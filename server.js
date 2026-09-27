const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const SERVER_VERSION = '3.0.0';
const MIN_CLIENT_VERSION = '1.0.0';
const API_VERSION = 'v3';

app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use('/api/upload/chunk', express.raw({ type: 'application/octet-stream', limit: '5mb' }));

process.on('uncaughtException', function (err) { console.error('[СЕРВЕР]:', err); });
process.on('unhandledRejection', function (r) { console.error('[ПРОМИС]:', r); });

const SERV_DIR = __dirname;
const ARXIV_DIR = path.join(SERV_DIR, 'arxiv');
const ACCOUNTS_DIR = path.join(ARXIV_DIR, 'accounts');
const MESSAGES_DIR = path.join(ARXIV_DIR, 'messages');
const GROUPS_DIR = path.join(ARXIV_DIR, 'groups');
const FILES_DIR = path.join(ARXIV_DIR, 'files');

[ARXIV_DIR, ACCOUNTS_DIR, MESSAGES_DIR, GROUPS_DIR, FILES_DIR].forEach(function (dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const ACCOUNTS_FILE = path.join(ACCOUNTS_DIR, 'accounts.json');
const MESSAGES_FILE = path.join(MESSAGES_DIR, 'messages.json');
const GROUPS_FILE = path.join(GROUPS_DIR, 'groups.json');

const CHUNK_SIZE_LIMIT = 1024 * 1024;
const MAX_FILE_SIZE = 200 * 1024 * 1024;
const uploads = new Map();

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
  } catch (e) { console.error('[ОШИБКА ЗАПИСИ]:', e); }
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

app.get('/api/health', function (req, res) {
  res.json({ ok: true, serverTime: Date.now(), serverVersion: SERVER_VERSION, minClientVersion: MIN_CLIENT_VERSION, apiVersion: API_VERSION });
});

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
  const groups = readGroups();
  if (Array.isArray(knownUsers)) {
    knownUsers.forEach(function (kUser) {
      if (!kUser.id || kUser.id === id) return;
      const existing = accounts.find(function (a) { return a.id === kUser.id; });
      if (!existing) {
        accounts.push({ id: kUser.id, name: kUser.name || 'Пользователь', avatar: kUser.avatar || '', contacts: [], blockedContacts: [], hiddenDialogs: [], updatedAt: 0 });
      } else {
        if (kUser.name) existing.name = kUser.name;
        if (kUser.avatar !== undefined) existing.avatar = kUser.avatar;
      }
    });
  }
  let user = accounts.find(function (u) { return u.id === id; });
  if (!user) {
    user = { id: id, name: name || 'Пользователь', avatar: avatar || '', contacts: Array.isArray(contacts) ? contacts : [], blockedContacts: [], hiddenDialogs: [], updatedAt: Date.now() };
    accounts.push(user);
  } else {
    user.updatedAt = Date.now();
    if (name) user.name = name;
    if (avatar !== undefined) user.avatar = avatar;
    if (Array.isArray(contacts)) {
      if (!user.contacts) user.contacts = [];
      contacts.forEach(function (cid) { if (user.contacts.indexOf(cid) === -1) user.contacts.push(cid); });
    }
  }
  groups.forEach(function (g) {
    if (g.members.indexOf(id) !== -1) {
      g.members.forEach(function (mId) {
        if (mId !== id && user.contacts.indexOf(mId) === -1) user.contacts.push(mId);
      });
    }
  });
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
      return { id: u.id, type: 'user', name: u.name, avatar: u.avatar || '', isOnline: u.updatedAt && (now - u.updatedAt < 8000) };
    });
  res.json(results);
});

