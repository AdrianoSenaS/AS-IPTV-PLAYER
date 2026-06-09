import {
  PRODUCTION_API_BASE_URL,
  LOCAL_API_BASE_URL,
  normalizeApiBaseUrl,
  getConfiguredApiBaseUrl,
  setConfiguredApiBaseUrl,
} from '@/services/api-config';

export const DEFAULT_APP_SERVER_URL = PRODUCTION_API_BASE_URL;
/** @deprecated use normalizeApiBaseUrl from api-config */
const normalizeServerBaseUrl = normalizeApiBaseUrl;

type ApiOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  token?: string;
  body?: unknown;
  timeoutMs?: number;
};

export async function getAppServerUrl(): Promise<string> {
  // Fonte unica: URL configurada em api-config/local-db.
  // Nao usa EXPO_PUBLIC_APP_SERVER_URL para evitar override acidental de producao.
  return getConfiguredApiBaseUrl();
}

export async function setAppServerUrl(url: string): Promise<void> {
  await setConfiguredApiBaseUrl(url);
}

export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const baseUrl = normalizeServerBaseUrl(await getAppServerUrl());
  const timeoutMs = options.timeoutMs ?? 20000;
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
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
    } catch (error: any) {
      const isAbort = String(error?.name || '').toLowerCase() === 'aborterror';
      if (isAbort && attempt < maxAttempts) {
        continue;
      }
      if (isAbort) {
        throw new Error(`Tempo esgotado ao conectar com ${baseUrl}. Verifique a URL do servidor e sua conexao.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Tempo esgotado ao conectar com ${baseUrl}. Verifique a URL do servidor e sua conexao.`);
}
