import { getDbValue, getDbValuesByPrefix, removeDbValue, setDbValue } from '@/services/local-db';
import { getProfileScopedKeyPrefix } from '@/services/profile-scoped-storage';
import { isNonMobileDevice } from '@/services/device-profile';
import * as FileSystem from 'expo-file-system/legacy';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

import { apiRequest, getAppServerUrl } from '@/services/app-server';
import { getAuthenticatedProfileId } from '@/services/access-control';

const SESSION_KEY = 'cloudSync.session.v2';
const LOCAL_USERS_KEY = 'cloudSync.localUsers.v2';
const CLOUD_PREFS_KEY = 'cloudSync.prefs.v1';
const CLOUD_PREFS_BY_USER_KEY = 'cloudSync.prefsByUser.v1';
const BACKUP_DIR = `${FileSystem.documentDirectory}cloud-backups/`;
const LAST_BACKUP_FILE = `${BACKUP_DIR}last-backup.json`;
const AVATAR_CACHE_DIR = `${FileSystem.documentDirectory}avatar-cache/`;

let localUsersCache: Record<string, LocalUserRecord> | null = null;
let sessionCache: UserSession | null | undefined;
let prefsCache: CloudSyncPrefs | null = null;

type LocalUserRecord = {
  id: string;
  name: string;
  email: string;
  password: string;
  avatarUri?: string;
  avatarRemoteUri?: string;
  createdAt: string;
  updatedAt: string;
};

export type UserAccount = {
  id: string;
  name: string;
  email: string;
  avatarUri?: string;
  avatarRemoteUri?: string;
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

export type CloudBackupProgress = {
  stage:
    | 'preparing'
    | 'building'
    | 'saving_local'
    | 'uploading'
    | 'fetching_remote'
    | 'restoring_local'
    | 'finalizing'
    | 'done';
  progress: number;
  message: string;
};

type BackupPayload = {
  version: 1;
  createdAt: string;
  userId: string;
  profileId?: string;
  data: Record<string, string | null>;
};

type ProfileScopedContainer = {
  __scopedByProfile: true;
  profiles: Record<string, unknown>;
};

const BACKUP_KEYS = [
  // ── Conta e perfis ──────────────────────────────────────────────────────────
  'accountSettings.v1',

  // ── Listas de usuário ───────────────────────────────────────────────────────
  'user_lists_v1',
  'user_lists_v2',

  // ── Progresso de reprodução ─────────────────────────────────────────────────
  'movieProgressMap',
  'seriesProgressMap',

  // ── Algoritmo de IA / gosto ─────────────────────────────────────────────────
  'taste.watchSignals.v1',
  'taste.profile.cache.v1',

  // ── Comportamento / onboarding ──────────────────────────────────────────────
  'behavior.events.v1',
  'behavior.onboarding.state.v1',
  'behavior.onboarding.pending.v1',
  'behavior.bootstrap.preferences.v1',
  'behavior.version.v1',

  // ── Assinatura ──────────────────────────────────────────────────────────────
  'subscription.plan.v1',
  'subscription.plan.state.v1',

  // ── Downloads ───────────────────────────────────────────────────────────────
  'downloaded_library_v1',

  // ── Configurações de automação e IA ─────────────────────────────────────────
  'automation.settings.v1',
  'ai.settings.v1',

  // ── Preferências do catálogo ────────────────────────────────────────────────
  'catalog.refresh.period.v1',

  // ── Preferências de perfil (acesso lembrado / confiado) ─────────────────────
  'session.profile.remembered.v1',
  'session.profile.trusted.v1',

  // ── Servidor Xtream (legado) ────────────────────────────────────────────────
  'session.server.credentials.v1',
  'name',
  'url',
  'username',
  'password',
  'userInfo',
  'serverInfo',

  // ── Servidor realtime ───────────────────────────────────────────────────────
  'realtimeServer.url',
  'realtimeServer.blockedContent.v1',

  // ── Cloud sync ──────────────────────────────────────────────────────────────
  'cloudSync.prefsByUser.v1',

  // ── Misc ────────────────────────────────────────────────────────────────────
  'demoModeEnabled',
] as const;

const PROFILE_SCOPED_BACKUP_KEYS = new Set<string>([
  'user_lists_v2',
  'movieProgressMap',
  'seriesProgressMap',
  'taste.watchSignals.v1',
  'taste.profile.cache.v1',
  'behavior.events.v1',
  'behavior.onboarding.state.v1',
  'behavior.onboarding.pending.v1',
  'behavior.bootstrap.preferences.v1',
  'behavior.version.v1',
  'ai.settings.v1',
]);

const nowIso = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const safeEmail = (value: string) => value.trim().toLowerCase();
const isRemoteAvatarUri = (value: string) => /^https?:\/\//i.test(value) || /^data:image\//i.test(value);

function isProfileScopedContainer(value: unknown): value is ProfileScopedContainer {
  const safe = value as any;
  return !!safe && typeof safe === 'object' && safe.__scopedByProfile === true && safe.profiles && typeof safe.profiles === 'object';
}

// Mescla dois objetos de accountSettings preservando TODOS os perfis de ambas as fontes.
// Usa a mesma lógica do painel admin: deduplicação por ID, prefere versão mais recente.
function mergeAccountSettingsForRestore(existing: unknown, incoming: unknown): unknown {
  const safe = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
  const existingSettings = safe(existing);
  const incomingSettings = safe(incoming);

  // Mescla perfis: mantém todos, preferencialmente o com updatedAt mais recente.
  const profileMap = new Map<string, Record<string, unknown>>();
  const addProfile = (profile: unknown) => {
    const p = safe(profile);
    const id = String(p.id || '').trim();
    if (!id) return;
    const prev = profileMap.get(id);
    if (!prev) {
      profileMap.set(id, p);
      return;
    }
    const prevDate = String(prev.updatedAt || '');
    const nextDate = String(p.updatedAt || '');
    if (nextDate >= prevDate) {
      profileMap.set(id, { ...prev, ...p, id });
    }
  };

  // Processa primeiro o existente (local) depois o incoming (remoto)
  // para que o remoto ganhe em caso de conflito de versão.
  (Array.isArray(existingSettings.profiles) ? existingSettings.profiles : []).forEach(addProfile);
  (Array.isArray(incomingSettings.profiles) ? incomingSettings.profiles : []).forEach(addProfile);

  const mergedProfiles = [...profileMap.values()];

  // Para servidores: igual, merge por url+username.
  const serverMap = new Map<string, Record<string, unknown>>();
  const addServer = (server: unknown) => {
    const s = safe(server);
    const url = String(s.url || '').replace(/\/$/, '').trim();
    const username = String(s.username || '').trim();
    if (!url || !username) return;
    const key = `${username}@@${url}`;
    const prev = serverMap.get(key);
    if (!prev) {
      serverMap.set(key, s);
      return;
    }
    const prevDate = String(prev.updatedAt || '');
    const nextDate = String(s.updatedAt || '');
    if (nextDate >= prevDate) {
      serverMap.set(key, { ...prev, ...s });
    }
  };
  (Array.isArray(existingSettings.servers) ? existingSettings.servers : []).forEach(addServer);
  (Array.isArray(incomingSettings.servers) ? incomingSettings.servers : []).forEach(addServer);
  const mergedServers = [...serverMap.values()];

  // O incoming (remoto/mais recente) prevalece para campos escalares,
  // mas preserva perfis/servidores adicionais do estado local.
  return {
    ...existingSettings,
    ...incomingSettings,
    profiles: mergedProfiles,
    servers: mergedServers,
    // Mantém activeProfileId/activeServerId do remoto se presentes.
    activeProfileId: String(incomingSettings.activeProfileId || existingSettings.activeProfileId || '').trim(),
    activeServerId: String(incomingSettings.activeServerId || existingSettings.activeServerId || '').trim(),
  };
}

function pickOnlyProfileFromScopedContainer(value: unknown, profileId: string) {
  if (!isProfileScopedContainer(value)) {
    return value;
  }

  const hasProfile = Object.prototype.hasOwnProperty.call(value.profiles, profileId);
  const profileValue = hasProfile ? value.profiles[profileId] : null;

  return {
    __scopedByProfile: true,
    profiles: {
      [profileId]: profileValue,
    },
  } as ProfileScopedContainer;
}

function mergeProfileScopedRestoreValue(currentRaw: unknown, incomingRaw: unknown, profileId: string) {
  const currentProfiles = isProfileScopedContainer(currentRaw)
    ? { ...currentRaw.profiles }
    : {};

  if (isProfileScopedContainer(incomingRaw)) {
    const hasProfile = Object.prototype.hasOwnProperty.call(incomingRaw.profiles, profileId);
    if (!hasProfile) {
      return {
        __scopedByProfile: true,
        profiles: currentProfiles,
      } as ProfileScopedContainer;
    }

    return {
      __scopedByProfile: true,
      profiles: {
        ...currentProfiles,
        [profileId]: incomingRaw.profiles[profileId],
      },
    } as ProfileScopedContainer;
  }

  return {
    __scopedByProfile: true,
    profiles: {
      ...currentProfiles,
      [profileId]: incomingRaw,
    },
  } as ProfileScopedContainer;
}

function sanitizeForFileName(value: string) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 100);
}

