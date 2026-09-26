const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

process.on('uncaughtException', (err) => {
  console.error('[ОШИБКА СЕРВЕРА]:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[ОШИБКА ПРОМИСА]:', reason);
});

const SERV_DIR = __dirname;
const ARXIV_DIR = path.join(SERV_DIR, 'arxiv');
const ACCOUNTS_DIR = path.join(ARXIV_DIR, 'accounts');
const MESSAGES_DIR = path.join(ARXIV_DIR, 'messages');
const GROUPS_DIR = path.join(ARXIV_DIR, 'groups');

[ARXIV_DIR, ACCOUNTS_DIR, MESSAGES_DIR, GROUPS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const ACCOUNTS_FILE = path.join(ACCOUNTS_DIR, 'accounts.json');
const MESSAGES_FILE = path.join(MESSAGES_DIR, 'messages.json');
const GROUPS_FILE = path.join(GROUPS_DIR, 'groups.json');

function safeReadJSON(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) { return fallback; }
}
function safeWriteJSON(filePath, data) {
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) { console.error(`[ОШИБКА ЗАПИСИ ${filePath}]:`, e); }
}

function readAccounts() { return safeReadJSON(ACCOUNTS_FILE, []); }
function writeAccounts(d) { safeWriteJSON(ACCOUNTS_FILE, d); }
function readMessages() { return safeReadJSON(MESSAGES_FILE, []); }
function writeMessages(d) { safeWriteJSON(MESSAGES_FILE, d); }
function readGroups() { return safeReadJSON(GROUPS_FILE, []); }
function writeGroups(d) { safeWriteJSON(GROUPS_FILE, d); }

function encryptText(text) {
  if (!text) return '';
  try { return Buffer.from(String(text), 'utf8').toString('base64'); }
  catch (e) { return text; }
}
function decryptText(text) {
  if (!text) return '';
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    if (decoded && !decoded.includes('\uFFFD')) return decoded;
  } catch (e) {}
  return text;
}
function timeStr() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function genId(prefix) {
  return prefix + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

/* ==================== АККАУНТЫ ==================== */

app.post('/api/register', (req, res) => {
  let { id, name, avatar, contacts } = req.body;
  const accounts = readAccounts();
  if (!name || !name.trim()) return res.status(400).json({ error: 'Введите имя' });

  let finalId = id;
  if (!finalId || accounts.some(u => u.id === finalId && u.name !== name.trim())) {
    finalId = 'id_' + Math.random().toString(36).substr(2, 9);
  }
  let user = accounts.find(u => u.id === finalId);
  if (user) {
    user.name = name.trim();
    if (avatar !== undefined) user.avatar = avatar;
    user.updatedAt = Date.now();
    if (Array.isArray(contacts)) user.contacts = Array.from(new Set([...(user.contacts || []), ...contacts]));
  } else {
    user = {
      id: finalId, name: name.trim(), avatar: avatar || '',
      contacts: Array.isArray(contacts) ? contacts : [],
      blockedContacts: [], hiddenDialogs: [], updatedAt: Date.now()
    };
    accounts.push(user);
  }
  writeAccounts(accounts);
  res.json({ success: true, user });
});

app.post('/api/ping', (req, res) => {
  const { id, name, avatar, contacts, knownUsers } = req.body;
  if (!id) return res.status(400).json({ error: 'No id provided' });
  const accounts = readAccounts();

  if (Array.isArray(knownUsers)) {
    knownUsers.forEach(kUser => {
      if (!kUser.id) return;
      if (!accounts.some(a => a.id === kUser.id)) {
        accounts.push({
          id: kUser.id, name: kUser.name || 'Пользователь', avatar: kUser.avatar || '',
          contacts: [], blockedContacts: [], hiddenDialogs: [], updatedAt: 0
        });
      }
    });
  }

  let user = accounts.find(u => u.id === id);
  if (!user) {
    user = {
      id, name: name || 'Пользователь', avatar: avatar || '',
      contacts: Array.isArray(contacts) ? contacts : [],
      blockedContacts: [], hiddenDialogs: [], updatedAt: Date.now()
    };
    accounts.push(user);
  } else {
    user.updatedAt = Date.now();
    if (name) user.name = name;
    if (avatar !== undefined) user.avatar = avatar;
    if (Array.isArray(contacts)) user.contacts = Array.from(new Set([...(user.contacts || []), ...contacts]));
  }
  writeAccounts(accounts);
  res.json({ success: true, user });
});

app.post('/api/profile/update', (req, res) => {
  const { id, name, avatar } = req.body;
  const accounts = readAccounts();
  const user = accounts.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (name && name.trim()) user.name = name.trim();
  if (avatar !== undefined) user.avatar = avatar;
  user.updatedAt = Date.now();
  writeAccounts(accounts);
  res.json({ success: true, user });
});

app.get('/api/users/:userId', (req, res) => {
  const accounts = readAccounts();
  const user = accounts.find(u => u.id === req.params.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const isOnline = user.updatedAt && (Date.now() - user.updatedAt < 8000);
  res.json({ id: user.id, name: user.name, avatar: user.avatar || '', isOnline, updatedAt: user.updatedAt });
});

app.post('/api/users/block', (req, res) => {
  const { userId, peerId, block } = req.body;
  const accounts = readAccounts();
  const user = accounts.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.blockedContacts) user.blockedContacts = [];
  if (block) { if (!user.blockedContacts.includes(peerId)) user.blockedContacts.push(peerId); }
  else { user.blockedContacts = user.blockedContacts.filter(x => x !== peerId); }
  writeAccounts(accounts);
  res.json({ success: true, blockedContacts: user.blockedContacts });
});

app.post('/api/chat/hide', (req, res) => {
  const { userId, peerId } = req.body;
  const accounts = readAccounts();
  const user = accounts.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.hiddenDialogs) user.hiddenDialogs = [];
  if (!user.hiddenDialogs.includes(peerId)) user.hiddenDialogs.push(peerId);
  writeAccounts(accounts);
  res.json({ success: true, hiddenDialogs: user.hiddenDialogs });
});

app.get('/api/users/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  const accounts = readAccounts();
  const now = Date.now();
  const results = accounts
    .filter(u => (u.id && u.id.toLowerCase().includes(q)) || (u.name && u.name.toLowerCase().includes(q)))
    .map(u => ({
      id: u.id, type: 'user', name: u.name, avatar: u.avatar || '',
      isOnline: u.updatedAt && (now - u.updatedAt < 8000)
    }));
  res.json(results);
});

/* ==================== ГРУППЫ ==================== */

