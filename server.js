/* ============================================================
   server.js — v6.0.0 (Чистый P2P / WebRTC DataChannels)
   - Сервер используется только как сигнальный хаб для установления 
     прямой связи между клиентами.
   - Сообщения и файлы передаются напрямую между пользователями (P2P).
   ============================================================ */
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_VERSION = '6.0.0';

app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

process.on('uncaughtException', function (err) { console.error('[СЕРВЕР EXCEPTION]:', err); });
process.on('unhandledRejection', function (r) { console.error('[ПРОМИС REJECTION]:', r); });

const MEM = { accounts: [], groups: [] };
const ONLINE_WINDOW_MS = 45000; 

function genId(prefix) { return prefix + Date.now() + '_' + Math.random().toString(36).substr(2, 6); }
function isOnline(u) { return !!(u && u.updatedAt && (Date.now() - u.updatedAt < ONLINE_WINDOW_MS)); }

// Очистка старых неактивных аккаунтов (> 48 часов)
setInterval(function() {
  const now = Date.now();
  MEM.accounts = MEM.accounts.filter(u => (now - (u.updatedAt || 0)) < 172800000);
}, 600000);

// Сигнальная очередь для P2P и звонков
const p2pSignals = new Map();
function ensureQ(uid) { if (!p2pSignals.has(uid)) p2pSignals.set(uid, []); return p2pSignals.get(uid); }
function pushSig(t, f, c, ty, p) { ensureQ(t).push({ id: genId('sig_'), from: f, callId: c, type: ty, payload: p || null, ts: Date.now() }); }

app.get('/api/health', function (req, res) {
  res.json({ ok: true, serverTime: Date.now(), serverVersion: SERVER_VERSION });
});

/* ==================== ВХОД / ВЫХОД ==================== */
app.post('/api/enter', function (req, res) {
  const name = (req.body.name || '').trim();
  const deviceId = (req.body.deviceId || '').trim();
  const pubKey = req.body.pubKey || '';
  const userAgent = (req.body.userAgent || '').substring(0, 300);

  if (!name) return res.status(400).json({ error: 'Введите имя' });
  if (name.length > 60) return res.status(400).json({ error: 'Слишком длинное имя' });
  if (!deviceId || deviceId.length < 3) return res.status(400).json({ error: 'Ошибка ID устройства' });

  let user = MEM.accounts.find(function (u) { return u.id === deviceId; });
  if (!user) {
    user = {
      id: deviceId, name: name, avatar: '', pubKey: pubKey, userAgent: userAgent,
      contacts: [], blockedContacts: [], hiddenDialogs: [], updatedAt: Date.now()
    };
    MEM.accounts.push(user);
  } else {
    user.name = name;
    if (pubKey) user.pubKey = pubKey;
    if (userAgent) user.userAgent = userAgent;
    user.updatedAt = Date.now();
  }
  res.json({ success: true, user: user });
});

app.post('/api/enter/leave', function (req, res) {
  const userId = (req.body.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'No user' });
  const idx = MEM.accounts.findIndex(function (u) { return u.id === userId; });
  if (idx >= 0) MEM.accounts.splice(idx, 1);
  res.json({ success: true });
});

/* ==================== PING И СИНХРОНИЗАЦИЯ ==================== */
app.post('/api/ping', function (req, res) {
  const { id, name, avatar, pubKey, contacts, userAgent } = req.body;
  if (!id) return res.status(400).json({ error: 'No id' });

  let user = MEM.accounts.find(function (u) { return u.id === id; });
  if (!user) {
    user = {
      id: id, name: name || 'Пользователь', avatar: avatar || '', pubKey: pubKey || '',
      userAgent: userAgent ? String(userAgent).substring(0, 300) : '',
      contacts: Array.isArray(contacts) ? contacts : [], blockedContacts: [], hiddenDialogs: [], updatedAt: Date.now()
    };
    MEM.accounts.push(user);
  } else {
    user.updatedAt = Date.now();
    if (name) user.name = name;
    if (avatar !== undefined) user.avatar = avatar;
    if (pubKey) user.pubKey = pubKey;
    if (userAgent) user.userAgent = String(userAgent).substring(0, 300);
  }
  res.json({ success: true, user: user });
});

app.post('/api/profile/update', function (req, res) {
  const { id, name, avatar, pubKey } = req.body;
  const user = MEM.accounts.find(function (u) { return u.id === id; });
  if (!user) return res.status(404).json({ error: 'Не найден' });
  if (name && name.trim()) user.name = name.trim();
  if (avatar !== undefined) user.avatar = avatar;
  if (pubKey) user.pubKey = pubKey;
  user.updatedAt = Date.now();
  res.json({ success: true, user: user });
});

app.get('/api/users/:userId', function (req, res) {
  const user = MEM.accounts.find(function (u) { return u.id === req.params.userId; });
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json({
    id: user.id, name: user.name, avatar: user.avatar || '', pubKey: user.pubKey || '',
    userAgent: user.userAgent || '',
    isOnline: isOnline(user), updatedAt: user.updatedAt
  });
});

/* ==================== ПОИСК / ОНЛАЙН ==================== */
app.get('/api/users/search', function (req, res) {
  const q = (req.query.q || '').toLowerCase().trim();
  const excludeId = req.query.excludeId || '';
  const now = Date.now();
  const results = MEM.accounts
    .filter(function (u) { return u.id && u.id !== excludeId; })
    .filter(function (u) {
      if (!q) return true;
      return (u.id && u.id.toLowerCase().indexOf(q) !== -1) || (u.name && u.name.toLowerCase().indexOf(q) !== -1);
    })
    .map(function (u) {
      return {
        id: u.id, type: 'user', name: u.name || 'Пользователь', avatar: u.avatar || '', pubKey: u.pubKey || '',
        userAgent: u.userAgent || '',
        isOnline: !!(u.updatedAt && (now - u.updatedAt < ONLINE_WINDOW_MS))
      };
    })
    .sort(function (a, b) {
      const ao = a.isOnline ? 1 : 0, bo = b.isOnline ? 1 : 0;
      if (ao !== bo) return bo - ao;
      return a.name.localeCompare(b.name);
    });
  res.json(results);
});

app.get('/api/users/online', function (req, res) {
  const userId = req.query.userId || '';
  const now = Date.now();
  const list = MEM.accounts
    .filter(function (u) { return u.id !== userId && u.name; })
    .map(function (u) {
      return {
        id: u.id, type: 'user', name: u.name, avatar: u.avatar || '', pubKey: u.pubKey || '',
        userAgent: u.userAgent || '',
        isOnline: !!(u.updatedAt && (now - u.updatedAt < ONLINE_WINDOW_MS))
      };
    })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
  res.json(list);
});

app.get('/api/dialogs/:userId', function (req, res) {
  const userId = req.params.userId;
  const now = Date.now();
  const list = MEM.accounts
    .filter(function (u) { return u.id !== userId && u.name && u.updatedAt && (now - u.updatedAt < ONLINE_WINDOW_MS); })
    .map(function (u) { return { id: u.id, type: 'user', name: u.name, avatar: u.avatar || '', pubKey: u.pubKey || '', userAgent: u.userAgent || '', isOnline: true }; });
  res.json(list);
});

/* ==================== P2P СИГНАЛИНГ (ДЛЯ CHAT & CALLS) ==================== */
app.post('/api/p2p/signal', function (req, res) {
  const { fromId, toId, type, payload } = req.body;
  if (!fromId || !toId || !type) return res.status(400).json({ error: 'Bad data' });
  pushSig(toId, fromId, 'p2p_chat', type, payload);
  res.json({ success: true });
});

