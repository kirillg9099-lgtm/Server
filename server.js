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
  try {
    const str = JSON.stringify(data);
    fs.writeFileSync(tmpPath, str, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    console.error(`[ОШИБКА ЗАПИСИ]:`, e);
  }
}

function readAccounts() { return safeReadJSON(ACCOUNTS_FILE, []); }
function writeAccounts(data) { safeWriteJSON(ACCOUNTS_FILE, data); }
function readMessages() { return safeReadJSON(MESSAGES_FILE, []); }
function writeMessages(data) { safeWriteJSON(MESSAGES_FILE, data); }

// Быстрое шифрование только текста (файлы не шифруем, чтобы они не весили больше и отправлялись мгновенно)
function encryptText(text) {
  if (!text) return '';
  try {
    return Buffer.from(String(text), 'utf8').toString('base64');
  } catch (e) {
    return text;
  }
}

function decryptText(text) {
  if (!text) return '';
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    if (decoded && !decoded.includes('\uFFFD')) return decoded;
  } catch (e) {}
  return text;
}

// Регистрация
app.post('/api/register', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Введите имя' });
  }

  const accounts = readAccounts();
  const newAccount = {
    id: 'id_' + Math.random().toString(36).substr(2, 9),
    name: name.trim(),
    contacts: [],
    updatedAt: Date.now()
  };

  accounts.push(newAccount);
  writeAccounts(accounts);
  res.json({ success: true, user: newAccount });
});

// Поиск аккаунтов
app.get('/api/users/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  
  const accounts = readAccounts();
  const results = accounts.filter(u => {
    return (u.id && u.id.toLowerCase().includes(q)) || (u.name && u.name.toLowerCase().includes(q));
  }).map(u => ({ id: u.id, name: u.name }));

  res.json(results);
});

// Отправка сообщений
app.post('/api/messages/send', (req, res) => {
  const { senderId, receiverId, text, fileData, fileName, fileType } = req.body;
  const accounts = readAccounts();
  const sender = accounts.find(u => u.id === senderId);

  const messages = readMessages();
  const newMsg = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    senderId,
    receiverId,
    text: encryptText(text || ''),
    fileData: fileData || '', // Файлы храним напрямую для максимальной скорости
    fileName: fileName || '',
    fileType: fileType || '',
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };

  messages.push(newMsg);
  writeMessages(messages);

  let updated = false;
  if (sender) {
    if (!sender.contacts) sender.contacts = [];
    if (!sender.contacts.includes(receiverId)) {
      sender.contacts.push(receiverId);
      updated = true;
    }
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
  messages = messages.filter(m => m.id !== msgId);
  writeMessages(messages);
  res.json({ success: true });
});