/* ==================== ГРУППЫ ==================== */
app.post('/api/groups/create', function (req, res) {
  const userId = req.body.userId, name = req.body.name, members = req.body.members, avatar = req.body.avatar;
  if (!userId) return res.status(400).json({ error: 'Нет пользователя' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Введите название группы' });
  if (!Array.isArray(members) || members.length === 0) return res.status(400).json({ error: 'Выберите хотя бы одного участника' });
  const accounts = readAccounts();
  const creator = accounts.find(function (u) { return u.id === userId; });
  const contactsSet = new Set(creator && creator.contacts ? creator.contacts : []);
  const validMembers = members.filter(function (mId) { return mId !== userId && contactsSet.has(mId); });
  if (validMembers.length === 0) return res.status(400).json({ error: 'Выбранные пользователи недоступны' });
  const memberSet = new Set([userId].concat(validMembers));
  const groups = readGroups();
  const group = { id: genId('grp_'), name: name.trim(), avatar: avatar || '', ownerId: userId, members: Array.from(memberSet), createdAt: Date.now() };
  groups.push(group);
  writeGroups(groups);
  if (creator) {
    if (!creator.contacts) creator.contacts = [];
    group.members.forEach(function (mId) {
      if (mId !== userId && creator.contacts.indexOf(mId) === -1) creator.contacts.push(mId);
    });
    writeAccounts(accounts);
  }
  res.json({ success: true, group: group });
});

function groupWithDetails(group) {
  const accounts = readAccounts();
  const now = Date.now();
  const memberDetails = group.members.map(function (mId) {
    const u = accounts.find(function (a) { return a.id === mId; });
    return { id: mId, name: u ? u.name : 'Пользователь', avatar: u ? (u.avatar || '') : '', isOnline: u && u.updatedAt && (now - u.updatedAt < 8000) };
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
  if (g.ownerId !== userId) return res.status(403).json({ error: 'Только создатель' });
  if (name && name.trim()) g.name = name.trim();
  if (avatar !== undefined) g.avatar = avatar;
  writeGroups(groups);
  res.json({ success: true, group: groupWithDetails(g) });
});

app.post('/api/groups/add', function (req, res) {
  const groupId = req.body.groupId, userId = req.body.userId, members = req.body.members;
  if (!Array.isArray(members) || members.length === 0) return res.status(400).json({ error: 'Выберите хотя бы одного' });
  const groups = readGroups();
  const g = groups.find(function (x) { return x.id === groupId; });
  if (!g) return res.status(404).json({ error: 'Группа не найдена' });
  if (g.ownerId !== userId) return res.status(403).json({ error: 'Только создатель' });
  const accounts = readAccounts();
  const owner = accounts.find(function (u) { return u.id === userId; });
  const contactsSet = new Set(owner && owner.contacts ? owner.contacts : []);
  var added = 0;
  members.forEach(function (mId) {
    if (contactsSet.has(mId) && g.members.indexOf(mId) === -1) { g.members.push(mId); added++; }
  });
  if (added === 0) return res.status(400).json({ error: 'Никто не добавлен' });
  writeGroups(groups);
  res.json({ success: true, group: groupWithDetails(g) });
});

app.post('/api/groups/kick', function (req, res) {
  const groupId = req.body.groupId, userId = req.body.userId, memberId = req.body.memberId;
  const groups = readGroups();
  const g = groups.find(function (x) { return x.id === groupId; });
  if (!g) return res.status(404).json({ error: 'Группа не найдена' });
  if (g.ownerId !== userId) return res.status(403).json({ error: 'Только создатель' });
  if (memberId === userId) return res.status(400).json({ error: 'Нельзя себя' });
  if (g.members.indexOf(memberId) === -1) return res.status(404).json({ error: 'Не найден' });
  g.members = g.members.filter(function (m) { return m !== memberId; });
  writeGroups(groups);
  res.json({ success: true, group: groupWithDetails(g) });
});

app.post('/api/groups/delete', function (req, res) {
  const groupId = req.body.groupId, userId = req.body.userId;
  let groups = readGroups();
  const g = groups.find(function (x) { return x.id === groupId; });
  if (!g) return res.status(404).json({ error: 'Группа не найдена' });
  if (g.ownerId !== userId) return res.status(403).json({ error: 'Только создатель' });
  groups = groups.filter(function (x) { return x.id !== groupId; });
  writeGroups(groups);
  res.json({ success: true });
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
  const fileUrl = req.body.fileUrl, fileSize = req.body.fileSize;
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
    if (sender && sender.blockedContacts && sender.blockedContacts.indexOf(receiverId) !== -1) return res.status(403).json({ error: 'Вы заблокировали' });
    if (receiver && receiver.blockedContacts && receiver.blockedContacts.indexOf(senderId) !== -1) return res.status(403).json({ error: 'Вы заблокированы' });
    if (sender && sender.hiddenDialogs) sender.hiddenDialogs = sender.hiddenDialogs.filter(function (id) { return id !== receiverId; });
    if (receiver && receiver.hiddenDialogs) receiver.hiddenDialogs = receiver.hiddenDialogs.filter(function (id) { return id !== senderId; });
    if (sender) { if (!sender.contacts) sender.contacts = []; if (sender.contacts.indexOf(receiverId) === -1) sender.contacts.push(receiverId); }
    if (receiver) { if (!receiver.contacts) receiver.contacts = []; if (receiver.contacts.indexOf(senderId) === -1) receiver.contacts.push(senderId); }
    writeAccounts(accounts);
  }
  const newMsg = {
    id: genId('msg_'), clientId: clientId || '',
    senderId: senderId,
    receiverId: groupId ? '' : receiverId,
    groupId: groupId || '',
    text: encryptText(text || ''),
    fileData: fileData || '',
    fileUrl: fileUrl || '',
    fileName: fileName || '',
    fileType: fileType || '',
    fileSize: fileSize || 0,
    timestamp: timeStr(), ts: Date.now(),
    isRead: false, readBy: [], isDeleted: false, clearedFor: []
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
      if (userId && m.senderId !== userId && m.readBy.indexOf(userId) === -1) { m.readBy.push(userId); changed = true; }
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
    const isDmMatch = !groupId && ((m.senderId === userId && m.receiverId === peerId) || (m.senderId === peerId && m.receiverId === userId));
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
      return !m.isDeleted && m.groupId === groupId && !(m.clearedFor && userId && m.clearedFor.indexOf(userId) !== -1);
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
  if (currentUser) {
    groups.forEach(function (g) {
      if (g.members.indexOf(userId) !== -1) {
        g.members.forEach(function (mId) { if (mId !== userId) peerIds.add(mId); });
      }
    });
  }
  const userDialogs = accounts
    .filter(function (u) { return peerIds.has(u.id) && u.id !== userId && !hiddenSet.has(u.id); })
    .map(function (u) {
      return { id: u.id, type: 'user', name: u.name, avatar: u.avatar || '', isOnline: u.updatedAt && (now - u.updatedAt < 8000), lastTs: lastTs[u.id] || 0 };
    });
  const groupDialogs = groups
    .filter(function (g) { return g.members.indexOf(userId) !== -1; })
    .map(function (g) {
      return { id: g.id, type: 'group', name: g.name, avatar: g.avatar || '', ownerId: g.ownerId, members: g.members, memberCount: g.members.length, lastTs: lastTs['grp:' + g.id] || 0 };
    });
  const all = userDialogs.concat(groupDialogs).sort(function (a, b) { return (b.lastTs || 0) - (a.lastTs || 0); });
  res.json(all);
});

/* ==================== FILES ==================== */
// Файлы храним ТОЛЬКО как временный кеш. Главный источник — IndexedDB клиента.
app.post('/api/upload/init', function (req, res) {
  const { senderId, fileName, fileSize, fileType } = req.body;
  if (!senderId) return res.status(400).json({ error: 'No sender' });
  if (fileSize > MAX_FILE_SIZE) return res.status(413).json({ error: 'Too big' });
  const fileId = 'f_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const totalChunks = Math.ceil((fileSize || 0) / CHUNK_SIZE_LIMIT);
  uploads.set(fileId, { fileId, fileName, fileSize, fileType, senderId, totalChunks, chunks: [], received: 0, startedAt: Date.now() });
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
  uploads.delete(fileId);
  // Очищаем старые файлы — держим только последние 500 на сервере (кэш)
  try {
    const files = fs.readdirSync(FILES_DIR).map(function (f) {
      return { name: f, mtime: fs.statSync(path.join(FILES_DIR, f)).mtimeMs };
    }).sort(function (a, b) { return b.mtime - a.mtime; });
    if (files.length > 500) {
      files.slice(500).forEach(function (f) {
        try { fs.unlinkSync(path.join(FILES_DIR, f.name)); } catch (e) {}
      });
    }
  } catch (e) {}
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
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg', '.mov': 'video/quicktime',
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
  #status-bar { position: fixed; top: 0; left: 0; right: 0; padding: 8px; text-align: center; font-size: 13px; font-weight: 600; z-index: 9999; transition: transform 0.3s; transform: translateY(-100%); }
  #status-bar.visible { transform: translateY(0); }
  #status-bar.internet-off { background: #e53935; color: #fff; }
  #status-bar.server-off { background: #f9a825; color: #000; }
  #status-bar.reconnected { background: #4cd964; color: #fff; }
  #loading-screen { display: none; position: fixed; inset: 0; background: var(--bg-app); z-index: 10000; flex-direction: column; align-items: center; justify-content: center; gap: 20px; padding: 20px; text-align: center; }
  #loading-screen.active { display: flex; }
  .spinner { width: 50px; height: 50px; border: 4px solid var(--bg-input); border-top-color: var(--accent); border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-text { color: var(--text-muted); font-size: 15px; }
  .loading-title { font-size: 20px; font-weight: bold; }
  .version-info { position: fixed; bottom: 8px; right: 10px; font-size: 10px; color: var(--text-muted); z-index: 9998; opacity: 0.6; pointer-events: none; }
  #app-container { display: flex; width: 100%; height: 100%; }
  .sidebar { width: 320px; background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
  .sidebar-header { padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }
  .user-profile-bar { display: flex; align-items: center; justify-content: space-between; padding: 4px; cursor: pointer; }
  .user-info-brief { display: flex; flex-direction: column; overflow: hidden; margin-left: 10px; flex: 1; }
  .avatar-circle { width: 40px; height: 40px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; color: #fff; font-weight: bold; flex-shrink: 0; font-size: 16px; position: relative; }
  .avatar-circle img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block; position: relative; z-index: 1; }
  .avatar-circle > span { position: relative; z-index: 1; }
  .online-indicator { position: absolute; bottom: -2px; right: -2px; width: 12px; height: 12px; background: #4cd964; border: 2px solid var(--bg-sidebar); border-radius: 50%; display: none; z-index: 999; box-sizing: content-box; }
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
  .msg.pending { opacity: 0.6; }
  .msg.selected-msg { background: var(--msg-selected) !important; outline: 2px solid var(--accent); }
  .msg-sender { font-size: 12px; font-weight: bold; color: var(--accent); margin-bottom: 2px; }
  .media-preview { width: 260px; height: 180px; max-width: 100%; border-radius: 8px; margin-top: 6px; object-fit: cover; display: block; background: #000; cursor: pointer; }
  .video-preview { width: 260px; max-width: 100%; border-radius: 8px; margin-top: 6px; display: block; background: #000; }
  .file-link { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-input); border-radius: 6px; color: var(--accent); text-decoration: none; margin-top: 5px; font-size: 13px; }
  .file-placeholder { padding: 8px 12px; background: var(--bg-input); border-radius: 6px; margin-top: 5px; font-size: 12px; color: var(--text-muted); }
  .audio-preview { width: 240px !important; max-width: 240px !important; height: 40px; margin-top: 5px; display: block; }
  .media-loading { padding: 8px 12px; background: var(--bg-input); border-radius: 6px; margin-top: 5px; font-size: 12px; color: var(--text-muted); }
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
  <div id="status-bar"></div>
  <div class="version-info" id="version-info"></div>
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
  <script src="/client.js"></script>
</body>
</html>`;

/* ==================== CLIENT JS ==================== */
const CLIENT_JS = `
var CLIENT_VERSION = '3.0.0';
var SCHEMA_VERSION_KEY = 'messenger_schema_version';

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
var localKnownUsers = {};
var mutedPeers = [];
var localMessagesCache = [];
var savedTheme = localStorage.getItem('app_theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);
var busyButtons = {};
var dialogsPollingTimer = null;
var draftAvatar = null;
var activeMemberDropdown = null;
var profileTargetId = null;
var connectionState = 'checking';
var statusBarTimeout = null;
var CHUNK_SIZE = 500 * 1024;
var MAX_FILE_SIZE = 200 * 1024 * 1024;
var serverVersion = 'unknown';
var serverMinClientVersion = '0.0.0';
var pingFailCount = 0;
var healthFailCount = 0;
var isRetrying = false;
var filesDB = null;
var fileUrlCache = new Map();
var activeUploads = {};  // clientId -> {file, url}

/* ==================== INDEXEDDB ДЛЯ ФАЙЛОВ ==================== */
function openFilesDB() {
  return new Promise(function (resolve, reject) {
    if (filesDB) return resolve(filesDB);
    if (!window.indexedDB) return reject(new Error('No IndexedDB'));
    var req = indexedDB.open('messenger_files_v1', 1);
    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'key' });
      }
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
      tx.objectStore('files').put({
        key: key, blob: blob,
        fileName: (meta && meta.fileName) || '',
        fileType: (meta && meta.fileType) || '',
        fileSize: (meta && meta.fileSize) || blob.size,
        savedAt: Date.now()
      });
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

async function blobFromDataUrl(dataUrl) {
  try {
    var res = await fetch(dataUrl);
    return await res.blob();
  } catch (e) { return null; }
}

async function getFileUrl(msg) {
  if (fileUrlCache.has(msg.id)) return fileUrlCache.get(msg.id);
  // 1. IDB
  var entry = await getFileFromIDB(msg.id);
  if (entry && entry.blob) {
    var url = URL.createObjectURL(entry.blob);
    fileUrlCache.set(msg.id, url);
    return url;
  }
  // 2. fileData base64
  if (msg.fileData) {
    try {
      var blob = await blobFromDataUrl(msg.fileData);
      if (blob) {
        await saveFileToIDB(msg.id, blob, { fileName: msg.fileName, fileType: msg.fileType, fileSize: blob.size });
        var url2 = URL.createObjectURL(blob);
        fileUrlCache.set(msg.id, url2);
        return url2;
      }
    } catch (e) {}
    return msg.fileData;  // fallback
  }
  // 3. fileUrl с сервера
  if (msg.fileUrl) {
    // Пробуем скачать и сохранить в IDB
    try {
      var res = await fetch(msg.fileUrl);
      if (res.ok) {
        var blob2 = await res.blob();
        await saveFileToIDB(msg.id, blob2, { fileName: msg.fileName, fileType: msg.fileType, fileSize: blob2.size });
        var url3 = URL.createObjectURL(blob2);
        fileUrlCache.set(msg.id, url3);
        return url3;
      }
    } catch (e) {}
    return msg.fileUrl;  // fallback — сервер (может 404)
  }
  return null;
}

/* ==================== ВЕРСИИ ==================== */
function compareVersions(a, b) {
  var aP = String(a || '0').split('.').map(function (n) { return parseInt(n, 10) || 0; });
  var bP = String(b || '0').split('.').map(function (n) { return parseInt(n, 10) || 0; });
  var max = Math.max(aP.length, bP.length);
  for (var i = 0; i < max; i++) {
    if ((aP[i] || 0) > (bP[i] || 0)) return 1;
    if ((aP[i] || 0) < (bP[i] || 0)) return -1;
  }
  return 0;
}

function runClientMigrations() {
  var storedVersion = localStorage.getItem(SCHEMA_VERSION_KEY) || '1.0.0';
  if (storedVersion === CLIENT_VERSION) return;
  console.log('[MIGRATION] ' + storedVersion + ' → ' + CLIENT_VERSION);
  // Поля добавляются автоматически при загрузке (см. loadLocalData ниже)
  localStorage.setItem(SCHEMA_VERSION_KEY, CLIENT_VERSION);
}

/* ==================== ЗАГРУЗКА ИЗ LOCALSTORAGE ==================== */
function loadLocalData() {
  try { currentUser = JSON.parse(localStorage.getItem('messenger_user') || 'null'); } catch (e) { currentUser = null; }
  try { localKnownUsers = JSON.parse(localStorage.getItem('messenger_known_users') || '{}'); } catch (e) { localKnownUsers = {}; }
  try { localMessagesCache = JSON.parse(localStorage.getItem('messenger_messages_cache') || '[]'); } catch (e) { localMessagesCache = []; }
  try { mutedPeers = JSON.parse(localStorage.getItem('messenger_muted_peers') || '[]'); } catch (e) { mutedPeers = []; }
  
  if (currentUser && typeof currentUser === 'object') {
    if (!Array.isArray(currentUser.contacts)) currentUser.contacts = [];
    if (!Array.isArray(currentUser.blockedContacts)) currentUser.blockedContacts = [];
    if (!Array.isArray(currentUser.hiddenDialogs)) currentUser.hiddenDialogs = [];
  }
  Object.keys(localKnownUsers).forEach(function (uid) {
    var u = localKnownUsers[uid];
    if (u && typeof u === 'object') {
      if (!u.id) u.id = uid;
      if (!u.name) u.name = 'Пользователь';
      if (u.avatar === undefined) u.avatar = '';
    }
  });
  localMessagesCache.forEach(function (m) {
    if (!m || typeof m !== 'object') return;
    if (!m.id) m.id = 'msg_migrated_' + Math.random().toString(36).substr(2, 9);
    if (m.text === undefined) m.text = '';
    if (m.fileData === undefined) m.fileData = '';
    if (m.fileUrl === undefined) m.fileUrl = '';
    if (m.fileName === undefined) m.fileName = '';
    if (m.fileType === undefined) m.fileType = '';
    if (m.fileSize === undefined) m.fileSize = 0;
    if (!m.timestamp) m.timestamp = '';
    if (typeof m.ts !== 'number') m.ts = Date.now();
    if (!Array.isArray(m.readBy)) m.readBy = [];
    if (typeof m.isRead !== 'boolean') m.isRead = false;
    if (typeof m.isDeleted !== 'boolean') m.isDeleted = false;
    if (!Array.isArray(m.clearedFor)) m.clearedFor = [];
    if (!m.senderId) m.senderId = '';
    if (m.receiverId === undefined) m.receiverId = '';
    if (m.groupId === undefined) m.groupId = '';
    if (typeof m.isPending !== 'boolean') m.isPending = false;
  });
}

function saveCache() {
  try { localStorage.setItem('messenger_messages_cache', JSON.stringify(localMessagesCache.slice(-500))); } catch (e) {}
}
function saveKnownUsers() {
  try { localStorage.setItem('messenger_known_users', JSON.stringify(localKnownUsers)); } catch (e) {}
}
function saveUser() {
  try { localStorage.setItem('messenger_user', JSON.stringify(currentUser)); } catch (e) {}
}

/* ==================== КНОПКИ ==================== */
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

/* ==================== МОДАЛКИ ==================== */
function isModalOpen(id) { var el = document.getElementById(id); return !!(el && el.classList.contains('active')); }
function safeOpenModal(id) { if (isModalOpen(id)) return false; document.getElementById(id).classList.add('active'); return true; }
function safeCloseModal(id) { var el = document.getElementById(id); if (el) el.classList.remove('active'); }

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
    if (bar.dataset.wasOffline === '1') {
      bar.innerText = '✓ Подключено';
      bar.className = 'visible reconnected';
      statusBarTimeout = setTimeout(function () { bar.classList.remove('visible'); bar.dataset.wasOffline = '0'; }, 2000);
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
  if (currentUser) { ls.classList.remove('active'); return; }
  if (connectionState === 'online') {
    ls.classList.remove('active');
  } else if (connectionState === 'no-internet') {
    ls.classList.add('active');
    title.innerText = 'Нет подключения к интернету';
    text.innerText = 'Проверьте соединение';
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
  if (!navigator.onLine) { setConnectionState('no-internet'); return false; }
  try {
    var ctrl = new AbortController();
    var tm = setTimeout(function () { ctrl.abort(); }, 8000);
    var res = await fetch('/api/health?_=' + Date.now(), { signal: ctrl.signal });
    clearTimeout(tm);
    if (res.ok) {
      var data = await res.json();
      serverVersion = data.serverVersion || 'unknown';
      serverMinClientVersion = data.minClientVersion || '0.0.0';
      updateVersionInfo();
      if (compareVersions(CLIENT_VERSION, serverMinClientVersion) < 0) { showUpdateRequired(); return false; }
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
  if (el) el.innerText = 'client v' + CLIENT_VERSION + ' · server v' + serverVersion;
}
function showUpdateRequired() {
  var ls = document.getElementById('loading-screen');
  var title = document.getElementById('loading-title');
  var text = document.getElementById('loading-text');
  if (!ls) return;
  ls.classList.add('active');
  title.innerText = 'Требуется обновление';
  text.innerText = 'Обновите страницу (Ctrl+Shift+R)';
  var sp = ls.querySelector('.spinner');
  if (sp) sp.style.display = 'none';
}
window.addEventListener('online', async function () {
  healthFailCount = 0; pingFailCount = 0;
  var ok = await checkServerHealth();
  if (ok && currentUser) { loadDialogs(); if (activePeer) loadMessages(); retryPendingMessages(); }
});
window.addEventListener('offline', function () { setConnectionState('no-internet'); });

/* ==================== УТИЛИТЫ ==================== */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return (bytes || 0) + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' ГБ';
}
function mergeMessage(msg) {
  if (!msg || !msg.id) return;
  for (var i = 0; i < localMessagesCache.length; i++) {
    var m = localMessagesCache[i];
    if (m.id === msg.id || (msg.clientId && m.clientId && m.clientId === msg.clientId)) {
      // Сохраняем fileUrl если он был, а новый без него
      if (!msg.fileUrl && m.fileUrl) msg.fileUrl = m.fileUrl;
      if (!msg.fileData && m.fileData) msg.fileData = m.fileData;
      localMessagesCache[i] = msg;
      saveCache();
      return;
    }
  }
  localMessagesCache.push(msg);
  saveCache();
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
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      var isPng = file.type === 'image/png';
      try { callback(canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', isPng ? undefined : (quality || 0.85))); }
      catch (err) { callback(e.target.result); }
    };
    img.onerror = function () { callback(e.target.result); };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

/* ==================== МЕНЮ ЧАТА ==================== */
function toggleChatDropdown() { var m = document.getElementById('chat-dropdown-menu'); if (m) m.classList.toggle('active'); }
function closeChatDropdown() { var m = document.getElementById('chat-dropdown-menu'); if (m) m.classList.remove('active'); }
document.addEventListener('click', function (e) {
  var menu = document.getElementById('chat-dropdown-menu');
  var dotsBtn = document.getElementById('chat-menu-dots-btn');
  if (menu && menu.classList.contains('active')) {
    if (!menu.contains(e.target) && e.target !== dotsBtn && !dotsBtn.contains(e.target)) menu.classList.remove('active');
  }
});

/* ==================== АВАТАРЫ ==================== */
function renderAvatarIntoElement(el, userObj, isOnline) {
  if (!el) return;
  var renderKey = (userObj && userObj.id ? userObj.id : '') + '|' +
                  (userObj && userObj.avatar ? String(userObj.avatar).substring(0, 30) : '') + '|' +
                  (userObj && userObj.name ? userObj.name : '');
  if (el.dataset.renderKey === renderKey) {
    var ind = el.querySelector('.online-indicator');
    if (ind) {
      if (isOnline) ind.classList.add('visible'); else ind.classList.remove('visible');
    }
    return;
  }
  el.dataset.renderKey = renderKey;
  var indicator = el.querySelector('.online-indicator');
  Array.from(el.childNodes).forEach(function (node) { if (node !== indicator) el.removeChild(node); });
  var avatarSrc = userObj && userObj.avatar;
  if (avatarSrc) {
    var img = document.createElement('img');
    img.src = avatarSrc;
    img.onerror = function () {
      this.remove();
      var span = document.createElement('span');
      span.innerText = ((userObj && userObj.name) ? userObj.name.charAt(0).toUpperCase() : '?');
      if (indicator) el.insertBefore(span, indicator); else el.appendChild(span);
    };
    if (indicator) el.insertBefore(img, indicator); else el.appendChild(img);
  } else {
    var span2 = document.createElement('span');
    span2.innerText = (userObj && userObj.name ? userObj.name.charAt(0).toUpperCase() : '?');
    if (indicator) el.insertBefore(span2, indicator); else el.appendChild(span2);
  }
  if (indicator) {
    if (isOnline) indicator.classList.add('visible'); else indicator.classList.remove('visible');
  }
}
function fillAvatarBox(el, avatar, fallback) { renderAvatarIntoElement(el, { avatar: avatar, name: fallback || '?' }, false); }
function cacheUser(user) {
  if (!user || !user.id || user.type === 'group') return;
  localKnownUsers[user.id] = { id: user.id, name: user.name, avatar: user.avatar, updatedAt: Date.now() };
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

/* ==================== РЕГИСТРАЦИЯ ==================== */
async function registerUser() {
  if (busyButtons['login-btn']) return;
  var nameInput = document.getElementById('auth-name');
  var name = nameInput.value.trim();
  var errBox = document.getElementById('auth-error');
  if (!name) { errBox.innerText = 'Введите ваше имя.'; errBox.style.display = 'block'; return; }
  if (!lockButton('login-btn', 5000)) return;
  try {
    var res = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name })
    });
    var data = await res.json();
    if (!data.success) { errBox.innerText = data.error || 'Ошибка'; errBox.style.display = 'block'; return; }
    currentUser = data.user;
    saveUser();
    localStorage.setItem(SCHEMA_VERSION_KEY, CLIENT_VERSION);
    startApp();
  } catch (e) {
    errBox.innerText = 'Сервер недоступен. Проверьте соединение.';
    errBox.style.display = 'block';
    setConnectionState(navigator.onLine ? 'server-offline' : 'no-internet');
  }
}

function startApp() {
  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('active');
  updateMyProfileUI();
  sendPing();
  loadDialogs();
  if (dialogsPollingTimer) clearInterval(dialogsPollingTimer);
  dialogsPollingTimer = setInterval(function () {
    if (currentUser && !isRecording) {
      sendPing();
      retryPendingMessages();
      loadDialogsQuiet();
      if (activePeer) {
        loadMessagesQuiet();
        if (activePeer.type === 'group') refreshGroupInfo();
        else refreshActivePeerStatus();
      }
    }
  }, 2000);
  setInterval(async function () {
    if (!currentUser) return;
    var wasOnline = connectionState === 'online';
    var ok = await checkServerHealth();
    if (ok && !wasOnline) { loadDialogs(); if (activePeer) loadMessages(); retryPendingMessages(); }
  }, 4000);
}

/* ==================== PING ==================== */
async function sendPing() {
  if (!currentUser) return;
  try {
    var knownList = [];
    for (var k in localKnownUsers) if (localKnownUsers.hasOwnProperty(k)) knownList.push(localKnownUsers[k]);
    var res = await fetch('/api/ping', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar || '', contacts: currentUser.contacts || [], knownUsers: knownList })
    });
    var data = await res.json();
    pingFailCount = 0;
    if (connectionState !== 'online' && navigator.onLine) setConnectionState('online');
    if (data.success && data.user) {
      var serverUser = data.user;
      var changed = false;
      if (serverUser.name && serverUser.name !== currentUser.name) { currentUser.name = serverUser.name; changed = true; }
      if (serverUser.avatar !== undefined && serverUser.avatar !== currentUser.avatar) { currentUser.avatar = serverUser.avatar; changed = true; }
      if (serverUser.contacts) {
        if (!currentUser.contacts) currentUser.contacts = [];
        serverUser.contacts.forEach(function (c) { if (currentUser.contacts.indexOf(c) === -1) currentUser.contacts.push(c); });
        changed = true;
      }
      if (serverUser.blockedContacts) currentUser.blockedContacts = serverUser.blockedContacts;
      if (changed) { saveUser(); updateMyProfileUI(); }
    }
  } catch (e) {
    pingFailCount++;
    if (!navigator.onLine) setConnectionState('no-internet');
    else if (pingFailCount >= 3) setConnectionState('server-offline');
  }
}

async function refreshActivePeerStatus() {
  if (!activePeer || activePeer.type === 'group') return;
  try {
    var res = await fetch('/api/users/' + activePeer.id);
    if (res.ok) {
      var info = await res.json();
      activePeer.isOnline = info.isOnline;
      activePeer.name = info.name;
      var avatarChanged = activePeer.avatar !== info.avatar;
      activePeer.avatar = info.avatar;
      var statusEl = document.getElementById('active-peer-status');
      if (info.isOnline) { statusEl.innerText = 'в сети'; statusEl.style.color = '#4cd964'; }
      else { statusEl.innerText = 'не в сети'; statusEl.style.color = 'var(--text-muted)'; }
      renderAvatarIntoElement(document.getElementById('peer-avatar-circle'), activePeer, info.isOnline);
      if (avatarChanged) { lastDialogsHash = ''; loadDialogsQuiet(); }
    }
  } catch (e) {}
}

/* ==================== RETRY ==================== */
async function retryPendingMessages() {
  if (!currentUser) return;
  if (isRetrying) return;
  var pending = localMessagesCache.filter(function (m) { return m.isPending && m.senderId === currentUser.id && m.clientId; });
  if (pending.length === 0) return;
  isRetrying = true;
  var anySuccess = false;
  for (var i = 0; i < pending.length; i++) {
    var pm = pending[i];
    try {
      var res = await fetch('/api/messages/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderId: pm.senderId, receiverId: pm.receiverId || '', groupId: pm.groupId || '',
          text: pm.text || '', fileData: pm.fileData || '',
          fileName: pm.fileName || '', fileType: pm.fileType || '',
          clientId: pm.clientId, fileUrl: pm.fileUrl || '', fileSize: pm.fileSize || 0
        })
      });
      if (res.ok) {
        var data = await res.json();
        if (data && data.message) {
          var rm = Object.assign({}, data.message);
          rm.isPending = false;
          if (pm.fileUrl) rm.fileUrl = pm.fileUrl;
          if (pm.fileSize) rm.fileSize = pm.fileSize;
          for (var j = 0; j < localMessagesCache.length; j++) {
            if (localMessagesCache[j].clientId === pm.clientId) { localMessagesCache[j] = rm; break; }
          }
          anySuccess = true;
        }
      }
    } catch (e) { break; }
  }
  if (anySuccess) {
    saveCache();
    if (activePeer) renderMessagesContainer(getChatMessages(activePeer));
    loadDialogsQuiet();
  }
  isRetrying = false;
}

/* ==================== МОЙ ПРОФИЛЬ ==================== */
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
  var file = e.target.files[0]; if (!file) return;
  if (file.size > 10 * 1024 * 1024) { alert('Максимум 10 МБ'); return; }
  compressImage(file, 200, 0.85, function (compressed) {
    if (!compressed) return;
    draftAvatar = compressed;
    renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), { id: currentUser.id, avatar: draftAvatar, name: currentUser.name }, true);
    document.getElementById('remove-avatar-link-btn').style.display = 'block';
  });
}
function removeMyAvatar() {
  draftAvatar = '';
  renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), { id: currentUser.id, avatar: '', name: currentUser.name }, true);
  document.getElementById('remove-avatar-link-btn').style.display = 'none';
}
async function saveMyProfileChanges() {
  if (!lockButton('save-my-profile-btn', 3000)) return;
  var newName = document.getElementById('edit-my-name-input').value.trim();
  if (newName) currentUser.name = newName;
  if (draftAvatar !== null) { currentUser.avatar = draftAvatar; draftAvatar = null; }
  saveUser();
  updateMyProfileUI();
  try {
    var res = await fetch('/api/profile/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar })
    });
    var data = await res.json();
    if (data.success) {
      currentUser = data.user;
      saveUser();
      updateMyProfileUI();
      lastDialogsHash = '';
      await loadDialogs();
    }
  } catch (e) {}
  closeMyProfile();
}

