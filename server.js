const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

process.on('uncaughtException', (err) => {
  console.error('[ОШИБКА СЕРВЕРА]:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ОШИБКА ПРОМИСА]:', reason);
});

const SERV_DIR = __dirname;
const ARXIV_DIR = path.join(SERV_DIR, 'arxiv');
const ACCOUNTS_DIR = path.join(ARXIV_DIR, 'accounts');
const MESSAGES_DIR = path.join(ARXIV_DIR, 'messages');

[ARXIV_DIR, ACCOUNTS_DIR, MESSAGES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const ACCOUNTS_FILE = path.join(ACCOUNTS_DIR, 'accounts.json');
const MESSAGES_FILE = path.join(MESSAGES_DIR, 'messages.json');

function safeReadJSON(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    const bakPath = filePath + '.bak';
    if (fs.existsSync(bakPath)) {
      try { return JSON.parse(fs.readFileSync(bakPath, 'utf8')); } catch (err) {}
    }
    return fallback;
  }
}

function safeWriteJSON(filePath, data) {
  const tmpPath = filePath + '.tmp';
  const bakPath = filePath + '.bak';
  try {
    const str = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, str, 'utf8');
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, bakPath);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    console.error(`[ОШИБКА ЗАПИСИ] Не удалось сохранить ${filePath}:`, e);
  }
}

function readAccounts() { return safeReadJSON(ACCOUNTS_FILE, []); }
function writeAccounts(data) { safeWriteJSON(ACCOUNTS_FILE, data); }

function readMessages() { return safeReadJSON(MESSAGES_FILE, []); }
function writeMessages(data) { safeWriteJSON(MESSAGES_FILE, data); }

const SECRET_SHIFT = 7;
const XOR_KEY = 0x5A;

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

  try {
    const buf = Buffer.from(text, 'hex');
    if (buf.length > 0) {
      for (let i = 0; i < buf.length; i++) buf[i] ^= XOR_KEY;
      let decoded = buf.toString('utf8');
      if (decoded && !decoded.includes('\uFFFD')) return decoded;
    }
  } catch (e) {}

  return String(text);
}

// Быстрый вход по имени
app.post('/api/guest', (req, res) => {
  const name = req.body && req.body.name ? String(req.body.name).trim() : '';
  const guestName = name || ('Пользователь_' + Math.floor(Math.random() * 1000));
  
  const accounts = readAccounts();

  const user = {
    id: 'user_' + Math.random().toString(36).substr(2, 9),
    username: 'user_' + Math.floor(Math.random() * 10000),
    name: guestName, 
    avatar: '', 
    isGuest: true, 
    isBanned: false, 
    contacts: [],
    updatedAt: Date.now()
  };

  accounts.push(user);
  writeAccounts(accounts);

  res.json({ success: true, user });
});

// Поиск
app.get('/api/users/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  
  const accounts = readAccounts();
  const results = accounts.filter(u => {
    const idMatch = u.id && u.id.toLowerCase().includes(q);
    const nameMatch = u.name && u.name.toLowerCase().includes(q);
    return idMatch || nameMatch;
  }).map(u => ({ 
    id: u.id, 
    name: u.name
  }));

  res.json(results);
});

// Отправка сообщений
app.post('/api/messages/send', (req, res) => {
  const { senderId, receiverId, text, fileData, fileName, fileType } = req.body;
  const accounts = readAccounts();
  const sender = accounts.find(u => u.id === senderId);

  if (sender && sender.isBanned) return res.status(403).json({ error: 'Вы заблокированы.' });

  const messages = readMessages();
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
  writeMessages(messages);

  let updated = false;
  if (sender && !sender.contacts.includes(receiverId)) {
    sender.contacts.push(receiverId);
    updated = true;
  }
  const receiver = accounts.find(u => u.id === receiverId);
  if (receiver) {
    if (!receiver.contacts) receiver.contacts = [];
    if (!receiver.contacts.includes(senderId)) {
      receiver.contacts.push(senderId);
      updated = true;
    }
  }
  if (updated) writeAccounts(accounts);

  res.json({ success: true });
});

