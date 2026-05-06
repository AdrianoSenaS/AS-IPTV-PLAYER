/**
 * realtime-presence.ts
 *
 * Serviço cliente para presença em tempo real, monitoramento parental
 * e session lock. Só funciona se o usuário estiver logado com conta cadastrada.
 *
 * Fluxo:
 *  1. No login do perfil (perfil-acesso.tsx): startSession()
 *  2. Após entrar no app: heartbeat REST
 *  3. No player: reportWatching() / reportStoppedWatching()
 *  4. No fechamento do app: disconnect()
 */

import { getDbValue, setDbValue, removeDbValue } from '@/services/local-db';
import { DEFAULT_APP_SERVER_URL, getAppServerUrl } from '@/services/app-server';
import { normalizeApiBaseUrl, API_BASE_URL_STORAGE_KEY, PRODUCTION_API_BASE_URL } from '@/services/api-config';
import { isNonMobileDevice } from '@/services/device-profile';

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export type WatchingInfo = {
  contentId: string;
  contentTitle: string;
  contentType: 'movie' | 'series' | 'live';
  since: number;
  previewUrl?: string;
  posterUrl?: string;
  positionMs?: number;
  durationMs?: number;
};

export type ProfilePresence = {
  profileId: string;
  profileName: string;
  kidsMode: boolean;
  online: boolean;
  watching: WatchingInfo | null;
  connectedAt?: number;
  lastSeen: number;
};

export type ChildEnteredEvent = {
  profileId: string;
  profileName: string;
  enteredAt: string;
};

export type ChildWatchingEvent = {
  profileId: string;
  profileName: string;
  contentId: string;
  contentTitle: string;
  contentType: string;
  since: number;
  previewUrl?: string;
  posterUrl?: string;
  positionMs?: number;
  durationMs?: number;
};

export type ChildSearchEvent = {
  profileId: string;
  profileName: string;
  query: string;
  at: string;
};

export type WatchHistoryEntry = {
  contentId: string;
  contentTitle: string;
  contentType: 'movie' | 'series' | 'live' | string;
  startedAt: string;
  endedAt: string;
  durationMin: number;
  hour: number;
};

export type ParentalActivity = {
  profileId: string;
  searches: Array<{ query: string; at: string }>;
  watchHistory: WatchHistoryEntry[];
  minutesByHour: Record<string, number>;
  totalMinutes: number;
};

export type ParentalRules = {
  aggressiveMode: boolean;
  autoBlockOnForbiddenSearch: boolean;
  criticalAlertsEnabled: boolean;
  progressivePenaltyEnabled?: boolean;
  penaltyWindowMinutes?: number;
  step2BlockMinutes?: number;
  step3BlockMinutes?: number;
  forbiddenSearchKeywords: string[];
  maxMinutesPerHour: number;
  maxContinuousMinutes: number;
};

export type ParentalAlertEvent = {
  at: string;
  type: 'forbidden_search' | 'hourly_limit' | 'continuous_limit' | string;
  profileId: string;
  profileName: string;
  message?: string;
  keyword?: string;
  query?: string;
  minutes?: number;
  threshold?: number;
  step?: number;
};

export type ServerHealthState = 'online' | 'overloaded' | 'offline';

export type RealtimeHealthAttempt = {
  url: string;
  endpoint: '/health' | '/api/health';
  ok: boolean;
  httpStatus: number;
  resolvedState: ServerHealthState;
  durationMs: number;
  error: string;
};

export type RealtimeHealthDiagnostics = {
  checkedAt: string;
  state: ServerHealthState;
  activeUrl: string;
  candidates: string[];
  attempts: RealtimeHealthAttempt[];
  lastError: string;
  tokenPresent: boolean;
};

export type ContentBlockedEvent = {
  contentId: string;
  contentTitle?: string;
};

export type SessionStartResult =
  | { ok: true; token: string }
  | { ok: false; locked: boolean; message: string };

type RealtimeSessionMeta = {
  username: string;
  serverUrl: string;
  profileId: string;
};

// ─── Configuração ─────────────────────────────────────────────────────────────

const RT_SERVER_URL_KEY = API_BASE_URL_STORAGE_KEY;
const RT_TOKEN_KEY = 'realtimeServer.token';
const RT_DEVICE_ID_KEY = 'realtimeServer.deviceId';
const RT_SESSION_META_KEY = 'realtimeServer.sessionMeta.v1';
export const RT_BLOCKED_CONTENT_CACHE_KEY = 'realtimeServer.blockedContent.v1';