/* ==================== ПРОФИЛЬ СОБЕСЕДНИКА ==================== */
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
  var blockBtn = document.getElementById('block-peer-btn');
  var isBlocked = currentUser.blockedContacts && currentUser.blockedContacts.indexOf(user.id) !== -1;
  blockBtn.innerText = isBlocked ? 'Разблокировать' : 'Заблокировать';
  blockBtn.className = isBlocked ? 'btn btn-secondary' : 'btn btn-danger';
  var muteBtn = document.getElementById('mute-peer-btn');
  var isMuted = mutedPeers.indexOf(user.id) !== -1;
  muteBtn.innerText = isMuted ? 'Включить звук' : 'Выключить звук';
  muteBtn.className = isMuted ? 'btn' : 'btn btn-secondary';
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
  var index = mutedPeers.indexOf(profileTargetId);
  if (index > -1) mutedPeers.splice(index, 1); else mutedPeers.push(profileTargetId);
  localStorage.setItem('messenger_muted_peers', JSON.stringify(mutedPeers));
  updatePeerProfileButtons({ id: profileTargetId });
}
async function toggleBlockPeer() {
  if (!profileTargetId) return;
  if (!lockButton('block-peer-btn', 2000)) return;
  var isBlocked = currentUser.blockedContacts && currentUser.blockedContacts.indexOf(profileTargetId) !== -1;
  var nextBlock = !isBlocked;
  try {
    var res = await fetch('/api/users/block', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, peerId: profileTargetId, block: nextBlock })
    });
    var data = await res.json();
    if (data.success) {
      currentUser.blockedContacts = data.blockedContacts;
      saveUser();
      closePeerProfile();
    }
  } catch (e) {}
}