app.post('/api/groups/create', (req, res) => {
  const { userId, name, members, avatar } = req.body;
  if (!userId) return res.status(400).json({ error: 'Нет пользователя' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Введите название группы' });

  const accounts = readAccounts();
  const creator = accounts.find(u => u.id === userId);
  const contactsSet = new Set(creator && creator.contacts ? creator.contacts : []);
  const validMembers = (Array.isArray(members) ? members : []).filter(mId => mId !== userId && contactsSet.has(mId));
  const memberSet = new Set([userId, ...validMembers]);

  const groups = readGroups();
  const group = {
    id: genId('grp_'), name: name.trim(), avatar: avatar || '',
    ownerId: userId, members: Array.from(memberSet), createdAt: Date.now()
  };
  groups.push(group);
  writeGroups(groups);
  res.json({ success: true, group });
});

function groupWithDetails(group) {
  const accounts = readAccounts();
  const now = Date.now();
  const memberDetails = group.members.map(mId => {
    const u = accounts.find(a => a.id === mId);
    return {
      id: mId,
      name: u ? u.name : 'Пользователь',
      avatar: u ? (u.avatar || '') : '',
      isOnline: u && u.updatedAt && (now - u.updatedAt < 8000)
    };
  });
  return { ...group, memberDetails };
}

app.get('/api/groups/:groupId', (req, res) => {
  const groups = readGroups();
  const g = groups.find(x => x.id === req.params.groupId);
  if (!g) return res.status(404).json({ error: 'Группа не найдена' });
  res.json(groupWithDetails(g));
});

app.post('/api/groups/update', (req, res) => {
  const { groupId, userId, name, avatar } = req.body;
  const groups = readGroups();
  const g = groups.find(x => x.id === groupId);
  if (!g) return res.status(404).json({ error: 'Группа не найдена' });
  if (g.ownerId !== userId) return res.status(403).json({ error: 'Только создатель может менять группу' });
  if (name && name.trim()) g.name = name.trim();
  if (avatar !== undefined) g.avatar = avatar;
  writeGroups(groups);
  res.json({ success: true, group: groupWithDetails(g) });
});

app.post('/api/groups/add', (req, res) => {
  const { groupId, userId, members } = req.body;
  const groups = readGroups();
  const g = groups.find(x => x.id === groupId);
  if (!g) return res.status(404).json({ error: 'Группа не найдена' });
  if (g.ownerId !== userId) return res.status(403).json({ error: 'Только создатель может добавлять' });

  const accounts = readAccounts();
  const owner = accounts.find(u => u.id === userId);
  const contactsSet = new Set(owner && owner.contacts ? owner.contacts : []);

  (Array.isArray(members) ? members : []).forEach(mId => {
    if (contactsSet.has(mId) && !g.members.includes(mId)) g.members.push(mId);
  });
  writeGroups(groups);
  res.json({ success: true, group: groupWithDetails(g) });
});

app.post('/api/groups/leave', (req, res) => {
  const { groupId, userId } = req.body;
  let groups = readGroups();
  const g = groups.find(x => x.id === groupId);
  if (!g) return res.status(404).json({ error: 'Группа не найдена' });
  g.members = g.members.filter(m => m !== userId);
  if (g.ownerId === userId) g.ownerId = g.members[0] || null;
  if (g.members.length === 0) groups = groups.filter(x => x.id !== groupId);
  writeGroups(groups);
  res.json({ success: true });
});

/* ==================== СООБЩЕНИЯ ==================== */

app.post('/api/messages/send', (req, res) => {
  const { senderId, receiverId, groupId, text, fileData, fileName, fileType, clientId } = req.body;
  const accounts = readAccounts();
  const messages = readMessages();

  if (clientId) {
    const dup = messages.find(m => m.clientId && m.clientId === clientId);
    if (dup) return res.json({ success: true, duplicate: true, message: { ...dup, text: decryptText(dup.text) } });
  }

  const sender = accounts.find(u => u.id === senderId);

  if (groupId) {
    const groups = readGroups();
    const g = groups.find(x => x.id === groupId);
    if (!g) return res.status(404).json({ error: 'Группа не найдена' });
    if (!g.members.includes(senderId)) return res.status(403).json({ error: 'Вы не участник группы' });
  } else {
    const receiver = accounts.find(u => u.id === receiverId);
    if (sender && sender.blockedContacts && sender.blockedContacts.includes(receiverId)) {
      return res.status(403).json({ error: 'Вы заблокировали этого пользователя' });
    }
    if (receiver && receiver.blockedContacts && receiver.blockedContacts.includes(senderId)) {
      return res.status(403).json({ error: 'Вы заблокированы получателем' });
    }
    if (sender && sender.hiddenDialogs) sender.hiddenDialogs = sender.hiddenDialogs.filter(id => id !== receiverId);
    if (receiver && receiver.hiddenDialogs) receiver.hiddenDialogs = receiver.hiddenDialogs.filter(id => id !== senderId);
    if (sender) {
      if (!sender.contacts) sender.contacts = [];
      if (!sender.contacts.includes(receiverId)) sender.contacts.push(receiverId);
    }
    if (receiver) {
      if (!receiver.contacts) receiver.contacts = [];
      if (!receiver.contacts.includes(senderId)) receiver.contacts.push(senderId);
    }
    writeAccounts(accounts);
  }

  const newMsg = {
    id: genId('msg_'), clientId: clientId || '',
    senderId,
    receiverId: groupId ? '' : receiverId,
    groupId: groupId || '',
    text: encryptText(text || ''),
    fileData: fileData || '', fileName: fileName || '', fileType: fileType || '',
    timestamp: timeStr(), ts: Date.now(),
    isRead: false, readBy: [], isDeleted: false,
    clearedFor: []
  };

  messages.push(newMsg);
  writeMessages(messages);
  res.json({ success: true, message: { ...newMsg, text: text || '' } });
});

app.post('/api/messages/read', (req, res) => {
  const { msgIds, userId } = req.body;
  if (!Array.isArray(msgIds) || msgIds.length === 0) return res.json({ success: true });
  const messages = readMessages();
  let changed = false;
  messages.forEach(m => {
    if (!msgIds.includes(m.id)) return;
    if (m.groupId) {
      if (!m.readBy) m.readBy = [];
      if (userId && m.senderId !== userId && !m.readBy.includes(userId)) {
        m.readBy.push(userId); changed = true;
      }
    } else if (!m.isRead && m.senderId !== userId) {
      m.isRead = true; changed = true;
    }
  });
  if (changed) writeMessages(messages);
  res.json({ success: true });
});

app.delete('/api/messages/:msgId', (req, res) => {
  const { msgId } = req.params;
  const messages = readMessages();
  let changed = false;
  messages.forEach(m => { if (m.id === msgId) { m.isDeleted = true; changed = true; } });
  if (changed) writeMessages(messages);
  res.json({ success: true });
});

app.post('/api/chat/clear', (req, res) => {
  const { userId, peerId, groupId } = req.body;
  const messages = readMessages();
  let changed = false;
  messages.forEach(m => {
    const isGroupMatch = groupId && m.groupId === groupId;
    const isDmMatch = !groupId && (
      (m.senderId === userId && m.receiverId === peerId) ||
      (m.senderId === peerId && m.receiverId === userId)
    );
    if ((isGroupMatch || isDmMatch) && !m.isDeleted) {
      if (!m.clearedFor) m.clearedFor = [];
      if (!m.clearedFor.includes(userId)) { m.clearedFor.push(userId); changed = true; }
    }
  });
  if (changed) writeMessages(messages);
  res.json({ success: true });
});

app.get('/api/messages/group/:groupId', (req, res) => {
  const { groupId } = req.params;
  const { userId } = req.query;
  const messages = readMessages();
  const list = messages
    .filter(m => !m.isDeleted && m.groupId === groupId &&
      !(m.clearedFor && userId && m.clearedFor.includes(userId)))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .map(m => ({ ...m, text: decryptText(m.text) }));
  res.json(list);
});

app.get('/api/messages/:userId/:peerId', (req, res) => {
  const { userId, peerId } = req.params;
  const messages = readMessages();
  const chatMsgs = messages.filter(m =>
    !m.isDeleted && !m.groupId && (
      (m.senderId === userId && m.receiverId === peerId) ||
      (m.senderId === peerId && m.receiverId === userId)
    ) &&
    !(m.clearedFor && m.clearedFor.includes(userId))
  ).sort((a, b) => (a.ts || 0) - (b.ts || 0)).map(m => ({
    ...m, text: decryptText(m.text)
  }));
  res.json(chatMsgs);
});

app.get('/api/dialogs/:userId', (req, res) => {
  const userId = req.params.userId;
  const accounts = readAccounts();
  const currentUser = accounts.find(u => u.id === userId);
  const messages = readMessages();
  const groups = readGroups();
  const now = Date.now();

  const hiddenSet = new Set(currentUser && currentUser.hiddenDialogs ? currentUser.hiddenDialogs : []);
  const peerIds = new Set(currentUser ? currentUser.contacts || [] : []);
  const lastTs = {};

  messages.forEach(m => {
    if (m.isDeleted) return;
    if (m.clearedFor && m.clearedFor.includes(userId)) return;
    if (m.groupId) {
      lastTs['grp:' + m.groupId] = Math.max(lastTs['grp:' + m.groupId] || 0, m.ts || 0);
    } else {
      if (m.senderId === userId) { peerIds.add(m.receiverId); lastTs[m.receiverId] = Math.max(lastTs[m.receiverId] || 0, m.ts || 0); }
      if (m.receiverId === userId) { peerIds.add(m.senderId); lastTs[m.senderId] = Math.max(lastTs[m.senderId] || 0, m.ts || 0); }
    }
  });

  const userDialogs = accounts
    .filter(u => peerIds.has(u.id) && u.id !== userId && !hiddenSet.has(u.id))
    .map(u => ({
      id: u.id, type: 'user', name: u.name, avatar: u.avatar || '',
      isOnline: u.updatedAt && (now - u.updatedAt < 8000),
      lastTs: lastTs[u.id] || 0
    }));

  const groupDialogs = groups
    .filter(g => g.members.includes(userId))
    .map(g => ({
      id: g.id, type: 'group', name: g.name, avatar: g.avatar || '',
      ownerId: g.ownerId, members: g.members, memberCount: g.members.length,
      lastTs: lastTs['grp:' + g.id] || 0
    }));

  const all = [...userDialogs, ...groupDialogs].sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  res.json(all);
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
  .avatar-circle { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: var(--accent); display: flex; align-items: center; justify-content: center; color: #fff; font-weight: bold; flex-shrink: 0; font-size: 16px; position: relative; }
  .avatar-circle img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
  .online-indicator { position: absolute; bottom: -1px; right: -1px; width: 12px; height: 12px; background: #4cd964; border: 2px solid var(--bg-sidebar); border-radius: 50%; display: none; z-index: 10; pointer-events: none; }
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
  .chat-item { display: flex; align-items: center; gap: 12px; padding: 12px; cursor: pointer; border-bottom: 1px solid var(--border); transition: background 0.2s; }
  .chat-item:hover, .chat-item.active { background: var(--bg-active); }

  .main-chat { flex: 1; display: flex; flex-direction: column; background: var(--bg-app); position: relative; min-width: 0; }
  .chat-header { background: var(--bg-sidebar); padding: 8px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); height: 60px; }
  .chat-header-info { display: flex; align-items: center; gap: 10px; cursor: pointer; flex: 1; overflow: hidden; }
  .chat-menu-container { position: relative; }
  .menu-dots-btn { background: transparent; border: none; color: var(--text-main); font-size: 20px; cursor: pointer; padding: 8px; border-radius: 50%; display: none; align-items: center; justify-content: center; }
  .menu-dots-btn:hover { background: var(--bg-input); }
  .chat-dropdown-menu { position: absolute; right: 0; top: 45px; background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); width: 220px; display: none; flex-direction: column; z-index: 1000; overflow: hidden; }
  .chat-dropdown-menu.active { display: flex; }
  .menu-item { padding: 12px 16px; font-size: 14px; cursor: pointer; border-bottom: 1px solid var(--border); text-align: left; background: none; border-top: none; border-left: none; border-right: none; color: var(--text-main); width: 100%; }
  .menu-item:hover { background: var(--bg-active); }
  .menu-item.danger { color: #e53935; }

  .messages-container { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px; -webkit-overflow-scrolling: touch; }
  .msg { max-width: 75%; padding: 10px 14px; border-radius: 12px; background: var(--bg-msg-peer); align-self: flex-start; word-break: break-word; position: relative; user-select: none; transition: background 0.2s; }
  .msg.my { background: var(--bg-msg-my); align-self: flex-end; }
  .msg.selected-msg { background: var(--msg-selected) !important; outline: 2px solid var(--accent); }
  .msg.pending { opacity: 0.75; }
  .msg-sender { font-size: 12px; font-weight: bold; color: var(--accent); margin-bottom: 2px; }

  .media-preview { width: 260px; height: 180px; max-width: 100%; border-radius: 8px; margin-top: 6px; object-fit: cover; display: block; background: #000; cursor: pointer; }
  .video-preview { width: 260px; max-width: 100%; border-radius: 8px; margin-top: 6px; display: block; background: #000; }
  .file-link { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-input); border-radius: 6px; color: var(--accent); text-decoration: none; margin-top: 5px; font-size: 13px; cursor: pointer; }

  .audio-slot { width: 240px; max-width: 100%; height: 40px; margin-top: 5px; }
  .audio-preview { width: 240px !important; min-width: 240px !important; max-width: 240px !important; height: 40px; margin-top: 5px; display: block; flex-shrink: 0; box-sizing: border-box; }
  @media (max-width: 360px) { .audio-preview { width: 200px !important; min-width: 200px !important; max-width: 200px !important; } .audio-slot { width: 200px; } }

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

  .record-panel { display: none; background: var(--bg-sidebar); border-top: 1px solid var(--border); padding: 6px 12px; align-items: center; justify-content: center; gap: 10px; flex-shrink: 0; height: 40px; box-sizing: border-box; }
  .record-panel.active { display: flex; }
  .recording-indicator { display: none; align-items: center; gap: 6px; font-size: 13px; color: #e53935; }
  .recording-indicator.active { display: inline-flex; }
  .recording-dot { width: 10px; height: 10px; border-radius: 50%; background: #e53935; animation: recpulse 1s infinite; }
  @keyframes recpulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  #recording-timer { font-family: monospace; font-weight: bold; color: #e53935; font-size: 14px; }
  .record-hint { font-size: 12px; color: var(--text-muted); }

  .input-bar { background: var(--bg-sidebar); padding: 10px; display: flex; gap: 10px; align-items: center; flex-shrink: 0; border-top: 1px solid var(--border); }
  .input-bar input[type="text"] { flex: 1; padding: 12px; border-radius: 20px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; min-width: 0; }
  .icon-btn { cursor: pointer; font-size: 22px; user-select: none; border: none; background: transparent; color: var(--text-main); padding: 4px; flex-shrink: 0; }
  .icon-btn.recording { color: #e53935; }

  .empty-state { margin: auto; text-align: center; color: var(--text-muted); font-size: 14px; }

  .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 2000; display: none; align-items: center; justify-content: center; }
  .modal-overlay.active { display: flex; }
  .profile-card { background: var(--bg-sidebar); width: 90%; max-width: 380px; border-radius: 16px; padding: 25px; display: flex; flex-direction: column; align-items: center; text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,0.5); position: relative; max-height: 90dvh; overflow-y: auto; }
  .profile-avatar-big { width: 90px; height: 90px; border-radius: 50%; object-fit: cover; background: var(--accent); margin-bottom: 15px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 32px; font-weight: bold; overflow: visible !important; position: relative; }
  .profile-avatar-big img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
  .profile-name { font-size: 20px; font-weight: bold; margin-bottom: 5px; }
  .profile-id { font-size: 13px; color: var(--accent); margin-bottom: 20px; }
  .profile-actions { width: 100%; display: flex; flex-direction: column; gap: 10px; }
  .profile-link-btn { background: none; border: none; color: var(--accent); font-size: 14px; font-weight: 500; cursor: pointer; padding: 5px; text-align: center; }
  .profile-link-btn:hover { text-decoration: underline; }
  .check-row { display: flex; align-items: center; gap: 10px; padding: 8px; cursor: pointer; border-bottom: 1px solid var(--border); }
  .member-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; }

  #image-viewer-modal { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.9); z-index: 3000; display: none; align-items: center; justify-content: center; }
  #image-viewer-modal.active { display: flex; }
  #image-viewer-modal img { max-width: 95vw; max-height: 95vh; border-radius: 8px; object-fit: contain; }
  .viewer-close { position: absolute; top: 20px; right: 20px; color: #fff; font-size: 30px; cursor: pointer; background: none; border: none; }

  .msg-actions-sheet { position: fixed; bottom: 0; left: 0; right: 0; background: var(--bg-sidebar); border-top-left-radius: 16px; border-top-right-radius: 16px; padding: 20px; z-index: 1001; display: none; flex-direction: column; gap: 10px; box-shadow: 0 -4px 20px rgba(0,0,0,0.4); }
  .msg-actions-sheet.active { display: flex; }

  @media (min-width: 601px) { .menu-dots-btn { display: flex !important; } }
  @media (max-width: 600px) {
    .sidebar { width: 100%; display: flex; }
    .main-chat { display: none; width: 100%; }
    .app-mobile-chat .sidebar { display: none; }
    .app-mobile-chat .main-chat { display: flex; }
    .app-mobile-chat .menu-dots-btn { display: flex !important; }
  }
  @media (orientation: landscape) and (max-width: 900px) {
    .audio-preview { width: 240px !important; min-width: 240px !important; max-width: 240px !important; }
  }
</style>
</head>
<body onclick="onBodyGlobalClick(event)">

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
              <button class="theme-toggle-btn" id="new-group-btn" onclick="openCreateGroup(event)" title="Создать группу">
                <span class="new-group-btn-icon"><span class="plus">+</span><span class="people">👥</span></span>
              </button>
              <button class="theme-toggle-btn" id="theme-toggle-btn" onclick="toggleTheme(event)" title="Сменить тему">🌙</button>
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
            <button class="menu-dots-btn" id="chat-menu-dots-btn" onclick="toggleChatDropdown(event)" title="Опции чата">⋮</button>
            <div class="chat-dropdown-menu" id="chat-dropdown-menu"></div>
          </div>
        </div>

        <div class="messages-container" id="messages-container" onscroll="checkVisibleMessages()">
          <div class="empty-state">Выберите диалог слева или найдите пользователя в поиске</div>
        </div>

        <div class="attachment-preview-container" id="attachment-preview-container">
          <img id="attachment-thumb-img" class="attachment-thumb" src="" alt="" style="display:none;">
          <div class="attachment-info">
            <div class="attachment-name" id="attachment-name-label">файл</div>
            <div style="font-size:11px; color:var(--text-muted);" id="attachment-type-label">Готово к отправке</div>
          </div>
          <span class="attachment-cancel" onclick="cancelAttachment()" title="Отменить">✕</span>
        </div>

        <div class="attachment-preview-container" id="audio-attachment-preview">
          <div class="attachment-info" style="flex:1;">
            <div class="attachment-name">Голосовое сообщение</div>
            <audio id="audio-preview-player" controls style="width:100%; margin-top:6px;"></audio>
          </div>
          <span class="attachment-cancel" onclick="cancelVoiceAttachment()" title="Отменить">✕</span>
        </div>

        <div class="record-panel" id="record-panel">
          <div class="recording-indicator active" id="recording-indicator">
            <span class="recording-dot"></span>
            <span>Запись</span>
            <span id="recording-timer">0:00</span>
          </div>
          <span class="record-hint">нажмите 🔴 для остановки</span>
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

  <div class="modal-overlay" id="my-profile-modal">
    <div class="profile-card">
      <div class="profile-avatar-big" id="my-profile-avatar-view">
        <div class="online-indicator visible" style="width:16px; height:16px; bottom:2px; right:2px;"></div>
      </div>
      <div class="profile-name" id="my-profile-name-view">Имя</div>
      <div class="profile-id" id="my-profile-id-view">ID</div>
      <div class="input-group" style="width:100%;">
        <input type="text" id="edit-my-name-input" placeholder="Ваше имя...">
      </div>
      <div class="profile-actions" style="align-items: center;">
        <button class="profile-link-btn" onclick="triggerAvatarInput()">Загрузить фото</button>
        <input type="file" id="avatar-file-input" style="display:none;" accept="image/*" onchange="handleAvatarSelect(event)">
        <button class="profile-link-btn" id="remove-avatar-link-btn" style="color: #e53935; display:none;" onclick="removeMyAvatar()">Удалить фото профиля</button>
        <button class="btn" onclick="saveMyProfileChanges()">Сохранить</button>
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
        <button class="btn btn-secondary" id="mute-peer-btn" onclick="toggleMutePeer()">Выключить звуковой сигнал</button>
        <button class="btn btn-secondary" id="block-peer-btn" onclick="toggleBlockPeer()">Заблокировать</button>
        <button class="btn btn-secondary" onclick="closePeerProfile()">Закрыть</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="create-group-modal">
    <div class="profile-card">
      <h3 style="margin-bottom:15px; color:var(--accent);">Новая группа</h3>
      <div class="profile-avatar-big" id="create-group-avatar"><span>👥</span></div>
      <button class="profile-link-btn" onclick="triggerGroupAvatarInput()">Загрузить фото группы</button>
      <input type="file" id="group-avatar-input" style="display:none;" accept="image/*" onchange="handleGroupAvatarSelect(event)">
      <div class="input-group" style="width:100%; margin-top:10px;">
        <input type="text" id="create-group-name" placeholder="Название группы...">
      </div>
      <div style="width:100%; text-align:left; font-size:13px; color:var(--text-muted); margin-bottom:8px;">Добавить участников (только те, с кем у вас есть чат):</div>
      <div id="create-group-contacts" style="width:100%; max-height:200px; overflow-y:auto; margin-bottom:10px;"></div>
      <div class="profile-actions">
        <button class="btn" onclick="submitCreateGroup()">Создать группу</button>
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
          <input type="text" id="edit-group-name" placeholder="Название группы...">
        </div>
        <button class="profile-link-btn" onclick="triggerEditGroupAvatarInput()">Изменить фото группы</button>
        <input type="file" id="edit-group-avatar-input" style="display:none;" accept="image/*" onchange="handleEditGroupAvatarSelect(event)">
        <button class="btn" onclick="saveGroupChanges()">Сохранить изменения</button>
        <button class="btn btn-secondary" onclick="openAddMembers()">Добавить участников</button>
      </div>
      <div style="width:100%; text-align:left; font-size:13px; color:var(--text-muted); margin:6px 0 5px;">Участники:</div>
      <div id="group-members-list" style="width:100%; max-height:180px; overflow-y:auto; margin-bottom:10px;"></div>
      <div class="profile-actions">
        <button class="btn btn-danger" onclick="leaveGroup()">Покинуть группу</button>
        <button class="btn btn-secondary" onclick="closeGroupProfile()">Закрыть</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="add-members-modal">
    <div class="profile-card">
      <h3 style="margin-bottom:15px; color:var(--accent);">Добавить участников</h3>
      <div style="width:100%; text-align:left; font-size:13px; color:var(--text-muted); margin-bottom:8px;">Доступны только те, с кем у вас есть чат:</div>
      <div id="add-members-contacts" style="width:100%; max-height:250px; overflow-y:auto; margin-bottom:10px;"></div>
      <div class="profile-actions">
        <button class="btn" onclick="submitAddMembers()">Добавить</button>
        <button class="btn btn-secondary" onclick="closeAddMembers()">Отмена</button>
      </div>
    </div>
  </div>

  <div id="image-viewer-modal" onclick="closeImageViewer()">
    <button class="viewer-close" onclick="closeImageViewer()">✕</button>
    <img id="full-screen-img" src="" alt="">
  </div>

  <div class="msg-actions-sheet" id="msg-actions-sheet">
    <button class="btn" id="action-btn-copy" onclick="actionCopyText()" style="display:none;">Копировать текст</button>
    <button class="btn" id="action-btn-download" onclick="actionDownloadFile()" style="display:none;">Скачать файл</button>
    <button class="btn btn-danger" onclick="deleteSelectedMessage()">Удалить сообщение</button>
    <button class="btn btn-secondary" onclick="closeMsgActions()">Отмена</button>
  </div>

  <div id="audio-pool" style="display:none; position:absolute; width:0; height:0; overflow:hidden;"></div>

  <script>
    let currentUser = null;
    let activePeer = null;
    let selectedFile = null;
    let pendingVoice = null;

    let audioChunks = [];
    let isRecording = false;
    let activeStream = null;
    let recordStartedAt = 0;
    let recordingTimerInterval = null;
    let recordAudioCtx = null, recordSourceNode = null, recordProcessor = null, recordSilentGain = null;

    let lastDialogsHash = '';
    let lastMessagesHash = '';

    let selectedMsgId = null;
    let selectedMsgObj = null;
    let longTouchTimer = null;

    let groupDraftAvatar = '';
    let editGroupDraftAvatar = '';

    let localKnownUsers = JSON.parse(localStorage.getItem('messenger_known_users') || '{}');
    let mutedPeers = JSON.parse(localStorage.getItem('messenger_muted_peers') || '[]');
    let localMessagesCache = JSON.parse(localStorage.getItem('messenger_messages_cache') || '[]');

    const savedTheme = localStorage.getItem('app_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);

    const audioPool = new Map();
    const blobUrlCache = new Map();

    function isModalOpen(id) {
      const el = document.getElementById(id);
      return el && el.classList.contains('active');
    }
    function safeOpenModal(id) {
      if (isModalOpen(id)) return false;
      document.getElementById(id).classList.add('active');
      return true;
    }
    function safeCloseModal(id) {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    }

    document.querySelectorAll('.modal-overlay').forEach(ov => {
      ov.addEventListener('click', (e) => {
        if (e.target === ov) ov.classList.remove('active');
      });
    });

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function saveCache() {
      try { localStorage.setItem('messenger_messages_cache', JSON.stringify(localMessagesCache)); } catch(e) {}
    }
    function saveKnownUsers() {
      try { localStorage.setItem('messenger_known_users', JSON.stringify(localKnownUsers)); } catch(e) {}
    }
    function mergeMessage(msg) {
      if (!msg || !msg.id) return;
      let idx = localMessagesCache.findIndex(m =>
        m.id === msg.id || (msg.clientId && m.clientId && m.clientId === msg.clientId)
      );
      if (idx !== -1) localMessagesCache[idx] = msg;
      else localMessagesCache.push(msg);
    }
    function quickHash(str) {
      if (!str) return '0';
      const len = str.length;
      const head = str.substring(0, 64);
      const tail = str.substring(Math.max(0, len - 64));
      let h = 0;
      const sample = head + '|' + tail + '|' + len;
      for (let i = 0; i < sample.length; i++) h = ((h << 5) - h + sample.charCodeAt(i)) | 0;
      return len + '_' + (h >>> 0).toString(36);
    }
    function getAudioSignature(msg) {
      return [msg.fileType || '', msg.fileName || '', quickHash(msg.fileData || '')].join('|');
    }
    function dataUrlToBlobUrl(dataUrl) {
      const commaIdx = dataUrl.indexOf(',');
      if (commaIdx === -1) return null;
      const meta = dataUrl.substring(5, commaIdx);
      const isBase64 = meta.includes(';base64');
      const mime = meta.split(';')[0] || 'audio/webm';
      let blob;
      if (isBase64) {
        const b64 = dataUrl.substring(commaIdx + 1);
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        blob = new Blob([bytes], { type: mime });
      } else {
        const decoded = decodeURIComponent(dataUrl.substring(commaIdx + 1));
        blob = new Blob([decoded], { type: mime });
      }
      return URL.createObjectURL(blob);
    }
    function getOrCreateBlobUrl(signature, fileData) {
      if (blobUrlCache.has(signature)) return blobUrlCache.get(signature);
      try {
        if (fileData && fileData.startsWith('data:')) {
          const url = dataUrlToBlobUrl(fileData);
          if (url) { blobUrlCache.set(signature, url); return url; }
        }
      } catch (e) { console.error('Blob URL error', e); }
      return fileData;
    }
    function getOrCreateAudioElement(msg) {
      const existing = audioPool.get(msg.id);
      const signature = getAudioSignature(msg);
      if (existing && existing.signature === signature) return existing.element;
      if (existing) {
        try { existing.element.pause(); } catch(e) {}
        if (existing.element.parentNode) existing.element.parentNode.removeChild(existing.element);
        audioPool.delete(msg.id);
      }
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.className = 'audio-preview';
      audio.preload = 'metadata';
      audio.setAttribute('controlsList', 'nodownload');
      audio.src = getOrCreateBlobUrl(signature, msg.fileData);
      audio.addEventListener('click', e => e.stopPropagation());
      audio.addEventListener('contextmenu', e => e.stopPropagation());
      audio.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
      document.getElementById('audio-pool').appendChild(audio);
      audioPool.set(msg.id, { element: audio, signature });
      return audio;
    }
    function cleanupAudioPool(validMsgIds) {
      const validSet = new Set(validMsgIds);
      for (const [msgId, entry] of Array.from(audioPool.entries())) {
        if (!validSet.has(msgId)) {
          try { entry.element.pause(); } catch(e) {}
          if (entry.element.parentNode) entry.element.parentNode.removeChild(entry.element);
          audioPool.delete(msgId);
        }
      }
      const usedSignatures = new Set(Array.from(audioPool.values()).map(v => v.signature));
      for (const [sig, url] of Array.from(blobUrlCache.entries())) {
        if (!usedSignatures.has(sig)) {
          try { URL.revokeObjectURL(url); } catch(e) {}
          blobUrlCache.delete(sig);
        }
      }
    }
    function pauseAllAudio() {
      for (const entry of audioPool.values()) { try { entry.element.pause(); } catch(e) {} }
    }
    function playNotificationSound() {
      try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, audioCtx.currentTime);
        osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(); osc.stop(audioCtx.currentTime + 0.3);
      } catch(e) {}
    }

    window.addEventListener('DOMContentLoaded', () => {
      const savedUser = localStorage.getItem('messenger_user');
      if (savedUser) {
        try { currentUser = JSON.parse(savedUser); startApp(); } catch(e) {}
      }
    });

    function toggleTheme(e) {
      if (e) e.stopPropagation();
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
    function toggleChatDropdown(e) {
      if (e) e.stopPropagation();
      const menu = document.getElementById('chat-dropdown-menu');
      if (!menu) return;
      menu.classList.toggle('active');
    }
    function closeChatDropdown() {
      const menu = document.getElementById('chat-dropdown-menu');
      if (menu) menu.classList.remove('active');
    }
    function onBodyGlobalClick(e) {
      const menu = document.getElementById('chat-dropdown-menu');
      const dotsBtn = document.getElementById('chat-menu-dots-btn');
      if (menu && menu.classList.contains('active')) {
        if (!menu.contains(e.target) && e.target !== dotsBtn && !dotsBtn.contains(e.target)) {
          menu.classList.remove('active');
        }
      }
    }
    function fillAvatarBox(el, avatar, fallback) {
      if (!el) return;
      const indicator = el.querySelector('.online-indicator');
      Array.from(el.childNodes).forEach(node => { if (node !== indicator) el.removeChild(node); });
      if (avatar) {
        const img = document.createElement('img'); img.src = avatar;
        indicator ? el.insertBefore(img, indicator) : el.appendChild(img);
      } else {
        const span = document.createElement('span'); span.innerText = fallback || '?';
        indicator ? el.insertBefore(span, indicator) : el.appendChild(span);
      }
    }
    function renderAvatarIntoElement(el, userObj, isOnline) {
      if (!el) return;
      const indicator = el.querySelector('.online-indicator');
      Array.from(el.childNodes).forEach(node => { if (node !== indicator) el.removeChild(node); });
      if (userObj && userObj.avatar) {
        const img = document.createElement('img'); img.src = userObj.avatar; el.insertBefore(img, indicator);
      } else if (userObj && userObj.name) {
        const span = document.createElement('span'); span.innerText = userObj.name.charAt(0).toUpperCase(); el.insertBefore(span, indicator);
      } else {
        const span = document.createElement('span'); span.innerText = '?'; el.insertBefore(span, indicator);
      }
      if (indicator) {
        if (isOnline) indicator.classList.add('visible'); else indicator.classList.remove('visible');
      }
    }

    async function registerUser() {
      const nameInput = document.getElementById('auth-name');
      const name = nameInput.value.trim();
      const errBox = document.getElementById('auth-error');
      if (!name) { errBox.innerText = 'Введите ваше имя.'; errBox.style.display = 'block'; return; }
      try {
        const res = await fetch('/api/register', {
          method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (!data.success) { errBox.innerText = data.error || 'Ошибка входа'; errBox.style.display = 'block'; }
        else {
          currentUser = data.user;
          localStorage.setItem('messenger_user', JSON.stringify(currentUser));
          startApp();
        }
      } catch(e) { errBox.innerText = 'Ошибка подключения к серверу.'; errBox.style.display = 'block'; }
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
          if (activePeer) {
            loadMessagesQuiet();
            if (activePeer.type === 'group') refreshGroupInfo();
            else refreshActivePeerStatus();
          }
        }
      }, 2000);
      window.addEventListener('online', resendPendingMessages);
    }

    async function resendPendingMessages() {
      if (!currentUser) return;
      const pending = localMessagesCache.filter(m => m.isPending && m.senderId === currentUser.id);
      for (const pm of pending) {
        localMessagesCache = localMessagesCache.filter(m => m.clientId !== pm.clientId);
        saveCache();
        if (activePeer && (
          (activePeer.type === 'group' && pm.groupId === activePeer.id) ||
          (activePeer.type !== 'group' && pm.receiverId === activePeer.id)
        )) {
          renderMessagesContainer(getChatMessages(activePeer));
        }
        try {
          const res = await fetch('/api/messages/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              senderId: pm.senderId,
              receiverId: pm.receiverId,
              groupId: pm.groupId,
              text: pm.text,
              fileData: pm.fileData,
              fileName: pm.fileName,
              fileType: pm.fileType,
              clientId: pm.clientId
            })
          });
          if (res.ok) {
            const data = await res.json();
            if (data && data.message) {
              mergeMessage({ ...data.message, isPending: false });
              saveCache();
              if (activePeer) renderMessagesContainer(getChatMessages(activePeer));
            }
          }
        } catch(e) {}
      }
    }

    function updateMyProfileUI() {
      document.getElementById('my-display-name').innerText = currentUser.name;
      document.getElementById('my-display-id').innerText = 'ID: ' + currentUser.id;
      renderAvatarIntoElement(document.getElementById('my-avatar-circle'), currentUser, true);
    }

    async function sendPing() {
      if (!currentUser) return;
      try {
        const knownList = Object.values(localKnownUsers);
        const res = await fetch('/api/ping', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar || '',
            contacts: currentUser.contacts || [], knownUsers: knownList
          })
        });
        const data = await res.json();
        if (data.success && data.user && data.user.id !== currentUser.id) {
          currentUser.id = data.user.id;
          localStorage.setItem('messenger_user', JSON.stringify(currentUser));
          updateMyProfileUI();
        }
      } catch(e) {}
    }

    async function refreshActivePeerStatus() {
      if (!activePeer || activePeer.type === 'group') return;
      try {
        const res = await fetch('/api/users/' + activePeer.id);
        if (res.ok) {
          const info = await res.json();
          activePeer.isOnline = info.isOnline; activePeer.name = info.name; activePeer.avatar = info.avatar;
          const statusEl = document.getElementById('active-peer-status');
          if (info.isOnline) { statusEl.innerText = 'в сети'; statusEl.style.color = '#4cd964'; }
          else { statusEl.innerText = 'не в сети'; statusEl.style.color = 'var(--text-muted)'; }
          renderAvatarIntoElement(document.getElementById('peer-avatar-circle'), activePeer, info.isOnline);
        }
      } catch(e) {}
    }

    function cacheUser(user) {
      if (!user || !user.id || user.type === 'group') return;
      localKnownUsers[user.id] = { id: user.id, name: user.name, avatar: user.avatar };
      saveKnownUsers();
    }
    function getUserName(id) {
      if (id === currentUser.id) return currentUser.name;
      if (localKnownUsers[id]) return localKnownUsers[id].name;
      if (activePeer && activePeer.memberDetails) {
        const m = activePeer.memberDetails.find(x => x.id === id);
        if (m) return m.name;
      }
      return 'Пользователь';
    }

    function getChatMessages(chat) {
      let list;
      if (chat.type === 'group') {
        list = localMessagesCache.filter(m => !m.isDeleted && m.groupId === chat.id);
      } else {
        list = localMessagesCache.filter(m => !m.isDeleted && !m.groupId && (
          (m.senderId === currentUser.id && m.receiverId === chat.id) ||
          (m.senderId === chat.id && m.receiverId === currentUser.id)
        ));
      }
      return list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    }

    function openMyProfile() {
      if (isModalOpen('my-profile-modal')) return;
      document.getElementById('edit-my-name-input').value = currentUser.name;
      renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), currentUser, true);
      document.getElementById('my-profile-name-view').innerText = currentUser.name;
      document.getElementById('my-profile-id-view').innerText = 'ID: ' + currentUser.id;
      document.getElementById('remove-avatar-link-btn').style.display = currentUser.avatar ? 'block' : 'none';
      safeOpenModal('my-profile-modal');
    }
    function closeMyProfile() { safeCloseModal('my-profile-modal'); }
    function triggerAvatarInput() { const i = document.getElementById('avatar-file-input'); i.value = ''; i.click(); }
    function handleAvatarSelect(e) {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = function(evt) {
        currentUser.avatar = evt.target.result;
        renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), currentUser, true);
        document.getElementById('remove-avatar-link-btn').style.display = 'block';
      };
      reader.readAsDataURL(file);
    }
    function removeMyAvatar() {
      currentUser.avatar = '';
      renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), currentUser, true);
      document.getElementById('remove-avatar-link-btn').style.display = 'none';
    }
    async function saveMyProfileChanges() {
      const newName = document.getElementById('edit-my-name-input').value.trim();
      if (newName) currentUser.name = newName;
      try {
        const res = await fetch('/api/profile/update', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar })
        });
        const data = await res.json();
        if (data.success) {
          currentUser = data.user;
          localStorage.setItem('messenger_user', JSON.stringify(currentUser));
          updateMyProfileUI(); closeMyProfile();
        }
      } catch(e) { alert('Не удалось обновить профиль'); }
    }

    function openPeerProfile() {
      if (!activePeer) return;
      if (activePeer.type === 'group') { openGroupProfile(); return; }
      if (isModalOpen('peer-profile-modal')) return;
      renderAvatarIntoElement(document.getElementById('peer-profile-avatar-view'), activePeer, activePeer.isOnline);
      document.getElementById('peer-profile-name-view').innerText = activePeer.name;
      document.getElementById('peer-profile-id-view').innerText = 'ID: ' + activePeer.id;
      const blockBtn = document.getElementById('block-peer-btn');
      const isBlocked = currentUser.blockedContacts && currentUser.blockedContacts.includes(activePeer.id);
      blockBtn.innerText = isBlocked ? 'Разблокировать' : 'Заблокировать';
      blockBtn.className = isBlocked ? 'btn btn-secondary' : 'btn btn-danger';
      const muteBtn = document.getElementById('mute-peer-btn');
      const isMuted = mutedPeers.includes(activePeer.id);
      muteBtn.innerText = isMuted ? 'Включить звуковой сигнал' : 'Выключить звуковой сигнал';
      muteBtn.className = isMuted ? 'btn' : 'btn btn-secondary';
      safeOpenModal('peer-profile-modal');
    }
    function closePeerProfile() { safeCloseModal('peer-profile-modal'); }
    function toggleMutePeer() {
      if (!activePeer) return;
      const index = mutedPeers.indexOf(activePeer.id);
      if (index > -1) { mutedPeers.splice(index, 1); alert('Звуковой сигнал включен'); }
      else { mutedPeers.push(activePeer.id); alert('Звуковой сигнал выключен'); }
      localStorage.setItem('messenger_muted_peers', JSON.stringify(mutedPeers));
      openPeerProfile();
    }
    async function toggleBlockPeer() {
      if (!activePeer) return;
      const isBlocked = currentUser.blockedContacts && currentUser.blockedContacts.includes(activePeer.id);
      const nextBlock = !isBlocked;
      try {
        const res = await fetch('/api/users/block', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ userId: currentUser.id, peerId: activePeer.id, block: nextBlock })
        });
        const data = await res.json();
        if (data.success) {
          currentUser.blockedContacts = data.blockedContacts;
          localStorage.setItem('messenger_user', JSON.stringify(currentUser));
          closePeerProfile();
          alert(nextBlock ? 'Пользователь заблокирован' : 'Пользователь разблокирован');
        }
      } catch(e) { alert('Ошибка при изменении статуса блокировки'); }
    }

    function updateChatMenu() {
      const menu = document.getElementById('chat-dropdown-menu');
      if (activePeer && activePeer.type === 'group') {
        menu.innerHTML =
          '<button class="menu-item" onclick="openGroupProfile()">Профиль группы</button>' +
          '<button class="menu-item" onclick="clearChatHistory()">Очистить историю</button>' +
          '<button class="menu-item danger" onclick="leaveGroup()">Покинуть группу</button>';
      } else {
        menu.innerHTML =
          '<button class="menu-item" onclick="clearChatHistory()">Очистить историю</button>' +
          '<button class="menu-item danger" onclick="deleteCurrentChat()">Удалить чат</button>';
      }
    }

    async function clearChatHistory() {
      closeChatDropdown();
      if (!activePeer || !confirm('Очистить всю историю этого чата?')) return;
      const isGroup = activePeer.type === 'group';
      try {
        await fetch('/api/chat/clear', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(isGroup ? { userId: currentUser.id, groupId: activePeer.id } : { userId: currentUser.id, peerId: activePeer.id })
        });
        getChatMessages(activePeer).forEach(m => { m.isDeleted = true; });
        saveCache(); lastMessagesHash = ''; loadMessages();
      } catch(e) { alert('Не удалось очистить историю'); }
    }

    async function deleteCurrentChat() {
      closeChatDropdown();
      if (!activePeer || !confirm('Удалить чат? Он исчезнет из списка, пока вы снова не напишете этому человеку.')) return;
      try {
        await fetch('/api/chat/hide', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ userId: currentUser.id, peerId: activePeer.id })
        });
        resetActiveChat(); loadDialogs();
      } catch(e) { alert('Не удалось удалить чат'); }
    }

    function resetActiveChat() {
      pauseAllAudio(); cancelVoiceAttachment(); cancelAttachment(); closeMobileChat(); activePeer = null;
      document.getElementById('input-bar').style.display = 'none';
      document.getElementById('active-peer-name').innerText = 'Выберите чат';
      document.getElementById('active-peer-status').innerText = 'нажмите для профиля';
      document.getElementById('messages-container').innerHTML = '<div class="empty-state">Выберите диалог слева или найдите пользователя в поиске</div>';
    }

    async function loadDialogs() {
      if (document.getElementById('search-input').value.trim()) return;
      try {
        const res = await fetch('/api/dialogs/' + currentUser.id);
        const dialogs = await res.json();
        dialogs.forEach(d => cacheUser(d));
        lastDialogsHash = JSON.stringify(dialogs);
        renderChatList(dialogs);
      } catch(e) {
        const fallback = Object.values(localKnownUsers).map(u => ({
          id: u.id, type: 'user', name: u.name, avatar: u.avatar || '', isOnline: false, lastTs: 0
        }));
        if (fallback.length) renderChatList(fallback);
      }
    }
    async function loadDialogsQuiet() {
      if (document.getElementById('search-input').value.trim()) return;
      try {
        const res = await fetch('/api/dialogs/' + currentUser.id);
        const dialogs = await res.json();
        dialogs.forEach(d => cacheUser(d));
        const currentHash = JSON.stringify(dialogs);
        if (currentHash !== lastDialogsHash) { lastDialogsHash = currentHash; renderChatList(dialogs); }
      } catch(e) {}
    }

    async function onSearchInput() {
      const q = document.getElementById('search-input').value.trim();
      const clearBtn = document.getElementById('clear-search-btn');
      if (!q) {
        clearBtn.style.display = 'none';
        lastDialogsHash = '';
        loadDialogs();
        return;
      }
      clearBtn.style.display = 'block';
      try {
        const res = await fetch('/api/users/search?q=' + encodeURIComponent(q));
        const users = await res.json();
        users.forEach(u => cacheUser(u));
        renderChatList(users.filter(u => u.id !== currentUser.id));
      } catch(e) {
        const ql = q.toLowerCase();
        const found = Object.values(localKnownUsers).filter(u =>
          (u.id && u.id.toLowerCase().includes(ql)) ||
          (u.name && u.name.toLowerCase().includes(ql))
        ).map(u => ({ id: u.id, type: 'user', name: u.name, avatar: u.avatar || '', isOnline: false }));
        renderChatList(found.filter(u => u.id !== currentUser.id));
      }
    }
    function clearSearch() {
      document.getElementById('search-input').value = '';
      document.getElementById('clear-search-btn').style.display = 'none';
      lastDialogsHash = '';
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
        const isGroup = item.type === 'group';
        const div = document.createElement('div');
        div.className = 'chat-item ' + (currentActiveId === item.id ? 'active' : '');
        div.onclick = () => openChat(item);
        const avatarId = 'chat_av_' + item.id;
        let subtitle;
        if (isGroup) subtitle = '<span style="color:var(--text-muted);">👥 ' + (item.memberCount || (item.members ? item.members.length : 0)) + ' участников</span>';
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
        const avEl = document.getElementById(avatarId);
        if (isGroup) fillAvatarBox(avEl, item.avatar, '👥');
        else renderAvatarIntoElement(avEl, item, item.isOnline);
      });
    }

    function openChat(peer) {
      pauseAllAudio();
      cancelVoiceAttachment();
      if (!peer.type) peer.type = 'user';
      activePeer = peer;
      lastMessagesHash = '';
      document.getElementById('active-peer-name').innerText = peer.name;
      const statusEl = document.getElementById('active-peer-status');
      if (peer.type === 'group') {
        statusEl.innerText = (peer.memberCount || (peer.members ? peer.members.length : 0)) + ' участников';
        statusEl.style.color = 'var(--text-muted)';
        renderAvatarIntoElement(document.getElementById('peer-avatar-circle'), peer, false);
      } else {
        if (peer.isOnline) { statusEl.innerText = 'в сети'; statusEl.style.color = '#4cd964'; }
        else { statusEl.innerText = 'не в сети'; statusEl.style.color = 'var(--text-muted)'; }
        renderAvatarIntoElement(document.getElementById('peer-avatar-circle'), peer, peer.isOnline);
        if (!currentUser.contacts) currentUser.contacts = [];
        if (!currentUser.contacts.includes(peer.id)) {
          currentUser.contacts.push(peer.id);
          localStorage.setItem('messenger_user', JSON.stringify(currentUser));
        }
      }
      document.getElementById('input-bar').style.display = 'flex';
      updateChatMenu();
      document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
      if (window.innerWidth <= 600) {
        document.getElementById('app-screen').classList.add('app-mobile-chat');
        document.getElementById('back-to-list-btn').style.display = 'block';
      }
      loadMessages();
      if (peer.type === 'group') refreshGroupInfo();
    }

    function closeMobileChat() {
      pauseAllAudio();
      document.getElementById('app-screen').classList.remove('app-mobile-chat');
    }

    function msgFetchUrl() {
      return activePeer.type === 'group'
        ? '/api/messages/group/' + activePeer.id + '?userId=' + encodeURIComponent(currentUser.id)
        : '/api/messages/' + currentUser.id + '/' + activePeer.id;
    }

    async function loadMessages() {
      if (!activePeer) return;
      try {
        const res = await fetch(msgFetchUrl());
        const messages = await res.json();
        messages.forEach(mergeMessage);
        saveCache();
        renderMessagesContainer(getChatMessages(activePeer));
        checkVisibleMessages();
      } catch(e) { renderMessagesContainer(getChatMessages(activePeer)); }
    }

    async function loadMessagesQuiet() {
      if (!activePeer) return;
      try {
        const res = await fetch(msgFetchUrl());
        const messages = await res.json();
        let hasNewMsg = false;
        messages.forEach(msg => {
          const known = localMessagesCache.some(m => m.id === msg.id || (msg.clientId && m.clientId === msg.clientId));
          if (!known && msg.senderId !== currentUser.id) hasNewMsg = true;
          mergeMessage(msg);
        });
        saveCache();
        const peerMsgs = getChatMessages(activePeer);
        const currentHash = JSON.stringify(peerMsgs.map(m => m.id + '_' + m.isRead + '_' + (m.readBy ? m.readBy.length : 0) + '_' + m.isDeleted));
        if (currentHash !== lastMessagesHash) {
          if (hasNewMsg && lastMessagesHash !== '' && !mutedPeers.includes(activePeer.id)) playNotificationSound();
          lastMessagesHash = currentHash;
          renderMessagesContainer(peerMsgs);
          checkVisibleMessages();
        }
      } catch(e) {}
    }

    function openImageViewer(src) {
      if (document.getElementById('image-viewer-modal').classList.contains('active')) return;
      document.getElementById('full-screen-img').src = src;
      document.getElementById('image-viewer-modal').classList.add('active');
    }
    function closeImageViewer() { document.getElementById('image-viewer-modal').classList.remove('active'); }

    function isGroupMsgRead(m) {
      if (!activePeer || activePeer.type !== 'group') return m.isRead;
      const others = (activePeer.members || []).filter(x => x !== currentUser.id);
      const rb = (m.readBy || []).filter(x => x !== currentUser.id);
      return others.length > 0 && rb.length >= others.length;
    }

    function renderMessagesContainer(messages) {
      const container = document.getElementById('messages-container');
      const isScrolledToBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 80;
      container.innerHTML = '';
      if (!messages || messages.length === 0) {
        cleanupAudioPool([]);
        container.innerHTML = '<div class="empty-state">Нет сообщений. Напишите первыми!</div>';
        return;
      }
      const isGroup = activePeer && activePeer.type === 'group';
      const validIds = [];
      messages.forEach(m => {
        const div = document.createElement('div');
        div.className = 'msg ' + (m.senderId === currentUser.id ? 'my' : '') + (m.isPending ? ' pending' : '');
        div.setAttribute('data-msg-id', m.id);
        div.setAttribute('data-sender-id', m.senderId);

        div.oncontextmenu = (e) => {
          if (e.target.tagName === 'AUDIO' || (e.target.closest && e.target.closest('audio'))) return;
          e.preventDefault(); openMsgActions(m, div);
        };
        div.ontouchstart = (e) => {
          if (e.target.tagName === 'AUDIO' || (e.target.closest && e.target.closest('audio'))) return;
          longTouchTimer = setTimeout(() => openMsgActions(m, div), 500);
        };
        div.ontouchend = () => clearTimeout(longTouchTimer);
        div.ontouchmove = () => clearTimeout(longTouchTimer);

        let html = '';
        if (isGroup && m.senderId !== currentUser.id) {
          html += '<div class="msg-sender">' + escapeHtml(getUserName(m.senderId)) + '</div>';
        }
        if (m.text) html += '<div>' + escapeHtml(m.text) + '</div>';

        const fileType = m.fileType || '';
        if (m.fileData) {
          if (fileType.startsWith('image/')) {
            html += '<img src="' + m.fileData + '" class="media-preview" data-full="1">';
          } else if (fileType.startsWith('video/')) {
            html += '<video src="' + m.fileData + '" controls class="video-preview"></video>';
          } else if (fileType.startsWith('audio/')) {
            html += '<div class="audio-slot" data-audio-msg-id="' + m.id + '"></div>';
            validIds.push(m.id);
          } else {
            html += '<a class="file-link" data-download="1">📁 ' + escapeHtml(m.fileName || 'Файл') + '</a>';
          }
        }

        let ticksHtml = '';
        if (m.senderId === currentUser.id) {
          const read = isGroupMsgRead(m);
          const isReadClass = read ? 'ticks read' : 'ticks';
          const ticksSymbol = m.isPending ? '🕐' : (read ? '✓✓' : '✓');
          ticksHtml = '<span class="' + isReadClass + '">' + ticksSymbol + '</span>';
        }
        html += '<div class="msg-footer"><span>' + escapeHtml(m.timestamp || '') + '</span>' + ticksHtml + '</div>';

        div.innerHTML = html;

        const imgEl = div.querySelector('img[data-full]');
        if (imgEl) imgEl.addEventListener('click', (e) => { e.stopPropagation(); openImageViewer(m.fileData); });
        const dl = div.querySelector('a[data-download]');
        if (dl) dl.addEventListener('click', (e) => { e.stopPropagation(); downloadData(m.fileData, m.fileName); });

        const slot = div.querySelector('.audio-slot');
        if (slot) slot.replaceWith(getOrCreateAudioElement(m));

        container.appendChild(div);
      });
      cleanupAudioPool(validIds);
      if (isScrolledToBottom) container.scrollTop = container.scrollHeight;
    }

    function downloadData(data, name) {
      if (!data) return;
      const a = document.createElement('a');
      a.href = data; a.download = name || 'download';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }

    function checkVisibleMessages() {
      if (!activePeer) return;
      const container = document.getElementById('messages-container');
      const msgElements = container.querySelectorAll('.msg');
      const containerRect = container.getBoundingClientRect();
      const isGroup = activePeer.type === 'group';
      let unreadMsgIds = [];
      msgElements.forEach(el => {
        const senderId = el.getAttribute('data-sender-id');
        const msgId = el.getAttribute('data-msg-id');
        if (senderId === currentUser.id || msgId.startsWith('tmp_') || msgId.startsWith('cid_')) return;
        const rect = el.getBoundingClientRect();
        if (rect.top >= containerRect.top && rect.bottom <= containerRect.bottom) {
          let msgObj = localMessagesCache.find(m => m.id === msgId);
          if (!msgObj || msgObj.isPending) return;
          if (isGroup) {
            if (!msgObj.readBy) msgObj.readBy = [];
            if (!msgObj.readBy.includes(currentUser.id)) { msgObj.readBy.push(currentUser.id); unreadMsgIds.push(msgId); }
          } else if (!msgObj.isRead) { msgObj.isRead = true; unreadMsgIds.push(msgId); }
        }
      });
      if (unreadMsgIds.length > 0) {
        saveCache();
        fetch('/api/messages/read', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ msgIds: unreadMsgIds, userId: currentUser.id })
        }).catch(e => {});
      }
    }

    function openMsgActions(msg, element) {
      if (msg.isPending) return;
      if (document.getElementById('msg-actions-sheet').classList.contains('active')) return;
      selectedMsgId = msg.id; selectedMsgObj = msg;
      document.querySelectorAll('.msg').forEach(el => el.classList.remove('selected-msg'));
      element.classList.add('selected-msg');
      document.getElementById('action-btn-copy').style.display = (msg.text && !msg.fileData) ? 'block' : 'none';
      document.getElementById('action-btn-download').style.display = msg.fileData ? 'block' : 'none';
      document.getElementById('msg-actions-sheet').classList.add('active');
    }
    function closeMsgActions() {
      selectedMsgId = null; selectedMsgObj = null;
      document.querySelectorAll('.msg').forEach(el => el.classList.remove('selected-msg'));
      document.getElementById('msg-actions-sheet').classList.remove('active');
    }
    function actionCopyText() {
      const t = selectedMsgObj && selectedMsgObj.text;
      closeMsgActions();
      if (t) navigator.clipboard.writeText(t).catch(() => {});
    }
    function actionDownloadFile() {
      const obj = selectedMsgObj;
      closeMsgActions();
      if (obj && obj.fileData) downloadData(obj.fileData, obj.fileName);
    }
    async function deleteSelectedMessage() {
      const id = selectedMsgId;
      closeMsgActions();
      if (!id) return;
      localMessagesCache.forEach(m => { if (m.id === id) m.isDeleted = true; });
      saveCache();
      lastMessagesHash = '';
      if (activePeer) renderMessagesContainer(getChatMessages(activePeer));
      try { await fetch('/api/messages/' + id, { method: 'DELETE' }); }
      catch(e) { alert('Не удалось удалить сообщение на сервере.'); }
    }

    function triggerFileInput() { document.getElementById('file-input').click(); }
    function handleFileSelect(e) {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = function(evt) {
        selectedFile = { data: evt.target.result, name: file.name, type: file.type };
        const thumbImg = document.getElementById('attachment-thumb-img');
        document.getElementById('attachment-name-label').innerText = file.name;
        const typeLabel = document.getElementById('attachment-type-label');
        if (file.type.startsWith('image/')) {
          thumbImg.src = evt.target.result; thumbImg.style.display = 'block'; typeLabel.innerText = 'Фото';
        } else {
          thumbImg.src = ''; thumbImg.style.display = 'none';
          typeLabel.innerText = file.type.startsWith('video/') ? 'Видео' : (file.type.startsWith('audio/') ? 'Аудио' : 'Файл');
        }
        document.getElementById('attachment-preview-container').classList.add('active');
      };
      reader.readAsDataURL(file);
    }
    function cancelAttachment() {
      selectedFile = null;
      document.getElementById('file-input').value = '';
      document.getElementById('attachment-preview-container').classList.remove('active');
    }

    function cancelVoiceAttachment() {
      if (pendingVoice && pendingVoice.url && pendingVoice.url.startsWith('blob:')) {
        try { URL.revokeObjectURL(pendingVoice.url); } catch(e) {}
      }
      pendingVoice = null;
      const box = document.getElementById('audio-attachment-preview');
      if (box) box.classList.remove('active');
      const player = document.getElementById('audio-preview-player');
      if (player) {
        player.pause();
        player.removeAttribute('src');
        try { player.load(); } catch(e) {}
      }
    }

    function floatTo16BitPCM(output, offset, input) {
      for (let i = 0; i < input.length; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, input[i]));
        s = s < 0 ? s * 0x8000 : s * 0x7FFF;
        output.setInt16(offset, s, true);
      }
    }
    function writeString(view, offset, string) { for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i)); }
    function encodeWAV(samples, sampleRate) {
      const buffer = new ArrayBuffer(44 + samples.length * 2);
      const view = new DataView(buffer);
      writeString(view, 0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true);
      writeString(view, 8, 'WAVE'); writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      writeString(view, 36, 'data'); view.setUint32(40, samples.length * 2, true);
      floatTo16BitPCM(view, 44, samples);
      return new Blob([view], { type: 'audio/wav' });
    }
    function cleanupRecordingNodes() {
      try { if (recordProcessor) recordProcessor.disconnect(); } catch(e) {}
      try { if (recordSourceNode) recordSourceNode.disconnect(); } catch(e) {}
      try { if (recordSilentGain) recordSilentGain.disconnect(); } catch(e) {}
      try { if (recordAudioCtx && recordAudioCtx.state !== 'closed') recordAudioCtx.close(); } catch(e) {}
      recordProcessor = recordSourceNode = recordSilentGain = recordAudioCtx = null;
    }
    function startRecordingTimer() {
      recordStartedAt = Date.now();
      const panel = document.getElementById('record-panel');
      const timerEl = document.getElementById('recording-timer');
      panel.classList.add('active'); timerEl.innerText = '0:00';
      if (recordingTimerInterval) clearInterval(recordingTimerInterval);
      recordingTimerInterval = setInterval(() => {
        const s = Math.floor((Date.now() - recordStartedAt) / 1000);
        timerEl.innerText = Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0');
      }, 200);
    }
    function stopRecordingTimer() {
      document.getElementById('record-panel').classList.remove('active');
      if (recordingTimerInterval) { clearInterval(recordingTimerInterval); recordingTimerInterval = null; }
    }

    async function toggleVoiceRecord() {
      const micBtn = document.getElementById('mic-btn');
      if (isRecording) {
        isRecording = false; micBtn.innerText = '🎙️'; micBtn.classList.remove('recording'); stopRecordingTimer();
        const chunks = audioChunks.slice();
        const capturedRate = recordAudioCtx ? recordAudioCtx.sampleRate : 48000;
        cleanupRecordingNodes();
        try { if (activeStream) activeStream.getTracks().forEach(t => t.stop()); } catch(e) {}
        activeStream = null;
        if (chunks.length === 0) { alert('Запись получилась пустой.'); return; }
        let totalLen = 0; for (const c of chunks) totalLen += c.length;
        const merged = new Float32Array(totalLen);
        let off = 0; for (const c of chunks) { merged.set(c, off); off += c.length; }
        const targetRate = 16000;
        let finalSamples = merged, finalRate = capturedRate;
        if (capturedRate > targetRate) {
          const ratio = capturedRate / targetRate;
          const newLen = Math.floor(merged.length / ratio);
          const down = new Float32Array(newLen);
          for (let i = 0; i < newLen; i++) down[i] = merged[Math.floor(i * ratio)] || 0;
          finalSamples = down; finalRate = targetRate;
        }
        const wavBlob = encodeWAV(finalSamples, finalRate);
        const reader = new FileReader();
        reader.onload = function(evt) {
          cancelVoiceAttachment();
          const dataUrl = evt.target.result;
          let url = '';
          try { url = URL.createObjectURL(wavBlob); } catch(e) { url = dataUrl; }
          pendingVoice = { data: dataUrl, name: 'voice_' + Date.now() + '.wav', type: 'audio/wav', url };
          const player = document.getElementById('audio-preview-player');
          player.src = url;
          document.getElementById('audio-attachment-preview').classList.add('active');
        };
        reader.readAsDataURL(wavBlob);
        return;
      }
      if (!activePeer) { alert('Сначала выберите чат.'); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { alert('Ваш браузер не поддерживает запись с микрофона.'); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false
        });
        activeStream = stream;
        const AC = window.AudioContext || window.webkitAudioContext;
        const ctx = new AC(); recordAudioCtx = ctx;
        if (ctx.state === 'suspended') { try { await ctx.resume(); } catch(e) {} }
        const source = ctx.createMediaStreamSource(stream); recordSourceNode = source;
        const processor = ctx.createScriptProcessor(4096, 1, 1); recordProcessor = processor; audioChunks = [];
        processor.onaudioprocess = (e) => { if (!isRecording) return; audioChunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
        const silentGain = ctx.createGain(); silentGain.gain.value = 0; recordSilentGain = silentGain;
        source.connect(processor); processor.connect(silentGain); silentGain.connect(ctx.destination);
        isRecording = true; micBtn.innerText = '🔴'; micBtn.classList.add('recording'); startRecordingTimer();
      } catch (err) {
        console.error('getUserMedia error', err);
        let msg = 'Нет доступа к микрофону.';
        if (err && err.name === 'NotAllowedError') msg = 'Вы отклонили доступ к микрофону.';
        else if (err && err.name === 'NotFoundError') msg = 'Микрофон не найден.';
        else if (err && err.name === 'NotReadableError') msg = 'Микрофон занят другим приложением.';
        alert(msg);
        cleanupRecordingNodes();
        try { if (activeStream) activeStream.getTracks().forEach(t => t.stop()); } catch(e) {}
        activeStream = null; isRecording = false; micBtn.innerText = '🎙️'; micBtn.classList.remove('recording'); stopRecordingTimer();
      }
    }

    async function sendMessagePayload({ text = '', file = null }) {
      if (!activePeer) return;
      const isGroup = activePeer.type === 'group';
      const clientId = 'cid_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
      const optimisticMsg = {
        id: clientId, clientId,
        senderId: currentUser.id,
        receiverId: isGroup ? '' : activePeer.id,
        groupId: isGroup ? activePeer.id : '',
        text, fileData: file ? file.data : '', fileName: file ? file.name : '', fileType: file ? file.type : '',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        ts: Date.now(), isRead: false, readBy: [], isDeleted: false, isPending: true
      };
      mergeMessage(optimisticMsg);
      renderMessagesContainer(getChatMessages(activePeer));
      const container = document.getElementById('messages-container');
      container.scrollTop = container.scrollHeight;

      const body = {
        senderId: currentUser.id,
        receiverId: isGroup ? '' : activePeer.id,
        groupId: isGroup ? activePeer.id : '',
        text, fileData: file ? file.data : '', fileName: file ? file.name : '', fileType: file ? file.type : '',
        clientId
      };
      const payloadStr = JSON.stringify(body);

      const maxAttempts = 3;
      let lastErr = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 90000);
        try {
          const res = await fetch('/api/messages/send', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: payloadStr, signal: controller.signal
          });
          clearTimeout(timeoutId);
          if (res.status === 403) {
            localMessagesCache = localMessagesCache.filter(m => m.clientId !== clientId);
            saveCache();
            renderMessagesContainer(getChatMessages(activePeer));
            alert('Сообщение не доставлено: чат заблокирован.');
            return;
          }
          if (!res.ok) {
            let errText = 'Ошибка сервера (' + res.status + ')';
            try { const j = await res.json(); if (j && j.error) errText = j.error; } catch(e) {}
            throw new Error(errText);
          }
          const data = await res.json();
          if (data && data.message) {
            const realMsg = { ...data.message, isPending: false };
            mergeMessage(realMsg);
            saveCache();
            renderMessagesContainer(getChatMessages(activePeer));
            loadDialogsQuiet();
            return;
          } else { throw new Error('Пустой ответ сервера'); }
        } catch (e) {
          clearTimeout(timeoutId);
          lastErr = e;
          const isAbort = e && e.name === 'AbortError';
          const isNetwork = e && (e.name === 'TypeError' || /network|failed/i.test(String(e.message)));
          if (!isAbort && !isNetwork) break;
          if (attempt < maxAttempts - 1) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        }
      }
      console.warn('Не удалось отправить сообщение после попыток:', lastErr);
    }

    async function sendMsg() {
      if (!activePeer) return;
      const input = document.getElementById('msg-input');
      const text = input.value.trim();
      const fileToSend = selectedFile;
      const voiceToSend = pendingVoice;
      if (!text && !fileToSend && !voiceToSend) return;
      input.value = '';
      if (voiceToSend) {
        const voiceData = { data: voiceToSend.data, name: voiceToSend.name, type: voiceToSend.type };
        cancelVoiceAttachment();
        sendMessagePayload({ text: '', file: voiceData });
        return;
      }
      cancelAttachment();
      sendMessagePayload({ text, file: fileToSend });
    }

    async function getContactUsers() {
      try {
        const res = await fetch('/api/dialogs/' + currentUser.id);
        const list = await res.json();
        return list.filter(d => d.type !== 'group');
      } catch(e) {
        return Object.values(localKnownUsers).map(u => ({ id: u.id, type: 'user', name: u.name, avatar: u.avatar || '' }));
      }
    }
    function renderCheckList(containerId, users, excludeSet) {
      const c = document.getElementById(containerId); c.innerHTML = '';
      const list = users.filter(u => !excludeSet.has(u.id));
      if (list.length === 0) {
        c.innerHTML = '<div style="color:var(--text-muted); font-size:13px; padding:8px;">Нет доступных контактов. Сначала начните с кем-нибудь чат.</div>';
        return;
      }
      list.forEach(u => {
        const row = document.createElement('label');
        row.className = 'check-row';
        row.innerHTML = '<input type="checkbox" value="' + u.id + '" style="width:18px;height:18px;"><span>' + escapeHtml(u.name) + '</span>';
        c.appendChild(row);
      });
    }
    function getChecked(containerId) {
      return Array.from(document.querySelectorAll('#' + containerId + ' input[type=checkbox]:checked')).map(i => i.value);
    }

    async function openCreateGroup(e) {
      if (e) e.stopPropagation();
      if (isModalOpen('create-group-modal')) return;
      groupDraftAvatar = '';
      document.getElementById('create-group-name').value = '';
      fillAvatarBox(document.getElementById('create-group-avatar'), '', '👥');
      const contacts = await getContactUsers();
      renderCheckList('create-group-contacts', contacts, new Set());
      safeOpenModal('create-group-modal');
    }
    function closeCreateGroup() { safeCloseModal('create-group-modal'); }
    function triggerGroupAvatarInput() { const i = document.getElementById('group-avatar-input'); i.value = ''; i.click(); }
    function handleGroupAvatarSelect(e) {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = function(evt) { groupDraftAvatar = evt.target.result; fillAvatarBox(document.getElementById('create-group-avatar'), groupDraftAvatar, '👥'); };
      reader.readAsDataURL(file);
    }
    async function submitCreateGroup() {
      const name = document.getElementById('create-group-name').value.trim();
      if (!name) { alert('Введите название группы'); return; }
      const members = getChecked('create-group-contacts');
      try {
        const res = await fetch('/api/groups/create', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ userId: currentUser.id, name, members, avatar: groupDraftAvatar })
        });
        const data = await res.json();
        if (data.success) {
          closeCreateGroup();
          await loadDialogs();
          const g = data.group;
          openChat({ id: g.id, type: 'group', name: g.name, avatar: g.avatar, members: g.members, ownerId: g.ownerId, memberCount: g.members.length });
        } else { alert(data.error || 'Не удалось создать группу'); }
      } catch(e) { alert('Ошибка создания группы'); }
    }

    async function refreshGroupInfo() {
      if (!activePeer || activePeer.type !== 'group') return;
      try {
        const res = await fetch('/api/groups/' + activePeer.id);
        if (!res.ok) return;
        const g = await res.json();
        activePeer.name = g.name; activePeer.avatar = g.avatar;
        activePeer.members = g.members; activePeer.ownerId = g.ownerId;
        activePeer.memberDetails = g.memberDetails; activePeer.memberCount = g.members.length;
        (g.memberDetails || []).forEach(u => cacheUser(u));
        document.getElementById('active-peer-name').innerText = g.name;
        document.getElementById('active-peer-status').innerText = g.members.length + ' участников';
        renderAvatarIntoElement(document.getElementById('peer-avatar-circle'), { name: g.name, avatar: g.avatar }, false);
      } catch(e) {}
    }

    async function openGroupProfile() {
      closeChatDropdown();
      if (!activePeer || activePeer.type !== 'group') return;
      if (isModalOpen('group-profile-modal')) return;
      await refreshGroupInfo();
      const g = activePeer;
      fillAvatarBox(document.getElementById('group-profile-avatar'), g.avatar, '👥');
      document.getElementById('group-profile-name').innerText = g.name;
      document.getElementById('group-profile-count').innerText = (g.members ? g.members.length : 0) + ' участников';
      const isOwner = g.ownerId === currentUser.id;
      const ownerControls = document.getElementById('group-owner-controls');
      ownerControls.style.display = isOwner ? 'block' : 'none';
      if (isOwner) { document.getElementById('edit-group-name').value = g.name; editGroupDraftAvatar = ''; }
      renderMembersList('group-members-list', g.memberDetails || [], g.ownerId);
      safeOpenModal('group-profile-modal');
    }
    function closeGroupProfile() { safeCloseModal('group-profile-modal'); }

    function renderMembersList(containerId, memberDetails, ownerId) {
      const c = document.getElementById(containerId); c.innerHTML = '';
      memberDetails.forEach(u => {
        const row = document.createElement('div'); row.className = 'member-row';
        const isOwner = u.id === ownerId;
        const isMe = u.id === currentUser.id;
        row.innerHTML =
          '<div class="avatar-circle" style="width:32px;height:32px;font-size:13px;"></div>' +
          '<div style="flex:1; text-align:left; overflow:hidden;">' +
            '<div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + escapeHtml(u.name) + (isMe ? ' (вы)' : '') + '</div>' +
            (isOwner ? '<div style="font-size:11px; color:var(--accent);">создатель</div>' : '') +
          '</div>';
        c.appendChild(row);
        fillAvatarBox(row.querySelector('.avatar-circle'), u.avatar, (u.name || '?').charAt(0).toUpperCase());
      });
    }

    function triggerEditGroupAvatarInput() { const i = document.getElementById('edit-group-avatar-input'); i.value = ''; i.click(); }
    function handleEditGroupAvatarSelect(e) {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = function(evt) { editGroupDraftAvatar = evt.target.result; fillAvatarBox(document.getElementById('group-profile-avatar'), editGroupDraftAvatar, '👥'); };
      reader.readAsDataURL(file);
    }
    async function saveGroupChanges() {
      if (!activePeer || activePeer.type !== 'group') return;
      const name = document.getElementById('edit-group-name').value.trim();
      const body = { groupId: activePeer.id, userId: currentUser.id, name };
      if (editGroupDraftAvatar) body.avatar = editGroupDraftAvatar;
      try {
        const res = await fetch('/api/groups/update', {
          method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.success) {
          editGroupDraftAvatar = '';
          await refreshGroupInfo();
          openGroupProfile();
          loadDialogsQuiet();
        } else { alert(data.error || 'Не удалось сохранить'); }
      } catch(e) { alert('Ошибка сохранения группы'); }
    }

    async function openAddMembers() {
      if (!activePeer || activePeer.type !== 'group') return;
      if (isModalOpen('add-members-modal')) return;
      const contacts = await getContactUsers();
      const exclude = new Set(activePeer.members || []);
      renderCheckList('add-members-contacts', contacts, exclude);
      safeOpenModal('add-members-modal');
    }
    function closeAddMembers() { safeCloseModal('add-members-modal'); }
    async function submitAddMembers() {
      const members = getChecked('add-members-contacts');
      if (members.length === 0) { closeAddMembers(); return; }
      try {
        const res = await fetch('/api/groups/add', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ groupId: activePeer.id, userId: currentUser.id, members })
        });
        const data = await res.json();
        if (data.success) { closeAddMembers(); await refreshGroupInfo(); openGroupProfile(); }
        else { alert(data.error || 'Не удалось добавить'); }
      } catch(e) { alert('Ошибка добавления участников'); }
    }

    async function leaveGroup() {
      closeChatDropdown();
      if (!activePeer || activePeer.type !== 'group') return;
      if (!confirm('Покинуть группу «' + activePeer.name + '»?')) return;
      try {
        await fetch('/api/groups/leave', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ groupId: activePeer.id, userId: currentUser.id })
        });
        closeGroupProfile();
        resetActiveChat();
        loadDialogs();
      } catch(e) { alert('Не удалось покинуть группу'); }
    }
  </script>
</body>
</html>
`;

/* ==================== СТАРТ СЕРВЕРА ==================== */
app.use((req, res) => { res.send(CLIENT_HTML); });

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Файл слишком большой' });
  }
  if (err && (err instanceof SyntaxError || err.type === 'entity.parse.failed')) {
    return res.status(400).json({ error: 'Некорректный JSON' });
  }
  console.error('[ОШИБКА EXPRESS]:', err && err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

const httpServer = app.listen(PORT, '0.0.0.0', () =>
  console.log(`[СЕРВЕР ЗАПУЩЕН] Порт: ${PORT}`)
);
httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 66000;
httpServer.requestTimeout = 0;
httpServer.timeout = 0;