/** URL padrão do servidor. Altere em Configurações > Conta > Servidor real-time. */
export const DEFAULT_RT_SERVER_URL = PRODUCTION_API_BASE_URL;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let restHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastHealthDiagnostics: RealtimeHealthDiagnostics = {
  checkedAt: '',
  state: 'offline',
  activeUrl: '',
  candidates: [],
  attempts: [],
  lastError: 'Sem verificacao de health ainda.',
  tokenPresent: false,
};

function parseHealthStateFromBody(body: any): ServerHealthState {
  const status = String(body?.status || 'online').toLowerCase();
  if (status === 'overloaded') return 'overloaded';
  if (status === 'offline') return 'offline';
  return 'online';
}

async function probeHealthEndpoint(
  baseUrl: string,
  endpoint: '/health' | '/api/health'
): Promise<RealtimeHealthAttempt> {
  const startedAt = Date.now();
  try {
    const res = await fetchWithTimeout(`${baseUrl}${endpoint}`, {}, 4_500);
    let resolvedState: ServerHealthState = 'offline';
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      resolvedState = parseHealthStateFromBody(body);
    }

    return {
      url: baseUrl,
      endpoint,
      ok: res.ok,
      httpStatus: res.status,
      resolvedState,
      durationMs: Date.now() - startedAt,
      error: res.ok ? '' : `HTTP ${res.status}`,
    };
  } catch (error: any) {
    return {
      url: baseUrl,
      endpoint,
      ok: false,
      httpStatus: 0,
      resolvedState: 'offline',
      durationMs: Date.now() - startedAt,
      error: String(error?.message || error || 'Falha de rede'),
    };
  }
}

const normalizeBaseUrl = normalizeApiBaseUrl;

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isLikelyInvalidForDevice(url: string): boolean {
  const safe = normalizeBaseUrl(url).toLowerCase();
  return (
    safe.includes('10.0.2.2') ||
    safe.includes('10.0.0.') ||
    safe.includes('192.168.') ||
    safe.includes('localhost') ||
    safe.includes('127.0.0.1')
  );
}

async function getRtUrlCandidates(): Promise<string[]> {
  const stored = normalizeBaseUrl((await getDbValue<string>(RT_SERVER_URL_KEY)) || '');
  const appUrl = normalizeBaseUrl(await getAppServerUrl().catch(() => ''));
  const hardDefault = normalizeBaseUrl(DEFAULT_APP_SERVER_URL);
  const fallback = normalizeBaseUrl(DEFAULT_RT_SERVER_URL);

  // Prioriza URL do app server quando a URL salva parece ser localhost/emulador.
  const ordered = isLikelyInvalidForDevice(stored)
    ? [appUrl, hardDefault, stored, fallback]
    : [stored, appUrl, hardDefault, fallback];

    const unique = Array.from(new Set(ordered.filter(Boolean)));

  // Em build de produ��o, nunca tenta URLs locais.
  if (typeof __DEV__ !== 'undefined' && !__DEV__) {
    return unique.filter((url) => !isLikelyInvalidForDevice(url));
  }

  return unique;
}

async function fetchHealthState(baseUrl: string): Promise<{ state: ServerHealthState | null; attempts: RealtimeHealthAttempt[]; lastError: string }> {
  const healthAttempt = await probeHealthEndpoint(baseUrl, '/health');
  if (healthAttempt.resolvedState !== 'offline') {
    return {
      state: healthAttempt.resolvedState,
      attempts: [healthAttempt],
      lastError: '',
    };
  }

  const apiHealthAttempt = await probeHealthEndpoint(baseUrl, '/api/health');
  if (apiHealthAttempt.resolvedState !== 'offline') {
    return {
      state: apiHealthAttempt.resolvedState,
      attempts: [healthAttempt, apiHealthAttempt],
      lastError: '',
    };
  }

  const lastError = apiHealthAttempt.error || healthAttempt.error || 'Servidor offline';
  return {
    state: null,
    attempts: [healthAttempt, apiHealthAttempt],
    lastError,
  };
}

