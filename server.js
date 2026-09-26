const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

process.on('uncaughtException', function (err) { console.error('[ОШИБКА СЕРВЕРА]:', err); });
process.on('unhandledRejection', function (reason) { console.error('[ОШИБКА ПРОМИСА]:', reason); });

const SERV_DIR = __dirname;
const ARXIV_DIR = path.join(SERV_DIR, 'arxiv');
const ACCOUNTS_DIR = path.join(ARXIV_DIR, 'accounts');
const MESSAGES_DIR = path.join(ARXIV_DIR, 'messages');
const GROUPS_DIR = path.join(ARXIV_DIR, 'groups');

[ARXIV_DIR, ACCOUNTS_DIR, MESSAGES_DIR, GROUPS_DIR].forEach(function (dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const ACCOUNTS_FILE = path.join(ACCOUNTS_DIR, 'accounts.json');
const MESSAGES_FILE = path.join(MESSAGES_DIR, 'messages.json');
const GROUPS_FILE = path.join(GROUPS_DIR, 'groups.json');

function safeReadJSON(filePath, fallback) {
  if (fallback === undefined) fallback = [];
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
  } catch (e) { console.error('[ОШИБКА ЗАПИСИ ' + filePath + ']:', e); }
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
    if (decoded && decoded.indexOf('\uFFFD') === -1) return decoded;
  } catch (e) {}
  return text;
}
function timeStr() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function genId(prefix) { return prefix + Date.now() + '_' + Math.random().toString(36).substr(2, 6); }

/* ==================== АККАУНТЫ ==================== */

app.post('/api/register', function (req, res) {
  let id = req.body.id, name = req.body.name, avatar = req.body.avatar, contacts = req.body.contacts;
  const accounts = readAccounts();
  if (!name || !name.trim()) return res.status(400).json({ error: 'Введите имя' });

  let finalId = id;
  if (!finalId || accounts.some(function (u) { return u.id === finalId && u.name !== name.trim(); })) {
    finalId = 'id_' + Math.random().toString(36).substr(2, 9);
  }
  let user = accounts.find(function (u) { return u.id === finalId; });
  if (user) {
    user.name = name.trim();
    if (avatar !== undefined) user.avatar = avatar;
    user.updatedAt = Date.now();
    if (Array.isArray(contacts)) user.contacts = Array.from(new Set([].concat(user.contacts || [], contacts)));
  } else {
    user = {
      id: finalId, name: name.trim(), avatar: avatar || '',
      contacts: Array.isArray(contacts) ? contacts : [],
      blockedContacts: [], hiddenDialogs: [], updatedAt: Date.now()
    };
    accounts.push(user);
  }
  writeAccounts(accounts);
  res.json({ success: true, user: user });
});

app.post('/api/ping', function (req, res) {
  const id = req.body.id, name = req.body.name, avatar = req.body.avatar, contacts = req.body.contacts, knownUsers = req.body.knownUsers;
  if (!id) return res.status(400).json({ error: 'No id provided' });
  const accounts = readAccounts();

  if (Array.isArray(knownUsers)) {
    knownUsers.forEach(function (kUser) {
      if (!kUser.id) return;
      if (!accounts.some(function (a) { return a.id === kUser.id; })) {
        accounts.push({
          id: kUser.id, name: kUser.name || 'Пользователь', avatar: kUser.avatar || '',
          contacts: [], blockedContacts: [], hiddenDialogs: [], updatedAt: 0
        });
      }
    });
  }

  let user = accounts.find(function (u) { return u.id === id; });
  if (!user) {
    user = {
      id: id, name: name || 'Пользователь', avatar: avatar || '',
      contacts: Array.isArray(contacts) ? contacts : [],
      blockedContacts: [], hiddenDialogs: [], updatedAt: Date.now()
    };
    accounts.push(user);
  } else {
    user.updatedAt = Date.now();
    if (name) user.name = name;
    if (avatar !== undefined) user.avatar = avatar;
    if (Array.isArray(contacts)) user.contacts = Array.from(new Set([].concat(user.contacts || [], contacts)));
  }
  writeAccounts(accounts);
  res.json({ success: true, user: user });
});

app.post('/api/profile/update', function (req, res) {
  const id = req.body.id, name = req.body.name, avatar = req.body.avatar;
  const accounts = readAccounts();
  const user = accounts.find(function (u) { return u.id === id; });
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (name && name.trim()) user.name = name.trim();
  if (avatar !== undefined) user.avatar = avatar;
  user.updatedAt = Date.now();
  writeAccounts(accounts);
  res.json({ success: true, user: user });
});

app.get('/api/users/:userId', function (req, res) {
  const accounts = readAccounts();
  const user = accounts.find(function (u) { return u.id === req.params.userId; });
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const isOnline = user.updatedAt && (Date.now() - user.updatedAt < 8000);
  res.json({ id: user.id, name: user.name, avatar: user.avatar || '', isOnline: isOnline, updatedAt: user.updatedAt });
});

app.post('/api/users/block', function (req, res) {
  const userId = req.body.userId, peerId = req.body.peerId, block = req.body.block;
  const accounts = readAccounts();
  const user = accounts.find(function (u) { return u.id === userId; });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.blockedContacts) user.blockedContacts = [];
  if (block) { if (user.blockedContacts.indexOf(peerId) === -1) user.blockedContacts.push(peerId); }
  else { user.blockedContacts = user.blockedContacts.filter(function (x) { return x !== peerId; }); }
  writeAccounts(accounts);
  res.json({ success: true, blockedContacts: user.blockedContacts });
});

app.post('/api/chat/hide', function (req, res) {
  const userId = req.body.userId, peerId = req.body.peerId;
  const accounts = readAccounts();
  const user = accounts.find(function (u) { return u.id === userId; });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.hiddenDialogs) user.hiddenDialogs = [];
  if (user.hiddenDialogs.indexOf(peerId) === -1) user.hiddenDialogs.push(peerId);
  writeAccounts(accounts);
  res.json({ success: true, hiddenDialogs: user.hiddenDialogs });
});

app.get('/api/users/search', function (req, res) {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  const accounts = readAccounts();
  const now = Date.now();
  const results = accounts
    .filter(function (u) { return (u.id && u.id.toLowerCase().indexOf(q) !== -1) || (u.name && u.name.toLowerCase().indexOf(q) !== -1); })
    .map(function (u) {
      return {
        id: u.id, type: 'user', name: u.name, avatar: u.avatar || '',
        isOnline: u.updatedAt && (now - u.updatedAt < 8000)
      };
    });
  res.json(results);
});

/* ==================== ГРУППЫ ==================== */