app.get('/api/p2p/poll', function (req, res) {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'No user' });
  const q = ensureQ(userId);
  const now = Date.now();
  const fresh = q.filter(function (s) { return now - s.ts < 120000; });
  p2pSignals.set(userId, []);
  res.json({ success: true, signals: fresh });
});

/* ==================== HTML ==================== */
const CLIENT_HTML = `<!DOCTYPE html>
<html lang="ru" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>P2P Мессенджер</title>
<style>
  :root[data-theme="dark"] { --bg-app:#0e1621; --bg-sidebar:#17212b; --bg-input:#242f3d; --bg-hover:#202b36; --bg-active:#2b5278; --bg-msg-peer:#182533; --bg-msg-my:#2b5278; --text-main:#fff; --text-muted:#7f91a4; --accent:#5288c1; --border:#0e1621; --msg-selected:rgba(82,136,193,.3); }
  :root[data-theme="light"] { --bg-app:#e6ebee; --bg-sidebar:#fff; --bg-input:#f1f3f5; --bg-hover:#f5f5f5; --bg-active:#e3edf7; --bg-msg-peer:#fff; --bg-msg-my:#eeffde; --text-main:#000; --text-muted:#707579; --accent:#3390ec; --border:#e6ebee; --msg-selected:rgba(51,144,236,.2); }
  *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-tap-highlight-color:transparent;}
  html,body{height:100dvh;width:100vw;background:var(--bg-app);color:var(--text-main);overflow:hidden;position:fixed;}
  .screen{display:none;height:100dvh;width:100vw;position:absolute;top:0;left:0;}
  .screen.active{display:flex;}
  .auth-container{margin:auto;width:90%;max-width:360px;background:var(--bg-sidebar);padding:25px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.3);text-align:center;}
  .auth-container h2{margin-bottom:15px;color:var(--accent);}
  .auth-container p{font-size:13px;color:var(--text-muted);margin-bottom:15px;}
  .input-group{margin-bottom:12px;text-align:left;}
  .input-group input{width:100%;padding:12px;border-radius:8px;border:1px solid var(--bg-input);background:var(--bg-input);color:var(--text-main);outline:none;}
  .btn{width:100%;padding:12px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-weight:bold;cursor:pointer;margin-top:10px;}
  .btn:disabled{opacity:.5;cursor:wait;}
  .btn-secondary{background:transparent;color:var(--accent);border:1px solid var(--accent);}
  .btn-danger{background:#e53935;color:#fff;}
  .error-msg{color:#e53935;font-size:12px;margin-bottom:10px;display:none;}
  #status-bar{position:fixed;top:0;left:0;right:0;padding:8px;text-align:center;font-size:13px;font-weight:600;z-index:9999;transition:transform .3s;transform:translateY(-100%);}
  #status-bar.visible{transform:translateY(0);}
  #status-bar.internet-off{background:#e53935;color:#fff;}
  #status-bar.server-off{background:#f9a825;color:#000;}
  #status-bar.reconnected{background:#4cd964;color:#fff;}
  #loading-screen{display:none;position:fixed;inset:0;background:var(--bg-app);z-index:10000;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:20px;text-align:center;}
  #loading-screen.active{display:flex;}
  .spinner{width:50px;height:50px;border:4px solid var(--bg-input);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;}
  @keyframes spin{to{transform:rotate(360deg);}}
  .loading-text{color:var(--text-muted);font-size:15px;}
  .loading-title{font-size:20px;font-weight:bold;}
  .version-info{position:fixed;bottom:8px;right:10px;font-size:10px;color:var(--text-muted);z-index:9998;opacity:.6;pointer-events:none;}
  #app-container{display:flex;width:100%;height:100%;}
  .sidebar{width:320px;background:var(--bg-sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0;}
  .sidebar-header{padding:12px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:10px;}
  .user-profile-bar{display:flex;align-items:center;justify-content:space-between;padding:4px;cursor:pointer;}
  .user-info-brief{display:flex;flex-direction:column;overflow:hidden;margin-left:10px;flex:1;}
  .avatar-circle{width:40px;height:40px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold;flex-shrink:0;font-size:16px;position:relative;overflow:visible;}
  .avatar-circle img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;object-position:center;border-radius:50%;display:block;z-index:1;}
  .avatar-circle > span{position:relative;z-index:1;}
  .avatar-circle .online-indicator{position:absolute;bottom:-2px;right:-2px;width:12px;height:12px;background:#4cd964;border:2px solid var(--bg-sidebar);border-radius:50%;display:none;z-index:10;box-sizing:content-box;}
  .avatar-circle .online-indicator.visible{display:block;}
  .avatar-circle .online-indicator.offline{background:#7f91a4;display:block;}
  .profile-avatar-big{width:90px;height:90px;border-radius:50%;background:var(--accent);margin-bottom:15px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:32px;font-weight:bold;position:relative;overflow:hidden;flex-shrink:0;}
  .profile-avatar-big img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;object-position:center;border-radius:50%;display:block;}
  .profile-avatar-big > span{position:relative;z-index:1;}
  .profile-avatar-big .online-indicator{position:absolute;bottom:0;right:0;width:16px;height:16px;background:#4cd964;border:2px solid var(--bg-sidebar);border-radius:50%;z-index:5;box-sizing:content-box;display:none;}
  .profile-avatar-big .online-indicator.visible{display:block;}
  .profile-avatar-big .online-indicator.offline{background:#7f91a4;display:block;}
  .header-actions{display:flex;gap:6px;}
  .theme-toggle-btn{background:var(--bg-input);border:none;color:var(--text-main);width:34px;height:34px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;}
  .search-box{position:relative;}
  .search-box input{width:100%;padding:10px 12px;border-radius:18px;border:none;background:var(--bg-input);color:var(--text-main);outline:none;font-size:14px;}
  .clear-search{position:absolute;right:10px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--text-muted);display:none;}
  .list-label{padding:6px 12px;font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;background:var(--bg-sidebar);}
  .chat-list{flex:1;overflow-y:auto;}
  .chat-item{display:flex;align-items:center;gap:12px;padding:12px;cursor:pointer;border-bottom:1px solid var(--border);}
  .chat-item:hover,.chat-item.active{background:var(--bg-active);}
  .main-chat{flex:1;display:flex;flex-direction:column;background:var(--bg-app);position:relative;min-width:0;}
  .chat-header{background:var(--bg-sidebar);padding:8px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);height:60px;}
  .chat-header-info{display:flex;align-items:center;gap:10px;cursor:pointer;flex:1;overflow:hidden;}
  .chat-menu-container{position:relative;display:flex;gap:4px;align-items:center;}
  .menu-dots-btn{background:transparent;border:none;color:var(--text-main);font-size:20px;cursor:pointer;padding:8px;border-radius:50%;display:none;}
  .call-btn{background:transparent;border:none;color:var(--text-main);font-size:22px;cursor:pointer;padding:8px;border-radius:50%;}
  .chat-dropdown-menu{position:absolute;right:0;top:45px;background:var(--bg-sidebar);border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.3);width:220px;display:none;flex-direction:column;z-index:1000;overflow:hidden;}
  .chat-dropdown-menu.active{display:flex;}
  .menu-item{padding:12px 16px;font-size:14px;cursor:pointer;border-bottom:1px solid var(--border);text-align:left;background:none;border-top:none;border-left:none;border-right:none;color:var(--text-main);width:100%;}
  .menu-item:hover{background:var(--bg-active);}
  .menu-item.danger{color:#e53935;}
  .messages-container{flex:1;overflow-y:auto;padding:15px;display:flex;flex-direction:column;gap:10px;}
  .msg{max-width:75%;padding:10px 14px;border-radius:12px;background:var(--bg-msg-peer);align-self:flex-start;word-break:break-word;user-select:none;}
  .msg.my{background:var(--bg-msg-my);align-self:flex-end;}
  .msg.pending{opacity:.6;}
  .msg.waiting{opacity:.7;border:1px dashed var(--accent);}
  .msg.selected-msg{background:var(--msg-selected)!important;outline:2px solid var(--accent);}
  .msg-sender{font-size:12px;font-weight:bold;color:var(--accent);margin-bottom:2px;}
  .media-preview{width:280px;height:180px;max-width:100%;border-radius:8px;margin-top:6px;object-fit:cover;display:block;background:#000;cursor:pointer;}
  .file-link{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-input);border-radius:6px;color:var(--accent);text-decoration:none;margin-top:5px;font-size:13px;}
  .file-placeholder{padding:8px 12px;background:var(--bg-input);border-radius:6px;margin-top:5px;font-size:12px;color:var(--text-muted);}
  .audio-preview{width:240px!important;max-width:240px!important;height:40px;margin-top:5px;display:block;}
  .media-loading{padding:8px 12px;background:var(--bg-input);border-radius:6px;margin-top:5px;font-size:12px;color:var(--text-muted);}
  .msg-footer{display:flex;align-items:center;justify-content:flex-end;gap:4px;font-size:9px;color:var(--text-muted);margin-top:3px;}
  .ticks{font-size:11px;letter-spacing:-3px;font-weight:bold;}
  .ticks.read{color:var(--accent);}
  .attachment-preview-container{background:var(--bg-sidebar);padding:10px 15px;border-top:1px solid var(--border);display:none;align-items:center;gap:12px;}
  .attachment-preview-container.active{display:flex;}
  .attachment-thumb{width:45px;height:45px;border-radius:6px;object-fit:cover;background:#000;}
  .attachment-info{flex:1;display:flex;flex-direction:column;overflow:hidden;}
  .attachment-name{font-size:13px;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .attachment-cancel{cursor:pointer;color:#e53935;font-size:18px;padding:5px;}
  #audio-attachment-preview{display:none;}
  #audio-attachment-preview.active{display:flex;}
  #audio-attachment-preview audio{height:36px;}
  .record-panel{display:none;background:var(--bg-sidebar);border-top:1px solid var(--border);padding:6px 12px;align-items:center;justify-content:center;gap:10px;flex-shrink:0;height:40px;}
  .record-panel.active{display:flex;}
  .recording-indicator{display:none;align-items:center;gap:6px;font-size:13px;color:#e53935;}
  .recording-indicator.active{display:inline-flex;}
  .recording-dot{width:10px;height:10px;border-radius:50%;background:#e53935;animation:recpulse 1s infinite;}
  @keyframes recpulse{0%,100%{opacity:1;}50%{opacity:.3;}}
  #recording-timer{font-family:monospace;font-weight:bold;color:#e53935;font-size:14px;}
  .recording-hint{display:none;color:#e53935;font-size:12px;font-weight:600;margin-left:8px;}
  .recording-hint.active{display:inline-block;}
  .input-bar{background:var(--bg-sidebar);padding:10px;display:flex;gap:10px;align-items:center;flex-shrink:0;border-top:1px solid var(--border);transition:opacity .15s;}
  .input-bar input[type="text"]{flex:1;padding:12px;border-radius:20px;border:none;background:var(--bg-input);color:var(--text-main);outline:none;min-width:0;}
  .icon-btn{cursor:pointer;font-size:22px;border:none;background:transparent;color:var(--text-main);padding:4px;flex-shrink:0;}
  .icon-btn.recording{color:#e53935;}
  .empty-state{margin:auto;text-align:center;color:var(--text-muted);font-size:14px;}
  .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2000;display:flex;align-items:center;justify-content:center;visibility:hidden;opacity:0;transition:.15s;pointer-events:none;}
  .modal-overlay.active{visibility:visible;opacity:1;pointer-events:auto;}
  .profile-card{background:var(--bg-sidebar);width:90%;max-width:380px;border-radius:16px;padding:25px;display:flex;flex-direction:column;align-items:center;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.5);max-height:90dvh;overflow-y:auto;}
  .profile-name{font-size:20px;font-weight:bold;margin-bottom:5px;}
  .profile-id{font-size:13px;color:var(--accent);margin-bottom:15px;text-align:center;line-height:1.4;}
  .profile-actions{width:100%;display:flex;flex-direction:column;gap:10px;}
  .profile-link-btn{background:none;border:none;color:var(--accent);font-size:14px;cursor:pointer;padding:5px;text-align:center;}
  #image-viewer-modal{position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:3000;display:flex;align-items:center;justify-content:center;visibility:hidden;opacity:0;transition:.15s;pointer-events:none;}
  #image-viewer-modal.active{visibility:visible;opacity:1;pointer-events:auto;}
  #image-viewer-modal img{max-width:95vw;max-height:95vh;border-radius:8px;}
  .viewer-close{position:absolute;top:20px;right:20px;color:#fff;font-size:30px;cursor:pointer;background:none;border:none;z-index:3100;}
  .msg-actions-sheet{position:fixed;bottom:0;left:0;right:0;background:var(--bg-sidebar);border-top-left-radius:16px;border-top-right-radius:16px;padding:20px;z-index:1001;display:flex;flex-direction:column;gap:10px;visibility:hidden;opacity:0;transform:translateY(20px);transition:.15s;pointer-events:none;}
  .msg-actions-sheet.active{visibility:visible;opacity:1;transform:translateY(0);pointer-events:auto;}
  @media (min-width:601px){.menu-dots-btn{display:flex!important;}}
  @media (max-width:600px){.sidebar{width:100%;display:flex;}.main-chat{display:none;width:100%;}.app-mobile-chat .sidebar{display:none;}.app-mobile-chat .main-chat{display:flex;}.app-mobile-chat .menu-dots-btn{display:flex!important;}}
</style>
</head>
<body>
  <div id="status-bar"></div>
  <div class="version-info" id="version-info"></div>
  <div id="loading-screen">
    <div class="loading-title" id="loading-title">Соединение...</div>
    <div class="spinner"></div>
    <div class="loading-text" id="loading-text">Подключаемся к серверу</div>
  </div>

  <div id="auth-screen" class="screen active">
    <div class="auth-container">
      <h2>P2P Мессенджер</h2>
      <p>Введите ваше имя, чтобы войти</p>
      <div id="auth-error" class="error-msg"></div>
      <div class="input-group">
        <input type="text" id="auth-name" placeholder="Ваше имя..." maxlength="60" onkeydown="if(event.key==='Enter') enterByName()">
      </div>
      <button class="btn" id="enter-btn" onclick="enterByName()">Войти</button>
    </div>
  </div>

  <div id="app-screen" class="screen">
    <div id="app-container">
      <div class="sidebar">
        <div class="sidebar-header">
          <div class="user-profile-bar">
            <div class="avatar-circle" id="my-avatar-circle" onclick="openMyProfile()"><div class="online-indicator visible"></div></div>
            <div class="user-info-brief" onclick="openMyProfile()">
              <b id="my-display-name">Имя</b>
              <div style="font-size:11px;color:var(--text-muted);" id="my-display-device">Устройство</div>
            </div>
            <div class="header-actions">
              <button class="theme-toggle-btn" id="theme-toggle-btn" onclick="toggleTheme()">🌙</button>
            </div>
          </div>
          <div class="search-box">
            <input type="text" id="search-input" placeholder="Поиск по имени или ID..." oninput="onSearchInput()">
            <span class="clear-search" id="clear-search-btn" onclick="clearSearch()">✕</span>
          </div>
        </div>
        <div class="chat-list" id="chat-list"></div>
      </div>
      <div class="main-chat" id="main-chat">
        <div class="chat-header">
          <button class="btn btn-secondary" style="width:auto;padding:6px 12px;font-size:12px;display:none;" id="back-to-list-btn" onclick="closeMobileChat()">← Назад</button>
          <div class="chat-header-info" onclick="openPeerProfile()">
            <div class="avatar-circle" id="peer-avatar-circle" style="width:36px;height:36px;font-size:14px;"><div class="online-indicator"></div></div>
            <div>
              <div id="active-peer-name" style="font-weight:bold;">Выберите чат</div>
              <div id="active-peer-status" style="font-size:11px;color:var(--text-muted);">нажмите для профиля</div>
            </div>
          </div>
          <div class="chat-menu-container">
            <button class="menu-dots-btn" id="chat-menu-dots-btn" onclick="toggleChatDropdown()">⋮</button>
            <div class="chat-dropdown-menu" id="chat-dropdown-menu"></div>
          </div>
        </div>
        <div class="messages-container" id="messages-container"><div class="empty-state">Выберите диалог слева</div></div>
        <div class="attachment-preview-container" id="attachment-preview-container">
          <img id="attachment-thumb-img" class="attachment-thumb" src="" style="display:none;">
          <div class="attachment-info"><div class="attachment-name" id="attachment-name-label">файл</div><div style="font-size:11px;color:var(--text-muted);" id="attachment-type-label">Готово</div></div>
          <span class="attachment-cancel" onclick="cancelAttachment()">✕</span>
        </div>
        <div class="attachment-preview-container" id="audio-attachment-preview">
          <div class="attachment-info" style="flex:1;"><div class="attachment-name">🎤 Голосовое</div><audio id="audio-preview-player" controls style="width:100%;margin-top:6px;"></audio></div>
          <span class="attachment-cancel" onclick="cancelVoiceAttachment()">✕</span>
        </div>
        <div class="record-panel" id="record-panel">
          <div class="recording-indicator active">
            <span class="recording-dot"></span><span>Запись</span>
            <span id="recording-timer">0:00</span>
            <span class="recording-hint" id="recording-hint">— нажмите 🔴 чтобы остановить</span>
          </div>
        </div>
        <div class="input-bar" id="input-bar" style="display:none;">
          <button class="icon-btn" onclick="triggerFileInput()">📎</button>
          <input type="file" id="file-input" style="display:none;" onchange="handleFileSelect(event)">
          <button class="icon-btn" id="mic-btn" onclick="toggleVoiceRecord()">🎙️</button>
          <input type="text" id="msg-input" placeholder="Сообщение..." onkeydown="if(event.key==='Enter') sendMsg()">
          <button class="btn" id="send-btn" style="width:auto;padding:10px 18px;border-radius:20px;" onclick="sendMsg()">➤</button>
        </div>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="my-profile-modal">
    <div class="profile-card">
      <div class="profile-avatar-big" id="my-profile-avatar-view"><div class="online-indicator visible"></div></div>
      <div class="profile-name" id="my-profile-name-view">Имя</div>
      <div class="profile-id" id="my-profile-id-view">Устройство</div>
      <div class="input-group" style="width:100%;"><input type="text" id="edit-my-name-input" placeholder="Ваше имя..."></div>
      <div class="profile-actions" style="align-items:center;">
        <button class="profile-link-btn" onclick="triggerAvatarInput()">Загрузить фото</button>
        <input type="file" id="avatar-file-input" style="display:none;" accept="image/*" onchange="handleAvatarSelect(event)">
        <button class="profile-link-btn" id="remove-avatar-link-btn" style="color:#e53935;display:none;" onclick="removeMyAvatar()">Удалить фото</button>
        <button class="btn" id="save-my-profile-btn" onclick="saveMyProfileChanges()">Сохранить</button>
        <button class="btn btn-secondary" onclick="restartSession()">Перезапустить</button>
        <button class="btn btn-danger" onclick="deleteSession()" style="background:#8b0000;">Удалить сессию</button>
        <button class="btn btn-danger" onclick="logoutUser()">Выйти</button>
        <button class="btn btn-secondary" onclick="closeMyProfile()">Закрыть</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="peer-profile-modal">
    <div class="profile-card">
      <div class="profile-avatar-big" id="peer-profile-avatar-view"><div class="online-indicator"></div></div>
      <div class="profile-name" id="peer-profile-name-view">Имя</div>
      <div class="profile-id" id="peer-profile-id-view">Устройство</div>
      <div class="profile-actions">
        <button class="btn btn-secondary" id="mute-peer-btn" onclick="toggleMutePeer()">Выключить звук</button>
        <button class="btn btn-secondary" onclick="closePeerProfile()">Закрыть</button>
      </div>
    </div>
  </div>

  <div id="image-viewer-modal" onclick="closeImageViewer()">
    <button class="viewer-close">✕</button>
    <img id="full-screen-img" src="">
  </div>

  <div class="msg-actions-sheet" id="msg-actions-sheet">
    <button class="btn" id="action-btn-copy" onclick="actionCopyText()" style="display:none;">Копировать</button>
    <button class="btn" id="action-btn-download" onclick="actionDownloadFile()" style="display:none;">Скачать</button>
    <button class="btn btn-danger" onclick="deleteSelectedMessage()">Удалить</button>
    <button class="btn btn-secondary" onclick="closeMsgActions()">Отмена</button>
  </div>

  <script src="/client.js"></script>
</body>
</html>`;

