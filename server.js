// server.js - compatible with your chat.js event names
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // If you're using a reverse proxy, you may need extra options here
});

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const rooms = new Map(); // in-memory: roomId -> { id, name, password, type, creator, users: Map(socketId->username), messages: [] }
const shortId = () => uuidv4().split('-')[0];

// Auto-create General Chat room
const GENERAL_ROOM_ID = 'general';
rooms.set(GENERAL_ROOM_ID, {
  id: GENERAL_ROOM_ID,
  name: 'General Chat',
  password: null,
  type: 'public',
  creator: 'System',
  createdAt: Date.now(),
  users: new Map(),
  messages: [
    {
      id: uuidv4(),
      username: 'System',
      message: "Welcome to the General Chat..! This is a public room where everyone can chat. Be respectful and have fun.! 🎉",
      type: 'text',
      fileData: null,
      replyTo: null,
      timestamp: Date.now(),
      edited: false
    }
  ]
});

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// REST endpoints used by frontend
app.post('/create-room', (req, res) => {
  const { roomName, password = '', username = 'Anon', roomType = 'private' } = req.body;
  if (!roomName) return res.status(400).json({ success: false, error: 'roomName required' });

  const roomId = shortId();
  rooms.set(roomId, {
    id: roomId,
    name: roomName,
    password: password || null,
    type: roomType === 'public' ? 'public' : 'private',
    creator: username,
    createdAt: Date.now(),
    users: new Map(),
    messages: []
  });
const shareUrl = `${req.protocol}://${req.get('host')}/room/${roomId}`;
return res.json({ success: true, roomId, roomName, shareUrl });
});

app.post('/join-room', (req, res) => {
  const { roomId, password = '' } = req.body;
  const room = rooms.get(roomId);
  if (!room) return res.json({ success: false, error: 'Room not found' });
  if (room.password && room.password !== password) return res.json({ success: false, error: 'Invalid password' });
  return res.json({ success: true, roomName: room.name });
});

app.post('/check-username', (req, res) => {
  const { roomId, username } = req.body;
  if (!roomId || !username) return res.status(400).json({ success: false, available: false, message: 'roomId & username required' });
  const room = rooms.get(roomId);
  if (!room) return res.json({ success: false, available: false, message: 'Room not found' });
  const taken = Array.from(room.users.values()).some(u => u.toLowerCase() === username.toLowerCase());
  return res.json({ success: true, available: !taken });
});

app.get('/public-rooms', (req, res) => {
  const list = Array.from(rooms.values())
    .filter(r => r.type === 'public')
    .map(r => ({ id: r.id, name: r.name, creator: r.creator, activeUsers: r.users.size, createdAt: r.createdAt }));
  return res.json({ success: true, rooms: list });
});

app.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, error: 'No file uploaded' });
    const type = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
    return res.json({
      success: true,
      url: `/uploads/${req.file.filename}`,
      originalName: req.file.originalname,
      type
    });
  } catch (err) {
    console.error('Upload error', err);
    return res.status(500).json({ success: false, error: err.message || 'Upload failed' });
  }
});

// serve frontend room page for direct /room/:id url
app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room', 'index.html'));
});

app.get('/room/:roomId/info', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ success: false, error: 'Room not found' });
  return res.json({ success: true, room: { id: room.id, name: room.name, type: room.type, activeUsers: room.users.size } });
});