// Получение сообщений чата
app.get('/api/messages/:userId/:peerId', (req, res) => {
  const { userId, peerId } = req.params;
  const messages = readMessages();
  
  const chatMsgs = messages.filter(m => 
    (m.senderId === userId && m.receiverId === peerId) ||
    (m.senderId === peerId && m.receiverId === userId)
  ).map(m => ({
    ...m,
    text: decryptText(m.text)
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Мессенджер</title>
  <style>
    :root[data-theme="dark"] {
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
    }

    :root[data-theme="light"] {
      --bg-app: #e6ebee;
      --bg-sidebar: #ffffff;
      --bg-input: #f1f3f5;
      --bg-hover: #f5f5f5;
      --bg-active: #e3edf7;
      --bg-msg-peer: #ffffff;
      --bg-msg-my: #eeffde;
      --text-main: #000000;
      --text-muted: #707579;
      --accent: #3390ec;
      --border: #e6ebee;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-tap-highlight-color: transparent; }
    html, body { height: 100dvh; width: 100vw; background: var(--bg-app); color: var(--text-main); overflow: hidden; position: fixed; }

    .screen { display: none; height: 100dvh; width: 100vw; position: absolute; top: 0; left: 0; }
    .active { display: flex; }

    .auth-container { margin: auto; width: 90%; max-width: 360px; background: var(--bg-sidebar); padding: 25px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); text-align: center; }
    .auth-container h2 { margin-bottom: 20px; color: var(--accent); }
    .input-group { margin-bottom: 15px; text-align: left; }
    .input-group input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--bg-input); background: var(--bg-input); color: var(--text-main); outline: none; }
    .btn { width: 100%; padding: 12px; background: var(--accent); color: #fff; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; margin-top: 10px; }
    .btn-secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
    .btn-danger { background: #e53935; color: #fff; }
    .error-msg { color: #e53935; font-size: 12px; margin-top: 8px; display: none; }

    #app-container { display: flex; width: 100%; height: 100%; }
    .sidebar { width: 320px; background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
    .sidebar-header { padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }
    
    .user-profile-bar { display: flex; align-items: center; justify-content: space-between; padding: 4px; }
    .user-info-brief { display: flex; flex-direction: column; overflow: hidden; }

    .theme-toggle-btn { background: var(--bg-input); border: none; color: var(--text-main); width: 34px; height: 34px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px; }

    .search-box { position: relative; }
    .search-box input { width: 100%; padding: 10px 12px; border-radius: 18px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; font-size: 14px; }
    .clear-search { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; color: var(--text-muted); display: none; }

    .chat-list { flex: 1; overflow-y: auto; }
    .chat-item { display: flex; align-items: center; gap: 12px; padding: 12px; cursor: pointer; border-bottom: 1px solid var(--border); transition: background 0.2s; }
    .chat-item:hover, .chat-item.active { background: var(--bg-active); }

    .main-chat { flex: 1; display: flex; flex-direction: column; background: var(--bg-app); position: relative; }
    .chat-header { background: var(--bg-sidebar); padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); height: 60px; }
    .messages-container { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px; -webkit-overflow-scrolling: touch; }
    
    .msg { max-width: 75%; padding: 10px 14px; border-radius: 12px; background: var(--bg-msg-peer); align-self: flex-start; word-break: break-word; position: relative; user-select: none; }
    .msg.my { background: var(--bg-msg-my); align-self: flex-end; }
    
    .media-preview { width: 260px; height: 180px; max-width: 100%; border-radius: 8px; margin-top: 6px; object-fit: cover; display: block; cursor: pointer; background: #000; }
    .video-preview { width: 260px; max-width: 100%; border-radius: 8px; margin-top: 6px; display: block; background: #000; }
    .file-link { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-input); border-radius: 6px; color: var(--accent); text-decoration: none; margin-top: 5px; font-size: 13px; }

    .attachment-preview-container { background: var(--bg-sidebar); padding: 10px 15px; border-top: 1px solid var(--border); display: none; align-items: center; gap: 12px; }
    .attachment-preview-container.active { display: flex; }
    .attachment-thumb { width: 45px; height: 45px; border-radius: 6px; object-fit: cover; background: #000; }
    .attachment-info { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .attachment-name { font-size: 13px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .attachment-cancel { cursor: pointer; color: #e53935; font-size: 18px; padding: 5px; }

    .uploading-box { display: flex; align-items: center; gap: 10px; padding: 8px; background: rgba(0,0,0,0.15); border-radius: 8px; margin-top: 5px; font-size: 13px; }
    .spinner { width: 16px; height: 16px; border: 2px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

    .input-bar { background: var(--bg-sidebar); padding: 10px; display: flex; gap: 10px; align-items: center; flex-shrink: 0; border-top: 1px solid var(--border); }
    .input-bar input[type="text"] { flex: 1; padding: 12px; border-radius: 20px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; }
    .icon-btn { cursor: pointer; font-size: 22px; user-select: none; border: none; background: transparent; color: var(--text-main); }

    .empty-state { margin: auto; text-align: center; color: var(--text-muted); font-size: 14px; }

    .msg-actions-sheet { position: fixed; bottom: 0; left: 0; right: 0; background: var(--bg-sidebar); border-top-left-radius: 16px; border-top-right-radius: 16px; padding: 20px; z-index: 1001; display: none; flex-direction: column; gap: 10px; box-shadow: 0 -4px 20px rgba(0,0,0,0.4); }
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
      <h2>Введите имя</h2>
      <div id="auth-error" class="error-msg"></div>
      <div class="input-group">
        <input type="text" id="auth-name" placeholder="Ваше имя..." onkeydown="if(event.key==='Enter') registerUser()">
      </div>
      <button class="btn" onclick="registerUser()">Войти</button>
    </div>
  </div>

  <div id="app-screen" class="screen">
    <div id="app-container">
      
      <div class="sidebar">
        <div class="sidebar-header">
          <div class="user-profile-bar">
            <div class="user-info-brief">
              <b id="my-display-name">Имя</b>
              <div style="font-size:11px; color:var(--accent);" id="my-display-id">ID</div>
            </div>
            <button class="theme-toggle-btn" id="theme-toggle-btn" onclick="toggleTheme()" title="Сменить тему">🌙</button>
          </div>

          <div class="search-box">
            <input type="text" id="search-input" placeholder="Поиск по имени или ID..." oninput="onSearchInput()">
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
          <div class="empty-state">Выберите диалог слева или найдите пользователя в поиске</div>
        </div>

        <div class="attachment-preview-container" id="attachment-preview-container">
          <img id="attachment-thumb-img" class="attachment-thumb" src="" alt="">
          <div class="attachment-info">
            <div class="attachment-name" id="attachment-name-label">файл</div>
            <div style="font-size:11px; color:var(--text-muted);" id="attachment-type-label">Готово к отправке</div>
          </div>
          <span class="attachment-cancel" onclick="cancelAttachment()" title="Отменить">✕</span>
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
    let currentUser = null;
    let activePeer = null;
    let selectedFile = null;
    
    let mediaRecorder = null;
    let audioChunks = [];
    let isRecording = false;

    let lastDialogsHash = '';
    let lastMessagesHash = '';

    let selectedMsgId = null;
    let longTouchTimer = null;

    const savedTheme = localStorage.getItem('app_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);

    function toggleTheme() {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('app_theme', next);
      updateThemeIcon(next);
    }

    function updateThemeIcon(theme) {
      const btn = document.getElementById('theme-toggle-btn');
      if (btn) btn.innerText = theme === 'dark' ? '🌙' : '☀️';
    }

    async function registerUser() {
      const name = document.getElementById('auth-name').value.trim();
      const errBox = document.getElementById('auth-error');

      if (!name) {
        errBox.innerText = 'Введите ваше имя.';
        errBox.style.display = 'block';
        return;
      }

      try {
        const res = await fetch('/api/register', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (!data.success) {
          errBox.innerText = data.error || 'Ошибка входа';
          errBox.style.display = 'block';
        } else {
          currentUser = data.user;
          startApp();
        }
      } catch(e) {
        errBox.innerText = 'Ошибка подключения к серверу.';
        errBox.style.display = 'block';
      }
    }

    function startApp() {
      document.getElementById('auth-screen').classList.remove('active');
      document.getElementById('app-screen').classList.add('active');

      document.getElementById('my-display-name').innerText = currentUser.name;
      document.getElementById('my-display-id').innerText = 'ID: ' + currentUser.id;

      loadDialogs();
      
      // Оптимизированный интервал опроса (2 секунды) для плавной работы
      setInterval(() => {
        if (currentUser && !isRecording) {
          loadDialogsQuiet();
          if (activePeer) loadMessagesQuiet();
        }
      }, 2000);
    }

    async function loadDialogs() {
      const searchVal = document.getElementById('search-input').value.trim();
      if (searchVal) return;
      try {
        const res = await fetch('/api/dialogs/' + currentUser.id);
        const dialogs = await res.json();
        renderChatList(dialogs);
      } catch(e) {}
    }

    async function loadDialogsQuiet() {
      const searchVal = document.getElementById('search-input').value.trim();
      if (searchVal) return;
      try {
        const res = await fetch('/api/dialogs/' + currentUser.id);
        const dialogs = await res.json();
        
        const currentHash = JSON.stringify(dialogs);
        if (currentHash !== lastDialogsHash) {
          lastDialogsHash = currentHash;
          renderChatList(dialogs);
        }
      } catch(e) {}
    }

    async function onSearchInput() {
      const q = document.getElementById('search-input').value.trim();
      const clearBtn = document.getElementById('clear-search-btn');

      if (!q) {
        clearBtn.style.display = 'none';
        loadDialogs();
        return;
      }

      clearBtn.style.display = 'block';
      try {
        const res = await fetch('/api/users/search?q=' + encodeURIComponent(q));
        const users = await res.json();
        renderChatList(users.filter(u => u.id !== currentUser.id));
      } catch(e) {}
    }

    function clearSearch() {
      document.getElementById('search-input').value = '';
      document.getElementById('clear-search-btn').style.display = 'none';
      loadDialogs();
    }

    function renderChatList(list) {
      const container = document.getElementById('chat-list');
      const currentActiveId = activePeer ? activePeer.id : null;
      container.innerHTML = '';

      if (!list || list.length === 0) {
        container.innerHTML = '<div style="padding:15px; color:var(--text-muted); font-size:12px; text-align:center;">Ничего не найдено</div>';
        return;
      }

      list.forEach(item => {
        const div = document.createElement('div');
        div.className = 'chat-item ' + (currentActiveId === item.id ? 'active' : '');
        div.onclick = () => openChat(item);

        div.innerHTML = \`
          <div>
            <div style="font-weight:bold;">\${item.name}</div>
            <div style="font-size:11px; color:var(--text-muted);">ID: \${item.id}</div>
          </div>
        \`;
        container.appendChild(div);
      });
    }

    function openChat(peer) {
      activePeer = peer;
      lastMessagesHash = '';
      document.getElementById('active-peer-name').innerText = peer.name + ' (ID: ' + peer.id + ')';
      document.getElementById('input-bar').style.display = 'flex';
      
      const chatItems = document.querySelectorAll('.chat-item');
      chatItems.forEach(el => el.classList.remove('active'));
      
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
        const res = await fetch(\`/api/messages/\${currentUser.id}/\${activePeer.id}\`);
        const messages = await res.json();
        renderMessagesContainer(messages);
      } catch(e) {}
    }

    async function loadMessagesQuiet() {
      if (!activePeer) return;
      try {
        const res = await fetch(\`/api/messages/\${currentUser.id}/\${activePeer.id}\`);
        const messages = await res.json();
        
        const currentHash = JSON.stringify(messages.map(m => m.id));
        if (currentHash !== lastMessagesHash) {
          lastMessagesHash = currentHash;
          renderMessagesContainer(messages);
        }
      } catch(e) {}
    }

    function renderMessagesContainer(messages) {
      const container = document.getElementById('messages-container');
      const isScrolledToBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 80;
      
      container.innerHTML = '';
      if (!messages || messages.length === 0) {
        container.innerHTML = '<div class="empty-state">Нет сообщений. Напишите первыми!</div>';
        return;
      }

      messages.forEach(m => {
        const div = document.createElement('div');
        div.className = 'msg ' + (m.senderId === currentUser.id ? 'my' : '');

        div.oncontextmenu = (e) => {
          e.preventDefault();
          openMsgActions(m.id);
        };
        div.ontouchstart = () => {
          longTouchTimer = setTimeout(() => openMsgActions(m.id), 500);
        };
        div.ontouchend = () => clearTimeout(longTouchTimer);
        div.ontouchmove = () => clearTimeout(longTouchTimer);

        let html = '';
        if (m.text) html += \`<div>\${m.text}</div>\`;

        const fileType = m.fileType || '';
        if (m.fileData) {
          if (fileType.startsWith('image/')) {
            html += \`<img src="\${m.fileData}" class="media-preview" onclick="window.open('\${m.fileData}')">\`;
          } else if (fileType.startsWith('video/')) {
            html += \`<video src="\${m.fileData}" controls class="video-preview"></video>\`;
          } else if (fileType.startsWith('audio/')) {
            html += \`<audio src="\${m.fileData}" controls style="margin-top:5px; max-width:100%;"></audio>\`;
          } else {
            html += \`<a class="file-link" href="\${m.fileData}" download="\${m.fileName || 'file'}">📁 \${m.fileName || 'Файл'}</a>\`;
          }
        }

        html += \`<div style="font-size:9px; color:var(--text-muted); text-align:right; margin-top:3px;">\${m.timestamp || ''}</div>\`;
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

    function triggerFileInput() {
      document.getElementById('file-input').click();
    }

    function handleFileSelect(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(evt) {
        selectedFile = { data: evt.target.result, name: file.name, type: file.type };
        
        const previewContainer = document.getElementById('attachment-preview-container');
        const thumbImg = document.getElementById('attachment-thumb-img');
        const nameLabel = document.getElementById('attachment-name-label');
        const typeLabel = document.getElementById('attachment-type-label');

        nameLabel.innerText = file.name;
        if (file.type.startsWith('image/')) {
          thumbImg.src = evt.target.result;
          thumbImg.style.display = 'block';
          typeLabel.innerText = 'Фото';
        } else if (file.type.startsWith('video/')) {
          thumbImg.src = '';
          thumbImg.style.display = 'none';
          typeLabel.innerText = 'Видео';
        } else {
          thumbImg.src = '';
          thumbImg.style.display = 'none';
          typeLabel.innerText = 'Файл';
        }
        previewContainer.classList.add('active');
      };
      reader.readAsDataURL(file);
    }

    function cancelAttachment() {
      selectedFile = null;
      document.getElementById('file-input').value = '';
      document.getElementById('attachment-preview-container').classList.remove('active');
    }

    function getSupportedMimeType() {
      const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/aac', 'audio/webm'];
      for (let t of types) {
        if (MediaRecorder.isTypeSupported(t)) return t;
      }
      return '';
    }

    async function toggleVoiceRecord() {
      const micBtn = document.getElementById('mic-btn');
      if (!isRecording) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const mimeType = getSupportedMimeType();
          
          mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
          audioChunks = [];

          mediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) audioChunks.push(e.data);
          };

          mediaRecorder.onstop = async () => {
            const actualType = mediaRecorder.mimeType || 'audio/mp4';
            const audioBlob = new Blob(audioChunks, { type: actualType });
            const reader = new FileReader();
            reader.onload = function(evt) {
              selectedFile = { data: evt.target.result, name: 'голосовое_сообщение', type: actualType };
              sendMsg();
            };
            reader.readAsDataURL(audioBlob);
            stream.getTracks().forEach(track => track.stop());
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
      const input = document.getElementById('msg-input');
      const text = input.value.trim();
      const fileToSend = selectedFile;

      if (!text && !fileToSend) return;

      input.value = '';
      cancelAttachment();

      const isVideo = fileToSend && fileToSend.type && fileToSend.type.startsWith('video/');
      const container = document.getElementById('messages-container');
      
      let tempDiv = null;
      if (isVideo) {
        tempDiv = document.createElement('div');
        tempDiv.className = 'msg my';
        tempDiv.innerHTML = \`
          \${text ? '<div>' + text + '</div>' : ''}
          <div class="uploading-box">
            <div class="spinner"></div>
            <div>Загрузка видео... (\${fileToSend.name})</div>
          </div>
          <div style="font-size:9px; color:var(--text-muted); text-align:right; margin-top:3px;">только что</div>
        \`;
        container.appendChild(tempDiv);
        container.scrollTop = container.scrollHeight;
      }

      const body = {
        senderId: currentUser.id,
        receiverId: activePeer.id,
        text: text,
        fileData: fileToSend ? fileToSend.data : '',
        fileName: fileToSend ? fileToSend.name : '',
        fileType: fileToSend ? fileToSend.type : ''
      };

      try {
        await fetch('/api/messages/send', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body)
        });

        if (tempDiv) tempDiv.remove();
        lastMessagesHash = '';
        loadMessages();
        loadDialogs();
      } catch(e) {
        if (tempDiv) tempDiv.remove();
        alert('Не удалось отправить сообщение.');
      }
    }
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => console.log(`[СЕРВЕР ЗАПУЩЕН] Порт: ${PORT}`));