app.post('/api/groups/create', function (req, res) {
  const userId = req.body.userId, name = req.body.name, members = req.body.members, avatar = req.body.avatar;
  if (!userId) return res.status(400).json({ error: 'Нет пользователя' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Введите название группы' });

  const accounts = readAccounts();
  const creator = accounts.find(function (u) { return u.id === userId; });
  const contactsSet = new Set(creator && creator.contacts ? creator.contacts : []);
  const validMembers = (Array.isArray(members) ? members : []).filter(function (mId) { return mId !== userId && contactsSet.has(mId); });
  const memberSet = new Set([userId].concat(validMembers));

  const groups = readGroups();
  const group = {
    id: genId('grp_'), name: name.trim(), avatar: avatar || '',
    ownerId: userId, members: Array.from(memberSet), createdAt: Date.now()
  };
  groups.push(group);
  writeGroups(groups);
  res.json({ success: true, group: group });
});

function groupWithDetails(group) {
  const accounts = readAccounts();
  const now = Date.now();
  const memberDetails = group.members.map(function (mId) {
    const u = accounts.find(function (a) { return a.id === mId; });
    return {
      id: mId,
      name: u ? u.name : 'Пользователь',
      avatar: u ? (u.avatar || '') : '',
      isOnline: u && u.updatedAt && (now - u.updatedAt < 8000)
    };
  });
  const copy = Object.assign({}, group);
  copy.memberDetails = memberDetails;
  return copy;
}

app.get('/api/groups/:groupId', function (req, res) {
  const groups = readGroups();
  const g = groups.find(function (x) { return x.id === req.params.groupId; });
  if (!g) return res.status(404).json({ error: 'Группа не найдена' });
  res.json(groupWithDetails(g));
});

app.post('/api/groups/update', function (req, res) {
  const groupId = req.body.groupId, userId = req.body.userId, name = req.body.name, avatar = req.body.avatar;
  const groups = readGroups();
  const g = groups.find(function (x) { return x.id === groupId; });
  if (!g) return res.status(404).json({ error: 'Группа не найдена' });
  if (g.ownerId !== userId) return res.status(403).json({ error: 'Только создатель может менять группу' });
  if (name && name.trim()) g.name = name.trim();
  if (avatar !== undefined) g.avatar = avatar;
  writeGroups(groups);
  res.json({ success: true, group: groupWithDetails(g) });
});

app.post('/api/groups/add', function (req, res) {
  const groupId = req.body.groupId, userId = req.body.userId, members = req.body.members;
  const groups = readGroups();
  const g = groups.find(function (x) { return x.id === groupId; });
  if (!g) return res.status(404).json({ error: 'Группа не найдена' });
  if (g.ownerId !== userId) return res.status(403).json({ error: 'Только создатель может добавлять' });

  const accounts = readAccounts();
  const owner = accounts.find(function (u) { return u.id === userId; });
  const contactsSet = new Set(owner && owner.contacts ? owner.contacts : []);

  (Array.isArray(members) ? members : []).forEach(function (mId) {
    if (contactsSet.has(mId) && g.members.indexOf(mId) === -1) g.members.push(mId);
  });
  writeGroups(groups);
  res.json({ success: true, group: groupWithDetails(g) });
});

app.post('/api/groups/leave', function (req, res) {
  const groupId = req.body.groupId, userId = req.body.userId;
  let groups = readGroups();
  const g = groups.find(function (x) { return x.id === groupId; });
  if (!g) return res.status(404).json({ error: 'Группа не найдена' });
  g.members = g.members.filter(function (m) { return m !== userId; });
  if (g.ownerId === userId) g.ownerId = g.members[0] || null;
  if (g.members.length === 0) groups = groups.filter(function (x) { return x.id !== groupId; });
  writeGroups(groups);
  res.json({ success: true });
});

/* ==================== СООБЩЕНИЯ ==================== */

app.post('/api/messages/send', function (req, res) {
  const senderId = req.body.senderId, receiverId = req.body.receiverId, groupId = req.body.groupId;
  const text = req.body.text, fileData = req.body.fileData, fileName = req.body.fileName, fileType = req.body.fileType, clientId = req.body.clientId;
  const accounts = readAccounts();
  const messages = readMessages();

  if (clientId) {
    const dup = messages.find(function (m) { return m.clientId && m.clientId === clientId; });
    if (dup) {
      const copyDup = Object.assign({}, dup);
      copyDup.text = decryptText(dup.text);
      return res.json({ success: true, duplicate: true, message: copyDup });
    }
  }

  const sender = accounts.find(function (u) { return u.id === senderId; });

  if (groupId) {
    const groups = readGroups();
    const g = groups.find(function (x) { return x.id === groupId; });
    if (!g) return res.status(404).json({ error: 'Группа не найдена' });
    if (g.members.indexOf(senderId) === -1) return res.status(403).json({ error: 'Вы не участник группы' });
  } else {
    const receiver = accounts.find(function (u) { return u.id === receiverId; });
    if (sender && sender.blockedContacts && sender.blockedContacts.indexOf(receiverId) !== -1) {
      return res.status(403).json({ error: 'Вы заблокировали этого пользователя' });
    }
    if (receiver && receiver.blockedContacts && receiver.blockedContacts.indexOf(senderId) !== -1) {
      return res.status(403).json({ error: 'Вы заблокированы получателем' });
    }
    if (sender && sender.hiddenDialogs) sender.hiddenDialogs = sender.hiddenDialogs.filter(function (id) { return id !== receiverId; });
    if (receiver && receiver.hiddenDialogs) receiver.hiddenDialogs = receiver.hiddenDialogs.filter(function (id) { return id !== senderId; });
    if (sender) {
      if (!sender.contacts) sender.contacts = [];
      if (sender.contacts.indexOf(receiverId) === -1) sender.contacts.push(receiverId);
    }
    if (receiver) {
      if (!receiver.contacts) receiver.contacts = [];
      if (receiver.contacts.indexOf(senderId) === -1) receiver.contacts.push(senderId);
    }
    writeAccounts(accounts);
  }

  const newMsg = {
    id: genId('msg_'), clientId: clientId || '',
    senderId: senderId,
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
  const copyMsg = Object.assign({}, newMsg);
  copyMsg.text = text || '';
  res.json({ success: true, message: copyMsg });
});

app.post('/api/messages/read', function (req, res) {
  const msgIds = req.body.msgIds, userId = req.body.userId;
  if (!Array.isArray(msgIds) || msgIds.length === 0) return res.json({ success: true });
  const messages = readMessages();
  let changed = false;
  messages.forEach(function (m) {
    if (msgIds.indexOf(m.id) === -1) return;
    if (m.groupId) {
      if (!m.readBy) m.readBy = [];
      if (userId && m.senderId !== userId && m.readBy.indexOf(userId) === -1) {
        m.readBy.push(userId); changed = true;
      }
    } else if (!m.isRead && m.senderId !== userId) {
      m.isRead = true; changed = true;
    }
  });
  if (changed) writeMessages(messages);
  res.json({ success: true });
});

app.delete('/api/messages/:msgId', function (req, res) {
  const msgId = req.params.msgId;
  const messages = readMessages();
  let changed = false;
  messages.forEach(function (m) { if (m.id === msgId) { m.isDeleted = true; changed = true; } });
  if (changed) writeMessages(messages);
  res.json({ success: true });
});

app.post('/api/chat/clear', function (req, res) {
  const userId = req.body.userId, peerId = req.body.peerId, groupId = req.body.groupId;
  const messages = readMessages();
  let changed = false;
  messages.forEach(function (m) {
    const isGroupMatch = groupId && m.groupId === groupId;
    const isDmMatch = !groupId && (
      (m.senderId === userId && m.receiverId === peerId) ||
      (m.senderId === peerId && m.receiverId === userId)
    );
    if ((isGroupMatch || isDmMatch) && !m.isDeleted) {
      if (!m.clearedFor) m.clearedFor = [];
      if (m.clearedFor.indexOf(userId) === -1) { m.clearedFor.push(userId); changed = true; }
    }
  });
  if (changed) writeMessages(messages);
  res.json({ success: true });
});

app.get('/api/messages/group/:groupId', function (req, res) {
  const groupId = req.params.groupId;
  const userId = req.query.userId;
  const messages = readMessages();
  const list = messages
    .filter(function (m) {
      return !m.isDeleted && m.groupId === groupId &&
        !(m.clearedFor && userId && m.clearedFor.indexOf(userId) !== -1);
    })
    .sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); })
    .map(function (m) { const c = Object.assign({}, m); c.text = decryptText(m.text); return c; });
  res.json(list);
});

app.get('/api/messages/:userId/:peerId', function (req, res) {
  const userId = req.params.userId, peerId = req.params.peerId;
  const messages = readMessages();
  const chatMsgs = messages.filter(function (m) {
    return !m.isDeleted && !m.groupId &&
      ((m.senderId === userId && m.receiverId === peerId) || (m.senderId === peerId && m.receiverId === userId)) &&
      !(m.clearedFor && m.clearedFor.indexOf(userId) !== -1);
  }).sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); })
    .map(function (m) { const c = Object.assign({}, m); c.text = decryptText(m.text); return c; });
  res.json(chatMsgs);
});

app.get('/api/dialogs/:userId', function (req, res) {
  const userId = req.params.userId;
  const accounts = readAccounts();
  const currentUser = accounts.find(function (u) { return u.id === userId; });
  const messages = readMessages();
  const groups = readGroups();
  const now = Date.now();

  const hiddenSet = new Set(currentUser && currentUser.hiddenDialogs ? currentUser.hiddenDialogs : []);
  const peerIds = new Set(currentUser ? currentUser.contacts || [] : []);
  const lastTs = {};

  messages.forEach(function (m) {
    if (m.isDeleted) return;
    if (m.clearedFor && m.clearedFor.indexOf(userId) !== -1) return;
    if (m.groupId) {
      lastTs['grp:' + m.groupId] = Math.max(lastTs['grp:' + m.groupId] || 0, m.ts || 0);
    } else {
      if (m.senderId === userId) { peerIds.add(m.receiverId); lastTs[m.receiverId] = Math.max(lastTs[m.receiverId] || 0, m.ts || 0); }
      if (m.receiverId === userId) { peerIds.add(m.senderId); lastTs[m.senderId] = Math.max(lastTs[m.senderId] || 0, m.ts || 0); }
    }
  });

  const userDialogs = accounts
    .filter(function (u) { return peerIds.has(u.id) && u.id !== userId && !hiddenSet.has(u.id); })
    .map(function (u) {
      return {
        id: u.id, type: 'user', name: u.name, avatar: u.avatar || '',
        isOnline: u.updatedAt && (now - u.updatedAt < 8000),
        lastTs: lastTs[u.id] || 0
      };
    });

  const groupDialogs = groups
    .filter(function (g) { return g.members.indexOf(userId) !== -1; })
    .map(function (g) {
      return {
        id: g.id, type: 'group', name: g.name, avatar: g.avatar || '',
        ownerId: g.ownerId, members: g.members, memberCount: g.members.length,
        lastTs: lastTs['grp:' + g.id] || 0
      };
    });

  const all = userDialogs.concat(groupDialogs).sort(function (a, b) { return (b.lastTs || 0) - (a.lastTs || 0); });
  res.json(all);
});

