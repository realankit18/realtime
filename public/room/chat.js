
const socket = io();
let currentRoom = null;
let currentUsername = null;
let replyingTo = null;
let selectedFile = null;
let typingTimer = null;
let isTyping = false;
let editingMessageId = null;
let deletingMessageId = null;
let activeUsers = 0;

// Initialize chat from stored data or URL
window.addEventListener('load', () => {
    const urlPath = window.location.pathname;
    const roomData = sessionStorage.getItem('roomData');
    
    if (urlPath.startsWith('/room/')) {
        const roomId = urlPath.split('/room/')[1];
        
        if (roomData) {
            // User has session data, connect directly
            const data = JSON.parse(roomData);
            connectToRoom(data.roomId, data.username, data.roomName);
        } else {
            // No session data, prompt for username
            promptForUsername(roomId);
        }
    } else if (roomData) {
        // Coming from landing page with room data
        const data = JSON.parse(roomData);
        connectToRoom(data.roomId, data.username, data.roomName);
    } else {
        // No room data at all, redirect to landing
        window.location.href = '/';
    }
});

let pendingRoomId = null;

async function promptForUsername(roomId) {
    pendingRoomId = roomId;
    
    // Check if we have stored username for this room
    const storedData = localStorage.getItem(`chatUser_${roomId}`);
    
    if (storedData) {
        const userData = JSON.parse(storedData);
        // Check if stored username is still available
        const usernameCheck = await fetch('/check-username', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ roomId: roomId, username: userData.username })
        });
        
        const checkResult = await usernameCheck.json();
        if (checkResult.success && checkResult.available) {
            // Auto-join with stored username
            await joinWithUsername(roomId, userData.username);
            return;
        }
    }

    // Show username input modal
    document.getElementById('usernameInput').value = storedData ? JSON.parse(storedData).username : '';
    document.getElementById('usernameModal').style.display = 'flex';
    document.getElementById('usernameInput').focus();
}

async function submitUsername() {
    const username = document.getElementById('usernameInput').value.trim();
    const errorDiv = document.getElementById('usernameError');
    
    if (!username) {
        errorDiv.textContent = 'Please enter a username';
        errorDiv.style.display = 'block';
        return;
    }

    // Disable the button to prevent multiple submissions
    const submitBtn = document.querySelector('#usernameModal .btn');
    const originalText = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<div style="width: 16px; height: 16px; border: 2px solid #ffffff; border-top: 2px solid transparent; border-radius: 50%; animation: spin 1s linear infinite; margin-right: 8px;"></div>Joining...';

    // Check if username is available
    try {
        const usernameCheck = await fetch('/check-username', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ roomId: pendingRoomId, username: username })
        });
        
        const checkResult = await usernameCheck.json();
        if (checkResult.success && checkResult.available) {
            errorDiv.style.display = 'none';
            document.getElementById('usernameModal').style.display = 'none';
            await joinWithUsername(pendingRoomId, username);
        } else {
            errorDiv.textContent = checkResult.message || 'Username not available. Please choose another.';
            errorDiv.style.display = 'block';
            // Re-enable button
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalText;
        }
    } catch (error) {
        errorDiv.textContent = 'Error checking username availability';
        errorDiv.style.display = 'block';
        // Re-enable button
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalText;
    }
}

// Make submitUsername globally available
window.submitUsername = submitUsername;

async function joinWithUsername(roomId, username) {
    // Store username locally for this room
    localStorage.setItem(`chatUser_${roomId}`, JSON.stringify({
        username: username,
        lastUsed: Date.now()
    }));

    // Verify room exists
    try {
        const response = await fetch('/join-room', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ roomId: roomId, password: '' })
        });
        
        const data = await response.json();
        if (data.success) {
            // Store the room data and connect
            sessionStorage.setItem('roomData', JSON.stringify({
                roomId: roomId,
                username: username,
                roomName: data.roomName
            }));
            connectToRoom(roomId, username, data.roomName);
        } else {
            showToast('Room not found or invalid: ' + data.error, 'error');
            setTimeout(() => window.location.href = '/', 2000);
        }
    } catch (error) {
        showToast('Error connecting to room', 'error');
        setTimeout(() => window.location.href = '/', 2000);
    }
}

