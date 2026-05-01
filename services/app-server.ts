import { getDbValue, setDbValue } from '@/services/local-db';

const SERVER_URL_KEY = 'realtimeServer.url';
export const DEFAULT_APP_SERVER_URL = 'http://10.0.2.2:3001';

type ApiOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  token?: string;
  body?: unknown;
  timeoutMs?: number;
};

export async function getAppServerUrl(): Promise<string> {
  const saved = await getDbValue<string>(SERVER_URL_KEY);
  const envUrl = typeof process !== 'undefined' ? process.env.EXPO_PUBLIC_APP_SERVER_URL : '';
  return (saved || envUrl || DEFAULT_APP_SERVER_URL).replace(/\/$/, '');
}

export async function setAppServerUrl(url: string): Promise<void> {
  await setDbValue(SERVER_URL_KEY, String(url || '').trim().replace(/\/$/, ''));
}

export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const baseUrl = await getAppServerUrl();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 9000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = typeof body?.error === 'string' ? body.error : `Erro ${res.status}`;
      throw new Error(message);
    }

    return body as T;
  } finally {
    clearTimeout(timer);
  }
}
