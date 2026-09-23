const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '150mb' }));

// Базовые пути и создание папок архива
const SERV_DIR = __dirname;
const ARXIV_DIR = path.join(SERV_DIR, 'arxiv');
const USERS_DIR = path.join(ARXIV_DIR, 'users');
const MESSAGES_DIR = path.join(ARXIV_DIR, 'messages');

[ARXIV_DIR, USERS_DIR, MESSAGES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const USERS_FILE = path.join(USERS_DIR, 'users.json');
const MESSAGES_FILE = path.join(MESSAGES_DIR, 'messages.json');

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, JSON.stringify([]));

function readUsers() { 
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } 
  catch(e) { return []; } 
}
function writeUsers(data) { fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2)); }

function readMessages() { 
  try { return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8')); } 
  catch(e) { return []; } 
}
function writeMessages(data) { fs.writeFileSync(MESSAGES_FILE, JSON.stringify(data, null, 2)); }

// Шифрование данных для безопасности сообщений в архиве
const SECRET_SHIFT = 7;
function encryptData(text) {
  if (!text) return text;
  let base64 = Buffer.from(text, 'utf8').toString('base64');
  let result = '';
  for (let i = 0; i < base64.length; i++) {
    result += String.fromCharCode(base64.charCodeAt(i) + SECRET_SHIFT);
  }
  return result;
}

function decryptData(text) {
  if (!text) return text;
  let base64 = '';
  for (let i = 0; i < text.length; i++) {
    base64 += String.fromCharCode(text.charCodeAt(i) - SECRET_SHIFT);
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

// Консольная команда D-1 (очистка гостей, чатов и файлов)
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  const input = data.toString().trim();
  if (input === 'D-1') {
    try {
      let users = readUsers();
      const nonGuestUsers = users.filter(u => !u.isGuest);
      const validUserIds = new Set(nonGuestUsers.map(u => u.id));

      const cleanedUsers = nonGuestUsers.map(u => ({
        ...u,
        contacts: (u.contacts || []).filter(id => validUserIds.has(id))
      }));

      writeUsers(cleanedUsers);
      writeMessages([]);

      console.log('\x1b[32m%s\x1b[0m', '[D-1] Данные успешно очищены: гости и сообщения удалены, зарегистрированные пользователи сохранены.');
    } catch (e) {
      console.error('[D-1 ERROR] Ошибка при выполнении очистки:', e);
    }
  }
});

// Регистрация
app.post('/api/register', (req, res) => {
  const { username, password, name } = req.body;
  const users = readUsers();

  if (!username || !password || !name) return res.status(400).json({ error: 'Заполните все поля.' });
  if (users.some(u => u.username && u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: 'Это имя пользователя уже занято.' });
  }

  if (password.length < 8 || !/[a-zA-Z]/.test(password)) {
    return res.status(400).json({ error: 'Пароль должен содержать как минимум 8 символов и хотя бы 1 латинскую букву.' });
  }

  const newUser = {
    id: 'id_' + Math.random().toString(36).substr(2, 9),
    username: username.trim(),
    password,
    name: name.trim(),
    avatar: '',
    isGuest: false,
    isBanned: false,
    contacts: []
  };

  users.push(newUser);
  writeUsers(users);
  res.json({ success: true, user: newUser });
});

// Авторизация
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = readUsers();
  const user = users.find(u => u.username && u.username.toLowerCase() === username.toLowerCase().trim() && u.password === password);

  if (!user) return res.status(401).json({ error: 'Неверный логин или пароль.' });
  if (user.isBanned) return res.status(403).json({ error: 'Ваш аккаунт заблокирован.' });

  res.json({ success: true, user });
});

// Вход гостя
app.post('/api/guest', (req, res) => {
  const { name } = req.body;
  const guestName = (name && name.trim()) ? name.trim() : ('Гость_' + Math.floor(Math.random() * 1000));
  const users = readUsers();

  const guestUser = {
    id: 'guest_' + Math.random().toString(36).substr(2, 9),
    username: 'guest_' + Math.floor(Math.random() * 10000),
    name: guestName, 
    avatar: '', 
    isGuest: true, 
    isBanned: false, 
    contacts: []
  };

  users.push(guestUser);
  writeUsers(users);

  res.json({ success: true, user: guestUser });
});