function goToHome() {
    // Clear any stored session data
    sessionStorage.removeItem('roomData');
    window.location.href = '/';
}

// Make goToHome globally available
window.goToHome = goToHome;

function connectToRoom(roomId, username, roomName) {
    currentRoom = roomId;
    currentUsername = username;
    
    document.getElementById('chatRoomName').textContent = roomName;
    document.getElementById('currentUsername').textContent = username;
    
    socket.emit('join-room', { roomId, username });
}

function sendMessage() {
    const messageText = document.getElementById('messageInput').value.trim();
    if (!messageText && !selectedFile) return;

    // Stop typing indicator
    stopTyping();

    if (selectedFile) {
        uploadAndSendFile();
    } else {
        socket.emit('send-message', {
            message: messageText,
            replyTo: replyingTo
        });
        
        document.getElementById('messageInput').value = '';
        autoResize();
        cancelReply();
    }
}

function handleFileSelect(event) {
    selectedFile = event.target.files[0];
    if (selectedFile) {
        uploadAndSendFile();
    }
}

async function uploadAndSendFile() {
    if (!selectedFile) return;

    // Show enhanced upload loading indicator
    const uploadLoading = document.getElementById('uploadLoading');
    const statusText = document.getElementById('uploadStatusText');
    const progressFill = document.getElementById('uploadProgressFill');
    const sizeText = document.getElementById('uploadSizeText');
    
    uploadLoading.style.display = 'block';
    
    // Format file size
    const formatFileSize = (bytes) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };
    
    // Determine file type for better messaging
    const isVideo = selectedFile.type.startsWith('video/');
    const isGif = selectedFile.name.toLowerCase().endsWith('.gif');
    let fileTypeText = 'image';
    if (isVideo) {
        fileTypeText = 'video';
    } else if (isGif) {
        fileTypeText = 'GIF';
    }
    
    // Update initial status without filename
    statusText.textContent = `Uploading your ${fileTypeText}...`;
    sizeText.textContent = `Processing ${formatFileSize(selectedFile.size)} file`;
    progressFill.style.width = '0%';
    
    // Simulate progress animation
    let progress = 0;
    const progressInterval = setInterval(() => {
        progress += Math.random() * 20;
        if (progress > 90) progress = 90;
        progressFill.style.width = progress + '%';
    }, 200);

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();
        
        // Complete progress
        clearInterval(progressInterval);
        progressFill.style.width = '100%';
        statusText.textContent = `${fileTypeText.charAt(0).toUpperCase() + fileTypeText.slice(1)} uploaded successfully!`;
        
        // Brief success animation
        setTimeout(() => {
            uploadLoading.style.display = 'none';
        }, 800);
        
        if (result.success) {
            // Send media message without displaying filename
            socket.emit('send-message', {
                message: '', // Empty message for clean media display
                type: result.type || 'image', // Use server-determined type
                replyTo: replyingTo,
                fileData: {
                    url: result.url,
                    filename: result.originalName,
                    type: result.type
                }
            });

            document.getElementById('messageInput').value = '';
            autoResize();
            selectedFile = null;
            document.getElementById('fileInput').value = '';
            cancelReply();
            
            const uploadedType = result.type === 'video' ? 'Video' : (result.originalName.toLowerCase().endsWith('.gif') ? 'GIF' : 'Image');
            showToast(`${uploadedType} shared successfully!`, 'success');
        } else {
            statusText.textContent = 'Upload failed';
            setTimeout(() => {
                uploadLoading.style.display = 'none';
            }, 1500);
            showToast('Error uploading file: ' + result.error, 'error');
        }
    } catch (error) {
        clearInterval(progressInterval);
        statusText.textContent = 'Upload failed';
        setTimeout(() => {
            uploadLoading.style.display = 'none';
        }, 1500);
        showToast('Error uploading file. Please check your connection.', 'error');
    }
}