// ─── Callbacks de evento ──────────────────────────────────────────────────────
type PresenceCallback = (profiles: ProfilePresence[]) => void;
type ChildEnteredCallback = (ev: ChildEnteredEvent) => void;
type ChildWatchingCallback = (ev: ChildWatchingEvent) => void;
type ChildSearchCallback = (ev: ChildSearchEvent) => void;
type ContentBlockedCallback = (ev: ContentBlockedEvent) => void;
type BlocksUpdatedCallback = (blockedIds: string[]) => void;
type SessionStolenCallback = (msg: string) => void;
type ParentalAlertCallback = (ev: ParentalAlertEvent) => void;
type ChildOfflineCallback = (ev: ChildEnteredEvent) => void;

const listeners = {
  presenceUpdate: new Set<PresenceCallback>(),
  childEntered: new Set<ChildEnteredCallback>(),
  childWatching: new Set<ChildWatchingCallback>(),
  childSearch: new Set<ChildSearchCallback>(),
  childOffline: new Set<ChildOfflineCallback>(),
  contentBlocked: new Set<ContentBlockedCallback>(),
  blocksUpdated: new Set<BlocksUpdatedCallback>(),
  sessionStolen: new Set<SessionStolenCallback>(),
  parentalAlert: new Set<ParentalAlertCallback>(),
};

function emit<T>(set: Set<(arg: T) => void>, value: T) {
  set.forEach((fn) => { try { fn(value); } catch { /* ignore */ } });
}

async function rtRequest(path: string, options?: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; timeoutMs?: number }) {
  const token = await getDbValue<string>(RT_TOKEN_KEY);
  if (!token) return null;

  const rtUrl = await getRtServerUrl();
  const res = await fetchWithTimeout(
    `${rtUrl}${path}`,
    {
      method: options?.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    },
    options?.timeoutMs ?? 5_000
  );

  return res;
}

async function reportHeartbeat(): Promise<void> {
  try {
    const res = await rtRequest('/api/session/heartbeat', { method: 'POST', timeoutMs: 4_500 });
    if (!res?.ok) {
      return;
    }
  } catch {
    // Mantem fluxo resiliente sem quebrar o app.
  }
}

function startRestHeartbeatLoop() {
  if (restHeartbeatTimer) return;
  void reportHeartbeat();
  restHeartbeatTimer = setInterval(() => {
    void reportHeartbeat();
  }, 20_000);
}

function stopRestHeartbeatLoop() {
  if (!restHeartbeatTimer) return;
  clearInterval(restHeartbeatTimer);
  restHeartbeatTimer = null;
}