/* ==================== CLIENT JS (P2P WEBRTC DATACACHANNEL) ==================== */
const CLIENT_JS = `
var CLIENT_VERSION = '6.0.0';
var currentUser = null;
var activePeer = null;
var selectedFile = null;
var pendingVoice = null;
var audioChunks = [];
var isRecording = false;
var activeStream = null;
var recordStartedAt = 0;
var recordingTimerInterval = null;
var recordAudioCtx = null, recordSourceNode = null, recordProcessor = null, recordSilentGain = null;
var lastMessagesHash = '';
var selectedMsgId = null;
var selectedMsgObj = null;
var longTouchTimer = null;
var localKnownUsers = {};
var mutedPeers = [];
var localMessagesCache = [];
var savedTheme = localStorage.getItem('app_theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);
var busyButtons = {};
var dialogsPollingTimer = null;
var profileTargetId = null;
var connectionState = 'checking';
var statusBarTimeout = null;
var MAX_FILE_SIZE = 100 * 1024 * 1024;
var serverVersion = 'unknown';
var pingFailCount = 0;
var healthFailCount = 0;
var filesDB = null;
var fileUrlCache = new Map();
var deletedIds = {};
var searchRequestSeq = 0;
var unreadTitleCounter = 0;
var originalTitle = document.title;

// P2P WebRTC Connections map: peerId -> { pc, dc, status: 'disconnected'|'connecting'|'connected', pendingQueue: [] }
var p2pConnections = {};

function getOrCreateDeviceId() {
  var existing = localStorage.getItem('messenger_device_id');
  if (existing && existing.length >= 6) return existing;
  var newId = 'usr_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
  localStorage.setItem('messenger_device_id', newId);
  return newId;
}
function getDeviceInfoString() {
  var ua = navigator.userAgent || '';
  var browser = 'Браузер';
  if (/Edg\\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\\//i.test(ua)) browser = 'Safari';
  return 'P2P Node · ' + browser;
}

/* ==================== INDEXED DB (ДЛЯ ФАЙЛОВ) ==================== */
function openFilesDB() {
  return new Promise(function (resolve, reject) {
    if (filesDB) return resolve(filesDB);
    if (!window.indexedDB) return reject(new Error('No IndexedDB'));
    var req = indexedDB.open('messenger_files_p2p_v1', 1);
    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'key' });
    };
    req.onsuccess = function (e) { filesDB = e.target.result; resolve(filesDB); };
    req.onerror = function (e) { reject(e.target.error); };
  });
}
async function saveFileToIDB(key, blob, meta) {
  try {
    var db = await openFilesDB();
    return new Promise(function (res, rej) {
      var tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put({ key: key, blob: blob, fileName: (meta && meta.fileName) || '', fileType: (meta && meta.fileType) || '', fileSize: blob.size, savedAt: Date.now() });
      tx.oncomplete = function () { res(true); };
      tx.onerror = function (e) { rej(e.target.error); };
    });
  } catch (e) { return false; }
}
async function getFileFromIDB(key) {
  try {
    var db = await openFilesDB();
    return new Promise(function (res, rej) {
      var tx = db.transaction('files', 'readonly');
      var r = tx.objectStore('files').get(key);
      r.onsuccess = function () { res(r.result || null); };
      r.onerror = function (e) { rej(e.target.error); };
    });
  } catch (e) { return null; }
}
async function deleteFileFromIDB(key) {
  try {
    var db = await openFilesDB();
    return new Promise(function (res) {
      var tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').delete(key);
      tx.oncomplete = function () { res(true); };
      tx.onerror = function () { res(false); };
    });
  } catch (e) { return false; }
}
function blobToBase64(blob) {
  return new Promise(function (res, rej) {
    var r = new FileReader();
    r.onload = function () { var s = r.result; var idx = s.indexOf(','); res(idx >= 0 ? s.substring(idx + 1) : s); };
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
function blobFromDataUrl(dataUrl) {
  try { var res = fetch(dataUrl); return res.then(function(r){ return r.blob(); }); } catch (e) { return Promise.resolve(null); }
}
async function getFileUrl(msg) {
  if (!msg) return null;
  if (deletedIds[msg.id]) return null;
  if (fileUrlCache.has(msg.id)) return fileUrlCache.get(msg.id);
  var entry = await getFileFromIDB(msg.id);
  var encBlob = entry ? entry.blob : null;
  if (!encBlob && msg.fileData) {
    encBlob = await blobFromDataUrl(msg.fileData);
    if (encBlob) await saveFileToIDB(msg.id, encBlob, { fileName: msg.fileName, fileType: msg.fileType });
  }
  if (!encBlob) return null;
  var url = URL.createObjectURL(encBlob);
  fileUrlCache.set(msg.id, url);
  return url;
}

/* ==================== P2P WEBRTC МЕНЕДЖЕР ==================== */
function getOrCreateP2PConnection(peerId, isInitiator) {
  if (p2pConnections[peerId] && p2pConnections[peerId].pc) {
    return p2pConnections[peerId];
  }

  var pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  });

  var connObj = { pc: pc, dc: null, status: 'connecting', pendingQueue: [] };
  p2pConnections[peerId] = connObj;

  pc.onicecandidate = function(event) {
    if (event.candidate) {
      sendP2PSignaling(peerId, 'ice', { candidate: event.candidate });
    }
  };

  if (isInitiator) {
    var dc = pc.createDataChannel('p2p_chat', { ordered: true });
    setupDataChannel(peerId, dc);
    connObj.dc = dc;

    pc.createOffer().then(function(offer) {
      return pc.setLocalDescription(offer);
    }).then(function() {
      sendP2PSignaling(peerId, 'offer', { sdp: pc.localDescription });
    }).catch(function(e) { console.error('P2P Offer error', e); });
  } else {
    pc.ondatachannel = function(event) {
      var dc = event.channel;
      connObj.dc = dc;
      setupDataChannel(peerId, dc);
    };
  }

  return connObj;
}

function setupDataChannel(peerId, dc) {
  dc.onopen = function() {
    var conn = p2pConnections[peerId];
    if (conn) {
      conn.status = 'connected';
      // Отправляем все накопленные сообщения
      while(conn.pendingQueue.length > 0) {
        var msg = conn.pendingQueue.shift();
        dc.send(JSON.stringify(msg));
      }
    }
    updatePeerStatusUI(peerId, true);
  };

  dc.onclose = function() {
    var conn = p2pConnections[peerId];
    if (conn) conn.status = 'disconnected';
    updatePeerStatusUI(peerId, false);
  };

  dc.onmessage = function(event) {
    try {
      var data = JSON.parse(event.data);
      handleIncomingP2PMessage(data);
    } catch(e) {}
  };
}

async function sendP2PSignaling(toId, type, payload) {
  try {
    await fetch('/api/p2p/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromId: currentUser.id, toId: toId, type: type, payload: payload })
    });
  } catch(e) {}
}

async function handleP2PSignal(sig) {
  var peerId = sig.from;
  var conn = p2pConnections[peerId];
  if (!conn) {
    conn = getOrCreateP2PConnection(peerId, false);
  }
  var pc = conn.pc;

  try {
    if (sig.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(sig.payload.sdp));
      var answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendP2PSignaling(peerId, 'answer', { sdp: pc.localDescription });
    } else if (sig.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(sig.payload.sdp));
    } else if (sig.type === 'ice') {
      if (sig.payload.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(sig.payload.candidate));
      }
    }
  } catch(e) {}
}

function sendDataMessage(peerId, msgObj) {
  var conn = getOrCreateP2PConnection(peerId, true);
  var dataStr = JSON.stringify(msgObj);
  if (conn.dc && conn.dc.readyState === 'open') {
    conn.dc.send(dataStr);
  } else {
    conn.pendingQueue.push(msgObj);
  }
}

function updatePeerStatusUI(peerId, isOnline) {
  if (activePeer && activePeer.id === peerId) {
    var statusEl = document.getElementById('active-peer-status');
    if (statusEl) {
      statusEl.innerText = isOnline ? 'в сети (P2P)' : 'не в сети';
      statusEl.style.color = isOnline ? '#4cd964' : 'var(--text-muted)';
    }
  }
}

/* ==================== УТИЛИТЫ И UI ==================== */
function lockButton(id, ms) {
  if (ms === undefined) ms = 1500;
  var el = document.getElementById(id);
  if (!el) return false;
  if (busyButtons[id]) return false;
  busyButtons[id] = true;
  el.disabled = true; el.style.opacity = '0.5'; el.style.pointerEvents = 'none';
  setTimeout(function () { busyButtons[id] = false; el.disabled = false; el.style.opacity = ''; el.style.pointerEvents = ''; }, ms);
  return true;
}
function isModalOpen(id) { var el = document.getElementById(id); return !!(el && el.classList.contains('active')); }
function safeOpenModal(id) { if (isModalOpen(id)) return false; document.getElementById(id).classList.add('active'); return true; }
function safeCloseModal(id) { var el = document.getElementById(id); if (el) el.classList.remove('active'); }

function setConnectionState(state) {
  if (connectionState === state) return;
  connectionState = state;
  updateStatusBar();
  updateLoadingScreen();
}
function updateStatusBar() {
  var bar = document.getElementById('status-bar');
  if (!bar) return;
  if (statusBarTimeout) { clearTimeout(statusBarTimeout); statusBarTimeout = null; }
  bar.className = '';
  if (connectionState === 'online') {
    if (bar.dataset.wasOffline === '1') {
      bar.innerText = '✓ P2P Подключено';
      bar.className = 'visible reconnected';
      statusBarTimeout = setTimeout(function () { bar.classList.remove('visible'); bar.dataset.wasOffline = '0'; }, 2000);
    }
  } else if (connectionState === 'no-internet') {
    bar.innerText = '⚠ Нет подключения';
    bar.className = 'visible internet-off';
    bar.dataset.wasOffline = '1';
  } else if (connectionState === 'server-offline') {
    bar.innerText = '⌛ Переподключение сигнального сервера...';
    bar.className = 'visible server-off';
    bar.dataset.wasOffline = '1';
  }
}
function updateLoadingScreen() {
  var ls = document.getElementById('loading-screen');
  var title = document.getElementById('loading-title');
  var text = document.getElementById('loading-text');
  if (!ls) return;
  if (currentUser) { ls.classList.remove('active'); return; }
  if (connectionState === 'online') { ls.classList.remove('active'); }
  else { ls.classList.add('active'); title.innerText = 'P2P Сигналинг'; text.innerText = 'Подключаемся к узлу'; }
}
async function checkServerHealth() {
  if (!navigator.onLine) { setConnectionState('no-internet'); return false; }
  try {
    var ctrl = new AbortController();
    var tm = setTimeout(function () { ctrl.abort(); }, 8000);
    var res = await fetch('/api/health?_=' + Date.now(), { signal: ctrl.signal });
    clearTimeout(tm);
    if (res.ok) {
      var data = await res.json();
      serverVersion = data.serverVersion || 'unknown';
      updateVersionInfo();
      healthFailCount = 0;
      setConnectionState('online');
      return true;
    }
    healthFailCount++;
    if (healthFailCount >= 2) setConnectionState('server-offline');
    return false;
  } catch (e) {
    healthFailCount++;
    if (!navigator.onLine) setConnectionState('no-internet');
    else if (healthFailCount >= 2) setConnectionState('server-offline');
    return false;
  }
}
function updateVersionInfo() {
  var el = document.getElementById('version-info');
  if (el) el.innerText = 'P2P client v' + CLIENT_VERSION;
}
window.addEventListener('online', async function () { healthFailCount = 0; pingFailCount = 0; checkServerHealth(); });
window.addEventListener('offline', function () { setConnectionState('no-internet'); });

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return (bytes || 0) + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
}
function saveCache() {
  try { localStorage.setItem('messenger_p2p_cache', JSON.stringify(localMessagesCache)); } catch (e) {}
}
function mergeMessage(msg) {
  if (!msg || !msg.id) return;
  if (deletedIds[msg.id]) return;
  for (var i = 0; i < localMessagesCache.length; i++) {
    if (localMessagesCache[i].id === msg.id || (msg.clientId && localMessagesCache[i].clientId === msg.clientId)) {
      localMessagesCache[i] = Object.assign({}, localMessagesCache[i], msg);
      saveCache();
      return;
    }
  }
  localMessagesCache.push(msg);
  saveCache();
}
function playNotificationSound() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = ctx.createOscillator(); var g = ctx.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(587, ctx.currentTime);
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.2);
  } catch (e) {}
}
function updatePageTitle() {
  if (unreadTitleCounter > 0) document.title = '(' + unreadTitleCounter + ') ' + originalTitle;
  else document.title = originalTitle;
}
function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme');
  var next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('app_theme', next);
  document.getElementById('theme-toggle-btn').innerText = next === 'dark' ? '🌙' : '☀️';
}
function compressImage(file, maxSize, quality, callback) {
  if (!file || file.type.indexOf('image/') !== 0) { callback(null); return; }
  var reader = new FileReader();
  reader.onload = function (e) {
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement('canvas');
      var w = img.width, h = img.height;
      var ratio = Math.min(maxSize / w, maxSize / h, 1);
      w = Math.round(w * ratio); h = Math.round(h * ratio);
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
      callback(canvas.toDataURL('image/jpeg', quality || 0.8));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function getChatMessages(peerId) {
  if (!currentUser || !peerId) return [];
  return localMessagesCache.filter(function (m) {
    return !m.isDeleted && !deletedIds[m.id] &&
      ((m.senderId === currentUser.id && m.receiverId === peerId) ||
       (m.senderId === peerId && m.receiverId === currentUser.id));
  }).sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
}

/* ==================== ВХОД И ИНИЦИАЛИЗАЦИЯ ==================== */
async function enterByName() {
  var name = document.getElementById('auth-name').value.trim();
  var errBox = document.getElementById('auth-error');
  if (!name) { errBox.innerText = 'Введите имя'; errBox.style.display = 'block'; return; }
  if (!lockButton('enter-btn', 3000)) return;
  try {
    var deviceId = getOrCreateDeviceId();
    var res = await fetch('/api/enter', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, deviceId: deviceId, userAgent: navigator.userAgent })
    });
    var data = await res.json();
    if (!data.success) { errBox.innerText = data.error || 'Ошибка'; errBox.style.display = 'block'; return; }
    currentUser = data.user;
    try { localStorage.setItem('messenger_p2p_user', JSON.stringify(currentUser)); } catch (e) {}
    startApp();
  } catch (e) { errBox.innerText = 'Сигнальный сервер недоступен'; errBox.style.display = 'block'; }
}
function logoutUser() {
  currentUser = null; localStorage.removeItem('messenger_p2p_user'); location.reload();
}
async function restartSession() { location.reload(); }
async function deleteSession() {
  if (!confirm('Удалить сессию и все локальные P2P сообщения?')) return;
  try {
    await fetch('/api/enter/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: currentUser.id }) });
  } catch(e){}
  localStorage.clear();
  location.reload();
}

function startApp() {
  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('active');
  updateMyProfileUI();
  sendPing();
  loadDialogs();

  // Опрос сигнального сервера для установки входящих P2P соединений
  setInterval(async function() {
    if (!currentUser) return;
    sendPing();
    try {
      var res = await fetch('/api/p2p/poll?userId=' + encodeURIComponent(currentUser.id));
      var data = await res.json();
      if (data.success && data.signals) {
        for (var i = 0; i < data.signals.length; i++) {
          await handleP2PSignal(data.signals[i]);
        }
      }
    } catch(e){}
    refreshChatListStatuses();
    if (activePeer) refreshActivePeerStatus();
  }, 2000);
}

async function sendPing() {
  if (!currentUser) return;
  try {
    await fetch('/api/ping', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar || '', userAgent: navigator.userAgent })
    });
  } catch(e){}
}

async function refreshActivePeerStatus() {
  if (!activePeer) return;
  try {
    var res = await fetch('/api/users/' + activePeer.id);
    if (res.ok) {
      var info = await res.json();
      activePeer.isOnline = info.isOnline;
      var conn = p2pConnections[activePeer.id];
      var isP2PConnected = conn && conn.status === 'connected';
      var statusEl = document.getElementById('active-peer-status');
      if (isP2PConnected) {
        statusEl.innerText = 'в сети (Прямое P2P соединение)';
        statusEl.style.color = '#4cd964';
      } else if (info.isOnline) {
        statusEl.innerText = 'в сети (установка P2P...)';
        statusEl.style.color = '#f9a825';
        getOrCreateP2PConnection(activePeer.id, true);
      } else {
        statusEl.innerText = 'не в сети';
        statusEl.style.color = 'var(--text-muted)';
      }
    }
  } catch(e){}
}

function updateMyProfileUI() {
  document.getElementById('my-display-name').innerText = currentUser.name;
  document.getElementById('my-display-device').innerText = 'ID: ' + currentUser.id;
  renderAvatarIntoElement(document.getElementById('my-avatar-circle'), currentUser, true);
}

function cacheUser(user) {
  if (!user || !user.id) return;
  localKnownUsers[user.id] = user;
  try { localStorage.setItem('messenger_p2p_known', JSON.stringify(localKnownUsers)); } catch (e) {}
}

/* ==================== ОБРАБОТКА ВХОДЯЩИХ ПРЯМЫХ СООБЩЕНИЙ ==================== */
function handleIncomingP2PMessage(msg) {
  if (!msg || !msg.id) return;
  msg.isPending = false;
  mergeMessage(msg);

  if (activePeer && activePeer.id === msg.senderId) {
    renderMessagesContainer(getChatMessages(activePeer));
  } else {
    playNotificationSound();
    if (document.hidden) {
      unreadTitleCounter++;
      updatePageTitle();
    }
  }
  loadDialogs();
}

/* ==================== ДИАЛОГИ И ПОИСК ==================== */
function loadDialogs() {
  if (!currentUser) return;
  var peers = new Set();
  localMessagesCache.forEach(function (m) {
    if (m.isDeleted || deletedIds[m.id]) return;
    if (m.senderId === currentUser.id) peers.add(m.receiverId);
    if (m.receiverId === currentUser.id) peers.add(m.senderId);
  });
  if (currentUser.contacts) currentUser.contacts.forEach(function(c){ peers.add(c); });

  fetch('/api/dialogs/' + encodeURIComponent(currentUser.id)).then(function (r) { return r.json(); }).then(function (onlineList) {
    var onlineMap = {};
    onlineList.forEach(function (u) { onlineMap[u.id] = u; cacheUser(u); });
    var dialogs = [];
    peers.forEach(function (pid) {
      if (pid === currentUser.id) return;
      var u = localKnownUsers[pid] || onlineMap[pid];
      if (!u) return;
      var conn = p2pConnections[pid];
      var p2pOk = conn && conn.status === 'connected';
      dialogs.push({ id: pid, name: u.name, avatar: u.avatar || '', isOnline: !!onlineMap[pid], p2pConnected: p2pOk });
    });
    renderChatList(dialogs);
  }).catch(function () {});
}

function renderChatList(list) {
  var container = document.getElementById('chat-list');
  var currentActiveId = activePeer ? activePeer.id : null;
  container.innerHTML = '';
  if (!list || list.length === 0) {
    container.innerHTML = '<div style="padding:15px;color:var(--text-muted);font-size:12px;text-align:center;">Нет чатов. Найдите собеседника через поиск.</div>';
    return;
  }
  list.forEach(function (item) {
    var div = document.createElement('div');
    div.className = 'chat-item ' + (currentActiveId === item.id ? 'active' : '');
    div.onclick = function () { openChat(item); };
    var avatarId = 'ch_av_' + item.id;
    var sub = item.p2pConnected ? '<span style="color:#4cd964;">⚡ Прямая связь (P2P)</span>' : (item.isOnline ? '<span style="color:#f9a825;">в сети</span>' : '<span style="color:var(--text-muted);">не в сети</span>');
    div.innerHTML = '<div class="avatar-circle" id="' + avatarId + '"></div><div style="overflow:hidden;flex:1;"><div style="font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(item.name) + '</div><div style="font-size:11px;">' + sub + '</div></div>';
    container.appendChild(div);
    renderAvatarIntoElement(document.getElementById(avatarId), item, item.isOnline);
  });
}

function refreshChatListStatuses() {
  loadDialogs();
}

var searchDebounceTimer = null;
function onSearchInput() {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(doSearch, 200);
}
async function doSearch() {
  var q = document.getElementById('search-input').value.trim();
  var clearBtn = document.getElementById('clear-search-btn');
  if (q) clearBtn.style.display = 'block'; else clearBtn.style.display = 'none';
  try {
    var res = await fetch('/api/users/search?q=' + encodeURIComponent(q) + '&excludeId=' + encodeURIComponent(currentUser.id));
    var users = await res.json();
    renderSearchResults(users);
  } catch(e){}
}
function clearSearch() { document.getElementById('search-input').value = ''; document.getElementById('clear-search-btn').style.display = 'none'; loadDialogs(); }

function renderSearchResults(list) {
  var container = document.getElementById('chat-list');
  container.innerHTML = '';
  if (!list || list.length === 0) { container.innerHTML = '<div style="padding:15px;color:var(--text-muted);font-size:12px;text-align:center;">Никого не найдено</div>'; return; }
  list.forEach(function (item) {
    var div = document.createElement('div');
    div.className = 'chat-item';
    div.onclick = function () { openChat(item); };
    div.innerHTML = '<div class="avatar-circle"><span>' + item.name.charAt(0) + '</span></div><div style="overflow:hidden;flex:1;"><div style="font-weight:bold;">' + escapeHtml(item.name) + '</div><div style="font-size:11px;color:#4cd964;">Нажмите для связи P2P</div></div>';
    container.appendChild(div);
  });
}

/* ==================== ОТКРЫТИЕ ЧАТА ==================== */
function openChat(peer) {
  activePeer = peer;
  cacheUser(peer);
  document.getElementById('active-peer-name').innerText = peer.name;
  
  // Инициируем прямое P2P соединение
  getOrCreateP2PConnection(peer.id, true);
  refreshActivePeerStatus();

  renderAvatarIntoElement(document.getElementById('peer-avatar-circle'), peer, peer.isOnline);
  document.getElementById('input-bar').style.display = 'flex';
  if (window.innerWidth <= 600) {
    document.getElementById('app-screen').classList.add('app-mobile-chat');
    document.getElementById('back-to-list-btn').style.display = 'block';
  }
  renderMessagesContainer(getChatMessages(peer.id));
  unreadTitleCounter = 0; updatePageTitle();
}
function closeMobileChat() { document.getElementById('app-screen').classList.remove('app-mobile-chat'); }

/* ==================== ОТПРАВКА СООБЩЕНИЙ ПРЯМО (P2P) ==================== */
async function sendMsg() {
  if (!activePeer) return;
  var input = document.getElementById('msg-input');
  var text = input.value.trim();
  var fileToSend = selectedFile;
  var voiceToSend = pendingVoice;
  if (!text && !fileToSend && !voiceToSend) return;
  input.value = '';

  var msgId = 'p2p_msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  var msgObj = {
    id: msgId,
    senderId: currentUser.id,
    receiverId: activePeer.id,
    text: text,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    ts: Date.now(),
    isRead: true,
    isDeleted: false
  };

  if (voiceToSend) {
    msgObj.fileData = await blobToBase64(voiceToSend.blob);
    msgObj.fileName = voiceToSend.name;
    msgObj.fileType = voiceToSend.type;
    cancelVoiceAttachment();
  } else if (fileToSend) {
    msgObj.fileData = await blobToBase64(fileToSend.file);
    msgObj.fileName = fileToSend.name;
    msgObj.fileType = fileToSend.type;
    cancelAttachment();
  }

  // Сохраняем локально и отправляем ПРЯМО через DataChannel
  mergeMessage(msgObj);
  renderMessagesContainer(getChatMessages(activePeer.id));
  sendDataMessage(activePeer.id, msgObj);
}

/* ==================== РЕНДЕР ИНТЕРФЕЙСА СООБЩЕНИЙ ==================== */
async function renderMessagesContainer(messages) {
  var container = document.getElementById('messages-container');
  if (!container) return;
  if (!messages || messages.length === 0) {
    container.innerHTML = '<div class="empty-state">Прямое P2P соединение установлено. Сообщения не хранятся на сервере.</div>';
    return;
  }
  container.innerHTML = '';
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m.isDeleted) continue;
    var div = document.createElement('div');
    div.className = 'msg ' + (m.senderId === currentUser.id ? 'my' : '');
    div.setAttribute('data-msg-id', m.id);
    
    var html = '';
    if (m.text) html += '<div class="msg-text">' + escapeHtml(m.text) + '</div>';
    if (m.fileData) {
      var url = await getFileUrl(m);
      if (m.fileType && m.fileType.indexOf('image/') === 0) {
        html += '<img class="media-preview" src="' + url + '" onclick="openImageViewer(\'' + url + '\')">';
      } else if (m.fileType && m.fileType.indexOf('audio/') === 0) {
        html += '<audio class="audio-preview" controls src="' + url + '"></audio>';
      } else {
        html += '<a class="file-link" href="' + url + '" download="' + (m.fileName || 'file') + '">📁 ' + escapeHtml(m.fileName || 'Файл') + '</a>';
      }
    }
    html += '<div class="msg-footer"><span class="msg-time">' + escapeHtml(m.timestamp) + '</span></div>';
    div.innerHTML = html;
    container.appendChild(div);
  }
  container.scrollTop = container.scrollHeight;
}

function openImageViewer(src) { document.getElementById('full-screen-img').src = src; document.getElementById('image-viewer-modal').classList.add('active'); }
function closeImageViewer() { document.getElementById('image-viewer-modal').classList.remove('active'); }

/* ==================== АВАТАРЫ И ПРОФИЛЬ ==================== */
function renderAvatarIntoElement(el, userObj, isOnline) {
  if (!el) return;
  el.innerHTML = '';
  var indicator = document.createElement('div');
  indicator.className = 'online-indicator ' + (isOnline ? 'visible' : 'offline');
  el.appendChild(indicator);
  var span = document.createElement('span');
  span.innerText = userObj && userObj.name ? userObj.name.charAt(0).toUpperCase() : '?';
  el.appendChild(span);
}
function openMyProfile() {
  document.getElementById('edit-my-name-input').value = currentUser.name;
  document.getElementById('my-profile-name-view').innerText = currentUser.name;
  document.getElementById('my-profile-id-view').innerText = 'ID: ' + currentUser.id;
  safeOpenModal('my-profile-modal');
}
function closeMyProfile() { safeCloseModal('my-profile-modal'); }
function triggerAvatarInput() { document.getElementById('avatar-file-input').click(); }
function handleAvatarSelect(e) {
  var file = e.target.files[0]; if (!file) return;
  compressImage(file, 200, 0.8, function(c) {
    if (!c) return;
    currentUser.avatar = c;
    renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), currentUser, true);
  });
}
async function saveMyProfileChanges() {
  var newName = document.getElementById('edit-my-name-input').value.trim();
  if (newName) currentUser.name = newName;
  try { localStorage.setItem('messenger_p2p_user', JSON.stringify(currentUser)); } catch (e) {}
  updateMyProfileUI();
  closeMyProfile();
}
function openPeerProfile() {
  if (!activePeer) return;
  document.getElementById('peer-profile-name-view').innerText = activePeer.name;
  document.getElementById('peer-profile-id-view').innerText = 'ID: ' + activePeer.id;
  safeOpenModal('peer-profile-modal');
}
function closePeerProfile() { safeCloseModal('peer-profile-modal'); }
function toggleMutePeer() { }

/* ==================== ФАЙЛЫ И ГОЛОС ==================== */
function triggerFileInput() { document.getElementById('file-input').click(); }
function handleFileSelect(e) {
  var file = e.target.files[0]; if (!file) return;
  if (file.size > MAX_FILE_SIZE) { alert('Максимальный размер файла для P2P: 100 МБ'); return; }
  selectedFile = { file: file, name: file.name, type: file.type };
  document.getElementById('attachment-name-label').innerText = file.name;
  document.getElementById('attachment-preview-container').classList.add('active');
}
function cancelAttachment() { selectedFile = null; document.getElementById('file-input').value = ''; document.getElementById('attachment-preview-container').classList.remove('active'); }
function cancelVoiceAttachment() { pendingVoice = null; document.getElementById('audio-attachment-preview').classList.remove('active'); }

async function toggleVoiceRecord() {
  var micBtn = document.getElementById('mic-btn');
  if (isRecording) {
    isRecording = false; micBtn.innerText = '🎙️'; micBtn.classList.remove('recording');
    try { activeStream.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
    return;
  }
  try {
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    activeStream = stream;
    var mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = function(e) { audioChunks.push(e.data); };
    mediaRecorder.onstop = function() {
      var blob = new Blob(audioChunks, { type: 'audio/webm' });
      pendingVoice = { name: 'voice.webm', type: 'audio/webm', blob: blob };
      var url = URL.createObjectURL(blob);
      document.getElementById('audio-preview-player').src = url;
      document.getElementById('audio-attachment-preview').classList.add('active');
    };
    mediaRecorder.start();
    isRecording = true;
    micBtn.innerText = '🔴';
    micBtn.classList.add('recording');
    setTimeout(function() { if (isRecording) toggleVoiceRecord(); }, 15000); // автостоп через 15 сек
  } catch(e) { alert('Нет доступа к микрофону'); }
}

/* ==================== ИНИЦИАЛИЗАЦИЯ СТАРТА ==================== */
window.addEventListener('DOMContentLoaded', async function () {
  try { currentUser = JSON.parse(localStorage.getItem('messenger_p2p_user') || 'null'); } catch (e) { currentUser = null; }
  try { localKnownUsers = JSON.parse(localStorage.getItem('messenger_p2p_known') || '{}'); } catch (e) { localKnownUsers = {}; }
  try { localMessagesCache = JSON.parse(localStorage.getItem('messenger_p2p_cache') || '[]'); } catch (e) { localMessagesCache = []; }

  await checkServerHealth();
  if (currentUser) {
    startApp();
  } else {
    updateLoadingScreen();
  }
});
`;

/* ==================== ROUTES ==================== */
app.get('/client.js', function (req, res) {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.send(CLIENT_JS);
});

app.use(function (req, res) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(CLIENT_HTML);
});

const httpServer = app.listen(PORT, '0.0.0.0', function () {
  console.log('[P2P SERVER v' + SERVER_VERSION + '] port ' + PORT);
});