// Обновление профиля (автосохранение)
app.post('/api/user/profile', (req, res) => {
  const { userId, name, avatar } = req.body;
  const users = readUsers();
  const userIndex = users.findIndex(u => u.id === userId);

  if (userIndex === -1) return res.status(404).json({ error: 'Пользователь не найден.' });

  if (name !== undefined && name.trim()) users[userIndex].name = name.trim();
  if (avatar !== undefined) users[userIndex].avatar = avatar;

  writeUsers(users);
  res.json({ success: true, user: users[userIndex] });
});

// Удаление аккаунта полностью с сервера
app.delete('/api/user/:userId', (req, res) => {
  const { userId } = req.params;
  let users = readUsers();

  users = users.filter(u => u.id !== userId);
  users.forEach(u => {
    if (u.contacts) u.contacts = u.contacts.filter(cId => cId !== userId);
  });
  writeUsers(users);

  let messages = readMessages();
  messages = messages.filter(m => m.senderId !== userId && m.receiverId !== userId);
  writeMessages(messages);

  res.json({ success: true });
});

// Поиск пользователей
app.get('/api/users/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const currentUserId = req.query.userId || '';
  if (!q) return res.json([]);
  
  const users = readUsers();
  const results = users.filter(u => {
    if (u.id === currentUserId) return false;
    const idMatch = u.id && u.id.toLowerCase().includes(q);
    const usernameMatch = u.username && u.username.toLowerCase().includes(q);
    const nameMatch = u.name && u.name.toLowerCase().includes(q);
    return idMatch || usernameMatch || nameMatch;
  }).map(u => ({ 
    id: u.id, 
    name: u.name, 
    username: u.username, 
    avatar: u.avatar, 
    isGuest: u.isGuest 
  }));

  res.json(results);
});

