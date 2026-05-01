import { getDbValue, removeDbValue, setDbValue } from '@/services/local-db';
import * as FileSystem from 'expo-file-system/legacy';

import { apiRequest } from '@/services/app-server';

const SESSION_KEY = 'cloudSync.session.v2';
const LOCAL_USERS_KEY = 'cloudSync.localUsers.v2';
const CLOUD_PREFS_KEY = 'cloudSync.prefs.v1';
const BACKUP_DIR = `${FileSystem.documentDirectory}cloud-backups/`;
const LAST_BACKUP_FILE = `${BACKUP_DIR}last-backup.json`;

let localUsersCache: Record<string, LocalUserRecord> | null = null;
let sessionCache: UserSession | null | undefined;
let prefsCache: CloudSyncPrefs | null = null;

type LocalUserRecord = {
  id: string;
  name: string;
  email: string;
  password: string;
  avatarUri?: string;
  createdAt: string;
  updatedAt: string;
};

export type UserAccount = {
  id: string;
  name: string;
  email: string;
  avatarUri?: string;
  provider: 'email';
  createdAt: string;
  lastLoginAt: string;
};

export type UserSession = {
  token: string;
  user: UserAccount;
};

export type CloudSyncPrefs = {
  consentEnabled: boolean;
  autoSyncEnabled: boolean;
  lastSyncAt: string;
};

type BackupPayload = {
  version: 1;
  createdAt: string;
  userId: string;
  data: Record<string, string | null>;
};

const BACKUP_KEYS = [
  'accountSettings.v1',
  'user_lists_v1',
  'movieProgressMap',
  'seriesProgressMap',
  'taste.watchSignals.v1',
  'downloaded_library_v1',
  'name',
  'url',
  'username',
  'password',
  'userInfo',
  'serverInfo',
  'demoModeEnabled',
] as const;

const nowIso = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const safeEmail = (value: string) => value.trim().toLowerCase();

async function ensureDir() {
  const info = await FileSystem.getInfoAsync(BACKUP_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(BACKUP_DIR, { intermediates: true });
  }
}

async function loadLocalUsers(): Promise<Record<string, LocalUserRecord>> {
  if (localUsersCache) {
    return localUsersCache;
  }

  try {
    const parsed = await getDbValue<Record<string, LocalUserRecord>>(LOCAL_USERS_KEY);
    localUsersCache = parsed && typeof parsed === 'object' ? parsed : {};
    return localUsersCache;
  } catch {
    localUsersCache = {};
    return {};
  }
}

async function saveLocalUsers(next: Record<string, LocalUserRecord>) {
  await setDbValue(LOCAL_USERS_KEY, next);
  localUsersCache = next;
}

function normalizeSession(input: any): UserSession {
  return {
    token: String(input?.token || ''),
    user: {
      id: String(input?.user?.id || ''),
      name: String(input?.user?.name || ''),
      email: String(input?.user?.email || ''),
      avatarUri: String(input?.user?.avatarUri || ''),
      provider: 'email',
      createdAt: String(input?.user?.createdAt || nowIso()),
      lastLoginAt: String(input?.user?.lastLoginAt || nowIso()),
    },
  };
}

async function saveUserSession(session: UserSession) {
  await setDbValue(SESSION_KEY, session);
  sessionCache = session;
  return session;
}

export async function loadUserSession(): Promise<UserSession | null> {
  if (sessionCache !== undefined) {
    return sessionCache;
  }

  try {
    const parsed = await getDbValue<UserSession>(SESSION_KEY);
    if (!parsed?.token || !parsed?.user?.id || !parsed?.user?.email) {
      sessionCache = null;
      return null;
    }
    sessionCache = parsed as UserSession;
    return sessionCache;
  } catch {
    sessionCache = null;
    return null;
  }
}

export async function clearUserSession() {
  const current = await loadUserSession();
  try {
    if (current?.token) {
      await apiRequest('/api/auth/logout', {
        method: 'POST',
        token: current.token,
        timeoutMs: 5000,
      });
    }
  } catch {
    // Logout remoto e opcional; sessao local ainda e encerrada.
  }

  await removeDbValue(SESSION_KEY);
  sessionCache = null;
}

export async function createUserWithEmail(input: { name: string; email: string; password: string }) {
  const name = (input.name || '').trim();
  const email = safeEmail(input.email || '');
  const password = (input.password || '').trim();

  if (!name) throw new Error('Informe o nome.');
  if (!email || !email.includes('@')) throw new Error('Informe um e-mail valido.');
  if (password.length < 6) throw new Error('A senha deve ter pelo menos 6 caracteres.');

  try {
    const remote = await apiRequest<{ token: string; user: UserAccount }>('/api/auth/register', {
      method: 'POST',
      body: { name, email, password },
    });
    return saveUserSession(normalizeSession(remote));
  } catch (error: any) {
    // fallback local em caso de servidor offline
    const message = String(error?.message || '');
    if (!message || !/Erro|Network|fetch|timeout|Failed/i.test(message)) {
      throw error;
    }

    const users = await loadLocalUsers();
    if (users[email]) {
      throw new Error('Este e-mail ja esta cadastrado.');
    }

    const now = nowIso();
    users[email] = {
      id: uid('user'),
      name,
      email,
      password,
      avatarUri: '',
      createdAt: now,
      updatedAt: now,
    };
    await saveLocalUsers(users);

    const session: UserSession = {
      token: uid('token'),
      user: {
        id: users[email].id,
        name,
        email,
        avatarUri: '',
        provider: 'email',
        createdAt: now,
        lastLoginAt: now,
      },
    };
    return saveUserSession(session);
  }
}

