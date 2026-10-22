/* ============================================================
   server.js — v5.1.0 (Фиксация ID пользователя и устойчивая доставка)
   - Постоянный закрепившийся ID устройства/пользователя
   - Убраны жесткие ограничения на формат ID
   - Полная синхронизация онлайн-статусов и доставки (ACK)
   ============================================================ */
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_VERSION = '5.1.0';

app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

process.on('uncaughtException', function (err) { console.error('[СЕРВЕР EXCEPTION]:', err); });
process.on('unhandledRejection', function (r) { console.error('[ПРОМИС REJECTION]:', r); });

const MEM = { accounts: [], groups: [], inbox: new Map() };
const ONLINE_WINDOW_MS = 45000; 
const MAX_INBOX_PER_USER = 500;
const CALL_RING_TIMEOUT_MS = 60000;
const CALL_CLEANUP_DELAY_MS = 3000;

function timeStr() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function genId(prefix) { return prefix + Date.now() + '_' + Math.random().toString(36).substr(2, 6); }
function isOnline(u) { return !!(u && u.updatedAt && (Date.now() - u.updatedAt < ONLINE_WINDOW_MS)); }

// Очистка старых неактивных аккаунтов (> 48 часов)
setInterval(function() {
  const now = Date.now();
  MEM.accounts = MEM.accounts.filter(u => (now - (u.updatedAt || 0)) < 172800000);
}, 600000);

const callSignals = new Map();
const activeCalls = new Map();
function ensureQ(uid) { if (!callSignals.has(uid)) callSignals.set(uid, []); return callSignals.get(uid); }
function pushSig(t, f, c, ty, p) { ensureQ(t).push({ id: genId('sig_'), from: f, callId: c, type: ty, payload: p || null, ts: Date.now() }); }

setInterval(function() {
  const now = Date.now();
  activeCalls.forEach(function(call, callId) {
    if (call.status === 'ringing' && (now - call.startedAt) > CALL_RING_TIMEOUT_MS) {
      pushSig(call.toId, call.fromId, callId, 'ended', { by: 'timeout' });
      pushSig(call.fromId, call.toId, callId, 'ended', { by: 'timeout' });
      activeCalls.delete(callId);
    }
  });
}, 5000);

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
  try { MEM.inbox.delete(userId); } catch (e) {}
  MEM.accounts.forEach(function (u) {
    if (u.contacts) u.contacts = u.contacts.filter(function (id) { return id !== userId; });
    if (u.blockedContacts) u.blockedContacts = u.blockedContacts.filter(function (id) { return id !== userId; });
    if (u.hiddenDialogs) u.hiddenDialogs = u.hiddenDialogs.filter(function (id) { return id !== userId; });
  });
  MEM.groups.forEach(function (g) {
    if (g.members) g.members = g.members.filter(function (id) { return id !== userId; });
    if (g.ownerId === userId) g.ownerId = (g.members && g.members[0]) || null;
  });
  MEM.groups = MEM.groups.filter(function (g) { return g.members && g.members.length > 0; });
  res.json({ success: true });
});

/* ==================== PING И СИНХРОНИЗАЦИЯ ==================== */
app.post('/api/ping', function (req, res) {
  const { id, name, avatar, pubKey, contacts, knownUsers, userAgent } = req.body;
  if (!id) return res.status(400).json({ error: 'No id' });

  if (Array.isArray(knownUsers)) {
    knownUsers.forEach(function (ku) {
      if (!ku.id || ku.id === id) return;
      let ex = MEM.accounts.find(function (a) { return a.id === ku.id; });
      if (!ex) {
        MEM.accounts.push({
          id: ku.id, name: ku.name || 'Пользователь', avatar: ku.avatar || '', pubKey: ku.pubKey || '',
          userAgent: '', contacts: [], blockedContacts: [], hiddenDialogs: [], updatedAt: 0
        });
      } else {
        if (ku.name) ex.name = ku.name;
        if (ku.avatar !== undefined) ex.avatar = ku.avatar;
        if (ku.pubKey) ex.pubKey = ku.pubKey;
      }
    });
  }

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
    if (Array.isArray(contacts)) {
      if (!user.contacts) user.contacts = [];
      contacts.forEach(function (cid) { if (user.contacts.indexOf(cid) === -1) user.contacts.push(cid); });
    }
  }

  MEM.groups.forEach(function (g) {
    if (g.members.indexOf(id) !== -1) {
      g.members.forEach(function (m) {
        if (m !== id && user.contacts && user.contacts.indexOf(m) === -1) user.contacts.push(m);
      });
    }
  });

  const pending = MEM.inbox.get(id) || [];
  res.json({ success: true, user: user, pendingMessages: pending });
});

