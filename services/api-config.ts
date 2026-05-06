import { getDbValue, setDbValue } from '@/services/local-db';

export type ApiEnvironment = 'production' | 'local';

export const API_BASE_URL_STORAGE_KEY = 'realtimeServer.url';
export const API_ENV_STORAGE_KEY = 'api.environment';

export const PRODUCTION_API_BASE_URL = 'https://www.asiptv.com.br';
export const LOCAL_API_BASE_URL = 'http://10.0.0.183:3001';
export const CONNECTIVITY_PROBE_URL = 'https://clients3.google.com/generate_204';

export function normalizeApiBaseUrl(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';

  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(withProtocol);
    return `${parsed.protocol}//${parsed.host}`.replace(/\/$/, '');
  } catch {
    return raw.replace(/\/$/, '');
  }
}

export async function getApiEnvironment(): Promise<ApiEnvironment> {
  const saved = String((await getDbValue<string>(API_ENV_STORAGE_KEY)) || '').trim().toLowerCase();
  return saved === 'local' ? 'local' : 'production';
}

export async function setApiEnvironment(env: ApiEnvironment): Promise<void> {
  await setDbValue(API_ENV_STORAGE_KEY, env);
  const url = env === 'local' ? LOCAL_API_BASE_URL : PRODUCTION_API_BASE_URL;
  await setDbValue(API_BASE_URL_STORAGE_KEY, normalizeApiBaseUrl(url));
}

function isLocalUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes('10.0.2.2') ||
    lower.includes('10.0.0.') ||
    lower.includes('192.168.') ||
    lower.includes('localhost') ||
    lower.includes('127.0.0.1')
  );
}

export async function getConfiguredApiBaseUrl(): Promise<string> {
  const saved = normalizeApiBaseUrl((await getDbValue<string>(API_BASE_URL_STORAGE_KEY)) || '');
  const env = await getApiEnvironment();

  // Se a URL salva for local mas o ambiente não estiver explicitamente como 'local',
  // ignora e retorna produção. Evita que IPs de desenvolvimento antigos persistam.
  if (saved) {
    if (isLocalUrl(saved) && env !== 'local') {
      return PRODUCTION_API_BASE_URL;
    }
    return saved;
  }

  return env === 'local' ? LOCAL_API_BASE_URL : PRODUCTION_API_BASE_URL;
}

export async function setConfiguredApiBaseUrl(url: string): Promise<void> {
  const normalized = normalizeApiBaseUrl(url);
  await setDbValue(API_BASE_URL_STORAGE_KEY, normalized);

  if (normalized === normalizeApiBaseUrl(LOCAL_API_BASE_URL)) {
    await setDbValue(API_ENV_STORAGE_KEY, 'local');
  } else if (normalized === normalizeApiBaseUrl(PRODUCTION_API_BASE_URL)) {
    await setDbValue(API_ENV_STORAGE_KEY, 'production');
  }
}

export async function useProductionApi(): Promise<void> {
  await setApiEnvironment('production');
}

export async function useLocalApi(): Promise<void> {
  await setApiEnvironment('local');
}