// ─── Device ID ───────────────────────────────────────────────────────────────
async function getOrCreateDeviceId(): Promise<string> {
  let id = await getDbValue<string>(RT_DEVICE_ID_KEY);
  if (!id) {
    id = `dev-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    await setDbValue(RT_DEVICE_ID_KEY, id);
  }
  return id;
}

// ─── URL do servidor ──────────────────────────────────────────────────────────
export async function getRtServerUrl(): Promise<string> {
  const candidates = await getRtUrlCandidates();
  if (candidates.length) {
    return candidates[0];
  }
  return DEFAULT_RT_SERVER_URL;
}

export async function setRtServerUrl(url: string): Promise<void> {
  await setDbValue(RT_SERVER_URL_KEY, normalizeBaseUrl(url));
}

// ─── Iniciar sessão (chamado ao selecionar perfil) ────────────────────────────
/**
 * Registra a sessão no servidor e obtém um token JWT.
 * Retorna SESSION_LOCKED (ok: false, locked: true) se o perfil já estiver ativo.
 */
export async function startSession(options: {
  username: string;
  serverUrl: string;
  profileId: string;
  profileName: string;
  kidsMode: boolean;
}): Promise<SessionStartResult> {
  const safeMeta: RealtimeSessionMeta = {
    username: String(options.username || '').trim(),
    serverUrl: String(options.serverUrl || '').trim(),
    profileId: String(options.profileId || '').trim(),
  };

  try {
    const deviceId = await getOrCreateDeviceId();
    const candidates = await getRtUrlCandidates();

    let lastError = 'Erro ao iniciar sessão em tempo real.';

    for (const rtUrl of candidates) {
      try {
        const res = await fetchWithTimeout(
          `${rtUrl}/api/session/start`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...options, deviceId }),
          },
          8_000
        );

        const body = await res.json().catch(() => ({}));

        if (res.status === 409) {
          return { ok: false, locked: true, message: body.message || 'Perfil em uso em outro dispositivo.' };
        }

        if (!res.ok || !body.token) {
          lastError = body.error || `Falha HTTP ${res.status}`;
          continue;
        }

        await Promise.all([
          setDbValue(RT_TOKEN_KEY, body.token),
          setDbValue(RT_SESSION_META_KEY, safeMeta),
          setRtServerUrl(rtUrl),
        ]);
        return { ok: true, token: body.token };
      } catch {
        // Tenta a próxima URL candidata.
      }
    }

    return { ok: false, locked: false, message: lastError };
  } catch {
    // Servidor offline → não bloqueia o acesso, apenas presença fica inativa
    await setDbValue(RT_SESSION_META_KEY, safeMeta);
    return { ok: true, token: '' };
  }
}

export async function ensureRealtimeSessionForActiveProfile(options?: { force?: boolean }): Promise<void> {
  if (isNonMobileDevice()) {
    return;
  }

  const force = options?.force === true;

  const [{ loadAccountSettings }, username, serverUrl, existingToken, existingMeta] = await Promise.all([
    import('@/services/account-settings'),
    getDbValue<string>('username'),
    getDbValue<string>('url'),
    getDbValue<string>(RT_TOKEN_KEY),
    getDbValue<RealtimeSessionMeta>(RT_SESSION_META_KEY),
  ]);

  const safeUsername = String(username || '').trim();
  const safeServerUrl = String(serverUrl || '').trim();
  if (!safeUsername || !safeServerUrl) {
    return;
  }

  const settings = await loadAccountSettings();
  const profile = settings.profiles.find((item) => item.id === settings.activeProfileId);
  if (!profile?.id) {
    return;
  }

  const safeMetaCurrent: RealtimeSessionMeta = {
    username: safeUsername,
    serverUrl: safeServerUrl,
    profileId: String(profile.id || '').trim(),
  };

  const safeMetaSaved: RealtimeSessionMeta = {
    username: String(existingMeta?.username || '').trim(),
    serverUrl: String(existingMeta?.serverUrl || '').trim(),
    profileId: String(existingMeta?.profileId || '').trim(),
  };

  const shouldStartSession =
    force ||
    !existingToken ||
    safeMetaSaved.username !== safeMetaCurrent.username ||
    safeMetaSaved.serverUrl !== safeMetaCurrent.serverUrl ||
    safeMetaSaved.profileId !== safeMetaCurrent.profileId;

  if (shouldStartSession) {
    const rt = await startSession({
      username: safeMetaCurrent.username,
      serverUrl: safeMetaCurrent.serverUrl,
      profileId: safeMetaCurrent.profileId,
      profileName: String(profile.name || 'Perfil'),
      kidsMode: !!profile.kidsMode,
    });

    if (!rt.ok && rt.locked) {
      return;
    }
  }

  startRestHeartbeatLoop();
}

// ─── Desconectar ─────────────────────────────────────────────────────────────
export async function disconnect(): Promise<void> {
  stopRestHeartbeatLoop();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  try {
    const token = await getDbValue<string>(RT_TOKEN_KEY);
    const rtUrl = await getRtServerUrl();
    if (token) {
      await fetchWithTimeout(
        `${rtUrl}/api/session/end`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
        5_000
      );
    }
  } catch { /* Ignora falhas ao desconectar */ }

  await removeDbValue(RT_TOKEN_KEY);
  await removeDbValue(RT_SESSION_META_KEY);
}

// ─── Reportar conteúdo assistindo ────────────────────────────────────────────
export function reportWatching(
  contentId: string,
  contentTitle: string,
  contentType: 'movie' | 'series' | 'live',
  options?: { previewUrl?: string; posterUrl?: string; positionMs?: number; durationMs?: number }
): void {
  void rtRequest('/api/activity/watching/start', {
    method: 'POST',
    body: {
      contentId,
      contentTitle,
      contentType,
      previewUrl: String(options?.previewUrl || '').trim(),
      posterUrl: String(options?.posterUrl || '').trim(),
      positionMs: Math.max(0, Number(options?.positionMs || 0)),
      durationMs: Math.max(0, Number(options?.durationMs || 0)),
    },
    timeoutMs: 5_000,
  }).catch(() => {
    // Evita promessa nao tratada quando houver timeout/rede oscilando.
  });
}

// ─── Reportar parou de assistir ──────────────────────────────────────────────
export function reportStoppedWatching(): void {
  void rtRequest('/api/activity/watching/stop', {
    method: 'POST',
    timeoutMs: 5_000,
  }).catch(() => {
    // Evita promessa nao tratada quando houver timeout/rede oscilando.
  });
}

export async function fetchBlockedContent(): Promise<string[]> {
  try {
    const res = await rtRequest('/api/parental/blocks', { method: 'GET', timeoutMs: 5_000 });
    if (!res?.ok) return [];
    const body = await res.json().catch(() => ({}));
    const blocked = Array.isArray(body?.blocked)
      ? body.blocked.map((item: any) => String(item || '').trim()).filter(Boolean)
      : [];
    await setDbValue(RT_BLOCKED_CONTENT_CACHE_KEY, blocked);
    return blocked;
  } catch {
    return [];
  }
}

export async function loadCachedBlockedContent(): Promise<string[]> {
  const cached = await getDbValue<string[]>(RT_BLOCKED_CONTENT_CACHE_KEY);
  if (!Array.isArray(cached)) return [];
  return cached.map((item) => String(item || '').trim()).filter(Boolean);
}

// ─── Verificar se conteúdo está bloqueado (REST) ──────────────────────────────
export async function isContentBlocked(contentId: string): Promise<boolean> {
  try {
    const token = await getDbValue<string>(RT_TOKEN_KEY);
    if (!token) {
      const cached = await loadCachedBlockedContent();
      return cached.includes(String(contentId || '').trim());
    }
    const rtUrl = await getRtServerUrl();
    const res = await fetchWithTimeout(
      `${rtUrl}/api/parental/blocks`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      5_000
    );
    if (!res.ok) {
      const cached = await loadCachedBlockedContent();
      return cached.includes(String(contentId || '').trim());
    }
    const body = await res.json();
    const blocked = Array.isArray(body?.blocked)
      ? (body.blocked as string[]).map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    await setDbValue(RT_BLOCKED_CONTENT_CACHE_KEY, blocked);
    return blocked.includes(String(contentId || '').trim());
  } catch {
    const cached = await loadCachedBlockedContent();
    return cached.includes(String(contentId || '').trim());
  }
}

// ─── Bloquear conteúdo (chamado pelo pai) ────────────────────────────────────
export async function blockContent(
  targetProfileId: string,
  contentId: string,
  contentTitle: string
): Promise<boolean> {
  try {
    const token = await getDbValue<string>(RT_TOKEN_KEY);
    if (!token) return false;
    const rtUrl = await getRtServerUrl();
    const res = await fetchWithTimeout(
      `${rtUrl}/api/parental/block`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ targetProfileId, contentId, contentTitle }),
      },
      5_000
    );
    if (!res.ok) return false;
    await fetchBlockedContent();
    return true;
  } catch {
    return false;
  }
}

// ─── Desbloquear conteúdo ────────────────────────────────────────────────────
export async function unblockContent(contentId: string): Promise<boolean> {
  try {
    const token = await getDbValue<string>(RT_TOKEN_KEY);
    if (!token) return false;
    const rtUrl = await getRtServerUrl();
    const res = await fetchWithTimeout(
      `${rtUrl}/api/parental/unblock`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ contentId }),
      },
      5_000
    );
    if (!res.ok) return false;
    await fetchBlockedContent();
    return true;
  } catch {
    return false;
  }
}

// ─── Snapshot de presença (REST) ──────────────────────────────────────────────
export async function fetchPresenceSnapshot(): Promise<ProfilePresence[]> {
  try {
    const token = await getDbValue<string>(RT_TOKEN_KEY);
    if (!token) return [];
    const rtUrl = await getRtServerUrl();
    const res = await fetchWithTimeout(
      `${rtUrl}/api/presence`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      5_000
    );
    if (!res.ok) return [];
    const body = await res.json();
    return body.profiles || [];
  } catch {
    return [];
  }
}

export async function fetchParentalActivity(profileId: string): Promise<ParentalActivity | null> {
  try {
    const token = await getDbValue<string>(RT_TOKEN_KEY);
    if (!token) return null;
    const rtUrl = await getRtServerUrl();
    const safeProfileId = encodeURIComponent(String(profileId || '').trim());
    if (!safeProfileId) return null;
    const res = await fetchWithTimeout(
      `${rtUrl}/api/parental/activity/${safeProfileId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      6_000
    );
    if (!res.ok) return null;
    const body = await res.json();
    return (body?.activity || null) as ParentalActivity | null;
  } catch {
    return null;
  }
}