function getLastBackupFileForUser(userId: string) {
  const safeUserId = sanitizeForFileName(userId) || 'unknown';
  return `${BACKUP_DIR}last-backup-${safeUserId}.json`;
}

function getLastBackupFileForUserProfile(userId: string, profileId: string) {
  const safeUserId = sanitizeForFileName(userId) || 'unknown';
  const safeProfileId = sanitizeForFileName(profileId) || 'default';
  return `${BACKUP_DIR}last-backup-${safeUserId}-${safeProfileId}.json`;
}

async function resolveActiveProfileId(): Promise<string> {
  try {
    const { loadAccountSettings } = await import('@/services/account-settings');
    const settings = await loadAccountSettings();
    return String(settings.activeProfileId || settings.profiles[0]?.id || '').trim();
  } catch {
    return '';
  }
}

async function resolveAuthenticatedProfileContext() {
  const [activeProfileId, authenticatedProfileId] = await Promise.all([
    resolveActiveProfileId(),
    getAuthenticatedProfileId(),
  ]);

  const normalizedActive = String(activeProfileId || '').trim();
  const normalizedAuth = String(authenticatedProfileId || '').trim();

  if (!normalizedActive || !normalizedAuth) {
    return {
      activeProfileId: normalizedActive,
      authenticatedProfileId: normalizedAuth,
      canUseProfileSync: false,
    };
  }

  return {
    activeProfileId: normalizedActive,
    authenticatedProfileId: normalizedAuth,
    canUseProfileSync: normalizedActive === normalizedAuth,
  };
}

function normalizeCloudPrefs(input: Partial<CloudSyncPrefs> | null | undefined): CloudSyncPrefs {
  return {
    consentEnabled: !!input?.consentEnabled,
    autoSyncEnabled: !!input?.autoSyncEnabled,
    lastSyncAt: typeof input?.lastSyncAt === 'string' ? input.lastSyncAt : '',
  };
}

