const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

process.on('uncaughtException', (err) => {
  console.error('[ОШИБКА СЕРВЕРА]:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[ОШИБКА ПРОМИСА]:', reason);
});

// Хранилища в памяти
const accounts = [];
const messages = [];
const userStatus = {}; 
const SECRET_SHIFT = 7;

function encryptData(text) {
  if (!text) return '';
  try {
    let base64 = Buffer.from(String(text), 'utf8').toString('base64');
    let result = '';
    for (let i = 0; i < base64.length; i++) {
      result += String.fromCharCode(base64.charCodeAt(i) + SECRET_SHIFT);
    }
    return result;
  } catch (e) {
    return String(text || '');
  }
}

function decryptData(text) {
  if (!text) return '';
  try {
    let base64 = '';
    for (let i = 0; i < text.length; i++) {
      base64 += String.fromCharCode(text.charCodeAt(i) - SECRET_SHIFT);
    }
    let decoded = Buffer.from(base64, 'base64').toString('utf8');
    if (decoded && !decoded.includes('\uFFFD')) {
      return decoded;
    }
  } catch (e) {}
  return String(text);
}

// --- API МАРШРУТЫ ---

app.post('/api/guest', (req, res) => {
  try {
    const rawName = req.body && req.body.name ? String(req.body.name).trim() : '';
    const guestName = rawName || ('Пользователь_' + Math.floor(Math.random() * 1000));

    const user = {
      id: 'id' + Math.floor(1000 + Math.random() * 9000),
      name: guestName,
      contacts: []
    };

    accounts.push(user);
    return res.json({ success: true, user });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

app.get('/api/users/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  
  const results = accounts.filter(u => {
    const idMatch = u.id && u.id.toLowerCase().includes(q);
    const nameMatch = u.name && u.name.toLowerCase().includes(q);
    return idMatch || nameMatch;
  }).map(u => ({ id: u.id, name: u.name }));

  res.json(results);
});

app.post('/api/messages/send', (req, res) => {
  const { senderId, receiverId, text, fileData, fileName, fileType } = req.body;

  const newMsg = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    senderId,
    receiverId,
    text: encryptData(text || ''),
    fileData: encryptData(fileData || ''),
    fileName: encryptData(fileName || ''),
    fileType: fileType || '',
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };

  messages.push(newMsg);

  const sender = accounts.find(u => u.id === senderId);
  if (sender && !sender.contacts.includes(receiverId)) {
    sender.contacts.push(receiverId);
  }
  const receiver = accounts.find(u => u.id === receiverId);
  if (receiver) {
    if (!receiver.contacts) receiver.contacts = [];
    if (!receiver.contacts.includes(senderId)) {
      receiver.contacts.push(senderId);
    }
  }

  if (userStatus[senderId]) {
    userStatus[senderId] = { isTyping: false, text: '' };
  }

  res.json({ success: true });
});

app.delete('/api/messages/:msgId', (req, res) => {
  const { msgId } = req.params;
  const idx = messages.findIndex(m => m.id === msgId);
  if (idx !== -1) {
    messages.splice(idx, 1);
  }
  res.json({ success: true });
});

app.get('/api/messages/:userId/:peerId', (req, res) => {
  const { userId, peerId } = req.params;
  
  const chatMsgs = messages.filter(m => 
    (m.senderId === userId && m.receiverId === peerId) ||
    (m.senderId === peerId && m.receiverId === userId)
  ).map(m => ({
    ...m,
    text: decryptData(m.text),
    fileData: decryptData(m.fileData),
    fileName: decryptData(m.fileName)
  }));

  res.json(chatMsgs);
});

app.get('/api/dialogs/:userId', (req, res) => {
  const userId = req.params.userId;
  const currentUser = accounts.find(u => u.id === userId);

  const peerIds = new Set(currentUser ? currentUser.contacts || [] : []);
  messages.forEach(m => {
    if (m.senderId === userId) peerIds.add(m.receiverId);
    if (m.receiverId === userId) peerIds.add(m.senderId);
  });

  const dialogs = accounts.filter(u => peerIds.has(u.id)).map(u => ({
    id: u.id, name: u.name
  }));

  res.json(dialogs);
});

app.post('/api/status', (req, res) => {
  const { userId, isTyping, statusText } = req.body;
  if (userId) {
    userStatus[userId] = { isTyping: !!isTyping, statusText: statusText || '' };
  }
  res.json({ success: true });
});

app.get('/api/status/:peerId', (req, res) => {
  const peerId = req.params.peerId;
  res.json(userStatus[peerId] || { isTyping: false, statusText: '' });
});

// --- ВЕБ-ИНТЕРФЕЙС ---
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Мессенджер</title>
  <style>
    :root {
      --bg-app: #0e1621;
      --bg-sidebar: #17212b;
      --bg-input: #242f3d;
      --bg-active: #2b5278;
      --bg-msg-peer: #182533;
      --bg-msg-my: #2b5278;
      --text-main: #ffffff;
      --text-muted: #7f91a4;
      --accent: #5288c1;
      --border: #0e1621;
      --modal-bg: #17212b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; -webkit-tap-highlight-color: transparent; }
    html, body { height: 100dvh; width: 100vw; background: var(--bg-app); color: var(--text-main); overflow: hidden; position: fixed; top: 0; left: 0; }

    .screen { display: none; height: 100%; width: 100%; position: absolute; top: 0; left: 0; align-items: center; justify-content: center; }
    .active { display: flex; }

    /* Увеличенный интерфейс входа на телефонах */
    .auth-container { width: 90%; max-width: 340px; background: var(--bg-sidebar); padding: 25px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
    .auth-container h2 { margin-bottom: 20px; text-align: center; color: var(--accent); font-size: 22px; }
    .input-group { margin-bottom: 15px; }
    .input-group label { display: block; margin-bottom: 6px; font-size: 13px; color: var(--text-muted); }
    .input-group input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--bg-input); background: var(--bg-input); color: var(--text-main); outline: none; font-size: 15px; }
    .btn { width: 100%; padding: 12px; background: var(--accent); color: #fff; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 15px; }
    .btn-danger { background: #e53935; color: #fff; }
    .btn-secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }

    #app-container { display: flex; width: 100%; height: 100%; position: relative; }
    .sidebar { width: 320px; min-width: 260px; background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; height: 100%; }
    .sidebar-header { padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }

    .section-title { font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 8px 12px 4px; letter-spacing: 0.5px; font-weight: bold; }
    .search-box input { width: 100%; padding: 10px 12px; border-radius: 18px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; }

    .chat-list { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }
    .chat-item { display: flex; align-items: center; gap: 12px; padding: 12px; cursor: pointer; border-bottom: 1px solid var(--border); }
    .chat-item:hover, .chat-item.active { background: var(--bg-active); }
    .avatar { width: 40px; height: 40px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; font-weight: bold; flex-shrink: 0; }

    .main-chat { flex: 1; display: flex; flex-direction: column; background: var(--bg-app); height: 100%; min-width: 0; }
    .chat-header { background: var(--bg-sidebar); padding: 10px 15px; border-bottom: 1px solid var(--border); height: 56px; display: flex; align-items: center; justify-content: space-between; }
    
    .chat-title-container { display: flex; flex-direction: column; }
    #active-peer-name { font-size: 14px; font-weight: bold; }
    #peer-status { font-size: 10px; color: var(--accent); height: 14px; }

    .messages-container { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 15px; display: flex; flex-direction: column; gap: 10px; }
    
    .msg { max-width: 75%; padding: 10px; border-radius: 12px; background: var(--bg-msg-peer); align-self: flex-start; word-break: break-word; }
    .msg.my { background: var(--bg-msg-my); align-self: flex-end; }

    .media-preview { width: 240px; height: 160px; object-fit: cover; border-radius: 8px; margin-top: 6px; display: block; cursor: pointer; background: #000; }
    .video-preview { width: 240px; max-width: 100%; border-radius: 8px; margin-top: 6px; display: block; }
    .file-link { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-input); border-radius: 6px; color: var(--accent); text-decoration: none; margin-top: 5px; font-size: 13px; }

    .file-preview-bar { background: var(--bg-sidebar); border-top: 1px solid var(--border); padding: 8px 12px; display: none; align-items: center; gap: 10px; }
    .file-preview-bar.active { display: flex; }
    .preview-thumb { width: 36px; height: 36px; object-fit: cover; border-radius: 4px; background: #000; }
    .preview-info { flex: 1; font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .input-bar-wrapper { background: var(--bg-sidebar); display: flex; flex-direction: column; width: 100%; }
    .input-bar { padding: 8px 10px; display: flex; gap: 8px; align-items: center; }
    .input-bar input[type="text"] { flex: 1; padding: 10px 14px; border-radius: 20px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; font-size: 14px; }
    .icon-btn { cursor: pointer; font-size: 18px; border: none; background: transparent; color: var(--text-main); padding: 4px; }

    .msg-actions-sheet { position: fixed; bottom: 0; left: 0; right: 0; background: var(--modal-bg); border-top-left-radius: 16px; border-top-right-radius: 16px; padding: 20px; z-index: 1001; display: none; flex-direction: column; gap: 10px; box-shadow: 0 -4px 20px rgba(0,0,0,0.4); }
    .msg-actions-sheet.active { display: flex; }

    @media (max-width: 600px) {
      /* Чуть крупнее элементы входа именно на телефонах */
      .auth-container {
        width: 92%;
        max-width: none;
        padding: 30px 22px;
      }
      .auth-container h2 {
        font-size: 26px;
        margin-bottom: 22px;
      }
      .auth-container .input-group input {
        padding: 15px;
        font-size: 16px;
      }
      .auth-container .btn {
        padding: 15px;
        font-size: 16px;
      }

      #app-container { flex-direction: column; }
      .sidebar { width: 100%; height: 100%; }
      .main-chat { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 10; display: none; }
      .main-chat.mobile-active { display: flex; }
    }
  </style>
</head>
<body>

  <div id="auth-screen" class="screen active">
    <div class="auth-container">
      <h2>Вход</h2>
      <div class="input-group">
        <label>Имя</label>
        <input type="text" id="auth-name" placeholder="Ваше имя">
      </div>
      <button class="btn" onclick="handleGuestLogin()">Войти</button>
    </div>
  </div>

  <div id="app-screen" class="screen">
    <div id="app-container">
      <div class="sidebar" id="sidebar">
        <div class="sidebar-header">
          <div>
            <b id="my-display-name">Имя</b>
            <div style="font-size:11px; color:var(--accent);" id="my-display-id">ID</div>
          </div>
          <div class="search-box">
            <input type="text" id="search-input" placeholder="Поиск людей или ID..." oninput="onSearchInput()">
          </div>
        </div>
        <div class="section-title">Чаты</div>
        <div class="chat-list" id="chat-list"></div>
      </div>

      <div class="main-chat" id="main-chat-panel">
        <div class="chat-header">
          <div style="display:flex; align-items:center; gap:10px;">
            <button class="icon-btn" id="back-btn" style="display:none;" onclick="closeMobileChat()">⬅️</button>
            <div class="chat-title-container">
              <div id="active-peer-name">Выберите чат</div>
              <div id="peer-status"></div>
            </div>
          </div>
        </div>
        
        <div class="messages-container" id="messages-container"></div>

        <div class="file-preview-bar" id="file-preview-bar">
          <img id="preview-thumb" class="preview-thumb" src="" style="display:none;">
          <div class="preview-info" id="preview-name">Файл выбран</div>
          <button class="icon-btn" style="font-size:14px;" onclick="clearSelectedFile()">✕</button>
        </div>

        <div class="input-bar-wrapper" id="input-bar-container" style="display:none;">
          <div class="input-bar">
            <button class="icon-btn" onclick="triggerFileInput()">📎</button>
            <input type="file" id="file-input" style="display:none;" onchange="handleFileSelect(event)">
            
            <button class="icon-btn" id="mic-btn" onclick="toggleVoiceRecord()">🎙️</button>
            <input type="text" id="msg-input" placeholder="Сообщение..." oninput="onInputTyping()" onkeydown="if(event.key==='Enter') sendMsg()">
            <button class="btn" style="width:auto; padding:8px 14px;" onclick="sendMsg()">➤</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="msg-actions-sheet" id="msg-actions-sheet">
    <button class="btn btn-danger" onclick="deleteSelectedMessage()">Удалить сообщение</button>
    <button class="btn btn-secondary" onclick="closeMsgActions()">Отмена</button>
  </div>

  <script>
    var currentUser = null;
    var activePeer = null;
    var selectedFile = null;
    var isSending = false;

    var mediaRecorder = null;
    var audioChunks = [];
    var isRecording = false;

    var selectedMsgId = null;
    var longTouchTimer = null;
    var typingTimer = null;

    async function handleGuestLogin() {
      var inputEl = document.getElementById('auth-name');
      var val = inputEl ? inputEl.value.trim() : '';
      try {
        var res = await fetch('/api/guest', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ name: val })
        });
        var data = await res.json();
        if (data && data.user) {
          currentUser = data.user;
          document.getElementById('auth-screen').classList.remove('active');
          document.getElementById('app-screen').classList.add('active');
          document.getElementById('my-display-name').innerText = currentUser.name;
          document.getElementById('my-display-id').innerText = 'Мой ID: ' + currentUser.id;
          
          loadDialogs();
          setInterval(function() {
            if (currentUser && !isRecording) {
              loadDialogs();
              if (activePeer) {
                loadMessages();
                loadPeerStatus();
              }
            }
          }, 1500);
        }
      } catch (e) { alert('Ошибка входа'); }
    }

    // Поддержка нажатия Enter для входа
    document.addEventListener('DOMContentLoaded', function() {
      var inputEl = document.getElementById('auth-name');
      if (inputEl) {
        inputEl.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') handleGuestLogin();
        });
      }
    });

    async function loadDialogs() {
      if (!currentUser) return;
      var q = document.getElementById('search-input').value.trim();
      if (q) return;

      try {
        var res = await fetch('/api/dialogs/' + currentUser.id);
        var dialogs = await res.json();
        renderChatList(dialogs);
      } catch (e) {}
    }

    async function onSearchInput() {
      var q = document.getElementById('search-input').value.trim();
      if (!q) { loadDialogs(); return; }
      try {
        var res = await fetch('/api/users/search?q=' + encodeURIComponent(q));
        var users = await res.json();
        renderChatList(users.filter(function(u) { return u.id !== currentUser.id; }));
      } catch (e) {}
    }

    function renderChatList(list) {
      var container = document.getElementById('chat-list');
      container.innerHTML = '';
      if (!list || list.length === 0) return;

      list.forEach(function(item) {
        var div = document.createElement('div');
        div.className = 'chat-item' + (activePeer && activePeer.id === item.id ? ' active' : '');
        div.onclick = function() { openChat(item); };
        div.innerHTML = '<div class="avatar">' + (item.name[0] || 'U').toUpperCase() + '</div>' +
          '<div style="overflow:hidden;"><b>' + item.name + '</b><div style="font-size:11px; color:var(--text-muted);">ID: ' + item.id + '</div></div>';
        container.appendChild(div);
      });
    }

    function openChat(peer) {
      activePeer = peer;
      document.getElementById('active-peer-name').innerText = peer.name + ' (ID: ' + peer.id + ')';
      document.getElementById('input-bar-container').style.display = 'flex';
      
      if (window.innerWidth <= 600) {
        document.getElementById('main-chat-panel').classList.add('mobile-active');
        document.getElementById('back-btn').style.display = 'block';
      }
      loadMessages();
    }

    function closeMobileChat() {
      document.getElementById('main-chat-panel').classList.remove('mobile-active');
      activePeer = null;
    }

    async function loadMessages() {
      if (!activePeer || !currentUser) return;
      try {
        var res = await fetch('/api/messages/' + currentUser.id + '/' + activePeer.id);
        var messages = await res.json();
        var container = document.getElementById('messages-container');
        var isScrolledToBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 80;

        container.innerHTML = '';
        messages.forEach(function(m) {
          var div = document.createElement('div');
          div.className = 'msg ' + (m.senderId === currentUser.id ? 'my' : '');

          div.oncontextmenu = function(e) { e.preventDefault(); openMsgActions(m.id); };
          div.ontouchstart = function() { longTouchTimer = setTimeout(function() { openMsgActions(m.id); }, 500); };
          div.ontouchend = function() { clearTimeout(longTouchTimer); };
          div.ontouchmove = function() { clearTimeout(longTouchTimer); };

          var html = m.text ? '<div>' + m.text + '</div>' : '';
          var fileType = m.fileType || '';
          if (m.fileData) {
            if (fileType.startsWith('image/')) {
              html += '<img src="' + m.fileData + '" class="media-preview" loading="lazy" onclick="window.open(\'' + m.fileData + '\')">';
            } else if (fileType.startsWith('video/')) {
              html += '<video src="' + m.fileData + '" controls class="video-preview" preload="metadata"></video>';
            } else if (fileType.startsWith('audio/')) {
              html += '<audio src="' + m.fileData + '" controls style="margin-top:5px; max-width:100%;" preload="metadata"></audio>';
            } else {
              html += '<a class="file-link" href="' + m.fileData + '" download="' + (m.fileName || 'file') + '">📁 ' + (m.fileName || 'Файл') + '</a>';
            }
          }

          html += '<div style="font-size:9px; color:var(--text-muted); text-align:right; margin-top:3px;">' + (m.timestamp || '') + '</div>';
          div.innerHTML = html;
          container.appendChild(div);
        });

        if (isScrolledToBottom) {
          container.scrollTop = container.scrollHeight;
        }
      } catch (e) {}
    }

    async function loadPeerStatus() {
      if (!activePeer) return;
      try {
        var res = await fetch('/api/status/' + activePeer.id);
        var status = await res.json();
        var statusEl = document.getElementById('peer-status');
        if (status.isTyping) {
          statusEl.innerText = status.statusText || 'печатает...';
        } else {
          statusEl.innerText = '';
        }
      } catch(e) {}
    }

    function onInputTyping() {
      if (!currentUser) return;
      var statusText = selectedFile ? 'отправляет файл...' : 'печатает...';
      
      fetch('/api/status', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ userId: currentUser.id, isTyping: true, statusText: statusText })
      });

      clearTimeout(typingTimer);
      typingTimer = setTimeout(function() {
        fetch('/api/status', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ userId: currentUser.id, isTyping: false })
        });
      }, 2000);
    }

    function openMsgActions(msgId) {
      selectedMsgId = msgId;
      document.getElementById('msg-actions-sheet').classList.add('active');
    }

    function closeMsgActions() {
      selectedMsgId = null;
      document.getElementById('msg-actions-sheet').classList.remove('active');
    }

    async function deleteSelectedMessage() {
      if (!selectedMsgId) return;
      try {
        var res = await fetch('/api/messages/' + selectedMsgId, { method: 'DELETE' });
        var data = await res.json();
        if (data.success) {
          closeMsgActions();
          loadMessages();
        }
      } catch(e) {}
    }

    function triggerFileInput() {
      document.getElementById('file-input').click();
    }

    function handleFileSelect(e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function(evt) {
        selectedFile = { data: evt.target.result, name: file.name, type: file.type };
        
        var previewBar = document.getElementById('file-preview-bar');
        var thumb = document.getElementById('preview-thumb');
        var nameEl = document.getElementById('preview-name');

        nameEl.innerText = file.name;
        if (file.type.startsWith('image/')) {
          thumb.src = evt.target.result;
          thumb.style.display = 'block';
        } else {
          thumb.style.display = 'none';
        }
        previewBar.classList.add('active');
      };
      reader.readAsDataURL(file);
    }

    function clearSelectedFile() {
      selectedFile = null;
      document.getElementById('file-input').value = '';
      document.getElementById('file-preview-bar').classList.remove('active');
    }

    async function toggleVoiceRecord() {
      var micBtn = document.getElementById('mic-btn');
      if (!isRecording) {
        try {
          var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          mediaRecorder = new MediaRecorder(stream);
          audioChunks = [];

          mediaRecorder.ondataavailable = function(e) {
            if (e.data.size > 0) audioChunks.push(e.data);
          };

          mediaRecorder.onstop = async function() {
            var actualType = mediaRecorder.mimeType || 'audio/webm';
            var audioBlob = new Blob(audioChunks, { type: actualType });
            var reader = new FileReader();
            reader.onload = function(evt) {
              selectedFile = { data: evt.target.result, name: 'голосовое_сообщение.webm', type: actualType };
              sendMsg();
            };
            reader.readAsDataURL(audioBlob);
            stream.getTracks().forEach(function(track) { track.stop(); });
          };

          mediaRecorder.start();
          isRecording = true;
          micBtn.innerText = '🔴';
        } catch (e) {
          alert('Нет доступа к микрофону.');
        }
      } else {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
        isRecording = false;
        micBtn.innerText = '🎙️';
      }
    }

    async function sendMsg() {
      if (isSending) return;
      
      var input = document.getElementById('msg-input');
      var text = input.value.trim();
      if ((!text && !selectedFile) || !activePeer) return;

      isSending = true;

      var body = {
        senderId: currentUser.id,
        receiverId: activePeer.id,
        text: text,
        fileData: selectedFile ? selectedFile.data : '',
        fileName: selectedFile ? selectedFile.name : '',
        fileType: selectedFile ? selectedFile.type : ''
      };

      input.value = '';
      clearSelectedFile();

      try {
        await fetch('/api/messages/send', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body)
        });

        loadMessages();
        loadDialogs();
      } catch(e) {} finally {
        isSending = false;
      }
    }
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => console.log(`[СЕРВЕР ЗАПУЩЕН] Порт: ${PORT}`));
