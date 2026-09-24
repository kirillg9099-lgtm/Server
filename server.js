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

function encryptText(text) {
  if (!text) return '';
  try { return Buffer.from(String(text), 'utf8').toString('base64'); } catch (e) { return text; }
}

function decryptText(text) {
  if (!text) return '';
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    if (decoded && !decoded.includes('\uFFFD')) return decoded;
  } catch (e) {}
  return text;
}

app.post('/api/register', (req, res) => {
  let { name } = req.body;
  const accounts = readAccounts();

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Введите имя' });
  }

  const finalId = 'id_' + Math.random().toString(36).substr(2, 9);
  const user = {
    id: finalId,
    name: name.trim(),
    avatar: '',
    contacts: [],
    blockedContacts: [],
    updatedAt: Date.now()
  };
  accounts.push(user);

  writeAccounts(accounts);
  res.json({ success: true, user });
});

app.post('/api/ping', (req, res) => {
  const { id, name, avatar, contacts, knownUsers } = req.body;
  if (!id) return res.status(400).json({ error: 'No id' });

  const accounts = readAccounts();
  
  if (Array.isArray(knownUsers)) {
    knownUsers.forEach(kUser => {
      if (!kUser.id) return;
      let acc = accounts.find(a => a.id === kUser.id);
      if (!acc) {
        accounts.push({
          id: kUser.id,
          name: kUser.name || 'Пользователь',
          avatar: kUser.avatar || '',
          contacts: [],
          blockedContacts: [],
          updatedAt: Date.now()
        });
      }
    });
  }

  let user = accounts.find(u => u.id === id);
  if (!user) {
    user = {
      id,
      name: name || 'Пользователь',
      avatar: avatar || '',
      contacts: Array.isArray(contacts) ? contacts : [],
      blockedContacts: [],
      updatedAt: Date.now()
    };
    accounts.push(user);
  } else {
    user.updatedAt = Date.now();
    if (name) user.name = name;
    if (avatar !== undefined) user.avatar = avatar;
    if (Array.isArray(contacts)) {
      user.contacts = Array.from(new Set([...(user.contacts || []), ...contacts]));
    }
  }

  writeAccounts(accounts);
  res.json({ success: true, user });
});

app.post('/api/profile/update', (req, res) => {
  const { id, name, avatar } = req.body;
  const accounts = readAccounts();
  let user = accounts.find(u => u.id === id);

  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  if (name && name.trim()) user.name = name.trim();
  if (avatar !== undefined) user.avatar = avatar;
  user.updatedAt = Date.now();

  writeAccounts(accounts);
  res.json({ success: true, user });
});

app.post('/api/users/block', (req, res) => {
  const { userId, peerId, block } = req.body;
  const accounts = readAccounts();
  let user = accounts.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (!user.blockedContacts) user.blockedContacts = [];
  if (block) {
    if (!user.blockedContacts.includes(peerId)) user.blockedContacts.push(peerId);
  } else {
    user.blockedContacts = user.blockedContacts.filter(id => id !== peerId);
  }

  writeAccounts(accounts);
  res.json({ success: true, blockedContacts: user.blockedContacts });
});

app.get('/api/users/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  
  const accounts = readAccounts();
  const results = accounts.filter(u => {
    return (u.id && u.id.toLowerCase().includes(q)) || (u.name && u.name.toLowerCase().includes(q));
  }).map(u => ({ id: u.id, name: u.name, avatar: u.avatar || '' }));

  res.json(results);
});

app.post('/api/messages/send', (req, res) => {
  const { senderId, receiverId, text, fileData, fileName, fileType } = req.body;
  const accounts = readAccounts();
  const sender = accounts.find(u => u.id === senderId);
  const receiver = accounts.find(u => u.id === receiverId);

  if (sender && sender.blockedContacts && sender.blockedContacts.includes(receiverId)) {
    return res.status(403).json({ error: 'Сообщения отключены вами' });
  }
  if (receiver && receiver.blockedContacts && receiver.blockedContacts.includes(senderId)) {
    return res.status(403).json({ error: 'Сообщения отключены получателем' });
  }

  const messages = readMessages();
  const newMsg = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    senderId,
    receiverId,
    text: encryptText(text || ''),
    fileData: fileData || '',
    fileName: fileName || '',
    fileType: fileType || '',
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };

  messages.push(newMsg);
  writeMessages(messages);
  res.json({ success: true });
});