async function loadCloudPrefsByUserMap() {
  try {
    const parsed = await getDbValue<Record<string, CloudSyncPrefs>>(CLOUD_PREFS_BY_USER_KEY);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function cloudPrefsScopeKey(session: UserSession | null) {
  return session?.user?.id ? `user:${session.user.id}` : 'guest';
}

async function readLocalCloudPrefsForSession(session: UserSession | null): Promise<CloudSyncPrefs> {
  const byUser = await loadCloudPrefsByUserMap();
  const scoped = byUser[cloudPrefsScopeKey(session)];
  if (scoped) {
    return normalizeCloudPrefs(scoped);
  }

  // Compatibilidade com versao antiga (chave global unica).
  try {
    const legacy = await getDbValue<CloudSyncPrefs>(CLOUD_PREFS_KEY);
    return normalizeCloudPrefs(legacy);
  } catch {
    return normalizeCloudPrefs(null);
  }
}

async function saveLocalCloudPrefsForSession(session: UserSession | null, prefs: CloudSyncPrefs) {
  const normalized = normalizeCloudPrefs(prefs);
  const byUser = await loadCloudPrefsByUserMap();
  byUser[cloudPrefsScopeKey(session)] = normalized;
  await Promise.all([
    setDbValue(CLOUD_PREFS_BY_USER_KEY, byUser),
    // Mantem legado em paralelo para compatibilidade de leitura por builds antigos.
    setDbValue(CLOUD_PREFS_KEY, normalized),
  ]);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function ensureAvatarCacheDir() {
  const info = await FileSystem.getInfoAsync(AVATAR_CACHE_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(AVATAR_CACHE_DIR, { intermediates: true });
  }
}

async function normalizeAvatarSourceToLocalFile(sourceUri: string, userId: string): Promise<string> {
  const safeSourceUri = String(sourceUri || '').trim();
  if (!safeSourceUri) {
    throw new Error('Nenhuma imagem foi selecionada.');
  }

  // URIs do picker/crop variam por plataforma (file://, content://, ph://, etc.).
  // Regrava como JPEG em cache para garantir um arquivo local estavel para upload.
  const normalized = await manipulateAsync(
    safeSourceUri,
    [{ resize: { width: 1024 } }],
    {
      compress: 0.82,
      format: SaveFormat.JPEG,
      base64: false,
    }
  );

  const normalizedUri = String(normalized?.uri || '').trim();
  if (!normalizedUri) {
    throw new Error('Nao foi possivel preparar a imagem selecionada.');
  }

  await ensureAvatarCacheDir();
  const destination = `${AVATAR_CACHE_DIR}${userId}-${Date.now()}.jpg`;
  await FileSystem.copyAsync({ from: normalizedUri, to: destination });
  return destination;
}

function inferImageExt(uri: string) {
  const clean = String(uri || '').split('?')[0];
  const match = clean.match(/\.([a-zA-Z0-9]{2,5})$/);
  const raw = (match?.[1] || 'jpg').toLowerCase();
  if (raw === 'jpeg') return 'jpg';
  if (['jpg', 'png', 'webp', 'heic'].includes(raw)) return raw;
  return 'jpg';
}

async function cacheAvatarLocally(userId: string, sourceUri: string): Promise<string> {
  const safeSourceUri = String(sourceUri || '').trim();
  if (!safeSourceUri) {
    throw new Error('Nenhuma imagem foi selecionada.');
  }

  await ensureAvatarCacheDir();

  // Se ja for um arquivo local simples, tenta copiar diretamente.
  // Caso falhe (content://, ph://, provider bloqueado, crop temporario),
  // regrava via image-manipulator para obter um arquivo local estavel.
  if (/^file:\/\//i.test(safeSourceUri)) {
    try {
      const ext = inferImageExt(safeSourceUri);
      const destination = `${AVATAR_CACHE_DIR}${userId}-${Date.now()}.${ext}`;
      await FileSystem.copyAsync({ from: safeSourceUri, to: destination });
      return destination;
    } catch {
      return normalizeAvatarSourceToLocalFile(safeSourceUri, userId);
    }
  }

  return normalizeAvatarSourceToLocalFile(safeSourceUri, userId);
}

async function persistAvatarForLocalUser(session: UserSession) {
  const users = await loadLocalUsers();
  const key = safeEmail(session.user.email);
  const existing = users[key];

  if (!existing) {
    return;
  }

  users[key] = {
    ...existing,
    name: session.user.name,
    email: session.user.email,
    avatarUri: session.user.avatarUri || '',
    avatarRemoteUri: session.user.avatarRemoteUri || '',
    updatedAt: nowIso(),
  };

  await saveLocalUsers(users);
}

async function uploadAvatarFileToServer(input: {
  token: string;
  localAvatarUri: string;
  fileNamePrefix: string;
}): Promise<string> {
  const baseUrl = await getAppServerUrl();
  const uploadResult = await withTimeout(
    FileSystem.uploadAsync(`${baseUrl}/api/auth/avatar/file`, input.localAvatarUri, {
      fieldName: 'avatar',
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      headers: {
        Authorization: `Bearer ${input.token}`,
      },
      parameters: {
        fileName: `${input.fileNamePrefix}.${inferImageExt(input.localAvatarUri)}`,
      },
    }),
    15000,
    'Upload da foto excedeu o tempo limite.'
  );

  let parsed: any = {};
  try {
    parsed = JSON.parse(String(uploadResult?.body || '{}'));
  } catch {
    parsed = {};
  }

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    const errorMessage = typeof parsed?.error === 'string' ? parsed.error : `Erro ${uploadResult.status}`;
    throw new Error(errorMessage);
  }

  const remoteAvatar = String(parsed?.avatarUri || '').trim();
  if (!remoteAvatar) {
    throw new Error('Servidor nao retornou URL da imagem.');
  }

  return remoteAvatar;
}

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
  const rawAvatar = String(input?.user?.avatarUri || '');
  const rawAvatarRemote = String(input?.user?.avatarRemoteUri || '');
  return {
    token: String(input?.token || ''),
    user: {
      id: String(input?.user?.id || ''),
      name: String(input?.user?.name || ''),
      email: String(input?.user?.email || ''),
      avatarUri: rawAvatar,
      avatarRemoteUri: rawAvatarRemote || (isRemoteAvatarUri(rawAvatar) ? rawAvatar : ''),
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

export async function clearAllLocalUserData() {
  // Encerra sessao remota da conta (best effort).
  await clearUserSession().catch(() => null);

  // Encerra sessao realtime (best effort).
  try {
    const { disconnect } = await import('@/services/realtime-presence');
    await disconnect();
  } catch {
    // Ignora falha de realtime no logout local.
  }

  const keysToRemove = [
    SESSION_KEY,
    CLOUD_PREFS_KEY,
    CLOUD_PREFS_BY_USER_KEY,
    'name',
    'url',
    'username',
    'password',
    'userInfo',
    'serverInfo',
    'session.server.credentials.v1',
    'accountSettings.v1',
    'session.profile.unlocked',
    'session.profile.authProfileId',
    'session.parental.unlocked',
    'session.profile.remembered.v1',
    'session.profile.trusted.v1',
    'realtimeServer.token',
    'realtimeServer.sessionMeta.v1',
    'realtimeServer.blockedContent.v1',
    'movieProgressMap',
    'seriesProgressMap',
    'user_lists_v1',
    'user_lists_v2',
    'downloaded_library_v1',
    'taste.watchSignals.v1',
    'taste.profile.cache.v1',
    'behavior.events.v1',
    'behavior.onboarding.state.v1',
    'behavior.onboarding.pending.v1',
    'behavior.bootstrap.preferences.v1',
    'behavior.version.v1',
    'ai.settings.v1',
    'automation.settings.v1',
    'catalog.snapshot.v3',
    'catalog.lastUpdate.v1',
    'catalog.ready.v1',
    'catalog.refresh.period.v1',
    'cloudSync.autoRestore.lastAt.v1',
    'session.access.blocked.message.v1',
  ];

  await Promise.all(keysToRemove.map((key) => removeDbValue(key).catch(() => null)));

  sessionCache = null;
  prefsCache = null;
  localUsersCache = null;
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
  avatarRemoteUri?: string;
}) {
  const session = await loadUserSession();
  if (!session) {
    throw new Error('Faca login para editar o perfil.');
  }

  const name = (input.name || '').trim();
  const email = safeEmail(input.email || '');
  const avatarUri = (input.avatarUri || '').trim();
  const avatarRemoteUri = (input.avatarRemoteUri || '').trim();

  if (!name) throw new Error('Informe o nome.');
  if (!email || !email.includes('@')) throw new Error('Informe um e-mail valido.');

  try {
    const payload: { name: string; email: string; avatarUri?: string } = { name, email };
    const remoteAvatar = avatarRemoteUri || (isRemoteAvatarUri(avatarUri) ? avatarUri : '');
    if (remoteAvatar) {
      payload.avatarUri = remoteAvatar;
    }

    const remote = await apiRequest<{ token: string; user: UserAccount }>('/api/auth/me', {
      method: 'PATCH',
      token: session.token,
      body: payload,
    });
    const normalized = normalizeSession(remote);
    const keepLocalAvatar = avatarUri && !isRemoteAvatarUri(avatarUri) ? avatarUri : '';
    const nextSession: UserSession = {
      ...normalized,
      user: {
        ...normalized.user,
        avatarUri: keepLocalAvatar || normalized.user.avatarUri || '',
        avatarRemoteUri: normalized.user.avatarRemoteUri || remoteAvatar || '',
      },
    };
    await persistAvatarForLocalUser(nextSession);
    return saveUserSession(nextSession);
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
      avatarRemoteUri: avatarRemoteUri || currentRecord.avatarRemoteUri || '',
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
        avatarRemoteUri: avatarRemoteUri || session.user.avatarRemoteUri || '',
        lastLoginAt: nowIso(),
      },
    };

    return saveUserSession(nextSession);
  }
}

export async function uploadCurrentUserAvatarFromDevice(sourceUri: string): Promise<UserSession> {
  const session = await loadUserSession();
  if (!session) {
    throw new Error('Faca login para alterar a foto de perfil.');
  }

  const origin = String(sourceUri || '').trim();
  if (!origin) {
    throw new Error('Nenhuma imagem foi selecionada.');
  }

  const localAvatarUri = await cacheAvatarLocally(session.user.id, origin);
  let nextSession: UserSession = {
    ...session,
    user: {
      ...session.user,
      avatarUri: localAvatarUri,
      lastLoginAt: nowIso(),
    },
  };

  await saveUserSession(nextSession);
  await persistAvatarForLocalUser(nextSession);

  try {
    const info = await FileSystem.getInfoAsync(localAvatarUri);
    if (!info.exists) {
      throw new Error('Arquivo da imagem nao foi encontrado.');
    }

    const remoteAvatar = await uploadAvatarFileToServer({
      token: session.token,
      localAvatarUri,
      fileNamePrefix: `avatar-${session.user.id}`,
    });

    if (remoteAvatar) {
      nextSession = {
        ...nextSession,
        user: {
          ...nextSession.user,
          avatarRemoteUri: remoteAvatar,
        },
      };
      await saveUserSession(nextSession);
      await persistAvatarForLocalUser(nextSession);
    }
  } catch (error) {
    // Mantem avatar local para UX fluida mesmo com falha temporaria de rede/servidor.
    console.error('[cloud-sync][avatar-upload] falha durante upload', {
      localAvatarUri,
      sourceUri: origin,
      message: String((error as any)?.message || error || ''),
      stack: (error as any)?.stack || null,
    });
    console.warn('Falha ao enviar avatar para o servidor:', error);
  }

  return nextSession;
}

export async function uploadProfileAvatarFromDevice(sourceUri: string): Promise<string> {
  const session = await loadUserSession();
  if (!session) {
    throw new Error('Faca login para enviar foto do perfil.');
  }

  const origin = String(sourceUri || '').trim();
  if (!origin) {
    throw new Error('Nenhuma imagem foi selecionada.');
  }

  const localAvatarUri = await normalizeAvatarSourceToLocalFile(origin, `profile-${session.user.id}`);
  const info = await FileSystem.getInfoAsync(localAvatarUri);
  if (!info.exists) {
    throw new Error('Arquivo da imagem nao foi encontrado.');
  }

  try {
    return await uploadAvatarFileToServer({
      token: session.token,
      localAvatarUri,
      fileNamePrefix: `profile-avatar-${session.user.id}`,
    });
  } catch (error) {
    console.error('[cloud-sync][profile-avatar-upload] falha durante upload', {
      localAvatarUri,
      sourceUri: origin,
      message: String((error as any)?.message || error || ''),
      stack: (error as any)?.stack || null,
    });
    throw error;
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
      await saveLocalCloudPrefsForSession(session, normalized);
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
    prefsCache = await readLocalCloudPrefsForSession(session);
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

  const session = await loadUserSession();
  await saveLocalCloudPrefsForSession(session, next);
  prefsCache = next;

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
      await saveLocalCloudPrefsForSession(session, synced);
      prefsCache = synced;
      return synced;
    } catch {
      // ignora falha remota e mantem local
    }
  }

  return next;
}

