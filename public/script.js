const socket = io();
let createdRoomData = null;

// Check if joining from URL
const urlPath = window.location.pathname;
if (urlPath.startsWith('/room/')) {
    const roomId = urlPath.split('/')[1]; // Correctly extract roomId from path
    // No need to showJoinRoom here, the chat interface should handle loading based on sessionStorage
    // document.getElementById('joinRoomId').value = roomId;
    // showJoinRoom();
}

// Function to handle chat interface initialization when arriving via room URL
function initializeChatFromUrl() {
    const roomData = sessionStorage.getItem('roomData');
    if (roomData) {
        const { roomId, username, roomName } = JSON.parse(roomData);

        // Ensure we are on the chat page and the elements exist
        if (document.getElementById('chatContainer') && document.getElementById('chatRoomName') && document.getElementById('currentUsername')) {
            document.getElementById('chatContainer').style.display = 'block';
            document.getElementById('chatRoomName').textContent = roomName;
            document.getElementById('currentUsername').textContent = username;

            // Connect via socket
            socket.emit('join-room', { roomId, username });

            // Clear session storage after successful initialization
            sessionStorage.removeItem('roomData');
        } else if (urlPath.startsWith('/room/')) {
             // If on a room URL but no roomData in session, it means it's a direct visit
             // We need to fetch room details if not already loaded
             // This part might need more robust handling depending on how the chat page itself is structured
        }
    } else if (urlPath.startsWith('/room/')) {
        // If directly visiting a /room/{roomId} without prior sessionStorage data
        // this implies a new visit or a refresh. We need to load the chat interface
        // and potentially prompt for username if not provided elsewhere.
        // For now, we'll assume the user will be prompted on the chat page itself.
        // The current setup relies on sessionStorage set by connectToRoom before redirecting.
        // A more robust solution would involve fetching room details here if needed.
    }
}


function showWelcome() {
    hideAllModals();
    document.getElementById('welcomeModal').style.display = 'flex';
}

function showCreateRoom() {
    hideAllModals();
    document.getElementById('createRoomModal').style.display = 'flex';
}

function showJoinRoom() {
    hideAllModals();
    document.getElementById('joinRoomModal').style.display = 'flex';
}

function showPublicRooms() {
    hideAllModals();
    document.getElementById('publicRoomsModal').style.display = 'flex';
    loadPublicRooms();
}

function hideAllModals() {
    document.querySelectorAll('.modal').forEach(modal => {
        modal.style.display = 'none';
    });
}

async function loadPublicRooms() {
    try {
        const response = await fetch('/public-rooms');
        const result = await response.json();
        displayPublicRooms(result.rooms); // Use the new display function
    } catch (error) {
        document.getElementById('publicRoomsList').innerHTML = '<p style="text-align: center; color: #f56565; padding: 32px;">Error loading public rooms</p>';
    }
}

// Updated displayPublicRooms function
function displayPublicRooms(rooms) {
    const roomsList = document.getElementById('publicRoomsList');

    if (rooms.length === 0) {
        roomsList.innerHTML = '<div class="no-rooms">No public rooms available. Create one!</div>';
        return;
    }

    roomsList.innerHTML = rooms.map(room => `
        <div class="room-item" onclick="joinPublicRoom('${room.id}', '${room.name}')">
            <div class="room-header">
                <div class="room-title">${room.name}</div>
                <div class="room-meta">
                    <span class="room-creator">Created by ${room.creator}</span>
                    <div class="room-users">
                        <svg class="icon" viewBox="0 0 24 24">
                            <path d="M16,4C18.11,4 19.99,5.89 19.99,8C19.99,10.11 18.11,12 16,12C13.89,12 12,10.11 12,8C12,5.89 13.89,4 16,4M16,14C20.42,14 24,15.79 24,18V20H8V18C8,15.79 11.58,14 16,14M6,6H4V4H6V6M4,8H6V10H4V8M6,12H4V10H6V12M4,14H6V16H4V14M6,18H4V16H6V18M4,20H6V18H4V20Z"/>
                        </svg>
                        <span>${room.activeUsers || 0} online</span>
                    </div>
                </div>
            </div>
        </div>
    `).join('');
}


function refreshPublicRooms() {
    document.getElementById('publicRoomsList').innerHTML = '<div class="loading"></div>';
    loadPublicRooms();
}

async function joinPublicRoom(roomId, roomName) {
    const username = document.getElementById('publicUsername').value.trim();
    if (!username) {
        showToast('Please enter your display name', 'error');
        return;
    }

    try {
        // Check if username is available
        const usernameCheck = await fetch('/check-username', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ roomId: roomId, username: username })
        });

        const checkResult = await usernameCheck.json();
        if (!checkResult.success || !checkResult.available) {
            showToast(checkResult.message || 'Username not available. Please choose another.', 'error');
            return;
        }

        // Store username locally for this room
        localStorage.setItem(`chatUser_${roomId}`, JSON.stringify({
            username: username,
            lastUsed: Date.now()
        }));

        connectToRoom(roomId, username, roomName);
    } catch (error) {
        showToast('Error validating username', 'error');
    }
}