// ---------- Socket.IO event mapping exactly for your chat.js ----------
io.on('connection', socket => {
  console.log('socket connected', socket.id);

  // Helper: find the roomId(s) the socket has joined (excluding its own room id)
  const getJoinedRoomId = () => {
    const rs = Array.from(socket.rooms).filter(r => r !== socket.id);
    return rs.length ? rs[0] : null;
  };

  // join-room: payload { roomId, username } — frontend emits this
  socket.on('join-room', ({ roomId, username }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }

    socket.join(roomId);
    room.users.set(socket.id, username || `User-${shortId()}`);

    // Send chat-history (frontend listens for 'chat-history')
    socket.emit('chat-history', room.messages);

    // Broadcast join events (frontend handles 'user-joined' and 'active-users-update')
    io.to(roomId).emit('user-joined', { username, activeUsers: room.users.size });
    io.to(roomId).emit('active-users-update', { count: room.users.size });

    console.log(`${username} joined ${roomId}`);
  });

  // send-message: frontend emits { message, replyTo, fileData?, type? } - without roomId
  socket.on('send-message', (payload) => {
    const roomId = getJoinedRoomId();
    if (!roomId) { socket.emit('error', 'Not in a room'); return; }
    const room = rooms.get(roomId);
    if (!room) return;

    const username = room.users.get(socket.id) || 'Unknown';
    const messageObj = {
      id: uuidv4(),
      username,
      message: payload.message || '',
      type: payload.type || (payload.fileData ? payload.fileData.type || 'image' : 'text'),
      fileData: payload.fileData || null,
      replyTo: payload.replyTo || null,
      timestamp: Date.now(),
      edited: false
    };

    room.messages.push(messageObj);
    if (room.messages.length > 1000) room.messages.shift();

    // Emit new-message (frontend listens for 'new-message')
    io.to(roomId).emit('new-message', messageObj);

    // Optionally notify replied user(s)
    if (messageObj.replyTo) {
      io.to(roomId).emit('reply-notification', { text: `${username} replied`, isGeneral: false });
    }
  });

  // typing-start / typing-stop -> frontend emits these; server should broadcast user-typing / user-stopped-typing
  socket.on('typing-start', ({ roomId, username }) => {
    if (!roomId) roomId = getJoinedRoomId();
    if (!roomId) return;
    socket.to(roomId).emit('user-typing', { username });
  });

  socket.on('typing-stop', ({ roomId, username }) => {
    if (!roomId) roomId = getJoinedRoomId();
    if (!roomId) return;
    socket.to(roomId).emit('user-stopped-typing', { username });
  });

  // edit-message: frontend emits { messageId, newMessage }
  socket.on('edit-message', ({ messageId, newMessage }) => {
    const roomId = getJoinedRoomId(); if (!roomId) return;
    const room = rooms.get(roomId); if (!room) return;
    const msg = room.messages.find(m => m.id === messageId);
    if (!msg) return;

    const username = room.users.get(socket.id);
    if (msg.username !== username) return socket.emit('error', 'Not allowed to edit');

    msg.message = newMessage;
    msg.edited = true;

    // frontend listens for 'message-edited'
    io.to(roomId).emit('message-edited', { messageId, newMessage });
  });

  // delete-message: frontend emits { messageId }
  socket.on('delete-message', ({ messageId }) => {
    const roomId = getJoinedRoomId(); if (!roomId) return;
    const room = rooms.get(roomId); if (!room) return;
    const idx = room.messages.findIndex(m => m.id === messageId);
    if (idx === -1) return;

    const msg = room.messages[idx];
    const username = room.users.get(socket.id);
    if (msg.username !== username) return socket.emit('error', 'Not allowed to delete');

    room.messages.splice(idx, 1);
    io.to(roomId).emit('message-deleted', { messageId });
  });

  // leave-room: frontend emits this with no payload
  socket.on('leave-room', () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.users.has(socket.id)) {
        const username = room.users.get(socket.id);
        room.users.delete(socket.id);
        socket.leave(roomId);
        io.to(roomId).emit('user-left', { username, activeUsers: room.users.size });
        io.to(roomId).emit('active-users-update', { count: room.users.size });
      }
    }
  });

  // disconnect handling
  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.users.has(socket.id)) {
        const username = room.users.get(socket.id);
        room.users.delete(socket.id);
        io.to(roomId).emit('user-left', { username, activeUsers: room.users.size });
        io.to(roomId).emit('active-users-update', { count: room.users.size });
      }
    }
    console.log('socket disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 9281;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));