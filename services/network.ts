import { CONNECTIVITY_PROBE_URL } from '@/services/api-config';

const CONNECTIVITY_CACHE_TTL_MS = 12_000;
const REQUEST_TIMEOUT_MS = 1_800;

let cachedValue: boolean | null = null;
let cachedAt = 0;

export async function hasInternetConnection() {
  if (cachedValue !== null && Date.now() - cachedAt < CONNECTIVITY_CACHE_TTL_MS) {
    return cachedValue;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const response = await fetch(CONNECTIVITY_PROBE_URL, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });

    clearTimeout(timer);
    cachedValue = response.ok;
    cachedAt = Date.now();
    return cachedValue;
  } catch {
    cachedValue = false;
    cachedAt = Date.now();
    return false;
  }
}