export async function fetchParentalRules(): Promise<ParentalRules | null> {
  try {
    const token = await getDbValue<string>(RT_TOKEN_KEY);
    if (!token) return null;
    const rtUrl = await getRtServerUrl();
    const res = await fetchWithTimeout(
      `${rtUrl}/api/parental/rules`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      6_000
    );
    if (!res.ok) return null;
    const body = await res.json();
    return (body?.rules || null) as ParentalRules | null;
  } catch {
    return null;
  }
}

export async function saveParentalRules(input: Partial<ParentalRules>): Promise<ParentalRules | null> {
  try {
    const token = await getDbValue<string>(RT_TOKEN_KEY);
    if (!token) return null;
    const rtUrl = await getRtServerUrl();
    const res = await fetchWithTimeout(
      `${rtUrl}/api/parental/rules`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input || {}),
      },
      6_000
    );
    if (!res.ok) return null;
    const body = await res.json();
    return (body?.rules || null) as ParentalRules | null;
  } catch {
    return null;
  }
}

export async function reportSearchQuery(query: string): Promise<void> {
  const safeQuery = String(query || '').trim();
  if (safeQuery.length < 2) return;

  try {
    const token = await getDbValue<string>(RT_TOKEN_KEY);
    if (!token) return;
    const rtUrl = await getRtServerUrl();
    await fetchWithTimeout(
      `${rtUrl}/api/activity/search`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: safeQuery }),
      },
      5_000
    );
  } catch {
    // Falha de telemetria realtime nao pode quebrar fluxo principal.
  }
}