export async function signInWithEmail(input: { email: string; password: string }) {
  const email = safeEmail(input.email || '');
  const password = (input.password || '').trim();

  if (!email || !email.includes('@')) throw new Error('Informe um e-mail valido.');
  if (!password) throw new Error('Informe a senha.');

  try {
    const remote = await apiRequest<{ token: string; user: UserAccount }>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    return saveUserSession(normalizeSession(remote));
  } catch (error: any) {
    const message = String(error?.message || '');
    if (!message || !/Erro|Network|fetch|timeout|Failed/i.test(message)) {
      throw error;
    }

    const users = await loadLocalUsers();
    const found = users[email];
    if (!found || found.password !== password) {
      throw new Error('Credenciais invalidas.');
    }

    const session: UserSession = {
      token: uid('token'),
      user: {
        id: found.id,
        name: found.name,
        email: found.email,
        avatarUri: found.avatarUri || '',
        provider: 'email',
        createdAt: found.createdAt,
        lastLoginAt: nowIso(),
      },
    };

    return saveUserSession(session);
  }
}

export async function updateCurrentUserProfile(input: {
  name: string;
  email: string;
  avatarUri?: string;
}) {
  const session = await loadUserSession();
  if (!session) {
    throw new Error('Faca login para editar o perfil.');
  }

  const name = (input.name || '').trim();
  const email = safeEmail(input.email || '');
  const avatarUri = (input.avatarUri || '').trim();

  if (!name) throw new Error('Informe o nome.');
  if (!email || !email.includes('@')) throw new Error('Informe um e-mail valido.');

  try {
    const remote = await apiRequest<{ token: string; user: UserAccount }>('/api/auth/me', {
      method: 'PATCH',
      token: session.token,
      body: { name, email, avatarUri },
    });
    return saveUserSession(normalizeSession(remote));
  } catch (error: any) {
    const message = String(error?.message || '');
    if (!message || !/Erro|Network|fetch|timeout|Failed/i.test(message)) {
      throw error;
    }

    const users = await loadLocalUsers();
    const currentEmail = safeEmail(session.user.email);
    const currentRecord = users[currentEmail];
    if (!currentRecord) {
      throw new Error('Usuario nao encontrado no armazenamento local.');
    }

    if (email !== currentEmail && users[email]) {
      throw new Error('Ja existe conta com este e-mail.');
    }

    const updated: LocalUserRecord = {
      ...currentRecord,
      name,
      email,
      avatarUri,
      updatedAt: nowIso(),
    };

    if (email !== currentEmail) {
      delete users[currentEmail];
    }
    users[email] = updated;
    await saveLocalUsers(users);

    const nextSession: UserSession = {
      ...session,
      user: {
        ...session.user,
        name,
        email,
        avatarUri,
        lastLoginAt: nowIso(),
      },
    };

    return saveUserSession(nextSession);
  }
}

export async function loadCloudSyncPrefs(): Promise<CloudSyncPrefs> {
  const session = await loadUserSession();

  if (session?.token) {
    try {
      const remote = await apiRequest<{ prefs: CloudSyncPrefs }>('/api/sync/prefs', {
        token: session.token,
      });
      const normalized: CloudSyncPrefs = {
        consentEnabled: !!remote?.prefs?.consentEnabled,
        autoSyncEnabled: !!remote?.prefs?.autoSyncEnabled,
        lastSyncAt: typeof remote?.prefs?.lastSyncAt === 'string' ? remote.prefs.lastSyncAt : '',
      };
      await setDbValue(CLOUD_PREFS_KEY, normalized);
      prefsCache = normalized;
      return normalized;
    } catch {
      // segue fallback local
    }
  }

  if (prefsCache) {
    return prefsCache;
  }

  try {
    const parsed = await getDbValue<CloudSyncPrefs>(CLOUD_PREFS_KEY);
    prefsCache = {
      consentEnabled: !!parsed?.consentEnabled,
      autoSyncEnabled: !!parsed?.autoSyncEnabled,
      lastSyncAt: typeof parsed?.lastSyncAt === 'string' ? parsed.lastSyncAt : '',
    };
    return prefsCache;
  } catch {
    prefsCache = {
      consentEnabled: false,
      autoSyncEnabled: false,
      lastSyncAt: '',
    };
    return prefsCache;
  }
}