/* ==================== HTML КЛИЕНТ ==================== */
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
  .theme-toggle-btn { background: var(--bg-input); border: none; color: var(--text-main); width: 34px; height: 34px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px; transition: opacity 0.15s; }
  .theme-toggle-btn:disabled { opacity: 0.5; cursor: wait; }
  .new-group-btn-icon { display: inline-flex; align-items: baseline; line-height: 1; }
  .new-group-btn-icon .plus { font-size: 11px; margin-right: 1px; }
  .new-group-btn-icon .people { font-size: 16px; }
  .search-box { position: relative; }
  .search-box input { width: 100%; padding: 10px 12px; border-radius: 18px; border: none; background: var(--bg-input); color: var(--text-main); outline: none; font-size: 14px; }
  .clear-search { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; color: var(--text-muted); display: none; }
  .chat-list { flex: 1; overflow-y: auto; }
  .chat-item { display: flex; align-items: center; gap: 12px; padding: 12px; cursor: pointer; border-bottom: 1px solid var(--border); transition: background 0.15s; }
  .chat-item:hover, .chat-item.active { background: var(--bg-active); }
  .main-chat { flex: 1; display: flex; flex-direction: column; background: var(--bg-app); position: relative; min-width: 0; }
  .chat-header { background: var(--bg-sidebar); padding: 8px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); height: 60px; }
  .chat-header-info { display: flex; align-items: center; gap: 10px; cursor: pointer; flex: 1; overflow: hidden; }
  .chat-menu-container { position: relative; }
  .menu-dots-btn { background: transparent; border: none; color: var(--text-main); font-size: 20px; cursor: pointer; padding: 8px; border-radius: 50%; display: none; align-items: center; justify-content: center; }
  .menu-dots-btn:hover { background: var(--bg-input); }
  .chat-dropdown-menu { position: absolute; right: 0; top: 45px; background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); width: 220px; display: flex; flex-direction: column; z-index: 1000; overflow: hidden; visibility: hidden; opacity: 0; transform: translateY(-6px); transition: opacity 0.12s, transform 0.12s, visibility 0.12s; pointer-events: none; }
  .chat-dropdown-menu.active { visibility: visible; opacity: 1; transform: translateY(0); pointer-events: auto; }
  .menu-item { padding: 12px 16px; font-size: 14px; cursor: pointer; border-bottom: 1px solid var(--border); text-align: left; background: none; border-top: none; border-left: none; border-right: none; color: var(--text-main); width: 100%; }
  .menu-item:hover { background: var(--bg-active); }
  .menu-item.danger { color: #e53935; }
  .messages-container { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px; -webkit-overflow-scrolling: touch; }
  .msg { max-width: 75%; padding: 10px 14px; border-radius: 12px; background: var(--bg-msg-peer); align-self: flex-start; word-break: break-word; position: relative; user-select: none; transition: background 0.15s; }
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
  .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 2000; display: flex; align-items: center; justify-content: center; visibility: hidden; opacity: 0; transition: opacity 0.15s, visibility 0.15s; pointer-events: none; }
  .modal-overlay.active { visibility: visible; opacity: 1; pointer-events: auto; }
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
  #image-viewer-modal { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.9); z-index: 3000; display: flex; align-items: center; justify-content: center; visibility: hidden; opacity: 0; transition: opacity 0.15s, visibility 0.15s; pointer-events: none; }
  #image-viewer-modal.active { visibility: visible; opacity: 1; pointer-events: auto; }
  #image-viewer-modal img { max-width: 95vw; max-height: 95vh; border-radius: 8px; object-fit: contain; }
  .viewer-close { position: absolute; top: 20px; right: 20px; color: #fff; font-size: 30px; cursor: pointer; background: none; border: none; }
  .msg-actions-sheet { position: fixed; bottom: 0; left: 0; right: 0; background: var(--bg-sidebar); border-top-left-radius: 16px; border-top-right-radius: 16px; padding: 20px; z-index: 1001; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 -4px 20px rgba(0,0,0,0.4); visibility: hidden; opacity: 0; transform: translateY(20px); transition: opacity 0.15s, transform 0.15s, visibility 0.15s; pointer-events: none; }
  .msg-actions-sheet.active { visibility: visible; opacity: 1; transform: translateY(0); pointer-events: auto; }
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
<body>
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
              <button class="theme-toggle-btn" id="theme-toggle-btn" onclick="toggleTheme()" title="Сменить тему">🌙</button>
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
            <button class="menu-dots-btn" id="chat-menu-dots-btn" onclick="toggleChatDropdown()" title="Опции чата">⋮</button>
            <div class="chat-dropdown-menu" id="chat-dropdown-menu"></div>
          </div>
        </div>
        <div class="messages-container" id="messages-container">
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
            <div class="attachment-name">🎤 Голосовое сообщение — готово к отправке</div>
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
          <button class="btn" id="send-btn" style="width:auto; padding:10px 18px; border-radius:20px;" onclick="sendMsg()">➤</button>
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
      <div id="create-group-contacts" style="width:100%; max-height:200px; overflow-y:auto; margin-bottom:10px;">
        <div style="color:var(--text-muted); font-size:13px; padding:8px;">Загрузка контактов…</div>
      </div>
      <div class="profile-actions">
        <button class="btn" id="create-group-submit-btn" onclick="submitCreateGroup()">Создать группу</button>
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
        <button class="btn" id="save-group-btn" onclick="saveGroupChanges()">Сохранить изменения</button>
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
        <button class="btn" id="add-members-submit-btn" onclick="submitAddMembers()">Добавить</button>
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
  <script src="/client.js"></script>
</body>
</html>`;

/* ==================== JS КЛИЕНТА ==================== */
const CLIENT_JS = `
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
var lastDialogsHash = '';
var lastMessagesHash = '';
var selectedMsgId = null;
var selectedMsgObj = null;
var longTouchTimer = null;
var groupDraftAvatar = '';
var editGroupDraftAvatar = '';
var localKnownUsers = JSON.parse(localStorage.getItem('messenger_known_users') || '{}');
var mutedPeers = JSON.parse(localStorage.getItem('messenger_muted_peers') || '[]');
var localMessagesCache = JSON.parse(localStorage.getItem('messenger_messages_cache') || '[]');
var savedTheme = localStorage.getItem('app_theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);
var audioPool = new Map();
var blobUrlCache = new Map();
var visibleMsgDebounce = null;
var busyButtons = {};

/* ---------- ЗАЩИТА КНОПОК ---------- */
function lockButton(id, ms) {
  if (ms === undefined) ms = 1500;
  var el = document.getElementById(id);
  if (!el) return false;
  if (busyButtons[id]) return false;
  busyButtons[id] = true;
  el.disabled = true;
  el.style.opacity = '0.5';
  el.style.pointerEvents = 'none';
  setTimeout(function () {
    busyButtons[id] = false;
    el.disabled = false;
    el.style.opacity = '';
    el.style.pointerEvents = '';
  }, ms);
  return true;
}

/* ---------- МОДАЛКИ ---------- */
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
function closeAllModals(except) {
  document.querySelectorAll('.modal-overlay').forEach(function (ov) {
    if (!except || ov.id !== except) ov.classList.remove('active');
  });
}

/* ---------- УТИЛИТЫ ---------- */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function saveCache() { try { localStorage.setItem('messenger_messages_cache', JSON.stringify(localMessagesCache)); } catch (e) {} }
function saveKnownUsers() { try { localStorage.setItem('messenger_known_users', JSON.stringify(localKnownUsers)); } catch (e) {} }
function mergeMessage(msg) {
  if (!msg || !msg.id) return;
  for (var i = 0; i < localMessagesCache.length; i++) {
    var m = localMessagesCache[i];
    if (m.id === msg.id || (msg.clientId && m.clientId && m.clientId === msg.clientId)) {
      localMessagesCache[i] = msg; return;
    }
  }
  localMessagesCache.push(msg);
}
function quickHash(str) {
  if (!str) return '0';
  var len = str.length;
  var head = str.substring(0, 64);
  var tail = str.substring(Math.max(0, len - 64));
  var h = 0;
  var sample = head + '|' + tail + '|' + len;
  for (var i = 0; i < sample.length; i++) h = ((h << 5) - h + sample.charCodeAt(i)) | 0;
  return len + '_' + (h >>> 0).toString(36);
}
function getAudioSignature(msg) { return [msg.fileType || '', msg.fileName || '', quickHash(msg.fileData || '')].join('|'); }
function dataUrlToBlobUrl(dataUrl) {
  var commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) return null;
  var meta = dataUrl.substring(5, commaIdx);
  var isBase64 = meta.indexOf(';base64') !== -1;
  var mime = meta.split(';')[0] || 'audio/webm';
  var blob;
  if (isBase64) {
    var b64 = dataUrl.substring(commaIdx + 1);
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: mime });
  } else {
    var decoded = decodeURIComponent(dataUrl.substring(commaIdx + 1));
    blob = new Blob([decoded], { type: mime });
  }
  return URL.createObjectURL(blob);
}
function getOrCreateBlobUrl(signature, fileData) {
  if (blobUrlCache.has(signature)) return blobUrlCache.get(signature);
  try {
    if (fileData && fileData.indexOf('data:') === 0) {
      var url = dataUrlToBlobUrl(fileData);
      if (url) { blobUrlCache.set(signature, url); return url; }
    }
  } catch (e) {}
  return fileData;
}
function getOrCreateAudioElement(msg) {
  var existing = audioPool.get(msg.id);
  var signature = getAudioSignature(msg);
  if (existing && existing.signature === signature) return existing.element;
  if (existing) {
    try { existing.element.pause(); } catch (e) {}
    if (existing.element.parentNode) existing.element.parentNode.removeChild(existing.element);
    audioPool.delete(msg.id);
  }
  var audio = document.createElement('audio');
  audio.controls = true;
  audio.className = 'audio-preview';
  audio.preload = 'metadata';
  audio.setAttribute('controlsList', 'nodownload');
  audio.src = getOrCreateBlobUrl(signature, msg.fileData);
  audio.addEventListener('click', function (e) { e.stopPropagation(); });
  audio.addEventListener('contextmenu', function (e) { e.stopPropagation(); });
  audio.addEventListener('touchstart', function (e) { e.stopPropagation(); }, { passive: true });
  document.getElementById('audio-pool').appendChild(audio);
  audioPool.set(msg.id, { element: audio, signature: signature });
  return audio;
}
function cleanupAudioPool(validMsgIds) {
  var validSet = new Set(validMsgIds);
  audioPool.forEach(function (entry, msgId) {
    if (!validSet.has(msgId)) {
      try { entry.element.pause(); } catch (e) {}
      if (entry.element.parentNode) entry.element.parentNode.removeChild(entry.element);
      audioPool.delete(msgId);
    }
  });
  var usedSignatures = new Set();
  audioPool.forEach(function (v) { usedSignatures.add(v.signature); });
  blobUrlCache.forEach(function (url, sig) {
    if (!usedSignatures.has(sig)) {
      try { URL.revokeObjectURL(url); } catch (e) {}
      blobUrlCache.delete(sig);
    }
  });
}
function pauseAllAudio() { audioPool.forEach(function (entry) { try { entry.element.pause(); } catch (e) {} }); }
function playNotificationSound() {
  try {
    var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, audioCtx.currentTime);
    osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + 0.3);
  } catch (e) {}
}
function updateThemeIcon(theme) {
  var btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.innerText = theme === 'dark' ? '🌙' : '☀️';
}
function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme');
  var next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('app_theme', next);
  updateThemeIcon(next);
}

