import { getDbValue, setDbValue } from '@/services/local-db';

export type CatalogRefreshPeriod = '2d' | '5d' | '1w' | '1m';

const REFRESH_PERIOD_KEY = 'catalog.refresh.period.v1';
const DEFAULT_REFRESH_PERIOD: CatalogRefreshPeriod = '2d';

const PERIOD_MS: Record<CatalogRefreshPeriod, number> = {
  '2d': 2 * 24 * 60 * 60 * 1000,
  '5d': 5 * 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
};

const VALID_PERIODS: CatalogRefreshPeriod[] = ['2d', '5d', '1w', '1m'];

export const REFRESH_PERIOD_LABELS: Record<CatalogRefreshPeriod, string> = {
  '2d': 'A cada 2 dias',
  '5d': 'A cada 5 dias',
  '1w': 'A cada 1 semana',
  '1m': 'A cada 1 mes',
};

function normalizePeriod(value: unknown): CatalogRefreshPeriod {
  return VALID_PERIODS.includes(value as CatalogRefreshPeriod)
    ? (value as CatalogRefreshPeriod)
    : DEFAULT_REFRESH_PERIOD;
}

export function getRefreshPeriodMs(period: CatalogRefreshPeriod) {
  return PERIOD_MS[period] || PERIOD_MS[DEFAULT_REFRESH_PERIOD];
}

export async function loadCatalogRefreshPeriod(): Promise<CatalogRefreshPeriod> {
  const raw = await getDbValue<string>(REFRESH_PERIOD_KEY);
  return normalizePeriod(raw);
}

export async function saveCatalogRefreshPeriod(period: CatalogRefreshPeriod) {
  const safe = normalizePeriod(period);
  await setDbValue(REFRESH_PERIOD_KEY, safe);
  return safe;
}

export function shouldRefreshCatalog(
  lastUpdateIso: string | null | undefined,
  period: CatalogRefreshPeriod,
  nowTs = Date.now()
) {
  if (!lastUpdateIso) {
    return true;
  }

  const lastTs = new Date(lastUpdateIso).getTime();
  if (!Number.isFinite(lastTs)) {
    return true;
  }

  return nowTs - lastTs >= getRefreshPeriodMs(period);
}

export function getNextCatalogRefreshAt(
  lastUpdateIso: string | null | undefined,
  period: CatalogRefreshPeriod
) {
  if (!lastUpdateIso) {
    return null;
  }

  const lastTs = new Date(lastUpdateIso).getTime();
  if (!Number.isFinite(lastTs)) {
    return null;
  }

  return new Date(lastTs + getRefreshPeriodMs(period)).toISOString();
}