// Удаление сообщения
app.delete('/api/messages/:msgId', (req, res) => {
  const { msgId } = req.params;
  let messages = readMessages();
  const initialLength = messages.length;

  messages = messages.filter(m => m.id !== msgId);

  if (messages.length === initialLength) {
    return res.status(404).json({ error: 'Сообщение не найдено.' });
  }

  writeMessages(messages);
  res.json({ success: true });
});

// Получение сообщений
app.get('/api/messages/:userId/:peerId', (req, res) => {
  const { userId, peerId } = req.params;
  const messages = readMessages();
  
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

// Список диалогов
app.get('/api/dialogs/:userId', (req, res) => {
  const userId = req.params.userId;
  const accounts = readAccounts();
  const currentUser = accounts.find(u => u.id === userId);
  const messages = readMessages();

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

// Клиентский интерфейс
app.get('*', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ru" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Мессенджер</title>
  <style>
    :root {
      --bg-app: #0e1621;
      --bg-sidebar: #17212b;
      --bg-input: #242f3d;
      --bg-hover: #202b36;
      --bg-active: #2b5278;
      --bg-msg-peer: #182533;
      --bg-msg-my: #2b5278;
      --text-main: #ffffff;
      --text-muted: #7f91a4;
      --accent: #5288c1;
      --border: #0e1621;
      --modal-bg: #17212b;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    html, body { height: 100dvh; width: 100vw; background: var(--bg-app); color: var(--text-main); overflow: hidden; position: fixed; }

    .screen { display: none; height: 100dvh; width: 100vw; position: absolute; top: 0; left: 0; }
    .active { display: flex; }

    .auth-container { margin: auto; width: 90%; max-width: 360px; background: var(--bg-sidebar); padding: 25px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
    .auth-container h2 { margin-bottom: 20px; text-align: center; color: var(--accent); }
    .input-group { margin-bottom: 15px; }
    .input-group label { display: block; margin-bottom: 5px; font-size: 13px; color: var(--text-muted); }
    .input-group input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--bg-input); background: var(--bg-input); color: var(--text-main); outline: none; }
    .btn { width: 100%; padding: 12px; background: var(--accent); color: #fff; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; margin-top: 10px; }
    .btn-secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
    .btn-danger { background: #e53935; color: #fff; }

    #app-container { display: flex; width: 100%; height: 100%; }
    .sidebar { width: 320px; background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
    .sidebar-header { padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }
    .user-profile-bar { display: flex; align-items: center; justify-content: space-between; padding: 4px; }
    .user-info-brief { display: flex; align-items: center; gap: 10px; overflow: hidden; }

    .search-box { position: relative; }
    .search-box input { width: 100%; padding: 10px 12px; border-radius: 18px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; font-size: 14px; }
    .clear-search { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; color: var(--text-muted); display: none; }

    .chat-list { flex: 1; overflow-y: auto; }
    .chat-item { display: flex; align-items: center; gap: 12px; padding: 12px; cursor: pointer; border-bottom: 1px solid var(--border); transition: background 0.2s; }
    .chat-item:hover, .chat-item.active { background: var(--bg-active); }
    .avatar { width: 42px; height: 42px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; font-weight: bold; color: #fff; flex-shrink: 0; }

    .main-chat { flex: 1; display: flex; flex-direction: column; background: var(--bg-app); position: relative; }
    .chat-header { background: var(--bg-sidebar); padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); height: 60px; }
    .messages-container { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px; }
    
    .msg { max-width: 75%; padding: 10px 14px; border-radius: 12px; background: var(--bg-msg-peer); align-self: flex-start; word-break: break-word; position: relative; }
    .msg.my { background: var(--bg-msg-my); align-self: flex-end; }
    
    .media-preview { width: 260px; height: 180px; max-width: 100%; border-radius: 8px; margin-top: 6px; object-fit: cover; display: block; cursor: pointer; background: #000; }
    .video-preview { width: 260px; max-width: 100%; border-radius: 8px; margin-top: 6px; display: block; }
    .file-link { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-input); border-radius: 6px; color: var(--accent); text-decoration: none; margin-top: 5px; font-size: 13px; }

    .input-bar { background: var(--bg-sidebar); padding: 10px; display: flex; gap: 10px; align-items: center; flex-shrink: 0; border-top: 1px solid var(--border); }
    .input-bar input[type="text"] { flex: 1; padding: 12px; border-radius: 20px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; }
    .icon-btn { cursor: pointer; font-size: 22px; user-select: none; border: none; background: transparent; color: var(--text-main); }

    .empty-state { margin: auto; text-align: center; color: var(--text-muted); font-size: 14px; }

    .msg-actions-sheet { position: fixed; bottom: 0; left: 0; right: 0; background: var(--modal-bg); border-top-left-radius: 16px; border-top-right-radius: 16px; padding: 20px; z-index: 1001; display: none; flex-direction: column; gap: 10px; box-shadow: 0 -4px 20px rgba(0,0,0,0.4); }
    .msg-actions-sheet.active { display: flex; }

    @media (max-width: 600px) {
      .sidebar { width: 100%; display: flex; }
      .main-chat { display: none; width: 100%; }
      .app-mobile-chat .sidebar { display: none; }
      .app-mobile-chat .main-chat { display: flex; }
    }
  </style>
</head>
<body>

  <div id="auth-screen" class="screen active">
    <div class="auth-container">
      <h2>Вход в чат</h2>
      <div class="input-group">
        <label>Имя</label>
        <input type="text" id="auth-name" placeholder="Имя">
      </div>
      <button class="btn" id="login-btn" onclick="handleGuestLogin()">Войти</button>
    </div>
  </div>

  <div id="app-screen" class="screen">
    <div id="app-container">
      
      <div class="sidebar">
        <div class="sidebar-header">
          <div class="user-profile-bar">
            <div class="user-info-brief">
              <div class="avatar" id="my-avatar-icon">U</div>
              <div>
                <b id="my-display-name">Имя</b>
                <div style="font-size:11px; color:var(--accent);" id="my-display-id">ID</div>
              </div>
            </div>
          </div>

          <div class="search-box">
            <input type="text" id="search-input" placeholder="Поиск по ID или имени..." oninput="onSearchInput()">
            <span class="clear-search" id="clear-search-btn" onclick="clearSearch()">✕</span>
          </div>
        </div>
        
        <div class="chat-list" id="chat-list"></div>
      </div>

      <div class="main-chat" id="main-chat">
        <div class="chat-header" id="chat-header">
          <button class="btn btn-secondary" style="width:auto; padding:6px 12px; font-size:12px; display:none;" id="back-to-list-btn" onclick="closeMobileChat()">← Назад</button>
          <div id="active-peer-name" style="font-weight:bold;">Выберите чат</div>
          <div></div>
        </div>

        <div class="messages-container" id="messages-container">
          <div class="empty-state">Выберите диалог слева или введите ID/имя в поиск</div>
        </div>

        <div class="input-bar" id="input-bar" style="display:none;">
          <button class="icon-btn" onclick="triggerFileInput()">📎</button>
          <input type="file" id="file-input" style="display:none;" onchange="handleFileSelect(event)">
          
          <button class="icon-btn" id="mic-btn" onclick="toggleVoiceRecord()">🎙️</button>
          <input type="text" id="msg-input" placeholder="Напишите сообщение..." onkeydown="if(event.key==='Enter') sendMsg()">
          <button class="btn" style="width:auto; padding:10px 18px; border-radius:20px;" onclick="sendMsg()">➤</button>
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
    
    var mediaRecorder = null;
    var audioChunks = [];
    var isRecording = false;

    var lastDialogsHash = '';
    var lastMessagesHash = '';

    var selectedMsgId = null;
    var longTouchTimer = null;

    async function handleGuestLogin() {
      var inputEl = document.getElementById('auth-name');
      var name = inputEl ? inputEl.value.trim() : '';

      try {
        var res = await fetch('/api/guest', { 
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ name: name })
        });
        var data = await res.json();
        if (data && data.user) {
          currentUser = data.user;
          startApp();
        } else {
          alert('Ошибка при входе');
        }
      } catch(e) {
        alert('Ошибка подключения к серверу');
      }
    }

    document.addEventListener('DOMContentLoaded', function() {
      var inputEl = document.getElementById('auth-name');
      if (inputEl) {
        inputEl.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') handleGuestLogin();
        });
      }
    });

    function startApp() {
      document.getElementById('auth-screen').classList.remove('active');
      document.getElementById('app-screen').classList.add('active');

      updateMyProfileUI();
      loadDialogs();
      
      setInterval(function() {
        if (currentUser && !isRecording) {
          loadDialogsQuiet();
          if (activePeer) loadMessagesQuiet();
        }
      }, 1500);
    }

    function updateMyProfileUI() {
      document.getElementById('my-display-name').innerText = currentUser.name;
      document.getElementById('my-display-id').innerText = 'ID: ' + currentUser.id;
      document.getElementById('my-avatar-icon').innerText = (currentUser.name || 'U')[0].toUpperCase();
    }

    async function loadDialogs() {
      var searchVal = document.getElementById('search-input').value.trim();
      if (searchVal) return;
      try {
        var res = await fetch('/api/dialogs/' + currentUser.id);
        var dialogs = await res.json();
        renderChatList(dialogs);
      } catch(e) {}
    }

    async function loadDialogsQuiet() {
      var searchVal = document.getElementById('search-input').value.trim();
      if (searchVal) return;
      try {
        var res = await fetch('/api/dialogs/' + currentUser.id);
        var dialogs = await res.json();
        
        var currentHash = JSON.stringify(dialogs.map(function(d) { return d.id + d.name; }));
        if (currentHash !== lastDialogsHash) {
          lastDialogsHash = currentHash;
          renderChatList(dialogs);
        }
      } catch(e) {}
    }

    async function onSearchInput() {
      var q = document.getElementById('search-input').value.trim();
      var clearBtn = document.getElementById('clear-search-btn');

      if (!q) {
        clearBtn.style.display = 'none';
        loadDialogs();
        return;
      }

      clearBtn.style.display = 'block';
      try {
        var res = await fetch('/api/users/search?q=' + encodeURIComponent(q));
        var users = await res.json();
        renderChatList(users.filter(function(u) { return u.id !== currentUser.id; }));
      } catch(e) {}
    }

    function clearSearch() {
      document.getElementById('search-input').value = '';
      document.getElementById('clear-search-btn').style.display = 'none';
      loadDialogs();
    }

    function renderChatList(list) {
      var container = document.getElementById('chat-list');
      var currentActiveId = activePeer ? activePeer.id : null;
      container.innerHTML = '';

      if (!list || list.length === 0) {
        container.innerHTML = '<div style="padding:15px; color:var(--text-muted); font-size:12px; text-align:center;">Ничего не найдено</div>';
        return;
      }

      list.forEach(function(item) {
        var div = document.createElement('div');
        div.className = 'chat-item ' + (currentActiveId === item.id ? 'active' : '');
        div.onclick = function() { openChat(item); };
        
        var avatarContent = (item.name || 'U')[0].toUpperCase();

        div.innerHTML = '<div class="avatar">' + avatarContent + '</div>' +
          '<div>' +
            '<div style="font-weight:bold;">' + item.name + '</div>' +
            '<div style="font-size:11px; color:var(--text-muted);">ID: ' + item.id + '</div>' +
          '</div>';
        container.appendChild(div);
      });
    }

    function openChat(peer) {
      activePeer = peer;
      lastMessagesHash = '';
      document.getElementById('active-peer-name').innerText = peer.name + ' (ID: ' + peer.id + ')';
      document.getElementById('input-bar').style.display = 'flex';
      
      var chatItems = document.querySelectorAll('.chat-item');
      chatItems.forEach(function(el) { el.classList.remove('active'); });
      
      if (window.innerWidth <= 600) {
        document.getElementById('app-screen').classList.add('app-mobile-chat');
        document.getElementById('back-to-list-btn').style.display = 'block';
      }

      loadMessages();
    }

    function closeMobileChat() {
      document.getElementById('app-screen').classList.remove('app-mobile-chat');
    }

    async function loadMessages() {
      if (!activePeer) return;
      try {
        var res = await fetch('/api/messages/' + currentUser.id + '/' + activePeer.id);
        var messages = await res.json();
        renderMessagesContainer(messages);
      } catch(e) {}
    }

    async function loadMessagesQuiet() {
      if (!activePeer) return;
      try {
        var res = await fetch('/api/messages/' + currentUser.id + '/' + activePeer.id);
        var messages = await res.json();
        
        var currentHash = JSON.stringify(messages.map(function(m) { return m.id + (m.text || ''); }));
        if (currentHash !== lastMessagesHash) {
          lastMessagesHash = currentHash;
          renderMessagesContainer(messages);
        }
      } catch(e) {}
    }

    function renderMessagesContainer(messages) {
      var container = document.getElementById('messages-container');
      var isScrolledToBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 80;
      
      container.innerHTML = '';
      if (!messages || messages.length === 0) {
        container.innerHTML = '<div class="empty-state">Нет сообщений. Напишите первыми!</div>';
        return;
      }

      messages.forEach(function(m) {
        var div = document.createElement('div');
        div.className = 'msg ' + (m.senderId === currentUser.id ? 'my' : '');

        div.oncontextmenu = function(e) {
          e.preventDefault();
          openMsgActions(m.id);
        };
        div.ontouchstart = function() {
          longTouchTimer = setTimeout(function() { openMsgActions(m.id); }, 500);
        };
        div.ontouchend = function() { clearTimeout(longTouchTimer); };
        div.ontouchmove = function() { clearTimeout(longTouchTimer); };

        var html = '';
        if (m.text) html += '<div>' + m.text + '</div>';

        var fileType = m.fileType || '';
        if (m.fileData) {
          if (fileType.startsWith('image/')) {
            html += '<img src="' + m.fileData + '" class="media-preview" onclick="window.open(\'' + m.fileData + '\')">';
          } else if (fileType.startsWith('video/')) {
            html += '<video src="' + m.fileData + '" controls class="video-preview"></video>';
          } else if (fileType.startsWith('audio/')) {
            html += '<audio src="' + m.fileData + '" controls style="margin-top:5px; max-width:100%;"></audio>';
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
          lastMessagesHash = '';
          loadMessages();
        } else {
          alert('Ошибка при удалении.');
        }
      } catch(e) {
        alert('Не удалось удалить сообщение.');
      }
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
        alert('Файл прикреплен: ' + file.name);
      };
      reader.readAsDataURL(file);
    }

    function getSupportedMimeType() {
      var types = [
        'audio/webm;codecs=opus',
        'audio/mp4',
        'audio/aac',
        'audio/webm',
        'audio/ogg;codecs=opus'
      ];
      for (var i = 0; i < types.length; i++) {
        if (MediaRecorder.isTypeSupported(types[i])) return types[i];
      }
      return '';
    }

    async function toggleVoiceRecord() {
      var micBtn = document.getElementById('mic-btn');
      if (!isRecording) {
        try {
          var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          var mimeType = getSupportedMimeType();
          
          mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
          audioChunks = [];

          mediaRecorder.ondataavailable = function(e) {
            if (e.data.size > 0) audioChunks.push(e.data);
          };

          mediaRecorder.onstop = async function() {
            var actualType = mediaRecorder.mimeType || 'audio/mp4';
            var audioBlob = new Blob(audioChunks, { type: actualType });
            var reader = new FileReader();
            reader.onload = function(evt) {
              selectedFile = { data: evt.target.result, name: 'голосовое_сообщение', type: actualType };
              sendMsg();
            };
            reader.readAsDataURL(audioBlob);
            
            stream.getTracks().forEach(function(track) { track.stop(); });
          };

          mediaRecorder.start();
          isRecording = true;
          micBtn.innerText = '🔴';
        } catch (e) { alert('Нет доступа к микрофону.'); }
      } else {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
        isRecording = false;
        micBtn.innerText = '🎙️';
      }
    }

    async function sendMsg() {
      if (!activePeer) return;
      var input = document.getElementById('msg-input');
      var text = input.value.trim();
      if (!text && !selectedFile) return;

      var body = {
        senderId: currentUser.id,
        receiverId: activePeer.id,
        text: text,
        fileData: selectedFile ? selectedFile.data : '',
        fileName: selectedFile ? selectedFile.name : '',
        fileType: selectedFile ? selectedFile.type : ''
      };

      try {
        await fetch('/api/messages/send', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body)
        });

        input.value = '';
        selectedFile = null;
        document.getElementById('file-input').value = '';
        
        lastMessagesHash = '';
        loadMessages();
        loadDialogs();
      } catch(e) {
        alert('Не удалось отправить сообщение.');
      }
    }
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => console.log(`[СЕРВЕР ЗАПУЩЕН] Порт: ${PORT}`));