/* ---------- МЕНЮ ЧАТА ---------- */
function toggleChatDropdown() {
  var menu = document.getElementById('chat-dropdown-menu');
  if (!menu) return;
  if (menu.classList.contains('active')) {
    menu.classList.remove('active');
  } else {
    menu.classList.add('active');
  }
}
function closeChatDropdown() {
  var menu = document.getElementById('chat-dropdown-menu');
  if (menu) menu.classList.remove('active');
}
document.addEventListener('click', function (e) {
  var menu = document.getElementById('chat-dropdown-menu');
  var dotsBtn = document.getElementById('chat-menu-dots-btn');
  if (menu && menu.classList.contains('active')) {
    if (!menu.contains(e.target) && e.target !== dotsBtn && !dotsBtn.contains(e.target)) {
      menu.classList.remove('active');
    }
  }
});

/* ---------- АВАТАРЫ ---------- */
function fillAvatarBox(el, avatar, fallback) {
  if (!el) return;
  var indicator = el.querySelector('.online-indicator');
  Array.from(el.childNodes).forEach(function (node) { if (node !== indicator) el.removeChild(node); });
  if (avatar) {
    var img = document.createElement('img'); img.src = avatar;
    if (indicator) el.insertBefore(img, indicator); else el.appendChild(img);
  } else {
    var span = document.createElement('span'); span.innerText = fallback || '?';
    if (indicator) el.insertBefore(span, indicator); else el.appendChild(span);
  }
}
function renderAvatarIntoElement(el, userObj, isOnline) {
  if (!el) return;
  var indicator = el.querySelector('.online-indicator');
  Array.from(el.childNodes).forEach(function (node) { if (node !== indicator) el.removeChild(node); });
  if (userObj && userObj.avatar) {
    var img = document.createElement('img'); img.src = userObj.avatar; el.insertBefore(img, indicator);
  } else if (userObj && userObj.name) {
    var span = document.createElement('span'); span.innerText = userObj.name.charAt(0).toUpperCase(); el.insertBefore(span, indicator);
  } else {
    var span2 = document.createElement('span'); span2.innerText = '?'; el.insertBefore(span2, indicator);
  }
  if (indicator) {
    if (isOnline) indicator.classList.add('visible'); else indicator.classList.remove('visible');
  }
}
function cacheUser(user) {
  if (!user || !user.id || user.type === 'group') return;
  localKnownUsers[user.id] = { id: user.id, name: user.name, avatar: user.avatar };
  saveKnownUsers();
}
function getUserName(id) {
  if (!currentUser) return 'Пользователь';
  if (id === currentUser.id) return currentUser.name;
  if (localKnownUsers[id]) return localKnownUsers[id].name;
  if (activePeer && activePeer.memberDetails) {
    var m = activePeer.memberDetails.find(function (x) { return x.id === id; });
    if (m) return m.name;
  }
  return 'Пользователь';
}
function getChatMessages(chat) {
  if (!chat || !currentUser) return [];
  var list;
  if (chat.type === 'group') {
    list = localMessagesCache.filter(function (m) { return !m.isDeleted && m.groupId === chat.id; });
  } else {
    list = localMessagesCache.filter(function (m) {
      return !m.isDeleted && !m.groupId &&
        ((m.senderId === currentUser.id && m.receiverId === chat.id) ||
         (m.senderId === chat.id && m.receiverId === currentUser.id));
    });
  }
  return list.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
}
function updateMyProfileUI() {
  document.getElementById('my-display-name').innerText = currentUser.name;
  document.getElementById('my-display-id').innerText = 'ID: ' + currentUser.id;
  renderAvatarIntoElement(document.getElementById('my-avatar-circle'), currentUser, true);
}

/* ---------- РЕГИСТРАЦИЯ / СТАРТ ---------- */
async function registerUser() {
  if (busyButtons['login-btn']) return;
  var nameInput = document.getElementById('auth-name');
  var name = nameInput.value.trim();
  var errBox = document.getElementById('auth-error');
  if (!name) { errBox.innerText = 'Введите ваше имя.'; errBox.style.display = 'block'; return; }
  if (!lockButton('login-btn', 3000)) return;
  try {
    var res = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) });
    var data = await res.json();
    if (!data.success) { errBox.innerText = data.error || 'Ошибка входа'; errBox.style.display = 'block'; }
    else {
      currentUser = data.user;
      localStorage.setItem('messenger_user', JSON.stringify(currentUser));
      startApp();
    }
  } catch (e) { errBox.innerText = 'Ошибка подключения к серверу.'; errBox.style.display = 'block'; }
}
function startApp() {
  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('active');
  updateMyProfileUI();
  sendPing();
  loadDialogs();
  setInterval(function () {
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
  var pending = localMessagesCache.filter(function (m) { return m.isPending && m.senderId === currentUser.id; });
  for (var i = 0; i < pending.length; i++) {
    var pm = pending[i];
    localMessagesCache = localMessagesCache.filter(function (m) { return m.clientId !== pm.clientId; });
    saveCache();
    if (activePeer && ((activePeer.type === 'group' && pm.groupId === activePeer.id) || (activePeer.type !== 'group' && pm.receiverId === activePeer.id))) {
      renderMessagesContainer(getChatMessages(activePeer));
    }
    try {
      var res = await fetch('/api/messages/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderId: pm.senderId, receiverId: pm.receiverId, groupId: pm.groupId,
          text: pm.text, fileData: pm.fileData, fileName: pm.fileName, fileType: pm.fileType, clientId: pm.clientId
        })
      });
      if (res.ok) {
        var data = await res.json();
        if (data && data.message) {
          var rm = Object.assign({}, data.message); rm.isPending = false;
          mergeMessage(rm); saveCache();
          if (activePeer) renderMessagesContainer(getChatMessages(activePeer));
        }
      }
    } catch (e) {}
  }
}
async function sendPing() {
  if (!currentUser) return;
  try {
    var knownList = [];
    for (var k in localKnownUsers) if (localKnownUsers.hasOwnProperty(k)) knownList.push(localKnownUsers[k]);
    var res = await fetch('/api/ping', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar || '',
        contacts: currentUser.contacts || [], knownUsers: knownList
      })
    });
    var data = await res.json();
    if (data.success && data.user && data.user.id !== currentUser.id) {
      currentUser.id = data.user.id;
      localStorage.setItem('messenger_user', JSON.stringify(currentUser));
      updateMyProfileUI();
    }
  } catch (e) {}
}
async function refreshActivePeerStatus() {
  if (!activePeer || activePeer.type === 'group') return;
  try {
    var res = await fetch('/api/users/' + activePeer.id);
    if (res.ok) {
      var info = await res.json();
      activePeer.isOnline = info.isOnline; activePeer.name = info.name; activePeer.avatar = info.avatar;
      var statusEl = document.getElementById('active-peer-status');
      if (info.isOnline) { statusEl.innerText = 'в сети'; statusEl.style.color = '#4cd964'; }
      else { statusEl.innerText = 'не в сети'; statusEl.style.color = 'var(--text-muted)'; }
      renderAvatarIntoElement(document.getElementById('peer-avatar-circle'), activePeer, info.isOnline);
    }
  } catch (e) {}
}