async function createRoom() {
    const username = document.getElementById('createUsername').value.trim();
    const roomName = document.getElementById('roomName').value.trim();
    const password = document.getElementById('roomPassword').value.trim();
    const roomType = document.getElementById('roomType').value;

    if (!username || !roomName) {
        showToast('Please fill in required fields', 'error');
        return;
    }

    try {
        const response = await fetch('/create-room', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ roomName, password, username, roomType })
        });

        const result = await response.json();
        if (result.success) {
            // Store username locally for this room
            localStorage.setItem(`chatUser_${result.roomId}`, JSON.stringify({
                username: username,
                lastUsed: Date.now()
            }));

            createdRoomData = { 
                roomId: result.roomId, 
                roomName: result.roomName, 
                username: username,
                shareUrl: result.shareUrl
            };

            document.getElementById('createdRoomName').textContent = result.roomName;
            document.getElementById('createdRoomId').textContent = result.roomId;
            document.getElementById('shareUrl').textContent = result.shareUrl;

            hideAllModals();
            document.getElementById('roomCreatedModal').style.display = 'flex';
        } else {
            showToast('Error creating room: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('Error creating room', 'error');
    }
}

function copyShareUrl() {
    const shareUrl = document.getElementById('shareUrl').textContent;
    navigator.clipboard.writeText(shareUrl).then(() => {
        showToast('Link copied successfully!', 'success');
    });
}

function joinCreatedRoom() {
    if (createdRoomData) {
        connectToRoom(createdRoomData.roomId, createdRoomData.username, createdRoomData.roomName);
    }
}

async function joinRoom() {
    const username = document.getElementById('joinUsername').value.trim();
    const roomId = document.getElementById('joinRoomId').value.trim();
    const password = document.getElementById('joinPassword').value.trim();

    if (!username || !roomId) {
        showToast('Please fill in required fields', 'error');
        return;
    }

    try {
        // Check if username is available
        const usernameCheck = await fetch('/check-username', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ roomId: roomId, username: username })
        });

        const checkResult = await usernameCheck.json();
        if (!checkResult.success || !checkResult.available) {
            showToast(checkResult.message || 'Username not available. Please choose another.', 'error');
            return;
        }

        const response = await fetch('/join-room', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ roomId, password })
        });

        const result = await response.json();
        if (result.success) {
            // Store username locally for this room
            localStorage.setItem(`chatUser_${roomId}`, JSON.stringify({
                username: username,
                lastUsed: Date.now()
            }));

            connectToRoom(roomId, username, result.roomName);
        } else {
            showToast('Error joining room: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('Error joining room', 'error');
    }
}

function connectToRoom(roomId, username, roomName) {
    // Store room data for the chat page
    sessionStorage.setItem('roomData', JSON.stringify({
        roomId: roomId,
        username: username,
        roomName: roomName
    }));

    // Redirect to chat page
    window.location.href = `/room/${roomId}`;
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icon = type === 'success' ? 
        '<svg class="icon" viewBox="0 0 24 24"><path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,14L6,9L7.41,7.59L11,11.17L16.59,5.58L18,7L11,14Z"/></svg>' :
        '<svg class="icon" viewBox="0 0 24 24"><path d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/></svg>';

    toast.innerHTML = `${icon}<span>${message}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => {
            document.body.removeChild(toast);
        }, 400);
    }, 3000);
}

// Close modals on escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        showWelcome();
    }
});

// Load stored username if available
function loadStoredUsernames() {
    // Try to find a recently used username
    const keys = Object.keys(localStorage);
    const chatUserKeys = keys.filter(key => key.startsWith('chatUser_'));

    if (chatUserKeys.length > 0) {
        // Find the most recently used username
        let mostRecent = null;
        let mostRecentTime = 0;

        chatUserKeys.forEach(key => {
            try {
                const userData = JSON.parse(localStorage.getItem(key));
                if (userData.lastUsed > mostRecentTime) {
                    mostRecentTime = userData.lastUsed;
                    mostRecent = userData.username;
                }
            } catch (e) {
                // Skip invalid data
            }
        });

        if (mostRecent) {
            // Pre-fill username fields
            const usernameFields = ['createUsername', 'joinUsername', 'publicUsername'];
            usernameFields.forEach(fieldId => {
                const field = document.getElementById(fieldId);
                if (field) {
                    field.value = mostRecent;
                }
            });
        }
    }
}

// Load stored usernames on page load
window.addEventListener('load', loadStoredUsernames);

// Initialize chat if arriving via a room URL
if (window.location.pathname.startsWith('/room/')) {
    initializeChatFromUrl();
}