/* ==================== МЕНЮ ЧАТА ==================== */
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
  if (!activePeer || !confirm('Очистить историю?')) return;
  var isGroup = activePeer.type === 'group';
  try {
    await fetch('/api/chat/clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isGroup ? { userId: currentUser.id, groupId: activePeer.id } : { userId: currentUser.id, peerId: activePeer.id })
    });
    var ids = [];
    getChatMessages(activePeer).forEach(function (m) { m.isDeleted = true; ids.push(m.id); });
    for (var i = 0; i < ids.length; i++) await deleteFileFromIDB(ids[i]);
    saveCache(); lastMessagesHash = ''; loadMessages();
  } catch (e) {}
}
async function deleteCurrentChat() {
  closeChatDropdown();
  if (!activePeer || !confirm('Удалить чат?')) return;
  try {
    await fetch('/api/chat/hide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, peerId: activePeer.id })
    });
    resetActiveChat(); lastDialogsHash = ''; loadDialogs();
  } catch (e) {}
}
function resetActiveChat() {
  cancelVoiceAttachment(); cancelAttachment(); closeMobileChat(); activePeer = null;
  document.getElementById('input-bar').style.display = 'none';
  document.getElementById('active-peer-name').innerText = 'Выберите чат';
  document.getElementById('active-peer-status').innerText = 'нажмите для профиля';
  document.getElementById('messages-container').innerHTML = '<div class="empty-state">Выберите диалог</div>';
}