function replyToMessage(messageId, username, content) {
    replyingTo = messageId;
    
    // Check what type of media is in the original message
    const originalMessage = document.querySelector(`[data-message-id="${messageId}"]`);
    const originalImage = originalMessage ? originalMessage.querySelector('.message-image') : null;
    const originalVideo = originalMessage ? originalMessage.querySelector('.message-video') : null;
    
    let thumbnailHtml = '';
    let mediaType = '';
    
    if (originalImage) {
        const src = originalImage.src;
        // Check if it's a GIF by file extension
        if (src.toLowerCase().includes('.gif')) {
            mediaType = 'GIF';
            thumbnailHtml = `<img src="${src}" alt="Reply thumbnail" class="reply-thumbnail">`;
        } else {
            mediaType = 'Image';
            thumbnailHtml = `<img src="${src}" alt="Reply thumbnail" class="reply-thumbnail">`;
        }
    } else if (originalVideo) {
        mediaType = 'Video';
        const videoSrc = originalVideo.querySelector('source') ? originalVideo.querySelector('source').src : originalVideo.src;
        thumbnailHtml = `<video class="reply-thumbnail"><source src="${videoSrc}"></video>`;
    }
    
    let displayContent;
    if (mediaType) {
        displayContent = mediaType;
    } else {
        displayContent = content || 'Message';
    }
    
    document.getElementById('replyContent').innerHTML = 
        `<div style="display: flex; align-items: center; gap: 10px;">
            ${thumbnailHtml}
            <div><strong>Replying to ${username}:</strong> ${mediaType ? `Replying to ${mediaType.toLowerCase()}` : displayContent.substring(0, 100)}${!mediaType && displayContent.length > 100 ? '...' : ''}</div>
        </div>`;
    document.getElementById('replyPreview').style.display = 'block';
    document.getElementById('messageInput').focus();
}

function cancelReply() {
    replyingTo = null;
    document.getElementById('replyPreview').style.display = 'none';
}

