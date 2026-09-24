const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const accounts = [];
const messages = [];

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

// Вход
app.post('/api/guest', (req, res) => {
  const rawName = req.body && req.body.name ? String(req.body.name).trim() : '';
  const guestName = rawName || ('Пользователь_' + Math.floor(Math.random() * 1000));

  const user = {
    id: 'id' + Math.floor(1000 + Math.random() * 9000),
    name: guestName,
    contacts: []
  };

  accounts.push(user);
  res.json({ success: true, user: user });
});

// Поиск
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

// Отправка сообщений
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

  res.json({ success: true });
});

// Получение сообщений
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

// Список диалогов
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

// Интерфейс
app.get('*', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
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
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    html, body { height: 100%; width: 100%; background: var(--bg-app); color: var(--text-main); overflow: hidden; }

    .screen { display: none; height: 100%; width: 100%; position: absolute; top: 0; left: 0; }
    .active { display: flex; }

    .auth-container { margin: auto; width: 90%; max-width: 340px; background: var(--bg-sidebar); padding: 25px; border-radius: 12px; }
    .auth-container h2 { margin-bottom: 20px; text-align: center; color: var(--accent); }
    .input-group { margin-bottom: 15px; }
    .input-group label { display: block; margin-bottom: 5px; font-size: 13px; color: var(--text-muted); }
    .input-group input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--bg-input); background: var(--bg-input); color: var(--text-main); outline: none; }
    .btn { width: 100%; padding: 12px; background: var(--accent); color: #fff; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; }

    #app-container { display: flex; width: 100%; height: 100%; }
    .sidebar { width: 320px; background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
    .sidebar-header { padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }

    .search-box { position: relative; }
    .search-box input { width: 100%; padding: 10px 12px; border-radius: 18px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; }

    .chat-list { flex: 1; overflow-y: auto; }
    .chat-item { display: flex; align-items: center; gap: 12px; padding: 12px; cursor: pointer; border-bottom: 1px solid var(--border); }
    .chat-item:hover, .chat-item.active { background: var(--bg-active); }
    .avatar { width: 40px; height: 40px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; font-weight: bold; }

    .main-chat { flex: 1; display: flex; flex-direction: column; background: var(--bg-app); }
    .chat-header { background: var(--bg-sidebar); padding: 12px; border-bottom: 1px solid var(--border); height: 60px; display: flex; align-items: center; }
    .messages-container { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px; }
    
    .msg { max-width: 75%; padding: 10px; border-radius: 12px; background: var(--bg-msg-peer); align-self: flex-start; word-break: break-word; }
    .msg.my { background: var(--bg-msg-my); align-self: flex-end; }

    /* Строгий единый размер для всех картинок */
    .media-preview {
      width: 260px;
      height: 180px;
      object-fit: cover;
      border-radius: 8px;
      margin-top: 6px;
      display: block;
      cursor: pointer;
      background: #000;
    }

    .video-preview {
      width: 260px;
      max-width: 100%;
      border-radius: 8px;
      margin-top: 6px;
      display: block;
    }

    .file-link {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--bg-input);
      border-radius: 6px;
      color: var(--accent);
      text-decoration: none;
      margin-top: 5px;
      font-size: 13px;
    }

    .input-bar { background: var(--bg-sidebar); padding: 10px; display: flex; gap: 10px; align-items: center; }
    .input-bar input[type="text"] { flex: 1; padding: 12px; border-radius: 20px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; }
    .icon-btn { cursor: pointer; font-size: 20px; border: none; background: transparent; color: var(--text-main); }
  </style>
</head>
<body>

  <div id="auth-screen" class="screen active">
    <div class="auth-container">
      <h2>Вход</h2>
      <div class="input-group">
        <label>Имя</label>
        <input type="text" id="auth-name" placeholder="Имя">
      </div>
      <button class="btn" onclick="handleGuestLogin()">Войти</button>
    </div>
  </div>

  <div id="app-screen" class="screen">
    <div id="app-container">
      <div class="sidebar">
        <div class="sidebar-header">
          <div>
            <b id="my-display-name">Имя</b>
            <div style="font-size:11px; color:var(--accent);" id="my-display-id">ID</div>
          </div>
          <div class="search-box">
            <input type="text" id="search-input" placeholder="Поиск..." oninput="onSearchInput()">
          </div>
        </div>
        <div class="chat-list" id="chat-list"></div>
      </div>

      <div class="main-chat">
        <div class="chat-header">
          <div id="active-peer-name">Выберите чат</div>
        </div>
        <div class="messages-container" id="messages-container"></div>
        <div class="input-bar" id="input-bar" style="display:none;">
          <button class="icon-btn" onclick="triggerFileInput()">📎</button>
          <input type="file" id="file-input" style="display:none;" onchange="handleFileSelect(event)">
          
          <input type="text" id="msg-input" placeholder="Сообщение..." onkeydown="if(event.key==='Enter') sendMsg()">
          <button class="btn" style="width:auto; padding:10px 18px;" onclick="sendMsg()">➤</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    var currentUser = null;
    var activePeer = null;
    var selectedFile = null;

    async function handleGuestLogin() {
      var val = document.getElementById('auth-name').value;
      
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
          loadDialogs();
          if (activePeer) loadMessages();
        }, 2000);
      }
    }

    async function loadDialogs() {
      if (!currentUser) return;
      var res = await fetch('/api/dialogs/' + currentUser.id);
      var dialogs = await res.json();
      renderChatList(dialogs);
    }

    async function onSearchInput() {
      var q = document.getElementById('search-input').value.trim();
      if (!q) { loadDialogs(); return; }
      var res = await fetch('/api/users/search?q=' + encodeURIComponent(q));
      var users = await res.json();
      renderChatList(users.filter(function(u) { return u.id !== currentUser.id; }));
    }

    function renderChatList(list) {
      var container = document.getElementById('chat-list');
      container.innerHTML = '';
      list.forEach(function(item) {
        var div = document.createElement('div');
        div.className = 'chat-item';
        div.onclick = function() { openChat(item); };
        div.innerHTML = '<div class="avatar">' + (item.name[0] || 'U').toUpperCase() + '</div>' +
          '<div><b>' + item.name + '</b><div style="font-size:11px;">ID: ' + item.id + '</div></div>';
        container.appendChild(div);
      });
    }

    function openChat(peer) {
      activePeer = peer;
      document.getElementById('active-peer-name').innerText = peer.name + ' (ID: ' + peer.id + ')';
      document.getElementById('input-bar').style.display = 'flex';
      loadMessages();
    }

    async function loadMessages() {
      if (!activePeer) return;
      var res = await fetch('/api/messages/' + currentUser.id + '/' + activePeer.id);
      var messages = await res.json();
      var container = document.getElementById('messages-container');
      container.innerHTML = '';
      messages.forEach(function(m) {
        var div = document.createElement('div');
        div.className = 'msg ' + (m.senderId === currentUser.id ? 'my' : '');
        
        var html = '';
        if (m.text) html += '<div>' + m.text + '</div>';

        var fileType = m.fileType || '';
        if (m.fileData) {
          if (fileType.startsWith('image/')) {
            html += '<img src="' + m.fileData + '" class="media-preview" onclick="window.open(\'' + m.fileData + '\')">';
          } else if (fileType.startsWith('video/')) {
            html += '<video src="' + m.fileData + '" controls class="video-preview"></video>';
          } else {
            html += '<a class="file-link" href="' + m.fileData + '" download="' + (m.fileName || 'file') + '">📁 ' + (m.fileName || 'Файл') + '</a>';
          }
        }

        html += '<div style="font-size:9px; color:var(--text-muted); text-align:right; margin-top:3px;">' + (m.timestamp || '') + '</div>';
        div.innerHTML = html;
        container.appendChild(div);
      });
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
        alert('Файл выбран: ' + file.name);
      };
      reader.readAsDataURL(file);
    }

    async function sendMsg() {
      var input = document.getElementById('msg-input');
      var text = input.value.trim();
      if ((!text && !selectedFile) || !activePeer) return;

      var body = {
        senderId: currentUser.id,
        receiverId: activePeer.id,
        text: text,
        fileData: selectedFile ? selectedFile.data : '',
        fileName: selectedFile ? selectedFile.name : '',
        fileType: selectedFile ? selectedFile.type : ''
      };

      await fetch('/api/messages/send', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
      });

      input.value = '';
      selectedFile = null;
      document.getElementById('file-input').value = '';
      loadMessages();
    }
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => console.log(`[СЕРВЕР ЗАПУЩЕН] Порт: ${PORT}`));