app.delete('/api/messages/:msgId', (req, res) => {
  const { msgId } = req.params;
  let messages = readMessages();
  messages = messages.filter(m => m.id !== msgId);
  writeMessages(messages);
  res.json({ success: true });
});

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

  const dialogs = accounts.filter(u => peerIds.has(u.id) && u.id !== userId).map(u => ({
    id: u.id, name: u.name, avatar: u.avatar || ''
  }));

  res.json(dialogs);
});

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
      --bg-app: #0e1621; --bg-sidebar: #17212b; --bg-input: #242f3d;
      --bg-active: #2b5278; --bg-msg-peer: #182533; --bg-msg-my: #2b5278;
      --text-main: #ffffff; --text-muted: #7f91a4; --accent: #5288c1; --border: #0e1621;
    }
    :root[data-theme="light"] {
      --bg-app: #e6ebee; --bg-sidebar: #ffffff; --bg-input: #f1f3f5;
      --bg-active: #e3edf7; --bg-msg-peer: #ffffff; --bg-msg-my: #eeffde;
      --text-main: #000000; --text-muted: #707579; --accent: #3390ec; --border: #e6ebee;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: sans-serif; }
    html, body { height: 100dvh; width: 100vw; background: var(--bg-app); color: var(--text-main); overflow: hidden; position: fixed; }
    .screen { display: none; height: 100dvh; width: 100vw; position: absolute; top: 0; left: 0; }
    .active { display: flex; }
    .auth-container { margin: auto; width: 90%; max-width: 360px; background: var(--bg-sidebar); padding: 25px; border-radius: 12px; text-align: center; }
    .input-group { margin-bottom: 15px; text-align: left; }
    .input-group input { width: 100%; padding: 12px; border-radius: 8px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; }
    .btn { width: 100%; padding: 12px; background: var(--accent); color: #fff; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; margin-top: 10px; }
    .btn-secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
    #app-container { display: flex; width: 100%; height: 100%; }
    .sidebar { width: 320px; background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
    .sidebar-header { padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }
    .user-profile-bar { display: flex; align-items: center; justify-content: space-between; padding: 4px; cursor: pointer; }
    .avatar-circle { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: var(--accent); display: flex; align-items: center; justify-content: center; color: #fff; font-weight: bold; overflow: hidden; }
    .avatar-circle img { width: 100%; height: 100%; object-fit: cover; }
    .chat-list { flex: 1; overflow-y: auto; }
    .chat-item { display: flex; align-items: center; gap: 12px; padding: 12px; cursor: pointer; border-bottom: 1px solid var(--border); }
    .chat-item:hover, .chat-item.active { background: var(--bg-active); }
    .main-chat { flex: 1; display: flex; flex-direction: column; background: var(--bg-app); }
    .chat-header { background: var(--bg-sidebar); padding: 8px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); height: 60px; }
    .messages-container { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px; }
    .msg { max-width: 75%; padding: 10px 14px; border-radius: 12px; background: var(--bg-msg-peer); align-self: flex-start; word-break: break-word; }
    .msg.my { background: var(--bg-msg-my); align-self: flex-end; }
    .input-bar { background: var(--bg-sidebar); padding: 10px; display: flex; gap: 10px; align-items: center; border-top: 1px solid var(--border); }
    .input-bar input[type="text"] { flex: 1; padding: 12px; border-radius: 20px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; }
    .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 2000; display: none; align-items: center; justify-content: center; }
    .modal-overlay.active { display: flex; }
    .profile-card { background: var(--bg-sidebar); width: 90%; max-width: 380px; border-radius: 16px; padding: 25px; display: flex; flex-direction: column; align-items: center; text-align: center; }
    .profile-avatar-big { width: 90px; height: 90px; border-radius: 50%; object-fit: cover; background: var(--accent); margin-bottom: 15px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 32px; font-weight: bold; overflow: hidden; }
    .profile-avatar-big img { width: 100%; height: 100%; object-fit: cover; }
    .profile-link-btn { background: none; border: none; color: var(--accent); font-size: 14px; cursor: pointer; padding: 5px; }
    @media (max-width: 600px) {
      .sidebar { width: 100%; }
      .main-chat { display: none; }
      .app-mobile-chat .sidebar { display: none; }
      .app-mobile-chat .main-chat { display: flex; }
    }
  </style>
</head>
<body>

  <div id="auth-screen" class="screen active">
    <div class="auth-container">
      <h2>Вход</h2>
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
          <div class="user-profile-bar" onclick="openMyProfile()">
            <div class="avatar-circle" id="my-avatar-circle"></div>
            <div>
              <b id="my-display-name">Имя</b>
              <div style="font-size:11px; color:var(--accent);" id="my-display-id">ID</div>
            </div>
            <button class="btn btn-secondary" style="width:34px; height:34px; padding:0; border-radius:50%;" onclick="event.stopPropagation(); toggleTheme()">🌙</button>
          </div>
        </div>
        <div class="chat-list" id="chat-list"></div>
      </div>

      <div class="main-chat">
        <div class="chat-header">
          <button class="btn btn-secondary" style="width:auto; padding:6px 12px; display:none;" id="back-to-list-btn" onclick="closeMobileChat()">←</button>
          <div style="font-weight:bold;" id="active-peer-name">Выберите чат</div>
          <div></div>
        </div>
        <div class="messages-container" id="messages-container">
          <div style="margin:auto; color:var(--text-muted);">Выберите диалог</div>
        </div>
        <div class="input-bar" id="input-bar" style="display:none;">
          <input type="text" id="msg-input" placeholder="Сообщение..." onkeydown="if(event.key==='Enter') sendMsg()">
          <button class="btn" style="width:auto; padding:10px 18px;" onclick="sendMsg()">➤</button>
        </div>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="my-profile-modal">
    <div class="profile-card">
      <div class="profile-avatar-big" id="my-profile-avatar-view"></div>
      <div class="input-group" style="width:100%;">
        <input type="text" id="edit-my-name-input" placeholder="Имя...">
      </div>
      <button class="profile-link-btn" onclick="triggerAvatarInput()">Загрузить фото</button>
      <input type="file" id="avatar-file-input" style="display:none;" accept="image/*" onchange="handleAvatarSelect(event)">
      <button class="btn" onclick="saveMyProfileChanges()">Сохранить</button>
      <button class="btn btn-secondary" onclick="closeMyProfile()">Закрыть</button>
    </div>
  </div>

  <script>
    let currentUser = null;
    let activePeer = null;
    let tempAvatar = '';
    let localKnownUsers = JSON.parse(localStorage.getItem('messenger_known_users') || '{}');

    window.addEventListener('DOMContentLoaded', () => {
      const savedUser = localStorage.getItem('messenger_user');
      if (savedUser) {
        try {
          currentUser = JSON.parse(savedUser);
          startApp();
        } catch(e) {}
      }
    });

    function toggleTheme() {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
    }

    function renderAvatarIntoElement(el, userObj) {
      if (!el) return;
      el.innerHTML = '';
      if (userObj && userObj.avatar) {
        const img = document.createElement('img');
        img.src = userObj.avatar;
        el.appendChild(img);
      } else if (userObj && userObj.name) {
        el.innerText = userObj.name.charAt(0).toUpperCase();
      } else {
        el.innerText = '?';
      }
    }

    async function registerUser() {
      const name = document.getElementById('auth-name').value.trim();
      if (!name) return;
      try {
        const res = await fetch('/api/register', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (data.success) {
          currentUser = data.user;
          localStorage.setItem('messenger_user', JSON.stringify(currentUser));
          startApp();
        }
      } catch(e) {}
    }

    function startApp() {
      document.getElementById('auth-screen').classList.remove('active');
      document.getElementById('app-screen').classList.add('active');
      updateMyProfileUI();
      loadDialogs();
      setInterval(() => { if (currentUser) loadDialogs(); }, 3000);
    }

    function updateMyProfileUI() {
      document.getElementById('my-display-name').innerText = currentUser.name;
      document.getElementById('my-display-id').innerText = 'ID: ' + currentUser.id;
      renderAvatarIntoElement(document.getElementById('my-avatar-circle'), currentUser);
    }

    function openMyProfile() {
      tempAvatar = currentUser.avatar || '';
      document.getElementById('edit-my-name-input').value = currentUser.name;
      renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), { name: currentUser.name, avatar: tempAvatar });
      document.getElementById('my-profile-modal').classList.add('active');
    }

    function closeMyProfile() {
      document.getElementById('my-profile-modal').classList.remove('active');
    }

    function triggerAvatarInput() {
      const input = document.getElementById('avatar-file-input');
      input.value = ''; // Сброс позволяет выбрать тот же самый файл повторно
      input.click();
    }

    function handleAvatarSelect(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(evt) {
        tempAvatar = evt.target.result;
        renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), { name: currentUser.name, avatar: tempAvatar });
      };
      reader.readAsDataURL(file);
    }

    async function saveMyProfileChanges() {
      const newName = document.getElementById('edit-my-name-input').value.trim();
      if (newName) currentUser.name = newName;
      currentUser.avatar = tempAvatar;

      try {
        const res = await fetch('/api/profile/update', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar })
        });
        const data = await res.json();
        if (data.success) {
          currentUser = data.user;
          localStorage.setItem('messenger_user', JSON.stringify(currentUser));
          updateMyProfileUI();
          closeMyProfile();
        }
      } catch(e) {}
    }

    async function loadDialogs() {
      try {
        const res = await fetch('/api/dialogs/' + currentUser.id);
        const dialogs = await res.json();
        renderChatList(dialogs);
      } catch(e) {}
    }

    function renderChatList(list) {
      const container = document.getElementById('chat-list');
      container.innerHTML = '';
      list.forEach(item => {
        const div = document.createElement('div');
        div.className = 'chat-item';
        div.onclick = () => openChat(item);
        div.innerHTML = `<div class="avatar-circle" id="av_${item.id}"></div><div><b>${item.name}</b></div>`;
        container.appendChild(div);
        renderAvatarIntoElement(document.getElementById('av_' + item.id), item);
      });
    }

    function openChat(peer) {
      activePeer = peer;
      document.getElementById('active-peer-name').innerText = peer.name;
      document.getElementById('input-bar').style.display = 'flex';
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
        const container = document.getElementById('messages-container');
        container.innerHTML = messages.map(m => \`<div class="msg \${m.senderId === currentUser.id ? 'my' : ''}">\${m.text}</div>\`).join('');
      } catch(e) {}
    }

    async function sendMsg() {
      if (!activePeer) return;
      const input = document.getElementById('msg-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        await fetch('/api/messages/send', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ senderId: currentUser.id, receiverId: activePeer.id, text })
        });
        loadMessages();
      } catch(e) {}
    }
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => console.log(`[СЕРВЕР ЗАПУЩЕН] Порт: ${PORT}`));
