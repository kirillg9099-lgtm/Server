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

// Регистрация с проверкой коллизий ID
app.post('/api/register', (req, res) => {
  let { id, name, avatar, contacts } = req.body;
  const accounts = readAccounts();

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Введите имя' });
  }

  // Проверка на коллизию ID (если ID занят другим пользователем с другим именем/сессией)
  if (id) {
    const existingIndex = accounts.findIndex(u => u.id === id);
    if (existingIndex !== -1) {
      // Если ID занят, но это другой пользователь (например, совпал рандом), меняем ID для нового
      // Проверяем по совпадению: если имя сильно отличается и это не тот же девайс, даем новый ID
      // Для простоты: если ID уже есть, но регистрируется новый клиент, проверим, не занят ли он.
    }
  }

  let finalId = id;
  if (!finalId || accounts.some(u => u.id === finalId && u.name !== name.trim())) {
    finalId = 'id_' + Math.random().toString(36).substr(2, 9);
  }

  let user = accounts.find(u => u.id === finalId);
  if (user) {
    user.name = name.trim();
    if (avatar !== undefined) user.avatar = avatar;
    user.updatedAt = Date.now();
    if (Array.isArray(contacts)) {
      user.contacts = Array.from(new Set([...(user.contacts || []), ...contacts]));
    }
  } else {
    user = {
      id: finalId,
      name: name.trim(),
      avatar: avatar || '',
      contacts: Array.isArray(contacts) ? contacts : [],
      blockedContacts: [],
      updatedAt: Date.now()
    };
    accounts.push(user);
  }

  writeAccounts(accounts);
  res.json({ success: true, user });
});