function addMessage(messageData) {
    const messagesContainer = document.getElementById('messagesContainer');
    const messageDiv = document.createElement('div');
    const isOwnMessage = messageData.username === currentUsername;
    
    messageDiv.className = `message ${isOwnMessage ? 'own' : 'other'} ${messageData.replyTo ? 'reply' : ''}`;
    
    let replyHtml = '';
    if (messageData.replyTo) {
        const originalMessage = document.querySelector(`[data-message-id="${messageData.replyTo}"]`);
        if (originalMessage) {
            const originalUsername = originalMessage.querySelector('.username').textContent;
            const originalImage = originalMessage.querySelector('.message-image');
            const originalVideo = originalMessage.querySelector('.message-video');
            const originalContent = originalMessage.querySelector('.message-content').textContent || '';
            
            let thumbnailHtml = '';
            let mediaType = '';
            
            if (originalImage) {
                const src = originalImage.src;
                if (src.toLowerCase().includes('.gif')) {
                    mediaType = 'GIF';
                } else {
                    mediaType = 'Image';
                }
                thumbnailHtml = `<img src="${src}" alt="Reply thumbnail" class="reply-thumbnail">`;
            } else if (originalVideo) {
                mediaType = 'Video';
                const videoSrc = originalVideo.querySelector('source') ? originalVideo.querySelector('source').src : originalVideo.src;
                thumbnailHtml = `<video class="reply-thumbnail"><source src="${videoSrc}"></video>`;
            }
            
            let displayText;
            if (mediaType) {
                displayText = mediaType;
            } else {
                displayText = originalContent || 'Message';
            }
            
            replyHtml = `<div class="reply-info">
                ${thumbnailHtml}
                <div class="reply-text">↪ Replying to <strong>${originalUsername}</strong>: ${mediaType || displayText.substring(0, 50)}${!mediaType && displayText.length > 50 ? '...' : ''}</div>
            </div>`;
        }
    }

    let contentHtml = '';
    let actionButtonsHtml = `
        <div class="message-actions">
            <button class="reply-btn" onclick="replyToMessage('${messageData.id}', '${messageData.username.replace(/'/g, '\\\'').replace(/"/g, '&quot;')}', '${messageData.message.replace(/'/g, '\\\'').replace(/"/g, '&quot;')}')">
                <svg class="icon" viewBox="0 0 24 24" style="width: 14px; height: 14px;">
                    <path d="M10,9V5L3,12L10,19V14.9C15,14.9 18.5,16.5 21,20C20,15 17,10 10,9Z"/>
                </svg>
                Reply
            </button>
            ${isOwnMessage && canEditDelete(messageData.timestamp) ? `
                <button class="edit-btn" onclick="editMessage('${messageData.id}', '${messageData.message.replace(/'/g, '\\\'').replace(/"/g, '&quot;')}')">
                    <svg class="icon" viewBox="0 0 24 24" style="width: 14px; height: 14px;">
                        <path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
                    </svg>
                    Edit
                </button>
                <button class="delete-btn" onclick="deleteMessage('${messageData.id}')">
                    <svg class="icon" viewBox="0 0 24 24" style="width: 14px; height: 14px;">
                        <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
                    </svg>
                    Delete
                </button>
            ` : ''}
        </div>
        <div class="message-actions-mobile">
            <button class="reply-btn" onclick="replyToMessage('${messageData.id}', '${messageData.username.replace(/'/g, '\\\'').replace(/"/g, '&quot;')}', '${messageData.message.replace(/'/g, '\\\'').replace(/"/g, '&quot;')}')">
                <svg class="icon" viewBox="0 0 24 24" style="width: 14px; height: 14px;">
                    <path d="M10,9V5L3,12L10,19V14.9C15,14.9 18.5,16.5 21,20C20,15 17,10 10,9Z"/>
                </svg>
                Reply
            </button>
            ${isOwnMessage && canEditDelete(messageData.timestamp) ? `
                <button class="edit-btn" onclick="editMessage('${messageData.id}', '${messageData.message.replace(/'/g, '\\\'').replace(/"/g, '&quot;')}')">
                    <svg class="icon" viewBox="0 0 24 24" style="width: 14px; height: 14px;">
                        <path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
                    </svg>
                    Edit
                </button>
                <button class="delete-btn" onclick="deleteMessage('${messageData.id}')">
                    <svg class="icon" viewBox="0 0 24 24" style="width: 14px; height: 14px;">
                        <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
                    </svg>
                    Delete
                </button>
            ` : ''}
        </div>
    `;

    if ((messageData.type === 'image' || messageData.type === 'video') && messageData.fileData) {
        if (messageData.type === 'video') {
            contentHtml = `
                <div class="media-container">
                    <video class="message-video" controls>
                        <source src="${messageData.fileData.url}" type="video/mp4">
                        Your browser does not support the video tag.
                    </video>
                    ${actionButtonsHtml}
                </div>
            `;
        } else {
            contentHtml = `
                <div class="media-container">
                    <img src="${messageData.fileData.url}" 
                         alt="${messageData.fileData.filename}" 
                         class="message-image" 
                         onclick="showImagePreview('${messageData.fileData.url}')">
                    ${actionButtonsHtml}
                </div>
            `;
        }
        actionButtonsHtml = ''; // Don't show action buttons twice
    } else {
        contentHtml = messageData.message + (messageData.edited ? ' <span class="edited-indicator">(edited)</span>' : '');
    }

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.innerHTML = `
        <div class="message-header">
            <span class="username">${messageData.username}</span>
            <span class="timestamp">${new Date(messageData.timestamp).toLocaleTimeString()}</span>
        </div>
        ${replyHtml}
        <div class="message-content">${contentHtml}</div>
        ${actionButtonsHtml}
    `;
    
    messageDiv.appendChild(bubble);
    messageDiv.setAttribute('data-message-id', messageData.id);
    messagesContainer.appendChild(messageDiv);
    
    // Auto-scroll to bottom with smooth animation
    autoScrollToBottom();
}

