const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use('/api/upload/chunk', express.raw({ type: 'application/octet-stream', limit: '5mb' }));

process.on('uncaughtException', function (err) { console.error('[СЕРВЕР]:', err); });
process.on('unhandledRejection', function (r) { console.error('[ПРОМИС]:', r); });

const SERV_DIR = __dirname;
const ARXIV_DIR = path.join(SERV_DIR, 'arxiv');
const FILES_DIR = path.join(ARXIV_DIR, 'files');
if (!fs.existsSync(ARXIV_DIR)) fs.mkdirSync(ARXIV_DIR, { recursive: true });
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

const TOMB_FILE = path.join(ARXIV_DIR, 'tombstones.json');
const PROFILES_FILE = path.join(ARXIV_DIR, 'profiles.json');

const CHUNK_SIZE_LIMIT = 1024 * 1024;
const MAX_FILE_SIZE = 200 * 1024 * 1024;

/* ==================== IN-MEMORY ==================== */
const recentEvents = new Map();
const RECENT_LIMIT = 10000;
const tombstones = new Map();
let tombstonesDirty = false;
const onlineUsers = new Map();
const ONLINE_TIMEOUT = 8000;
const profilesCache = {};
let profilesDirty = false;
const fileIndex = new Map();
const uploads = new Map();

/* ==================== DISK ==================== */
function safeReadJSON(fp, fb) {
  try {
    if (!fs.existsSync(fp)) return fb;
    const raw = fs.readFileSync(fp, 'utf8');
    if (!raw || !raw.trim()) return fb;
    return JSON.parse(raw);
  } catch (e) { return fb; }
}
function safeWriteJSON(fp, data) {
  const tmp = fp + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, fp);
  } catch (e) {}
}

(function () {
  const arr = safeReadJSON(TOMB_FILE, []);
  arr.forEach(t => { if (t && t.type && t.id) tombstones.set(t.type + ':' + t.id, t); });
  console.log('[TOMBSTONES] loaded: ' + tombstones.size);
})();
(function () {
  const obj = safeReadJSON(PROFILES_FILE, {});
  Object.keys(obj).forEach(id => { profilesCache[id] = obj[id]; });
  console.log('[PROFILES] loaded: ' + Object.keys(profilesCache).length);
})();

setInterval(function () {
  if (tombstonesDirty) { tombstonesDirty = false; safeWriteJSON(TOMB_FILE, Array.from(tombstones.values())); }
  if (profilesDirty) { profilesDirty = false; safeWriteJSON(PROFILES_FILE, profilesCache); }
}, 3000);

/* ==================== HELPERS ==================== */
function markOnline(u) {
  onlineUsers.set(u.id, { id: u.id, name: u.name || '', avatar: u.avatar || '', lastSeen: Date.now() });
}
setInterval(function () {
  const now = Date.now();
  onlineUsers.forEach((u, id) => { if (now - u.lastSeen > ONLINE_TIMEOUT) onlineUsers.delete(id); });
}, 3000);

function pushEvent(ev) {
  const key = ev._key || (ev.type + ':' + (ev.id || Date.now()) + ':' + Math.random().toString(36).substr(2, 6));
  ev._key = key;
  ev._ts = Date.now();
  recentEvents.set(key, ev);
  if (recentEvents.size > RECENT_LIMIT) {
    const firstKey = recentEvents.keys().next().value;
    recentEvents.delete(firstKey);
  }
}

/* ==================== API ==================== */

// Проверка соединения клиента с сервером
app.get('/api/health', function (req, res) {
  res.json({ ok: true, serverTime: Date.now() });
});

// РЕГИСТРАЦИЯ — только через сервер. Если сервер жив, но не подтвердил — отказ
app.post('/api/register', function (req, res) {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Введите имя' });
  
  const id = 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const profile = {
    id: id,
    name: name.trim(),
    avatar: '',
    updatedAt: Date.now()
  };
  
  profilesCache[id] = profile;
  profilesDirty = true;
  markOnline(profile);
  
  res.json({ success: true, user: profile });
});

app.post('/api/ping', function (req, res) {
  const { id, name, avatar } = req.body;
  if (!id) return res.status(400).json({ error: 'No id' });
  markOnline({ id, name, avatar });
  if (name) {
    if (!profilesCache[id] || profilesCache[id].name !== name || profilesCache[id].avatar !== avatar) {
      profilesCache[id] = { id, name, avatar: avatar || '', updatedAt: Date.now() };
      profilesDirty = true;
    }
  }
  res.json({
    success: true,
    online: Array.from(onlineUsers.keys()),
    tombstonesCount: tombstones.size,
    eventsCount: recentEvents.size,
    serverTime: Date.now()
  });
});

app.get('/api/profiles', function (req, res) {
  const result = Object.keys(profilesCache).map(id => {
    const p = profilesCache[id];
    return { id, name: p.name, avatar: p.avatar || '', isOnline: onlineUsers.has(id) };
  });
  res.json(result);
});

app.post('/api/push', function (req, res) {
  const { senderId, events, tombstones: newTombs, profile } = req.body;
  if (!senderId) return res.status(400).json({ error: 'No senderId' });
  markOnline({ id: senderId, name: req.body.name || '', avatar: req.body.avatar || '' });
  
  if (profile && profile.id) {
    profilesCache[profile.id] = Object.assign({}, profile, { updatedAt: Date.now() });
    profilesDirty = true;
  }
  
  if (Array.isArray(newTombs)) {
    newTombs.forEach(t => {
      if (!t || !t.type || !t.id) return;
      const key = t.type + ':' + t.id;
      if (!tombstones.has(key)) {
        tombstones.set(key, { type: t.type, id: t.id, at: t.at || Date.now(), fromUser: senderId });
        tombstonesDirty = true;
        if (t.type === 'message' || t.type === 'file') {
          try {
            const files = fs.readdirSync(FILES_DIR);
            files.forEach(f => {
              if (f.indexOf(t.id) === 0) {
                try { fs.unlinkSync(path.join(FILES_DIR, f)); } catch (e) {}
              }
            });
          } catch (e) {}
        }
      }
    });
  }
  
  if (Array.isArray(events)) {
    events.forEach(ev => {
      if (!ev || !ev.type) return;
      if (ev.id) {
        if (ev.type === 'message' && tombstones.has('message:' + ev.id)) return;
        if (ev.type === 'group' && tombstones.has('group:' + ev.id)) return;
        if (ev.type === 'group_update' && tombstones.has('group:' + ev.id)) return;
      }
      ev.fromUser = senderId;
      pushEvent(ev);
    });
  }
  
  res.json({ success: true });
});

app.post('/api/pull', function (req, res) {
  const { userId, contacts, groups, knownTombstones } = req.body;
  if (!userId) return res.status(400).json({ error: 'No userId' });
  markOnline({ id: userId, name: req.body.name || '', avatar: req.body.avatar || '' });
  
  const knownSet = new Set(knownTombstones || []);
  const contactsSet = new Set(contacts || []);
  const myGroups = new Map();
  (groups || []).forEach(g => myGroups.set(g.id, new Set(g.members || [])));
  
  const newTombstones = [];
  tombstones.forEach((t, key) => {
    if (knownSet.has(key)) return;
    if (t.fromUser === userId) return;
    newTombstones.push(t);
  });
  
  const result = [];
  recentEvents.forEach(ev => {
    if (ev.fromUser === userId) return;
    if (ev.id) {
      if (ev.type === 'message' && tombstones.has('message:' + ev.id)) return;
      if (ev.type === 'group' && tombstones.has('group:' + ev.id)) return;
    }
    let interested = false;
    if (ev.type === 'message' || ev.type === 'message_read') {
      if (ev.groupId) interested = myGroups.has(ev.groupId);
      else interested = (ev.senderId === userId || ev.receiverId === userId);
    } else if (ev.type === 'group' || ev.type === 'group_update') {
      interested = myGroups.has(ev.id) || (ev.members && ev.members.indexOf(userId) !== -1) || (ev.ownerId === userId);
    } else if (ev.type === 'group_kick') {
      interested = (ev.memberId === userId) || myGroups.has(ev.groupId);
    } else if (ev.type === 'profile') {
      interested = contactsSet.has(ev.id) || ev.id === userId;
    } else if (ev.type === 'sync_request' && ev.toUserId === userId) {
      interested = true;
    } else if (ev.type === 'sync_response' && ev.toUserId === userId) {
      interested = true;
    } else if (ev.type === 'file_request' && ev.toUserId === userId) {
      interested = true;
    }
    if (interested) result.push(ev);
  });
  
  res.json({
    success: true,
    events: result,
    tombstones: newTombstones,
    online: Array.from(onlineUsers.keys())
  });
});

app.post('/api/request-sync', function (req, res) {
  const { fromUserId, toUserId, scope } = req.body;
  if (!fromUserId || !toUserId) return res.status(400).json({ error: 'Bad' });
  pushEvent({
    type: 'sync_request',
    id: fromUserId + ':' + toUserId + ':' + Date.now(),
    fromUser: fromUserId, fromUserId, toUserId,
    scope: scope || 'all'
  });
  res.json({ success: true });
});

app.post('/api/respond-sync', function (req, res) {
  const { fromUserId, toUserId, chunkIndex, totalChunks, data } = req.body;
  if (!fromUserId || !toUserId) return res.status(400).json({ error: 'Bad' });
  pushEvent({
    type: 'sync_response',
    id: fromUserId + ':' + toUserId + ':' + (chunkIndex || 0) + ':' + Date.now(),
    fromUser: fromUserId, fromUserId, toUserId,
    chunkIndex: chunkIndex || 0, totalChunks: totalChunks || 1, data
  });
  res.json({ success: true });
});

/* ==================== FILES ==================== */
app.post('/api/upload/init', function (req, res) {
  const { senderId, fileName, fileSize, fileType } = req.body;
  if (!senderId) return res.status(400).json({ error: 'No sender' });
  if (fileSize > MAX_FILE_SIZE) return res.status(413).json({ error: 'Too big' });
  const fileId = 'f_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const totalChunks = Math.ceil((fileSize || 0) / CHUNK_SIZE_LIMIT);
  uploads.set(fileId, { fileId, fileName, fileSize, fileType, senderId, totalChunks, chunks: [], received: 0 });
  res.json({ success: true, fileId, totalChunks, chunkSize: CHUNK_SIZE_LIMIT });
});

app.post('/api/upload/chunk', function (req, res) {
  const fileId = req.query.fileId;
  const idx = parseInt(req.query.chunkIndex, 10);
  const up = uploads.get(fileId);
  if (!up) return res.status(404).json({ error: 'Not found' });
  if (isNaN(idx) || idx < 0 || idx >= up.totalChunks) return res.status(400).json({ error: 'Bad chunk' });
  up.chunks[idx] = Buffer.from(req.body);
  up.received = up.chunks.filter(c => c).length;
  res.json({ success: true, received: up.received, total: up.totalChunks });
});

app.post('/api/upload/finish', function (req, res) {
  const { fileId } = req.body;
  const up = uploads.get(fileId);
  if (!up) return res.status(404).json({ error: 'Not found' });
  for (let i = 0; i < up.totalChunks; i++) {
    if (!up.chunks[i]) return res.status(400).json({ error: 'Missing chunk ' + i });
  }
  const buf = Buffer.concat(up.chunks);
  const safeName = fileId + '_' + (up.fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const fp = path.join(FILES_DIR, safeName);
  fs.writeFileSync(fp, buf);
  fileIndex.set(fileId, { path: fp, ownerId: up.senderId });
  uploads.delete(fileId);
  res.json({ success: true, fileId, url: '/files/' + safeName, fileName: up.fileName, fileType: up.fileType, fileSize: up.fileSize });
});

app.get('/files/:name', function (req, res) {
  const name = req.params.name;
  if (name.indexOf('..') !== -1 || name.indexOf('/') !== -1 || name.indexOf('\\') !== -1) return res.status(400).send('bad');
  const fp = path.join(FILES_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).send('not found');
  const stat = fs.statSync(fp);
  const range = req.headers.range;
  const ext = path.extname(name).toLowerCase();
  const mime = {
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.txt': 'text/plain'
  }[ext] || 'application/octet-stream';
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    if (start >= stat.size) return res.status(416).set('Content-Range', 'bytes */' + stat.size).end();
    res.writeHead(206, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime
    });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(fp).pipe(res);
  }
});

app.post('/api/request-file', function (req, res) {
  const { fileId, fromUserId, ownerId } = req.body;
  if (!fileId || !fromUserId || !ownerId) return res.status(400).json({ error: 'Bad' });
  pushEvent({
    type: 'file_request',
    id: fileId + ':' + fromUserId,
    fromUser: fromUserId, fileId, fromUserId, ownerId, toUserId: ownerId
  });
  res.json({ success: true });
});

/* ==================== HTML ==================== */

