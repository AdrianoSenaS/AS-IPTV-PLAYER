/**
 * AS-IPTV Server
 *
 * APIs:
 * - realtime presence/session lock (socket.io)
 * - auth/account (register/login/profile)
 * - subscription plan state
 * - cloud sync prefs + backups
 * - admin dashboard endpoints
 *
 * Persistence: SQLite via better-sqlite3
 */

'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const httpServer = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'as-iptv-rt-secret-change-in-prod';
const ADMIN_BOOTSTRAP_TOKEN = process.env.ADMIN_TOKEN || 'as-admin-123';
const PORT = Number(process.env.PORT || 3001);

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'as-iptv.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

const PLAN_IDS = ['free', 'plus', 'pro', 'ultra', 'lifetime'];

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

// sessions[accountKey][profileId] = { ... }
const sessions = {};

// blockedContent[accountKey] = Set<contentId>
const blockedContent = {};

// pushTokens[accountKey][profileId] = expoToken
const pushTokens = {};

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

function safeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function makeId(prefix) {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

function normalizePlanId(value) {
  return PLAN_IDS.includes(value) ? value : 'free';
}

function normalizePlanStatus(value) {
  return value === 'active' || value === 'expired' || value === 'grace' ? value : 'unknown';
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ---- SQLite setup -----------------------------------------------------------
let _db = null;

function getDb() {
  if (_db) return _db;
  ensureDataDir();
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      avatar_uri    TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      last_login_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_plans (
      user_id        TEXT PRIMARY KEY,
      plan_id        TEXT NOT NULL DEFAULT 'free',
      status         TEXT NOT NULL DEFAULT 'unknown',
      payment_due_at TEXT NOT NULL DEFAULT '',
      payment_hour   TEXT NOT NULL DEFAULT '',
      payment_amount TEXT NOT NULL DEFAULT '',
      enabled        INTEGER NOT NULL DEFAULT 1,
      updated_at     TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_sync_prefs (
      user_id           TEXT PRIMARY KEY,
      consent_enabled   INTEGER NOT NULL DEFAULT 0,
      auto_sync_enabled INTEGER NOT NULL DEFAULT 0,
      last_sync_at      TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_backups (
      user_id    TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT '',
      data       TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

// ---- DB helpers -------------------------------------------------------------
function dbGetUserById(userId) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function dbGetUserByEmail(email) {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function dbGetPlan(userId) {
  return getDb().prepare('SELECT * FROM user_plans WHERE user_id = ?').get(userId);
}

function dbGetSyncPrefs(userId) {
  return getDb().prepare('SELECT * FROM user_sync_prefs WHERE user_id = ?').get(userId);
}

function dbGetBackup(userId) {
  return getDb().prepare('SELECT * FROM user_backups WHERE user_id = ?').get(userId);
}

function dbInsertUser(user) {
  getDb().prepare(`
    INSERT INTO users (id, name, email, avatar_uri, password_hash, created_at, updated_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user.id, user.name, user.email, user.avatarUri, user.passwordHash, user.createdAt, user.updatedAt, user.lastLoginAt);
}

function dbInsertDefaultPlan(userId) {
  getDb().prepare(`
    INSERT INTO user_plans (user_id, plan_id, status, payment_due_at, payment_hour, payment_amount, enabled, updated_at)
    VALUES (?, 'free', 'unknown', '', '', '', 1, ?)
  `).run(userId, nowIso());
}

function dbInsertDefaultSyncPrefs(userId) {
  getDb().prepare(`
    INSERT INTO user_sync_prefs (user_id, consent_enabled, auto_sync_enabled, last_sync_at)
    VALUES (?, 0, 0, '')
  `).run(userId);
}

function dbInsertEmptyBackup(userId) {
  getDb().prepare(`
    INSERT INTO user_backups (user_id, created_at, data) VALUES (?, '', '')
  `).run(userId);
}

function dbUpsertPlan(userId, plan) {
  getDb().prepare(`
    INSERT INTO user_plans (user_id, plan_id, status, payment_due_at, payment_hour, payment_amount, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      plan_id = excluded.plan_id,
      status = excluded.status,
      payment_due_at = excluded.payment_due_at,
      payment_hour = excluded.payment_hour,
      payment_amount = excluded.payment_amount,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(userId, plan.planId, plan.status, plan.paymentDueAt, plan.paymentHour, plan.paymentAmount, plan.enabled ? 1 : 0, plan.updatedAt);
}

function dbUpsertSyncPrefs(userId, prefs) {
  getDb().prepare(`
    INSERT INTO user_sync_prefs (user_id, consent_enabled, auto_sync_enabled, last_sync_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      consent_enabled = excluded.consent_enabled,
      auto_sync_enabled = excluded.auto_sync_enabled,
      last_sync_at = excluded.last_sync_at
  `).run(userId, prefs.consentEnabled ? 1 : 0, prefs.autoSyncEnabled ? 1 : 0, prefs.lastSyncAt || '');
}

function dbUpsertBackup(userId, createdAt, data) {
  getDb().prepare(`
    INSERT INTO user_backups (user_id, created_at, data)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      created_at = excluded.created_at,
      data = excluded.data
  `).run(userId, createdAt, typeof data === 'string' ? data : JSON.stringify(data));
}

function planRowToObject(row) {
  if (!row) {
    return { planId: 'free', status: 'unknown', paymentDueAt: '', paymentHour: '', paymentAmount: '', enabled: true, updatedAt: nowIso() };
  }
  return {
    planId: row.plan_id,
    status: row.status,
    paymentDueAt: row.payment_due_at,
    paymentHour: row.payment_hour,
    paymentAmount: row.payment_amount,
    enabled: row.enabled !== 0,
    updatedAt: row.updated_at,
  };
}

function syncPrefsRowToObject(row) {
  if (!row) {
    return { consentEnabled: false, autoSyncEnabled: false, lastSyncAt: '' };
  }
  return {
    consentEnabled: row.consent_enabled !== 0,
    autoSyncEnabled: row.auto_sync_enabled !== 0,
    lastSyncAt: row.last_sync_at || '',
  };
}

function toPublicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatarUri: row.avatar_uri || '',
    provider: 'email',
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || row.created_at,
  };
}

function buildUserToken(user) {
  return jwt.sign(
    { kind: 'user', userId: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function buildAdminToken() {
  return jwt.sign(
    { kind: 'admin', scope: 'all' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function accountKey(username, serverUrl) {
  return `${username}@${String(serverUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
}

function presenceSnapshot(key) {
  const group = sessions[key] || {};
  return Object.entries(group).map(([profileId, s]) => ({
    profileId,
    profileName: s.profileName,
    kidsMode: s.kidsMode,
    online: s.online,
    watching: s.watching,
    lastSeen: s.lastSeen,
  }));
}

function getBlockedList(key) {
  return [...(blockedContent[key] || [])];
}

function rtAuthMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (!payload || payload.kind) {
      return res.status(401).json({ error: 'Token realtime invalido' });
    }
    req.auth = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

function userAuthMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (!payload || payload.kind !== 'user' || !payload.userId) {
      return res.status(401).json({ error: 'Token de usuario invalido' });
    }
    req.userAuth = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

function adminAuthMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (!payload || payload.kind !== 'admin') {
      return res.status(401).json({ error: 'Token admin invalido' });
    }
    req.adminAuth = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

app.get('/health', (_req, res) => {
  return res.json({ ok: true, ts: nowIso() });
});

// ---- Auth/user APIs ---------------------------------------------------------
app.post('/api/auth/register', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = safeEmail(req.body?.email || '');
  const password = String(req.body?.password || '').trim();

  if (!name) return res.status(400).json({ error: 'Informe o nome.' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Informe um e-mail valido.' });
  if (password.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });

  if (dbGetUserByEmail(email)) return res.status(409).json({ error: 'Este e-mail ja esta cadastrado.' });

  const now = nowIso();
  const userId = makeId('user');

  getDb().transaction(() => {
    dbInsertUser({ id: userId, name, email, avatarUri: '', passwordHash: hashPassword(password), createdAt: now, updatedAt: now, lastLoginAt: now });
    dbInsertDefaultPlan(userId);
    dbInsertDefaultSyncPrefs(userId);
    dbInsertEmptyBackup(userId);
  })();

  const user = dbGetUserById(userId);
  return res.json({ token: buildUserToken(user), user: toPublicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const email = safeEmail(req.body?.email || '');
  const password = String(req.body?.password || '').trim();

  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Informe um e-mail valido.' });
  if (!password) return res.status(400).json({ error: 'Informe a senha.' });

  const user = dbGetUserByEmail(email);
  if (!user || user.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Credenciais invalidas.' });
  }

  const now = nowIso();
  getDb().prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, user.id);

  return res.json({ token: buildUserToken(user), user: toPublicUser(user) });
});

app.get('/api/auth/me', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });
  return res.json({ user: toPublicUser(user) });
});

app.patch('/api/auth/me', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const nextName = String(req.body?.name || '').trim();
  const nextEmail = safeEmail(req.body?.email || '');
  const nextAvatarUri = String(req.body?.avatarUri || '').trim();

  if (!nextName) return res.status(400).json({ error: 'Informe o nome.' });
  if (!nextEmail || !nextEmail.includes('@')) return res.status(400).json({ error: 'Informe um e-mail valido.' });

  if (nextEmail !== user.email) {
    const emailUsed = dbGetUserByEmail(nextEmail);
    if (emailUsed && emailUsed.id !== user.id) {
      return res.status(409).json({ error: 'Ja existe conta com este e-mail.' });
    }
  }

  const now = nowIso();
  getDb().prepare('UPDATE users SET name = ?, email = ?, avatar_uri = ?, updated_at = ? WHERE id = ?')
    .run(nextName, nextEmail, nextAvatarUri, now, user.id);

  const updated = dbGetUserById(user.id);
  return res.json({ user: toPublicUser(updated), token: buildUserToken(updated) });
});

app.post('/api/auth/logout', userAuthMiddleware, (_req, res) => {
  return res.json({ ok: true });
});

// ---- Subscription APIs ------------------------------------------------------
app.get('/api/subscription/plans', (_req, res) => {
  return res.json({ plans: PLAN_IDS });
});

app.get('/api/subscription/me', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const raw = planRowToObject(dbGetPlan(user.id));
  const effectivePlanId = raw.enabled === false ? 'free' : normalizePlanId(raw.planId);
  const effectiveStatus = raw.enabled === false ? 'expired' : normalizePlanStatus(raw.status);

  return res.json({
    planState: {
      planId: effectivePlanId,
      status: effectiveStatus,
      paymentDueAt: raw.paymentDueAt || '',
      paymentHour: raw.paymentHour || '',
      paymentAmount: raw.paymentAmount || '',
      enabled: raw.enabled !== false,
      updatedAt: raw.updatedAt || nowIso(),
      checkedAt: nowIso(),
    },
  });
});

app.put('/api/subscription/me', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const plan = {
    planId: normalizePlanId(req.body?.planId),
    status: normalizePlanStatus(req.body?.status || 'active'),
    paymentDueAt: String(req.body?.paymentDueAt || ''),
    paymentHour: String(req.body?.paymentHour || ''),
    paymentAmount: String(req.body?.paymentAmount || ''),
    enabled: req.body?.enabled !== false,
    updatedAt: nowIso(),
  };
  dbUpsertPlan(user.id, plan);
  getDb().prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(nowIso(), user.id);

  return res.json({ planState: { ...plan, checkedAt: nowIso() } });
});

// ---- Cloud sync APIs --------------------------------------------------------
app.get('/api/sync/prefs', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  return res.json({ prefs: syncPrefsRowToObject(dbGetSyncPrefs(user.id)) });
});

app.put('/api/sync/prefs', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const current = syncPrefsRowToObject(dbGetSyncPrefs(user.id));
  const next = {
    consentEnabled: req.body?.consentEnabled ?? current.consentEnabled,
    autoSyncEnabled: req.body?.autoSyncEnabled ?? current.autoSyncEnabled,
    lastSyncAt: typeof req.body?.lastSyncAt === 'string' ? req.body.lastSyncAt : current.lastSyncAt,
  };
  dbUpsertSyncPrefs(user.id, next);
  getDb().prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(nowIso(), user.id);

  return res.json({ prefs: next });
});

app.post('/api/sync/backup', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const data = req.body?.data;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Payload de backup invalido.' });
  }

  const createdAt = nowIso();
  dbUpsertBackup(user.id, createdAt, data);
  const current = syncPrefsRowToObject(dbGetSyncPrefs(user.id));
  dbUpsertSyncPrefs(user.id, { ...current, lastSyncAt: createdAt });
  getDb().prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(createdAt, user.id);

  return res.json({ ok: true, createdAt });
});

app.get('/api/sync/backup/latest', userAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.userAuth.userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const row = dbGetBackup(user.id);
  if (!row || !row.data) {
    return res.status(404).json({ error: 'Nenhum backup encontrado.' });
  }

  let parsedData;
  try { parsedData = JSON.parse(row.data); } catch { return res.status(500).json({ error: 'Backup corrompido.' }); }

  return res.json({ backup: { createdAt: row.created_at, data: parsedData } });
});

// ---- Admin APIs -------------------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token || token !== ADMIN_BOOTSTRAP_TOKEN) {
    return res.status(401).json({ error: 'Token admin invalido.' });
  }
  return res.json({ token: buildAdminToken() });
});

app.get('/api/admin/users', adminAuthMiddleware, (_req, res) => {
  const users = getDb().prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  const result = users.map((u) => {
    const plan = planRowToObject(dbGetPlan(u.id));
    const sync = syncPrefsRowToObject(dbGetSyncPrefs(u.id));
    const backup = dbGetBackup(u.id);
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at || '',
      plan: {
        planId: normalizePlanId(plan.planId),
        status: normalizePlanStatus(plan.status),
        enabled: plan.enabled !== false,
        paymentDueAt: plan.paymentDueAt || '',
        paymentAmount: plan.paymentAmount || '',
        updatedAt: plan.updatedAt || '',
      },
      sync: {
        lastSyncAt: sync.lastSyncAt || '',
        hasBackup: !!(backup && backup.data),
        backupAt: backup?.created_at || '',
      },
    };
  });
  return res.json({ users: result });
});

app.patch('/api/admin/users/:id/plan', adminAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const current = planRowToObject(dbGetPlan(user.id));
  const plan = {
    planId: normalizePlanId(req.body?.planId || current.planId),
    status: normalizePlanStatus(req.body?.status || current.status || 'unknown'),
    paymentDueAt: String(req.body?.paymentDueAt ?? current.paymentDueAt ?? ''),
    paymentHour: String(req.body?.paymentHour ?? current.paymentHour ?? ''),
    paymentAmount: String(req.body?.paymentAmount ?? current.paymentAmount ?? ''),
    enabled: req.body?.enabled !== false,
    updatedAt: nowIso(),
  };
  dbUpsertPlan(user.id, plan);
  getDb().prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(nowIso(), user.id);

  return res.json({ ok: true, plan });
});

app.patch('/api/admin/users/:id/active', adminAuthMiddleware, (req, res) => {
  const user = dbGetUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  const active = req.body?.active !== false;
  const current = planRowToObject(dbGetPlan(user.id));
  const plan = {
    ...current,
    enabled: active,
    status: active ? normalizePlanStatus(current.status) : 'expired',
    updatedAt: nowIso(),
  };
  dbUpsertPlan(user.id, plan);
  getDb().prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(nowIso(), user.id);

  return res.json({ ok: true, plan });
});

// ---- Realtime APIs ----------------------------------------------------------
app.post('/api/session/start', (req, res) => {
  const { username, serverUrl, profileId, profileName, kidsMode, deviceId } = req.body;
  if (!username || !serverUrl || !profileId || !deviceId) {
    return res.status(400).json({ error: 'Campos obrigatorios faltando' });
  }

  const key = accountKey(username, serverUrl);
  if (!sessions[key]) sessions[key] = {};

  const existing = sessions[key][profileId];
  const isStale = !existing || nowMs() - existing.lastSeen > 45000;

  if (existing && existing.deviceId !== deviceId && !isStale && existing.online) {
    return res.status(409).json({
      error: 'SESSION_LOCKED',
      message: `O perfil "${profileName}" ja esta ativo em outro dispositivo.`,
    });
  }

  const token = jwt.sign(
    { key, profileId, profileName, kidsMode: !!kidsMode, deviceId },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  sessions[key][profileId] = {
    deviceId,
    socketId: null,
    online: false,
    watching: null,
    profileName,
    kidsMode: !!kidsMode,
    lastSeen: nowMs(),
  };

  return res.json({ token });
});

app.post('/api/session/end', rtAuthMiddleware, (req, res) => {
  const { key, profileId, deviceId } = req.auth;
  const sess = sessions[key]?.[profileId];
  if (sess && sess.deviceId === deviceId) {
    delete sessions[key][profileId];
    io.to(key).emit('presence_update', presenceSnapshot(key));
  }
  return res.json({ ok: true });
});

app.get('/api/presence', rtAuthMiddleware, (req, res) => {
  return res.json({ profiles: presenceSnapshot(req.auth.key) });
});

app.post('/api/parental/block', rtAuthMiddleware, (req, res) => {
  const { key } = req.auth;
  const { targetProfileId, contentId, contentTitle } = req.body;
  if (!contentId) return res.status(400).json({ error: 'contentId obrigatorio' });

  if (!blockedContent[key]) blockedContent[key] = new Set();
  blockedContent[key].add(contentId);

  const targetSess = sessions[key]?.[targetProfileId];
  if (targetSess?.socketId) {
    io.to(targetSess.socketId).emit('content_blocked', { contentId, contentTitle });
  }

  io.to(`parents:${key}`).emit('parental_block_applied', {
    contentId,
    contentTitle,
    targetProfileId,
    blockedAt: nowIso(),
  });

  return res.json({ ok: true });
});

app.post('/api/parental/unblock', rtAuthMiddleware, (req, res) => {
  const { key } = req.auth;
  const { contentId } = req.body;
  blockedContent[key]?.delete(contentId);
  io.to(key).emit('parental_blocks_updated', getBlockedList(key));
  return res.json({ ok: true });
});

app.get('/api/parental/blocks', rtAuthMiddleware, (req, res) => {
  return res.json({ blocked: getBlockedList(req.auth.key) });
});

app.post('/api/push-token', rtAuthMiddleware, (req, res) => {
  const { key, profileId } = req.auth;
  const { token } = req.body;
  if (token) {
    if (!pushTokens[key]) pushTokens[key] = {};
    pushTokens[key][profileId] = token;
  }
  return res.json({ ok: true });
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 30000,
  pingInterval: 15000,
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('TOKEN_MISSING'));
  try {
    socket.auth = jwt.verify(token, JWT_SECRET);
    if (!socket.auth || socket.auth.kind) {
      return next(new Error('TOKEN_INVALID'));
    }
    return next();
  } catch {
    return next(new Error('TOKEN_INVALID'));
  }
});

io.on('connection', (socket) => {
  const { key, profileId, profileName, kidsMode, deviceId } = socket.auth;

  if (!sessions[key]) sessions[key] = {};
  if (!sessions[key][profileId]) {
    sessions[key][profileId] = {
      deviceId,
      socketId: null,
      online: false,
      watching: null,
      profileName,
      kidsMode,
      lastSeen: nowMs(),
    };
  }

  const sess = sessions[key][profileId];

  if (sess.deviceId !== deviceId) {
    socket.emit('session_stolen', {
      message: `Sessao encerrada: perfil "${profileName}" entrou em outro dispositivo.`,
    });
    socket.disconnect(true);
    return;
  }

  sess.socketId = socket.id;
  sess.online = true;
  sess.lastSeen = nowMs();

  socket.join(key);
  if (!kidsMode) {
    socket.join(`parents:${key}`);
  }

  socket.emit('presence_update', presenceSnapshot(key));
  socket.emit('parental_blocks_updated', getBlockedList(key));
  io.to(key).emit('presence_update', presenceSnapshot(key));

  if (kidsMode) {
    io.to(`parents:${key}`).emit('child_entered', {
      profileId,
      profileName,
      enteredAt: nowIso(),
    });
  }

  socket.on('watching', ({ contentId, contentTitle, contentType }) => {
    sess.watching = { contentId, contentTitle, contentType, since: nowMs() };
    sess.lastSeen = nowMs();
    io.to(key).emit('presence_update', presenceSnapshot(key));
    if (kidsMode) {
      io.to(`parents:${key}`).emit('child_watching', {
        profileId,
        profileName,
        contentId,
        contentTitle,
        contentType,
        since: sess.watching.since,
      });
    }
  });

  socket.on('stopped_watching', () => {
    sess.watching = null;
    sess.lastSeen = nowMs();
    io.to(key).emit('presence_update', presenceSnapshot(key));
  });

  socket.on('heartbeat', () => {
    sess.lastSeen = nowMs();
    sess.online = true;
  });

  socket.on('disconnect', () => {
    sess.online = false;
    sess.socketId = null;
    sess.watching = null;
    sess.lastSeen = nowMs();
    io.to(key).emit('presence_update', presenceSnapshot(key));
    if (kidsMode) {
      io.to(`parents:${key}`).emit('child_offline', {
        profileId,
        profileName,
        offlineAt: nowIso(),
      });
    }
  });
});

setInterval(() => {
  const staleThreshold = 90000;
  for (const key of Object.keys(sessions)) {
    for (const [profileId, sess] of Object.entries(sessions[key])) {
      if (!sess.online && nowMs() - sess.lastSeen > staleThreshold) {
        delete sessions[key][profileId];
      }
    }
    if (Object.keys(sessions[key]).length === 0) {
      delete sessions[key];
    }
  }
}, 120000);

httpServer.listen(PORT, () => {
  getDb(); // initialize SQLite on startup
  console.log(`AS-IPTV server rodando na porta ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Admin:  http://localhost:${PORT}/admin`);
  console.log(`DB:     ${DB_PATH}`);
});