/* ---------- МОЙ ПРОФИЛЬ ---------- */
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
function triggerAvatarInput() { var i = document.getElementById('avatar-file-input'); i.value = ''; i.click(); }
function handleAvatarSelect(e) {
  var file = e.target.files[0]; if (!file) return;
  var reader = new FileReader();
  reader.onload = function (evt) {
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
  if (!lockButton('save-my-profile-btn', 2000)) return;
  var newName = document.getElementById('edit-my-name-input').value.trim();
  if (newName) currentUser.name = newName;
  try {
    var res = await fetch('/api/profile/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar })
    });
    var data = await res.json();
    if (data.success) {
      currentUser = data.user;
      localStorage.setItem('messenger_user', JSON.stringify(currentUser));
      updateMyProfileUI(); closeMyProfile();
    }
  } catch (e) { alert('Не удалось обновить профиль'); }
}

/* ---------- ПРОФИЛЬ СОБЕСЕДНИКА ---------- */
function openPeerProfile() {
  if (!activePeer) return;
  if (activePeer.type === 'group') { openGroupProfile(); return; }
  if (isModalOpen('peer-profile-modal')) return;
  renderAvatarIntoElement(document.getElementById('peer-profile-avatar-view'), activePeer, activePeer.isOnline);
  document.getElementById('peer-profile-name-view').innerText = activePeer.name;
  document.getElementById('peer-profile-id-view').innerText = 'ID: ' + activePeer.id;
  var blockBtn = document.getElementById('block-peer-btn');
  var isBlocked = currentUser.blockedContacts && currentUser.blockedContacts.indexOf(activePeer.id) !== -1;
  blockBtn.innerText = isBlocked ? 'Разблокировать' : 'Заблокировать';
  blockBtn.className = isBlocked ? 'btn btn-secondary' : 'btn btn-danger';
  var muteBtn = document.getElementById('mute-peer-btn');
  var isMuted = mutedPeers.indexOf(activePeer.id) !== -1;
  muteBtn.innerText = isMuted ? 'Включить звуковой сигнал' : 'Выключить звуковой сигнал';
  muteBtn.className = isMuted ? 'btn' : 'btn btn-secondary';
  safeOpenModal('peer-profile-modal');
}
function closePeerProfile() { safeCloseModal('peer-profile-modal'); }
function toggleMutePeer() {
  if (!activePeer) return;
  var index = mutedPeers.indexOf(activePeer.id);
  if (index > -1) { mutedPeers.splice(index, 1); } else { mutedPeers.push(activePeer.id); }
  localStorage.setItem('messenger_muted_peers', JSON.stringify(mutedPeers));
  openPeerProfile();
}
async function toggleBlockPeer() {
  if (!activePeer) return;
  if (!lockButton('block-peer-btn', 2000)) return;
  var isBlocked = currentUser.blockedContacts && currentUser.blockedContacts.indexOf(activePeer.id) !== -1;
  var nextBlock = !isBlocked;
  try {
    var res = await fetch('/api/users/block', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, peerId: activePeer.id, block: nextBlock })
    });
    var data = await res.json();
    if (data.success) {
      currentUser.blockedContacts = data.blockedContacts;
      localStorage.setItem('messenger_user', JSON.stringify(currentUser));
      closePeerProfile();
    }
  } catch (e) { alert('Ошибка при изменении статуса блокировки'); }
}

/* ---------- МЕНЮ ЧАТА ОБНОВЛЕНИЕ ---------- */
function updateChatMenu() {
  var menu = document.getElementById('chat-dropdown-menu');
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
  var isGroup = activePeer.type === 'group';
  try {
    await fetch('/api/chat/clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isGroup ? { userId: currentUser.id, groupId: activePeer.id } : { userId: currentUser.id, peerId: activePeer.id })
    });
    getChatMessages(activePeer).forEach(function (m) { m.isDeleted = true; });
    saveCache(); lastMessagesHash = ''; loadMessages();
  } catch (e) { alert('Не удалось очистить историю'); }
}
async function deleteCurrentChat() {
  closeChatDropdown();
  if (!activePeer || !confirm('Удалить чат? Он исчезнет из списка, пока вы снова не напишете этому человеку.')) return;
  try {
    await fetch('/api/chat/hide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, peerId: activePeer.id })
    });
    resetActiveChat(); loadDialogs();
  } catch (e) { alert('Не удалось удалить чат'); }
}
function resetActiveChat() {
  pauseAllAudio(); cancelVoiceAttachment(); cancelAttachment(); closeMobileChat(); activePeer = null;
  document.getElementById('input-bar').style.display = 'none';
  document.getElementById('active-peer-name').innerText = 'Выберите чат';
  document.getElementById('active-peer-status').innerText = 'нажмите для профиля';
  document.getElementById('messages-container').innerHTML = '<div class="empty-state">Выберите диалог слева или найдите пользователя в поиске</div>';
}

/* ---------- ДИАЛОГИ ---------- */
async function loadDialogs() {
  if (document.getElementById('search-input').value.trim()) return;
  try {
    var res = await fetch('/api/dialogs/' + currentUser.id);
    var dialogs = await res.json();
    dialogs.forEach(function (d) { cacheUser(d); });
    lastDialogsHash = JSON.stringify(dialogs);
    renderChatList(dialogs);
  } catch (e) {
    var fallback = [];
    for (var k in localKnownUsers) if (localKnownUsers.hasOwnProperty(k)) {
      var u = localKnownUsers[k];
      fallback.push({ id: u.id, type: 'user', name: u.name, avatar: u.avatar || '', isOnline: false, lastTs: 0 });
    }
    if (fallback.length) renderChatList(fallback);
  }
}
async function loadDialogsQuiet() {
  if (document.getElementById('search-input').value.trim()) return;
  try {
    var res = await fetch('/api/dialogs/' + currentUser.id);
    var dialogs = await res.json();
    dialogs.forEach(function (d) { cacheUser(d); });
    var currentHash = JSON.stringify(dialogs);
    if (currentHash !== lastDialogsHash) { lastDialogsHash = currentHash; renderChatList(dialogs); }
  } catch (e) {}
}
async function onSearchInput() {
  var q = document.getElementById('search-input').value.trim();
  var clearBtn = document.getElementById('clear-search-btn');
  if (!q) {
    clearBtn.style.display = 'none';
    lastDialogsHash = '';
    loadDialogs();
    return;
  }
  clearBtn.style.display = 'block';
  try {
    var res = await fetch('/api/users/search?q=' + encodeURIComponent(q));
    var users = await res.json();
    users.forEach(function (u) { cacheUser(u); });
    renderChatList(users.filter(function (u) { return u.id !== currentUser.id; }));
  } catch (e) {
    var ql = q.toLowerCase();
    var found = [];
    for (var k in localKnownUsers) if (localKnownUsers.hasOwnProperty(k)) {
      var u = localKnownUsers[k];
      if ((u.id && u.id.toLowerCase().indexOf(ql) !== -1) || (u.name && u.name.toLowerCase().indexOf(ql) !== -1)) {
        found.push({ id: u.id, type: 'user', name: u.name, avatar: u.avatar || '', isOnline: false });
      }
    }
    renderChatList(found.filter(function (u) { return u.id !== currentUser.id; }));
  }
}
function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('clear-search-btn').style.display = 'none';
  lastDialogsHash = '';
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
  list.forEach(function (item) {
    var isGroup = item.type === 'group';
    var div = document.createElement('div');
    div.className = 'chat-item ' + (currentActiveId === item.id ? 'active' : '');
    div.onclick = function () { openChat(item); };
    var avatarId = 'chat_av_' + item.id;
    var subtitle;
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
    var avEl = document.getElementById(avatarId);
    if (isGroup) fillAvatarBox(avEl, item.avatar, '👥');
    else renderAvatarIntoElement(avEl, item, item.isOnline);
  });
}

/* ---------- ОТКРЫТИЕ ЧАТА ---------- */
function openChat(peer) {
  pauseAllAudio();
  cancelVoiceAttachment();
  if (!peer.type) peer.type = 'user';
  activePeer = peer;
  lastMessagesHash = '';
  document.getElementById('active-peer-name').innerText = peer.name;
  var statusEl = document.getElementById('active-peer-status');
  if (peer.type === 'group') {
    statusEl.innerText = (peer.memberCount || (peer.members ? peer.members.length : 0)) + ' участников';
    statusEl.style.color = 'var(--text-muted)';
    renderAvatarIntoElement(document.getElementById('peer-avatar-circle'), peer, false);
  } else {
    if (peer.isOnline) { statusEl.innerText = 'в сети'; statusEl.style.color = '#4cd964'; }
    else { statusEl.innerText = 'не в сети'; statusEl.style.color = 'var(--text-muted)'; }
    renderAvatarIntoElement(document.getElementById('peer-avatar-circle'), peer, peer.isOnline);
    if (!currentUser.contacts) currentUser.contacts = [];
    if (currentUser.contacts.indexOf(peer.id) === -1) {
      currentUser.contacts.push(peer.id);
      localStorage.setItem('messenger_user', JSON.stringify(currentUser));
    }
  }
  document.getElementById('input-bar').style.display = 'flex';
  updateChatMenu();
  document.querySelectorAll('.chat-item').forEach(function (el) { el.classList.remove('active'); });
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
    var res = await fetch(msgFetchUrl());
    var messages = await res.json();
    messages.forEach(mergeMessage);
    saveCache();
    renderMessagesContainer(getChatMessages(activePeer));
    checkVisibleMessages();
  } catch (e) { renderMessagesContainer(getChatMessages(activePeer)); }
}
async function loadMessagesQuiet() {
  if (!activePeer) return;
  try {
    var res = await fetch(msgFetchUrl());
    var messages = await res.json();
    var hasNewMsg = false;
    messages.forEach(function (msg) {
      var known = localMessagesCache.some(function (m) { return m.id === msg.id || (msg.clientId && m.clientId === msg.clientId); });
      if (!known && msg.senderId !== currentUser.id) hasNewMsg = true;
      mergeMessage(msg);
    });
    saveCache();
    var peerMsgs = getChatMessages(activePeer);
    var currentHash = JSON.stringify(peerMsgs.map(function (m) { return m.id + '_' + m.isRead + '_' + (m.readBy ? m.readBy.length : 0) + '_' + m.isDeleted; }));
    if (currentHash !== lastMessagesHash) {
      if (hasNewMsg && lastMessagesHash !== '' && mutedPeers.indexOf(activePeer.id) === -1) playNotificationSound();
      lastMessagesHash = currentHash;
      renderMessagesContainer(peerMsgs);
      checkVisibleMessages();
    }
  } catch (e) {}
}
function openImageViewer(src) {
  if (document.getElementById('image-viewer-modal').classList.contains('active')) return;
  document.getElementById('full-screen-img').src = src;
  document.getElementById('image-viewer-modal').classList.add('active');
}
function closeImageViewer() { document.getElementById('image-viewer-modal').classList.remove('active'); }
function isGroupMsgRead(m) {
  if (!activePeer || activePeer.type !== 'group') return m.isRead;
  var others = (activePeer.members || []).filter(function (x) { return x !== currentUser.id; });
  var rb = (m.readBy || []).filter(function (x) { return x !== currentUser.id; });
  return others.length > 0 && rb.length >= others.length;
}