const CLIENT_HTML = `<!DOCTYPE html>
<html lang="ru" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>Мессенджер</title>
<style>
  :root[data-theme="dark"] {
    --bg-app: #0e1621; --bg-sidebar: #17212b; --bg-input: #242f3d; --bg-hover: #202b36;
    --bg-active: #2b5278; --bg-msg-peer: #182533; --bg-msg-my: #2b5278; --text-main: #ffffff;
    --text-muted: #7f91a4; --accent: #5288c1; --border: #0e1621; --msg-selected: rgba(82,136,193,0.3);
  }
  :root[data-theme="light"] {
    --bg-app: #e6ebee; --bg-sidebar: #ffffff; --bg-input: #f1f3f5; --bg-hover: #f5f5f5;
    --bg-active: #e3edf7; --bg-msg-peer: #ffffff; --bg-msg-my: #eeffde; --text-main: #000000;
    --text-muted: #707579; --accent: #3390ec; --border: #e6ebee; --msg-selected: rgba(51,144,236,0.2);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100dvh; width: 100vw; background: var(--bg-app); color: var(--text-main); overflow: hidden; position: fixed; }
  .screen { display: none; height: 100dvh; width: 100vw; position: absolute; top: 0; left: 0; }
  .screen.active { display: flex; }
  .auth-container { margin: auto; width: 90%; max-width: 360px; background: var(--bg-sidebar); padding: 25px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); text-align: center; }
  .auth-container h2 { margin-bottom: 20px; color: var(--accent); }
  .input-group { margin-bottom: 15px; text-align: left; }
  .input-group input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--bg-input); background: var(--bg-input); color: var(--text-main); outline: none; }
  .btn { width: 100%; padding: 12px; background: var(--accent); color: #fff; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; margin-top: 10px; transition: opacity 0.15s; }
  .btn:disabled { opacity: 0.5; cursor: wait; }
  .btn-secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  .btn-danger { background: #e53935; color: #fff; }
  .error-msg { color: #e53935; font-size: 12px; margin-top: 8px; display: none; }
  
  /* STATUS BAR - состояние соединения */
  #status-bar { position: fixed; top: 0; left: 0; right: 0; padding: 8px; text-align: center; font-size: 13px; font-weight: 600; z-index: 9999; transition: transform 0.3s, opacity 0.3s; transform: translateY(-100%); }
  #status-bar.visible { transform: translateY(0); }
  #status-bar.internet-off { background: #e53935; color: #fff; }
  #status-bar.server-off { background: #f9a825; color: #000; }
  #status-bar.reconnected { background: #4cd964; color: #fff; }
  
  /* LOADING SCREEN */
  #loading-screen { display: none; position: fixed; inset: 0; background: var(--bg-app); z-index: 10000; flex-direction: column; align-items: center; justify-content: center; gap: 20px; }
  #loading-screen.active { display: flex; }
  .spinner { width: 50px; height: 50px; border: 4px solid var(--bg-input); border-top-color: var(--accent); border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-text { color: var(--text-muted); font-size: 15px; text-align: center; padding: 0 20px; }
  .loading-title { font-size: 20px; font-weight: bold; color: var(--text-main); text-align: center; }
  
  #app-container { display: flex; width: 100%; height: 100%; }
  .sidebar { width: 320px; background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
  .sidebar-header { padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }
  .user-profile-bar { display: flex; align-items: center; justify-content: space-between; padding: 4px; cursor: pointer; }
  .user-info-brief { display: flex; flex-direction: column; overflow: hidden; margin-left: 10px; flex: 1; }
  .avatar-circle { width: 40px; height: 40px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; color: #fff; font-weight: bold; flex-shrink: 0; font-size: 16px; position: relative; }
  .avatar-circle img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block; position: relative; z-index: 1; }
  .avatar-circle > span { position: relative; z-index: 1; }
  .online-indicator { position: absolute; bottom: -2px; right: -2px; width: 12px; height: 12px; background: #4cd964; border: 2px solid var(--bg-sidebar); border-radius: 50%; display: none; z-index: 999; pointer-events: none; box-sizing: content-box; }
  .online-indicator.visible { display: block; }
  .header-actions { display: flex; gap: 6px; }
  .theme-toggle-btn { background: var(--bg-input); border: none; color: var(--text-main); width: 34px; height: 34px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px; }
  .new-group-btn-icon { display: inline-flex; align-items: baseline; line-height: 1; }
  .new-group-btn-icon .plus { font-size: 11px; margin-right: 1px; }
  .new-group-btn-icon .people { font-size: 16px; }
  .search-box { position: relative; }
  .search-box input { width: 100%; padding: 10px 12px; border-radius: 18px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; font-size: 14px; }
  .clear-search { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; color: var(--text-muted); display: none; }
  .chat-list { flex: 1; overflow-y: auto; }
  .chat-item { display: flex; align-items: center; gap: 12px; padding: 12px; cursor: pointer; border-bottom: 1px solid var(--border); }
  .chat-item:hover, .chat-item.active { background: var(--bg-active); }
  .main-chat { flex: 1; display: flex; flex-direction: column; background: var(--bg-app); position: relative; min-width: 0; }
  .chat-header { background: var(--bg-sidebar); padding: 8px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); height: 60px; }
  .chat-header-info { display: flex; align-items: center; gap: 10px; cursor: pointer; flex: 1; overflow: hidden; }
  .chat-menu-container { position: relative; }
  .menu-dots-btn { background: transparent; border: none; color: var(--text-main); font-size: 20px; cursor: pointer; padding: 8px; border-radius: 50%; display: none; }
  .chat-dropdown-menu { position: absolute; right: 0; top: 45px; background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); width: 220px; display: none; flex-direction: column; z-index: 1000; overflow: hidden; }
  .chat-dropdown-menu.active { display: flex; }
  .menu-item { padding: 12px 16px; font-size: 14px; cursor: pointer; border-bottom: 1px solid var(--border); text-align: left; background: none; border-top: none; border-left: none; border-right: none; color: var(--text-main); width: 100%; }
  .menu-item:hover { background: var(--bg-active); }
  .menu-item.danger { color: #e53935; }
  .messages-container { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 75%; padding: 10px 14px; border-radius: 12px; background: var(--bg-msg-peer); align-self: flex-start; word-break: break-word; user-select: none; }
  .msg.my { background: var(--bg-msg-my); align-self: flex-end; }
  .msg.selected-msg { background: var(--msg-selected) !important; outline: 2px solid var(--accent); }
  .msg-sender { font-size: 12px; font-weight: bold; color: var(--accent); margin-bottom: 2px; }
  .media-preview { width: 260px; height: 180px; max-width: 100%; border-radius: 8px; margin-top: 6px; object-fit: cover; display: block; background: #000; cursor: pointer; }
  .video-preview { width: 260px; max-width: 100%; border-radius: 8px; margin-top: 6px; display: block; background: #000; }
  .file-link { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-input); border-radius: 6px; color: var(--accent); text-decoration: none; margin-top: 5px; font-size: 13px; }
  .file-placeholder { padding: 8px 12px; background: var(--bg-input); border-radius: 6px; margin-top: 5px; font-size: 12px; color: var(--text-muted); }
  .audio-preview { width: 240px !important; max-width: 240px !important; height: 40px; margin-top: 5px; display: block; }
  .msg-footer { display: flex; align-items: center; justify-content: flex-end; gap: 4px; font-size: 9px; color: var(--text-muted); margin-top: 3px; }
  .ticks { font-size: 11px; letter-spacing: -3px; font-weight: bold; }
  .ticks.read { color: var(--accent); }
  .attachment-preview-container { background: var(--bg-sidebar); padding: 10px 15px; border-top: 1px solid var(--border); display: none; align-items: center; gap: 12px; }
  .attachment-preview-container.active { display: flex; }
  .attachment-thumb { width: 45px; height: 45px; border-radius: 6px; object-fit: cover; background: #000; }
  .attachment-info { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .attachment-name { font-size: 13px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .attachment-cancel { cursor: pointer; color: #e53935; font-size: 18px; padding: 5px; }
  #audio-attachment-preview { display: none; }
  #audio-attachment-preview.active { display: flex; }
  #audio-attachment-preview audio { height: 36px; }
  .record-panel { display: none; background: var(--bg-sidebar); border-top: 1px solid var(--border); padding: 6px 12px; align-items: center; justify-content: center; gap: 10px; flex-shrink: 0; height: 40px; }
  .record-panel.active { display: flex; }
  .recording-indicator { display: none; align-items: center; gap: 6px; font-size: 13px; color: #e53935; }
  .recording-indicator.active { display: inline-flex; }
  .recording-dot { width: 10px; height: 10px; border-radius: 50%; background: #e53935; animation: recpulse 1s infinite; }
  @keyframes recpulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  #recording-timer { font-family: monospace; font-weight: bold; color: #e53935; font-size: 14px; }
  .input-bar { background: var(--bg-sidebar); padding: 10px; display: flex; gap: 10px; align-items: center; flex-shrink: 0; border-top: 1px solid var(--border); }
  .input-bar input[type="text"] { flex: 1; padding: 12px; border-radius: 20px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; min-width: 0; }
  .icon-btn { cursor: pointer; font-size: 22px; border: none; background: transparent; color: var(--text-main); padding: 4px; flex-shrink: 0; }
  .icon-btn.recording { color: #e53935; }
  .empty-state { margin: auto; text-align: center; color: var(--text-muted); font-size: 14px; }
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 2000; display: flex; align-items: center; justify-content: center; visibility: hidden; opacity: 0; transition: 0.15s; pointer-events: none; }
  .modal-overlay.active { visibility: visible; opacity: 1; pointer-events: auto; }
  .profile-card { background: var(--bg-sidebar); width: 90%; max-width: 380px; border-radius: 16px; padding: 25px; display: flex; flex-direction: column; align-items: center; text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,0.5); max-height: 90dvh; overflow-y: auto; }
  .profile-avatar-big { width: 90px; height: 90px; border-radius: 50%; background: var(--accent); margin-bottom: 15px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 32px; font-weight: bold; position: relative; }
  .profile-avatar-big img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
  .profile-avatar-big > span { position: relative; z-index: 1; }
  .profile-name { font-size: 20px; font-weight: bold; margin-bottom: 5px; }
  .profile-id { font-size: 13px; color: var(--accent); margin-bottom: 20px; }
  .profile-actions { width: 100%; display: flex; flex-direction: column; gap: 10px; }
  .profile-link-btn { background: none; border: none; color: var(--accent); font-size: 14px; cursor: pointer; padding: 5px; text-align: center; }
  .check-row { display: flex; align-items: center; gap: 10px; padding: 8px; cursor: pointer; border-radius: 8px; }
  .member-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; cursor: pointer; border-radius: 8px; position: relative; }
  .member-row:hover { background: var(--bg-hover); }
  .member-menu-btn { background: transparent; border: none; color: var(--text-muted); font-size: 20px; cursor: pointer; padding: 4px 8px; border-radius: 50%; }
  .member-dropdown { position: absolute; right: 8px; top: 90%; background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); min-width: 180px; z-index: 1500; display: none; }
  .member-dropdown.active { display: block; }
  .member-dropdown .menu-item { padding: 10px 14px; font-size: 13px; }
  .upload-progress-container { flex: 1; display: flex; align-items: center; gap: 10px; }
  .upload-progress-track { flex: 1; background: var(--bg-input); border-radius: 10px; overflow: hidden; height: 8px; }
  .upload-progress-bar { height: 100%; background: var(--accent); width: 0%; transition: width 0.15s; }
  .upload-progress-text { font-size: 12px; color: var(--text-muted); }
  #image-viewer-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.9); z-index: 3000; display: flex; align-items: center; justify-content: center; visibility: hidden; opacity: 0; transition: 0.15s; pointer-events: none; }
  #image-viewer-modal.active { visibility: visible; opacity: 1; pointer-events: auto; }
  #image-viewer-modal img { max-width: 95vw; max-height: 95vh; border-radius: 8px; }
  .viewer-close { position: absolute; top: 20px; right: 20px; color: #fff; font-size: 30px; cursor: pointer; background: none; border: none; }
  .msg-actions-sheet { position: fixed; bottom: 0; left: 0; right: 0; background: var(--bg-sidebar); border-top-left-radius: 16px; border-top-right-radius: 16px; padding: 20px; z-index: 1001; display: flex; flex-direction: column; gap: 10px; visibility: hidden; opacity: 0; transform: translateY(20px); transition: 0.15s; pointer-events: none; }
  .msg-actions-sheet.active { visibility: visible; opacity: 1; transform: translateY(0); pointer-events: auto; }
  @media (min-width: 601px) { .menu-dots-btn { display: flex !important; } }
  @media (max-width: 600px) {
    .sidebar { width: 100%; display: flex; }
    .main-chat { display: none; width: 100%; }
    .app-mobile-chat .sidebar { display: none; }
    .app-mobile-chat .main-chat { display: flex; }
    .app-mobile-chat .menu-dots-btn { display: flex !important; }
  }
</style>
</head>
<body>
  
  <!-- STATUS BAR -->
  <div id="status-bar"></div>
  
  <!-- LOADING SCREEN -->
  <div id="loading-screen">
    <div class="loading-title" id="loading-title">Соединение...</div>
    <div class="spinner"></div>
    <div class="loading-text" id="loading-text">Подключаемся к серверу</div>
  </div>
  
  <div id="auth-screen" class="screen active">
    <div class="auth-container">
      <h2>Вход в мессенджер</h2>
      <div id="auth-error" class="error-msg"></div>
      <div class="input-group">
        <input type="text" id="auth-name" placeholder="Ваше имя..." onkeydown="if(event.key==='Enter') registerUser()">
      </div>
      <button class="btn" id="login-btn" onclick="registerUser()">Войти</button>
    </div>
  </div>
  
  <div id="app-screen" class="screen">
    <div id="app-container">
      <div class="sidebar">
        <div class="sidebar-header">
          <div class="user-profile-bar">
            <div class="avatar-circle" id="my-avatar-circle" onclick="openMyProfile()">
              <div class="online-indicator visible" id="my-online-indicator"></div>
            </div>
            <div class="user-info-brief" onclick="openMyProfile()">
              <b id="my-display-name">Имя</b>
              <div style="font-size:11px; color:var(--accent);" id="my-display-id">ID</div>
            </div>
            <div class="header-actions">
              <button class="theme-toggle-btn" id="new-group-btn" onclick="openCreateGroup()" title="Создать группу">
                <span class="new-group-btn-icon"><span class="plus">+</span><span class="people">👥</span></span>
              </button>
              <button class="theme-toggle-btn" id="theme-toggle-btn" onclick="toggleTheme()">🌙</button>
            </div>
          </div>
          <div class="search-box">
            <input type="text" id="search-input" placeholder="Поиск..." oninput="onSearchInput()">
            <span class="clear-search" id="clear-search-btn" onclick="clearSearch()">✕</span>
          </div>
        </div>
        <div class="chat-list" id="chat-list"></div>
      </div>
      <div class="main-chat" id="main-chat">
        <div class="chat-header" id="chat-header">
          <button class="btn btn-secondary" style="width:auto; padding:6px 12px; font-size:12px; display:none;" id="back-to-list-btn" onclick="closeMobileChat()">← Назад</button>
          <div class="chat-header-info" onclick="openPeerProfile()">
            <div class="avatar-circle" id="peer-avatar-circle" style="width:36px; height:36px; font-size:14px;">
              <div class="online-indicator" id="peer-online-indicator"></div>
            </div>
            <div>
              <div id="active-peer-name" style="font-weight:bold;">Выберите чат</div>
              <div id="active-peer-status" style="font-size:11px; color:var(--text-muted);">нажмите для профиля</div>
            </div>
          </div>
          <div class="chat-menu-container">
            <button class="menu-dots-btn" id="chat-menu-dots-btn" onclick="toggleChatDropdown()">⋮</button>
            <div class="chat-dropdown-menu" id="chat-dropdown-menu"></div>
          </div>
        </div>
        <div class="messages-container" id="messages-container">
          <div class="empty-state">Выберите диалог слева</div>
        </div>
        <div class="attachment-preview-container" id="attachment-preview-container">
          <img id="attachment-thumb-img" class="attachment-thumb" src="" style="display:none;">
          <div class="attachment-info">
            <div class="attachment-name" id="attachment-name-label">файл</div>
            <div style="font-size:11px; color:var(--text-muted);" id="attachment-type-label">Готово</div>
          </div>
          <span class="attachment-cancel" onclick="cancelAttachment()">✕</span>
        </div>
        <div class="attachment-preview-container" id="audio-attachment-preview">
          <div class="attachment-info" style="flex:1;">
            <div class="attachment-name">🎤 Голосовое сообщение</div>
            <audio id="audio-preview-player" controls style="width:100%; margin-top:6px;"></audio>
          </div>
          <span class="attachment-cancel" onclick="cancelVoiceAttachment()">✕</span>
        </div>
        <div class="record-panel" id="record-panel">
          <div class="recording-indicator active" id="recording-indicator">
            <span class="recording-dot"></span>
            <span>Запись</span>
            <span id="recording-timer">0:00</span>
          </div>
          <span style="font-size:12px; color:var(--text-muted);">нажмите 🔴 для остановки</span>
        </div>
        <div class="input-bar" id="input-bar" style="display:none;">
          <button class="icon-btn" onclick="triggerFileInput()">📎</button>
          <input type="file" id="file-input" style="display:none;" onchange="handleFileSelect(event)">
          <button class="icon-btn" id="mic-btn" onclick="toggleVoiceRecord()">🎙️</button>
          <input type="text" id="msg-input" placeholder="Сообщение..." onkeydown="if(event.key==='Enter') sendMsg()">
          <button class="btn" id="send-btn" style="width:auto; padding:10px 18px; border-radius:20px;" onclick="sendMsg()">➤</button>
        </div>
      </div>
    </div>
  </div>
  
  <div class="modal-overlay" id="my-profile-modal">
    <div class="profile-card">
      <div class="profile-avatar-big" id="my-profile-avatar-view">
        <div class="online-indicator visible" style="width:16px; height:16px; bottom:2px; right:2px; border-color: var(--bg-sidebar);"></div>
      </div>
      <div class="profile-name" id="my-profile-name-view">Имя</div>
      <div class="profile-id" id="my-profile-id-view">ID</div>
      <div class="input-group" style="width:100%;">
        <input type="text" id="edit-my-name-input" placeholder="Ваше имя...">
      </div>
      <div class="profile-actions" style="align-items: center;">
        <button class="profile-link-btn" onclick="triggerAvatarInput()">Загрузить фото</button>
        <input type="file" id="avatar-file-input" style="display:none;" accept="image/*" onchange="handleAvatarSelect(event)">
        <button class="profile-link-btn" id="remove-avatar-link-btn" style="color:#e53935; display:none;" onclick="removeMyAvatar()">Удалить фото</button>
        <button class="btn" id="save-my-profile-btn" onclick="saveMyProfileChanges()">Сохранить</button>
        <button class="btn btn-secondary" onclick="closeMyProfile()">Закрыть</button>
      </div>
    </div>
  </div>
  <div class="modal-overlay" id="peer-profile-modal">
    <div class="profile-card">
      <div class="profile-avatar-big" id="peer-profile-avatar-view">
        <div class="online-indicator" id="peer-profile-indicator" style="width:16px; height:16px; bottom:2px; right:2px;"></div>
      </div>
      <div class="profile-name" id="peer-profile-name-view">Имя</div>
      <div class="profile-id" id="peer-profile-id-view">ID</div>
      <div class="profile-actions">
        <button class="btn btn-secondary" id="mute-peer-btn" onclick="toggleMutePeer()">Выключить звук</button>
        <button class="btn btn-secondary" id="block-peer-btn" onclick="toggleBlockPeer()">Заблокировать</button>
        <button class="btn btn-secondary" onclick="closePeerProfile()">Закрыть</button>
      </div>
    </div>
  </div>
  <div class="modal-overlay" id="create-group-modal">
    <div class="profile-card">
      <h3 style="margin-bottom:15px; color:var(--accent);">Новая группа</h3>
      <div class="profile-avatar-big" id="create-group-avatar"><span>👥</span></div>
      <button class="profile-link-btn" onclick="triggerGroupAvatarInput()">Загрузить фото</button>
      <input type="file" id="group-avatar-input" style="display:none;" accept="image/*" onchange="handleGroupAvatarSelect(event)">
      <div class="input-group" style="width:100%; margin-top:10px;">
        <input type="text" id="create-group-name" placeholder="Название...">
      </div>
      <div style="width:100%; text-align:left; font-size:13px; color:var(--text-muted); margin-bottom:8px;">Участники:</div>
      <div id="create-group-contacts" style="width:100%; max-height:200px; overflow-y:auto; margin-bottom:10px;"></div>
      <div class="profile-actions">
        <button class="btn" id="create-group-submit-btn" onclick="submitCreateGroup()">Создать</button>
        <button class="btn btn-secondary" onclick="closeCreateGroup()">Отмена</button>
      </div>
    </div>
  </div>
  <div class="modal-overlay" id="group-profile-modal">
    <div class="profile-card">
      <div class="profile-avatar-big" id="group-profile-avatar"></div>
      <div class="profile-name" id="group-profile-name">Группа</div>
      <div class="profile-id" id="group-profile-count">0 участников</div>
      <div id="group-owner-controls" style="width:100%; display:none; border-bottom:1px solid var(--border); padding-bottom:12px; margin-bottom:8px;">
        <div class="input-group" style="width:100%;">
          <input type="text" id="edit-group-name" placeholder="Название...">
        </div>
        <button class="profile-link-btn" onclick="triggerEditGroupAvatarInput()">Изменить фото</button>
        <input type="file" id="edit-group-avatar-input" style="display:none;" accept="image/*" onchange="handleEditGroupAvatarSelect(event)">
        <button class="btn" id="save-group-btn" onclick="saveGroupChanges()">Сохранить</button>
        <button class="btn btn-secondary" onclick="openAddMembers()">Добавить участников</button>
      </div>
      <div style="width:100%; text-align:left; font-size:13px; color:var(--text-muted); margin:6px 0 5px;">Участники:</div>
      <div id="group-members-list" style="width:100%; max-height:180px; overflow-y:auto; margin-bottom:10px;"></div>
      <div class="profile-actions">
        <button class="btn btn-danger" id="delete-group-btn" style="display:none;" onclick="deleteGroup()">Удалить группу</button>
        <button class="btn btn-danger" id="leave-group-btn" onclick="leaveGroup()">Покинуть</button>
        <button class="btn btn-secondary" onclick="closeGroupProfile()">Закрыть</button>
      </div>
    </div>
  </div>
  <div class="modal-overlay" id="add-members-modal">
    <div class="profile-card">
      <h3 style="margin-bottom:15px; color:var(--accent);">Добавить участников</h3>
      <div id="add-members-contacts" style="width:100%; max-height:250px; overflow-y:auto; margin-bottom:10px;"></div>
      <div class="profile-actions">
        <button class="btn" id="add-members-submit-btn" onclick="submitAddMembers()">Добавить</button>
        <button class="btn btn-secondary" onclick="closeAddMembers()">Отмена</button>
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
  <div id="audio-pool" style="display:none; position:absolute; width:0; height:0; overflow:hidden;"></div>
  <script src="/client.js"></script>
</body>
</html>`;