// Пинг для поддержания активности и синхронизации кэшированных данных/профиля
app.post('/api/ping', (req, res) => {
  const { id, name, avatar, contacts, knownUsers } = req.body;
  if (!id) return res.status(400).json({ error: 'No id' });

  const accounts = readAccounts();
  
  // Синхронизация кэшированных пользователей с сервера
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

// Обновление профиля
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

// Получение информации о пользователе (для профиля)
app.get('/api/users/:userId', (req, res) => {
  const accounts = readAccounts();
  const user = accounts.find(u => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json({ id: user.id, name: user.name, avatar: user.avatar || '' });
});

// Блокировка/разблокировка чата с пользователем
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

// Поиск аккаунтов
app.get('/api/users/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  
  const accounts = readAccounts();
  const results = accounts.filter(u => {
    return (u.id && u.id.toLowerCase().includes(q)) || (u.name && u.name.toLowerCase().includes(q));
  }).map(u => ({ id: u.id, name: u.name, avatar: u.avatar || '' }));

  res.json(results);
});

// Отправка сообщений
app.post('/api/messages/send', (req, res) => {
  const { senderId, receiverId, text, fileData, fileName, fileType } = req.body;
  const accounts = readAccounts();
  const sender = accounts.find(u => u.id === senderId);
  const receiver = accounts.find(u => u.id === receiverId);

  if (sender && sender.blockedContacts && sender.blockedContacts.includes(receiverId)) {
    return res.status(403.1).json({ error: 'Чат заблокирован вами' });
  }
  if (receiver && receiver.blockedContacts && receiver.blockedContacts.includes(senderId)) {
    return res.status(403).json({ error: 'Вы заблокированы пользователем' });
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

  let updated = false;
  if (sender) {
    if (!sender.contacts) sender.contacts = [];
    if (!sender.contacts.includes(receiverId)) {
      sender.contacts.push(receiverId);
      updated = true;
    }
  }
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

  const dialogs = accounts.filter(u => peerIds.has(u.id) && u.id !== userId).map(u => ({
    id: u.id, name: u.name, avatar: u.avatar || ''
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
      --msg-selected: rgba(82, 136, 193, 0.3);
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
      --msg-selected: rgba(51, 144, 236, 0.2);
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
    
    .user-profile-bar { display: flex; align-items: center; justify-content: space-between; padding: 4px; cursor: pointer; }
    .user-info-brief { display: flex; flex-direction: column; overflow: hidden; margin-left: 10px; flex: 1; }
    
    .avatar-circle { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: var(--accent); display: flex; align-items: center; justify-content: center; color: #fff; font-weight: bold; flex-shrink: 0; font-size: 16px; overflow: hidden; }
    .avatar-circle img { width: 100%; height: 100%; object-fit: cover; }

    .theme-toggle-btn { background: var(--bg-input); border: none; color: var(--text-main); width: 34px; height: 34px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px; }

    .search-box { position: relative; }
    .search-box input { width: 100%; padding: 10px 12px; border-radius: 18px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; font-size: 14px; }
    .clear-search { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; color: var(--text-muted); display: none; }

    .chat-list { flex: 1; overflow-y: auto; }
    .chat-item { display: flex; align-items: center; gap: 12px; padding: 12px; cursor: pointer; border-bottom: 1px solid var(--border); transition: background 0.2s; }
    .chat-item:hover, .chat-item.active { background: var(--bg-active); }

    .main-chat { flex: 1; display: flex; flex-direction: column; background: var(--bg-app); position: relative; }
    .chat-header { background: var(--bg-sidebar); padding: 8px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); height: 60px; }
    .chat-header-info { display: flex; align-items: center; gap: 10px; cursor: pointer; flex: 1; overflow: hidden; }
    
    .messages-container { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px; -webkit-overflow-scrolling: touch; }
    
    .msg { max-width: 75%; padding: 10px 14px; border-radius: 12px; background: var(--bg-msg-peer); align-self: flex-start; word-break: break-word; position: relative; user-select: none; transition: background 0.2s; }
    .msg.my { background: var(--bg-msg-my); align-self: flex-end; }
    .msg.selected-msg { background: var(--msg-selected) !important; outline: 2px solid var(--accent); }
    
    .media-preview { width: 260px; height: 180px; max-width: 100%; border-radius: 8px; margin-top: 6px; object-fit: cover; display: block; background: #000; }
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

    /* Модальные окна профилей (в стиле Telegram) */
    .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 2000; display: none; align-items: center; justify-content: center; }
    .modal-overlay.active { display: flex; }
    .profile-card { background: var(--bg-sidebar); width: 90%; max-width: 380px; border-radius: 16px; padding: 25px; display: flex; flex-direction: column; align-items: center; text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,0.5); position: relative; }
    .profile-avatar-big { width: 90px; height: 90px; border-radius: 50%; object-fit: cover; background: var(--accent); margin-bottom: 15px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 32px; font-weight: bold; overflow: hidden; position: relative; }
    .profile-avatar-big img { width: 100%; height: 100%; object-fit: cover; }
    .profile-name { font-size: 20px; font-weight: bold; margin-bottom: 5px; }
    .profile-id { font-size: 13px; color: var(--accent); margin-bottom: 20px; }
    .profile-actions { width: 100%; display: flex; flex-direction: column; gap: 10px; }

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

  <!-- Экран входа / регистрации -->
  <div id="auth-screen" class="screen active">
    <div class="auth-container">
      <h2>Вход в мессенджер</h2>
      <div id="auth-error" class="error-msg"></div>
      <div class="input-group">
        <input type="text" id="auth-name" placeholder="Ваше имя..." onkeydown="if(event.key==='Enter') registerUser()">
      </div>
      <button class="btn" onclick="registerUser()">Войти</button>
    </div>
  </div>

  <!-- Главный экран -->
  <div id="app-screen" class="screen">
    <div id="app-container">
      
      <div class="sidebar">
        <div class="sidebar-header">
          <div class="user-profile-bar" onclick="openMyProfile()">
            <div class="avatar-circle" id="my-avatar-circle"></div>
            <div class="user-info-brief">
              <b id="my-display-name">Имя</b>
              <div style="font-size:11px; color:var(--accent);" id="my-display-id">ID</div>
            </div>
            <button class="theme-toggle-btn" id="theme-toggle-btn" onclick="event.stopPropagation(); toggleTheme()" title="Сменить тему">🌙</button>
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
          <div class="chat-header-info" onclick="openPeerProfile()">
            <div class="avatar-circle" id="peer-avatar-circle" style="width:36px; height:36px; font-size:14px;"></div>
            <div>
              <div id="active-peer-name" style="font-weight:bold;">Выберите чат</div>
              <div id="active-peer-status" style="font-size:11px; color:var(--text-muted);">нажмите для профиля</div>
            </div>
          </div>
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

  <!-- Модальное окно своего профиля -->
  <div class="modal-overlay" id="my-profile-modal">
    <div class="profile-card">
      <div class="profile-avatar-big" id="my-profile-avatar-view"></div>
      <div class="profile-name" id="my-profile-name-view">Имя</div>
      <div class="profile-id" id="my-profile-id-view">ID</div>
      
      <div class="input-group" style="width:100%;">
        <label style="font-size:12px; color:var(--text-muted);">Изменить имя:</label>
        <input type="text" id="edit-my-name-input" placeholder="Ваше имя...">
      </div>

      <div class="profile-actions">
        <button class="btn btn-secondary" onclick="triggerAvatarInput()">Загрузить аватарку</button>
        <input type="file" id="avatar-file-input" style="display:none;" accept="image/*" onchange="handleAvatarSelect(event)">
        <button class="btn btn-secondary" id="remove-avatar-btn" onclick="removeMyAvatar()">Удалить аватарку</button>
        <button class="btn" onclick="saveMyProfileChanges()">Сохранить</button>
        <button class="btn btn-secondary" onclick="closeMyProfile()">Закрыть</button>
      </div>
    </div>
  </div>

  <!-- Модальное окно профиля собеседника (Telegram-style) -->
  <div class="modal-overlay" id="peer-profile-modal">
    <div class="profile-card">
      <div class="profile-avatar-big" id="peer-profile-avatar-view"></div>
      <div class="profile-name" id="peer-profile-name-view">Имя</div>
      <div class="profile-id" id="peer-profile-id-view">ID</div>
      
      <div class="profile-actions">
        <button class="btn btn-secondary" id="block-peer-btn" onclick="toggleBlockPeer()">Заблокировать сообщения</button>
        <button class="btn btn-secondary" onclick="closePeerProfile()">Закрыть</button>
      </div>
    </div>
  </div>

  <!-- Лист действий с сообщением -->
  <div class="msg-actions-sheet" id="msg-actions-sheet">
    <button class="btn" id="action-btn-copy" onclick="actionCopyText()" style="display:none;">Копировать текст</button>
    <button class="btn" id="action-btn-download" onclick="actionDownloadFile()" style="display:none;">Скачать файл</button>
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
    let selectedMsgObj = null;
    let longTouchTimer = null;

    let localKnownUsers = JSON.parse(localStorage.getItem('messenger_known_users') || '{}');

    const savedTheme = localStorage.getItem('app_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);

    // Запрос разрешений на уведомления браузера
    if (window.Notification && Notification.permission !== 'granted') {
      Notification.requestPermission();
    }

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
      localStorage.setItem('app_theme', next);
      updateThemeIcon(next);
    }

    function updateThemeIcon(theme) {
      const btn = document.getElementById('theme-toggle-btn');
      if (btn) btn.innerText = theme === 'dark' ? '🌙' : '☀️';
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
      const nameInput = document.getElementById('auth-name');
      const name = nameInput.value.trim();
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
          localStorage.setItem('messenger_user', JSON.stringify(currentUser));
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

      updateMyProfileUI();
      sendPing();
      loadDialogs();
      
      setInterval(() => {
        if (currentUser && !isRecording) {
          sendPing();
          loadDialogsQuiet();
          if (activePeer) loadMessagesQuiet();
        }
      }, 2000);
    }

    function updateMyProfileUI() {
      document.getElementById('my-display-name').innerText = currentUser.name;
      document.getElementById('my-display-id').innerText = 'ID: ' + currentUser.id;
      renderAvatarIntoElement(document.getElementById('my-avatar-circle'), currentUser);
    }

    async function sendPing() {
      if (!currentUser) return;
      try {
        const knownList = Object.values(localKnownUsers);
        const res = await fetch('/api/ping', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            id: currentUser.id,
            name: currentUser.name,
            avatar: currentUser.avatar || '',
            contacts: currentUser.contacts || [],
            knownUsers: knownList
          })
        });
        const data = await res.json();
        if (data.success && data.user) {
          // Если сервер автоматически сменил ID из-за коллизии
          if (data.user.id !== currentUser.id) {
            currentUser.id = data.user.id;
            localStorage.setItem('messenger_user', JSON.stringify(currentUser));
            updateMyProfileUI();
          }
        }
      } catch(e) {}
    }

    function cacheUser(user) {
      if (!user || !user.id) return;
      localKnownUsers[user.id] = { id: user.id, name: user.name, avatar: user.avatar };
      localStorage.setItem('messenger_known_users', JSON.stringify(localKnownUsers));
    }

    function openMyProfile() {
      document.getElementById('edit-my-name-input').value = currentUser.name;
      renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), currentUser);
      document.getElementById('my-profile-name-view').innerText = currentUser.name;
      document.getElementById('my-profile-id-view').innerText = 'ID: ' + currentUser.id;
      document.getElementById('my-profile-modal').classList.add('active');
    }

    function closeMyProfile() {
      document.getElementById('my-profile-modal').classList.remove('active');
    }

    function triggerAvatarInput() {
      document.getElementById('avatar-file-input').click();
    }

    function handleAvatarSelect(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(evt) {
        currentUser.avatar = evt.target.result;
        renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), currentUser);
      };
      reader.readAsDataURL(file);
    }

    function removeMyAvatar() {
      currentUser.avatar = '';
      renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), currentUser);
    }

    async function saveMyProfileChanges() {
      const newName = document.getElementById('edit-my-name-input').value.trim();
      if (newName) currentUser.name = newName;

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
      } catch(e) {
        alert('Не удалось обновить профиль');
      }
    }

    function openPeerProfile() {
      if (!activePeer) return;
      renderAvatarIntoElement(document.getElementById('peer-profile-avatar-view'), activePeer);
      document.getElementById('peer-profile-name-view').innerText = activePeer.name;
      document.getElementById('peer-profile-id-view').innerText = 'ID: ' + activePeer.id;

      const blockBtn = document.getElementById('block-peer-btn');
      const isBlocked = currentUser.blockedContacts && currentUser.blockedContacts.includes(activePeer.id);
      blockBtn.innerText = isBlocked ? 'Разблокировать сообщения' : 'Заблокировать сообщения';
      blockBtn.className = isBlocked ? 'btn' : 'btn btn-secondary';

      document.getElementById('peer-profile-modal').classList.add('active');
    }

    function closePeerProfile() {
      document.getElementById('peer-profile-modal').classList.remove('active');
    }

    async function toggleBlockPeer() {
      if (!activePeer) return;
      const isBlocked = currentUser.blockedContacts && currentUser.blockedContacts.includes(activePeer.id);
      const nextBlock = !isBlocked;

      try {
        const res = await fetch('/api/users/block', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ userId: currentUser.id, peerId: activePeer.id, block: nextBlock })
        });
        const data = await res.json();
        if (data.success) {
          currentUser.blockedContacts = data.blockedContacts;
          localStorage.setItem('messenger_user', JSON.stringify(currentUser));
          closePeerProfile();
          alert(nextBlock ? 'Пользователь заблокирован' : 'Пользователь разблокирован');
        }
      } catch(e) {
        alert('Ошибка при изменении статуса блока');
      }
    }

    async function loadDialogs() {
      const searchVal = document.getElementById('search-input').value.trim();
      if (searchVal) return;
      try {
        const res = await fetch('/api/dialogs/' + currentUser.id);
        const dialogs = await res.json();
        dialogs.forEach(d => cacheUser(d));
        renderChatList(dialogs);
      } catch(e) {}
    }

    async function loadDialogsQuiet() {
      const searchVal = document.getElementById('search-input').value.trim();
      if (searchVal) return;
      try {
        const res = await fetch('/api/dialogs/' + currentUser.id);
        const dialogs = await res.json();
        dialogs.forEach(d => cacheUser(d));
        
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
        users.forEach(u => cacheUser(u));
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

        const avatarId = 'chat_av_' + item.id;
        div.innerHTML = \`
          <div class="avatar-circle" id="\${avatarId}"></div>
          <div>
            <div style="font-weight:bold;">\${item.name}</div>
            <div style="font-size:11px; color:var(--text-muted);">ID: \${item.id}</div>
          </div>
        \`;
        container.appendChild(div);
        renderAvatarIntoElement(document.getElementById(avatarId), item);
      });
    }

    function openChat(peer) {
      activePeer = peer;
      lastMessagesHash = '';
      document.getElementById('active-peer-name').innerText = peer.name;
      document.getElementById('active-peer-status').innerText = 'ID: ' + peer.id;
      renderAvatarIntoElement(document.getElementById('peer-avatar-circle'), peer);
      document.getElementById('input-bar').style.display = 'flex';
      
      if (!currentUser.contacts) currentUser.contacts = [];
      if (!currentUser.contacts.includes(peer.id)) {
        currentUser.contacts.push(peer.id);
        localStorage.setItem('messenger_user', JSON.stringify(currentUser));
      }

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
          // Проверка на входящие сообщения для генерации браузерного уведомления
          if (messages.length > 0) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg.senderId === activePeer.id && lastMessagesHash !== '') {
              showBrowserNotification(activePeer.name, lastMsg.text || 'Вложенный файл');
            }
          }

          lastMessagesHash = currentHash;
          renderMessagesContainer(messages);
        }
      } catch(e) {}
    }

    function showBrowserNotification(title, bodyText) {
      if (window.Notification && Notification.permission === 'granted' && document.hidden) {
        new Notification(title, { body: bodyText });
      }
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
          openMsgActions(m, div);
        };
        div.ontouchstart = () => {
          longTouchTimer = setTimeout(() => openMsgActions(m, div), 500);
        };
        div.ontouchend = () => clearTimeout(longTouchTimer);
        div.ontouchmove = () => clearTimeout(longTouchTimer);

        let html = '';
        if (m.text) html += \`<div>\${m.text}</div>\`;

        const fileType = m.fileType || '';
        if (m.fileData) {
          if (fileType.startsWith('image/')) {
            html += \`<img src="\${m.fileData}" class="media-preview">\`;
          } else if (fileType.startsWith('video/')) {
            html += \`<video src="\${m.fileData}" controls class="video-preview"></video>\`;
          } else if (fileType.startsWith('audio/')) {
            html += \`<audio src="\${m.fileData}" controls style="margin-top:5px; max-width:100%;"></audio>\`;
          } else {
            html += \`<a class="file-link" onclick="event.stopPropagation()">📁 \${m.fileName || 'Файл'}</a>\`;
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

    function openMsgActions(msg, element) {
      selectedMsgId = msg.id;
      selectedMsgObj = msg;

      document.querySelectorAll('.msg').forEach(el => el.classList.remove('selected-msg'));
      element.classList.add('selected-msg');

      const copyBtn = document.getElementById('action-btn-copy');
      const downloadBtn = document.getElementById('action-btn-download');

      if (msg.text && !msg.fileData) {
        copyBtn.style.display = 'block';
      } else {
        copyBtn.style.display = 'none';
      }

      if (msg.fileData) {
        downloadBtn.style.display = 'block';
      } else {
        downloadBtn.style.display = 'none';
      }

      document.getElementById('msg-actions-sheet').classList.add('active');
    }

    function closeMsgActions() {
      selectedMsgId = null;
      selectedMsgObj = null;
      document.querySelectorAll('.msg').forEach(el => el.classList.remove('selected-msg'));
      document.getElementById('msg-actions-sheet').classList.remove('active');
    }

    function actionCopyText() {
      if (selectedMsgObj && selectedMsgObj.text) {
        navigator.clipboard.writeText(selectedMsgObj.text).then(() => {
          closeMsgActions();
        }).catch(() => {
          alert('Не удалось скопировать');
        });
      }
    }

    function actionDownloadFile() {
      if (selectedMsgObj && selectedMsgObj.fileData) {
        const a = document.createElement('a');
        a.href = selectedMsgObj.fileData;
        a.download = selectedMsgObj.fileName || 'download';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        closeMsgActions();
      }
    }

    async function deleteSelectedMessage() {
      if (!selectedMsgId) return;
      try {
        await fetch('/api/messages/' + selectedMsgId, { method: 'DELETE' });
        closeMsgActions();
        lastMessagesHash = '';
        loadMessages();
      } catch(e) {
        alert('Не удалось удалить сообщение.');
      }
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
        const res = await fetch('/api/messages/send', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body)
        });

        if (res.status === 403 || res.status === 403.1) {
          alert('Сообщение не доставлено: чат заблокирован.');
        }

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
