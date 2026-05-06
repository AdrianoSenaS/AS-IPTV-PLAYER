/**
 * proxy-settings.ts
 *
 * Gerencia a preferência de proxy de rede do usuário.
 * Quando ativo, todas as URLs de mídia são roteadas pelo servidor AS-IPTV
 * para contornar bloqueios de rede/VPN que filtram tráfego HTTP direto.
 *
 * Requer plano Ultra ou Lifetime (feature 'network_proxy').
 */

import { getDbValue, setDbValue } from '@/services/local-db';
import { getAppServerUrl } from '@/services/app-server';

const PROXY_ENABLED_KEY = 'proxy.network.enabled.v1';
const PROXY_UPSTREAM_URL_KEY = 'proxy.network.upstream.url.v1';
const PROXY_DNS_RESOLVER_KEY = 'proxy.network.dns.resolver.v1';

export type ProxyAdvancedOptions = {
  upstreamProxyUrl: string;
  dnsResolver: string;
};

// ─── Preferência persistida ───────────────────────────────────────────────────

export async function isProxyEnabled(): Promise<boolean> {
  try {
    const val = await getDbValue(PROXY_ENABLED_KEY);
    return val === '1' || val === 'true';
  } catch {
    return false;
  }
}

export async function setProxyEnabled(enabled: boolean): Promise<void> {
  await setDbValue(PROXY_ENABLED_KEY, enabled ? '1' : '0');
}

export async function getProxyAdvancedOptions(): Promise<ProxyAdvancedOptions> {
  try {
    const [upstreamProxyUrl, dnsResolver] = await Promise.all([
      getDbValue<string>(PROXY_UPSTREAM_URL_KEY),
      getDbValue<string>(PROXY_DNS_RESOLVER_KEY),
    ]);
    return {
      upstreamProxyUrl: String(upstreamProxyUrl || '').trim(),
      dnsResolver: String(dnsResolver || '').trim(),
    };
  } catch {
    return {
      upstreamProxyUrl: '',
      dnsResolver: '',
    };
  }
}

export async function setProxyAdvancedOptions(partial: Partial<ProxyAdvancedOptions>): Promise<ProxyAdvancedOptions> {
  const current = await getProxyAdvancedOptions();
  const next: ProxyAdvancedOptions = {
    upstreamProxyUrl: Object.prototype.hasOwnProperty.call(partial || {}, 'upstreamProxyUrl')
      ? String(partial?.upstreamProxyUrl || '').trim()
      : current.upstreamProxyUrl,
    dnsResolver: Object.prototype.hasOwnProperty.call(partial || {}, 'dnsResolver')
      ? String(partial?.dnsResolver || '').trim()
      : current.dnsResolver,
  };

  await Promise.all([
    setDbValue(PROXY_UPSTREAM_URL_KEY, next.upstreamProxyUrl),
    setDbValue(PROXY_DNS_RESOLVER_KEY, next.dnsResolver),
  ]);

  return next;
}

// ─── Geração de session ID estável por perfil/sessão ─────────────────────────

let _sessionId: string | null = null;

export function getProxySessionId(): string {
  if (!_sessionId) {
    _sessionId = `pxs-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
  return _sessionId;
}

export function resetProxySessionId(): void {
  _sessionId = null;
}

export function getCurrentProxySessionId(): string | null {
  return _sessionId;
}

// ─── Wrapper de URL ──────────────────────────────────────────────────────────

/**
 * Se o proxy estiver habilitado e a feature estiver disponível,
 * envolve a URL de mídia pelo endpoint /api/proxy do servidor.
 * Caso contrário, retorna a URL original.
 */
export async function wrapUrlWithProxy(
  url: string,
  options?: { userId?: string; profileName?: string }
): Promise<string> {
  if (!url || !/^https?:\/\//i.test(url)) return url;

  try {
    const base = await getAppServerUrl();
    const origin = new URL(base).origin;
    const sid = getProxySessionId();
    const uid = encodeURIComponent(options?.userId || '');
    const profile = encodeURIComponent(options?.profileName || '');
    const advanced = await getProxyAdvancedOptions();
    const upstreamProxyUrl = String(advanced.upstreamProxyUrl || '').trim();
    const dnsResolver = String(advanced.dnsResolver || '').trim();

    return (
      `${origin}/api/proxy` +
      `?sid=${encodeURIComponent(sid)}` +
      `&uid=${uid}` +
      `&profile=${profile}` +
      (upstreamProxyUrl ? `&p2=${encodeURIComponent(upstreamProxyUrl)}` : '') +
      (dnsResolver ? `&dns=${encodeURIComponent(dnsResolver)}` : '') +
      `&url=${encodeURIComponent(url)}`
    );
  } catch {
    return url;
  }
}

// ─── Heartbeat periódico para manter sessão ativa no admin ───────────────────

let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function startProxyHeartbeat(
  url: string,
  options?: { userId?: string; profileName?: string }
): void {
  stopProxyHeartbeat();
  const ping = () => wrapUrlWithProxy(url, options).catch(() => {});
  ping();
  _heartbeatTimer = setInterval(ping, 30_000);
}

export function stopProxyHeartbeat(): void {
  if (_heartbeatTimer !== null) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

export async function closeProxySession(): Promise<void> {
  const sid = getCurrentProxySessionId();
  if (!sid) return;

  try {
    const base = await getAppServerUrl();
    const origin = new URL(base).origin;
    await fetch(`${origin}/api/proxy/session/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid }),
    });
  } catch {
    // Best-effort: mesmo com falha de rede, limpamos a sessão local.
  } finally {
    resetProxySessionId();
  }
}
