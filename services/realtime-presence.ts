/**
 * realtime-presence.ts
 *
 * Serviço cliente para presença em tempo real, monitoramento parental
 * e session lock. Só funciona se o usuário estiver logado com conta cadastrada.
 *
 * Fluxo:
 *  1. No login do perfil (perfil-acesso.tsx): startSession()
 *  2. Após entrar no app: connectSocket()
 *  3. No player: reportWatching() / reportStoppedWatching()
 *  4. No fechamento do app: disconnect()
 */

import { getDbValue, setDbValue, removeDbValue } from '@/services/local-db';
import { io, Socket } from 'socket.io-client';

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export type WatchingInfo = {
  contentId: string;
  contentTitle: string;
  contentType: 'movie' | 'series' | 'live';
  since: number;
};

export type ProfilePresence = {
  profileId: string;
  profileName: string;
  kidsMode: boolean;
  online: boolean;
  watching: WatchingInfo | null;
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
};

export type ContentBlockedEvent = {
  contentId: string;
  contentTitle?: string;
};

export type SessionStartResult =
  | { ok: true; token: string }
  | { ok: false; locked: boolean; message: string };

// ─── Configuração ─────────────────────────────────────────────────────────────

const RT_SERVER_URL_KEY = 'realtimeServer.url';
const RT_TOKEN_KEY = 'realtimeServer.token';
const RT_DEVICE_ID_KEY = 'realtimeServer.deviceId';

/** URL padrão do servidor. Altere em Configurações > Conta > Servidor real-time. */
export const DEFAULT_RT_SERVER_URL = 'http://10.0.2.2:3001'; // localhost via emulador Android

let socket: Socket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// ─── Callbacks de evento ──────────────────────────────────────────────────────
type PresenceCallback = (profiles: ProfilePresence[]) => void;
type ChildEnteredCallback = (ev: ChildEnteredEvent) => void;
type ChildWatchingCallback = (ev: ChildWatchingEvent) => void;
type ContentBlockedCallback = (ev: ContentBlockedEvent) => void;
type BlocksUpdatedCallback = (blockedIds: string[]) => void;
type SessionStolenCallback = (msg: string) => void;
type ChildOfflineCallback = (ev: ChildEnteredEvent) => void;

const listeners = {
  presenceUpdate: new Set<PresenceCallback>(),
  childEntered: new Set<ChildEnteredCallback>(),
  childWatching: new Set<ChildWatchingCallback>(),
  childOffline: new Set<ChildOfflineCallback>(),
  contentBlocked: new Set<ContentBlockedCallback>(),
  blocksUpdated: new Set<BlocksUpdatedCallback>(),
  sessionStolen: new Set<SessionStolenCallback>(),
};

function emit<T>(set: Set<(arg: T) => void>, value: T) {
  set.forEach((fn) => { try { fn(value); } catch { /* ignore */ } });
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
  const stored = await getDbValue<string>(RT_SERVER_URL_KEY);
  return stored || DEFAULT_RT_SERVER_URL;
}

export async function setRtServerUrl(url: string): Promise<void> {
  await setDbValue(RT_SERVER_URL_KEY, url.trim().replace(/\/$/, ''));
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
  try {
    const rtUrl = await getRtServerUrl();
    const deviceId = await getOrCreateDeviceId();

    const res = await fetch(`${rtUrl}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...options, deviceId }),
      signal: AbortSignal.timeout(8_000),
    });

    const body = await res.json();

    if (res.status === 409) {
      return { ok: false, locked: true, message: body.message || 'Perfil em uso em outro dispositivo.' };
    }

    if (!res.ok || !body.token) {
      return { ok: false, locked: false, message: body.error || 'Erro ao iniciar sessão em tempo real.' };
    }

    await setDbValue(RT_TOKEN_KEY, body.token);
    return { ok: true, token: body.token };
  } catch {
    // Servidor offline → não bloqueia o acesso, apenas presença fica inativa
    return { ok: true, token: '' };
  }
}

// ─── Conectar socket (chamado após entrar no app) ─────────────────────────────
export async function connectSocket(): Promise<void> {
  if (socket?.connected) return;

  const token = await getDbValue<string>(RT_TOKEN_KEY);
  if (!token) return; // usuário sem sessão real-time (modo demo ou servidor offline)

  const rtUrl = await getRtServerUrl();

  socket = io(rtUrl, {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 3_000,
  });

  socket.on('connect', () => {
    // Inicia heartbeat a cada 20s para manter sessão viva
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      socket?.emit('heartbeat');
    }, 20_000);
  });

  socket.on('presence_update', (profiles: ProfilePresence[]) => {
    emit(listeners.presenceUpdate, profiles);
  });

  socket.on('child_entered', (ev: ChildEnteredEvent) => {
    emit(listeners.childEntered, ev);
  });

  socket.on('child_watching', (ev: ChildWatchingEvent) => {
    emit(listeners.childWatching, ev);
  });

  socket.on('child_offline', (ev: ChildEnteredEvent) => {
    emit(listeners.childOffline, ev);
  });

  socket.on('content_blocked', (ev: ContentBlockedEvent) => {
    emit(listeners.contentBlocked, ev);
  });

  socket.on('parental_blocks_updated', (ids: string[]) => {
    emit(listeners.blocksUpdated, ids);
  });

  socket.on('session_stolen', ({ message }: { message: string }) => {
    disconnect();
    emit(listeners.sessionStolen, message);
  });

  socket.on('disconnect', () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  });
}

// ─── Desconectar ─────────────────────────────────────────────────────────────
export async function disconnect(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  try {
    const token = await getDbValue<string>(RT_TOKEN_KEY);
    const rtUrl = await getRtServerUrl();
    if (token) {
      await fetch(`${rtUrl}/api/session/end`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
    }
  } catch { /* Ignora falhas ao desconectar */ }

  await removeDbValue(RT_TOKEN_KEY);
}

// ─── Reportar conteúdo assistindo ────────────────────────────────────────────
export function reportWatching(
  contentId: string,
  contentTitle: string,
  contentType: 'movie' | 'series' | 'live'
): void {
  socket?.emit('watching', { contentId, contentTitle, contentType });
}

// ─── Reportar parou de assistir ──────────────────────────────────────────────
export function reportStoppedWatching(): void {
  socket?.emit('stopped_watching');
}

// ─── Verificar se conteúdo está bloqueado (REST) ──────────────────────────────
export async function isContentBlocked(contentId: string): Promise<boolean> {
  try {
    const token = await getDbValue<string>(RT_TOKEN_KEY);
    if (!token) return false;
    const rtUrl = await getRtServerUrl();
    const res = await fetch(`${rtUrl}/api/parental/blocks`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return (body.blocked as string[]).includes(contentId);
  } catch {
    return false;
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
    const res = await fetch(`${rtUrl}/api/parental/block`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ targetProfileId, contentId, contentTitle }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
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
    const res = await fetch(`${rtUrl}/api/parental/unblock`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contentId }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
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
    const res = await fetch(`${rtUrl}/api/presence`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const body = await res.json();
    return body.profiles || [];
  } catch {
    return [];
  }
}

// ─── Verificar se servidor está acessível ─────────────────────────────────────
export async function checkServerHealth(): Promise<boolean> {
  try {
    const rtUrl = await getRtServerUrl();
    const res = await fetch(`${rtUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
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

// ─── Status interno (para debug) ─────────────────────────────────────────────
export function isSocketConnected(): boolean {
  return socket?.connected === true;
}