/* ==================== CLIENT JS ==================== */

const CLIENT_JS = `
/* ============================================================
   Соединение с сервером обязательно. Хранилище — IndexedDB.
   ============================================================ */

var appDB = null;
var messagesCache = {};
var usersCache = {};
var groupsCache = {};
var tombstonesCache = {};
var metaCache = {};
var currentUser = null;
var activePeer = null;
var mutedPeers = [];
var fileUrlCache = new Map();

var syncState = {
  pendingEvents: [],
  pendingTombstones: [],
  isPushing: false,
  isPulling: false
};

// Состояние соединения
var connectionState = 'checking'; // 'checking' | 'online' | 'server-offline' | 'no-internet'

var savedTheme = localStorage.getItem('app_theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);

var selectedFile = null;
var pendingVoice = null;
var audioChunks = [];
var isRecording = false;
var activeStream = null;
var recordStartedAt = 0;
var recordingTimerInterval = null;
var recordAudioCtx = null, recordSourceNode = null, recordProcessor = null, recordSilentGain = null;
var selectedMsgId = null;
var selectedMsgObj = null;
var longTouchTimer = null;
var groupDraftAvatar = '';
var editGroupDraftAvatar = '';
var draftAvatar = null;
var activeMemberDropdown = null;
var profileTargetId = null;
var isUploading = false;
var busyButtons = {};
var CHUNK_SIZE = 500 * 1024;
var MAX_FILE_SIZE = 200 * 1024 * 1024;
var statusBarTimeout = null;

/* ==================== INDEXEDDB ==================== */

function openAppDB() {
  return new Promise(function (resolve, reject) {
    if (appDB) return resolve(appDB);
    if (!window.indexedDB) return reject(new Error('No IndexedDB'));
    var req = indexedDB.open('messenger_v4', 1);
    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('messages')) {
        var ms = db.createObjectStore('messages', { keyPath: 'id' });
        ms.createIndex('by_ts', 'ts');
        ms.createIndex('by_group', 'groupId');
      }
      if (!db.objectStoreNames.contains('groups')) db.createObjectStore('groups', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('users')) db.createObjectStore('users', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('tombstones')) db.createObjectStore('tombstones', { keyPath: 'key' });
    };
    req.onsuccess = function (e) { appDB = e.target.result; resolve(appDB); };
    req.onerror = function (e) { reject(e.target.error); };
  });
}

async function dbPut(store, value) {
  var db = await openAppDB();
  return new Promise(function (res, rej) {
    var tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = function () { res(true); };
    tx.onerror = function (e) { rej(e.target.error); };
  });
}
async function dbGet(store, key) {
  var db = await openAppDB();
  return new Promise(function (res, rej) {
    var tx = db.transaction(store, 'readonly');
    var r = tx.objectStore(store).get(key);
    r.onsuccess = function () { res(r.result || null); };
    r.onerror = function (e) { rej(e.target.error); };
  });
}
async function dbDelete(store, key) {
  var db = await openAppDB();
  return new Promise(function (res, rej) {
    var tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = function () { res(true); };
    tx.onerror = function (e) { rej(e.target.error); };
  });
}
async function dbGetAll(store) {
  var db = await openAppDB();
  return new Promise(function (res, rej) {
    var tx = db.transaction(store, 'readonly');
    var r = tx.objectStore(store).getAll();
    r.onsuccess = function () { res(r.result || []); };
    r.onerror = function (e) { rej(e.target.error); };
  });
}

async function loadAllFromDB() {
  var msgs = await dbGetAll('messages');
  msgs.forEach(m => { messagesCache[m.id] = m; });
  var users = await dbGetAll('users');
  users.forEach(u => { usersCache[u.id] = u; });
  var groups = await dbGetAll('groups');
  groups.forEach(g => { groupsCache[g.id] = g; });
  var tombs = await dbGetAll('tombstones');
  tombs.forEach(t => { tombstonesCache[t.key] = t; });
  var meta = await dbGetAll('meta');
  meta.forEach(m => { metaCache[m.key] = m.value; });
  currentUser = metaCache['profile'] || null;
  mutedPeers = metaCache['mutedPeers'] || [];
}

async function setMeta(key, value) {
  metaCache[key] = value;
  await dbPut('meta', { key, value });
}
function getMeta(key) { return metaCache[key]; }

/* ==================== CONNECTION ==================== */

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
    // Если только что восстановилось — показать зелёную плашку на 2 сек
    if (bar.dataset.wasOffline === '1') {
      bar.innerText = '✓ Подключено';
      bar.className = 'visible reconnected';
      statusBarTimeout = setTimeout(function () {
        bar.classList.remove('visible');
        bar.dataset.wasOffline = '0';
      }, 2000);
    }
  } else if (connectionState === 'no-internet') {
    bar.innerText = '⚠ Нет подключения к интернету';
    bar.className = 'visible internet-off';
    bar.dataset.wasOffline = '1';
  } else if (connectionState === 'server-offline') {
    bar.innerText = '⌛ Соединение...';
    bar.className = 'visible server-off';
    bar.dataset.wasOffline = '1';
  }
}

function updateLoadingScreen() {
  var ls = document.getElementById('loading-screen');
  var title = document.getElementById('loading-title');
  var text = document.getElementById('loading-text');
  if (!ls) return;
  // Показываем экран загрузки только если ещё не залогинились и связи нет
  if (currentUser) { ls.classList.remove('active'); return; }
  if (connectionState === 'online') {
    ls.classList.remove('active');
  } else if (connectionState === 'no-internet') {
    ls.classList.add('active');
    title.innerText = 'Нет подключения к интернету';
    text.innerText = 'Проверьте соединение с интернетом';
  } else if (connectionState === 'server-offline') {
    ls.classList.add('active');
    title.innerText = 'Соединение...';
    text.innerText = 'Подключаемся к серверу';
  } else {
    ls.classList.add('active');
    title.innerText = 'Подключение';
    text.innerText = 'Проверяем соединение';
  }
}

async function checkServerHealth() {
  // 1. Есть ли вообще интернет?
  if (!navigator.onLine) {
    setConnectionState('no-internet');
    return false;
  }
  // 2. Отвечает ли сервер?
  try {
    var ctrl = new AbortController();
    var tm = setTimeout(function () { ctrl.abort(); }, 5000);
    var res = await fetch('/api/health?_=' + Date.now(), { signal: ctrl.signal });
    clearTimeout(tm);
    if (res.ok) {
      setConnectionState('online');
      return true;
    }
    setConnectionState('server-offline');
    return false;
  } catch (e) {
    // Отличить internet-off от server-off
    if (!navigator.onLine) setConnectionState('no-internet');
    else setConnectionState('server-offline');
    return false;
  }
}

window.addEventListener('online', async function () {
  var ok = await checkServerHealth();
  if (ok) {
    pushToServer();
    pullFromServer();
  }
});
window.addEventListener('offline', function () {
  setConnectionState('no-internet');
});

/* ==================== UTILS ==================== */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function formatBytes(b) {
  if (!b || b < 1024) return (b || 0) + ' Б';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' КБ';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' МБ';
  return (b / (1024 * 1024 * 1024)).toFixed(1) + ' ГБ';
}
function updateThemeIcon(t) {
  var b = document.getElementById('theme-toggle-btn');
  if (b) b.innerText = t === 'dark' ? '🌙' : '☀️';
}
function toggleTheme() {
  var c = document.documentElement.getAttribute('data-theme');
  var n = c === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', n);
  localStorage.setItem('app_theme', n);
  updateThemeIcon(n);
}
function playNotificationSound() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08);
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.3);
  } catch (e) {}
}
function lockButton(id, ms) {
  ms = ms || 1500;
  var el = document.getElementById(id);
  if (!el) return false;
  if (busyButtons[id]) return false;
  busyButtons[id] = true;
  el.disabled = true;
  el.style.opacity = '0.5';
  setTimeout(function () {
    busyButtons[id] = false;
    el.disabled = false;
    el.style.opacity = '';
  }, ms);
  return true;
}
function isModalOpen(id) {
  var el = document.getElementById(id);
  return !!(el && el.classList.contains('active'));
}
function safeOpenModal(id) {
  if (isModalOpen(id)) return false;
  document.getElementById(id).classList.add('active');
  return true;
}
function safeCloseModal(id) {
  var el = document.getElementById(id);
  if (el) el.classList.remove('active');
}

/* ==================== AVATARS ==================== */

function renderAvatarIntoElement(el, userObj, isOnline) {
  if (!el) return;
  var rk = (userObj && userObj.id ? userObj.id : '') + '|' +
           (userObj && userObj.avatar ? String(userObj.avatar).substring(0, 30) : '') + '|' +
           (userObj && userObj.name ? userObj.name : '');
  if (el.dataset.renderKey === rk) {
    var ind = el.querySelector('.online-indicator');
    if (ind) {
      if (isOnline) ind.classList.add('visible');
      else ind.classList.remove('visible');
    }
    return;
  }
  el.dataset.renderKey = rk;
  var indicator = el.querySelector('.online-indicator');
  Array.from(el.childNodes).forEach(function (node) {
    if (node !== indicator) el.removeChild(node);
  });
  var src = userObj && userObj.avatar;
  if (src) {
    var img = document.createElement('img');
    img.src = src;
    img.onerror = function () {
      this.remove();
      var s = document.createElement('span');
      s.innerText = ((userObj && userObj.name) ? userObj.name.charAt(0).toUpperCase() : '?');
      if (indicator) el.insertBefore(s, indicator); else el.appendChild(s);
    };
    if (indicator) el.insertBefore(img, indicator); else el.appendChild(img);
  } else {
    var s2 = document.createElement('span');
    s2.innerText = (userObj && userObj.name ? userObj.name.charAt(0).toUpperCase() : '?');
    if (indicator) el.insertBefore(s2, indicator); else el.appendChild(s2);
  }
  if (indicator) {
    if (isOnline) indicator.classList.add('visible');
    else indicator.classList.remove('visible');
  }
}

/* ==================== FILES ==================== */

async function saveFileToIDB(key, blob, meta) {
  await dbPut('files', {
    key: key, blob: blob,
    fileName: (meta && meta.fileName) || '',
    fileType: (meta && meta.fileType) || '',
    fileSize: (meta && meta.fileSize) || blob.size
  });
}
async function getFileFromIDB(key) { return await dbGet('files', key); }
async function deleteFileFromIDB(key) { try { await dbDelete('files', key); } catch (e) {} }

async function downloadAndCacheFile(msg) {
  if (!msg.fileUrl) return false;
  var ex = await getFileFromIDB(msg.id);
  if (ex) return true;
  try {
    var res = await fetch(msg.fileUrl);
    if (!res.ok) return false;
    var blob = await res.blob();
    await saveFileToIDB(msg.id, blob, { fileName: msg.fileName, fileType: msg.fileType, fileSize: blob.size });
    return true;
  } catch (e) { return false; }
}

async function getFileUrlForMessage(msg) {
  if (fileUrlCache.has(msg.id)) return fileUrlCache.get(msg.id);
  var entry = await getFileFromIDB(msg.id);
  if (entry && entry.blob) {
    var url = URL.createObjectURL(entry.blob);
    fileUrlCache.set(msg.id, url);
    return url;
  }
  return msg.fileUrl || null;
}

/* ==================== TOMBSTONES ==================== */

async function markDeleted(type, id, extra) {
  var key = type + ':' + id;
  if (tombstonesCache[key]) return;
  var tomb = { type: type, id: id, at: Date.now(), fromUser: currentUser.id };
  if (extra) Object.assign(tomb, extra);
  tombstonesCache[key] = tomb;
  await dbPut('tombstones', { key: key, ...tomb });
  await applyDeleteLocally(type, id, extra);
  syncState.pendingTombstones.push(tomb);
  pushToServer();
}

async function applyDeleteLocally(type, id, extra) {
  if (type === 'message') {
    var m = messagesCache[id];
    if (m) { m.isDeleted = true; await dbPut('messages', m); }
    await deleteFileFromIDB(id);
    if (fileUrlCache.has(id)) {
      try { URL.revokeObjectURL(fileUrlCache.get(id)); } catch (e) {}
      fileUrlCache.delete(id);
    }
  } else if (type === 'group') {
    delete groupsCache[id];
    await dbDelete('groups', id);
  } else if (type === 'file') {
    await deleteFileFromIDB(id);
    if (fileUrlCache.has(id)) {
      try { URL.revokeObjectURL(fileUrlCache.get(id)); } catch (e) {}
      fileUrlCache.delete(id);
    }
  } else if (type === 'group_kick') {
    if (extra && extra.memberId === currentUser.id) {
      delete groupsCache[extra.groupId];
      await dbDelete('groups', extra.groupId);
    } else if (extra && extra.groupId && groupsCache[extra.groupId]) {
      var g = groupsCache[extra.groupId];
      g.members = extra.members || g.members;
      await dbPut('groups', g);
    }
  } else if (type === 'chat_hide') {
    if (extra && extra.userId === currentUser.id) {
      if (!currentUser.hiddenDialogs) currentUser.hiddenDialogs = [];
      if (currentUser.hiddenDialogs.indexOf(extra.peerId) === -1) {
        currentUser.hiddenDialogs.push(extra.peerId);
        await setMeta('profile', currentUser);
      }
    }
  }
}

/* ==================== SYNC ==================== */

function getMyGroupsSummary() {
  var arr = [];
  for (var id in groupsCache) {
    var g = groupsCache[id];
    if (g.isDeleted) continue;
    if (g.members.indexOf(currentUser.id) === -1) continue;
    arr.push({ id: g.id, members: g.members });
  }
  return arr;
}

function scheduleEvent(ev) {
  if (!ev.id) ev.id = ev.payload && ev.payload.id;
  syncState.pendingEvents.push(ev);
  pushToServer();
}

async function pushToServer() {
  if (!currentUser) return;
  if (connectionState !== 'online') return;
  if (syncState.isPushing) return;
  if (syncState.pendingEvents.length === 0 && syncState.pendingTombstones.length === 0) return;
  syncState.isPushing = true;
  try {
    var evBatch = syncState.pendingEvents.slice(0, 300);
    var tbBatch = syncState.pendingTombstones.slice(0, 300);
    var res = await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        senderId: currentUser.id,
        name: currentUser.name,
        avatar: currentUser.avatar || '',
        profile: { id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar || '' },
        events: evBatch,
        tombstones: tbBatch
      })
    });
    if (res.ok) {
      syncState.pendingEvents = syncState.pendingEvents.slice(evBatch.length);
      syncState.pendingTombstones = syncState.pendingTombstones.slice(tbBatch.length);
    }
  } catch (e) {
    setConnectionState(navigator.onLine ? 'server-offline' : 'no-internet');
  }
  syncState.isPushing = false;
}

async function pullFromServer() {
  if (!currentUser) return;
  if (connectionState !== 'online') return;
  if (syncState.isPulling) return;
  syncState.isPulling = true;
  try {
    var knownTombKeys = Object.keys(tombstonesCache);
    var res = await fetch('/api/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentUser.id,
        name: currentUser.name,
        avatar: currentUser.avatar || '',
        contacts: currentUser.contacts || [],
        groups: getMyGroupsSummary(),
        knownTombstones: knownTombKeys
      })
    });
    var data = await res.json();
    if (!data.success) { syncState.isPulling = false; return; }
    var hasUpdates = false;
    if (Array.isArray(data.tombstones)) {
      for (var ti = 0; ti < data.tombstones.length; ti++) {
        var t = data.tombstones[ti];
        var key = t.type + ':' + t.id;
        if (!tombstonesCache[key]) {
          tombstonesCache[key] = t;
          await dbPut('tombstones', { key: key, ...t });
          await applyDeleteLocally(t.type, t.id, t);
          hasUpdates = true;
        }
      }
    }
    for (var i = 0; i < data.events.length; i++) {
      var applied = await applyRemoteEvent(data.events[i]);
      if (applied) hasUpdates = true;
    }
    if (Array.isArray(data.online)) {
      var set = new Set(data.online);
      for (var uid in usersCache) usersCache[uid].isOnline = set.has(uid);
      hasUpdates = true;
    }
    if (hasUpdates) refreshUI();
  } catch (e) {
    setConnectionState(navigator.onLine ? 'server-offline' : 'no-internet');
  }
  syncState.isPulling = false;
}

async function applyRemoteEvent(ev) {
  if (!ev || !ev.type) return false;
  if (ev.id) {
    if (ev.type === 'message' && tombstonesCache['message:' + ev.id]) return false;
    if (ev.type === 'group' && tombstonesCache['group:' + ev.id]) return false;
    if (ev.type === 'group_update' && tombstonesCache['group:' + ev.id]) return false;
    if (ev.type === 'file' && tombstonesCache['file:' + ev.id]) return false;
  }
  if (ev.type === 'message') {
    if (messagesCache[ev.id]) return false;
    messagesCache[ev.id] = ev;
    await dbPut('messages', ev);
    if (ev.fileUrl) downloadAndCacheFile(ev).catch(function () {});
    if (activePeer && ev.senderId !== currentUser.id && mutedPeers.indexOf(activePeer.id) === -1) {
      var isForThis = (ev.groupId && activePeer.id === ev.groupId) ||
                      (!ev.groupId && (ev.senderId === activePeer.id || ev.receiverId === activePeer.id));
      if (isForThis) playNotificationSound();
    }
    return true;
  } else if (ev.type === 'group') {
    if (groupsCache[ev.id]) return false;
    groupsCache[ev.id] = ev;
    await dbPut('groups', ev);
    return true;
  } else if (ev.type === 'group_update') {
    var g = groupsCache[ev.id];
    if (!g) {
      if (ev.members && ev.members.indexOf(currentUser.id) === -1) return false;
      groupsCache[ev.id] = ev;
      await dbPut('groups', ev);
      return true;
    }
    g.name = ev.name || g.name;
    if (ev.avatar !== undefined) g.avatar = ev.avatar;
    if (ev.members) g.members = ev.members;
    if (ev.ownerId) g.ownerId = ev.ownerId;
    await dbPut('groups', g);
    return true;
  } else if (ev.type === 'message_read') {
    var m = messagesCache[ev.id];
    if (m) {
      if (m.groupId) {
        if (!m.readBy) m.readBy = [];
        if (m.readBy.indexOf(ev.readerId) === -1) {
          m.readBy.push(ev.readerId);
          await dbPut('messages', m);
          return true;
        }
      } else if (!m.isRead) {
        m.isRead = true;
        await dbPut('messages', m);
        return true;
      }
    }
  } else if (ev.type === 'group_kick') {
    if (ev.memberId === currentUser.id) {
      await markDeleted('group', ev.groupId);
      return true;
    }
    var gk = groupsCache[ev.groupId];
    if (gk && ev.members) {
      gk.members = ev.members;
      await dbPut('groups', gk);
      return true;
    }
  } else if (ev.type === 'profile') {
    if (!ev.id || ev.id === currentUser.id) return false;
    var u = usersCache[ev.id];
    if (!u || (ev.updatedAt || 0) > (u.updatedAt || 0)) {
      usersCache[ev.id] = ev;
      await dbPut('users', ev);
      return true;
    }
  } else if (ev.type === 'sync_request' && ev.toUserId === currentUser.id) {
    await respondToSyncRequest(ev.fromUserId, ev.scope);
  } else if (ev.type === 'sync_response' && ev.toUserId === currentUser.id) {
    await applySyncResponse(ev.data);
    return true;
  } else if (ev.type === 'file_request' && ev.toUserId === currentUser.id) {
    await respondWithFile(ev.fileId, ev.fromUserId);
  }
  return false;
}

async function respondToSyncRequest(toUserId, scope) {
  var messages = [], groups = [], users = [], tombs = [];
  for (var id in messagesCache) {
    var m = messagesCache[id];
    if (m.isDeleted) continue;
    if (scope === 'all' ||
        (scope.indexOf('chat:') === 0 && (m.senderId === toUserId || m.receiverId === toUserId)) ||
        (scope.indexOf('group:') === 0 && m.groupId === scope.substring(6))) {
      messages.push(m);
    }
  }
  for (var gid in groupsCache) {
    var g = groupsCache[gid];
    if (g.isDeleted) continue;
    if (g.members.indexOf(toUserId) !== -1) groups.push(g);
  }
  for (var uid in usersCache) users.push(usersCache[uid]);
  for (var k in tombstonesCache) tombs.push(tombstonesCache[k]);
  var chunkSize = 500;
  var chunks = [];
  for (var i = 0; i < messages.length; i += chunkSize) chunks.push(messages.slice(i, i + chunkSize));
  if (chunks.length === 0) chunks.push([]);
  for (var ci = 0; ci < chunks.length; ci++) {
    await fetch('/api/respond-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromUserId: currentUser.id,
        toUserId: toUserId,
        chunkIndex: ci,
        totalChunks: chunks.length,
        data: {
          messages: chunks[ci],
          groups: ci === 0 ? groups : [],
          users: ci === 0 ? users : [],
          tombstones: ci === 0 ? tombs : []
        }
      })
    }).catch(function () {});
  }
}

async function applySyncResponse(data) {
  if (!data) return;
  (data.messages || []).forEach(async function (m) {
    if (tombstonesCache['message:' + m.id]) return;
    if (!messagesCache[m.id]) {
      messagesCache[m.id] = m;
      await dbPut('messages', m);
      if (m.fileUrl) downloadAndCacheFile(m).catch(function () {});
    }
  });
  (data.groups || []).forEach(async function (g) {
    if (tombstonesCache['group:' + g.id]) return;
    if (!groupsCache[g.id]) { groupsCache[g.id] = g; await dbPut('groups', g); }
  });
  (data.users || []).forEach(async function (u) {
    if (!usersCache[u.id] || (u.updatedAt || 0) > (usersCache[u.id].updatedAt || 0)) {
      usersCache[u.id] = u;
      await dbPut('users', u);
    }
  });
  (data.tombstones || []).forEach(async function (t) {
    var key = t.type + ':' + t.id;
    if (!tombstonesCache[key]) {
      tombstonesCache[key] = t;
      await dbPut('tombstones', { key: key, ...t });
      await applyDeleteLocally(t.type, t.id, t);
    }
  });
}

async function respondWithFile(fileId, toUserId) {
  var entry = await getFileFromIDB(fileId);
  if (!entry || !entry.blob) return;
  try {
    var file = new File([entry.blob], entry.fileName || 'file', { type: entry.fileType || 'application/octet-stream' });
    var fileUrl = await uploadFileInChunks(file);
    scheduleEvent({
      type: 'file', id: fileId,
      fileName: entry.fileName, fileType: entry.fileType,
      fileSize: entry.fileSize, fileUrl: fileUrl, ownerId: currentUser.id
    });
  } catch (e) {}
}

/* ==================== SYNC LOOP ==================== */

function startSyncLoop() {
  // Проверка здоровья сервера
  setInterval(async function () {
    if (!currentUser) return;
    var wasOnline = connectionState === 'online';
    var ok = await checkServerHealth();
    if (ok) {
      if (!wasOnline) {
        // Только что подключились — пушим и тянем
        pushToServer();
        pullFromServer();
      }
    }
  }, 4000);
  
  // Пинг + пуш + пул
  setInterval(async function () {
    if (!currentUser) return;
    if (connectionState !== 'online') return;
    try {
      await fetch('/api/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar || '' })
      });
    } catch (e) {}
    await pushToServer();
    await pullFromServer();
  }, 2000);
}

/* ==================== REGISTER (только через сервер) ==================== */

async function registerUser() {
  if (busyButtons['login-btn']) return;
  var name = document.getElementById('auth-name').value.trim();
  var errBox = document.getElementById('auth-error');
  if (!name) { errBox.innerText = 'Введите имя'; errBox.style.display = 'block'; return; }
  
  // Проверяем соединение с сервером
  if (connectionState !== 'online') {
    errBox.innerText = connectionState === 'no-internet'
      ? 'Нет подключения к интернету'
      : 'Нет соединения с сервером';
    errBox.style.display = 'block';
    // Запускаем проверку чаще
    checkServerHealth();
    return;
  }
  
  if (!lockButton('login-btn', 5000)) return;
  try {
    var res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name })
    });
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      errBox.innerText = err.error || 'Ошибка регистрации';
      errBox.style.display = 'block';
      return;
    }
    var data = await res.json();
    if (!data.success) {
      errBox.innerText = data.error || 'Ошибка';
      errBox.style.display = 'block';
      return;
    }
    // Профиль подтверждён сервером
    currentUser = {
      id: data.user.id,
      name: data.user.name,
      avatar: data.user.avatar || '',
      contacts: [],
      blockedContacts: [],
      hiddenDialogs: [],
      updatedAt: data.user.updatedAt || Date.now()
    };
    metaCache['profile'] = currentUser;
    await dbPut('meta', { key: 'profile', value: currentUser });
    await dbPut('users', currentUser);
    startApp();
  } catch (e) {
    errBox.innerText = 'Сервер недоступен';
    errBox.style.display = 'block';
    setConnectionState(navigator.onLine ? 'server-offline' : 'no-internet');
  }
}

async function startApp() {
  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('active');
  updateMyProfileUI();
  refreshUI();
  startSyncLoop();
  
  // Запрос синхронизации у контактов
  setTimeout(function () {
    if (currentUser && currentUser.contacts && currentUser.contacts.length > 0 && connectionState === 'online') {
      currentUser.contacts.forEach(function (cid) {
        fetch('/api/request-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromUserId: currentUser.id, toUserId: cid, scope: 'all' })
        }).catch(function () {});
      });
    }
  }, 2000);
}

function updateMyProfileUI() {
  if (!currentUser) return;
  document.getElementById('my-display-name').innerText = currentUser.name;
  document.getElementById('my-display-id').innerText = 'ID: ' + currentUser.id;
  renderAvatarIntoElement(document.getElementById('my-avatar-circle'), currentUser, true);
}

/* ==================== UI ==================== */

function refreshUI() {
  if (!currentUser) return;
  renderChatListFromCache();
  if (activePeer) renderMessagesContainer(getChatMessages(activePeer));
}

function renderChatListFromCache() {
  if (!currentUser) return;
  var list = [];
  var peerIds = new Set();
  var hidden = new Set(currentUser.hiddenDialogs || []);
  (currentUser.contacts || []).forEach(function (c) { peerIds.add(c); });
  for (var mid in messagesCache) {
    var m = messagesCache[mid];
    if (m.isDeleted || m.groupId) continue;
    if (m.senderId === currentUser.id) peerIds.add(m.receiverId);
    if (m.receiverId === currentUser.id) peerIds.add(m.senderId);
  }
  peerIds.forEach(function (pid) {
    if (pid === currentUser.id || !pid) return;
    if (hidden.has(pid)) return;
    var u = usersCache[pid] || { id: pid, name: 'Пользователь', avatar: '' };
    var lastTs = 0;
    for (var m2id in messagesCache) {
      var m2 = messagesCache[m2id];
      if (m2.isDeleted) continue;
      if ((m2.senderId === pid && m2.receiverId === currentUser.id) ||
          (m2.senderId === currentUser.id && m2.receiverId === pid)) {
        lastTs = Math.max(lastTs, m2.ts || 0);
      }
    }
    list.push({ id: pid, type: 'user', name: u.name, avatar: u.avatar, isOnline: u.isOnline, lastTs });
  });
  for (var gid in groupsCache) {
    var g = groupsCache[gid];
    if (g.isDeleted) continue;
    if (g.members.indexOf(currentUser.id) === -1) continue;
    var glastTs = 0;
    for (var m3id in messagesCache) {
      var m3 = messagesCache[m3id];
      if (m3.isDeleted || m3.groupId !== gid) continue;
      glastTs = Math.max(glastTs, m3.ts || 0);
    }
    list.push({
      id: g.id, type: 'group', name: g.name, avatar: g.avatar,
      members: g.members, ownerId: g.ownerId, memberCount: g.members.length, lastTs: glastTs
    });
  }
  list.sort(function (a, b) { return (b.lastTs || 0) - (a.lastTs || 0); });
  renderChatList(list);
}

function renderChatList(list) {
  var container = document.getElementById('chat-list');
  var currentActiveId = activePeer ? activePeer.id : null;
  var currentActiveType = activePeer ? (activePeer.type || 'user') : null;
  container.innerHTML = '';
  if (!list || list.length === 0) {
    container.innerHTML = '<div style="padding:15px; color:var(--text-muted); font-size:12px; text-align:center;">Пусто</div>';
    return;
  }
  list.forEach(function (item) {
    var isGroup = item.type === 'group';
    var div = document.createElement('div');
    var isActive = currentActiveId === item.id && currentActiveType === (item.type || 'user');
    div.className = 'chat-item ' + (isActive ? 'active' : '');
    div.onclick = function () { openChat(item); };
    var avatarId = 'chat_av_' + (isGroup ? 'grp_' : 'usr_') + item.id.replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + Math.random().toString(36).substr(2, 4);
    var subtitle;
    if (isGroup) subtitle = '<span style="color:var(--text-muted);">👥 ' + (item.memberCount || 0) + '</span>';
    else subtitle = item.isOnline ? '<span style="color:#4cd964;">в сети</span>' : '<span style="color:var(--text-muted);">не в сети</span>';
    div.innerHTML =
      '<div class="avatar-circle" id="' + avatarId + '">' +
        (isGroup ? '' : '<div class="online-indicator ' + (item.isOnline ? 'visible' : '') + '"></div>') +
      '</div>' +
      '<div style="overflow:hidden; flex:1;">' +
        '<div style="font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + escapeHtml(item.name) + '</div>' +
        '<div style="font-size:11px;">' + subtitle + '</div>' +
      '</div>';
    container.appendChild(div);
    renderAvatarIntoElement(document.getElementById(avatarId), { id: item.id, avatar: item.avatar, name: item.name }, item.isOnline || false);
  });
}

function getChatMessages(chat) {
  if (!chat || !currentUser) return [];
  var list = [];
  for (var id in messagesCache) {
    var m = messagesCache[id];
    if (m.isDeleted) continue;
    if (chat.type === 'group') {
      if (m.groupId === chat.id) list.push(m);
    } else {
      if (!m.groupId &&
          ((m.senderId === currentUser.id && m.receiverId === chat.id) ||
           (m.senderId === chat.id && m.receiverId === currentUser.id))) list.push(m);
    }
  }
  return list.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
}

function renderMessagesContainer(messages) {
  var container = document.getElementById('messages-container');
  var isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 80;
  container.innerHTML = '';
  if (!messages || messages.length === 0) {
    container.innerHTML = '<div class="empty-state">Нет сообщений</div>';
    return;
  }
  var isGroup = activePeer && activePeer.type === 'group';
  messages.forEach(function (m) {
    var div = document.createElement('div');
    div.className = 'msg ' + (m.senderId === currentUser.id ? 'my' : '');
    div.setAttribute('data-msg-id', m.id);
    div.setAttribute('data-sender-id', m.senderId);
    div.oncontextmenu = function (e) {
      if (e.target.tagName === 'AUDIO' || e.target.tagName === 'VIDEO' || (e.target.closest && (e.target.closest('audio') || e.target.closest('video')))) return;
      e.preventDefault(); openMsgActions(m, div);
    };
    div.ontouchstart = function (e) {
      if (e.target.tagName === 'AUDIO' || e.target.tagName === 'VIDEO' || (e.target.closest && (e.target.closest('audio') || e.target.closest('video')))) return;
      longTouchTimer = setTimeout(function () { openMsgActions(m, div); }, 500);
    };
    div.ontouchend = function () { clearTimeout(longTouchTimer); };
    div.ontouchmove = function () { clearTimeout(longTouchTimer); };
    var html = '';
    if (isGroup && m.senderId !== currentUser.id) {
      var uname = usersCache[m.senderId] ? usersCache[m.senderId].name : 'Пользователь';
      html += '<div class="msg-sender">' + escapeHtml(uname) + '</div>';
    }
    if (m.text) html += '<div>' + escapeHtml(m.text) + '</div>';
    var ft = m.fileType || '';
    if (m.fileData) {
      if (ft.indexOf('image/') === 0) html += '<img src="' + m.fileData + '" class="media-preview" data-full="1">';
      else if (ft.indexOf('video/') === 0) html += '<video src="' + m.fileData + '" controls class="video-preview"></video>';
      else if (ft.indexOf('audio/') === 0) html += '<audio src="' + m.fileData + '" controls class="audio-preview"></audio>';
      else html += '<a class="file-link" href="' + m.fileData + '" download="' + escapeHtml(m.fileName || 'file') + '">📁 ' + escapeHtml(m.fileName || 'Файл') + '</a>';
    } else if (m.fileUrl) {
      html += '<div data-file-url-msg-id="' + m.id + '"></div>';
    }
    var ticks = '';
    if (m.senderId === currentUser.id) {
      var read = m.isRead;
      if (isGroup && activePeer && activePeer.members) {
        var others = activePeer.members.filter(function (x) { return x !== currentUser.id; });
        var rb = (m.readBy || []).filter(function (x) { return x !== currentUser.id; });
        read = others.length > 0 && rb.length >= others.length;
      }
      ticks = '<span class="ticks' + (read ? ' read' : '') + '">' + (read ? '✓✓' : '✓') + '</span>';
    }
    html += '<div class="msg-footer"><span>' + escapeHtml(m.timestamp || '') + '</span>' + ticks + '</div>';
    div.innerHTML = html;
    var placeholder = div.querySelector('[data-file-url-msg-id]');
    if (placeholder) loadFileIntoElement(m, placeholder);
    var imgEl = div.querySelector('img[data-full]');
    if (imgEl) imgEl.addEventListener('click', function (e) { e.stopPropagation(); openImageViewer(imgEl.src); });
    container.appendChild(div);
  });
  if (isAtBottom) container.scrollTop = container.scrollHeight;
}

async function loadFileIntoElement(msg, placeholder) {
  var entry = await getFileFromIDB(msg.id);
  if (entry && entry.blob) {
    var url = URL.createObjectURL(entry.blob);
    fileUrlCache.set(msg.id, url);
    renderFileElement(placeholder, msg, url);
    return;
  }
  var ok = false;
  try { var head = await fetch(msg.fileUrl, { method: 'HEAD' }); ok = head.ok; } catch (e) {}
  if (ok) {
    renderFileElement(placeholder, msg, msg.fileUrl);
    downloadAndCacheFile(msg).then(function (saved) {
      if (saved) {
        getFileUrlForMessage(msg).then(function (newUrl) {
          if (newUrl && newUrl !== msg.fileUrl) renderFileElement(placeholder, msg, newUrl);
        });
      }
    });
  } else {
    placeholder.outerHTML = '<div class="file-placeholder">⚠️ Файл недоступен</div>';
  }
}

function renderFileElement(placeholder, msg, url) {
  var ft = msg.fileType || '';
  var html = '';
  if (ft.indexOf('image/') === 0) html = '<img src="' + url + '" class="media-preview" data-full="1">';
  else if (ft.indexOf('video/') === 0) html = '<video src="' + url + '" controls class="video-preview" preload="metadata"></video>';
  else if (ft.indexOf('audio/') === 0) html = '<audio src="' + url + '" controls class="audio-preview" preload="metadata"></audio>';
  else html = '<a class="file-link" href="' + url + '" download="' + escapeHtml(msg.fileName || 'file') + '">📁 ' + escapeHtml(msg.fileName || 'Файл') + (msg.fileSize ? ' (' + formatBytes(msg.fileSize) + ')' : '') + '</a>';
  var wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  var newEl = wrapper.firstChild;
  newEl.addEventListener('click', function (e) { e.stopPropagation(); });
  placeholder.parentNode.replaceChild(newEl, placeholder);
  if (newEl.tagName === 'IMG') newEl.addEventListener('click', function (e) { e.stopPropagation(); openImageViewer(newEl.src); });
}

/* ==================== OPEN CHAT ==================== */

function openChat(peer) {
  if (!peer.type) peer.type = 'user';
  activePeer = peer;
  document.getElementById('active-peer-name').innerText = peer.name;
  var statusEl = document.getElementById('active-peer-status');
  if (peer.type === 'group') {
    statusEl.innerText = (peer.memberCount || 0) + ' участников';
    statusEl.style.color = 'var(--text-muted)';
  } else {
    if (peer.isOnline) { statusEl.innerText = 'в сети'; statusEl.style.color = '#4cd964'; }
    else { statusEl.innerText = 'не в сети'; statusEl.style.color = 'var(--text-muted)'; }
    if (!currentUser.contacts) currentUser.contacts = [];
    if (currentUser.contacts.indexOf(peer.id) === -1) {
      currentUser.contacts.push(peer.id);
      setMeta('profile', currentUser);
    }
  }
  renderAvatarIntoElement(document.getElementById('peer-avatar-circle'), { id: peer.id, avatar: peer.avatar, name: peer.name }, peer.isOnline || false);
  document.getElementById('input-bar').style.display = 'flex';
  updateChatMenu();
  document.querySelectorAll('.chat-item').forEach(function (el) { el.classList.remove('active'); });
  if (window.innerWidth <= 600) {
    document.getElementById('app-screen').classList.add('app-mobile-chat');
    document.getElementById('back-to-list-btn').style.display = 'block';
  }
  renderMessagesContainer(getChatMessages(peer));
  checkVisibleMessages();
}

function closeMobileChat() {
  document.getElementById('app-screen').classList.remove('app-mobile-chat');
}

function resetActiveChat() {
  activePeer = null;
  document.getElementById('input-bar').style.display = 'none';
  document.getElementById('active-peer-name').innerText = 'Выберите чат';
  document.getElementById('active-peer-status').innerText = 'нажмите для профиля';
  document.getElementById('messages-container').innerHTML = '<div class="empty-state">Выберите диалог</div>';
  closeMobileChat();
}

function updateChatMenu() {
  var menu = document.getElementById('chat-dropdown-menu');
  if (activePeer && activePeer.type === 'group') {
    menu.innerHTML =
      '<button class="menu-item" onclick="openGroupProfile()">Профиль группы</button>' +
      '<button class="menu-item" onclick="clearChatHistory()">Очистить историю</button>' +
      '<button class="menu-item danger" onclick="leaveGroup()">Покинуть</button>';
  } else {
    menu.innerHTML =
      '<button class="menu-item" onclick="clearChatHistory()">Очистить историю</button>' +
      '<button class="menu-item danger" onclick="deleteCurrentChat()">Удалить чат</button>';
  }
}

async function clearChatHistory() {
  closeChatDropdown();
  if (!activePeer) return;
  if (!confirm('Очистить историю?')) return;
  var ids = [];
  for (var id in messagesCache) {
    var m = messagesCache[id];
    if (activePeer.type === 'group' && m.groupId === activePeer.id) ids.push(id);
    else if (activePeer.type !== 'group' &&
      ((m.senderId === currentUser.id && m.receiverId === activePeer.id) ||
       (m.senderId === activePeer.id && m.receiverId === currentUser.id))) ids.push(id);
  }
  for (var i = 0; i < ids.length; i++) await markDeleted('message', ids[i]);
  renderMessagesContainer(getChatMessages(activePeer));
  renderChatListFromCache();
}

async function deleteCurrentChat() {
  closeChatDropdown();
  if (!activePeer) return;
  if (!confirm('Удалить чат?')) return;
  await markDeleted('chat_hide', currentUser.id + ':' + activePeer.id, {
    userId: currentUser.id, peerId: activePeer.id
  });
  resetActiveChat();
  renderChatListFromCache();
}

/* ==================== SEND ==================== */

async function sendMsg() {
  if (!activePeer) return;
  if (isUploading) return;
  if (connectionState !== 'online') {
    showStatusTransient(connectionState === 'no-internet' ? '⚠ Нет подключения к интернету' : '⌛ Соединение...', connectionState);
    return;
  }
  if (!lockButton('send-btn', 1000)) return;
  var input = document.getElementById('msg-input');
  var text = input.value.trim();
  var fileToSend = selectedFile;
  var voiceToSend = pendingVoice;
  if (!text && !fileToSend && !voiceToSend) return;
  input.value = '';
  var isGroup = activePeer.type === 'group';
  var msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  var msg = {
    id: msgId, senderId: currentUser.id,
    receiverId: isGroup ? '' : activePeer.id,
    groupId: isGroup ? activePeer.id : '',
    text: text,
    fileName: fileToSend ? fileToSend.name : (voiceToSend ? voiceToSend.name : ''),
    fileType: fileToSend ? fileToSend.type : (voiceToSend ? voiceToSend.type : ''),
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    ts: Date.now(), isRead: false, readBy: [], isDeleted: false
  };
  if (voiceToSend) msg.fileData = voiceToSend.data;
  else if (fileToSend && !fileToSend.isLarge) msg.fileData = fileToSend.data;
  messagesCache[msgId] = msg;
  await dbPut('messages', msg);
  if (fileToSend && fileToSend.isLarge && fileToSend.file) {
    isUploading = true;
    var inputBar = document.getElementById('input-bar');
    var orig = inputBar.innerHTML;
    inputBar.innerHTML = '<div class="upload-progress-container"><div class="upload-progress-track"><div class="upload-progress-bar" id="upload-progress-bar"></div></div><span class="upload-progress-text" id="upload-progress-text">0%</span></div>';
    try {
      var fileUrl = await uploadFileInChunks(fileToSend.file, function (done, total) {
        var p = Math.round(done / total * 100);
        var bar = document.getElementById('upload-progress-bar');
        var txt = document.getElementById('upload-progress-text');
        if (bar) bar.style.width = p + '%';
        if (txt) txt.innerText = p + '%';
      });
      msg.fileUrl = fileUrl;
      msg.fileSize = fileToSend.file.size;
      messagesCache[msgId] = msg;
      await dbPut('messages', msg);
      await saveFileToIDB(msgId, fileToSend.file, { fileName: fileToSend.name, fileType: fileToSend.type, fileSize: fileToSend.file.size });
    } catch (e) { alert('Ошибка загрузки'); }
    inputBar.innerHTML = orig;
    isUploading = false;
  }
  scheduleEvent({
    type: 'message', id: msgId,
    senderId: msg.senderId, receiverId: msg.receiverId, groupId: msg.groupId,
    text: msg.text, fileName: msg.fileName, fileType: msg.fileType,
    fileData: msg.fileData || '', fileUrl: msg.fileUrl || '',
    fileSize: msg.fileSize || 0, timestamp: msg.timestamp, ts: msg.ts,
    isRead: false, readBy: []
  });
  renderMessagesContainer(getChatMessages(activePeer));
  cancelAttachment();
  cancelVoiceAttachment();
}

function showStatusTransient(text, cls) {
  var bar = document.getElementById('status-bar');
  if (!bar) return;
  bar.innerText = text;
  bar.className = 'visible ' + (cls === 'no-internet' ? 'internet-off' : 'server-off');
  if (statusBarTimeout) clearTimeout(statusBarTimeout);
  statusBarTimeout = setTimeout(function () { updateStatusBar(); }, 3000);
}

async function uploadFileInChunks(file, onProgress) {
  var init = await fetch('/api/upload/init', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senderId: currentUser.id, fileName: file.name, fileSize: file.size, fileType: file.type })
  });
  if (!init.ok) throw new Error('init failed');
  var data = await init.json();
  var fileId = data.fileId;
  var totalChunks = data.totalChunks;
  for (var i = 0; i < totalChunks; i++) {
    var start = i * CHUNK_SIZE;
    var end = Math.min(start + CHUNK_SIZE, file.size);
    var chunk = file.slice(start, end);
    var res = await fetch('/api/upload/chunk?fileId=' + encodeURIComponent(fileId) + '&chunkIndex=' + i, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk
    });
    if (!res.ok) throw new Error('chunk ' + i);
    if (onProgress) onProgress(i + 1, totalChunks);
  }
  var fin = await fetch('/api/upload/finish', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: fileId })
  });
  if (!fin.ok) throw new Error('finish');
  var fdata = await fin.json();
  return fdata.url;
}

/* ==================== MSG ACTIONS ==================== */

function openMsgActions(msg, el) {
  if (document.getElementById('msg-actions-sheet').classList.contains('active')) return;
  selectedMsgId = msg.id; selectedMsgObj = msg;
  document.querySelectorAll('.msg').forEach(function (x) { x.classList.remove('selected-msg'); });
  el.classList.add('selected-msg');
  document.getElementById('action-btn-copy').style.display = (msg.text && !msg.fileData && !msg.fileUrl) ? 'block' : 'none';
  document.getElementById('action-btn-download').style.display = (msg.fileData || msg.fileUrl) ? 'block' : 'none';
  document.getElementById('msg-actions-sheet').classList.add('active');
}
function closeMsgActions() {
  selectedMsgId = null; selectedMsgObj = null;
  document.querySelectorAll('.msg').forEach(function (x) { x.classList.remove('selected-msg'); });
  document.getElementById('msg-actions-sheet').classList.remove('active');
}
function actionCopyText() {
  var t = selectedMsgObj && selectedMsgObj.text;
  closeMsgActions();
  if (t) navigator.clipboard.writeText(t).catch(function () {});
}
async function actionDownloadFile() {
  var obj = selectedMsgObj;
  closeMsgActions();
  if (!obj) return;
  var url = await getFileUrlForMessage(obj);
  if (!url && obj.fileData) url = obj.fileData;
  if (!url) { alert('Файл недоступен'); return; }
  var a = document.createElement('a');
  a.href = url; a.download = obj.fileName || 'file';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
async function deleteSelectedMessage() {
  var id = selectedMsgId;
  closeMsgActions();
  if (!id) return;
  await markDeleted('message', id);
  if (activePeer) renderMessagesContainer(getChatMessages(activePeer));
  renderChatListFromCache();
}

/* ==================== READ ==================== */

function checkVisibleMessages() { setTimeout(doCheckVisibleMessages, 300); }
async function doCheckVisibleMessages() {
  if (!activePeer || !currentUser) return;
  var container = document.getElementById('messages-container');
  var els = container.querySelectorAll('.msg');
  var cr = container.getBoundingClientRect();
  var ids = [];
  els.forEach(function (el) {
    var sid = el.getAttribute('data-sender-id');
    var mid = el.getAttribute('data-msg-id');
    if (sid === currentUser.id) return;
    var r = el.getBoundingClientRect();
    if (r.top >= cr.top && r.bottom <= cr.bottom) {
      var m = messagesCache[mid];
      if (!m) return;
      if (m.groupId) {
        if (!m.readBy) m.readBy = [];
        if (m.readBy.indexOf(currentUser.id) === -1) { m.readBy.push(currentUser.id); dbPut('messages', m); ids.push(mid); }
      } else if (!m.isRead) {
        m.isRead = true;
        dbPut('messages', m);
        ids.push(mid);
      }
    }
  });
  for (var i = 0; i < ids.length; i++) {
    var mm = messagesCache[ids[i]];
    if (!mm) continue;
    scheduleEvent({
      type: 'message_read', id: ids[i], readerId: currentUser.id,
      senderId: mm.senderId, receiverId: mm.receiverId, groupId: mm.groupId || ''
    });
  }
}

/* ==================== PROFILE ==================== */

function openMyProfile() {
  if (isModalOpen('my-profile-modal')) return;
  draftAvatar = null;
  document.getElementById('edit-my-name-input').value = currentUser.name;
  renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), currentUser, true);
  document.getElementById('my-profile-name-view').innerText = currentUser.name;
  document.getElementById('my-profile-id-view').innerText = 'ID: ' + currentUser.id;
  document.getElementById('remove-avatar-link-btn').style.display = currentUser.avatar ? 'block' : 'none';
  safeOpenModal('my-profile-modal');
}
function closeMyProfile() { draftAvatar = null; safeCloseModal('my-profile-modal'); }
function triggerAvatarInput() { var i = document.getElementById('avatar-file-input'); i.value = ''; i.click(); }
function handleAvatarSelect(e) {
  var file = e.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { alert('Максимум 10 МБ'); return; }
  compressImage(file, 200, 0.85, function (c) {
    if (!c) return;
    draftAvatar = c;
    renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), { id: currentUser.id, avatar: c, name: currentUser.name }, true);
    document.getElementById('remove-avatar-link-btn').style.display = 'block';
  });
}
function removeMyAvatar() {
  draftAvatar = '';
  renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), { id: currentUser.id, avatar: '', name: currentUser.name }, true);
  document.getElementById('remove-avatar-link-btn').style.display = 'none';
}
async function saveMyProfileChanges() {
  if (connectionState !== 'online') {
    alert(connectionState === 'no-internet' ? 'Нет подключения к интернету' : 'Соединение...');
    return;
  }
  if (!lockButton('save-my-profile-btn', 2000)) return;
  var newName = document.getElementById('edit-my-name-input').value.trim();
  if (newName) currentUser.name = newName;
  if (draftAvatar !== null) { currentUser.avatar = draftAvatar; draftAvatar = null; }
  currentUser.updatedAt = Date.now();
  await setMeta('profile', currentUser);
  await dbPut('users', currentUser);
  updateMyProfileUI();
  scheduleEvent({
    type: 'profile', id: currentUser.id,
    name: currentUser.name, avatar: currentUser.avatar, updatedAt: Date.now()
  });
  closeMyProfile();
}

function openPeerProfile() {
  if (!activePeer) return;
  if (activePeer.type === 'group') { openGroupProfile(); return; }
  profileTargetId = activePeer.id;
  if (isModalOpen('peer-profile-modal')) return;
  renderAvatarIntoElement(document.getElementById('peer-profile-avatar-view'), activePeer, activePeer.isOnline);
  document.getElementById('peer-profile-name-view').innerText = activePeer.name;
  document.getElementById('peer-profile-id-view').innerText = 'ID: ' + activePeer.id;
  updatePeerProfileButtons(activePeer);
  safeOpenModal('peer-profile-modal');
}
function updatePeerProfileButtons(user) {
  var b = document.getElementById('block-peer-btn');
  var blocked = currentUser.blockedContacts && currentUser.blockedContacts.indexOf(user.id) !== -1;
  b.innerText = blocked ? 'Разблокировать' : 'Заблокировать';
  b.className = blocked ? 'btn btn-secondary' : 'btn btn-danger';
  var m = document.getElementById('mute-peer-btn');
  var muted = mutedPeers.indexOf(user.id) !== -1;
  m.innerText = muted ? 'Включить звук' : 'Выключить звук';
  m.className = muted ? 'btn' : 'btn btn-secondary';
}
function openMemberProfile(member) {
  profileTargetId = member.id;
  if (isModalOpen('peer-profile-modal')) return;
  renderAvatarIntoElement(document.getElementById('peer-profile-avatar-view'), member, member.isOnline);
  document.getElementById('peer-profile-name-view').innerText = member.name;
  document.getElementById('peer-profile-id-view').innerText = 'ID: ' + member.id;
  updatePeerProfileButtons(member);
  safeOpenModal('peer-profile-modal');
}
function closePeerProfile() { safeCloseModal('peer-profile-modal'); }
function toggleMutePeer() {
  if (!profileTargetId) return;
  var i = mutedPeers.indexOf(profileTargetId);
  if (i > -1) mutedPeers.splice(i, 1); else mutedPeers.push(profileTargetId);
  setMeta('mutedPeers', mutedPeers);
  updatePeerProfileButtons({ id: profileTargetId });
}
async function toggleBlockPeer() {
  if (!profileTargetId) return;
  if (!lockButton('block-peer-btn', 1500)) return;
  var blocked = currentUser.blockedContacts && currentUser.blockedContacts.indexOf(profileTargetId) !== -1;
  if (!currentUser.blockedContacts) currentUser.blockedContacts = [];
  if (blocked) currentUser.blockedContacts = currentUser.blockedContacts.filter(function (x) { return x !== profileTargetId; });
  else currentUser.blockedContacts.push(profileTargetId);
  await setMeta('profile', currentUser);
  closePeerProfile();
}

/* ==================== GROUPS ==================== */

function openCreateGroup() {
  if (connectionState !== 'online') { alert('Нет соединения с сервером'); return; }
  if (isModalOpen('create-group-modal')) return;
  groupDraftAvatar = '';
  document.getElementById('create-group-name').value = '';
  renderAvatarIntoElement(document.getElementById('create-group-avatar'), { avatar: '', name: '👥' }, false);
  var cached = [];
  for (var uid in usersCache) if (uid !== currentUser.id) cached.push(usersCache[uid]);
  renderCheckList('create-group-contacts', cached, new Set());
  safeOpenModal('create-group-modal');
}
function closeCreateGroup() { safeCloseModal('create-group-modal'); }
function triggerGroupAvatarInput() { var i = document.getElementById('group-avatar-input'); i.value = ''; i.click(); }
function handleGroupAvatarSelect(e) {
  var file = e.target.files[0];
  if (!file) return;
  compressImage(file, 200, 0.85, function (c) {
    if (!c) return;
    groupDraftAvatar = c;
    renderAvatarIntoElement(document.getElementById('create-group-avatar'), { avatar: c, name: '👥' }, false);
  });
}
function renderCheckList(containerId, users, excludeSet) {
  var c = document.getElementById(containerId);
  c.innerHTML = '';
  var list = users.filter(function (u) { return !excludeSet.has(u.id); });
  if (list.length === 0) { c.innerHTML = '<div style="color:var(--text-muted); font-size:13px; padding:8px;">Нет контактов</div>'; return; }
  list.forEach(function (u) {
    var row = document.createElement('label');
    row.className = 'check-row';
    row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:8px; cursor:pointer; border-bottom:1px solid var(--border);';
    var avId = 'chk_av_' + u.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    row.innerHTML =
      '<input type="checkbox" value="' + u.id + '" style="width:18px;height:18px;">' +
      '<div class="avatar-circle" id="' + avId + '" style="width:32px;height:32px;font-size:13px;"></div>' +
      '<span style="flex:1;">' + escapeHtml(u.name) + '</span>';
    c.appendChild(row);
    renderAvatarIntoElement(document.getElementById(avId), u, false);
  });
}
function getChecked(id) {
  return Array.from(document.querySelectorAll('#' + id + ' input[type=checkbox]:checked')).map(function (i) { return i.value; });
}
async function submitCreateGroup() {
  if (connectionState !== 'online') { alert('Нет соединения с сервером'); return; }
  var name = document.getElementById('create-group-name').value.trim();
  if (!name) { alert('Введите название'); return; }
  var members = getChecked('create-group-contacts');
  if (members.length === 0) { alert('Выберите участников'); return; }
  if (!lockButton('create-group-submit-btn', 2000)) return;
  var gid = 'grp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  var g = {
    id: gid, name, avatar: groupDraftAvatar || '',
    ownerId: currentUser.id,
    members: [currentUser.id].concat(members),
    createdAt: Date.now()
  };
  groupsCache[gid] = g;
  await dbPut('groups', g);
  scheduleEvent({
    type: 'group', id: gid,
    name: g.name, avatar: g.avatar, ownerId: g.ownerId,
    members: g.members, createdAt: g.createdAt
  });
  closeCreateGroup();
  renderChatListFromCache();
  openChat({ id: gid, type: 'group', name: g.name, avatar: g.avatar, members: g.members, ownerId: g.ownerId, memberCount: g.members.length });
}

async function openGroupProfile() {
  closeChatDropdown();
  if (!activePeer || activePeer.type !== 'group') return;
  if (isModalOpen('group-profile-modal')) return;
  var g = groupsCache[activePeer.id];
  if (!g) return;
  activePeer = Object.assign({}, activePeer, { members: g.members, ownerId: g.ownerId, name: g.name, avatar: g.avatar });
  editGroupDraftAvatar = '';
  renderAvatarIntoElement(document.getElementById('group-profile-avatar'), { id: g.id, avatar: g.avatar, name: g.name }, false);
  document.getElementById('group-profile-name').innerText = g.name;
  document.getElementById('group-profile-count').innerText = g.members.length + ' участников';
  var isOwner = g.ownerId === currentUser.id;
  document.getElementById('group-owner-controls').style.display = isOwner ? 'block' : 'none';
  document.getElementById('delete-group-btn').style.display = isOwner ? 'block' : 'none';
  if (isOwner) document.getElementById('edit-group-name').value = g.name;
  renderMembersList('group-members-list', g.members, g.ownerId);
  safeOpenModal('group-profile-modal');
}
function closeGroupProfile() {
  editGroupDraftAvatar = '';
  safeCloseModal('group-profile-modal');
  closeMemberDropdown();
}
function renderMembersList(containerId, memberIds, ownerId) {
  var c = document.getElementById(containerId);
  c.innerHTML = '';
  var amOwner = ownerId === currentUser.id;
  memberIds.forEach(function (mid) {
    var u = usersCache[mid] || { id: mid, name: 'Пользователь', avatar: '' };
    var isOwner = mid === ownerId;
    var isMe = mid === currentUser.id;
    var row = document.createElement('div');
    row.className = 'member-row';
    var info = document.createElement('div');
    info.style.cssText = 'display:flex; align-items:center; gap:10px; flex:1; overflow:hidden;';
    info.innerHTML =
      '<div class="avatar-circle" style="width:32px;height:32px;font-size:13px;"></div>' +
      '<div style="flex:1; text-align:left;">' +
        '<div>' + escapeHtml(u.name) + (isMe ? ' (вы)' : '') + '</div>' +
        (isOwner ? '<div style="font-size:11px;color:var(--accent);">создатель</div>' : '') +
      '</div>';
    info.onclick = function (e) {
      e.stopPropagation();
      if (isMe) { closeGroupProfile(); openMyProfile(); }
      else openMemberProfile(u);
    };
    row.appendChild(info);
    renderAvatarIntoElement(info.querySelector('.avatar-circle'), u, u.isOnline || false);
    if (amOwner && !isMe && !isOwner) {
      var btn = document.createElement('button');
      btn.className = 'member-menu-btn';
      btn.innerText = '⋮';
      btn.onclick = function (e) {
        e.stopPropagation();
        if (activeMemberDropdown && activeMemberDropdown.dataset.memberId === u.id) closeMemberDropdown();
        else openMemberDropdown(row, u);
      };
      row.appendChild(btn);
    }
    c.appendChild(row);
  });
}
function openMemberDropdown(rowEl, member) {
  closeMemberDropdown();
  var dd = document.createElement('div');
  dd.className = 'member-dropdown active';
  dd.dataset.memberId = member.id;
  dd.innerHTML =
    '<button class="menu-item" data-action="profile">Профиль</button>' +
    '<button class="menu-item danger" data-action="kick">Выгнать</button>';
  dd.addEventListener('click', function (e) {
    e.stopPropagation();
    var a = e.target.getAttribute('data-action');
    if (a === 'profile') { closeMemberDropdown(); openMemberProfile(member); }
    else if (a === 'kick') { closeMemberDropdown(); kickMember(member); }
  });
  rowEl.appendChild(dd);
  activeMemberDropdown = dd;
  setTimeout(function () {
    document.addEventListener('click', function h(ev) {
      if (activeMemberDropdown && !activeMemberDropdown.contains(ev.target)) {
        closeMemberDropdown();
        document.removeEventListener('click', h);
      }
    });
  }, 0);
}
function closeMemberDropdown() {
  if (activeMemberDropdown && activeMemberDropdown.parentNode) activeMemberDropdown.parentNode.removeChild(activeMemberDropdown);
  activeMemberDropdown = null;
}
async function kickMember(member) {
  if (!activePeer || activePeer.type !== 'group') return;
  if (!confirm('Выгнать ' + member.name + '?')) return;
  var g = groupsCache[activePeer.id];
  if (!g) return;
  g.members = g.members.filter(function (m) { return m !== member.id; });
  await dbPut('groups', g);
  await markDeleted('group_kick', activePeer.id + ':' + member.id, {
    groupId: activePeer.id, memberId: member.id, members: g.members
  });
  scheduleEvent({
    type: 'group_update', id: activePeer.id,
    name: g.name, avatar: g.avatar, members: g.members, ownerId: g.ownerId
  });
  activePeer.members = g.members;
  renderMembersList('group-members-list', g.members, g.ownerId);
  document.getElementById('group-profile-count').innerText = g.members.length + ' участников';
  renderChatListFromCache();
}
async function deleteGroup() {
  if (!activePeer || activePeer.type !== 'group') return;
  if (!confirm('Удалить группу?')) return;
  await markDeleted('group', activePeer.id);
  closeGroupProfile();
  resetActiveChat();
  renderChatListFromCache();
}
function triggerEditGroupAvatarInput() { var i = document.getElementById('edit-group-avatar-input'); i.value = ''; i.click(); }
function handleEditGroupAvatarSelect(e) {
  var file = e.target.files[0];
  if (!file) return;
  compressImage(file, 200, 0.85, function (c) {
    if (!c) return;
    editGroupDraftAvatar = c;
    renderAvatarIntoElement(document.getElementById('group-profile-avatar'), { avatar: c, name: '👥' }, false);
  });
}
async function saveGroupChanges() {
  if (!activePeer || activePeer.type !== 'group') return;
  if (!lockButton('save-group-btn', 2000)) return;
  var name = document.getElementById('edit-group-name').value.trim();
  if (!name) { alert('Введите название'); return; }
  var g = groupsCache[activePeer.id];
  if (!g) return;
  g.name = name;
  if (editGroupDraftAvatar) g.avatar = editGroupDraftAvatar;
  await dbPut('groups', g);
  editGroupDraftAvatar = '';
  scheduleEvent({
    type: 'group_update', id: g.id,
    name: g.name, avatar: g.avatar, members: g.members, ownerId: g.ownerId
  });
  renderChatListFromCache();
  closeGroupProfile();
}
async function openAddMembers() {
  if (!activePeer || activePeer.type !== 'group') return;
  if (isModalOpen('add-members-modal')) return;
  var g = groupsCache[activePeer.id];
  if (!g) return;
  var exclude = new Set(g.members);
  var cached = [];
  for (var uid in usersCache) if (!exclude.has(uid)) cached.push(usersCache[uid]);
  renderCheckList('add-members-contacts', cached, exclude);
  safeOpenModal('add-members-modal');
}
function closeAddMembers() { safeCloseModal('add-members-modal'); }
async function submitAddMembers() {
  var members = getChecked('add-members-contacts');
  if (members.length === 0) { alert('Выберите участников'); return; }
  var g = groupsCache[activePeer.id];
  if (!g) return;
  members.forEach(function (m) { if (g.members.indexOf(m) === -1) g.members.push(m); });
  await dbPut('groups', g);
  scheduleEvent({
    type: 'group_update', id: g.id,
    name: g.name, avatar: g.avatar, members: g.members, ownerId: g.ownerId
  });
  closeAddMembers();
  activePeer.members = g.members;
  renderMembersList('group-members-list', g.members, g.ownerId);
  document.getElementById('group-profile-count').innerText = g.members.length + ' участников';
}
async function leaveGroup() {
  closeChatDropdown();
  if (!activePeer || activePeer.type !== 'group') return;
  if (!confirm('Покинуть группу?')) return;
  var g = groupsCache[activePeer.id];
  if (g) {
    g.members = g.members.filter(function (m) { return m !== currentUser.id; });
    await dbPut('groups', g);
    scheduleEvent({
      type: 'group_update', id: g.id,
      name: g.name, avatar: g.avatar, members: g.members, ownerId: g.ownerId
    });
  }
  await markDeleted('group', activePeer.id);
  closeGroupProfile();
  resetActiveChat();
  renderChatListFromCache();
}

/* ==================== ATTACHMENTS ==================== */

function triggerFileInput() { if (isUploading) return; document.getElementById('file-input').click(); }
function handleFileSelect(e) {
  var file = e.target.files[0];
  if (!file) return;
  if (file.size > MAX_FILE_SIZE) { alert('Максимум 200 МБ'); return; }
  if (file.size > 1024 * 1024) {
    selectedFile = { file: file, name: file.name, type: file.type, data: null, isLarge: true };
    var thumb = document.getElementById('attachment-thumb-img');
    document.getElementById('attachment-name-label').innerText = file.name;
    document.getElementById('attachment-type-label').innerText = formatBytes(file.size);
    if (file.type.indexOf('image/') === 0) {
      var r = new FileReader();
      r.onload = function (ev) { thumb.src = ev.target.result; thumb.style.display = 'block'; };
      r.readAsDataURL(file);
    } else thumb.style.display = 'none';
    document.getElementById('attachment-preview-container').classList.add('active');
    return;
  }
  var reader = new FileReader();
  reader.onload = function (evt) {
    selectedFile = { data: evt.target.result, name: file.name, type: file.type, file: file, isLarge: false };
    var thumb = document.getElementById('attachment-thumb-img');
    document.getElementById('attachment-name-label').innerText = file.name;
    document.getElementById('attachment-type-label').innerText = formatBytes(file.size);
    if (file.type.indexOf('image/') === 0) { thumb.src = evt.target.result; thumb.style.display = 'block'; }
    else thumb.style.display = 'none';
    document.getElementById('attachment-preview-container').classList.add('active');
  };
  reader.readAsDataURL(file);
}
function cancelAttachment() {
  if (isUploading) return;
  selectedFile = null;
  document.getElementById('file-input').value = '';
  document.getElementById('attachment-preview-container').classList.remove('active');
}

/* ==================== VOICE ==================== */

function cancelVoiceAttachment() {
  if (pendingVoice && pendingVoice.url && pendingVoice.url.indexOf('blob:') === 0) {
    try { URL.revokeObjectURL(pendingVoice.url); } catch (e) {}
  }
  pendingVoice = null;
  document.getElementById('audio-attachment-preview').classList.remove('active');
  var p = document.getElementById('audio-preview-player');
  if (p) { p.pause(); p.removeAttribute('src'); try { p.load(); } catch (e) {} }
}
function cleanupRecordingNodes() {
  try { if (recordProcessor) recordProcessor.disconnect(); } catch (e) {}
  try { if (recordSourceNode) recordSourceNode.disconnect(); } catch (e) {}
  try { if (recordSilentGain) recordSilentGain.disconnect(); } catch (e) {}
  try { if (recordAudioCtx && recordAudioCtx.state !== 'closed') recordAudioCtx.close(); } catch (e) {}
  recordProcessor = recordSourceNode = recordSilentGain = recordAudioCtx = null;
}
function floatTo16BitPCM(output, offset, input) {
  for (var i = 0; i < input.length; i++, offset += 2) {
    var s = Math.max(-1, Math.min(1, input[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    output.setInt16(offset, s, true);
  }
}
function writeString(view, offset, string) { for (var i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i)); }
function encodeWAV(samples, sampleRate) {
  var buffer = new ArrayBuffer(44 + samples.length * 2);
  var view = new DataView(buffer);
  writeString(view, 0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE'); writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeString(view, 36, 'data'); view.setUint32(40, samples.length * 2, true);
  floatTo16BitPCM(view, 44, samples);
  return new Blob([view], { type: 'audio/wav' });
}
function startRecordingTimer() {
  recordStartedAt = Date.now();
  document.getElementById('record-panel').classList.add('active');
  document.getElementById('recording-timer').innerText = '0:00';
  if (recordingTimerInterval) clearInterval(recordingTimerInterval);
  recordingTimerInterval = setInterval(function () {
    var s = Math.floor((Date.now() - recordStartedAt) / 1000);
    document.getElementById('recording-timer').innerText = Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0');
  }, 200);
}
function stopRecordingTimer() {
  document.getElementById('record-panel').classList.remove('active');
  if (recordingTimerInterval) { clearInterval(recordingTimerInterval); recordingTimerInterval = null; }
}
async function toggleVoiceRecord() {
  var mic = document.getElementById('mic-btn');
  if (isRecording) {
    isRecording = false;
    mic.innerText = '🎙️';
    mic.classList.remove('recording');
    stopRecordingTimer();
    var chunks = audioChunks.slice();
    var rate = recordAudioCtx ? recordAudioCtx.sampleRate : 48000;
    cleanupRecordingNodes();
    try { if (activeStream) activeStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    activeStream = null;
    if (chunks.length === 0) { alert('Пустая запись'); return; }
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var merged = new Float32Array(total);
    var off = 0;
    for (var j = 0; j < chunks.length; j++) { merged.set(chunks[j], off); off += chunks[j].length; }
    var targetRate = 16000;
    var final = merged, fr = rate;
    if (rate > targetRate) {
      var ratio = rate / targetRate;
      var nl = Math.floor(merged.length / ratio);
      var down = new Float32Array(nl);
      for (var k = 0; k < nl; k++) down[k] = merged[Math.floor(k * ratio)] || 0;
      final = down; fr = targetRate;
    }
    var wavBlob = encodeWAV(final, fr);
    var reader = new FileReader();
    reader.onload = function (evt) {
      cancelVoiceAttachment();
      var dataUrl = evt.target.result;
      var url = '';
      try { url = URL.createObjectURL(wavBlob); } catch (e) { url = dataUrl; }
      pendingVoice = { data: dataUrl, name: 'voice_' + Date.now() + '.wav', type: 'audio/wav', url: url };
      document.getElementById('audio-preview-player').src = url;
      document.getElementById('audio-attachment-preview').classList.add('active');
    };
    reader.readAsDataURL(wavBlob);
    return;
  }
  if (!activePeer) { alert('Выберите чат'); return; }
  if (!navigator.mediaDevices) { alert('Нет доступа'); return; }
  try {
    var stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
    activeStream = stream;
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC();
    recordAudioCtx = ctx;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
    var source = ctx.createMediaStreamSource(stream);
    recordSourceNode = source;
    var processor = ctx.createScriptProcessor(4096, 1, 1);
    recordProcessor = processor;
    audioChunks = [];
    processor.onaudioprocess = function (e) { if (!isRecording) return; audioChunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    var sg = ctx.createGain();
    sg.gain.value = 0;
    recordSilentGain = sg;
    source.connect(processor);
    processor.connect(sg);
    sg.connect(ctx.destination);
    isRecording = true;
    mic.innerText = '🔴';
    mic.classList.add('recording');
    startRecordingTimer();
  } catch (err) {
    alert('Нет доступа к микрофону');
    cleanupRecordingNodes();
    try { if (activeStream) activeStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    activeStream = null;
    isRecording = false;
    mic.innerText = '🎙️';
    mic.classList.remove('recording');
    stopRecordingTimer();
  }
}

/* ==================== IMAGE ==================== */

function compressImage(file, maxSize, quality, callback) {
  if (!file || file.type.indexOf('image/') !== 0) { callback(null); return; }
  var reader = new FileReader();
  reader.onload = function (e) {
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement('canvas');
      var w = img.width, h = img.height;
      var r = Math.min(maxSize / w, maxSize / h, 1);
      w = Math.round(w * r);
      h = Math.round(h * r);
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      var isPng = file.type === 'image/png';
      try { callback(canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', isPng ? undefined : quality)); }
      catch (err) { callback(e.target.result); }
    };
    img.onerror = function () { callback(e.target.result); };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

/* ==================== MENUS ==================== */

function toggleChatDropdown() {
  var m = document.getElementById('chat-dropdown-menu');
  if (m) m.classList.toggle('active');
}
function closeChatDropdown() {
  var m = document.getElementById('chat-dropdown-menu');
  if (m) m.classList.remove('active');
}
document.addEventListener('click', function (e) {
  var m = document.getElementById('chat-dropdown-menu');
  var b = document.getElementById('chat-menu-dots-btn');
  if (m && m.classList.contains('active')) {
    if (!m.contains(e.target) && e.target !== b && !b.contains(e.target)) m.classList.remove('active');
  }
});
function openImageViewer(src) {
  document.getElementById('full-screen-img').src = src;
  document.getElementById('image-viewer-modal').classList.add('active');
}
function closeImageViewer() {
  document.getElementById('image-viewer-modal').classList.remove('active');
}

/* ==================== SEARCH ==================== */

async function onSearchInput() {
  var q = document.getElementById('search-input').value.trim();
  var clr = document.getElementById('clear-search-btn');
  if (!q) { clr.style.display = 'none'; refreshUI(); return; }
  clr.style.display = 'block';
  var ql = q.toLowerCase();
  var found = [];
  for (var uid in usersCache) {
    if (uid === currentUser.id) continue;
    var u = usersCache[uid];
    if ((u.id && u.id.toLowerCase().indexOf(ql) !== -1) || (u.name && u.name.toLowerCase().indexOf(ql) !== -1)) {
      found.push({ id: uid, type: 'user', name: u.name, avatar: u.avatar, isOnline: u.isOnline });
    }
  }
  renderChatList(found);
}
function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('clear-search-btn').style.display = 'none';
  refreshUI();
}

/* ==================== INIT ==================== */

window.addEventListener('DOMContentLoaded', async function () {
  updateThemeIcon(savedTheme);
  document.querySelectorAll('.modal-overlay').forEach(function (ov) {
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.classList.remove('active'); });
  });
  await loadAllFromDB();
  
  // Проверяем соединение
  await checkServerHealth();
  // Периодически проверяем пока не залогинен
  if (!currentUser) {
    var checkTimer = setInterval(async function () {
      if (currentUser) { clearInterval(checkTimer); return; }
      await checkServerHealth();
      updateLoadingScreen();
    }, 3000);
  }
  
  if (currentUser) {
    startApp();
  } else {
    document.getElementById('auth-screen').classList.add('active');
    document.getElementById('app-screen').classList.remove('active');
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

app.use(function (err, req, res, next) {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Too big' });
  if (err && (err instanceof SyntaxError || err.type === 'entity.parse.failed')) return res.status(400).json({ error: 'Bad JSON' });
  console.error('[EXPRESS]', err && err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Server error' });
});

const httpServer = app.listen(PORT, '0.0.0.0', function () {
  console.log('[STARTED] port ' + PORT);
});
httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 66000;
httpServer.requestTimeout = 0;
httpServer.timeout = 0;