/* ---------- РЕНДЕР СООБЩЕНИЙ ---------- */
function renderMessagesContainer(messages) {
  var container = document.getElementById('messages-container');
  var isScrolledToBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 80;
  container.innerHTML = '';
  if (!messages || messages.length === 0) {
    cleanupAudioPool([]);
    container.innerHTML = '<div class="empty-state">Нет сообщений. Напишите первыми!</div>';
    return;
  }
  var isGroup = activePeer && activePeer.type === 'group';
  var validIds = [];
  messages.forEach(function (m) {
    var div = document.createElement('div');
    div.className = 'msg ' + (m.senderId === currentUser.id ? 'my' : '') + (m.isPending ? ' pending' : '');
    div.setAttribute('data-msg-id', m.id);
    div.setAttribute('data-sender-id', m.senderId);
    div.oncontextmenu = function (e) {
      if (e.target.tagName === 'AUDIO' || (e.target.closest && e.target.closest('audio'))) return;
      e.preventDefault(); openMsgActions(m, div);
    };
    div.ontouchstart = function (e) {
      if (e.target.tagName === 'AUDIO' || (e.target.closest && e.target.closest('audio'))) return;
      longTouchTimer = setTimeout(function () { openMsgActions(m, div); }, 500);
    };
    div.ontouchend = function () { clearTimeout(longTouchTimer); };
    div.ontouchmove = function () { clearTimeout(longTouchTimer); };
    var html = '';
    if (isGroup && m.senderId !== currentUser.id) {
      html += '<div class="msg-sender">' + escapeHtml(getUserName(m.senderId)) + '</div>';
    }
    if (m.text) html += '<div>' + escapeHtml(m.text) + '</div>';
    var fileType = m.fileType || '';
    if (m.fileData) {
      if (fileType.indexOf('image/') === 0) {
        html += '<img src="' + m.fileData + '" class="media-preview" data-full="1">';
      } else if (fileType.indexOf('video/') === 0) {
        html += '<video src="' + m.fileData + '" controls class="video-preview"></video>';
      } else if (fileType.indexOf('audio/') === 0) {
        html += '<div class="audio-slot" data-audio-msg-id="' + m.id + '"></div>';
        validIds.push(m.id);
      } else {
        html += '<a class="file-link" data-download="1">📁 ' + escapeHtml(m.fileName || 'Файл') + '</a>';
      }
    }
    var ticksHtml = '';
    if (m.senderId === currentUser.id) {
      var read = isGroupMsgRead(m);
      var isReadClass = read ? 'ticks read' : 'ticks';
      var ticksSymbol = m.isPending ? '🕐' : (read ? '✓✓' : '✓');
      ticksHtml = '<span class="' + isReadClass + '">' + ticksSymbol + '</span>';
    }
    html += '<div class="msg-footer"><span>' + escapeHtml(m.timestamp || '') + '</span>' + ticksHtml + '</div>';
    div.innerHTML = html;
    var imgEl = div.querySelector('img[data-full]');
    if (imgEl) imgEl.addEventListener('click', function (e) { e.stopPropagation(); openImageViewer(m.fileData); });
    var dl = div.querySelector('a[data-download]');
    if (dl) dl.addEventListener('click', function (e) { e.stopPropagation(); downloadData(m.fileData, m.fileName); });
    var slot = div.querySelector('.audio-slot');
    if (slot) slot.replaceWith(getOrCreateAudioElement(m));
    container.appendChild(div);
  });
  cleanupAudioPool(validIds);
  if (isScrolledToBottom) container.scrollTop = container.scrollHeight;
}
function downloadData(data, name) {
  if (!data) return;
  var a = document.createElement('a');
  a.href = data; a.download = name || 'download';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
function checkVisibleMessages() {
  if (visibleMsgDebounce) clearTimeout(visibleMsgDebounce);
  visibleMsgDebounce = setTimeout(function () { doCheckVisibleMessages(); }, 300);
}
function doCheckVisibleMessages() {
  if (!activePeer) return;
  var container = document.getElementById('messages-container');
  var msgElements = container.querySelectorAll('.msg');
  var containerRect = container.getBoundingClientRect();
  var isGroup = activePeer.type === 'group';
  var unreadMsgIds = [];
  msgElements.forEach(function (el) {
    var senderId = el.getAttribute('data-sender-id');
    var msgId = el.getAttribute('data-msg-id');
    if (senderId === currentUser.id || msgId.indexOf('tmp_') === 0 || msgId.indexOf('cid_') === 0) return;
    var rect = el.getBoundingClientRect();
    if (rect.top >= containerRect.top && rect.bottom <= containerRect.bottom) {
      var msgObj = localMessagesCache.find(function (m) { return m.id === msgId; });
      if (!msgObj || msgObj.isPending) return;
      if (isGroup) {
        if (!msgObj.readBy) msgObj.readBy = [];
        if (msgObj.readBy.indexOf(currentUser.id) === -1) { msgObj.readBy.push(currentUser.id); unreadMsgIds.push(msgId); }
      } else if (!msgObj.isRead) { msgObj.isRead = true; unreadMsgIds.push(msgId); }
    }
  });
  if (unreadMsgIds.length > 0) {
    saveCache();
    fetch('/api/messages/read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgIds: unreadMsgIds, userId: currentUser.id })
    }).catch(function () {});
  }
}
function openMsgActions(msg, element) {
  if (msg.isPending) return;
  if (document.getElementById('msg-actions-sheet').classList.contains('active')) return;
  selectedMsgId = msg.id; selectedMsgObj = msg;
  document.querySelectorAll('.msg').forEach(function (el) { el.classList.remove('selected-msg'); });
  element.classList.add('selected-msg');
  document.getElementById('action-btn-copy').style.display = (msg.text && !msg.fileData) ? 'block' : 'none';
  document.getElementById('action-btn-download').style.display = msg.fileData ? 'block' : 'none';
  document.getElementById('msg-actions-sheet').classList.add('active');
}
function closeMsgActions() {
  selectedMsgId = null; selectedMsgObj = null;
  document.querySelectorAll('.msg').forEach(function (el) { el.classList.remove('selected-msg'); });
  document.getElementById('msg-actions-sheet').classList.remove('active');
}
function actionCopyText() {
  var t = selectedMsgObj && selectedMsgObj.text;
  closeMsgActions();
  if (t) navigator.clipboard.writeText(t).catch(function () {});
}
function actionDownloadFile() {
  var obj = selectedMsgObj;
  closeMsgActions();
  if (obj && obj.fileData) downloadData(obj.fileData, obj.fileName);
}
async function deleteSelectedMessage() {
  var id = selectedMsgId;
  closeMsgActions();
  if (!id) return;
  localMessagesCache.forEach(function (m) { if (m.id === id) m.isDeleted = true; });
  saveCache();
  lastMessagesHash = '';
  if (activePeer) renderMessagesContainer(getChatMessages(activePeer));
  try { await fetch('/api/messages/' + id, { method: 'DELETE' }); }
  catch (e) { alert('Не удалось удалить сообщение на сервере.'); }
}