// Отправка сообщений
app.post('/api/messages/send', (req, res) => {
  const { senderId, receiverId, text, fileData, fileName, fileType } = req.body;
  const users = readUsers();
  const sender = users.find(u => u.id === senderId);

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

  if (sender && !sender.contacts.includes(receiverId)) {
    sender.contacts.push(receiverId);
  }
  const receiver = users.find(u => u.id === receiverId);
  if (receiver && !receiver.contacts.includes(senderId)) {
    receiver.contacts.push(senderId);
  }
  writeUsers(users);

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

// Получение сообщений конкретного чата
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
  const users = readUsers();
  const currentUser = users.find(u => u.id === userId);
  const messages = readMessages();

  const peerIds = new Set(currentUser ? currentUser.contacts || [] : []);
  messages.forEach(m => {
    if (m.senderId === userId) peerIds.add(m.receiverId);
    if (m.receiverId === userId) peerIds.add(m.senderId);
  });

  const dialogs = users.filter(u => peerIds.has(u.id)).map(u => ({
    id: u.id, name: u.name, username: u.username, avatar: u.avatar, isGuest: u.isGuest
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
      --modal-bg: #17212b;
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
      --modal-bg: #ffffff;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-tap-highlight-color: transparent; }
    html, body { height: 100dvh; width: 100vw; background: var(--bg-app); color: var(--text-main); overflow: hidden; position: fixed; }

    .screen { display: none; height: 100dvh; width: 100vw; position: absolute; top: 0; left: 0; }
    .active { display: flex; }

    .auth-container { margin: auto; width: 90%; max-width: 400px; background: var(--bg-sidebar); padding: 25px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
    .auth-container h2 { margin-bottom: 20px; text-align: center; color: var(--accent); }
    .input-group { margin-bottom: 15px; }
    .input-group label { display: block; margin-bottom: 5px; font-size: 13px; color: var(--text-muted); }
    .input-group input, .input-group select { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--bg-input); background: var(--bg-input); color: var(--text-main); outline: none; }
    .btn { width: 100%; padding: 12px; background: var(--accent); color: #fff; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; margin-top: 10px; }
    .btn-secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
    .btn-danger { background: #e53935; color: #fff; }
    .error-msg { color: #e53935; font-size: 12px; margin-top: 8px; text-align: center; display: none; }

    #app-container { display: flex; width: 100%; height: 100%; }
    .sidebar { width: 320px; background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
    .sidebar-header { padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }
    .user-profile-bar { display: flex; align-items: center; justify-content: space-between; cursor: pointer; padding: 4px; border-radius: 8px; }
    .user-profile-bar:hover { background: var(--bg-hover); }
    .user-info-brief { display: flex; align-items: center; gap: 10px; overflow: hidden; }

    .search-box { position: relative; }
    .search-box input { width: 100%; padding: 10px 12px; border-radius: 18px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; font-size: 14px; }
    .clear-search { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; color: var(--text-muted); display: none; }

    .chat-list { flex: 1; overflow-y: auto; }
    .chat-item { display: flex; align-items: center; gap: 12px; padding: 12px; cursor: pointer; border-bottom: 1px solid var(--border); transition: background 0.2s; }
    .chat-item:hover, .chat-item.active { background: var(--bg-active); }
    .avatar { width: 42px; height: 42px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; font-weight: bold; color: #fff; overflow: hidden; object-fit: cover; flex-shrink: 0; }
    .avatar img { width: 100%; height: 100%; object-fit: cover; }

    .main-chat { flex: 1; display: flex; flex-direction: column; background: var(--bg-app); position: relative; }
    .chat-header { background: var(--bg-sidebar); padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); height: 60px; }
    .messages-container { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px; -webkit-overflow-scrolling: touch; }
    
    .msg { max-width: 75%; padding: 10px 14px; border-radius: 12px; background: var(--bg-msg-peer); align-self: flex-start; word-break: break-word; position: relative; user-select: none; }
    .msg.my { background: var(--bg-msg-my); align-self: flex-end; }
    
    .media-preview { width: 260px; height: 180px; max-width: 100%; border-radius: 8px; margin-top: 6px; object-fit: cover; display: block; cursor: pointer; background: #000; }
    .video-preview { width: 260px; max-width: 100%; border-radius: 8px; margin-top: 6px; display: block; }
    .file-link { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-input); border-radius: 6px; color: var(--accent); text-decoration: none; margin-top: 5px; font-size: 13px; }

    .input-bar { background: var(--bg-sidebar); padding: 10px; display: flex; gap: 10px; align-items: center; flex-shrink: 0; border-top: 1px solid var(--border); }
    .input-bar input[type="text"] { flex: 1; padding: 12px; border-radius: 20px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; }
    .icon-btn { cursor: pointer; font-size: 22px; user-select: none; border: none; background: transparent; color: var(--text-main); }

    .modal-overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.6); display: none; align-items: center; justify-content: center; z-index: 1000; }
    .modal-overlay.active { display: flex; }
    .modal-card { background: var(--modal-bg); width: 90%; max-width: 380px; padding: 20px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
    .modal-card h3 { margin-bottom: 15px; color: var(--text-main); text-align: center; }

    .profile-avatar-picker { width: 90px; height: 90px; border-radius: 50%; margin: 0 auto 10px; position: relative; overflow: hidden; cursor: pointer; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 32px; color: #fff; }
    .profile-avatar-picker img { width: 100%; height: 100%; object-fit: cover; }

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

  <!-- Авторизация / Регистрация -->
  <div id="auth-screen" class="screen active">
    <div class="auth-container">
      <h2 id="auth-title">Вход в мессенджер</h2>
      <div id="auth-error" class="error-msg"></div>
      
      <div class="input-group" id="group-name" style="display:none;">
        <label>Имя</label>
        <input type="text" id="auth-name" placeholder="Введите имя">
      </div>
      <div class="input-group" id="group-username">
        <label>Имя пользователя (Login)</label>
        <input type="text" id="auth-username" placeholder="@username">
      </div>
      <div class="input-group" id="group-password">
        <label id="pass-label">Пароль</label>
        <input type="password" id="auth-password" placeholder="••••••••">
      </div>

      <button class="btn" id="btn-main-action" onclick="handleAuth()">Войти</button>
      <button class="btn btn-secondary" id="btn-toggle-mode" onclick="toggleAuthMode()">Нет аккаунта? Зарегистрироваться</button>
      <button class="btn btn-secondary" onclick="promptGuestLogin()" style="margin-top:10px; border-color:#888; color:#888;">Зайти как гость</button>
    </div>
  </div>

  <!-- Главный экран -->
  <div id="app-screen" class="screen">
    <div id="app-container">
      
      <div class="sidebar">
        <div class="sidebar-header">
          <div class="user-profile-bar" onclick="openProfileModal()">
            <div class="user-info-brief">
              <div class="avatar" id="my-avatar-icon">U</div>
              <div>
                <b id="my-display-name">Имя</b>
                <div style="font-size:11px; color:var(--accent);" id="my-display-id">ID</div>
              </div>
            </div>
            <span style="font-size:18px;">⚙️</span>
          </div>

          <div class="search-box">
            <input type="text" id="search-input" placeholder="Поиск по ID, имени или логину..." oninput="onSearchInput()" onblur="if(!this.value.trim()) clearSearch()">
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

        <div class="messages-container" id="messages-container"></div>

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

  <!-- Модальное окно Профиля -->
  <div class="modal-overlay" id="profile-modal">
    <div class="modal-card">
      <h3>Профиль</h3>
      
      <div class="profile-avatar-picker" onclick="triggerAvatarUpload()">
        <span id="profile-avatar-preview">U</span>
        <input type="file" id="avatar-input" accept="image/*" style="display:none;" onchange="handleAvatarSelect(event)">
      </div>
      <div style="text-align:center; margin-bottom:12px;">
        <button class="btn btn-secondary" style="width:auto; padding:4px 10px; font-size:11px;" onclick="removeAvatar()">Удалить аватарку</button>
      </div>

      <div id="profile-username-display" style="text-align:center; font-weight:bold; color:var(--accent); margin-bottom:15px; font-size:14px;">@username</div>

      <div class="input-group">
        <label>Имя</label>
        <input type="text" id="profile-name-input" placeholder="Ваше имя" oninput="onProfileNameChange(this.value)">
      </div>

      <div class="input-group">
        <label>Тема оформления</label>
        <select id="theme-select" onchange="changeTheme(this.value)">
          <option value="dark">Тёмная</option>
          <option value="light">Светлая</option>
        </select>
      </div>

      <div id="profile-action-buttons" style="display:flex; flex-direction:column; gap:8px; margin-top:15px;"></div>

      <button class="btn btn-secondary" style="margin-top:10px;" onclick="closeProfileModal()">Закрыть</button>
    </div>
  </div>

  <!-- Контекстное меню действия с сообщением -->
  <div class="msg-actions-sheet" id="msg-actions-sheet">
    <button class="btn btn-danger" onclick="deleteSelectedMessage()">Удалить сообщение</button>
    <button class="btn btn-secondary" onclick="closeMsgActions()">Отмена</button>
  </div>

  <script>
    let currentUser = null;
    let activePeer = null;
    let isRegisterMode = false;
    let selectedFile = null;
    
    let mediaRecorder = null;
    let audioChunks = [];
    let isRecording = false;

    let lastDialogsHash = '';
    let lastMessagesHash = '';

    let selectedMsgId = null;
    let longTouchTimer = null;
    let nameSaveDebounce = null;

    const savedTheme = localStorage.getItem('app_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);

    function changeTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('app_theme', theme);
    }

    function toggleAuthMode() {
      isRegisterMode = !isRegisterMode;
      document.getElementById('auth-title').innerText = isRegisterMode ? 'Регистрация' : 'Вход в мессенджер';
      document.getElementById('group-name').style.display = isRegisterMode ? 'block' : 'none';
      
      const passLabel = document.getElementById('pass-label');
      passLabel.innerText = isRegisterMode ? 'Пароль (мин. 8 символов, 1 латинская)' : 'Пароль';

      document.getElementById('btn-main-action').innerText = isRegisterMode ? 'Зарегистрироваться' : 'Войти';
      document.getElementById('btn-toggle-mode').innerText = isRegisterMode ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться';
      document.getElementById('auth-error').style.display = 'none';
    }

    async function handleAuth() {
      const username = document.getElementById('auth-username').value.trim();
      const password = document.getElementById('auth-password').value;
      const name = document.getElementById('auth-name').value.trim();
      const errBox = document.getElementById('auth-error');

      const endpoint = isRegisterMode ? '/api/register' : '/api/login';
      const body = isRegisterMode ? { username, password, name } : { username, password };

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!data.success) {
          errBox.innerText = data.error;
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

    async function promptGuestLogin() {
      const guestName = prompt("Введите ваше имя для входа в качестве гостя:", "Гость");
      if (guestName === null) return;

      try {
        const res = await fetch('/api/guest', { 
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ name: guestName })
        });
        const data = await res.json();
        currentUser = data.user;
        startApp();
      } catch(e) {
        alert('Ошибка при создании гостевого аккаунта.');
      }
    }

    function startApp() {
      document.getElementById('auth-screen').classList.remove('active');
      document.getElementById('app-screen').classList.add('active');

      updateMyProfileUI();
      loadDialogs();
      
      setInterval(() => {
        if (currentUser && !isRecording) {
          loadDialogsQuiet();
          if (activePeer) loadMessagesQuiet();
        }
      }, 1500);
    }

    function logout() {
      currentUser = null;
      activePeer = null;
      closeProfileModal();
      document.getElementById('app-screen').classList.remove('active');
      document.getElementById('auth-screen').classList.add('active');
      document.getElementById('input-bar').style.display = 'none';
      document.getElementById('messages-container').innerHTML = '';
      document.getElementById('active-peer-name').innerText = 'Выберите чат';
    }

    async function deleteAccount() {
      if (!currentUser) return;
      if (!confirm('Вы уверены, что хотите удалить аккаунт? Все ваши сообщения и данные будут безвозвратно удалены.')) return;

      try {
        const res = await fetch('/api/user/' + currentUser.id, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          alert('Ваш аккаунт успешно удалён.');
          logout();
        } else {
          alert('Не удалось удалить аккаунт.');
        }
      } catch(e) {
        alert('Ошибка при удалении аккаунта.');
      }
    }

    function updateMyProfileUI() {
      if (!currentUser) return;
      document.getElementById('my-display-name').innerText = currentUser.name + (currentUser.isGuest ? ' (Гость)' : '');
      document.getElementById('my-display-id').innerText = 'ID: ' + currentUser.id;

      const avatarContainer = document.getElementById('my-avatar-icon');
      if (currentUser.avatar) {
        avatarContainer.innerHTML = \`<img src="\${currentUser.avatar}">\`;
      } else {
        avatarContainer.innerText = (currentUser.name || 'U')[0].toUpperCase();
      }
    }

    /* Автосохранение и управление профилем */
    function openProfileModal() {
      document.getElementById('profile-name-input').value = currentUser.name;
      document.getElementById('theme-select').value = localStorage.getItem('app_theme') || 'dark';
      
      const usernameDisplay = document.getElementById('profile-username-display');
      usernameDisplay.innerText = currentUser.isGuest ? 'Гостевой аккаунт' : ('@' + currentUser.username);

      renderProfileAvatarPreview();

      const actionsDiv = document.getElementById('profile-action-buttons');
      if (currentUser.isGuest) {
        actionsDiv.innerHTML = \`
          <button class="btn" onclick="logout()">Войти в аккаунт</button>
          <button class="btn btn-secondary" onclick="logout()">Выйти из гостя</button>
        \`;
      } else {
        actionsDiv.innerHTML = \`
          <button class="btn btn-secondary" onclick="logout()">Выйти из аккаунта</button>
          <button class="btn btn-danger" onclick="deleteAccount()">Удалить аккаунт</button>
        \`;
      }

      document.getElementById('profile-modal').classList.add('active');
    }

    function closeProfileModal() {
      document.getElementById('profile-modal').classList.remove('active');
    }

    function renderProfileAvatarPreview() {
      const preview = document.getElementById('profile-avatar-preview');
      if (currentUser && currentUser.avatar) {
        preview.innerHTML = \`<img src="\${currentUser.avatar}">\`;
      } else {
        preview.innerText = (currentUser ? currentUser.name : 'U')[0].toUpperCase();
      }
    }

    function onProfileNameChange(val) {
      clearTimeout(nameSaveDebounce);
      nameSaveDebounce = setTimeout(() => {
        if (val.trim()) autoSaveProfile(val.trim(), undefined);
      }, 400);
    }

    function triggerAvatarUpload() {
      document.getElementById('avatar-input').click();
    }

    function handleAvatarSelect(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(evt) {
        autoSaveProfile(null, evt.target.result);
      };
      reader.readAsDataURL(file);
    }

    function removeAvatar() {
      autoSaveProfile(null, '');
    }

    async function autoSaveProfile(newName = null, newAvatar = undefined) {
      if (!currentUser) return;
      const nameToSend = newName !== null ? newName : currentUser.name;
      const avatarToSend = newAvatar !== undefined ? newAvatar : currentUser.avatar;

      try {
        const res = await fetch('/api/user/profile', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            userId: currentUser.id,
            name: nameToSend,
            avatar: avatarToSend
          })
        });
        const data = await res.json();
        if (data.success) {
          currentUser = data.user;
          updateMyProfileUI();
          renderProfileAvatarPreview();
          loadDialogs();
          if (activePeer) loadMessages();
        }
      } catch(e) {
        console.error('Ошибка сохранения профиля:', e);
      }
    }

    /* Загрузка и поиск чатов */
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
        
        const currentHash = JSON.stringify(dialogs.map(d => d.id + d.name + d.avatar));
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
        const res = await fetch(\`/api/users/search?q=\${encodeURIComponent(q)}&userId=\${currentUser.id}\`);
        const users = await res.json();
        renderChatList(users);
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

      if (list.length === 0) {
        container.innerHTML = '<div style="padding:15px; color:var(--text-muted); font-size:12px; text-align:center;">Ничего не найдено</div>';
        return;
      }

      list.forEach(item => {
        const div = document.createElement('div');
        div.className = 'chat-item ' + (currentActiveId === item.id ? 'active' : '');
        div.onclick = () => openChat(item);
        
        const avatarContent = item.avatar 
          ? \`<img src="\${item.avatar}">\` 
          : (item.name || 'U')[0].toUpperCase();

        div.innerHTML = \`
          <div class="avatar">\${avatarContent}</div>
          <div>
            <div style="font-weight:bold;">\${item.name} \${item.isGuest ? '<span style="font-size:10px; color:var(--text-muted);">(Гость)</span>' : ''}</div>
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
      activePeer = null;
      document.getElementById('input-bar').style.display = 'none';
      document.getElementById('messages-container').innerHTML = '';
      document.getElementById('active-peer-name').innerText = 'Выберите чат';
    }

    /* Сообщения */
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

        if (m.fileData) {
          if (m.fileType.startsWith('image/')) {
            html += \`<img src="\${m.fileData}" class="media-preview" onclick="window.open('\${m.fileData}')">\`;
          } else if (m.fileType.startsWith('video/')) {
            html += \`<video src="\${m.fileData}" controls class="video-preview"></video>\`;
          } else if (m.fileType.startsWith('audio/')) {
            html += \`<audio src="\${m.fileData}" controls style="margin-top:5px; max-width:100%;"></audio>\`;
          } else {
            html += \`<a class="file-link" href="\${m.fileData}" download="\${m.fileName}">📁 \${m.fileName}</a>\`;
          }
        }

        html += \`<div style="font-size:9px; color:var(--text-muted); text-align:right; margin-top:3px;">\${m.timestamp}</div>\`;
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
        const res = await fetch('/api/messages/' + selectedMsgId, { method: 'DELETE' });
        const data = await res.json();
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

    /* Файлы и Запись Голоса */
    function triggerFileInput() {
      document.getElementById('file-input').click();
    }

    function handleFileSelect(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(evt) {
        selectedFile = { data: evt.target.result, name: file.name, type: file.type };
        alert('Файл прикреплен: ' + file.name);
      };
      reader.readAsDataURL(file);
    }

    function getSupportedMimeType() {
      const types = [
        'audio/webm;codecs=opus',
        'audio/mp4',
        'audio/aac',
        'audio/webm',
        'audio/ogg;codecs=opus'
      ];
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
              selectedFile = { data: evt.target.result, name: 'voice_message', type: actualType };
              sendMsg();
            };
            reader.readAsDataURL(audioBlob);
            
            stream.getTracks().forEach(track => track.stop());
          };

          mediaRecorder.start();
          isRecording = true;
          micBtn.innerText = '🔴';
        } catch (e) { alert('Нет доступа к микрофону или устройство не поддерживает запись.'); }
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
      if (!text && !selectedFile) return;

      const body = {
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