/* ==================== ДИАЛОГИ ==================== */
async function loadDialogs() {
  if (document.getElementById('search-input').value.trim()) return;
  if (!currentUser) return;
  try {
    var res = await fetch('/api/dialogs/' + currentUser.id);
    var dialogs = await res.json();
    dialogs.forEach(function (d) { cacheUser(d); });
    lastDialogsHash = JSON.stringify(dialogs);
    renderChatList(dialogs);
  } catch (e) {}
}
async function loadDialogsQuiet() {
  if (document.getElementById('search-input').value.trim()) return;
  if (!currentUser) return;
  try {
    var res = await fetch('/api/dialogs/' + currentUser.id);
    var dialogs = await res.json();
    dialogs.forEach(function (d) { cacheUser(d); });
    var currentHash = JSON.stringify(dialogs.map(function (d) {
      return { id: d.id, name: d.name, avatarSig: d.avatar ? quickHash(d.avatar) : '', isOnline: d.isOnline, lastTs: d.lastTs, memberCount: d.memberCount };
    }));
    if (currentHash !== lastDialogsHash) { lastDialogsHash = currentHash; renderChatList(dialogs); }
  } catch (e) {}
}
async function onSearchInput() {
  var q = document.getElementById('search-input').value.trim();
  var clearBtn = document.getElementById('clear-search-btn');
  if (!q) { clearBtn.style.display = 'none'; lastDialogsHash = ''; loadDialogs(); return; }
  clearBtn.style.display = 'block';
  var ql = q.toLowerCase();
  var localFound = [];
  for (var k in localKnownUsers) if (localKnownUsers.hasOwnProperty(k)) {
    var u = localKnownUsers[k];
    if (u.id === currentUser.id) continue;
    if ((u.id && u.id.toLowerCase().indexOf(ql) !== -1) || (u.name && u.name.toLowerCase().indexOf(ql) !== -1)) {
      localFound.push({ id: u.id, type: 'user', name: u.name, avatar: u.avatar || '', isOnline: false });
    }
  }
  renderChatList(localFound);
  try {
    var res = await fetch('/api/users/search?q=' + encodeURIComponent(q));
    var users = await res.json();
    users.forEach(function (u) { if (u.id !== currentUser.id) cacheUser(u); });
    renderChatList(users.filter(function (u) { return u.id !== currentUser.id; }));
  } catch (e) {}
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

/* ==================== ОТКРЫТИЕ ЧАТА ==================== */
function openChat(peer) {
  cancelVoiceAttachment();
  if (!peer.type) peer.type = 'user';
  activePeer = peer;
  lastMessagesHash = '';
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
      saveUser();
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
  loadMessages();
  if (peer.type === 'group') refreshGroupInfo();
}
function closeMobileChat() { document.getElementById('app-screen').classList.remove('app-mobile-chat'); }
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

/* ==================== РЕНДЕР СООБЩЕНИЙ ==================== */
async function renderMessagesContainer(messages) {
  var container = document.getElementById('messages-container');
  var isScrolledToBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 80;
  container.innerHTML = '';
  if (!messages || messages.length === 0) {
    container.innerHTML = '<div class="empty-state">Нет сообщений</div>';
    return;
  }
  var isGroup = activePeer && activePeer.type === 'group';
  var mediaTasks = [];
  
  for (var idx = 0; idx < messages.length; idx++) {
    var m = messages[idx];
    var div = document.createElement('div');
    div.className = 'msg ' + (m.senderId === currentUser.id ? 'my' : '') + (m.isPending ? ' pending' : '');
    div.setAttribute('data-msg-id', m.id);
    div.setAttribute('data-sender-id', m.senderId);
    div.oncontextmenu = (function(msg, el){ return function(e){
      if (e.target.tagName === 'AUDIO' || e.target.tagName === 'VIDEO' || (e.target.closest && (e.target.closest('audio') || e.target.closest('video')))) return;
      e.preventDefault(); openMsgActions(msg, el);
    }; })(m, div);
    div.ontouchstart = (function(msg, el){ return function(e){
      if (e.target.tagName === 'AUDIO' || e.target.tagName === 'VIDEO' || (e.target.closest && (e.target.closest('audio') || e.target.closest('video')))) return;
      longTouchTimer = setTimeout(function () { openMsgActions(msg, el); }, 500);
    }; })(m, div);
    div.ontouchend = function () { clearTimeout(longTouchTimer); };
    div.ontouchmove = function () { clearTimeout(longTouchTimer); };
    
    var html = '';
    if (isGroup && m.senderId !== currentUser.id) {
      html += '<div class="msg-sender">' + escapeHtml(getUserName(m.senderId)) + '</div>';
    }
    if (m.text) html += '<div>' + escapeHtml(m.text) + '</div>';
    var ft = m.fileType || '';
    
    // Есть файл? — вставляем placeholder с data-msg-id, потом подгружаем
    if (m.fileData || m.fileUrl) {
      var mid = m.id;
      if (ft.indexOf('image/') === 0) {
        html += '<div class="media-loading" data-media-msg-id="' + mid + '">📷 Загрузка...</div>';
      } else if (ft.indexOf('video/') === 0) {
        html += '<div class="media-loading" data-media-msg-id="' + mid + '">🎬 Загрузка видео...</div>';
      } else if (ft.indexOf('audio/') === 0) {
        html += '<div class="media-loading" data-media-msg-id="' + mid + '">🎤 Загрузка...</div>';
      } else {
        html += '<div class="media-loading" data-media-msg-id="' + mid + '">📁 ' + escapeHtml(m.fileName || 'Файл') + ' — загрузка...</div>';
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
    container.appendChild(div);
    
    // Ставим в очередь загрузку медиа
    var placeholder = div.querySelector('[data-media-msg-id]');
    if (placeholder) {
      mediaTasks.push({ msg: m, placeholder: placeholder });
    }
  }
  
  if (isScrolledToBottom) container.scrollTop = container.scrollHeight;
  
  // Асинхронно загружаем каждое медиа
  mediaTasks.forEach(function (task) {
    loadMediaIntoPlaceholder(task.msg, task.placeholder).catch(function () {});
  });
}

async function loadMediaIntoPlaceholder(msg, placeholder) {
  if (!placeholder || !placeholder.parentNode) return;
  
  var url = await getFileUrl(msg);
  if (!placeholder.parentNode) return;
  
  var ft = msg.fileType || '';
  var wrapper = document.createElement('div');
  wrapper.innerHTML = renderMediaHtml(msg, url, ft);
  var newEl = wrapper.firstChild;
  
  if (!newEl) {
    placeholder.outerHTML = '<div class="file-placeholder">⚠️ Файл недоступен</div>';
    return;
  }
  
  // Навешиваем обработчики
  if (newEl.tagName === 'IMG') {
    newEl.addEventListener('click', function (e) { e.stopPropagation(); openImageViewer(newEl.src); });
    newEl.addEventListener('error', function () {
      if (placeholder.parentNode) {
        var ph = document.createElement('div');
        ph.className = 'file-placeholder';
        ph.textContent = '⚠️ Изображение недоступно';
        newEl.parentNode.replaceChild(ph, newEl);
      }
    });
  } else if (newEl.tagName === 'VIDEO') {
    newEl.addEventListener('error', function () {
      if (placeholder.parentNode) {
        var ph = document.createElement('div');
        ph.className = 'file-placeholder';
        ph.textContent = '⚠️ Видео недоступно';
        newEl.parentNode.replaceChild(ph, newEl);
      }
    });
  }
  
  placeholder.parentNode.replaceChild(newEl, placeholder);
}

function renderMediaHtml(msg, url, ft) {
  if (!url) return '<div class="file-placeholder">⚠️ Файл недоступен</div>';
  if (ft.indexOf('image/') === 0) {
    return '<img src="' + url + '" class="media-preview" alt="">';
  } else if (ft.indexOf('video/') === 0) {
    return '<video src="' + url + '" controls class="video-preview" preload="metadata" playsinline webkit-playsinline></video>';
  } else if (ft.indexOf('audio/') === 0) {
    return '<audio src="' + url + '" controls class="audio-preview" preload="metadata"></audio>';
  } else {
    return '<a class="file-link" href="' + url + '" download="' + escapeHtml(msg.fileName || 'file') + '" target="_blank">📁 ' + escapeHtml(msg.fileName || 'Файл') + (msg.fileSize ? ' (' + formatBytes(msg.fileSize) + ')' : '') + '</a>';
  }
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
    if (senderId === currentUser.id || msgId.indexOf('cid_') === 0) return;
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
  if (document.getElementById('msg-actions-sheet').classList.contains('active')) return;
  selectedMsgId = msg.id; selectedMsgObj = msg;
  document.querySelectorAll('.msg').forEach(function (el) { el.classList.remove('selected-msg'); });
  element.classList.add('selected-msg');
  document.getElementById('action-btn-copy').style.display = (msg.text && !msg.fileData && !msg.fileUrl) ? 'block' : 'none';
  document.getElementById('action-btn-download').style.display = (msg.fileData || msg.fileUrl) ? 'block' : 'none';
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
async function actionDownloadFile() {
  var obj = selectedMsgObj;
  closeMsgActions();
  if (!obj) return;
  var url = await getFileUrl(obj);
  if (!url) { alert('Файл недоступен'); return; }
  var a = document.createElement('a');
  a.href = url; a.download = obj.fileName || 'file';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
async function deleteSelectedMessage() {
  var id = selectedMsgId;
  closeMsgActions();
  if (!id) return;
  localMessagesCache.forEach(function (m) { if (m.id === id) m.isDeleted = true; });
  saveCache();
  lastMessagesHash = '';
  await deleteFileFromIDB(id);
  if (fileUrlCache.has(id)) { try { URL.revokeObjectURL(fileUrlCache.get(id)); } catch (e) {} fileUrlCache.delete(id); }
  if (activePeer) renderMessagesContainer(getChatMessages(activePeer));
  try { await fetch('/api/messages/' + id, { method: 'DELETE' }); }
  catch (e) {}
}

/* ==================== ВЛОЖЕНИЯ ==================== */
function triggerFileInput() { document.getElementById('file-input').click(); }
function handleFileSelect(e) {
  var file = e.target.files[0]; if (!file) return;
  if (file.size > MAX_FILE_SIZE) { alert('Максимум 200 МБ'); e.target.value = ''; return; }
  selectedFile = { file: file, name: file.name, type: file.type, data: null, isLarge: file.size > 1024 * 1024, blob: file };
  var thumbImg = document.getElementById('attachment-thumb-img');
  document.getElementById('attachment-name-label').innerText = file.name;
  document.getElementById('attachment-type-label').innerText = formatBytes(file.size) + (selectedFile.isLarge ? ' • будет загружено' : '');
  if (file.type.indexOf('image/') === 0) {
    var r = new FileReader();
    r.onload = function (ev) { thumbImg.src = ev.target.result; thumbImg.style.display = 'block'; };
    r.readAsDataURL(file);
  } else { thumbImg.src = ''; thumbImg.style.display = 'none'; }
  document.getElementById('attachment-preview-container').classList.add('active');
}
function cancelAttachment() {
  selectedFile = null;
  document.getElementById('file-input').value = '';
  document.getElementById('attachment-preview-container').classList.remove('active');
}

/* ==================== ГОЛОС ==================== */
function cancelVoiceAttachment() {
  if (pendingVoice && pendingVoice.url && pendingVoice.url.indexOf('blob:') === 0) {
    try { URL.revokeObjectURL(pendingVoice.url); } catch (e) {}
  }
  pendingVoice = null;
  var box = document.getElementById('audio-attachment-preview');
  if (box) box.classList.remove('active');
  var player = document.getElementById('audio-preview-player');
  if (player) { player.pause(); player.removeAttribute('src'); try { player.load(); } catch (e) {} }
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
  var micBtn = document.getElementById('mic-btn');
  if (isRecording) {
    isRecording = false; micBtn.innerText = '🎙️'; micBtn.classList.remove('recording'); stopRecordingTimer();
    var chunks = audioChunks.slice();
    var capturedRate = recordAudioCtx ? recordAudioCtx.sampleRate : 48000;
    cleanupRecordingNodes();
    try { if (activeStream) activeStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    activeStream = null;
    if (chunks.length === 0) { alert('Пустая запись'); return; }
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
      pendingVoice = { data: dataUrl, name: 'voice_' + Date.now() + '.wav', type: 'audio/wav', url: url, blob: wavBlob };
      var player = document.getElementById('audio-preview-player');
      player.src = url;
      document.getElementById('audio-attachment-preview').classList.add('active');
    };
    reader.readAsDataURL(wavBlob);
    return;
  }
  if (!activePeer) { alert('Выберите чат'); return; }
  if (!navigator.mediaDevices) { alert('Нет доступа'); return; }
  try {
    var stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
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
    alert('Нет доступа к микрофону');
    cleanupRecordingNodes();
    try { if (activeStream) activeStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    activeStream = null; isRecording = false; micBtn.innerText = '🎙️'; micBtn.classList.remove('recording'); stopRecordingTimer();
  }
}

/* ==================== ОТПРАВКА ==================== */
async function sendMsg() {
  if (!activePeer) return;
  if (!lockButton('send-btn', 1000)) return;
  var input = document.getElementById('msg-input');
  var text = input.value.trim();
  var fileToSend = selectedFile;
  var voiceToSend = pendingVoice;
  if (!text && !fileToSend && !voiceToSend) return;
  input.value = '';
  
  var isGroup = activePeer.type === 'group';
  var clientId = 'cid_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
  
  // Оптимистичное сообщение
  var optMsg = {
    id: clientId, clientId: clientId,
    senderId: currentUser.id,
    receiverId: isGroup ? '' : activePeer.id,
    groupId: isGroup ? activePeer.id : '',
    text: text,
    fileName: fileToSend ? fileToSend.name : (voiceToSend ? voiceToSend.name : ''),
    fileType: fileToSend ? fileToSend.type : (voiceToSend ? voiceToSend.type : ''),
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    ts: Date.now(), isRead: false, readBy: [], isDeleted: false, isPending: true
  };
  
  // Голосовое — сохраняем blob в IDB
  if (voiceToSend) {
    optMsg.fileData = voiceToSend.data;
    optMsg.fileSize = voiceToSend.blob ? voiceToSend.blob.size : 0;
    try { await saveFileToIDB(clientId, voiceToSend.blob, { fileName: voiceToSend.name, fileType: voiceToSend.type, fileSize: voiceToSend.blob.size }); } catch (e) {}
    cancelVoiceAttachment();
    mergeMessage(optMsg);
    renderMessagesContainer(getChatMessages(activePeer));
    await sendPayload({ clientId: clientId, text: '', fileData: voiceToSend.data, fileName: voiceToSend.name, fileType: voiceToSend.type });
    return;
  }
  
  // Малый файл (base64)
  if (fileToSend && !fileToSend.isLarge) {
    try {
      var dataUrl = await fileToDataUrl(fileToSend.file);
      optMsg.fileData = dataUrl;
      optMsg.fileSize = fileToSend.file.size;
      try {
        var blob = await blobFromDataUrl(dataUrl);
        if (blob) await saveFileToIDB(clientId, blob, { fileName: fileToSend.name, fileType: fileToSend.type, fileSize: blob.size });
      } catch (e) {}
      cancelAttachment();
      mergeMessage(optMsg);
      renderMessagesContainer(getChatMessages(activePeer));
      await sendPayload({ clientId: clientId, text: text, fileData: dataUrl, fileName: fileToSend.name, fileType: fileToSend.type });
    } catch (e) { alert('Ошибка чтения файла'); }
    return;
  }
  
  // Большой файл — сохраняем blob в IDB сразу, потом загружаем на сервер, но собеседник получит fileUrl
  if (fileToSend && fileToSend.isLarge) {
    optMsg.fileName = fileToSend.name;
    optMsg.fileType = fileToSend.type;
    optMsg.fileSize = fileToSend.file.size;
    optMsg.fileUrl = ''; // пока нет, появится после загрузки
    try { await saveFileToIDB(clientId, fileToSend.file, { fileName: fileToSend.name, fileType: fileToSend.type, fileSize: fileToSend.file.size }); } catch (e) {}
    cancelAttachment();
    mergeMessage(optMsg);
    renderMessagesContainer(getChatMessages(activePeer));
    
    // Загружаем в фоне, не блокируя UI
    uploadLargeFileInBackground(clientId, fileToSend.file, fileToSend.name, fileToSend.type, text);
    return;
  }
  
  // Просто текст
  mergeMessage(optMsg);
  renderMessagesContainer(getChatMessages(activePeer));
  await sendPayload({ clientId: clientId, text: text });
}

function fileToDataUrl(file) {
  return new Promise(function (resolve, reject) {
    var r = new FileReader();
    r.onload = function () { resolve(r.result); };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function sendPayload(payload) {
  var isGroup = activePeer.type === 'group';
  try {
    var res = await fetch('/api/messages/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        senderId: currentUser.id,
        receiverId: isGroup ? '' : activePeer.id,
        groupId: isGroup ? activePeer.id : '',
        text: payload.text || '',
        fileData: payload.fileData || '',
        fileName: payload.fileName || '',
        fileType: payload.fileType || '',
        fileUrl: payload.fileUrl || '',
        fileSize: payload.fileSize || 0,
        clientId: payload.clientId
      })
    });
    if (res.status === 403) {
      localMessagesCache = localMessagesCache.filter(function (m) { return m.clientId !== payload.clientId; });
      saveCache();
      renderMessagesContainer(getChatMessages(activePeer));
      alert('Чат заблокирован');
      return;
    }
    if (!res.ok) throw new Error('Server error');
    var data = await res.json();
    if (data && data.message) {
      var rm = Object.assign({}, data.message); rm.isPending = false;
      if (payload.fileUrl) rm.fileUrl = payload.fileUrl;
      if (payload.fileSize) rm.fileSize = payload.fileSize;
      // Перенос файла из IDB по clientId в IDB по реальному id
      try {
        var entry = await getFileFromIDB(payload.clientId);
        if (entry && entry.blob) {
          await saveFileToIDB(rm.id, entry.blob, { fileName: rm.fileName, fileType: rm.fileType, fileSize: entry.blob.size });
          await deleteFileFromIDB(payload.clientId);
          if (fileUrlCache.has(payload.clientId)) {
            fileUrlCache.set(rm.id, fileUrlCache.get(payload.clientId));
            fileUrlCache.delete(payload.clientId);
          }
        }
      } catch (e) {}
      mergeMessage(rm);
      saveCache();
      renderMessagesContainer(getChatMessages(activePeer));
      loadDialogsQuiet();
      if (connectionState !== 'online' && navigator.onLine) setConnectionState('online');
    }
  } catch (e) {
    // Оставляем isPending — retry догонит
    if (!navigator.onLine) setConnectionState('no-internet');
    else setConnectionState('server-offline');
  }
}

async function uploadLargeFileInBackground(clientId, file, fileName, fileType, text) {
  try {
    var initRes = await fetch('/api/upload/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderId: currentUser.id, fileName: fileName, fileSize: file.size, fileType: fileType })
    });
    if (!initRes.ok) throw new Error('init failed');
    var initData = await initRes.json();
    var fileId = initData.fileId;
    var totalChunks = initData.totalChunks;
    for (var i = 0; i < totalChunks; i++) {
      var start = i * CHUNK_SIZE;
      var end = Math.min(start + CHUNK_SIZE, file.size);
      var chunk = file.slice(start, end);
      var res = await fetch('/api/upload/chunk?fileId=' + encodeURIComponent(fileId) + '&chunkIndex=' + i, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk
      });
      if (!res.ok) throw new Error('chunk ' + i);
    }
    var finRes = await fetch('/api/upload/finish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: fileId })
    });
    if (!finRes.ok) throw new Error('finish');
    var fdata = await finRes.json();
    
    // Обновляем сообщение — добавляем fileUrl, убираем isPending
    for (var j = 0; j < localMessagesCache.length; j++) {
      if (localMessagesCache[j].clientId === clientId) {
        localMessagesCache[j].fileUrl = fdata.url;
        break;
      }
    }
    saveCache();
    // Отправляем на сервер
    await sendPayload({
      clientId: clientId,
      text: text || '',
      fileName: fileName,
      fileType: fileType,
      fileUrl: fdata.url,
      fileSize: file.size
    });
  } catch (e) {
    // Оставляем isPending — retry догонит, но без fileUrl. Удалим если не смогли
    console.warn('Large file upload failed:', e);
    // Оставляем isPending — пользователь может отправить снова
  }
}

/* ==================== ГРУППЫ ==================== */
async function getContactUsers() {
  var arr = [];
  for (var k in localKnownUsers) if (localKnownUsers.hasOwnProperty(k)) {
    var u = localKnownUsers[k];
    if (u.id && u.id !== currentUser.id) arr.push({ id: u.id, type: 'user', name: u.name, avatar: u.avatar || '' });
  }
  try {
    var res = await fetch('/api/dialogs/' + currentUser.id);
    var list = await res.json();
    var serverUsers = list.filter(function (d) { return d.type !== 'group' && d.id !== currentUser.id; });
    serverUsers.forEach(function (u) { cacheUser(u); });
    return serverUsers;
  } catch (e) { return arr; }
}
function renderCheckList(containerId, users, excludeSet) {
  var c = document.getElementById(containerId); c.innerHTML = '';
  var list = users.filter(function (u) { return !excludeSet.has(u.id); });
  if (list.length === 0) { c.innerHTML = '<div style="color:var(--text-muted); font-size:13px; padding:8px;">Нет контактов</div>'; return; }
  list.forEach(function (u) {
    var row = document.createElement('label');
    row.className = 'check-row';
    row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:8px; cursor:pointer; border-bottom:1px solid var(--border);';
    var avatarId = 'chk_av_' + u.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    row.innerHTML =
      '<input type="checkbox" value="' + u.id + '" style="width:18px;height:18px;flex-shrink:0;">' +
      '<div class="avatar-circle" id="' + avatarId + '" style="width:32px;height:32px;font-size:13px;"></div>' +
      '<span style="flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;">' + escapeHtml(u.name) + '</span>';
    c.appendChild(row);
    renderAvatarIntoElement(document.getElementById(avatarId), u, false);
  });
}
function getChecked(containerId) {
  return Array.from(document.querySelectorAll('#' + containerId + ' input[type=checkbox]:checked')).map(function (i) { return i.value; });
}
async function openCreateGroup() {
  if (isModalOpen('create-group-modal')) return;
  groupDraftAvatar = '';
  document.getElementById('create-group-name').value = '';
  fillAvatarBox(document.getElementById('create-group-avatar'), '', '👥');
  var cached = [];
  for (var k in localKnownUsers) if (localKnownUsers.hasOwnProperty(k)) {
    var u = localKnownUsers[k];
    if (u.id && u.id !== currentUser.id) cached.push({ id: u.id, type: 'user', name: u.name, avatar: u.avatar || '' });
  }
  renderCheckList('create-group-contacts', cached, new Set());
  safeOpenModal('create-group-modal');
  getContactUsers().then(function (contacts) {
    if (contacts.length !== cached.length) renderCheckList('create-group-contacts', contacts, new Set());
  }).catch(function () {});
}
function closeCreateGroup() { safeCloseModal('create-group-modal'); }
function triggerGroupAvatarInput() { var i = document.getElementById('group-avatar-input'); i.value = ''; i.click(); }
function handleGroupAvatarSelect(e) {
  var file = e.target.files[0]; if (!file) return;
  if (file.size > 10 * 1024 * 1024) { alert('Максимум 10 МБ'); return; }
  compressImage(file, 200, 0.85, function (compressed) {
    if (!compressed) return;
    groupDraftAvatar = compressed;
    fillAvatarBox(document.getElementById('create-group-avatar'), groupDraftAvatar, '👥');
  });
}
async function submitCreateGroup() {
  var name = document.getElementById('create-group-name').value.trim();
  if (!name) { alert('Введите название'); return; }
  var members = getChecked('create-group-contacts');
  if (members.length === 0) { alert('Выберите участников'); return; }
  if (!lockButton('create-group-submit-btn', 5000)) return;
  try {
    var res = await fetch('/api/groups/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, name: name, members: members, avatar: groupDraftAvatar })
    });
    var data = await res.json();
    if (data.success) {
      closeCreateGroup();
      lastDialogsHash = '';
      await loadDialogs();
      var g = data.group;
      openChat({ id: g.id, type: 'group', name: g.name, avatar: g.avatar, members: g.members, ownerId: g.ownerId, memberCount: g.members.length });
    } else alert(data.error || 'Ошибка');
  } catch (e) { alert('Не удалось создать'); }
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
    renderAvatarIntoElement(document.getElementById('peer-avatar-circle'), { id: g.id, name: g.name, avatar: g.avatar }, false);
  } catch (e) {}
}
async function openGroupProfile() {
  closeChatDropdown();
  if (!activePeer || activePeer.type !== 'group') return;
  if (isModalOpen('group-profile-modal')) return;
  await refreshGroupInfo();
  var g = activePeer;
  editGroupDraftAvatar = '';
  fillAvatarBox(document.getElementById('group-profile-avatar'), g.avatar, '👥');
  document.getElementById('group-profile-name').innerText = g.name;
  document.getElementById('group-profile-count').innerText = (g.members ? g.members.length : 0) + ' участников';
  var isOwner = g.ownerId === currentUser.id;
  document.getElementById('group-owner-controls').style.display = isOwner ? 'block' : 'none';
  document.getElementById('delete-group-btn').style.display = isOwner ? 'block' : 'none';
  if (isOwner) document.getElementById('edit-group-name').value = g.name;
  renderMembersList('group-members-list', g.memberDetails || [], g.ownerId);
  safeOpenModal('group-profile-modal');
}
function closeGroupProfile() { editGroupDraftAvatar = ''; safeCloseModal('group-profile-modal'); closeMemberDropdown(); }
function renderMembersList(containerId, memberDetails, ownerId) {
  var c = document.getElementById(containerId); c.innerHTML = '';
  var amIOwner = ownerId === currentUser.id;
  memberDetails.forEach(function (u) {
    var row = document.createElement('div'); row.className = 'member-row';
    var isOwner = u.id === ownerId;
    var isMe = u.id === currentUser.id;
    var info = document.createElement('div');
    info.style.cssText = 'display:flex; align-items:center; gap:10px; flex:1; overflow:hidden;';
    info.innerHTML =
      '<div class="avatar-circle" style="width:32px;height:32px;font-size:13px;"></div>' +
      '<div style="flex:1; text-align:left; overflow:hidden;">' +
        '<div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + escapeHtml(u.name) + (isMe ? ' (вы)' : '') + '</div>' +
        (isOwner ? '<div style="font-size:11px; color:var(--accent);">создатель</div>' : '') +
      '</div>';
    info.onclick = function (e) {
      e.stopPropagation();
      if (isMe) { closeGroupProfile(); openMyProfile(); }
      else openMemberProfile(u);
    };
    row.appendChild(info);
    renderAvatarIntoElement(info.querySelector('.avatar-circle'), u, u.isOnline);
    if (amIOwner && !isMe && !isOwner) {
      var dotsBtn = document.createElement('button');
      dotsBtn.className = 'member-menu-btn';
      dotsBtn.innerText = '⋮';
      dotsBtn.onclick = function (e) {
        e.stopPropagation();
        if (activeMemberDropdown && activeMemberDropdown.dataset.memberId === u.id) closeMemberDropdown();
        else openMemberDropdown(row, u);
      };
      row.appendChild(dotsBtn);
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
    '<button class="menu-item" data-action="profile">Открыть профиль</button>' +
    '<button class="menu-item danger" data-action="kick">Выгнать</button>';
  dd.addEventListener('click', function (e) {
    e.stopPropagation();
    var action = e.target.getAttribute('data-action');
    if (action === 'profile') { closeMemberDropdown(); openMemberProfile(member); }
    else if (action === 'kick') { closeMemberDropdown(); kickMember(member); }
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
  try {
    var res = await fetch('/api/groups/kick', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: activePeer.id, userId: currentUser.id, memberId: member.id })
    });
    var data = await res.json();
    if (data.success) {
      await refreshGroupInfo();
      renderMembersList('group-members-list', activePeer.memberDetails || [], activePeer.ownerId);
      document.getElementById('group-profile-count').innerText = (activePeer.members ? activePeer.members.length : 0) + ' участников';
      lastDialogsHash = '';
      loadDialogsQuiet();
    } else alert(data.error || 'Ошибка');
  } catch (e) { alert('Ошибка'); }
}
async function deleteGroup() {
  if (!activePeer || activePeer.type !== 'group') return;
  if (!confirm('Удалить группу?')) return;
  if (!lockButton('delete-group-btn', 3000)) return;
  try {
    var res = await fetch('/api/groups/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: activePeer.id, userId: currentUser.id })
    });
    var data = await res.json();
    if (data.success) {
      closeGroupProfile();
      resetActiveChat();
      lastDialogsHash = '';
      loadDialogs();
    } else alert(data.error || 'Ошибка');
  } catch (e) { alert('Ошибка'); }
}
function triggerEditGroupAvatarInput() { var i = document.getElementById('edit-group-avatar-input'); i.value = ''; i.click(); }
function handleEditGroupAvatarSelect(e) {
  var file = e.target.files[0]; if (!file) return;
  if (file.size > 10 * 1024 * 1024) { alert('Максимум 10 МБ'); return; }
  compressImage(file, 200, 0.85, function (compressed) {
    if (!compressed) return;
    editGroupDraftAvatar = compressed;
    fillAvatarBox(document.getElementById('group-profile-avatar'), editGroupDraftAvatar, '👥');
  });
}
async function saveGroupChanges() {
  if (!activePeer || activePeer.type !== 'group') return;
  if (!lockButton('save-group-btn', 3000)) return;
  var name = document.getElementById('edit-group-name').value.trim();
  if (!name) { alert('Введите название'); return; }
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
      lastDialogsHash = '';
      await loadDialogsQuiet();
      openGroupProfile();
    } else alert(data.error || 'Ошибка');
  } catch (e) { alert('Ошибка'); }
}
async function openAddMembers() {
  if (!activePeer || activePeer.type !== 'group') return;
  if (isModalOpen('add-members-modal')) return;
  var exclude = new Set(activePeer.members || []);
  var cached = [];
  for (var k in localKnownUsers) if (localKnownUsers.hasOwnProperty(k)) {
    var u = localKnownUsers[k];
    if (u.id && u.id !== currentUser.id && !exclude.has(u.id)) cached.push({ id: u.id, type: 'user', name: u.name, avatar: u.avatar || '' });
  }
  renderCheckList('add-members-contacts', cached, exclude);
  safeOpenModal('add-members-modal');
  getContactUsers().then(function (contacts) {
    renderCheckList('add-members-contacts', contacts, exclude);
  }).catch(function () {});
}
function closeAddMembers() { safeCloseModal('add-members-modal'); }
async function submitAddMembers() {
  var members = getChecked('add-members-contacts');
  if (members.length === 0) { alert('Выберите участников'); return; }
  if (!lockButton('add-members-submit-btn', 3000)) return;
  try {
    var res = await fetch('/api/groups/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: activePeer.id, userId: currentUser.id, members: members })
    });
    var data = await res.json();
    if (data.success) {
      closeAddMembers();
      await refreshGroupInfo();
      renderMembersList('group-members-list', activePeer.memberDetails || [], activePeer.ownerId);
      document.getElementById('group-profile-count').innerText = (activePeer.members ? activePeer.members.length : 0) + ' участников';
      lastDialogsHash = '';
      loadDialogsQuiet();
    } else alert(data.error || 'Ошибка');
  } catch (e) { alert('Ошибка'); }
}
async function leaveGroup() {
  closeChatDropdown();
  if (!activePeer || activePeer.type !== 'group') return;
  if (!confirm('Покинуть группу?')) return;
  try {
    await fetch('/api/groups/leave', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: activePeer.id, userId: currentUser.id })
    });
    closeGroupProfile();
    resetActiveChat();
    lastDialogsHash = '';
    loadDialogs();
  } catch (e) {}
}

/* ==================== ИНИЦИАЛИЗАЦИЯ ==================== */
window.addEventListener('DOMContentLoaded', async function () {
  updateThemeIcon(savedTheme);
  document.querySelectorAll('.modal-overlay').forEach(function (ov) {
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.classList.remove('active'); });
  });
  runClientMigrations();
  loadLocalData();
  updateVersionInfo();
  await checkServerHealth();
  if (!currentUser) {
    setInterval(async function () {
      await checkServerHealth();
      updateLoadingScreen();
    }, 3000);
  }
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

app.use(function (err, req, res, next) {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Too big' });
  if (err && (err instanceof SyntaxError || err.type === 'entity.parse.failed')) return res.status(400).json({ error: 'Bad JSON' });
  console.error('[EXPRESS]', err && err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Server error' });
});

const httpServer = app.listen(PORT, '0.0.0.0', function () {
  console.log('[STARTED v' + SERVER_VERSION + '] port ' + PORT);
});
httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 66000;
httpServer.requestTimeout = 0;
httpServer.timeout = 0;