// ─── Verificar se servidor está acessível ─────────────────────────────────────
export async function checkServerHealth(): Promise<ServerHealthState> {
  const candidates = await getRtUrlCandidates();
  const token = await getDbValue<string>(RT_TOKEN_KEY);
  const attempts: RealtimeHealthAttempt[] = [];
  let lastError = '';

  for (const rtUrl of candidates) {
    const result = await fetchHealthState(rtUrl);
    attempts.push(...result.attempts);
    if (result.state) {
      await setRtServerUrl(rtUrl);
      lastHealthDiagnostics = {
        checkedAt: new Date().toISOString(),
        state: result.state,
        activeUrl: rtUrl,
        candidates,
        attempts,
        lastError: '',
        tokenPresent: !!token,
      };
      return result.state;
    }
    lastError = result.lastError || lastError;
  }

  lastHealthDiagnostics = {
    checkedAt: new Date().toISOString(),
    state: 'offline',
    activeUrl: '',
    candidates,
    attempts,
    lastError: lastError || 'Servidor offline',
    tokenPresent: !!token,
  };
  return 'offline';
}

export function getRealtimeHealthDiagnostics(): RealtimeHealthDiagnostics {
  return {
    ...lastHealthDiagnostics,
    candidates: [...lastHealthDiagnostics.candidates],
    attempts: [...lastHealthDiagnostics.attempts],
  };
}

// ─── Subscriptions ───────────────────────────────────────────────────────────
export function onPresenceUpdate(cb: PresenceCallback) {
  listeners.presenceUpdate.add(cb);
  return () => listeners.presenceUpdate.delete(cb);
}

export function onChildEntered(cb: ChildEnteredCallback) {
  listeners.childEntered.add(cb);
  return () => listeners.childEntered.delete(cb);
}

export function onChildWatching(cb: ChildWatchingCallback) {
  listeners.childWatching.add(cb);
  return () => listeners.childWatching.delete(cb);
}

export function onChildSearch(cb: ChildSearchCallback) {
  listeners.childSearch.add(cb);
  return () => listeners.childSearch.delete(cb);
}

export function onChildOffline(cb: ChildOfflineCallback) {
  listeners.childOffline.add(cb);
  return () => listeners.childOffline.delete(cb);
}

export function onContentBlocked(cb: ContentBlockedCallback) {
  listeners.contentBlocked.add(cb);
  return () => listeners.contentBlocked.delete(cb);
}

export function onBlocksUpdated(cb: BlocksUpdatedCallback) {
  listeners.blocksUpdated.add(cb);
  return () => listeners.blocksUpdated.delete(cb);
}

export function onSessionStolen(cb: SessionStolenCallback) {
  listeners.sessionStolen.add(cb);
  return () => listeners.sessionStolen.delete(cb);
}

export function onParentalAlert(cb: ParentalAlertCallback) {
  listeners.parentalAlert.add(cb);
  return () => listeners.parentalAlert.delete(cb);
}

// ─── Status interno (para debug) ─────────────────────────────────────────────
export function isSocketConnected(): boolean {
  return false;
}