async function buildBackupData(profileIdForSync = '') {
  const keyPairs = await Promise.all(
    (BACKUP_KEYS as unknown as string[]).map(async (key) => {
      let val: unknown = await getDbValue<unknown>(key);
      if (key === 'behavior.events.v1') {
        const prefix = await getProfileScopedKeyPrefix(key, profileIdForSync || undefined);
        const rows = await getDbValuesByPrefix(prefix);
        if (rows && rows.length) {
          val = rows
            .map((row) => row.value)
            .filter((value): value is unknown => value !== null && value !== undefined);
        }
      }
      const valueForBackup =
        profileIdForSync && PROFILE_SCOPED_BACKUP_KEYS.has(key)
          ? pickOnlyProfileFromScopedContainer(val, profileIdForSync)
          : val;
      const serialized = valueForBackup !== null && valueForBackup !== undefined ? JSON.stringify(valueForBackup) : null;
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
  const userLastBackupFile = getLastBackupFileForUser(payload.userId);
  const profileLastBackupFile = payload.profileId
    ? getLastBackupFileForUserProfile(payload.userId, payload.profileId)
    : '';
  const body = JSON.stringify(payload);

  await FileSystem.writeAsStringAsync(backupFile, body);
  await FileSystem.writeAsStringAsync(userLastBackupFile, body);
  if (profileLastBackupFile) {
    await FileSystem.writeAsStringAsync(profileLastBackupFile, body);
  }
  // Mantem o legado para compatibilidade com versoes antigas do app.
  await FileSystem.writeAsStringAsync(LAST_BACKUP_FILE, body);
  return backupFile;
}

export async function runCloudBackupNow(options?: {
  onProgress?: (progress: CloudBackupProgress) => void;
}) {
  const report = (progress: CloudBackupProgress) => {
    options?.onProgress?.(progress);
  };

  const session = await loadUserSession();
  if (!session) {
    throw new Error('Faca login para sincronizar backup.');
  }

  const prefs = await loadCloudSyncPrefs();
  if (!prefs.consentEnabled) {
    throw new Error('Ative a permissao de backup em nuvem local para continuar.');
  }

  report({ stage: 'preparing', progress: 5, message: 'Preparando backup da conta' });

  report({ stage: 'building', progress: 20, message: 'Lendo dados locais do app' });
  const profileContext = await resolveAuthenticatedProfileContext();
  const profileIdForSync = profileContext.canUseProfileSync ? profileContext.activeProfileId : '';
  const data = await withTimeout(
    buildBackupData(profileIdForSync),
    15000,
    'A leitura dos dados do backup excedeu o tempo limite.'
  );

  const payload: BackupPayload = {
    version: 1,
    createdAt: nowIso(),
    userId: session.user.id,
    profileId: profileIdForSync || undefined,
    data,
  };

  report({ stage: 'saving_local', progress: 45, message: 'Salvando copia local no celular' });
  const backupFile = await withTimeout(
    saveBackupMirror(payload),
    12000,
    'O salvamento do backup local excedeu o tempo limite.'
  );

  report({ stage: 'uploading', progress: 70, message: 'Enviando backup ao servidor' });
  try {
    if (profileIdForSync) {
      await withTimeout(
        apiRequest(`/api/sync/backup/profile/${encodeURIComponent(profileIdForSync)}`, {
          method: 'POST',
          token: session.token,
          body: { data: payload.data },
          timeoutMs: 12000,
        }),
        15000,
        'O envio do backup de perfil ao servidor excedeu o tempo limite.'
      );
    } else {
      await withTimeout(
        apiRequest('/api/sync/backup', {
          method: 'POST',
          token: session.token,
          body: { data: payload.data },
          timeoutMs: 12000,
        }),
        15000,
        'O envio do backup ao servidor excedeu o tempo limite.'
      );
    }
  } catch {
    // Compatibilidade com servidor antigo sem endpoint por perfil.
    try {
      await withTimeout(
        apiRequest('/api/sync/backup', {
          method: 'POST',
          token: session.token,
          body: { data: payload.data },
          timeoutMs: 12000,
        }),
        15000,
        'O envio do backup ao servidor excedeu o tempo limite.'
      );
    } catch {
      // servidor offline: espelho local ja foi salvo
    }
  }

  report({ stage: 'finalizing', progress: 90, message: 'Finalizando sincronizacao' });
  await withTimeout(
    saveCloudSyncPrefs({ lastSyncAt: payload.createdAt }),
    8000,
    'A finalizacao do backup excedeu o tempo limite.'
  );

  report({ stage: 'done', progress: 100, message: 'Backup concluido com sucesso' });

  return {
    backupFile,
    syncedAt: payload.createdAt,
  };
}

async function restoreFromPayload(parsed: BackupPayload, expectedUserId?: string, expectedProfileId?: string) {
  if (expectedUserId && parsed?.userId && parsed.userId !== expectedUserId) {
    throw new Error('Este backup pertence a outro usuario.');
  }

  if (expectedProfileId && parsed?.profileId && parsed.profileId !== expectedProfileId) {
    throw new Error('Este backup pertence a outro perfil.');
  }

  const pairs = Object.entries(parsed?.data || {}).map(([key, value]) => [key, value] as [string, string | null]);

  if (!pairs.length) {
    throw new Error('Backup invalido ou vazio.');
  }

  // Restaura apenas chaves com valor presente; chaves null significam "dado ausente
  // no momento do backup" — não devem apagar dados mais recentes do dispositivo.
  const toRestore = pairs.filter((entry): entry is [string, string] => typeof entry[1] === 'string');

  if (!toRestore.length) {
    throw new Error('Backup invalido ou vazio.');
  }

  await Promise.all(
    toRestore.map(async ([key, value]) => {
      try {
        const parsedValue = JSON.parse(value);

        // accountSettings.v1: mescla perfis e servidores para nunca perder
        // perfis criados localmente que ainda não foram incluídos no backup remoto.
        if (key === 'accountSettings.v1') {
          const currentValue = await getDbValue<unknown>(key);
          const mergedValue = mergeAccountSettingsForRestore(currentValue, parsedValue);
          return setDbValue(key, mergedValue);
        }

        if (expectedProfileId && PROFILE_SCOPED_BACKUP_KEYS.has(key)) {
          const currentValue = await getDbValue<unknown>(key);
          const mergedValue = mergeProfileScopedRestoreValue(currentValue, parsedValue, expectedProfileId);
          return setDbValue(key, mergedValue);
        }
        return setDbValue(key, parsedValue);
      } catch {
        return setDbValue(key, value);
      }
    })
  );

  // O restore escreve direto no banco; limpa caches em memoria para a navegacao ler estado novo.
  const { invalidateAccountSettingsCache } = await import('@/services/account-settings');
  invalidateAccountSettingsCache();
  prefsCache = null;
}

async function restoreGlobalAccountSettingsFromServer(session: UserSession): Promise<string | null> {
  try {
    const remote = await withTimeout(
      apiRequest<{ backup: { createdAt: string; data: Record<string, string | null> } }>('/api/sync/backup/latest', {
        token: session.token,
        timeoutMs: 10000,
      }),
      12000,
      'A leitura do backup global excedeu o tempo limite.'
    );

    const accountSettingsRaw = remote?.backup?.data?.['accountSettings.v1'];
    if (typeof accountSettingsRaw !== 'string') {
      return null;
    }

    const payload: BackupPayload = {
      version: 1,
      createdAt: String(remote?.backup?.createdAt || nowIso()),
      userId: session.user.id,
      data: {
        'accountSettings.v1': accountSettingsRaw,
      },
    };

    await withTimeout(
      restoreFromPayload(payload, session.user.id, undefined),
      12000,
      'A restauracao de accountSettings excedeu o tempo limite.'
    );

    return payload.createdAt;
  } catch {
    return null;
  }
}

export async function restoreLastCloudBackup(options?: {
  onProgress?: (progress: CloudBackupProgress) => void;
}) {
  const report = (progress: CloudBackupProgress) => {
    options?.onProgress?.(progress);
  };

  const session = await loadUserSession();
  if (!session) {
    throw new Error('Faca login para restaurar backup.');
  }

  report({ stage: 'preparing', progress: 5, message: 'Preparando restauracao do backup' });
  const profileContext = await resolveAuthenticatedProfileContext();
  const profileIdForSync = profileContext.canUseProfileSync ? profileContext.activeProfileId : '';

  // Em reinstalacao (sem profileId autenticado local), prioriza o backup de perfil
  // mais recente. O backup global pode estar defasado em relacao ao fluxo por perfil.
  if (!profileIdForSync) {
    try {
      report({ stage: 'fetching_remote', progress: 25, message: 'Buscando backup de perfil mais recente' });
      const remote = await withTimeout(
        apiRequest<{ backup: { createdAt: string; profileId?: string; data: Record<string, string | null> } }>(
          '/api/sync/backup/profile/latest',
          {
            token: session.token,
            timeoutMs: 10000,
          }
        ),
        12000,
        'A leitura do backup remoto de perfil excedeu o tempo limite.'
      );

      const payload: BackupPayload = {
        version: 1,
        createdAt: String(remote?.backup?.createdAt || nowIso()),
        userId: session.user.id,
        profileId: String(remote?.backup?.profileId || '').trim() || undefined,
        data: remote?.backup?.data || {},
      };

      report({ stage: 'restoring_local', progress: 55, message: 'Aplicando backup de perfil mais recente' });
      await withTimeout(
        restoreFromPayload(payload, session.user.id, undefined),
        15000,
        'A restauracao dos dados locais excedeu o tempo limite.'
      );
      await restoreGlobalAccountSettingsFromServer(session);
      report({ stage: 'saving_local', progress: 75, message: 'Atualizando copia local do backup' });
      await withTimeout(
        saveBackupMirror(payload),
        12000,
        'O salvamento local do backup restaurado excedeu o tempo limite.'
      );
      report({ stage: 'finalizing', progress: 90, message: 'Finalizando restauracao' });
      await withTimeout(
        saveCloudSyncPrefs({ lastSyncAt: nowIso() }),
        8000,
        'A finalizacao da restauracao excedeu o tempo limite.'
      );

      report({ stage: 'done', progress: 100, message: 'Restauracao concluida com sucesso' });

      return {
        restoredAt: nowIso(),
        sourceCreatedAt: payload.createdAt,
      };
    } catch {
      // Se nao houver backup de perfil, segue para o fluxo global/compatibilidade abaixo.
    }
  }

  try {
    report({ stage: 'fetching_remote', progress: 25, message: 'Buscando ultimo backup no servidor' });
    let remote: { backup: { createdAt: string; profileId?: string; data: Record<string, string | null> } };
    if (profileIdForSync) {
      remote = await withTimeout(
        apiRequest<{ backup: { createdAt: string; profileId?: string; data: Record<string, string | null> } }>(
          `/api/sync/backup/profile/${encodeURIComponent(profileIdForSync)}/latest`,
          {
            token: session.token,
            timeoutMs: 10000,
          }
        ),
        12000,
        'A leitura do backup remoto de perfil excedeu o tempo limite.'
      );
    } else {
      remote = await withTimeout(
        apiRequest<{ backup: { createdAt: string; profileId?: string; data: Record<string, string | null> } }>(
          '/api/sync/backup/latest',
          {
            token: session.token,
            timeoutMs: 10000,
          }
        ),
        12000,
        'A leitura do backup remoto excedeu o tempo limite.'
      );
    }

    const payload: BackupPayload = {
      version: 1,
      createdAt: String(remote?.backup?.createdAt || nowIso()),
      userId: session.user.id,
      profileId: profileIdForSync || remote?.backup?.profileId || undefined,
      data: remote?.backup?.data || {},
    };

    report({ stage: 'restoring_local', progress: 55, message: 'Aplicando backup nos dados locais' });
    await withTimeout(
      restoreFromPayload(payload, session.user.id, profileIdForSync || undefined),
      15000,
      'A restauracao dos dados locais excedeu o tempo limite.'
    );
    await restoreGlobalAccountSettingsFromServer(session);
    report({ stage: 'saving_local', progress: 75, message: 'Atualizando copia local do backup' });
    await withTimeout(
      saveBackupMirror(payload),
      12000,
      'O salvamento local do backup restaurado excedeu o tempo limite.'
    );
    report({ stage: 'finalizing', progress: 90, message: 'Finalizando restauracao' });
    await withTimeout(
      saveCloudSyncPrefs({ lastSyncAt: nowIso() }),
      8000,
      'A finalizacao da restauracao excedeu o tempo limite.'
    );

    report({ stage: 'done', progress: 100, message: 'Restauracao concluida com sucesso' });

    return {
      restoredAt: nowIso(),
      sourceCreatedAt: payload.createdAt,
    };
  } catch {
    // Compatibilidade com servidor antigo sem endpoint por perfil.
    if (profileIdForSync) {
      try {
        const remote = await withTimeout(
          apiRequest<{ backup: { createdAt: string; data: Record<string, string | null> } }>('/api/sync/backup/latest', {
            token: session.token,
            timeoutMs: 10000,
          }),
          12000,
          'A leitura do backup remoto excedeu o tempo limite.'
        );

        const payload: BackupPayload = {
          version: 1,
          createdAt: String(remote?.backup?.createdAt || nowIso()),
          userId: session.user.id,
          profileId: undefined,
          data: remote?.backup?.data || {},
        };

        report({ stage: 'restoring_local', progress: 55, message: 'Aplicando backup nos dados locais' });
        await withTimeout(
          restoreFromPayload(payload, session.user.id, undefined),
          15000,
          'A restauracao dos dados locais excedeu o tempo limite.'
        );
        await restoreGlobalAccountSettingsFromServer(session);
        report({ stage: 'saving_local', progress: 75, message: 'Atualizando copia local do backup' });
        await withTimeout(
          saveBackupMirror(payload),
          12000,
          'O salvamento local do backup restaurado excedeu o tempo limite.'
        );
        report({ stage: 'finalizing', progress: 90, message: 'Finalizando restauracao' });
        await withTimeout(
          saveCloudSyncPrefs({ lastSyncAt: nowIso() }),
          8000,
          'A finalizacao da restauracao excedeu o tempo limite.'
        );

        report({ stage: 'done', progress: 100, message: 'Restauracao concluida com sucesso' });

        return {
          restoredAt: nowIso(),
          sourceCreatedAt: payload.createdAt,
        };
      } catch {
        // fallback do ultimo espelho local
      }
    } else {
      // Quando ainda nao existe profileId autenticado no dispositivo (ex.: app recem-instalado),
      // tenta restaurar pelo backup de perfil mais recente da conta.
      try {
        const remote = await withTimeout(
          apiRequest<{ backup: { createdAt: string; profileId?: string; data: Record<string, string | null> } }>(
            '/api/sync/backup/profile/latest',
            {
              token: session.token,
              timeoutMs: 10000,
            }
          ),
          12000,
          'A leitura do backup remoto de perfil excedeu o tempo limite.'
        );

        const payload: BackupPayload = {
          version: 1,
          createdAt: String(remote?.backup?.createdAt || nowIso()),
          userId: session.user.id,
          profileId: String(remote?.backup?.profileId || '').trim() || undefined,
          data: remote?.backup?.data || {},
        };

        report({ stage: 'restoring_local', progress: 55, message: 'Aplicando backup de perfil mais recente' });
        await withTimeout(
          restoreFromPayload(payload, session.user.id, undefined),
          15000,
          'A restauracao dos dados locais excedeu o tempo limite.'
        );
        await restoreGlobalAccountSettingsFromServer(session);
        report({ stage: 'saving_local', progress: 75, message: 'Atualizando copia local do backup' });
        await withTimeout(
          saveBackupMirror(payload),
          12000,
          'O salvamento local do backup restaurado excedeu o tempo limite.'
        );
        report({ stage: 'finalizing', progress: 90, message: 'Finalizando restauracao' });
        await withTimeout(
          saveCloudSyncPrefs({ lastSyncAt: nowIso() }),
          8000,
          'A finalizacao da restauracao excedeu o tempo limite.'
        );

        report({ stage: 'done', progress: 100, message: 'Restauracao concluida com sucesso' });

        return {
          restoredAt: nowIso(),
          sourceCreatedAt: payload.createdAt,
        };
      } catch {
        // fallback do ultimo espelho local
      }
    }
  }

  report({ stage: 'fetching_remote', progress: 30, message: 'Servidor indisponivel, usando copia local' });

  const profileLastBackupFile = profileIdForSync
    ? getLastBackupFileForUserProfile(session.user.id, profileIdForSync)
    : '';
  const userLastBackupFile = getLastBackupFileForUser(session.user.id);

  let fallbackFile = profileLastBackupFile || userLastBackupFile;
  let info = await withTimeout(
    FileSystem.getInfoAsync(fallbackFile),
    5000,
    'Nao foi possivel verificar a copia local do backup.'
  );

  // Compatibilidade: tenta arquivo por usuario se o por perfil nao existir.
  if (!info.exists && profileLastBackupFile) {
    fallbackFile = userLastBackupFile;
    info = await withTimeout(
      FileSystem.getInfoAsync(userLastBackupFile),
      5000,
      'Nao foi possivel verificar a copia local do backup.'
    );
  }

  // Compatibilidade: se ainda nao existir arquivo por usuario, tenta o legado.
  if (!info.exists) {
    fallbackFile = LAST_BACKUP_FILE;
    info = await withTimeout(
      FileSystem.getInfoAsync(LAST_BACKUP_FILE),
      5000,
      'Nao foi possivel verificar a copia local do backup.'
    );
  }

  if (!info.exists) {
    throw new Error('Nenhum backup encontrado para restaurar.');
  }

  const raw = await withTimeout(
    FileSystem.readAsStringAsync(fallbackFile),
    8000,
    'A leitura do backup local excedeu o tempo limite.'
  );
  const parsed = JSON.parse(raw) as BackupPayload;
  report({ stage: 'restoring_local', progress: 65, message: 'Aplicando backup salvo no dispositivo' });
  await withTimeout(
    restoreFromPayload(parsed, session.user.id, profileIdForSync || undefined),
    15000,
    'A restauracao dos dados locais excedeu o tempo limite.'
  );

  report({ stage: 'finalizing', progress: 90, message: 'Finalizando restauracao' });
  await withTimeout(
    saveCloudSyncPrefs({ lastSyncAt: nowIso() }),
    8000,
    'A finalizacao da restauracao excedeu o tempo limite.'
  );
  report({ stage: 'done', progress: 100, message: 'Restauracao concluida com sucesso' });
  return {
    restoredAt: nowIso(),
    sourceCreatedAt: parsed.createdAt,
  };
}

export async function loadLastLocalMirrorSync() {
  const prefs = await loadCloudSyncPrefs();
  return prefs.lastSyncAt;
}

/**
 * Dispara um backup imediato em background sem bloquear a UI.
 * Usado apos criar/editar perfis para garantir sincronizacao rapida com a API.
 */
export async function triggerImmediateSync(): Promise<void> {
  if (isNonMobileDevice()) {
    return;
  }

  const [session, prefs] = await Promise.all([loadUserSession(), loadCloudSyncPrefs()]);
  if (!session?.token || !prefs.consentEnabled) {
    return;
  }
  runCloudBackupNow().catch(() => null);
}