/* ---------- ВЛОЖЕНИЯ ---------- */
function triggerFileInput() { document.getElementById('file-input').click(); }
function handleFileSelect(e) {
  var file = e.target.files[0]; if (!file) return;
  var reader = new FileReader();
  reader.onload = function (evt) {
    selectedFile = { data: evt.target.result, name: file.name, type: file.type };
    var thumbImg = document.getElementById('attachment-thumb-img');
    document.getElementById('attachment-name-label').innerText = file.name;
    var typeLabel = document.getElementById('attachment-type-label');
    if (file.type.indexOf('image/') === 0) {
      thumbImg.src = evt.target.result; thumbImg.style.display = 'block'; typeLabel.innerText = 'Фото';
    } else {
      thumbImg.src = ''; thumbImg.style.display = 'none';
      typeLabel.innerText = file.type.indexOf('video/') === 0 ? 'Видео' : (file.type.indexOf('audio/') === 0 ? 'Аудио' : 'Файл');
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

/* ---------- ГОЛОСОВОЕ ПРЕВЬЮ ---------- */
function cancelVoiceAttachment() {
  if (pendingVoice && pendingVoice.url && pendingVoice.url.indexOf('blob:') === 0) {
    try { URL.revokeObjectURL(pendingVoice.url); } catch (e) {}
  }
  pendingVoice = null;
  var box = document.getElementById('audio-attachment-preview');
  if (box) box.classList.remove('active');
  var player = document.getElementById('audio-preview-player');
  if (player) {
    player.pause();
    player.removeAttribute('src');
    try { player.load(); } catch (e) {}
  }
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
function cleanupRecordingNodes() {
  try { if (recordProcessor) recordProcessor.disconnect(); } catch (e) {}
  try { if (recordSourceNode) recordSourceNode.disconnect(); } catch (e) {}
  try { if (recordSilentGain) recordSilentGain.disconnect(); } catch (e) {}
  try { if (recordAudioCtx && recordAudioCtx.state !== 'closed') recordAudioCtx.close(); } catch (e) {}
  recordProcessor = recordSourceNode = recordSilentGain = recordAudioCtx = null;
}
function startRecordingTimer() {
  recordStartedAt = Date.now();
  var panel = document.getElementById('record-panel');
  var timerEl = document.getElementById('recording-timer');
  panel.classList.add('active'); timerEl.innerText = '0:00';
  if (recordingTimerInterval) clearInterval(recordingTimerInterval);
  recordingTimerInterval = setInterval(function () {
    var s = Math.floor((Date.now() - recordStartedAt) / 1000);
    timerEl.innerText = Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0');
  }, 200);
}
function stopRecordingTimer() {
  document.getElementById('record-panel').classList.remove('active');
  if (recordingTimerInterval) { clearInterval(recordingTimerInterval); recordingTimerInterval = null; }
}
async function toggleVoiceRecord() {
  var micBtn = document.getElementById('mic-btn');
  if (isRecording) {
    isRecording = false; micBtn.innerText = '🎙️'; micBtn.classList.remove('recording'); stopRecordingTimer();
    var chunks = audioChunks.slice();
    var capturedRate = recordAudioCtx ? recordAudioCtx.sampleRate : 48000;
    cleanupRecordingNodes();
    try { if (activeStream) activeStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    activeStream = null;
    if (chunks.length === 0) { alert('Запись получилась пустой.'); return; }
    var totalLen = 0; for (var i = 0; i < chunks.length; i++) totalLen += chunks[i].length;
    var merged = new Float32Array(totalLen);
    var off = 0; for (var j = 0; j < chunks.length; j++) { merged.set(chunks[j], off); off += chunks[j].length; }
    var targetRate = 16000;
    var finalSamples = merged, finalRate = capturedRate;
    if (capturedRate > targetRate) {
      var ratio = capturedRate / targetRate;
      var newLen = Math.floor(merged.length / ratio);
      var down = new Float32Array(newLen);
      for (var k = 0; k < newLen; k++) down[k] = merged[Math.floor(k * ratio)] || 0;
      finalSamples = down; finalRate = targetRate;
    }
    var wavBlob = encodeWAV(finalSamples, finalRate);
    var reader = new FileReader();
    reader.onload = function (evt) {
      cancelVoiceAttachment();
      var dataUrl = evt.target.result;
      var url = '';
      try { url = URL.createObjectURL(wavBlob); } catch (e) { url = dataUrl; }
      pendingVoice = { data: dataUrl, name: 'voice_' + Date.now() + '.wav', type: 'audio/wav', url: url };
      var player = document.getElementById('audio-preview-player');
      player.src = url;
      document.getElementById('audio-attachment-preview').classList.add('active');
    };
    reader.readAsDataURL(wavBlob);
    return;
  }
  if (!activePeer) { alert('Сначала выберите чат.'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { alert('Ваш браузер не поддерживает запись с микрофона.'); return; }
  try {
    var stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false
    });
    activeStream = stream;
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC(); recordAudioCtx = ctx;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
    var source = ctx.createMediaStreamSource(stream); recordSourceNode = source;
    var processor = ctx.createScriptProcessor(4096, 1, 1); recordProcessor = processor; audioChunks = [];
    processor.onaudioprocess = function (e) { if (!isRecording) return; audioChunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    var silentGain = ctx.createGain(); silentGain.gain.value = 0; recordSilentGain = silentGain;
    source.connect(processor); processor.connect(silentGain); silentGain.connect(ctx.destination);
    isRecording = true; micBtn.innerText = '🔴'; micBtn.classList.add('recording'); startRecordingTimer();
  } catch (err) {
    var msg = 'Нет доступа к микрофону.';
    if (err && err.name === 'NotAllowedError') msg = 'Вы отклонили доступ к микрофону.';
    else if (err && err.name === 'NotFoundError') msg = 'Микрофон не найден.';
    else if (err && err.name === 'NotReadableError') msg = 'Микрофон занят другим приложением.';
    alert(msg);
    cleanupRecordingNodes();
    try { if (activeStream) activeStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    activeStream = null; isRecording = false; micBtn.innerText = '🎙️'; micBtn.classList.remove('recording'); stopRecordingTimer();
  }
}

/* ---------- ОТПРАВКА ---------- */
async function sendMessagePayload(payload) {
  var text = payload.text || '';
  var file = payload.file || null;
  if (!activePeer) return;
  var isGroup = activePeer.type === 'group';
  var clientId = 'cid_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
  var optimisticMsg = {
    id: clientId, clientId: clientId,
    senderId: currentUser.id,
    receiverId: isGroup ? '' : activePeer.id,
    groupId: isGroup ? activePeer.id : '',
    text: text, fileData: file ? file.data : '', fileName: file ? file.name : '', fileType: file ? file.type : '',
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    ts: Date.now(), isRead: false, readBy: [], isDeleted: false, isPending: true
  };
  mergeMessage(optimisticMsg);
  renderMessagesContainer(getChatMessages(activePeer));
  var container = document.getElementById('messages-container');
  container.scrollTop = container.scrollHeight;
  var body = {
    senderId: currentUser.id,
    receiverId: isGroup ? '' : activePeer.id,
    groupId: isGroup ? activePeer.id : '',
    text: text, fileData: file ? file.data : '', fileName: file ? file.name : '', fileType: file ? file.type : '',
    clientId: clientId
  };
  var payloadStr = JSON.stringify(body);
  var maxAttempts = 3;
  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    var controller = new AbortController();
    var timeoutId = setTimeout(function () { controller.abort(); }, 90000);
    try {
      var res = await fetch('/api/messages/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: payloadStr, signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.status === 403) {
        localMessagesCache = localMessagesCache.filter(function (m) { return m.clientId !== clientId; });
        saveCache();
        renderMessagesContainer(getChatMessages(activePeer));
        alert('Сообщение не доставлено: чат заблокирован.');
        return;
      }
      if (!res.ok) {
        var errText = 'Ошибка сервера (' + res.status + ')';
        try { var j = await res.json(); if (j && j.error) errText = j.error; } catch (e) {}
        throw new Error(errText);
      }
      var data = await res.json();
      if (data && data.message) {
        var rm = Object.assign({}, data.message); rm.isPending = false;
        mergeMessage(rm);
        saveCache();
        renderMessagesContainer(getChatMessages(activePeer));
        loadDialogsQuiet();
        return;
      } else { throw new Error('Пустой ответ сервера'); }
    } catch (e) {
      clearTimeout(timeoutId);
      var isAbort = e && e.name === 'AbortError';
      var isNetwork = e && (e.name === 'TypeError' || /network|failed/i.test(String(e.message)));
      if (!isAbort && !isNetwork) break;
      if (attempt < maxAttempts - 1) await new Promise(function (r) { setTimeout(r, 800 * (attempt + 1)); });
    }
  }
}
async function sendMsg() {
  if (!activePeer) return;
  if (!lockButton('send-btn', 1200)) return;
  var input = document.getElementById('msg-input');
  var text = input.value.trim();
  var fileToSend = selectedFile;
  var voiceToSend = pendingVoice;
  if (!text && !fileToSend && !voiceToSend) return;
  input.value = '';
  if (voiceToSend) {
    var voiceData = { data: voiceToSend.data, name: voiceToSend.name, type: voiceToSend.type };
    cancelVoiceAttachment();
    sendMessagePayload({ text: '', file: voiceData });
    return;
  }
  cancelAttachment();
  sendMessagePayload({ text: text, file: fileToSend });
}

/* ---------- ГРУППЫ ---------- */
async function getContactUsers() {
  try {
    var res = await fetch('/api/dialogs/' + currentUser.id);
    var list = await res.json();
    return list.filter(function (d) { return d.type !== 'group'; });
  } catch (e) {
    var arr = [];
    for (var k in localKnownUsers) if (localKnownUsers.hasOwnProperty(k)) {
      var u = localKnownUsers[k];
      arr.push({ id: u.id, type: 'user', name: u.name, avatar: u.avatar || '' });
    }
    return arr;
  }
}
function renderCheckList(containerId, users, excludeSet) {
  var c = document.getElementById(containerId); c.innerHTML = '';
  var list = users.filter(function (u) { return !excludeSet.has(u.id); });
  if (list.length === 0) {
    c.innerHTML = '<div style="color:var(--text-muted); font-size:13px; padding:8px;">Нет доступных контактов. Сначала начните с кем-нибудь чат.</div>';
    return;
  }
  list.forEach(function (u) {
    var row = document.createElement('label');
    row.className = 'check-row';
    row.innerHTML = '<input type="checkbox" value="' + u.id + '" style="width:18px;height:18px;"><span>' + escapeHtml(u.name) + '</span>';
    c.appendChild(row);
  });
}
function getChecked(containerId) {
  return Array.from(document.querySelectorAll('#' + containerId + ' input[type=checkbox]:checked')).map(function (i) { return i.value; });
}
function openCreateGroup() {
  if (isModalOpen('create-group-modal')) return;
  groupDraftAvatar = '';
  document.getElementById('create-group-name').value = '';
  fillAvatarBox(document.getElementById('create-group-avatar'), '', '👥');
  document.getElementById('create-group-contacts').innerHTML = '<div style="color:var(--text-muted); font-size:13px; padding:8px;">Загрузка контактов…</div>';
  safeOpenModal('create-group-modal');
  getContactUsers().then(function (contacts) {
    renderCheckList('create-group-contacts', contacts, new Set());
  }).catch(function () {
    renderCheckList('create-group-contacts', [], new Set());
  });
}
function closeCreateGroup() { safeCloseModal('create-group-modal'); }
function triggerGroupAvatarInput() { var i = document.getElementById('group-avatar-input'); i.value = ''; i.click(); }
function handleGroupAvatarSelect(e) {
  var file = e.target.files[0]; if (!file) return;
  var reader = new FileReader();
  reader.onload = function (evt) { groupDraftAvatar = evt.target.result; fillAvatarBox(document.getElementById('create-group-avatar'), groupDraftAvatar, '👥'); };
  reader.readAsDataURL(file);
}
async function submitCreateGroup() {
  var name = document.getElementById('create-group-name').value.trim();
  if (!name) { alert('Введите название группы'); return; }
  if (!lockButton('create-group-submit-btn', 5000)) return;
  var members = getChecked('create-group-contacts');
  try {
    var res = await fetch('/api/groups/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, name: name, members: members, avatar: groupDraftAvatar })
    });
    var data = await res.json();
    if (data.success) {
      closeCreateGroup();
      await loadDialogs();
      var g = data.group;
      openChat({ id: g.id, type: 'group', name: g.name, avatar: g.avatar, members: g.members, ownerId: g.ownerId, memberCount: g.members.length });
    } else { alert(data.error || 'Не удалось создать группу'); }
  } catch (e) { alert('Ошибка создания группы'); }
}
async function refreshGroupInfo() {
  if (!activePeer || activePeer.type !== 'group') return;
  try {
    var res = await fetch('/api/groups/' + activePeer.id);
    if (!res.ok) return;
    var g = await res.json();
    activePeer.name = g.name; activePeer.avatar = g.avatar;
    activePeer.members = g.members; activePeer.ownerId = g.ownerId;
    activePeer.memberDetails = g.memberDetails; activePeer.memberCount = g.members.length;
    (g.memberDetails || []).forEach(function (u) { cacheUser(u); });
    document.getElementById('active-peer-name').innerText = g.name;
    document.getElementById('active-peer-status').innerText = g.members.length + ' участников';
    renderAvatarIntoElement(document.getElementById('peer-avatar-circle'), { name: g.name, avatar: g.avatar }, false);
  } catch (e) {}
}
async function openGroupProfile() {
  closeChatDropdown();
  if (!activePeer || activePeer.type !== 'group') return;
  if (isModalOpen('group-profile-modal')) return;
  await refreshGroupInfo();
  var g = activePeer;
  fillAvatarBox(document.getElementById('group-profile-avatar'), g.avatar, '👥');
  document.getElementById('group-profile-name').innerText = g.name;
  document.getElementById('group-profile-count').innerText = (g.members ? g.members.length : 0) + ' участников';
  var isOwner = g.ownerId === currentUser.id;
  var ownerControls = document.getElementById('group-owner-controls');
  ownerControls.style.display = isOwner ? 'block' : 'none';
  if (isOwner) { document.getElementById('edit-group-name').value = g.name; editGroupDraftAvatar = ''; }
  renderMembersList('group-members-list', g.memberDetails || [], g.ownerId);
  safeOpenModal('group-profile-modal');
}
function closeGroupProfile() { safeCloseModal('group-profile-modal'); }
function renderMembersList(containerId, memberDetails, ownerId) {
  var c = document.getElementById(containerId); c.innerHTML = '';
  memberDetails.forEach(function (u) {
    var row = document.createElement('div'); row.className = 'member-row';
    var isOwner = u.id === ownerId;
    var isMe = u.id === currentUser.id;
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
function triggerEditGroupAvatarInput() { var i = document.getElementById('edit-group-avatar-input'); i.value = ''; i.click(); }
function handleEditGroupAvatarSelect(e) {
  var file = e.target.files[0]; if (!file) return;
  var reader = new FileReader();
  reader.onload = function (evt) { editGroupDraftAvatar = evt.target.result; fillAvatarBox(document.getElementById('group-profile-avatar'), editGroupDraftAvatar, '👥'); };
  reader.readAsDataURL(file);
}
async function saveGroupChanges() {
  if (!activePeer || activePeer.type !== 'group') return;
  if (!lockButton('save-group-btn', 3000)) return;
  var name = document.getElementById('edit-group-name').value.trim();
  var body = { groupId: activePeer.id, userId: currentUser.id, name: name };
  if (editGroupDraftAvatar) body.avatar = editGroupDraftAvatar;
  try {
    var res = await fetch('/api/groups/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    var data = await res.json();
    if (data.success) {
      editGroupDraftAvatar = '';
      await refreshGroupInfo();
      openGroupProfile();
      loadDialogsQuiet();
    } else { alert(data.error || 'Не удалось сохранить'); }
  } catch (e) { alert('Ошибка сохранения группы'); }
}
async function openAddMembers() {
  if (!activePeer || activePeer.type !== 'group') return;
  if (isModalOpen('add-members-modal')) return;
  document.getElementById('add-members-contacts').innerHTML = '<div style="color:var(--text-muted); font-size:13px; padding:8px;">Загрузка…</div>';
  safeOpenModal('add-members-modal');
  var contacts = await getContactUsers();
  var exclude = new Set(activePeer.members || []);
  renderCheckList('add-members-contacts', contacts, exclude);
}
function closeAddMembers() { safeCloseModal('add-members-modal'); }
async function submitAddMembers() {
  if (!lockButton('add-members-submit-btn', 3000)) return;
  var members = getChecked('add-members-contacts');
  if (members.length === 0) { closeAddMembers(); return; }
  try {
    var res = await fetch('/api/groups/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: activePeer.id, userId: currentUser.id, members: members })
    });
    var data = await res.json();
    if (data.success) { closeAddMembers(); await refreshGroupInfo(); openGroupProfile(); }
    else { alert(data.error || 'Не удалось добавить'); }
  } catch (e) { alert('Ошибка добавления участников'); }
}
async function leaveGroup() {
  closeChatDropdown();
  if (!activePeer || activePeer.type !== 'group') return;
  if (!confirm('Покинуть группу «' + activePeer.name + '»?')) return;
  try {
    await fetch('/api/groups/leave', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: activePeer.id, userId: currentUser.id })
    });
    closeGroupProfile();
    resetActiveChat();
    loadDialogs();
  } catch (e) { alert('Не удалось покинуть группу'); }
}

/* ---------- ИНИЦИАЛИЗАЦИЯ ---------- */
window.addEventListener('DOMContentLoaded', function () {
  updateThemeIcon(savedTheme);
  document.querySelectorAll('.modal-overlay').forEach(function (ov) {
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.classList.remove('active'); });
  });
  var savedUser = localStorage.getItem('messenger_user');
  if (savedUser) {
    try { currentUser = JSON.parse(savedUser); startApp(); } catch (e) {}
  }
});
`;

/* ==================== РАЗДАЧА КЛИЕНТА ==================== */
app.get('/client.js', function (req, res) {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.send(CLIENT_JS);
});

app.use(function (req, res) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(CLIENT_HTML);
});

/* ==================== ОБРАБОТКА ОШИБОК ==================== */
app.use(function (err, req, res, next) {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Файл слишком большой' });
  }
  if (err && (err instanceof SyntaxError || err.type === 'entity.parse.failed')) {
    return res.status(400).json({ error: 'Некорректный JSON' });
  }
  console.error('[ОШИБКА EXPRESS]:', err && err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

/* ==================== СТАРТ ==================== */
const httpServer = app.listen(PORT, '0.0.0.0', function () {
  console.log('[СЕРВЕР ЗАПУЩЕН] Порт: ' + PORT);
});
httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 66000;
httpServer.requestTimeout = 0;
httpServer.timeout = 0;