function autoScrollToBottom() {
    const messagesContainer = document.getElementById('messagesContainer');
    messagesContainer.scrollTo({
        top: messagesContainer.scrollHeight,
        behavior: 'smooth'
    });
}

function addSystemMessage(message) {
    const messagesContainer = document.getElementById('messagesContainer');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'system-message';
    messageDiv.innerHTML = `${message}`;
    messagesContainer.appendChild(messageDiv);
    
    // Auto-scroll to bottom with smooth animation
    autoScrollToBottom();
}

function showImagePreview(src) {
    const previewModal = document.getElementById('imagePreview');
    const previewImage = document.getElementById('previewImage');
    
    previewImage.src = src;
    previewModal.style.display = 'flex';
    previewModal.classList.add('show');
    
    // Prevent body scroll when modal is open
    document.body.style.overflow = 'hidden';
}

function closeImagePreview() {
    const previewModal = document.getElementById('imagePreview');
    
    previewModal.classList.remove('show');
    document.body.style.overflow = 'auto';
    
    // Small delay to allow animation
    setTimeout(() => {
        previewModal.style.display = 'none';
    }, 300);
}

function autoResize() {
    const textarea = document.getElementById('messageInput');
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

function updateActiveUsers(count) {
    activeUsers = count;
    const activeUsersElement = document.getElementById('activeUsersCount');
    if (activeUsersElement) {
        activeUsersElement.textContent = count;
    }
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

// Typing indicator functions
function startTyping() {
    if (!isTyping && currentRoom) {
        isTyping = true;
        socket.emit('typing-start', { roomId: currentRoom, username: currentUsername });
    }
    
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 2000);
}

function stopTyping() {
    if (isTyping && currentRoom) {
        isTyping = false;
        socket.emit('typing-stop', { roomId: currentRoom, username: currentUsername });
    }
    clearTimeout(typingTimer);
}

// Helper functions for edit/delete
function canEditDelete(timestamp) {
    const messageTime = new Date(timestamp).getTime();
    const now = Date.now();
    return (now - messageTime) <= 15 * 60 * 1000; // 15 minutes
}

function editMessage(messageId, currentMessage) {
    editingMessageId = messageId;
    document.getElementById('editMessageInput').value = currentMessage;
    document.getElementById('editMessageModal').style.display = 'flex';
    document.getElementById('editMessageInput').focus();
}

function confirmEdit() {
    const newMessage = document.getElementById('editMessageInput').value.trim();
    if (!newMessage) {
        showToast('Message cannot be empty', 'error');
        return;
    }
    
    socket.emit('edit-message', {
        messageId: editingMessageId,
        newMessage: newMessage
    });
    
    cancelEdit();
}

function cancelEdit() {
    editingMessageId = null;
    document.getElementById('editMessageModal').style.display = 'none';
    document.getElementById('editMessageInput').value = '';
}

function deleteMessage(messageId) {
    deletingMessageId = messageId;
    document.getElementById('deleteMessageModal').style.display = 'flex';
}

function confirmDelete() {
    socket.emit('delete-message', {
        messageId: deletingMessageId
    });
    
    cancelDelete();
}

function cancelDelete() {
    deletingMessageId = null;
    document.getElementById('deleteMessageModal').style.display = 'none';
}

// Socket event listeners
socket.on('chat-history', (messages) => {
    const messagesContainer = document.getElementById('messagesContainer');
    messagesContainer.innerHTML = '';
    messages.forEach(message => addMessage(message));
});

socket.on('new-message', (messageData) => {
    addMessage(messageData);
});

socket.on('message-edited', (data) => {
    const messageElement = document.querySelector(`[data-message-id="${data.messageId}"]`);
    if (messageElement) {
        const contentElement = messageElement.querySelector('.message-content');
        contentElement.innerHTML = data.newMessage + ' <span class="edited-indicator">(edited)</span>';
    }
});

socket.on('message-deleted', (data) => {
    const messageElement = document.querySelector(`[data-message-id="${data.messageId}"]`);
    if (messageElement) {
        messageElement.style.animation = 'messageSlideOut 0.3s ease';
        setTimeout(() => {
            messageElement.remove();
        }, 300);
    }
});

socket.on('reply-notification', (data) => {
    if (!data.isGeneral) {
        showToast(data.text, 'info');
    }
});

socket.on('user-joined', (data) => {
    addSystemMessage(`${data.username} joined the room`);
    if (data.activeUsers !== undefined) {
        updateActiveUsers(data.activeUsers);
    }
});

socket.on('user-left', (data) => {
    addSystemMessage(`${data.username} left the room`);
    if (data.activeUsers !== undefined) {
        updateActiveUsers(data.activeUsers);
    }
});

socket.on('active-users-update', (data) => {
    updateActiveUsers(data.count);
});

socket.on('user-typing', (data) => {
    if (data.username !== currentUsername) {
        const typingIndicator = document.getElementById('typingIndicator');
        const typingText = document.getElementById('typingText');
        typingText.textContent = `${data.username} is typing`;
        typingIndicator.style.display = 'block';
    }
});

socket.on('user-stopped-typing', (data) => {
    if (data.username !== currentUsername) {
        document.getElementById('typingIndicator').style.display = 'none';
    }
});

socket.on('error', (message) => {
    showToast('Error: ' + message, 'error');
});

// Enter key handling
document.getElementById('messageInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Typing detection
document.getElementById('messageInput').addEventListener('input', (e) => {
    autoResize();
    if (e.target.value.trim()) {
        startTyping();
    } else {
        stopTyping();
    }
});

// Stop typing on blur
document.getElementById('messageInput').addEventListener('blur', stopTyping);

function leaveRoom() {
    document.getElementById('confirmationModal').style.display = 'flex';
}

function confirmLeave() {
    // Clear session storage
    sessionStorage.removeItem('roomData');
    
    // Emit leave room event
    socket.emit('leave-room');
    
    // Disconnect from socket
    socket.disconnect();
    
    // Hide modal
    document.getElementById('confirmationModal').style.display = 'none';
    
    // Show leaving message
    showToast('Leaving chat room...', 'success');
    
    // Redirect to home page after a short delay
    setTimeout(() => {
        window.location.href = '/';
    }, 1000);
}

function cancelLeave() {
    document.getElementById('confirmationModal').style.display = 'none';
}

// Close modals on escape key and handle enter key for username input
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeImagePreview();
        cancelLeave();
        cancelEdit();
        cancelDelete();
        if (document.getElementById('usernameModal').style.display === 'flex') {
            goToHome();
        }
    }
    
    if (e.key === 'Enter' && document.getElementById('usernameModal').style.display === 'flex') {
        e.preventDefault();
        submitUsername();
    }
    
    if (e.key === 'Enter' && document.getElementById('editMessageModal').style.display === 'flex' && !e.shiftKey) {
        e.preventDefault();
        confirmEdit();
    }
});

// Close image preview when clicking outside the image
document.getElementById('imagePreview')?.addEventListener('click', (e) => {
    if (e.target.id === 'imagePreview') {
        closeImagePreview();
    }
});

// Focus username input when modal is shown
document.getElementById('usernameInput')?.addEventListener('input', () => {
    document.getElementById('usernameError').style.display = 'none';
});