app.post('/api/messages/ack', function (req, res) {
  const { userId, messageIds } = req.body;
  if (!userId || !Array.isArray(messageIds)) return res.status(400).json({ error: 'Bad data' });
  let q = MEM.inbox.get(userId);
  if (q && q.length > 0) {
    MEM.inbox.set(userId, q.filter(m => !messageIds.includes(m.id)));
  }
  res.json({ success: true });
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

app.post('/api/users/block', function (req, res) {
  const { userId, peerId, block } = req.body;
  const user = MEM.accounts.find(function (u) { return u.id === userId; });
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (!user.blockedContacts) user.blockedContacts = [];
  if (block) { if (user.blockedContacts.indexOf(peerId) === -1) user.blockedContacts.push(peerId); }
  else { user.blockedContacts = user.blockedContacts.filter(function (x) { return x !== peerId; }); }
  res.json({ success: true, blockedContacts: user.blockedContacts });
});

app.post('/api/chat/hide', function (req, res) {
  const { userId, peerId } = req.body;
  const user = MEM.accounts.find(function (u) { return u.id === userId; });
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (!user.hiddenDialogs) user.hiddenDialogs = [];
  if (user.hiddenDialogs.indexOf(peerId) === -1) user.hiddenDialogs.push(peerId);
  res.json({ success: true, hiddenDialogs: user.hiddenDialogs });
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

/* ==================== ГРУППЫ ==================== */
app.post('/api/groups/create', function (req, res) {
  const { userId, name, members, avatar } = req.body;
  if (!userId) return res.status(400).json({ error: 'No user' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Введите название' });
  if (!Array.isArray(members) || members.length === 0) return res.status(400).json({ error: 'Выберите участников' });
  const memberSet = new Set([userId].concat(members.filter(function (m) { return m !== userId; })));
  const group = {
    id: genId('grp_'), name: name.trim(), avatar: avatar || '', ownerId: userId,
    members: Array.from(memberSet), createdAt: Date.now()
  };
  MEM.groups.push(group);
  res.json({ success: true, group: group });
});

function groupWithDetails(group) {
  const now = Date.now();
  const memberDetails = group.members.map(function (mId) {
    const u = MEM.accounts.find(function (a) { return a.id === mId; });
    return {
      id: mId, name: u ? u.name : 'Пользователь', avatar: u ? (u.avatar || '') : '',
      pubKey: u ? (u.pubKey || '') : '',
      userAgent: u ? (u.userAgent || '') : '',
      isOnline: !!(u && u.updatedAt && (now - u.updatedAt < ONLINE_WINDOW_MS))
    };
  });
  const copy = Object.assign({}, group);
  copy.memberDetails = memberDetails;
  return copy;
}

app.get('/api/groups/:groupId', function (req, res) {
  const g = MEM.groups.find(function (x) { return x.id === req.params.groupId; });
  if (!g) return res.status(404).json({ error: 'Не найдена' });
  res.json(groupWithDetails(g));
});

app.post('/api/groups/update', function (req, res) {
  const { groupId, userId, name, avatar } = req.body;
  const g = MEM.groups.find(function (x) { return x.id === groupId; });
  if (!g) return res.status(404).json({ error: 'Не найдена' });
  if (g.ownerId !== userId) return res.status(403).json({ error: 'Только создатель' });
  if (name && name.trim()) g.name = name.trim();
  if (avatar !== undefined) g.avatar = avatar;
  res.json({ success: true, group: groupWithDetails(g) });
});

app.post('/api/groups/add', function (req, res) {
  const { groupId, userId, members } = req.body;
  if (!Array.isArray(members) || members.length === 0) return res.status(400).json({ error: 'Выберите' });
  const g = MEM.groups.find(function (x) { return x.id === groupId; });
  if (!g) return res.status(404).json({ error: 'Не найдена' });
  if (g.ownerId !== userId) return res.status(403).json({ error: 'Только создатель' });
  let added = 0;
  members.forEach(function (m) { if (g.members.indexOf(m) === -1) { g.members.push(m); added++; } });
  if (added === 0) return res.status(400).json({ error: 'Никто' });
  res.json({ success: true, group: groupWithDetails(g) });
});

app.post('/api/groups/kick', function (req, res) {
  const { groupId, userId, memberId } = req.body;
  const g = MEM.groups.find(function (x) { return x.id === groupId; });
  if (!g) return res.status(404).json({ error: 'Не найдена' });
  if (g.ownerId !== userId) return res.status(403).json({ error: 'Только создатель' });
  if (memberId === userId) return res.status(400).json({ error: 'Нельзя себя' });
  if (g.members.indexOf(memberId) === -1) return res.status(404).json({ error: 'Не найден' });
  g.members = g.members.filter(function (m) { return m !== memberId; });
  res.json({ success: true, group: groupWithDetails(g) });
});

app.post('/api/groups/delete', function (req, res) {
  const { groupId, userId } = req.body;
  const g = MEM.groups.find(function (x) { return x.id === groupId; });
  if (!g) return res.status(404).json({ error: 'Не найдена' });
  if (g.ownerId !== userId) return res.status(403).json({ error: 'Только создатель' });
  MEM.groups = MEM.groups.filter(function (x) { return x.id !== groupId; });
  res.json({ success: true });
});

app.post('/api/groups/leave', function (req, res) {
  const { groupId, userId } = req.body;
  const g = MEM.groups.find(function (x) { return x.id === groupId; });
  if (!g) return res.status(404).json({ error: 'Не найдена' });
  g.members = g.members.filter(function (m) { return m !== userId; });
  if (g.ownerId === userId) g.ownerId = g.members[0] || null;
  if (g.members.length === 0) MEM.groups = MEM.groups.filter(function (x) { return x.id !== groupId; });
  res.json({ success: true });
});

/* ==================== СООБЩЕНИЯ ==================== */
app.post('/api/messages/send', function (req, res) {
  const {
    senderId, receiverId, groupId, text, fileData, fileName, fileType, clientId,
    fileUrl, fileSize, thumbUrl,
    encFileData, fileIv, fileKeyEncByUser,
    textKeyEncByUser, encryptionVersion
  } = req.body;

  let sender = MEM.accounts.find(function (u) { return u.id === senderId; });
  if (!sender) {
    sender = { id: senderId, name: 'Пользователь', avatar: '', pubKey: '', userAgent: '', contacts: [], blockedContacts: [], hiddenDialogs: [], updatedAt: Date.now() };
    MEM.accounts.push(sender);
  }

  if (groupId) {
    const g = MEM.groups.find(function (x) { return x.id === groupId; });
    if (!g) return res.status(404).json({ error: 'Не найдена' });
    if (g.members.indexOf(senderId) === -1) return res.status(403).json({ error: 'Вы не участник' });
  } else {
    let receiver = MEM.accounts.find(function (u) { return u.id === receiverId; });
    if (!receiver) {
      receiver = { id: receiverId, name: 'Пользователь', avatar: '', pubKey: '', userAgent: '', contacts: [], blockedContacts: [], hiddenDialogs: [], updatedAt: 0 };
      MEM.accounts.push(receiver);
    }
    if (sender.blockedContacts && sender.blockedContacts.indexOf(receiverId) !== -1) return res.status(403).json({ error: 'Заблокировали' });
    if (receiver.blockedContacts && receiver.blockedContacts.indexOf(senderId) !== -1) return res.status(403).json({ error: 'Заблокированы' });
    if (sender.hiddenDialogs) sender.hiddenDialogs = sender.hiddenDialogs.filter(function (id) { return id !== receiverId; });
    if (receiver.hiddenDialogs) receiver.hiddenDialogs = receiver.hiddenDialogs.filter(function (id) { return id !== senderId; });
    if (!sender.contacts) sender.contacts = [];
    if (sender.contacts.indexOf(receiverId) === -1) sender.contacts.push(receiverId);
    if (!receiver.contacts) receiver.contacts = [];
    if (receiver.contacts.indexOf(senderId) === -1) receiver.contacts.push(senderId);
  }

  const newMsg = {
    id: genId('msg_'), clientId: clientId || '',
    senderId: senderId,
    receiverId: groupId ? '' : receiverId,
    groupId: groupId || '',
    text: text || '',
    fileData: fileData || '',
    fileUrl: fileUrl || '',
    thumbUrl: thumbUrl || '',
    fileName: fileName || '',
    fileType: fileType || '',
    fileSize: fileSize || 0,
    encFileData: encFileData || '',
    fileIv: fileIv || '',
    fileKeyEncByUser: fileKeyEncByUser || null,
    textKeyEncByUser: textKeyEncByUser || null,
    encryptionVersion: encryptionVersion || 2,
    timestamp: timeStr(), ts: Date.now(),
    isRead: false, readBy: [], isDeleted: false, clearedFor: []
  };

  const targets = groupId
    ? (MEM.groups.find(function (x) { return x.id === groupId; }) || { members: [] }).members.filter(function (m) { return m !== senderId; })
    : [receiverId];

  targets.forEach(function (tid) {
    if (!tid) return;
    if (!MEM.inbox.has(tid)) MEM.inbox.set(tid, []);
    const q = MEM.inbox.get(tid);
    q.push(newMsg);
    if (q.length > MAX_INBOX_PER_USER) q.splice(0, q.length - MAX_INBOX_PER_USER);
  });

  res.json({ success: true, message: newMsg });
});

app.get('/api/messages/receive', function (req, res) {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'No user' });
  const pending = MEM.inbox.get(userId) || [];
  res.json({ success: true, messages: pending });
});

app.post('/api/messages/read', function (req, res) {
  const { msgIds, userId } = req.body;
  if (Array.isArray(msgIds) && userId) {
    MEM.inbox.forEach(function (q) {
      q.forEach(function (m) {
        if (msgIds.indexOf(m.id) !== -1) {
          if (!m.readBy) m.readBy = [];
          if (m.readBy.indexOf(userId) === -1) m.readBy.push(userId);
          m.isRead = true;
        }
      });
    });
  }
  res.json({ success: true });
});

app.delete('/api/messages/:msgId', function (req, res) {
  const msgId = req.params.msgId;
  MEM.inbox.forEach(function (q) {
    q.forEach(function (m) { if (m.id === msgId) m.isDeleted = true; });
  });
  res.json({ success: true });
});

app.post('/api/chat/clear', function (req, res) { res.json({ success: true }); });

app.get('/api/dialogs/:userId', function (req, res) {
  const userId = req.params.userId;
  const now = Date.now();
  const list = MEM.accounts
    .filter(function (u) { return u.id !== userId && u.name && u.updatedAt && (now - u.updatedAt < ONLINE_WINDOW_MS); })
    .map(function (u) { return { id: u.id, type: 'user', name: u.name, avatar: u.avatar || '', pubKey: u.pubKey || '', userAgent: u.userAgent || '', isOnline: true }; });
  res.json(list);
});

/* ==================== ЗВОНКИ ==================== */
app.post('/api/calls/start', function (req, res) {
  const { fromId, toId, video } = req.body;
  if (!fromId || !toId) return res.status(400).json({ error: 'No ids' });
  if (fromId === toId) return res.status(400).json({ error: 'Нельзя звонить себе' });
  const from = MEM.accounts.find(function (u) { return u.id === fromId; });
  const to = MEM.accounts.find(function (u) { return u.id === toId; });
  if (!from) return res.status(404).json({ error: 'Отправитель не найден' });
  if (!to) return res.status(404).json({ error: 'Получатель не найден' });
  if (to.blockedContacts && to.blockedContacts.indexOf(fromId) !== -1) return res.status(403).json({ error: 'Заблокирован' });

  activeCalls.forEach((call, cId) => {
    if (call.fromId === fromId || call.toId === fromId || call.fromId === toId || call.toId === toId) {
      activeCalls.delete(cId);
    }
  });

  const callId = genId('call_');
  activeCalls.set(callId, {
    id: callId, fromId: fromId, toId: toId,
    fromName: from.name, fromAvatar: from.avatar || '', toName: to.name,
    video: !!video, status: 'ringing', startedAt: Date.now(), answeredAt: 0
  });
  pushSig(toId, fromId, callId, 'offer-start', { fromName: from.name, fromAvatar: from.avatar || '', video: !!video });
  res.json({ success: true, callId: callId });
});

app.post('/api/calls/answer', function (req, res) {
  const { callId, userId, accept } = req.body;
  const call = activeCalls.get(callId);
  if (!call) return res.status(404).json({ error: 'Звонок не найден' });
  if (call.toId !== userId) return res.status(403).json({ error: 'Не тот получатель' });
  if (accept) {
    call.status = 'active'; call.answeredAt = Date.now();
    pushSig(call.fromId, call.toId, callId, 'accepted', {});
  } else {
    call.status = 'rejected';
    pushSig(call.fromId, call.toId, callId, 'rejected', {});
    setTimeout(function () { activeCalls.delete(callId); }, CALL_CLEANUP_DELAY_MS);
  }
  res.json({ success: true });
});

app.post('/api/calls/end', function (req, res) {
  const { callId, userId } = req.body;
  const call = activeCalls.get(callId);
  if (call) {
    const peer = userId === call.fromId ? call.toId : call.fromId;
    call.status = 'ended';
    pushSig(peer, userId, callId, 'ended', { by: userId });
    setTimeout(function () { activeCalls.delete(callId); }, CALL_CLEANUP_DELAY_MS);
  }
  res.json({ success: true });
});

app.post('/api/calls/signal', function (req, res) {
  const { callId, fromId, toId, type, payload } = req.body;
  if (!callId || !fromId || !toId || !type) return res.status(400).json({ error: 'Bad' });
  pushSig(toId, fromId, callId, type, payload);
  res.json({ success: true });
});

app.get('/api/calls/poll', function (req, res) {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'No user' });
  const q = ensureQ(userId);
  const now = Date.now();
  const fresh = q.filter(function (s) { return now - s.ts < 120000; });
  callSignals.set(userId, []);
  res.json({ success: true, signals: fresh });
});

/* ==================== HTML ==================== */
const CLIENT_HTML = `<!DOCTYPE html>
<html lang="ru" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>Мессенджер</title>
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
  .vid-wrapper{position:relative;width:280px;max-width:100%;border-radius:10px;overflow:hidden;margin-top:6px;background:#000;}
  .vid-wrapper video{width:100%;height:auto;display:block;max-height:320px;}
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
  .icon-btn{cursor:pointer;font-size:22px;border:none;background:transparent;color:var(--text-main);padding:4px;flex-shrink:0;transition:opacity .15s,filter .15s;}
  .icon-btn.recording{color:#e53935;}

  .input-bar.recording-mode .icon-btn,
  .input-bar.recording-mode #send-btn,
  .input-bar.recording-mode #msg-input {
    opacity: 0.35;
    pointer-events: none;
    filter: grayscale(1);
    cursor: not-allowed;
  }
  .input-bar.recording-mode #mic-btn.recording {
    opacity: 1;
    pointer-events: auto;
    filter: none;
  }
  .btn:disabled, .icon-btn:disabled {
    opacity: 0.35;
    filter: grayscale(1);
    cursor: not-allowed;
  }

  .empty-state{margin:auto;text-align:center;color:var(--text-muted);font-size:14px;}
  .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2000;display:flex;align-items:center;justify-content:center;visibility:hidden;opacity:0;transition:.15s;pointer-events:none;}
  .modal-overlay.active{visibility:visible;opacity:1;pointer-events:auto;}
  .profile-card{background:var(--bg-sidebar);width:90%;max-width:380px;border-radius:16px;padding:25px;display:flex;flex-direction:column;align-items:center;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.5);max-height:90dvh;overflow-y:auto;}
  .profile-name{font-size:20px;font-weight:bold;margin-bottom:5px;}
  .profile-id{font-size:13px;color:var(--accent);margin-bottom:15px;text-align:center;line-height:1.4;}
  .profile-actions{width:100%;display:flex;flex-direction:column;gap:10px;}
  .profile-link-btn{background:none;border:none;color:var(--accent);font-size:14px;cursor:pointer;padding:5px;text-align:center;}
  .member-row{display:flex;align-items:center;gap:10px;padding:6px 8px;cursor:pointer;border-radius:8px;position:relative;}
  .member-row:hover{background:var(--bg-hover);}
  .member-menu-btn{background:transparent;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;padding:4px 8px;border-radius:50%;}
  .member-dropdown{position:absolute;right:8px;top:90%;background:var(--bg-sidebar);border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.4);min-width:180px;z-index:1500;display:none;}
  .member-dropdown.active{display:block;}
  .member-dropdown .menu-item{padding:10px 14px;font-size:13px;}
  #image-viewer-modal{position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:3000;display:flex;align-items:center;justify-content:center;visibility:hidden;opacity:0;transition:.15s;pointer-events:none;}
  #image-viewer-modal.active{visibility:visible;opacity:1;pointer-events:auto;}
  #image-viewer-modal img{max-width:95vw;max-height:95vh;border-radius:8px;}
  .viewer-close{position:absolute;top:20px;right:20px;color:#fff;font-size:30px;cursor:pointer;background:none;border:none;z-index:3100;}
  .msg-actions-sheet{position:fixed;bottom:0;left:0;right:0;background:var(--bg-sidebar);border-top-left-radius:16px;border-top-right-radius:16px;padding:20px;z-index:1001;display:flex;flex-direction:column;gap:10px;visibility:hidden;opacity:0;transform:translateY(20px);transition:.15s;pointer-events:none;}
  .msg-actions-sheet.active{visibility:visible;opacity:1;transform:translateY(0);pointer-events:auto;}
  .call-overlay{position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:5000;display:none;flex-direction:column;align-items:center;justify-content:center;color:#fff;}
  .call-overlay.active{display:flex;}
  .call-topbar{position:absolute;top:0;left:0;right:0;padding:16px;display:flex;justify-content:space-between;align-items:center;z-index:10;}
  .call-close-x{background:rgba(255,255,255,.15);border:none;color:#fff;font-size:22px;width:40px;height:40px;border-radius:50%;cursor:pointer;}
  .call-title{font-size:18px;font-weight:bold;}
  .call-videos{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;}
  .call-remote-video{width:100%;height:100%;object-fit:contain;background:#000;}
  .call-local-video{position:absolute;top:70px;right:16px;width:110px;height:160px;object-fit:cover;border-radius:12px;background:#111;box-shadow:0 4px 12px rgba(0,0,0,.5);z-index:5;}
  .call-audio-screen{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;}
  .call-big-avatar{width:120px;height:120px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:bold;color:#fff;overflow:hidden;position:relative;}
  .call-big-avatar img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;border-radius:50%;}
  .call-name{font-size:24px;font-weight:bold;}
  .call-status-text{font-size:14px;opacity:.7;}
  .call-controls{position:absolute;bottom:30px;left:0;right:0;display:flex;justify-content:center;gap:16px;padding:0 16px;flex-wrap:wrap;z-index:10;}
  .call-ctrl-btn{width:60px;height:60px;border-radius:50%;background:rgba(255,255,255,.15);border:none;color:#fff;font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;}
  .call-ctrl-btn.danger{background:#e53935;}
  .call-ctrl-btn.active{background:var(--accent);}
  .call-incoming-actions{display:flex;gap:30px;margin-top:30px;}
  .call-incoming-btn{width:70px;height:70px;border-radius:50%;border:none;color:#fff;font-size:28px;cursor:pointer;display:flex;align-items:center;justify-content:center;}
  .call-incoming-btn.accept{background:#4cd964;}
  .call-incoming-btn.reject{background:#e53935;}
  #call-return-btn{display:none;position:fixed;bottom:20px;right:20px;z-index:4999;background:#4cd964;color:#fff;border:none;border-radius:50%;width:60px;height:60px;font-size:26px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.4);align-items:center;justify-content:center;}
  #call-in-progress-bar{display:none;position:fixed;top:0;left:0;right:0;z-index:4998;background:#2b5278;color:#fff;padding:8px;text-align:center;font-size:13px;cursor:pointer;}
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
      <h2>Мессенджер</h2>
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
              <button class="theme-toggle-btn" onclick="openCreateGroup()" title="Создать группу">👥</button>
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
            <button class="call-btn" id="call-btn" onclick="startCall()" title="Позвонить" style="display:none;">📞</button>
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
        <button class="btn btn-secondary" id="block-peer-btn" onclick="toggleBlockPeer()">Заблокировать</button>
        <button class="btn btn-secondary" onclick="closePeerProfile()">Закрыть</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="create-group-modal">
    <div class="profile-card">
      <h3 style="margin-bottom:15px;color:var(--accent);">Новая группа</h3>
      <div class="profile-avatar-big" id="create-group-avatar"><span>👥</span></div>
      <button class="profile-link-btn" onclick="triggerGroupAvatarInput()">Загрузить фото</button>
      <input type="file" id="group-avatar-input" style="display:none;" accept="image/*" onchange="handleGroupAvatarSelect(event)">
      <div class="input-group" style="width:100%;margin-top:10px;"><input type="text" id="create-group-name" placeholder="Название..."></div>
      <div style="width:100%;text-align:left;font-size:13px;color:var(--text-muted);margin-bottom:8px;">Участники:</div>
      <div id="create-group-contacts" style="width:100%;max-height:200px;overflow-y:auto;margin-bottom:10px;"></div>
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
      <div id="group-owner-controls" style="width:100%;display:none;border-bottom:1px solid var(--border);padding-bottom:12px;margin-bottom:8px;">
        <div class="input-group" style="width:100%;"><input type="text" id="edit-group-name" placeholder="Название..."></div>
        <button class="profile-link-btn" onclick="triggerEditGroupAvatarInput()">Изменить фото</button>
        <input type="file" id="edit-group-avatar-input" style="display:none;" accept="image/*" onchange="handleEditGroupAvatarSelect(event)">
        <button class="btn" id="save-group-btn" onclick="saveGroupChanges()">Сохранить</button>
        <button class="btn btn-secondary" onclick="openAddMembers()">Добавить участников</button>
      </div>
      <div style="width:100%;text-align:left;font-size:13px;color:var(--text-muted);margin:6px 0 5px;">Участники:</div>
      <div id="group-members-list" style="width:100%;max-height:180px;overflow-y:auto;margin-bottom:10px;"></div>
      <div class="profile-actions">
        <button class="btn btn-danger" id="delete-group-btn" style="display:none;" onclick="deleteGroup()">Удалить группу</button>
        <button class="btn btn-danger" onclick="leaveGroup()">Покинуть</button>
        <button class="btn btn-secondary" onclick="closeGroupProfile()">Закрыть</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="add-members-modal">
    <div class="profile-card">
      <h3 style="margin-bottom:15px;color:var(--accent);">Добавить участников</h3>
      <div id="add-members-contacts" style="width:100%;max-height:250px;overflow-y:auto;margin-bottom:10px;"></div>
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

  <div class="call-overlay" id="call-overlay">
    <div class="call-topbar">
      <div><div class="call-title" id="call-title">Звонок</div></div>
      <button class="call-close-x" onclick="minimizeCallOverlay()" title="Свернуть">✕</button>
    </div>
    <div class="call-videos">
      <div class="call-audio-screen" id="call-audio-screen">
        <div class="call-big-avatar" id="call-peer-avatar">?</div>
        <div class="call-name" id="call-peer-name">Собеседник</div>
        <div class="call-status-text" id="call-status-text">Соединение...</div>
      </div>
      <video class="call-remote-video" id="call-remote-video" autoplay playsinline style="display:none;"></video>
      <video class="call-local-video" id="call-local-video" autoplay playsinline muted style="display:none;"></video>
    </div>
    <div class="call-controls">
      <button class="call-ctrl-btn active" id="ctrl-mic" onclick="toggleCallMic()">🎤</button>
      <button class="call-ctrl-btn" id="ctrl-cam" onclick="toggleCallCam()">📷</button>
      <button class="call-ctrl-btn" id="ctrl-flip" onclick="flipCallCamera()">🔄</button>
      <button class="call-ctrl-btn danger" onclick="endCurrentCall()">📵</button>
    </div>
  </div>

  <div class="call-overlay" id="incoming-call-overlay">
    <div class="call-topbar">
      <div></div>
      <button class="call-close-x" onclick="rejectIncomingCall()" title="Отклонить">✕</button>
    </div>
    <div class="call-audio-screen">
      <div class="call-big-avatar" id="incoming-avatar">?</div>
      <div class="call-name" id="incoming-name">Собеседник</div>
      <div class="call-status-text" id="incoming-status-text">Входящий звонок...</div>
      <div class="call-incoming-actions">
        <button class="call-incoming-btn reject" onclick="rejectIncomingCall()">✕</button>
        <button class="call-incoming-btn accept" onclick="acceptIncomingCall()">📞</button>
      </div>
    </div>
  </div>

  <div id="call-return-btn" onclick="restoreCallOverlay()" title="Вернуться в звонок">📞</div>
  <div id="call-in-progress-bar" onclick="restoreCallOverlay()">📞 Вы в звонке с <b id="call-in-progress-name">собеседником</b> — нажмите, чтобы вернуться</div>

  <script src="/client.js"></script>
</body>
</html>`;

/* ==================== CLIENT JS ==================== */
const CLIENT_JS = `
var CLIENT_VERSION = '5.1.0';
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
var groupDraftAvatar = '';
var editGroupDraftAvatar = '';
var localKnownUsers = {};
var mutedPeers = [];
var localMessagesCache = [];
var localGroups = [];
var savedTheme = localStorage.getItem('app_theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);
var busyButtons = {};
var dialogsPollingTimer = null;
var activeMemberDropdown = null;
var profileTargetId = null;
var connectionState = 'checking';
var statusBarTimeout = null;
var MAX_FILE_SIZE = 200 * 1024 * 1024;
var serverVersion = 'unknown';
var pingFailCount = 0;
var healthFailCount = 0;
var isRetrying = false;
var filesDB = null;
var fileUrlCache = new Map();
var deletedIds = {};
var myKeyPair = null;
var searchRequestSeq = 0;
var unreadTitleCounter = 0;
var originalTitle = document.title;

/* ==================== DEVICE & ID ==================== */
function getOrCreateDeviceId() {
  var existing = localStorage.getItem('messenger_device_id');
  if (existing && existing.length >= 6) return existing;
  var newId = 'usr_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
  localStorage.setItem('messenger_device_id', newId);
  return newId;
}
function getDeviceInfo() {
  var ua = navigator.userAgent || '';
  var browser = 'Браузер';
  if (/Edg\\//i.test(ua)) browser = 'Edge';
  else if (/OPR\\//i.test(ua) || /Opera/i.test(ua)) browser = 'Opera';
  else if (/YaBrowser/i.test(ua)) browser = 'Яндекс';
  else if (/Firefox\\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\\//i.test(ua)) browser = 'Safari';
  var os = 'ОС';
  if (/Windows NT 10/i.test(ua)) os = 'Windows 10/11';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  return { browser: browser, os: os };
}
function getDeviceInfoString() {
  var d = getDeviceInfo();
  return d.os + ' · ' + d.browser;
}
function parseUserAgent(ua) {
  if (!ua) return '';
  var browser = 'Браузер';
  if (/Edg\\//i.test(ua)) browser = 'Edge';
  else if (/OPR\\//i.test(ua) || /Opera/i.test(ua)) browser = 'Opera';
  else if (/YaBrowser/i.test(ua)) browser = 'Яндекс';
  else if (/Firefox\\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\\//i.test(ua)) browser = 'Safari';
  var os = 'ОС';
  if (/Windows NT 10/i.test(ua)) os = 'Windows 10/11';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  return os + ' · ' + browser;
}

/* ==================== ШИФРОВАНИЕ ==================== */
function bufToBase64(buf) {
  var bytes = new Uint8Array(buf);
  var binary = '';
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToBuf(b64) {
  var binary = atob(b64);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
function strToU8(s) { return new TextEncoder().encode(s); }
function u8ToStr(u) { return new TextDecoder().decode(u); }

async function initMyKeyPair() {
  try {
    var storedPriv = localStorage.getItem('messenger_ec_priv');
    var storedPub = localStorage.getItem('messenger_ec_pub');
    if (storedPriv && storedPub) {
      var privKey = await crypto.subtle.importKey('jwk', JSON.parse(storedPriv), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
      var pubKey = await crypto.subtle.importKey('jwk', JSON.parse(storedPub), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
      myKeyPair = { privateKey: privKey, publicKey: pubKey, pubKeyB64: storedPub };
    } else {
      var kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
      var pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
      var privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
      var pubStr = JSON.stringify(pubJwk);
      localStorage.setItem('messenger_ec_priv', JSON.stringify(privJwk));
      localStorage.setItem('messenger_ec_pub', pubStr);
      myKeyPair = { privateKey: kp.privateKey, publicKey: kp.publicKey, pubKeyB64: pubStr };
    }
  } catch (e) { console.error('E2EE KeyInit error', e); }
}

var derivedKeysCache = {};
async function getDerivedSharedKey(peerPubKeyJwkStr) {
  if (!peerPubKeyJwkStr) return null;
  if (derivedKeysCache[peerPubKeyJwkStr]) return derivedKeysCache[peerPubKeyJwkStr];
  try {
    var peerPub = await crypto.subtle.importKey('jwk', JSON.parse(peerPubKeyJwkStr), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    var sharedKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerPub }, myKeyPair.privateKey,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    derivedKeysCache[peerPubKeyJwkStr] = sharedKey;
    return sharedKey;
  } catch (e) { return null; }
}
async function aesEncrypt(key, dataU8) {
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, dataU8);
  return { iv: bufToBase64(iv), data: bufToBase64(enc) };
}
async function aesDecrypt(key, ivB64, dataB64) {
  var iv = new Uint8Array(base64ToBuf(ivB64));
  var data = base64ToBuf(dataB64);
  var dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
  return new Uint8Array(dec);
}
async function generateFileKey() { return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']); }
async function exportFileKeyB64(k) { return bufToBase64(await crypto.subtle.exportKey('raw', k)); }
async function importFileKeyB64(b64) { return crypto.subtle.importKey('raw', base64ToBuf(b64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }
async function encryptBlob(blob) {
  var fileKey = await generateFileKey();
  var buf = await blob.arrayBuffer();
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, fileKey, buf);
  return { blob: new Blob([enc], { type: 'application/octet-stream' }), ivB64: bufToBase64(iv), keyB64: await exportFileKeyB64(fileKey), originalSize: blob.size };
}
async function decryptBlob(encBlob, keyB64, ivB64, originalType) {
  var fileKey = await importFileKeyB64(keyB64);
  var iv = new Uint8Array(base64ToBuf(ivB64));
  var buf = await encBlob.arrayBuffer();
  var dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, fileKey, buf);
  return new Blob([dec], { type: originalType || 'application/octet-stream' });
}
async function wrapFileKeyForUser(fileKeyB64, peerId) {
  var targetUser = (peerId === currentUser.id) ? currentUser : (localKnownUsers[peerId] || {});
  var pubKeyJwkStr = targetUser.pubKey || (peerId === currentUser.id ? myKeyPair.pubKeyB64 : '');
  if (!pubKeyJwkStr) return fileKeyB64;
  var sharedKey = await getDerivedSharedKey(pubKeyJwkStr);
  if (!sharedKey) return fileKeyB64;
  var enc = await aesEncrypt(sharedKey, strToU8(fileKeyB64));
  return enc.iv + '.' + enc.data;
}
async function unwrapFileKeyForMe(wrapped, senderId) {
  if (!wrapped) return null;
  if (wrapped.indexOf('.') === -1) return wrapped;
  var parts = wrapped.split('.');
  if (parts.length !== 2) return null;
  var senderUser = (senderId === currentUser.id) ? currentUser : (localKnownUsers[senderId] || {});
  var pubKeyJwkStr = senderUser.pubKey || (senderId === currentUser.id ? myKeyPair.pubKeyB64 : '');
  if (!pubKeyJwkStr) return null;
  var sharedKey = await getDerivedSharedKey(pubKeyJwkStr);
  if (!sharedKey) return null;
  try { var dec = await aesDecrypt(sharedKey, parts[0], parts[1]); return u8ToStr(dec); }
  catch (e) { return null; }
}
function blobToBase64(blob) {
  return new Promise(function (res, rej) {
    var r = new FileReader();
    r.onload = function () { var s = r.result; var idx = s.indexOf(','); res(idx >= 0 ? s.substring(idx + 1) : s); };
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
function getRecipients() {
  if (!activePeer) return [];
  if (activePeer.type === 'group') {
    var m = (activePeer.members || []).slice();
    if (m.indexOf(currentUser.id) === -1) m.push(currentUser.id);
    return m;
  }
  return [activePeer.id, currentUser.id];
}
async function wrapKeyForRecipients(fileKeyB64) {
  var recipients = getRecipients();
  var map = {};
  for (var i = 0; i < recipients.length; i++) {
    try { map[recipients[i]] = await wrapFileKeyForUser(fileKeyB64, recipients[i]); } catch (e) {}
  }
  return map;
}
async function buildEncryptedPayload(opts) {
  var payload = {
    clientId: opts.clientId, text: '', fileData: '',
    encFileData: opts.encFileData || '', fileIv: opts.fileIv || '',
    fileKeyEncByUser: opts.fileKeyEncByUser || null, textKeyEncByUser: null,
    fileName: opts.fileName || '', fileType: opts.fileType || '',
    fileUrl: opts.fileUrl || '', fileSize: opts.fileSize || 0,
    thumbUrl: opts.thumbUrl || '', encryptionVersion: 2
  };
  if (opts.plainText) {
    var textKey = await generateFileKey();
    var keyB64 = await exportFileKeyB64(textKey);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, textKey, strToU8(opts.plainText));
    payload.text = '__AESV2__:' + bufToBase64(iv) + ':' + bufToBase64(enc);
    payload.textKeyEncByUser = await wrapKeyForRecipients(keyB64);
  }
  return payload;
}

/* ==================== УТИЛИТЫ ==================== */
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
      bar.innerText = '✓ Подключено';
      bar.className = 'visible reconnected';
      statusBarTimeout = setTimeout(function () { bar.classList.remove('visible'); bar.dataset.wasOffline = '0'; }, 2000);
    }
  } else if (connectionState === 'no-internet') {
    bar.innerText = '⚠ Нет подключения';
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
  if (connectionState === 'online') { ls.classList.remove('active'); }
  else if (connectionState === 'no-internet') { ls.classList.add('active'); title.innerText = 'Нет подключения'; text.innerText = 'Проверьте соединение'; }
  else if (connectionState === 'server-offline') { ls.classList.add('active'); title.innerText = 'Соединение...'; text.innerText = 'Подключаемся к серверу'; }
  else { ls.classList.add('active'); title.innerText = 'Подключение'; text.innerText = 'Проверяем соединение'; }
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
  if (el) el.innerText = 'client v' + CLIENT_VERSION + ' · server v' + serverVersion;
}
window.addEventListener('online', async function () {
  healthFailCount = 0; pingFailCount = 0;
  var ok = await checkServerHealth();
  if (ok && currentUser) { loadDialogs(); startCallPolling(); }
});
window.addEventListener('offline', function () { setConnectionState('no-internet'); });

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
function saveCache() {
  try { localStorage.setItem('messenger_messages_cache', JSON.stringify(localMessagesCache)); }
  catch (e) {
    try {
      var light = localMessagesCache.map(function (m) {
        var c = Object.assign({}, m);
        if (c.encFileData && c.encFileData.length > 50000) c.encFileData = '';
        if (c.fileData && c.fileData.length > 50000) c.fileData = '';
        return c;
      });
      localStorage.setItem('messenger_messages_cache', JSON.stringify(light));
    } catch (e2) {}
  }
}
function saveGroups() { try { localStorage.setItem('messenger_groups', JSON.stringify(localGroups)); } catch (e) {} }

function mergeMessage(msg) {
  if (!msg || !msg.id) return;
  if (deletedIds[msg.id]) return;
  for (var i = 0; i < localMessagesCache.length; i++) {
    var m = localMessagesCache[i];
    if (m.id === msg.id || (msg.clientId && m.clientId && m.clientId === msg.clientId)) {
      if (!msg.fileUrl && m.fileUrl) msg.fileUrl = m.fileUrl;
      if (!msg.encFileData && m.encFileData) msg.encFileData = m.encFileData;
      if (!msg.fileIv && m.fileIv) msg.fileIv = m.fileIv;
      if (!msg.fileKeyEncByUser && m.fileKeyEncByUser) msg.fileKeyEncByUser = m.fileKeyEncByUser;
      if (!msg.textKeyEncByUser && m.textKeyEncByUser) msg.textKeyEncByUser = m.textKeyEncByUser;
      if (!msg.fileSize && m.fileSize) msg.fileSize = m.fileSize;
      if (!msg.fileType && m.fileType) msg.fileType = m.fileType;
      if (!msg.fileName && m.fileName) msg.fileName = m.fileName;
      if (!msg.thumbUrl && m.thumbUrl) msg.thumbUrl = m.thumbUrl;
      if (!msg.encryptionVersion && m.encryptionVersion) msg.encryptionVersion = m.encryptionVersion;
      localMessagesCache[i] = msg;
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
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08);
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.3);
  } catch (e) {}
}
function isPeerMuted(peerId) { return mutedPeers.indexOf(peerId) !== -1; }
function showBrowserNotification(title, body) {
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body: body, silent: false }); } catch (e) {}
}
function updatePageTitle() {
  if (unreadTitleCounter > 0) document.title = '(' + unreadTitleCounter + ') ' + originalTitle;
  else document.title = originalTitle;
}
function updateThemeIcon(theme) { var btn = document.getElementById('theme-toggle-btn'); if (btn) btn.innerText = theme === 'dark' ? '🌙' : '☀️'; }
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

/* ==================== INDEXED DB ==================== */
function openFilesDB() {
  return new Promise(function (resolve, reject) {
    if (filesDB) return resolve(filesDB);
    if (!window.indexedDB) return reject(new Error('No IndexedDB'));
    var req = indexedDB.open('messenger_files_v1', 1);
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
      tx.objectStore('files').put({ key: key, blob: blob, fileName: (meta && meta.fileName) || '', fileType: (meta && meta.fileType) || '', fileSize: (meta && meta.fileSize) || blob.size, savedAt: Date.now() });
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
  try { var res = await fetch(dataUrl); return await res.blob(); } catch (e) { return null; }
}
async function getFileUrl(msg) {
  if (!msg) return null;
  if (deletedIds[msg.id]) return null;
  if (fileUrlCache.has(msg.id)) return fileUrlCache.get(msg.id);
  var encBlob = null;
  var entry = await getFileFromIDB(msg.id);
  if (!entry && msg.clientId) entry = await getFileFromIDB(msg.clientId);
  if (entry && entry.blob) encBlob = entry.blob;
  
  if (!encBlob) {
    if (msg.encFileData) {
      try { encBlob = await blobFromDataUrl('data:application/octet-stream;base64,' + msg.encFileData); } catch (e) {}
    } else if (msg.fileData && msg.fileData.indexOf('data:') === 0) {
      try { encBlob = await blobFromDataUrl(msg.fileData); } catch (e) {}
    } else if (msg.fileUrl) {
      try { var res = await fetch(msg.fileUrl); if (res.ok) encBlob = await res.blob(); } catch (e) {}
    }
    if (encBlob) { try { await saveFileToIDB(msg.id, encBlob, { fileName: msg.fileName, fileType: msg.fileType, fileSize: encBlob.size }); } catch (e) {} }
  }
  if (!encBlob) return null;

  var mime = msg.fileType || '';
  if (!mime && msg.fileName) {
    var lower = String(msg.fileName).toLowerCase();
    if (lower.endsWith('.wav')) mime = 'audio/wav';
    else if (lower.endsWith('.mp3')) mime = 'audio/mpeg';
    else if (lower.endsWith('.ogg')) mime = 'audio/ogg';
    else if (lower.endsWith('.m4a')) mime = 'audio/mp4';
    else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) mime = 'image/jpeg';
    else if (lower.endsWith('.png')) mime = 'image/png';
    else if (lower.endsWith('.gif')) mime = 'image/gif';
    else if (lower.endsWith('.webp')) mime = 'image/webp';
    else if (lower.endsWith('.mp4')) mime = 'video/mp4';
    else if (lower.endsWith('.webm')) mime = 'video/webm';
  }

  if (msg.fileKeyEncByUser && msg.fileIv) {
    try {
      var wrapped = msg.fileKeyEncByUser[currentUser.id];
      if (!wrapped) return null;
      var fileKeyB64 = await unwrapFileKeyForMe(wrapped, msg.senderId);
      if (!fileKeyB64) return null;
      var dec = await decryptBlob(encBlob, fileKeyB64, msg.fileIv, mime || 'application/octet-stream');
      var url = URL.createObjectURL(dec);
      fileUrlCache.set(msg.id, url);
      return url;
    } catch (e) { return null; }
  }
  if (msg.encryptionVersion === 2 || msg.fileIv) return null;
  var blob2 = mime ? new Blob([await encBlob.arrayBuffer()], { type: mime }) : encBlob;
  var url2 = URL.createObjectURL(blob2);
  fileUrlCache.set(msg.id, url2);
  return url2;
}

/* ==================== UI РЕНДЕР ==================== */
function toggleChatDropdown() { var m = document.getElementById('chat-dropdown-menu'); if (m) m.classList.toggle('active'); }
function closeChatDropdown() { var m = document.getElementById('chat-dropdown-menu'); if (m) m.classList.remove('active'); }
document.addEventListener('click', function (e) {
  var menu = document.getElementById('chat-dropdown-menu');
  var b = document.getElementById('chat-menu-dots-btn');
  if (menu && menu.classList.contains('active')) {
    if (!menu.contains(e.target) && e.target !== b && !b.contains(e.target)) menu.classList.remove('active');
  }
});

function renderAvatarIntoElement(el, userObj, isOnline) {
  if (!el) return;
  var indicator = el.querySelector('.online-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'online-indicator';
    el.appendChild(indicator);
  }
  var rk = (userObj && userObj.id ? userObj.id : '') + '|' + (userObj && userObj.avatar ? String(userObj.avatar).substring(0, 30) : '') + '|' + (userObj && userObj.name ? userObj.name : '');
  if (el.dataset.renderKey === rk) {
    indicator.classList.toggle('visible', !!isOnline);
    indicator.classList.toggle('offline', !isOnline);
    return;
  }
  el.dataset.renderKey = rk;
  Array.from(el.childNodes).forEach(function (node) { if (node !== indicator) el.removeChild(node); });
  var src = userObj && userObj.avatar;
  if (src) {
    var img = document.createElement('img');
    img.src = src;
    img.onerror = function () {
      this.remove();
      var s = document.createElement('span');
      s.innerText = ((userObj && userObj.name) ? userObj.name.charAt(0).toUpperCase() : '?');
      el.insertBefore(s, indicator);
    };
    el.insertBefore(img, indicator);
  } else {
    var s2 = document.createElement('span');
    s2.innerText = (userObj && userObj.name ? userObj.name.charAt(0).toUpperCase() : '?');
    el.insertBefore(s2, indicator);
  }
  indicator.classList.toggle('visible', !!isOnline);
  indicator.classList.toggle('offline', !isOnline);
}
function fillAvatarBox(el, avatar, fallback) {
  if (!el) return;
  var rk = 'fill|' + (avatar ? String(avatar).substring(0, 30) : '') + '|' + (fallback || '?');
  if (el.dataset.renderKey === rk) return;
  el.dataset.renderKey = rk;
  Array.from(el.childNodes).forEach(function (node) {
    if (!node.classList || !node.classList.contains('online-indicator')) el.removeChild(node);
  });
  if (avatar) {
    var img = document.createElement('img');
    img.src = avatar;
    el.insertBefore(img, el.firstChild);
  } else {
    var s = document.createElement('span');
    s.innerText = fallback || '?';
    el.insertBefore(s, el.firstChild);
  }
}
function cacheUser(user) {
  if (!user || !user.id || user.type === 'group') return;
  localKnownUsers[user.id] = { id: user.id, name: user.name, avatar: user.avatar, pubKey: user.pubKey || '', userAgent: user.userAgent || '', updatedAt: Date.now() };
  try { localStorage.setItem('messenger_known_users', JSON.stringify(localKnownUsers)); } catch (e) {}
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
    list = localMessagesCache.filter(function (m) { return !m.isDeleted && !deletedIds[m.id] && m.groupId === chat.id; });
  } else {
    list = localMessagesCache.filter(function (m) {
      return !m.isDeleted && !deletedIds[m.id] && !m.groupId &&
        ((m.senderId === currentUser.id && m.receiverId === chat.id) ||
         (m.senderId === chat.id && m.receiverId === currentUser.id));
    });
  }
  return list.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
}
function messagesHash(msgs) {
  if (!msgs) return '';
  var h = '';
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    h += m.id + ':' + (m.isRead ? '1' : '0') + ':' + (m.isPending ? '1' : '0') + ':' + (m.isWaiting ? '1' : '0') + ':' + (m.isDeleted ? '1' : '0') + '|';
  }
  return h + '|' + msgs.length;
}
function updateMyProfileUI() {
  document.getElementById('my-display-name').innerText = currentUser.name;
  document.getElementById('my-display-device').innerText = 'ID: ' + currentUser.id + ' · ' + getDeviceInfoString();
  renderAvatarIntoElement(document.getElementById('my-avatar-circle'), currentUser, true);
}

/* ==================== ВХОД ==================== */
async function enterByName() {
  if (busyButtons['enter-btn']) return;
  var name = document.getElementById('auth-name').value.trim();
  var errBox = document.getElementById('auth-error');
  if (!name) { errBox.innerText = 'Введите имя'; errBox.style.display = 'block'; return; }
  if (!lockButton('enter-btn', 3000)) return;
  try {
    await initMyKeyPair();
    var deviceId = getOrCreateDeviceId();
    var res = await fetch('/api/enter', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, deviceId: deviceId, pubKey: myKeyPair ? myKeyPair.pubKeyB64 : '', userAgent: navigator.userAgent })
    });
    var data = await res.json();
    if (!data.success) { errBox.innerText = data.error || 'Ошибка'; errBox.style.display = 'block'; return; }
    currentUser = data.user;
    currentUser.pubKey = myKeyPair ? myKeyPair.pubKeyB64 : '';
    try { localStorage.setItem('messenger_user', JSON.stringify(currentUser)); } catch (e) {}
    if ('Notification' in window && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (e) {} }
    startApp();
  } catch (e) { errBox.innerText = 'Сервер недоступен'; errBox.style.display = 'block'; }
}
function logoutUser() {
  if (!confirm('Выйти? Данные останутся на этом устройстве.')) return;
  currentUser = null;
  localStorage.removeItem('messenger_user');
  location.reload();
}
async function restartSession() { if (!confirm('Перезапустить сессию? Данные сохранятся.')) return; location.reload(); }
async function deleteSession() {
  if (!currentUser) return;
  var ok = confirm('Удалить сессию?\\n\\nУдалится ВСЁ на этом устройстве.');
  if (!ok) return;
  var uid = currentUser.id;
  try { await fetch('/api/enter/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: uid }) }); } catch (e) {}
  try {
    ['messenger_user','messenger_known_users','messenger_messages_cache','messenger_ec_priv','messenger_ec_pub','messenger_deleted_ids','messenger_muted_peers','messenger_groups','messenger_device_id'].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
  } catch (e) {}
  try {
    var dbs = await indexedDB.databases();
    for (var i = 0; i < dbs.length; i++) {
      if (dbs[i].name && dbs[i].name.indexOf('messenger') === 0) {
        await new Promise(function (resolve) { var req = indexedDB.deleteDatabase(dbs[i].name); req.onsuccess = req.onerror = req.onblocked = function () { resolve(); }; });
      }
    }
  } catch (e) {
    try { await new Promise(function (resolve) { var req = indexedDB.deleteDatabase('messenger_files_v1'); req.onsuccess = req.onerror = req.onblocked = function () { resolve(); }; }); } catch (e2) {}
  }
  currentUser = null;
  location.reload();
}

function startApp() {
  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('active');
  updateMyProfileUI();
  sendPing();
  loadDialogs();
  startCallPolling();
  if (dialogsPollingTimer) clearInterval(dialogsPollingTimer);
  dialogsPollingTimer = setInterval(async function () {
    if (!currentUser || isRecording) return;
    sendPing();
    retryPendingMessages();
    try {
      var r = await fetch('/api/messages/receive?userId=' + encodeURIComponent(currentUser.id));
      var d = await r.json();
      if (d.success && d.messages && d.messages.length > 0) {
        var receivedIds = [];
        for (var i = 0; i < d.messages.length; i++) {
          var m = d.messages[i];
          receivedIds.push(m.id);
          await processIncomingMessage(m);
          if (!m.isDeleted) mergeMessage(m);
        }
        if (receivedIds.length > 0) {
          fetch('/api/messages/ack', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, messageIds: receivedIds })
          }).catch(function(){});
        }

        saveCache();
        if (activePeer) renderMessagesContainer(getChatMessages(activePeer));
        loadDialogs();

        d.messages.forEach(function (m) {
          if (m.senderId === currentUser.id) return;
          if (isPeerMuted(m.senderId)) return;
          if (document.hidden) {
            unreadTitleCounter++;
            updatePageTitle();
            var senderName = getUserName(m.senderId);
            var bodyText = m.text || (m.fileType ? '📎 Файл' : 'Сообщение');
            showBrowserNotification(senderName, bodyText);
            playNotificationSound();
          } else if (!activePeer || activePeer.id !== m.senderId) {
            playNotificationSound();
          }
        });
      }
    } catch (e) {}
    refreshChatListStatuses();
    if (activePeer) {
      loadMessagesQuiet();
      if (activePeer.type === 'group') refreshGroupInfo();
      else refreshActivePeerStatus();
    }
  }, 2000);
}
async function refreshChatListStatuses() {
  if (!currentUser) return;
  try {
    var res = await fetch('/api/dialogs/' + encodeURIComponent(currentUser.id));
    var onlineList = await res.json();
    var onlineMap = {};
    onlineList.forEach(function (u) { onlineMap[u.id] = true; cacheUser(u); });
    document.querySelectorAll('#chat-list .chat-item').forEach(function (itemEl) {
      var pid = itemEl.dataset.peerId;
      if (!pid) return;
      var av = itemEl.querySelector('.avatar-circle');
      if (!av) return;
      var ind = av.querySelector('.online-indicator');
      if (!ind) return;
      var isOn = !!onlineMap[pid];
      ind.classList.toggle('visible', isOn);
      ind.classList.toggle('offline', !isOn);
      var sub = itemEl.querySelector('.chat-item-subtitle');
      if (sub) sub.innerHTML = isOn ? '<span style="color:#4cd964;">в сети</span>' : '<span style="color:var(--text-muted);">не в сети</span>';
    });
  } catch (e) {}
}
async function sendPing() {
  if (!currentUser) return;
  try {
    var knownList = [];
    for (var k in localKnownUsers) if (localKnownUsers.hasOwnProperty(k)) knownList.push(localKnownUsers[k]);
    var res = await fetch('/api/ping', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar || '', pubKey: myKeyPair ? myKeyPair.pubKeyB64 : '', contacts: currentUser.contacts || [], knownUsers: knownList, userAgent: navigator.userAgent })
    });
    var data = await res.json();
    pingFailCount = 0;
    if (connectionState !== 'online' && navigator.onLine) setConnectionState('online');
    if (data.success && data.user) {
      var serverUser = data.user; var changed = false;
      if (serverUser.name && serverUser.name !== currentUser.name) { currentUser.name = serverUser.name; changed = true; }
      if (serverUser.avatar !== undefined && serverUser.avatar !== currentUser.avatar) { currentUser.avatar = serverUser.avatar; changed = true; }
      if (serverUser.userAgent) currentUser.userAgent = serverUser.userAgent;
      if (serverUser.contacts) { if (!currentUser.contacts) currentUser.contacts = []; serverUser.contacts.forEach(function (c) { if (currentUser.contacts.indexOf(c) === -1) currentUser.contacts.push(c); }); changed = true; }
      if (serverUser.blockedContacts) currentUser.blockedContacts = serverUser.blockedContacts;
      if (changed) { try { localStorage.setItem('messenger_user', JSON.stringify(currentUser)); } catch (e) {} updateMyProfileUI(); }
      if (Array.isArray(data.pendingMessages) && data.pendingMessages.length > 0) {
        (async function () {
          var ackIds = [];
          for (var i = 0; i < data.pendingMessages.length; i++) {
            var m = data.pendingMessages[i];
            ackIds.push(m.id);
            await processIncomingMessage(m);
            if (!m.isDeleted) mergeMessage(m);
          }
          if (ackIds.length > 0) {
            fetch('/api/messages/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: currentUser.id, messageIds: ackIds }) }).catch(function(){});
          }
          saveCache(); if (activePeer) renderMessagesContainer(getChatMessages(activePeer)); loadDialogs();
        })();
      }
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
      activePeer.isOnline = info.isOnline; activePeer.name = info.name; activePeer.avatar = info.avatar;
      if (info.pubKey) { activePeer.pubKey = info.pubKey; }
      if (info.userAgent) activePeer.userAgent = info.userAgent;
      cacheUser(activePeer);
      var statusEl = document.getElementById('active-peer-status');
      if (info.isOnline) { statusEl.innerText = 'в сети'; statusEl.style.color = '#4cd964'; }
      else { statusEl.innerText = 'не в сети'; statusEl.style.color = 'var(--text-muted)'; }
      renderAvatarIntoElement(document.getElementById('peer-avatar-circle'), activePeer, info.isOnline);
    }
  } catch (e) {}
}

/* ==================== ДИАЛОГИ ==================== */
function loadDialogs() {
  if (!currentUser) return;
  if (document.getElementById('search-input').value.trim()) return;
  var peers = new Set();
  localMessagesCache.forEach(function (m) {
    if (m.isDeleted || deletedIds[m.id]) return; if (m.groupId) return;
    if (m.senderId === currentUser.id) peers.add(m.receiverId);
    if (m.receiverId === currentUser.id) peers.add(m.senderId);
  });
  (currentUser.contacts || []).forEach(function (id) { peers.add(id); });

  fetch('/api/dialogs/' + encodeURIComponent(currentUser.id)).then(function (r) { return r.json(); }).then(function (onlineList) {
    var onlineMap = {};
    onlineList.forEach(function (u) { onlineMap[u.id] = u; cacheUser(u); });
    var dialogs = [];
    peers.forEach(function (pid) {
      if (pid === currentUser.id) return;
      var u = localKnownUsers[pid] || onlineMap[pid];
      if (!u || !u.name) return;
      var last = 0;
      localMessagesCache.forEach(function (m) {
        if (m.isDeleted || m.groupId) return;
        if ((m.senderId === currentUser.id && m.receiverId === pid) || (m.senderId === pid && m.receiverId === currentUser.id)) { if ((m.ts || 0) > last) last = m.ts || 0; }
      });
      dialogs.push({ id: pid, type: 'user', name: u.name, avatar: u.avatar || '', pubKey: u.pubKey || '', isOnline: !!onlineMap[pid], lastTs: last });
    });
    localGroups.forEach(function (g) {
      var last = 0;
      localMessagesCache.forEach(function (m) { if (!m.isDeleted && m.groupId === g.id && (m.ts || 0) > last) last = m.ts || 0; });
      dialogs.push({ id: g.id, type: 'group', name: g.name, avatar: g.avatar || '', ownerId: g.ownerId, members: g.members, memberCount: (g.members || []).length, lastTs: last });
    });
    dialogs.sort(function (a, b) { return (b.lastTs || 0) - (a.lastTs || 0); });
    renderChatList(dialogs);
  }).catch(function () {
    var dialogs = [];
    peers.forEach(function (pid) { var u = localKnownUsers[pid]; if (u && u.name) dialogs.push({ id: pid, type: 'user', name: u.name, avatar: u.avatar || '', pubKey: u.pubKey || '', isOnline: false, lastTs: 0 }); });
    localGroups.forEach(function (g) { dialogs.push({ id: g.id, type: 'group', name: g.name, avatar: g.avatar || '', ownerId: g.ownerId, members: g.members, memberCount: (g.members || []).length, lastTs: 0 }); });
    renderChatList(dialogs);
  });
}
function renderChatList(list) {
  var container = document.getElementById('chat-list');
  var currentActiveId = activePeer ? activePeer.id : null;
  var currentActiveType = activePeer ? (activePeer.type || 'user') : null;
  container.innerHTML = '';
  if (!list || list.length === 0) { container.innerHTML = '<div style="padding:15px;color:var(--text-muted);font-size:12px;text-align:center;">Нет чатов. Найдите собеседника в поиске.</div>'; return; }
  list.forEach(function (item) {
    var isGroup = item.type === 'group';
    var div = document.createElement('div');
    div.dataset.peerId = isGroup ? '' : item.id;
    var isActive = currentActiveId === item.id && currentActiveType === (item.type || 'user');
    div.className = 'chat-item ' + (isActive ? 'active' : '');
    div.onclick = function () { openChat(item); };
    var avatarId = 'chat_av_' + (isGroup ? 'grp_' : 'usr_') + item.id.replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + Math.random().toString(36).substr(2, 4);
    var subtitle = isGroup ? '<span style="color:var(--text-muted);">👥 ' + (item.memberCount || 0) + '</span>' : (item.isOnline ? '<span style="color:#4cd964;">в сети</span>' : '<span style="color:var(--text-muted);">не в сети</span>');
    div.innerHTML = '<div class="avatar-circle" id="' + avatarId + '">' + (isGroup ? '' : '<div class="online-indicator ' + (item.isOnline ? 'visible' : 'offline') + '"></div>') + '</div><div style="overflow:hidden;flex:1;"><div style="font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(item.name) + '</div><div class="chat-item-subtitle" style="font-size:11px;">' + subtitle + '</div></div>';
    container.appendChild(div);
    renderAvatarIntoElement(document.getElementById(avatarId), { id: item.id, avatar: item.avatar, name: item.name }, item.isOnline || false);
  });
}
function renderSearchResults(list) {
  var container = document.getElementById('chat-list');
  var currentActiveId = activePeer ? activePeer.id : null;
  var currentActiveType = activePeer ? (activePeer.type || 'user') : null;
  container.innerHTML = '';
  if (!list || list.length === 0) { container.innerHTML = '<div style="padding:15px;color:var(--text-muted);font-size:12px;text-align:center;">Никого не найдено</div>'; return; }
  var onlineList = list.filter(function (u) { return u.isOnline; });
  var offlineList = list.filter(function (u) { return !u.isOnline; });
  function buildItem(item) {
    var div = document.createElement('div');
    var isActive = currentActiveId === item.id && currentActiveType === 'user';
    div.className = 'chat-item ' + (isActive ? 'active' : '');
    div.onclick = function () { openChat(item); };
    var avatarId = 'ch_av_' + item.id.replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + Math.random().toString(36).substr(2, 4);
    var subtitle = item.isOnline ? '<span style="color:#4cd964;">в сети</span>' : '<span style="color:var(--text-muted);">не в сети</span>';
    div.innerHTML = '<div class="avatar-circle" id="' + avatarId + '"><div class="online-indicator ' + (item.isOnline ? 'visible' : 'offline') + '"></div></div><div style="overflow:hidden;flex:1;"><div style="font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(item.name) + '</div><div style="font-size:11px;">' + subtitle + '<span style="color:var(--text-muted);margin-left:6px;font-family:monospace;font-size:10px;">ID: ' + escapeHtml(item.id || '') + '</span></div></div>';
    container.appendChild(div);
    renderAvatarIntoElement(document.getElementById(avatarId), { id: item.id, avatar: item.avatar, name: item.name }, item.isOnline || false);
  }
  if (onlineList.length > 0) { var l1 = document.createElement('div'); l1.className = 'list-label'; l1.innerText = 'В сети (' + onlineList.length + ')'; container.appendChild(l1); onlineList.forEach(buildItem); }
  if (offlineList.length > 0) { var l2 = document.createElement('div'); l2.className = 'list-label'; l2.innerText = 'Не в сети (' + offlineList.length + ')'; container.appendChild(l2); offlineList.forEach(buildItem); }
}

/* ==================== ПОИСК ==================== */
var searchDebounceTimer = null;
function onSearchInput() { if (searchDebounceTimer) clearTimeout(searchDebounceTimer); searchDebounceTimer = setTimeout(doSearch, 200); }
async function doSearch() {
  var mySeq = ++searchRequestSeq;
  var q = document.getElementById('search-input').value.trim();
  var clearBtn = document.getElementById('clear-search-btn');
  var ql = q.toLowerCase();
  var map = {};
  for (var k in localKnownUsers) if (localKnownUsers.hasOwnProperty(k)) {
    var u = localKnownUsers[k];
    if (u.id === currentUser.id) continue;
    if (!q || (u.id && u.id.toLowerCase().indexOf(ql) !== -1) || (u.name && u.name.toLowerCase().indexOf(ql) !== -1)) {
      map[u.id] = { id: u.id, type: 'user', name: u.name, avatar: u.avatar || '', pubKey: u.pubKey || '', isOnline: false };
    }
  }
  if (q) clearBtn.style.display = 'block'; else clearBtn.style.display = 'none';
  renderSearchResults(Object.values(map));
  try {
    var r = await fetch('/api/users/search?q=' + encodeURIComponent(q) + '&excludeId=' + encodeURIComponent(currentUser.id));
    if (mySeq !== searchRequestSeq) return;
    var users = await r.json();
    if (Array.isArray(users)) {
      users.forEach(function (u) {
        if (map[u.id]) { map[u.id].isOnline = !!u.isOnline; map[u.id].name = u.name || map[u.id].name; map[u.id].avatar = u.avatar !== undefined ? u.avatar : map[u.id].avatar; }
        else map[u.id] = { id: u.id, type: 'user', name: u.name, avatar: u.avatar || '', pubKey: u.pubKey || '', isOnline: !!u.isOnline };
        cacheUser(u);
      });
    }
  } catch (e) {}
  if (mySeq !== searchRequestSeq) return;
  var arr = Object.values(map);
  arr.sort(function (a, b) { var ao = a.isOnline ? 1 : 0, bo = b.isOnline ? 1 : 0; if (ao !== bo) return bo - ao; return a.name.localeCompare(b.name); });
  renderSearchResults(arr);
}
function clearSearch() { document.getElementById('search-input').value = ''; document.getElementById('clear-search-btn').style.display = 'none'; loadDialogs(); }

/* ==================== ЧАТ ==================== */
function openChat(peer) {
  cancelVoiceAttachment();
  if (!peer.type) peer.type = 'user';
  var cameFromSearch = !!peer._fromSearch;
  activePeer = peer;
  cacheUser(peer);
  lastMessagesHash = '';
  document.getElementById('active-peer-name').innerText = peer.name;
  var statusEl = document.getElementById('active-peer-status');
  if (peer.type === 'group') {
    statusEl.innerText = (peer.memberCount || 0) + ' участников';
    statusEl.style.color = 'var(--text-muted)';
    document.getElementById('call-btn').style.display = 'none';
  } else {
    if (peer.isOnline) { statusEl.innerText = 'в сети'; statusEl.style.color = '#4cd964'; }
    else { statusEl.innerText = 'не в сети'; statusEl.style.color = 'var(--text-muted)'; }
    document.getElementById('call-btn').style.display = 'flex';
    if (!cameFromSearch) {
      if (!currentUser.contacts) currentUser.contacts = [];
      if (currentUser.contacts.indexOf(peer.id) === -1) {
        currentUser.contacts.push(peer.id);
        try { localStorage.setItem('messenger_user', JSON.stringify(currentUser)); } catch (e) {}
      }
    }
  }
  renderAvatarIntoElement(document.getElementById('peer-avatar-circle'), { id: peer.id, avatar: peer.avatar, name: peer.name }, peer.isOnline || false);
  document.getElementById('input-bar').style.display = 'flex';
  updateChatMenu();
  document.querySelectorAll('.chat-item').forEach(function (el) { el.classList.remove('active'); });
  if (window.innerWidth <= 600) { document.getElementById('app-screen').classList.add('app-mobile-chat'); document.getElementById('back-to-list-btn').style.display = 'block'; }
  loadMessages();
  if (peer.type === 'group') refreshGroupInfo();
  unreadTitleCounter = 0; updatePageTitle();
}
function closeMobileChat() { document.getElementById('app-screen').classList.remove('app-mobile-chat'); }

/* ==================== РАСШИФРОВКА ==================== */
async function processIncomingMessage(m) {
  if (m.text && m.text.indexOf('__AESV2__:') === 0) {
    var rest = m.text.substring('__AESV2__:'.length);
    var colon = rest.indexOf(':');
    if (colon > 0) {
      var ivB64 = rest.substring(0, colon);
      var dataB64 = rest.substring(colon + 1);
      var wrapped = m.textKeyEncByUser && m.textKeyEncByUser[currentUser.id];
      if (wrapped) {
        try {
          var fileKeyB64 = await unwrapFileKeyForMe(wrapped, m.senderId);
          if (fileKeyB64) { var fileKey = await importFileKeyB64(fileKeyB64); var dec = await aesDecrypt(fileKey, ivB64, dataB64); m.text = u8ToStr(dec); }
          else m.text = '[Зашифрованное сообщение]';
        } catch (e) { m.text = '[Ошибка расшифровки]'; }
      } else m.text = '[Ошибка ключа]';
    }
  }
}
async function loadMessages() {
  if (!activePeer) return;
  renderMessagesContainer(getChatMessages(activePeer));
  checkVisibleMessages();
}
async function loadMessagesQuiet() {
  if (!activePeer) return;
  var msgs = getChatMessages(activePeer);
  var newHash = messagesHash(msgs) + '|' + activePeer.id;
  if (newHash === lastMessagesHash) return;
  renderMessagesContainer(msgs);
}
function openImageViewer(src) { if (document.getElementById('image-viewer-modal').classList.contains('active')) return; document.getElementById('full-screen-img').src = src; document.getElementById('image-viewer-modal').classList.add('active'); }
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
  if (!container) return;

  if (!messages || messages.length === 0) {
    if (container.innerHTML !== '<div class="empty-state">Нет сообщений</div>') {
      container.innerHTML = '<div class="empty-state">Нет сообщений</div>';
      lastMessagesHash = '';
    }
    return;
  }

  var newHash = messagesHash(messages) + '|' + (activePeer ? activePeer.id : '');
  if (newHash === lastMessagesHash && container.children.length > 0 && !container.querySelector('.empty-state')) {
    return;
  }
  lastMessagesHash = newHash;

  var isGroup = activePeer && activePeer.type === 'group';
  var existingMap = {};
  Array.from(container.children).forEach(function (el) {
    var id = el.getAttribute && el.getAttribute('data-msg-id');
    if (id) existingMap[id] = el;
  });

  var seen = {};
  var prevScrollTop = container.scrollTop;
  var prevScrollHeight = container.scrollHeight;
  var wasAtBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) <= 80;

  for (var idx = 0; idx < messages.length; idx++) {
    var m = messages[idx];
    if (deletedIds[m.id] || m.isDeleted) continue;
    seen[m.id] = true;
    var existing = existingMap[m.id];
    if (existing) {
      updateMessageElement(existing, m, isGroup);
      container.appendChild(existing);
    } else {
      var div = createMessageElement(m, isGroup);
      container.appendChild(div);
    }
  }

  Array.from(container.children).forEach(function (el) {
    var id = el.getAttribute && el.getAttribute('data-msg-id');
    if (id && !seen[id]) el.remove();
    else if (!id && !el.classList.contains('empty-state')) el.remove();
  });

  if (wasAtBottom) container.scrollTop = container.scrollHeight;
  else {
    var newScrollHeight = container.scrollHeight;
    container.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
  }
}

function createMessageElement(m, isGroup) {
  var div = document.createElement('div');
  div.setAttribute('data-msg-id', m.id);
  div.setAttribute('data-sender-id', m.senderId);
  div.oncontextmenu = (function (msg, el) { return function (e) {
    if (e.target.tagName === 'AUDIO' || e.target.tagName === 'VIDEO' || (e.target.closest && (e.target.closest('audio') || e.target.closest('video')))) return;
    e.preventDefault(); openMsgActions(msg, el);
  }; })(m, div);
  div.ontouchstart = (function (msg, el) { return function (e) {
    if (e.target.tagName === 'AUDIO' || e.target.tagName === 'VIDEO' || (e.target.closest && (e.target.closest('audio') || e.target.closest('video')))) return;
    longTouchTimer = setTimeout(function () { openMsgActions(msg, el); }, 500);
  }; })(m, div);
  div.ontouchend = function () { clearTimeout(longTouchTimer); };
  div.ontouchmove = function () { clearTimeout(longTouchTimer); };
  div.className = 'msg ' + (m.senderId === currentUser.id ? 'my' : '') + (m.isPending ? ' pending' : (m.isWaiting ? ' waiting' : ''));
  div.innerHTML = buildMessageInnerHTML(m, isGroup);
  var placeholder = div.querySelector('[data-media-msg-id]');
  if (placeholder) loadMediaIntoPlaceholder(m, placeholder).catch(function () {});
  updateMessageElement(div, m, isGroup);
  return div;
}

function buildMessageInnerHTML(m, isGroup) {
  var html = '';
  if (isGroup && m.senderId !== currentUser.id) html += '<div class="msg-sender">' + escapeHtml(getUserName(m.senderId)) + '</div>';
  if (m.text) html += '<div class="msg-text">' + escapeHtml(m.text) + '</div>';
  var ft = m.fileType || '';
  if (m.encFileData || m.fileData || m.fileUrl || (m.fileType && m.fileSize)) {
    if (ft.indexOf('image/') === 0) html += '<div class="media-loading" data-media-msg-id="' + m.id + '">📷 Загрузка...</div>';
    else if (ft.indexOf('video/') === 0) html += '<div class="media-loading" data-media-msg-id="' + m.id + '">🎬 Загрузка...</div>';
    else if (ft.indexOf('audio/') === 0) html += '<div class="media-loading" data-media-msg-id="' + m.id + '">🎤 Загрузка...</div>';
    else html += '<div class="media-loading" data-media-msg-id="' + m.id + '">📁 ' + escapeHtml(m.fileName || 'Файл') + ' — загрузка...</div>';
  }
  html += '<div class="msg-wait-label"></div>';
  html += '<div class="msg-footer"><span class="msg-time">' + escapeHtml(m.timestamp || '') + '</span><span class="msg-ticks"></span></div>';
  return html;
}

function updateMessageElement(el, m, isGroup) {
  var wantClass = 'msg ' + (m.senderId === currentUser.id ? 'my' : '') + (m.isPending ? ' pending' : (m.isWaiting ? ' waiting' : ''));
  if (el.className !== wantClass) el.className = wantClass;

  var textEl = el.querySelector('.msg-text');
  if (m.text) {
    if (!textEl) {
      textEl = document.createElement('div');
      textEl.className = 'msg-text';
      el.insertBefore(textEl, el.firstChild);
    }
    if (textEl.textContent !== m.text) textEl.textContent = m.text;
  }

  var placeholder = el.querySelector('[data-media-msg-id]');
  if (placeholder && (m.encFileData || m.fileData || m.fileUrl || (m.fileType && m.fileSize))) {
    loadMediaIntoPlaceholder(m, placeholder).catch(function () {});
  }

  var waitLabel = el.querySelector('.msg-wait-label');
  if (waitLabel) {
    if (m.isWaiting && m.senderId === currentUser.id) {
      var peerName = isGroup ? 'группы' : getUserName(m.receiverId);
      var wt = '⏳ Ожидание соединения с ' + peerName + '…';
      if (waitLabel.textContent !== wt) { waitLabel.textContent = wt; waitLabel.style.cssText = 'font-size:10px;color:var(--accent);margin-top:2px;'; }
    } else if (waitLabel.textContent) {
      waitLabel.textContent = '';
      waitLabel.style.cssText = '';
    }
  }

  var timeEl = el.querySelector('.msg-time');
  if (timeEl && timeEl.textContent !== (m.timestamp || '')) timeEl.textContent = m.timestamp || '';

  var ticksEl = el.querySelector('.msg-ticks');
  if (ticksEl && m.senderId === currentUser.id) {
    var read = isGroupMsgRead(m);
    var sym = m.isPending ? '🕐' : (m.isWaiting ? '⏳' : (read ? '✓✓' : '✓'));
    if (ticksEl.textContent !== sym) ticksEl.textContent = sym;
    var wantTickClass = read ? 'ticks read msg-ticks' : 'ticks msg-ticks';
    if (ticksEl.className !== wantTickClass) ticksEl.className = wantTickClass;
  }
}

async function loadMediaIntoPlaceholder(msg, placeholder) {
  if (!placeholder || !placeholder.parentNode) return;
  if (deletedIds[msg.id] || msg.isDeleted) { if (placeholder.parentNode) placeholder.remove(); return; }
  var url = await getFileUrl(msg);
  if (!placeholder.parentNode) return;
  if (!url) { placeholder.outerHTML = '<div class="file-placeholder">⚠️ Файл недоступен</div>'; return; }
  var ft = msg.fileType || '';
  var newEl = null;
  if (ft.indexOf('image/') === 0) {
    newEl = document.createElement('img');
    newEl.className = 'media-preview'; newEl.src = url;
    newEl.addEventListener('click', function (e) { e.stopPropagation(); openImageViewer(url); });
  } else if (ft.indexOf('video/') === 0) {
    var wrapper = document.createElement('div');
    wrapper.className = 'vid-wrapper';
    var video = document.createElement('video');
    video.src = url; video.controls = true; video.playsInline = true; video.preload = 'metadata';
    video.setAttribute('data-msg-video-id', msg.id);
    if (msg.thumbUrl) video.poster = msg.thumbUrl;
    wrapper.appendChild(video); newEl = wrapper;
  } else if (ft.indexOf('audio/') === 0) {
    newEl = document.createElement('audio');
    newEl.className = 'audio-preview';
    newEl.controls = true;
    newEl.preload = 'auto';
    newEl.src = url;
    newEl.setAttribute('data-msg-audio-id', msg.id);
  } else {
    newEl = document.createElement('a');
    newEl.className = 'file-link'; newEl.href = url; newEl.download = msg.fileName || 'file'; newEl.target = '_blank';
    newEl.textContent = '📁 ' + (msg.fileName || 'Файл') + (msg.fileSize ? ' (' + formatBytes(msg.fileSize) + ')' : '');
  }
  if (!newEl) { placeholder.outerHTML = '<div class="file-placeholder">⚠️ Файл недоступен</div>'; return; }
  placeholder.parentNode.replaceChild(newEl, placeholder);
}

function checkVisibleMessages() {
  setTimeout(function () {
    if (!activePeer) return;
    var container = document.getElementById('messages-container');
    var els = container.querySelectorAll('.msg');
    var cr = container.getBoundingClientRect(); var unread = [];
    els.forEach(function (el) {
      var sid = el.getAttribute('data-sender-id'); var mid = el.getAttribute('data-msg-id');
      if (sid === currentUser.id || mid.indexOf('cid_') === 0) return;
      if (deletedIds[mid]) return;
      var r = el.getBoundingClientRect();
      if (r.top >= cr.top && r.bottom <= cr.bottom) {
        var mo = localMessagesCache.find(function (m) { return m.id === mid; });
        if (!mo || mo.isPending || mo.isWaiting) return;
        if (!mo.isRead) { mo.isRead = true; unread.push(mid); }
      }
    });
    if (unread.length > 0) { saveCache(); fetch('/api/messages/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgIds: unread, userId: currentUser.id }) }).catch(function () {}); }
  }, 300);
}

function openMsgActions(msg, el) {
  if (document.getElementById('msg-actions-sheet').classList.contains('active')) return;
  selectedMsgId = msg.id; selectedMsgObj = msg;
  document.querySelectorAll('.msg').forEach(function (x) { x.classList.remove('selected-msg'); });
  el.classList.add('selected-msg');
  document.getElementById('action-btn-copy').style.display = (msg.text && !msg.encFileData && !msg.fileData && !msg.fileUrl) ? 'block' : 'none';
  document.getElementById('action-btn-download').style.display = (msg.encFileData || msg.fileData || msg.fileUrl) ? 'block' : 'none';
  document.getElementById('msg-actions-sheet').classList.add('active');
}
function closeMsgActions() { selectedMsgId = null; selectedMsgObj = null; document.querySelectorAll('.msg').forEach(function (x) { x.classList.remove('selected-msg'); }); document.getElementById('msg-actions-sheet').classList.remove('active'); }
function actionCopyText() { var t = selectedMsgObj && selectedMsgObj.text; closeMsgActions(); if (t) navigator.clipboard.writeText(t).catch(function () {}); }
async function actionDownloadFile() {
  var obj = selectedMsgObj; closeMsgActions(); if (!obj) return;
  var url = await getFileUrl(obj); if (!url) { alert('Файл недоступен'); return; }
  var a = document.createElement('a'); a.href = url; a.download = obj.fileName || 'file'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
async function deleteSelectedMessage() {
  var id = selectedMsgId; closeMsgActions(); if (!id) return;
  markDeleted(id);
  for (var i = 0; i < localMessagesCache.length; i++) { if (localMessagesCache[i].id === id) { localMessagesCache[i].isDeleted = true; break; } }
  saveCache(); lastMessagesHash = ''; await deleteFileFromIDB(id);
  if (fileUrlCache.has(id)) { try { URL.revokeObjectURL(fileUrlCache.get(id)); } catch (e) {} fileUrlCache.delete(id); }
  if (activePeer) renderMessagesContainer(getChatMessages(activePeer));
  try { await fetch('/api/messages/' + id + '?userId=' + encodeURIComponent(currentUser.id), { method: 'DELETE' }); } catch (e) {}
}
function markDeleted(msgId) { deletedIds[msgId] = true; try { localStorage.setItem('messenger_deleted_ids', JSON.stringify(deletedIds)); } catch (e) {} }
function loadDeletedIds() { try { deletedIds = JSON.parse(localStorage.getItem('messenger_deleted_ids') || '{}'); } catch (e) { deletedIds = {}; } }

/* ==================== ФАЙЛЫ ==================== */
function triggerFileInput() { document.getElementById('file-input').click(); }
function generateVideoThumbnail(file, callback) {
  var video = document.createElement('video');
  video.preload = 'metadata'; video.src = URL.createObjectURL(file); video.muted = true; video.playsInline = true;
  video.onloadeddata = function () { video.currentTime = 0.5; };
  video.onseeked = function () {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 320; canvas.height = video.videoHeight || 240;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      callback(canvas.toDataURL('image/jpeg', 0.8));
    } catch (e) { callback(''); }
  };
  video.onerror = function () { callback(''); };
}
function handleFileSelect(e) {
  var file = e.target.files[0]; if (!file) return;
  if (file.size > MAX_FILE_SIZE) { alert('Максимум 200 МБ'); e.target.value = ''; return; }
  selectedFile = { file: file, name: file.name, type: file.type, isLarge: file.size > 1024 * 1024, thumbUrl: '' };
  var thumbImg = document.getElementById('attachment-thumb-img');
  document.getElementById('attachment-name-label').innerText = file.name;
  document.getElementById('attachment-type-label').innerText = formatBytes(file.size);
  if (file.type.indexOf('image/') === 0) { var r = new FileReader(); r.onload = function (ev) { thumbImg.src = ev.target.result; thumbImg.style.display = 'block'; }; r.readAsDataURL(file); }
  else if (file.type.indexOf('video/') === 0) { generateVideoThumbnail(file, function (thumb) { selectedFile.thumbUrl = thumb; if (thumb) { thumbImg.src = thumb; thumbImg.style.display = 'block'; } else { thumbImg.src = ''; thumbImg.style.display = 'none'; } }); }
  else { thumbImg.src = ''; thumbImg.style.display = 'none'; }
  document.getElementById('attachment-preview-container').classList.add('active');
}
function cancelAttachment() { selectedFile = null; document.getElementById('file-input').value = ''; document.getElementById('attachment-preview-container').classList.remove('active'); }
function cancelVoiceAttachment() {
  if (pendingVoice && pendingVoice.url && pendingVoice.url.indexOf('blob:') === 0) { try { URL.revokeObjectURL(pendingVoice.url); } catch (e) {} }
  pendingVoice = null;
  var box = document.getElementById('audio-attachment-preview'); if (box) box.classList.remove('active');
  var player = document.getElementById('audio-preview-player');
  if (player) { player.pause(); player.removeAttribute('src'); try { player.load(); } catch (e) {} }
}

/* ==================== ГОЛОС ==================== */
function floatTo16BitPCM(output, offset, input) {
  for (var i = 0; i < input.length; i++, offset += 2) { var s = Math.max(-1, Math.min(1, input[i])); s = s < 0 ? s * 0x8000 : s * 0x7FFF; output.setInt16(offset, s, true); }
}
function writeString(view, offset, string) { for (var i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i)); }
function encodeWAV(samples, sampleRate) {
  var buffer = new ArrayBuffer(44 + samples.length * 2); var view = new DataView(buffer);
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
  var hint = document.getElementById('recording-hint');
  if (hint) hint.classList.add('active');
  var bar = document.getElementById('input-bar');
  if (bar) bar.classList.add('recording-mode');
  if (recordingTimerInterval) clearInterval(recordingTimerInterval);
  recordingTimerInterval = setInterval(function () {
    var s = Math.floor((Date.now() - recordStartedAt) / 1000);
    document.getElementById('recording-timer').innerText = Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0');
  }, 200);
}
function stopRecordingTimer() {
  document.getElementById('record-panel').classList.remove('active');
  var hint = document.getElementById('recording-hint');
  if (hint) hint.classList.remove('active');
  var bar = document.getElementById('input-bar');
  if (bar) bar.classList.remove('recording-mode');
  if (recordingTimerInterval) { clearInterval(recordingTimerInterval); recordingTimerInterval = null; }
}
async function toggleVoiceRecord() {
  var micBtn = document.getElementById('mic-btn');
  if (isRecording) {
    isRecording = false; micBtn.innerText = '🎙️'; micBtn.classList.remove('recording'); stopRecordingTimer();
    var chunks = audioChunks.slice(); var rate = recordAudioCtx ? recordAudioCtx.sampleRate : 48000;
    cleanupRecordingNodes();
    try { if (activeStream) activeStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    activeStream = null;
    if (chunks.length === 0) { alert('Пустая запись'); return; }
    var totalLen = 0; for (var i = 0; i < chunks.length; i++) totalLen += chunks[i].length;
    var merged = new Float32Array(totalLen); var off = 0;
    for (var j = 0; j < chunks.length; j++) { merged.set(chunks[j], off); off += chunks[j].length; }
    var targetRate = 16000; var final = merged, fr = rate;
    if (rate > targetRate) {
      var ratio = rate / targetRate; var nl = Math.floor(merged.length / ratio); var down = new Float32Array(nl);
      for (var k = 0; k < nl; k++) down[k] = merged[Math.floor(k * ratio)] || 0;
      final = down; fr = targetRate;
    }
    var wavBlob = encodeWAV(final, fr); var url = '';
    try { url = URL.createObjectURL(wavBlob); } catch (e) {}
    pendingVoice = { name: 'voice_' + Date.now() + '.wav', type: 'audio/wav', url: url, blob: wavBlob };
    document.getElementById('audio-preview-player').src = url;
    document.getElementById('audio-attachment-preview').classList.add('active');
    return;
  }
  if (!activePeer) { alert('Выберите чат'); return; }
  if (!navigator.mediaDevices) { alert('Нет доступа'); return; }
  if (recordAudioCtx) { try { await recordAudioCtx.close(); } catch (e) {} recordAudioCtx = null; }
  try {
    var stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
    activeStream = stream;
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC(); recordAudioCtx = ctx;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
    var source = ctx.createMediaStreamSource(stream); recordSourceNode = source;
    var processor = ctx.createScriptProcessor(4096, 1, 1); recordProcessor = processor; audioChunks = [];
    processor.onaudioprocess = function (e) { if (!isRecording) return; audioChunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    var sg = ctx.createGain(); sg.gain.value = 0; recordSilentGain = sg;
    source.connect(processor); processor.connect(sg); sg.connect(ctx.destination);
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
  if (isRecording) return;
  if (!lockButton('send-btn', 1000)) return;
  var input = document.getElementById('msg-input');
  var text = input.value.trim(); var fileToSend = selectedFile; var voiceToSend = pendingVoice;
  if (!text && !fileToSend && !voiceToSend) return;
  input.value = '';
  var isGroup = activePeer.type === 'group';
  var clientId = 'cid_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
  var peerOnline = true;
  if (!isGroup) { var pu = localKnownUsers[activePeer.id]; if (pu && pu.updatedAt && (Date.now() - pu.updatedAt >= ONLINE_WINDOW_MS)) peerOnline = false; if (activePeer.isOnline === false) peerOnline = false; }
  var optMsg = {
    id: clientId, clientId: clientId, senderId: currentUser.id,
    receiverId: isGroup ? '' : activePeer.id, groupId: isGroup ? activePeer.id : '',
    text: text, fileName: fileToSend ? fileToSend.name : (voiceToSend ? voiceToSend.name : ''),
    fileType: fileToSend ? fileToSend.type : (voiceToSend ? voiceToSend.type : ''),
    thumbUrl: fileToSend ? fileToSend.thumbUrl : '',
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    ts: Date.now(), isRead: false, readBy: [], isDeleted: false, isPending: peerOnline, isWaiting: !peerOnline, encryptionVersion: 2
  };
  if (voiceToSend) {
    try {
      var encV = await encryptBlob(voiceToSend.blob); var encB64V = await blobToBase64(encV.blob); var wrapV = await wrapKeyForRecipients(encV.keyB64);
      optMsg.encFileData = encB64V; optMsg.fileIv = encV.ivB64; optMsg.fileKeyEncByUser = wrapV; optMsg.fileSize = encV.originalSize;
      try { await saveFileToIDB(clientId, encV.blob, { fileName: voiceToSend.name, fileType: voiceToSend.type, fileSize: encV.blob.size }); } catch (e) {}
      cancelVoiceAttachment(); mergeMessage(optMsg); renderMessagesContainer(getChatMessages(activePeer));
      var pV = await buildEncryptedPayload({ clientId: clientId, plainText: text, encFileData: encB64V, fileIv: encV.ivB64, fileKeyEncByUser: wrapV, fileName: voiceToSend.name, fileType: voiceToSend.type, fileSize: encV.originalSize });
      await sendPayload(pV);
    } catch (e) { alert('Ошибка отправки голосового'); }
    return;
  }
  if (fileToSend && !fileToSend.isLarge) {
    try {
      var enc = await encryptBlob(fileToSend.file); var encB64 = await blobToBase64(enc.blob); var wrap = await wrapKeyForRecipients(enc.keyB64);
      optMsg.encFileData = encB64; optMsg.fileIv = enc.ivB64; optMsg.fileKeyEncByUser = wrap; optMsg.fileSize = enc.originalSize;
      try { await saveFileToIDB(clientId, enc.blob, { fileName: fileToSend.name, fileType: fileToSend.type, fileSize: enc.blob.size }); } catch (e) {}
      cancelAttachment(); mergeMessage(optMsg); renderMessagesContainer(getChatMessages(activePeer));
      var p = await buildEncryptedPayload({ clientId: clientId, plainText: text, encFileData: encB64, fileIv: enc.ivB64, fileKeyEncByUser: wrap, fileName: fileToSend.name, fileType: fileToSend.type, fileSize: enc.originalSize, thumbUrl: fileToSend.thumbUrl });
      await sendPayload(p);
    } catch (e) { alert('Ошибка чтения файла'); }
    return;
  }
  if (fileToSend && fileToSend.isLarge) {
    optMsg.fileSize = fileToSend.file.size; optMsg.fileType = fileToSend.type;
    cancelAttachment(); mergeMessage(optMsg); renderMessagesContainer(getChatMessages(activePeer));
    uploadLargeFileInBackground(clientId, fileToSend.file, fileToSend.name, fileToSend.type, text, fileToSend.thumbUrl);
    return;
  }
  var pT = await buildEncryptedPayload({ clientId: clientId, plainText: text });
  optMsg.textEnc = pT.text; optMsg.textKeyEncByUser = pT.textKeyEncByUser;
  mergeMessage(optMsg); renderMessagesContainer(getChatMessages(activePeer));
  await sendPayload(pT);
}
async function sendPayload(payload) {
  var isGroup = activePeer.type === 'group';
  try {
    var res = await fetch('/api/messages/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        senderId: currentUser.id, receiverId: isGroup ? '' : activePeer.id, groupId: isGroup ? activePeer.id : '',
        text: payload.text || '', fileData: '', encFileData: payload.encFileData || '', fileIv: payload.fileIv || '',
        fileKeyEncByUser: payload.fileKeyEncByUser || null, textKeyEncByUser: payload.textKeyEncByUser || null,
        fileName: payload.fileName || '', fileType: payload.fileType || '', fileUrl: payload.fileUrl || '',
        fileSize: payload.fileSize || 0, thumbUrl: payload.thumbUrl || '', clientId: payload.clientId, encryptionVersion: 2
      })
    });
    if (res.status === 403) {
      localMessagesCache = localMessagesCache.filter(function (m) { return m.clientId !== payload.clientId; });
      saveCache(); renderMessagesContainer(getChatMessages(activePeer)); alert('Чат заблокирован'); return;
    }
    if (!res.ok) throw new Error('Server error');
    var data = await res.json();
    if (data && data.message) {
      var rm = Object.assign({}, data.message); rm.isPending = false; rm.isWaiting = false;
      var plain = localMessagesCache.find(function (m) { return m.clientId === payload.clientId; });
      rm.text = plain ? plain.text : '';
      if (payload.fileUrl) rm.fileUrl = payload.fileUrl;
      if (payload.fileSize) rm.fileSize = payload.fileSize;
      if (payload.encFileData) rm.encFileData = payload.encFileData;
      if (payload.fileIv) rm.fileIv = payload.fileIv;
      if (payload.fileKeyEncByUser) rm.fileKeyEncByUser = payload.fileKeyEncByUser;
      if (payload.textKeyEncByUser) rm.textKeyEncByUser = payload.textKeyEncByUser;
      if (!rm.fileType && payload.fileType) rm.fileType = payload.fileType;
      if (!rm.fileName && payload.fileName) rm.fileName = payload.fileName;
      if (!rm.thumbUrl && payload.thumbUrl) rm.thumbUrl = payload.thumbUrl;
      try {
        var entry = await getFileFromIDB(payload.clientId);
        if (entry && entry.blob) {
          await saveFileToIDB(rm.id, entry.blob, { fileName: rm.fileName, fileType: rm.fileType, fileSize: entry.blob.size });
          await deleteFileFromIDB(payload.clientId);
          if (fileUrlCache.has(payload.clientId)) { fileUrlCache.set(rm.id, fileUrlCache.get(payload.clientId)); fileUrlCache.delete(payload.clientId); }
        }
      } catch (e) {}
      mergeMessage(rm); saveCache(); renderMessagesContainer(getChatMessages(activePeer));
      if (connectionState !== 'online' && navigator.onLine) setConnectionState('online');
    }
  } catch (e) { if (!navigator.onLine) setConnectionState('no-internet'); else setConnectionState('server-offline'); }
}
async function uploadLargeFileInBackground(clientId, file, fileName, fileType, text, thumbUrl) {
  try {
    var enc = await encryptBlob(file); var wrap = await wrapKeyForRecipients(enc.keyB64);
    try { await saveFileToIDB(clientId, enc.blob, { fileName: fileName, fileType: fileType, fileSize: enc.blob.size }); } catch (e) {}
    var b64 = await blobToBase64(enc.blob);
    for (var j = 0; j < localMessagesCache.length; j++) {
      if (localMessagesCache[j].clientId === clientId) {
        localMessagesCache[j].encFileData = b64; localMessagesCache[j].fileKeyEncByUser = wrap;
        localMessagesCache[j].fileIv = enc.ivB64; localMessagesCache[j].fileSize = enc.originalSize;
        localMessagesCache[j].fileType = fileType; localMessagesCache[j].fileName = fileName; localMessagesCache[j].thumbUrl = thumbUrl;
        break;
      }
    }
    saveCache();
    var p = await buildEncryptedPayload({ clientId: clientId, plainText: text, encFileData: b64, fileIv: enc.ivB64, fileKeyEncByUser: wrap, fileName: fileName, fileType: fileType, fileSize: enc.originalSize, thumbUrl: thumbUrl });
    await sendPayload(p);
    lastMessagesHash = '';
    if (activePeer) renderMessagesContainer(getChatMessages(activePeer));
  } catch (e) {}
}
async function retryPendingMessages() {
  if (!currentUser || isRetrying) return;
  var pending = localMessagesCache.filter(function (m) { return (m.isPending || m.isWaiting) && m.senderId === currentUser.id && m.clientId; });
  if (pending.length === 0) return;
  isRetrying = true; var anySuccess = false;
  for (var i = 0; i < pending.length; i++) {
    var pm = pending[i];
    try {
      var body = {
        senderId: pm.senderId, receiverId: pm.receiverId || '', groupId: pm.groupId || '',
        text: pm.textEnc || (pm.text ? '__PLAIN__' : ''), fileData: '', fileName: pm.fileName || '', fileType: pm.fileType || '',
        clientId: pm.clientId, fileUrl: pm.fileUrl || '', fileSize: pm.fileSize || 0, thumbUrl: pm.thumbUrl || '',
        encFileData: pm.encFileData || '', fileIv: pm.fileIv || '',
        fileKeyEncByUser: pm.fileKeyEncByUser || null, textKeyEncByUser: pm.textKeyEncByUser || null, encryptionVersion: pm.encryptionVersion || 2
      };
      var res = await fetch('/api/messages/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) {
        var data = await res.json();
        if (data && data.message) {
          var rm = Object.assign({}, data.message); rm.isPending = false; rm.isWaiting = false; rm.text = pm.text || '';
          if (!rm.encFileData && pm.encFileData) rm.encFileData = pm.encFileData;
          if (!rm.fileIv && pm.fileIv) rm.fileIv = pm.fileIv;
          if (!rm.fileKeyEncByUser && pm.fileKeyEncByUser) rm.fileKeyEncByUser = pm.fileKeyEncByUser;
          if (!rm.fileSize && pm.fileSize) rm.fileSize = pm.fileSize;
          if (!rm.fileType && pm.fileType) rm.fileType = pm.fileType;
          if (!rm.fileName && pm.fileName) rm.fileName = pm.fileName;
          if (!rm.thumbUrl && pm.thumbUrl) rm.thumbUrl = pm.thumbUrl;
          if (!rm.textKeyEncByUser && pm.textKeyEncByUser) rm.textKeyEncByUser = pm.textKeyEncByUser;
          for (var j = 0; j < localMessagesCache.length; j++) { if (localMessagesCache[j].clientId === pm.clientId) { localMessagesCache[j] = rm; break; } }
          anySuccess = true;
        }
      }
    } catch (e) { break; }
  }
  if (anySuccess) { saveCache(); if (activePeer) renderMessagesContainer(getChatMessages(activePeer)); }
  isRetrying = false;
}

/* ==================== ПРОФИЛЬ ==================== */
function openMyProfile() {
  if (isModalOpen('my-profile-modal')) return;
  document.getElementById('edit-my-name-input').value = currentUser.name;
  renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), currentUser, true);
  document.getElementById('my-profile-name-view').innerText = currentUser.name;
  document.getElementById('my-profile-id-view').innerHTML =
    '<span style="color:var(--text-main);">ID: ' + escapeHtml(currentUser.id) + '</span>' +
    '<br><span style="font-size:11px;color:var(--text-muted);">' + escapeHtml(getDeviceInfoString()) + '</span>';
  document.getElementById('remove-avatar-link-btn').style.display = currentUser.avatar ? 'block' : 'none';
  safeOpenModal('my-profile-modal');
}
function closeMyProfile() { safeCloseModal('my-profile-modal'); }
function triggerAvatarInput() { var i = document.getElementById('avatar-file-input'); i.value = ''; i.click(); }
function handleAvatarSelect(e) {
  var file = e.target.files[0]; if (!file) return;
  if (file.size > 10 * 1024 * 1024) { alert('Максимум 10 МБ'); return; }
  compressImage(file, 200, 0.85, function (c) {
    if (!c) return;
    currentUser.avatar = c;
    renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), { id: currentUser.id, avatar: c, name: currentUser.name }, true);
    document.getElementById('remove-avatar-link-btn').style.display = 'block';
  });
}
function removeMyAvatar() {
  currentUser.avatar = '';
  renderAvatarIntoElement(document.getElementById('my-profile-avatar-view'), { id: currentUser.id, avatar: '', name: currentUser.name }, true);
  document.getElementById('remove-avatar-link-btn').style.display = 'none';
}
async function saveMyProfileChanges() {
  if (!lockButton('save-my-profile-btn', 3000)) return;
  var newName = document.getElementById('edit-my-name-input').value.trim();
  if (newName) currentUser.name = newName;
  try { localStorage.setItem('messenger_user', JSON.stringify(currentUser)); } catch (e) {}
  updateMyProfileUI();
  try { await fetch('/api/profile/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar, pubKey: myKeyPair ? myKeyPair.pubKeyB64 : '' }) }); } catch (e) {}
  closeMyProfile();
}
function openPeerProfile() {
  if (!activePeer) return;
  if (activePeer.type === 'group') { openGroupProfile(); return; }
  profileTargetId = activePeer.id;
  if (isModalOpen('peer-profile-modal')) return;
  renderAvatarIntoElement(document.getElementById('peer-profile-avatar-view'), activePeer, !!activePeer.isOnline);
  document.getElementById('peer-profile-name-view').innerText = activePeer.name;
  var devStr = activePeer.userAgent ? parseUserAgent(activePeer.userAgent) : '';
  document.getElementById('peer-profile-id-view').innerHTML =
    '<span style="color:var(--text-main);">ID: ' + escapeHtml(activePeer.id) + '</span>' +
    (devStr ? '<br><span style="font-size:11px;color:var(--text-muted);">' + escapeHtml(devStr) + '</span>' : '');
  updatePeerProfileButtons(activePeer);
  safeOpenModal('peer-profile-modal');
  fetch('/api/users/' + activePeer.id).then(function (r) { return r.json(); }).then(function (info) {
    if (info && info.userAgent) {
      activePeer.userAgent = info.userAgent;
      var s = parseUserAgent(info.userAgent);
      var el = document.getElementById('peer-profile-id-view');
      if (el) el.innerHTML =
        '<span style="color:var(--text-main);">ID: ' + escapeHtml(activePeer.id) + '</span>' +
        (s ? '<br><span style="font-size:11px;color:var(--text-muted);">' + escapeHtml(s) + '</span>' : '');
    }
  }).catch(function () {});
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
  renderAvatarIntoElement(document.getElementById('peer-profile-avatar-view'), member, !!member.isOnline);
  document.getElementById('peer-profile-name-view').innerText = member.name;
  var devStr = member.userAgent ? parseUserAgent(member.userAgent) : '';
  document.getElementById('peer-profile-id-view').innerHTML =
    '<span style="color:var(--text-main);">ID: ' + escapeHtml(member.id) + '</span>' +
    (devStr ? '<br><span style="font-size:11px;color:var(--text-muted);">' + escapeHtml(devStr) + '</span>' : '');
  updatePeerProfileButtons(member);
  safeOpenModal('peer-profile-modal');
}
function closePeerProfile() { safeCloseModal('peer-profile-modal'); }
function toggleMutePeer() {
  if (!profileTargetId) return;
  var i = mutedPeers.indexOf(profileTargetId);
  if (i > -1) mutedPeers.splice(i, 1); else mutedPeers.push(profileTargetId);
  localStorage.setItem('messenger_muted_peers', JSON.stringify(mutedPeers));
  updatePeerProfileButtons({ id: profileTargetId });
}
async function toggleBlockPeer() {
  if (!profileTargetId) return;
  if (!lockButton('block-peer-btn', 2000)) return;
  var blocked = currentUser.blockedContacts && currentUser.blockedContacts.indexOf(profileTargetId) !== -1;
  var nextBlock = !blocked;
  try {
    var res = await fetch('/api/users/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: currentUser.id, peerId: profileTargetId, block: nextBlock }) });
    var data = await res.json();
    if (data.success) { currentUser.blockedContacts = data.blockedContacts; try { localStorage.setItem('messenger_user', JSON.stringify(currentUser)); } catch (e) {} closePeerProfile(); }
  } catch (e) {}
}
function updateChatMenu() {
  var menu = document.getElementById('chat-dropdown-menu');
  if (activePeer && activePeer.type === 'group') menu.innerHTML = '<button class="menu-item" onclick="openGroupProfile()">Профиль группы</button><button class="menu-item" onclick="clearChatHistory()">Очистить историю</button><button class="menu-item danger" onclick="leaveGroup()">Покинуть</button>';
  else menu.innerHTML = '<button class="menu-item" onclick="clearChatHistory()">Очистить историю</button><button class="menu-item danger" onclick="deleteCurrentChat()">Удалить чат</button>';
}
async function clearChatHistory() {
  closeChatDropdown();
  if (!activePeer || !confirm('Очистить историю?')) return;
  var isGroup = activePeer.type === 'group';
  try { await fetch('/api/chat/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(isGroup ? { userId: currentUser.id, groupId: activePeer.id } : { userId: currentUser.id, peerId: activePeer.id }) }); } catch (e) {}
  var ids = [];
  getChatMessages(activePeer).forEach(function (m) { m.isDeleted = true; markDeleted(m.id); ids.push(m.id); });
  for (var i = 0; i < ids.length; i++) await deleteFileFromIDB(ids[i]);
  saveCache(); lastMessagesHash = ''; loadMessages();
}
async function deleteCurrentChat() {
  closeChatDropdown();
  if (!activePeer || !confirm('Удалить чат?')) return;
  try { await fetch('/api/chat/hide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: currentUser.id, peerId: activePeer.id }) }); resetActiveChat(); loadDialogs(); } catch (e) {}
}
function resetActiveChat() {
  cancelVoiceAttachment(); cancelAttachment(); closeMobileChat(); activePeer = null;
  document.getElementById('input-bar').style.display = 'none';
  document.getElementById('call-btn').style.display = 'none';
  document.getElementById('active-peer-name').innerText = 'Выберите чат';
  document.getElementById('active-peer-status').innerText = 'нажмите для профиля';
  document.getElementById('messages-container').innerHTML = '<div class="empty-state">Выберите диалог</div>';
  lastMessagesHash = '';
}

/* ==================== ГРУППЫ ==================== */
async function getContactUsers() {
  try { var res = await fetch('/api/users/online?userId=' + encodeURIComponent(currentUser.id)); var list = await res.json(); list.forEach(function (u) { cacheUser(u); }); return list; }
  catch (e) { return []; }
}
function renderCheckList(containerId, users, excludeSet) {
  var c = document.getElementById(containerId); c.innerHTML = '';
  var list = users.filter(function (u) { return !excludeSet.has(u.id); });
  if (list.length === 0) { c.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">Нет доступных контактов</div>'; return; }
  list.forEach(function (u) {
    var row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px;cursor:pointer;border-bottom:1px solid var(--border);';
    var avatarId = 'chk_av_' + u.id.replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + Math.random().toString(36).substr(2, 4);
    row.innerHTML = '<input type="checkbox" value="' + u.id + '" style="width:18px;height:18px;"><div class="avatar-circle" id="' + avatarId + '" style="width:32px;height:32px;font-size:13px;"></div><span style="flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">' + escapeHtml(u.name) + '</span>';
    c.appendChild(row);
    renderAvatarIntoElement(document.getElementById(avatarId), u, !!u.isOnline);
  });
}
function getChecked(containerId) { return Array.from(document.querySelectorAll('#' + containerId + ' input[type=checkbox]:checked')).map(function (i) { return i.value; }); }
async function openCreateGroup() {
  if (isModalOpen('create-group-modal')) return;
  groupDraftAvatar = '';
  document.getElementById('create-group-name').value = '';
  fillAvatarBox(document.getElementById('create-group-avatar'), '', '👥');
  var cached = [];
  for (var k in localKnownUsers) if (localKnownUsers.hasOwnProperty(k)) {
    var u = localKnownUsers[k];
    if (u.id && u.id !== currentUser.id) cached.push({ id: u.id, type: 'user', name: u.name, avatar: u.avatar || '', pubKey: u.pubKey || '', isOnline: false });
  }
  renderCheckList('create-group-contacts', cached, new Set());
  safeOpenModal('create-group-modal');
  try {
    var res = await fetch('/api/users/online?userId=' + encodeURIComponent(currentUser.id));
    var list = await res.json();
    list.forEach(function (u) { cacheUser(u); });
    renderCheckList('create-group-contacts', list, new Set());
  } catch(e){}
}
function closeCreateGroup() { safeCloseModal('create-group-modal'); }
function triggerGroupAvatarInput() { var i = document.getElementById('group-avatar-input'); i.value = ''; i.click(); }
function handleGroupAvatarSelect(e) {
  var file = e.target.files[0]; if (!file) return;
  compressImage(file, 200, 0.85, function (c) { if (!c) return; groupDraftAvatar = c; fillAvatarBox(document.getElementById('create-group-avatar'), groupDraftAvatar, '👥'); });
}
async function submitCreateGroup() {
  var name = document.getElementById('create-group-name').value.trim();
  if (!name) { alert('Введите название'); return; }
  var members = getChecked('create-group-contacts');
  if (members.length === 0) { alert('Выберите участников'); return; }
  if (!lockButton('create-group-submit-btn', 5000)) return;
  try {
    var res = await fetch('/api/groups/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: currentUser.id, name: name, members: members, avatar: groupDraftAvatar }) });
    var data = await res.json();
    if (data.success) {
      closeCreateGroup();
      var g = data.group; localGroups.push(g); saveGroups(); loadDialogs();
      openChat({ id: g.id, type: 'group', name: g.name, avatar: g.avatar, members: g.members, ownerId: g.ownerId, memberCount: g.members.length });
    } else alert(data.error || 'Ошибка');
  } catch (e) { alert('Не удалось'); }
}
async function refreshGroupInfo() {
  if (!activePeer || activePeer.type !== 'group') return;
  try {
    var res = await fetch('/api/groups/' + activePeer.id);
    if (!res.ok) return;
    var g = await res.json();
    activePeer.name = g.name; activePeer.avatar = g.avatar; activePeer.members = g.members; activePeer.ownerId = g.ownerId;
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

  editGroupDraftAvatar = '';
  fillAvatarBox(document.getElementById('group-profile-avatar'), activePeer.avatar, '👥');
  document.getElementById('group-profile-name').innerText = activePeer.name || 'Группа';
  document.getElementById('group-profile-count').innerText = ((activePeer.members || []).length) + ' участников';
  var isOwner = activePeer.ownerId === currentUser.id;
  document.getElementById('group-owner-controls').style.display = isOwner ? 'block' : 'none';
  document.getElementById('delete-group-btn').style.display = isOwner ? 'block' : 'none';
  if (isOwner) document.getElementById('edit-group-name').value = activePeer.name || '';
  document.getElementById('group-members-list').innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">Загрузка участников…</div>';
  safeOpenModal('group-profile-modal');

  await refreshGroupInfo();

  var g = activePeer;
  fillAvatarBox(document.getElementById('group-profile-avatar'), g.avatar, '👥');
  document.getElementById('group-profile-name').innerText = g.name;
  document.getElementById('group-profile-count').innerText = (g.members ? g.members.length : 0) + ' участников';
  isOwner = g.ownerId === currentUser.id;
  document.getElementById('group-owner-controls').style.display = isOwner ? 'block' : 'none';
  document.getElementById('delete-group-btn').style.display = isOwner ? 'block' : 'none';
  if (isOwner) document.getElementById('edit-group-name').value = g.name;
  if (!g.memberDetails || g.memberDetails.length === 0) {
    document.getElementById('group-members-list').innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">Участники не загружены</div>';
  } else {
    renderMembersList('group-members-list', g.memberDetails, g.ownerId);
  }
}
function closeGroupProfile() { editGroupDraftAvatar = ''; safeCloseModal('group-profile-modal'); closeMemberDropdown(); }
function renderMembersList(containerId, memberDetails, ownerId) {
  var c = document.getElementById(containerId); if (!c) return;
  c.innerHTML = '';
  if (!memberDetails || memberDetails.length === 0) {
    c.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">Участники не загружены</div>';
    return;
  }
  var amOwner = ownerId === currentUser.id;
  memberDetails.forEach(function (u) {
    var row = document.createElement('div'); row.className = 'member-row';
    var isOwner = u.id === ownerId; var isMe = u.id === currentUser.id;
    var info = document.createElement('div');
    info.style.cssText = 'display:flex;align-items:center;gap:10px;flex:1;overflow:hidden;';
    info.innerHTML = '<div class="avatar-circle" style="width:32px;height:32px;font-size:13px;"></div><div style="flex:1;text-align:left;overflow:hidden;"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(u.name) + (isMe ? ' (вы)' : '') + '</div>' + (isOwner ? '<div style="font-size:11px;color:var(--accent);">создатель</div>' : '') + '</div>';
    info.onclick = function (e) { e.stopPropagation(); if (isMe) { closeGroupProfile(); openMyProfile(); } else openMemberProfile(u); };
    row.appendChild(info);
    renderAvatarIntoElement(info.querySelector('.avatar-circle'), u, !!u.isOnline);
    if (amOwner && !isMe && !isOwner) {
      var btn = document.createElement('button'); btn.className = 'member-menu-btn'; btn.innerText = '⋮';
      btn.onclick = function (e) { e.stopPropagation(); if (activeMemberDropdown && activeMemberDropdown.dataset.memberId === u.id) closeMemberDropdown(); else openMemberDropdown(row, u); };
      row.appendChild(btn);
    }
    c.appendChild(row);
  });
}
function openMemberDropdown(rowEl, member) {
  closeMemberDropdown();
  var dd = document.createElement('div'); dd.className = 'member-dropdown active'; dd.dataset.memberId = member.id;
  dd.innerHTML = '<button class="menu-item" data-action="profile">Профиль</button><button class="menu-item danger" data-action="kick">Выгнать</button>';
  dd.addEventListener('click', function (e) {
    e.stopPropagation(); var a = e.target.getAttribute('data-action');
    if (a === 'profile') { closeMemberDropdown(); openMemberProfile(member); }
    else if (a === 'kick') { closeMemberDropdown(); kickMember(member); }
  });
  rowEl.appendChild(dd); activeMemberDropdown = dd;
  setTimeout(function () { document.addEventListener('click', function h(ev) { if (activeMemberDropdown && !activeMemberDropdown.contains(ev.target)) { closeMemberDropdown(); document.removeEventListener('click', h); } }); }, 0);
}
function closeMemberDropdown() { if (activeMemberDropdown && activeMemberDropdown.parentNode) activeMemberDropdown.parentNode.removeChild(activeMemberDropdown); activeMemberDropdown = null; }
async function kickMember(member) {
  if (!activePeer || activePeer.type !== 'group') return;
  if (!confirm('Выгнать ' + member.name + '?')) return;
  try {
    var res = await fetch('/api/groups/kick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: activePeer.id, userId: currentUser.id, memberId: member.id }) });
    var data = await res.json();
    if (data.success) {
      await refreshGroupInfo();
      renderMembersList('group-members-list', activePeer.memberDetails || [], activePeer.ownerId);
      document.getElementById('group-profile-count').innerText = (activePeer.members ? activePeer.members.length : 0) + ' участников';
    } else alert(data.error || 'Ошибка');
  } catch (e) { alert('Ошибка'); }
}
async function deleteGroup() {
  if (!activePeer || activePeer.type !== 'group') return;
  if (!confirm('Удалить группу?')) return;
  if (!lockButton('delete-group-btn', 3000)) return;
  try {
    var res = await fetch('/api/groups/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: activePeer.id, userId: currentUser.id }) });
    var data = await res.json();
    if (data.success) { localGroups = localGroups.filter(function (g) { return g.id !== activePeer.id; }); saveGroups(); closeGroupProfile(); resetActiveChat(); loadDialogs(); }
    else alert(data.error || 'Ошибка');
  } catch (e) { alert('Ошибка'); }
}
function triggerEditGroupAvatarInput() { var i = document.getElementById('edit-group-avatar-input'); i.value = ''; i.click(); }
function handleEditGroupAvatarSelect(e) {
  var file = e.target.files[0]; if (!file) return;
  compressImage(file, 200, 0.85, function (c) { if (!c) return; editGroupDraftAvatar = c; fillAvatarBox(document.getElementById('group-profile-avatar'), editGroupDraftAvatar, '👥'); });
}
async function saveGroupChanges() {
  if (!activePeer || activePeer.type !== 'group') return;
  if (!lockButton('save-group-btn', 3000)) return;
  var name = document.getElementById('edit-group-name').value.trim();
  if (!name) { alert('Введите название'); return; }
  var body = { groupId: activePeer.id, userId: currentUser.id, name: name };
  if (editGroupDraftAvatar) body.avatar = editGroupDraftAvatar;
  try {
    var res = await fetch('/api/groups/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var data = await res.json();
    if (data.success) { for (var i = 0; i < localGroups.length; i++) if (localGroups[i].id === activePeer.id) localGroups[i] = data.group; saveGroups(); editGroupDraftAvatar = ''; await refreshGroupInfo(); openGroupProfile(); }
    else alert(data.error || 'Ошибка');
  } catch (e) { alert('Ошибка'); }
}
async function openAddMembers() {
  if (!activePeer || activePeer.type !== 'group') return;
  if (isModalOpen('add-members-modal')) return;
  var exclude = new Set(activePeer.members || []);
  var cached = [];
  for (var k in localKnownUsers) if (localKnownUsers.hasOwnProperty(k)) {
    var u = localKnownUsers[k];
    if (u.id && u.id !== currentUser.id && !exclude.has(u.id)) cached.push({ id: u.id, type: 'user', name: u.name, avatar: u.avatar || '', pubKey: u.pubKey || '', isOnline: false });
  }
  renderCheckList('add-members-contacts', cached, exclude);
  safeOpenModal('add-members-modal');
  try {
    var res = await fetch('/api/users/online?userId=' + encodeURIComponent(currentUser.id));
    var list = await res.json();
    list.forEach(function (x) { cacheUser(x); });
    renderCheckList('add-members-contacts', list, exclude);
  } catch (e) {}
}
function closeAddMembers() { safeCloseModal('add-members-modal'); }
async function submitAddMembers() {
  var members = getChecked('add-members-contacts');
  if (members.length === 0) { alert('Выберите'); return; }
  if (!lockButton('add-members-submit-btn', 3000)) return;
  try {
    var res = await fetch('/api/groups/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: activePeer.id, userId: currentUser.id, members: members }) });
    var data = await res.json();
    if (data.success) {
      for (var i = 0; i < localGroups.length; i++) if (localGroups[i].id === activePeer.id) localGroups[i] = data.group;
      saveGroups(); closeAddMembers(); await refreshGroupInfo();
      renderMembersList('group-members-list', activePeer.memberDetails || [], activePeer.ownerId);
      document.getElementById('group-profile-count').innerText = (activePeer.members ? activePeer.members.length : 0) + ' участников';
    } else alert(data.error || 'Ошибка');
  } catch (e) { alert('Ошибка'); }
}
async function leaveGroup() {
  closeChatDropdown();
  if (!activePeer || activePeer.type !== 'group') return;
  if (!confirm('Покинуть группу?')) return;
  try {
    await fetch('/api/groups/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: activePeer.id, userId: currentUser.id }) });
    localGroups = localGroups.filter(function (g) { return g.id !== activePeer.id; });
    saveGroups(); closeGroupProfile(); resetActiveChat(); loadDialogs();
  } catch (e) {}
}

/* ==================== ЗВОНКИ ==================== */
var callPollingTimer = null;
var currentCall = null;
var incomingCall = null;
var earlySignals = [];
var callRingTimeout = null;

function startCallPolling() { if (callPollingTimer) clearInterval(callPollingTimer); callPollingTimer = setInterval(pollCalls, 1000); pollCalls(); }
async function pollCalls() {
  if (!currentUser) return;
  try {
    var res = await fetch('/api/calls/poll?userId=' + encodeURIComponent(currentUser.id));
    var data = await res.json();
    if (!data.success) return;
    for (var i = 0; i < (data.signals || []).length; i++) { await handleSig(data.signals[i]); }
  } catch (e) {}
}
function showCallOverlay() {
  document.getElementById('call-overlay').classList.add('active');
  document.getElementById('incoming-call-overlay').classList.remove('active');
  document.getElementById('call-return-btn').style.display = 'none';
  document.getElementById('call-in-progress-bar').style.display = 'none';
}
function hideCallOverlay() { document.getElementById('call-overlay').classList.remove('active'); }
function minimizeCallOverlay() {
  hideCallOverlay();
  if (currentCall) {
    document.getElementById('call-return-btn').style.display = 'flex';
    document.getElementById('call-in-progress-bar').style.display = 'block';
    document.getElementById('call-in-progress-name').innerText = currentCall.peerName || 'собеседником';
  }
}
function restoreCallOverlay() {
  if (!currentCall) { document.getElementById('call-return-btn').style.display = 'none'; document.getElementById('call-in-progress-bar').style.display = 'none'; return; }
  document.getElementById('call-return-btn').style.display = 'none';
  document.getElementById('call-in-progress-bar').style.display = 'none';
  document.getElementById('call-overlay').classList.add('active');
  updateCallUI();
  if (currentCall.localStream) { var lv = document.getElementById('call-local-video'); if (!lv.srcObject) lv.srcObject = currentCall.localStream; lv.style.display = currentCall.camOn ? 'block' : 'none'; }
  if (currentCall.remoteStream) { var rv = document.getElementById('call-remote-video'); if (!rv.srcObject) rv.srcObject = currentCall.remoteStream; rv.style.display = currentCall.video ? 'block' : 'none'; }
}
function updateCallUI() {
  if (!currentCall) return;
  var a = document.getElementById('call-peer-avatar');
  if (currentCall.peerAvatar) a.innerHTML = '<img src="' + currentCall.peerAvatar + '">';
  else a.innerText = (currentCall.peerName || '?').charAt(0).toUpperCase();
  document.getElementById('call-peer-name').innerText = currentCall.peerName || 'Собеседник';
  var s = document.getElementById('call-status-text');
  if (currentCall.status === 'ringing') s.innerText = 'Вызов...';
  else if (currentCall.status === 'connecting') s.innerText = 'Соединение...';
  else if (currentCall.status === 'active') s.innerText = 'В звонке';
  document.getElementById('call-title').innerText = currentCall.video ? 'Видеозвонок' : 'Аудиозвонок';
  document.getElementById('ctrl-mic').classList.toggle('active', currentCall.micOn);
  document.getElementById('ctrl-cam').classList.toggle('active', currentCall.camOn);
  document.getElementById('ctrl-mic').innerText = currentCall.micOn ? '🎤' : '🔇';
}
async function startCall() {
  if (!activePeer || activePeer.type === 'group') { alert('Групповые звонки не поддерживаются'); return; }
  if (currentCall || incomingCall) { alert('Уже есть активный звонок'); return; }
  var video = confirm('Видеозвонок? OK - с камерой, Отмена - только аудио');
  try {
    var res = await fetch('/api/calls/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromId: currentUser.id, toId: activePeer.id, video: video }) });
    var data = await res.json();
    if (!data.success) { alert(data.error || 'Ошибка'); return; }
    currentCall = { callId: data.callId, role: 'caller', peerId: activePeer.id, peerName: activePeer.name, peerAvatar: activePeer.avatar || '', video: video, pc: null, localStream: null, remoteStream: null, startedAt: Date.now(), micOn: true, camOn: video, facing: 'user', status: 'ringing', pendingIce: [], offerSent: false };
    showCallOverlay(); updateCallUI();
    await setupLocalMedia(video);
    if (currentCall) await createPC();
    if (currentCall) {
      updateCallUI();
      callRingTimeout = setTimeout(function () {
        if (currentCall && currentCall.status === 'ringing') { alert('Собеседник не отвечает'); endCurrentCall(); }
      }, 60000);
    }
  } catch (e) { alert('Ошибка инициализации звонка'); }
}
async function acceptIncomingCall() {
  if (!incomingCall) return;
  var c = incomingCall; incomingCall = null;
  if (callRingTimeout) { clearTimeout(callRingTimeout); callRingTimeout = null; }
  document.getElementById('incoming-call-overlay').classList.remove('active');
  currentCall = { callId: c.callId, role: 'callee', peerId: c.fromId, peerName: c.fromName, peerAvatar: c.fromAvatar, video: !!c.video, pc: null, localStream: null, remoteStream: null, startedAt: Date.now(), micOn: true, camOn: !!c.video, facing: 'user', status: 'connecting', pendingIce: [], offerSent: false };
  showCallOverlay(); updateCallUI();
  try { await fetch('/api/calls/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: currentCall.callId, userId: currentUser.id, accept: true }) }); } catch (e) {}
  await setupLocalMedia(currentCall.video);
  if (currentCall) await createPC();
  var queued = earlySignals; earlySignals = [];
  for (var i = 0; i < queued.length; i++) { if (currentCall && queued[i].callId === currentCall.callId) await handleSig(queued[i]); }
  if (currentCall) updateCallUI();
}
async function rejectIncomingCall() {
  if (!incomingCall) return;
  var c = incomingCall; incomingCall = null;
  if (callRingTimeout) { clearTimeout(callRingTimeout); callRingTimeout = null; }
  document.getElementById('incoming-call-overlay').classList.remove('active');
  try { await fetch('/api/calls/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: c.callId, userId: currentUser.id, accept: false }) }); } catch (e) {}
}
async function setupLocalMedia(wantVideo) {
  if (!currentCall) return;
  var constraints = { audio: true, video: wantVideo ? { facingMode: currentCall.facing || 'user' } : false };
  try {
    var stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (!currentCall) { stream.getTracks().forEach(function(t){ t.stop(); }); return; }
    currentCall.localStream = stream;
    var lv = document.getElementById('call-local-video');
    lv.srcObject = stream; lv.style.display = wantVideo ? 'block' : 'none';
    document.getElementById('call-audio-screen').style.display = wantVideo ? 'none' : 'flex';
  } catch (e) {
    if (!currentCall) return;
    if (wantVideo) {
      try {
        var s2 = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (!currentCall) { s2.getTracks().forEach(function(t){ t.stop(); }); return; }
        currentCall.localStream = s2; currentCall.video = false; currentCall.camOn = false;
        document.getElementById('call-local-video').style.display = 'none';
        document.getElementById('call-audio-screen').style.display = 'flex';
      } catch (e2) { alert('Нет доступа к устройствам'); endCurrentCall(); }
    } else { alert('Нет доступа к микрофону'); endCurrentCall(); }
  }
}
async function createPC() {
  if (!currentCall) return;
  var pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle'
  });
  currentCall.pc = pc;
  if (currentCall.localStream) { currentCall.localStream.getTracks().forEach(function (t) { pc.addTrack(t, currentCall.localStream); }); }
  pc.ontrack = function (e) {
    if (!currentCall) return;
    if (e.streams && e.streams[0]) {
      currentCall.remoteStream = e.streams[0];
      var rv = document.getElementById('call-remote-video');
      rv.srcObject = e.streams[0];
      if (currentCall.video) { rv.style.display = 'block'; document.getElementById('call-audio-screen').style.display = 'none'; }
      else { rv.style.display = 'none'; document.getElementById('call-audio-screen').style.display = 'flex'; }
    }
  };
  pc.onicecandidate = function (e) { if (e.candidate && currentCall) sendSig('ice', { candidate: e.candidate }); };
  pc.onconnectionstatechange = function () {
    if (!currentCall) return;
    var st = pc.connectionState;
    if (st === 'connected') { currentCall.status = 'active'; updateCallUI(); }
    else if (st === 'failed') {
      setTimeout(function () { if (currentCall && currentCall.pc === pc && pc.connectionState === 'failed') { alert('Не удалось установить соединение'); endCurrentCall(); } }, 2000);
    }
  };
}
async function sendSig(type, payload) {
  if (!currentCall) return;
  try { await fetch('/api/calls/signal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: currentCall.callId, fromId: currentUser.id, toId: currentCall.peerId, type: type, payload: payload }) }); } catch (e) {}
}
async function handleSig(sig) {
  if (sig.type === 'offer-start') {
    if (currentCall || incomingCall) {
      try { await fetch('/api/calls/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: sig.callId, userId: currentUser.id, accept: false }) }); } catch (e) {}
      return;
    }
    incomingCall = { callId: sig.callId, fromId: sig.from, fromName: sig.payload.fromName || 'Пользователь', fromAvatar: sig.payload.fromAvatar || '', video: !!sig.payload.video };
    document.getElementById('incoming-avatar').innerHTML = incomingCall.fromAvatar ? '<img src="' + incomingCall.fromAvatar + '">' : (incomingCall.fromName.charAt(0).toUpperCase());
    document.getElementById('incoming-name').innerText = incomingCall.fromName;
    document.getElementById('incoming-status-text').innerText = incomingCall.video ? 'Входящий видеозвонок...' : 'Входящий звонок...';
    document.getElementById('incoming-call-overlay').classList.add('active');
    playNotificationSound();
    callRingTimeout = setTimeout(function () { if (incomingCall && incomingCall.callId === sig.callId) rejectIncomingCall(); }, 60000);
    return;
  }
  if (incomingCall && sig.callId === incomingCall.callId && !currentCall) {
    if (sig.type === 'offer' || sig.type === 'ice' || sig.type === 'answer') { earlySignals.push(sig); return; }
  }
  if (!currentCall || sig.callId !== currentCall.callId) return;
  if (sig.type === 'accepted') {
    if (callRingTimeout) { clearTimeout(callRingTimeout); callRingTimeout = null; }
    currentCall.status = 'connecting'; updateCallUI();
    if (currentCall.role === 'caller' && currentCall.pc && !currentCall.offerSent) {
      currentCall.offerSent = true;
      try {
        var offer = await currentCall.pc.createOffer();
        await currentCall.pc.setLocalDescription(offer);
        sendSig('offer', { sdp: offer });
      } catch (e) {}
    }
  }
  else if (sig.type === 'rejected' || sig.type === 'ended') {
    if (callRingTimeout) { clearTimeout(callRingTimeout); callRingTimeout = null; }
    endCurrentCall(true);
  }
  else if (sig.type === 'offer') {
    try {
      await currentCall.pc.setRemoteDescription(new RTCSessionDescription(sig.payload.sdp));
      var answer = await currentCall.pc.createAnswer();
      await currentCall.pc.setLocalDescription(answer);
      sendSig('answer', { sdp: answer });
      if (currentCall.pendingIce) {
        for (var i = 0; i < currentCall.pendingIce.length; i++) {
          try { await currentCall.pc.addIceCandidate(new RTCIceCandidate(currentCall.pendingIce[i])); } catch (e) {}
        }
        currentCall.pendingIce = [];
      }
    } catch (e) {}
  }
  else if (sig.type === 'answer') {
    try {
      await currentCall.pc.setRemoteDescription(new RTCSessionDescription(sig.payload.sdp));
      if (currentCall.pendingIce) {
        for (var j = 0; j < currentCall.pendingIce.length; j++) {
          try { await currentCall.pc.addIceCandidate(new RTCIceCandidate(currentCall.pendingIce[j])); } catch (e) {}
        }
        currentCall.pendingIce = [];
      }
    } catch (e) {}
  }
  else if (sig.type === 'ice') {
    try {
      if (!currentCall.pc || !currentCall.pc.remoteDescription) {
        currentCall.pendingIce = currentCall.pendingIce || [];
        currentCall.pendingIce.push(sig.payload.candidate);
      } else {
        await currentCall.pc.addIceCandidate(new RTCIceCandidate(sig.payload.candidate));
      }
    } catch (e) {}
  }
}
function toggleCallMic() {
  if (!currentCall || !currentCall.localStream) return;
  var audioTracks = currentCall.localStream.getAudioTracks();
  currentCall.micOn = !currentCall.micOn;
  audioTracks.forEach(function (t) { t.enabled = currentCall.micOn; });
  document.getElementById('ctrl-mic').classList.toggle('active', currentCall.micOn);
  document.getElementById('ctrl-mic').innerText = currentCall.micOn ? '🎤' : '🔇';
}
async function toggleCallCam() {
  if (!currentCall) return;
  if (!currentCall.camOn) {
    try {
      var vs = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentCall.facing || 'user' } });
      if (!currentCall) { vs.getTracks().forEach(function(t){ t.stop(); }); return; }
      currentCall.localStream = currentCall.localStream || new MediaStream();
      vs.getVideoTracks().forEach(function (t) {
        currentCall.localStream.addTrack(t);
        if (currentCall.pc) { var sender = currentCall.pc.getSenders().find(function (s) { return s.track && s.track.kind === 'video'; }); if (sender) sender.replaceTrack(t); else currentCall.pc.addTrack(t, currentCall.localStream); }
      });
      currentCall.camOn = true; currentCall.video = true;
      document.getElementById('call-local-video').srcObject = currentCall.localStream;
      document.getElementById('call-local-video').style.display = 'block';
      document.getElementById('call-audio-screen').style.display = currentCall.remoteStream ? 'none' : 'flex';
      document.getElementById('ctrl-cam').classList.add('active');
    } catch (e) { alert('Камера недоступна'); }
  } else {
    currentCall.localStream.getVideoTracks().forEach(function (t) { t.stop(); currentCall.localStream.removeTrack(t); });
    currentCall.camOn = false;
    document.getElementById('call-local-video').style.display = 'none';
    document.getElementById('ctrl-cam').classList.remove('active');
  }
}
async function flipCallCamera() {
  if (!currentCall || !currentCall.camOn) return;
  currentCall.facing = currentCall.facing === 'user' ? 'environment' : 'user';
  try {
    var vs = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentCall.facing } });
    if (!currentCall) { vs.getTracks().forEach(function(t){ t.stop(); }); return; }
    var newTrack = vs.getVideoTracks()[0];
    currentCall.localStream.getVideoTracks().forEach(function (t) { t.stop(); currentCall.localStream.removeTrack(t); });
    currentCall.localStream.addTrack(newTrack);
    var sender = currentCall.pc.getSenders().find(function (s) { return s.track && s.track.kind === 'video'; });
    if (sender) await sender.replaceTrack(newTrack);
    document.getElementById('call-local-video').srcObject = currentCall.localStream;
  } catch (e) { currentCall.facing = currentCall.facing === 'user' ? 'environment' : 'user'; }
}
async function endCurrentCall(silent) {
  var c = currentCall; currentCall = null;
  if (callRingTimeout) { clearTimeout(callRingTimeout); callRingTimeout = null; }
  hideCallOverlay();
  document.getElementById('call-return-btn').style.display = 'none';
  document.getElementById('call-in-progress-bar').style.display = 'none';
  if (!c) return;
  try { await fetch('/api/calls/end', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: c.callId, userId: currentUser.id }) }); } catch (e) {}
  try { if (c.pc) c.pc.close(); } catch (e) {}
  try { if (c.localStream) c.localStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
  var rv = document.getElementById('call-remote-video'); rv.srcObject = null; rv.style.display = 'none';
  var lv = document.getElementById('call-local-video'); lv.srcObject = null; lv.style.display = 'none';
  document.getElementById('call-audio-screen').style.display = 'flex';
  document.getElementById('ctrl-mic').classList.add('active');
  document.getElementById('ctrl-mic').innerText = '🎤';
  document.getElementById('ctrl-cam').classList.remove('active');
}

/* ==================== ИНИЦИАЛИЗАЦИЯ ==================== */
window.addEventListener('DOMContentLoaded', async function () {
  updateThemeIcon(savedTheme);
  document.querySelectorAll('.modal-overlay').forEach(function (ov) { ov.addEventListener('click', function (e) { if (e.target === ov) ov.classList.remove('active'); }); });
  loadDeletedIds();
  await initMyKeyPair();
  try { currentUser = JSON.parse(localStorage.getItem('messenger_user') || 'null'); } catch (e) { currentUser = null; }
  try { localKnownUsers = JSON.parse(localStorage.getItem('messenger_known_users') || '{}'); } catch (e) { localKnownUsers = {}; }
  try { localMessagesCache = JSON.parse(localStorage.getItem('messenger_messages_cache') || '[]'); } catch (e) { localMessagesCache = []; }
  try { mutedPeers = JSON.parse(localStorage.getItem('messenger_muted_peers') || '[]'); } catch (e) { mutedPeers = []; }
  try { localGroups = JSON.parse(localStorage.getItem('messenger_groups') || '[]'); } catch (e) { localGroups = []; }
  localMessagesCache = localMessagesCache.filter(function (m) { return !deletedIds[m.id] && !m.isDeleted; });
  saveCache();
  updateVersionInfo();
  await checkServerHealth();
  if (!currentUser) { setInterval(async function () { await checkServerHealth(); updateLoadingScreen(); }, 3000); }
  if (currentUser) {
    if (!currentUser.id) currentUser.id = getOrCreateDeviceId();
    if (myKeyPair && currentUser) currentUser.pubKey = myKeyPair.pubKeyB64;
    startApp();
  }
  else updateLoadingScreen();
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