export async function saveCloudSyncPrefs(input: Partial<CloudSyncPrefs>) {
  const current = await loadCloudSyncPrefs();
  const next: CloudSyncPrefs = {
    ...current,
    ...input,
    lastSyncAt: typeof input.lastSyncAt === 'string' ? input.lastSyncAt : current.lastSyncAt,
  };

  await setDbValue(CLOUD_PREFS_KEY, next);
  prefsCache = next;

  const session = await loadUserSession();
  if (session?.token) {
    try {
      const remote = await apiRequest<{ prefs: CloudSyncPrefs }>('/api/sync/prefs', {
        method: 'PUT',
        token: session.token,
        body: next,
      });
      const synced = {
        consentEnabled: !!remote?.prefs?.consentEnabled,
        autoSyncEnabled: !!remote?.prefs?.autoSyncEnabled,
        lastSyncAt: typeof remote?.prefs?.lastSyncAt === 'string' ? remote.prefs.lastSyncAt : next.lastSyncAt,
      };
      await setDbValue(CLOUD_PREFS_KEY, synced);
      prefsCache = synced;
      return synced;
    } catch {
      // ignora falha remota e mantem local
    }
  }

  return next;
}

async function buildBackupData() {
  const keyPairs = await Promise.all(
    (BACKUP_KEYS as unknown as string[]).map(async (key) => {
      const val = await getDbValue<unknown>(key);
      const serialized = val !== null && val !== undefined ? JSON.stringify(val) : null;
      return [key, serialized] as [string, string | null];
    })
  );

  const data: Record<string, string | null> = {};
  keyPairs.forEach(([key, value]) => {
    data[key] = value;
  });
  return data;
}

async function saveBackupMirror(payload: BackupPayload) {
  await ensureDir();
  const stamp = payload.createdAt.replace(/[:.]/g, '-');
  const backupFile = `${BACKUP_DIR}backup-${stamp}.json`;
  const body = JSON.stringify(payload);

  await FileSystem.writeAsStringAsync(backupFile, body);
  await FileSystem.writeAsStringAsync(LAST_BACKUP_FILE, body);
  return backupFile;
}

export async function runCloudBackupNow() {
  const session = await loadUserSession();
  if (!session) {
    throw new Error('Faca login para sincronizar backup.');
  }

  const prefs = await loadCloudSyncPrefs();
  if (!prefs.consentEnabled) {
    throw new Error('Ative a permissao de backup em nuvem local para continuar.');
  }

  const data = await buildBackupData();
  const payload: BackupPayload = {
    version: 1,
    createdAt: nowIso(),
    userId: session.user.id,
    data,
  };

  const backupFile = await saveBackupMirror(payload);

  try {
    await apiRequest('/api/sync/backup', {
      method: 'POST',
      token: session.token,
      body: { data: payload.data },
      timeoutMs: 12000,
    });
  } catch {
    // servidor offline: espelho local ja foi salvo
  }

  await saveCloudSyncPrefs({ lastSyncAt: payload.createdAt });

  return {
    backupFile,
    syncedAt: payload.createdAt,
  };
}

async function restoreFromPayload(parsed: BackupPayload) {
  const pairs = Object.entries(parsed?.data || {}).map(([key, value]) => [key, value] as [string, string | null]);

  if (!pairs.length) {
    throw new Error('Backup invalido ou vazio.');
  }

  await Promise.all(
    pairs
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, value]) => {
        try {
          return setDbValue(key, JSON.parse(value));
        } catch {
          return setDbValue(key, value);
        }
      })
  );

  const toRemove = pairs.filter((entry) => entry[1] === null).map(([key]) => key);
  if (toRemove.length) {
    await Promise.all(toRemove.map((key) => removeDbValue(key)));
  }
}

export async function restoreLastCloudBackup() {
  const session = await loadUserSession();
  if (!session) {
    throw new Error('Faca login para restaurar backup.');
  }

  try {
    const remote = await apiRequest<{ backup: { createdAt: string; data: Record<string, string | null> } }>('/api/sync/backup/latest', {
      token: session.token,
      timeoutMs: 10000,
    });

    const payload: BackupPayload = {
      version: 1,
      createdAt: String(remote?.backup?.createdAt || nowIso()),
      userId: session.user.id,
      data: remote?.backup?.data || {},
    };

    await restoreFromPayload(payload);
    await saveBackupMirror(payload);
    await saveCloudSyncPrefs({ lastSyncAt: nowIso() });

    return {
      restoredAt: nowIso(),
      sourceCreatedAt: payload.createdAt,
    };
  } catch {
    // fallback do ultimo espelho local
  }

  const info = await FileSystem.getInfoAsync(LAST_BACKUP_FILE);
  if (!info.exists) {
    throw new Error('Nenhum backup encontrado para restaurar.');
  }

  const raw = await FileSystem.readAsStringAsync(LAST_BACKUP_FILE);
  const parsed = JSON.parse(raw) as BackupPayload;
  await restoreFromPayload(parsed);

  await saveCloudSyncPrefs({ lastSyncAt: nowIso() });
  return {
    restoredAt: nowIso(),
    sourceCreatedAt: parsed.createdAt,
  };
}

export async function loadLastLocalMirrorSync() {
  const prefs = await loadCloudSyncPrefs();
  return prefs.lastSyncAt;
}
