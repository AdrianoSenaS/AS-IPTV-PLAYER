import { getDbValue, setDbValue, getDbValuesByPrefix, removeDbValue } from '@/services/local-db';
import { scheduleAutoCloudBackup } from '@/services/backup-background';
import {
  loadProfileScopedValue,
  saveProfileScopedValue,
  appendProfileScopedValue,
  getProfileScopedKeyPrefix,
} from '@/services/profile-scoped-storage';
import { reportSearchQuery } from '@/services/realtime-presence';
import { isNonMobileDevice } from '@/services/device-profile';

type BehaviorEventType = 'search' | 'ranking' | 'category' | 'session';

type BehaviorEvent = {
  id: string;
  type: BehaviorEventType;
  value: string;
  context: string;
  at: string;
  weight: number;
};

type BehaviorInsights = {
  searchTokenScores: Record<string, number>;
  hourScores: Record<number, number>;
  categoryScores: Record<string, number>;
  rankingScores: Record<string, number>;
  sessionMinutesByHour: Record<number, number>;
};

export type AlgorithmAgePreference = 'kids' | 'teen' | 'adult' | 'mixed';

export type AlgorithmBootstrapPreferences = {
  favoriteGenres: string[];
  favoriteCategories: string[];
  preferredAge: AlgorithmAgePreference;
  preferredMood: string;
  preferredTypes: Array<'movie' | 'series' | 'live'>;
  createdAt: string;
};

type AlgorithmOnboardingState = {
  done: boolean;
  skipped: boolean;
  completedAt: string;
};

const BEHAVIOR_KEY = 'behavior.events.v1';
const BEHAVIOR_BOOTSTRAP_KEY = 'behavior.bootstrap.preferences.v1';
const BEHAVIOR_ONBOARDING_KEY = 'behavior.onboarding.state.v1';
const BEHAVIOR_ONBOARDING_PENDING_KEY = 'behavior.onboarding.pending.v1';
const BEHAVIOR_FIRST_LOGIN_SEEN_PREFIX = 'behavior.onboarding.first_login_seen.v1';
const BEHAVIOR_VERSION_KEY = 'behavior.version.v1';
const MAX_EVENTS = 4000;

const normalize = (value: string) => value.trim().toLowerCase();

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

async function bumpBehaviorVersion() {
  await saveProfileScopedValue(BEHAVIOR_VERSION_KEY, new Date().toISOString());
}

function toTokens(value: string) {
  return normalize(value)
    .replace(/[.,;:()\[\]{}|/\\!?"'`´~^+=*_<>-]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .slice(0, 12);
}

function hourFromIso(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 20;
  return date.getHours();
}

async function loadBehaviorEventsInternal(): Promise<BehaviorEvent[]> {
  try {
    // Legacy array-based storage used by older versions.
    const legacy = await loadProfileScopedValue<BehaviorEvent[]>(BEHAVIOR_KEY, []);
    const perKeyPrefix = await getProfileScopedKeyPrefix(BEHAVIOR_KEY);
    const per = await getDbValuesByPrefix(perKeyPrefix, MAX_EVENTS);

    const perEvents: BehaviorEvent[] = (per || [])
      .map((r) => {
        const v = r.value as Partial<BehaviorEvent> | null;
        if (!v || !v.type || !v.value) return null;
        return {
          id: String(v.id || `${v.type}-${v.value}-${v.at || Date.now()}`),
          type: String(v.type) as BehaviorEventType,
          value: String(v.value || ''),
          context: String(v.context || 'global'),
          at: String(v.at || r.updatedAt || new Date().toISOString()),
          weight: clamp(Number(v.weight || 1), 0.1, 8),
        } as BehaviorEvent;
      })
      .filter(Boolean) as BehaviorEvent[];

    const legacyEvents: BehaviorEvent[] = Array.isArray(legacy)
      ? legacy
          .filter((entry) => entry && entry.type && entry.value)
          .map((entry) => ({
            id: String(entry.id || `${entry.type}-${entry.value}-${entry.at || Date.now()}`),
            type: entry.type as BehaviorEventType,
            value: String(entry.value || ''),
            context: String(entry.context || 'global'),
            at: String(entry.at || new Date().toISOString()),
            weight: clamp(Number(entry.weight || 1), 0.1, 8),
          }))
      : [];

    const combined = [...perEvents, ...legacyEvents];
    const seen = new Set<string>();
    return combined
      .sort((a, b) => (a.at > b.at ? -1 : 1))
      .filter((entry) => {
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      })
      .slice(0, MAX_EVENTS);
  } catch {
    return [];
  }
}

async function loadAlgorithmOnboardingStateInternal(): Promise<AlgorithmOnboardingState | null> {
  const raw = await loadProfileScopedValue<AlgorithmOnboardingState | null>(BEHAVIOR_ONBOARDING_KEY, null);
  if (!raw || typeof raw !== 'object') return null;
  return {
    done: !!raw.done,
    skipped: !!raw.skipped,
    completedAt: String(raw.completedAt || new Date().toISOString()),
  };
}

function sanitizeList(values: unknown, max = 8) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalize(String(value || '')))
    .filter(Boolean)
    .slice(0, max);
}

export async function loadAlgorithmBootstrapPreferences(): Promise<AlgorithmBootstrapPreferences | null> {
  const raw = await loadProfileScopedValue<AlgorithmBootstrapPreferences | null>(BEHAVIOR_BOOTSTRAP_KEY, null);
  if (!raw || typeof raw !== 'object') return null;

  const preferredAge = String(raw.preferredAge || 'mixed') as AlgorithmAgePreference;
  const safeAge: AlgorithmAgePreference =
    preferredAge === 'kids' || preferredAge === 'teen' || preferredAge === 'adult' ? preferredAge : 'mixed';

  return {
    favoriteGenres: sanitizeList(raw.favoriteGenres),
    favoriteCategories: sanitizeList(raw.favoriteCategories),
    preferredAge: safeAge,
    preferredMood: normalize(String(raw.preferredMood || '')), 
    preferredTypes: sanitizeList(raw.preferredTypes).filter(
      (value): value is 'movie' | 'series' | 'live' => value === 'movie' || value === 'series' || value === 'live'
    ),
    createdAt: String(raw.createdAt || new Date().toISOString()),
  };
}

export async function completeAlgorithmOnboarding(input?: {
  skipped?: boolean;
  preferences?: Partial<AlgorithmBootstrapPreferences>;
}) {
  const skipped = !!input?.skipped;

  if (!skipped && input?.preferences) {
    const normalized: AlgorithmBootstrapPreferences = {
      favoriteGenres: sanitizeList(input.preferences.favoriteGenres),
      favoriteCategories: sanitizeList(input.preferences.favoriteCategories),
      preferredAge:
        input.preferences.preferredAge === 'kids' ||
        input.preferences.preferredAge === 'teen' ||
        input.preferences.preferredAge === 'adult'
          ? input.preferences.preferredAge
          : 'mixed',
      preferredMood: normalize(String(input.preferences.preferredMood || '')), 
      preferredTypes: sanitizeList(input.preferences.preferredTypes).filter(
        (value): value is 'movie' | 'series' | 'live' => value === 'movie' || value === 'series' || value === 'live'
      ),
      createdAt: new Date().toISOString(),
    };

    await saveProfileScopedValue(BEHAVIOR_BOOTSTRAP_KEY, normalized);

    for (const genre of normalized.favoriteGenres.slice(0, 5)) {
      await appendBehaviorEvent({ type: 'search', value: genre, context: 'onboarding', weight: 2.8 });
    }

    for (const category of normalized.favoriteCategories.slice(0, 5)) {
      await appendBehaviorEvent({ type: 'category', value: category, context: 'onboarding', weight: 2.6 });
    }

    if (normalized.preferredMood) {
      await appendBehaviorEvent({
        type: 'search',
        value: normalized.preferredMood,
        context: 'onboarding',
        weight: 2.4,
      });
    }

    if (normalized.preferredAge !== 'mixed') {
      await appendBehaviorEvent({
        type: 'search',
        value: normalized.preferredAge,
        context: 'onboarding-age',
        weight: 2.2,
      });
    }
  }

  await saveProfileScopedValue<AlgorithmOnboardingState>(BEHAVIOR_ONBOARDING_KEY, {
    done: true,
    skipped,
    completedAt: new Date().toISOString(),
  });
  await saveProfileScopedValue(BEHAVIOR_ONBOARDING_PENDING_KEY, false);
  await bumpBehaviorVersion();
  scheduleAutoCloudBackup();
}

export async function prepareAlgorithmOnboardingForFirstLogin(userId: string) {
  const safeUserId = normalize(String(userId || ''));
  if (!safeUserId) return false;

  const seenKey = `${BEHAVIOR_FIRST_LOGIN_SEEN_PREFIX}.${safeUserId}`;
  const alreadySeen = await getDbValue<boolean>(seenKey);
  if (alreadySeen) {
    await saveProfileScopedValue(BEHAVIOR_ONBOARDING_PENDING_KEY, false);
    return false;
  }

  await Promise.all([
    setDbValue(seenKey, true),
    saveProfileScopedValue(BEHAVIOR_ONBOARDING_PENDING_KEY, true),
    saveProfileScopedValue<AlgorithmOnboardingState>(BEHAVIOR_ONBOARDING_KEY, {
      done: false,
      skipped: false,
      completedAt: '',
    }),
    bumpBehaviorVersion(),
  ]);

  return true;
}

export async function markAlgorithmOnboardingPendingForActiveProfile() {
  await Promise.all([
    saveProfileScopedValue(BEHAVIOR_ONBOARDING_PENDING_KEY, true),
    saveProfileScopedValue<AlgorithmOnboardingState>(BEHAVIOR_ONBOARDING_KEY, {
      done: false,
      skipped: false,
      completedAt: '',
    }),
    bumpBehaviorVersion(),
  ]);
}

export async function shouldShowAlgorithmOnboarding() {
  if (isNonMobileDevice()) {
    return false;
  }

  const [onboarding, pending] = await Promise.all([
    loadAlgorithmOnboardingStateInternal(),
    loadProfileScopedValue<boolean>(BEHAVIOR_ONBOARDING_PENDING_KEY, false),
  ]);

  if (onboarding?.done) return false;

  // O onboarding so aparece quando explicitamente marcado como pendente
  // (primeiro login via prepareAlgorithmOnboardingForFirstLogin ou
  // novo perfil via markAlgorithmOnboardingPendingForActiveProfile).
  // O fallback antigo causava exibicao repetida ao nao haver dados de comportamento.
  return !!pending;
}

async function saveBehaviorEvents(events: BehaviorEvent[]) {
  await saveProfileScopedValue(BEHAVIOR_KEY, events.slice(0, MAX_EVENTS));
  await bumpBehaviorVersion();
  scheduleAutoCloudBackup();
}

export async function getBehaviorDataVersion(): Promise<string> {
  const version = await loadProfileScopedValue<string | null>(BEHAVIOR_VERSION_KEY, null);
  return String(version || '0');
}

async function appendBehaviorEvent(input: {
  type: BehaviorEventType;
  value: string;
  context: string;
  weight?: number;
}) {
  const value = normalize(String(input.value || ''));
  if (!value) return;

  const nowIso = new Date().toISOString();
  const nowTs = Date.now();
  const incoming: BehaviorEvent = {
    id: `${input.type}-${value}-${nowTs}`,
    type: input.type,
    value,
    context: String(input.context || 'global'),
    at: nowIso,
    weight: clamp(Number(input.weight || 1), 0.1, 8),
  };

  const deDupMs = input.type === 'session' ? 30_000 : 90_000;
  try {
    const perKeyPrefix = await getProfileScopedKeyPrefix(BEHAVIOR_KEY);
    const recent = await getDbValuesByPrefix(perKeyPrefix, 200);
    const latestSame = (recent || []).find((row) => {
      const v = row.value as Partial<BehaviorEvent> | null;
      return !!v && v.type === incoming.type && v.value === incoming.value && v.context === incoming.context;
    });

    if (latestSame) {
      const ts = new Date(latestSame.updatedAt).getTime();
      if (Number.isFinite(ts) && Math.abs(nowTs - ts) < deDupMs) {
        return;
      }
    }
  } catch {
    // ignore DB lookup failures and continue appending
  }

  await appendProfileScopedValue<BehaviorEvent>(BEHAVIOR_KEY, incoming);

  void (async () => {
    try {
      await bumpBehaviorVersion();
      scheduleAutoCloudBackup();

      const perKeyPrefix = await getProfileScopedKeyPrefix(BEHAVIOR_KEY);
      const rows = await getDbValuesByPrefix(perKeyPrefix);
      if (rows && rows.length > MAX_EVENTS) {
        const toRemove = rows.slice(MAX_EVENTS).map((row) => row.key);
        for (const key of toRemove) {
          await removeDbValue(key);
        }
      }
    } catch {
      // no-op
    }
  })();
}

export async function recordSearchEvent(query: string, context: string) {
  const normalized = normalize(query);
  if (normalized.length < 2) return;
  await appendBehaviorEvent({ type: 'search', value: normalized, context, weight: 1.2 });
  void reportSearchQuery(normalized);
}

export async function recordRankingEvent(mode: string, context: string) {
  await appendBehaviorEvent({ type: 'ranking', value: normalize(mode), context, weight: 1 });
}

export async function recordCategoryEvent(categoryId: string, context: string) {
  const normalized = normalize(categoryId);
  if (!normalized || normalized === 'all') return;
  await appendBehaviorEvent({ type: 'category', value: normalized, context, weight: 1.3 });
}

export async function recordSessionEvent(context: string, durationMs: number) {
  const min = clamp(Math.round(durationMs / 60000), 1, 180);
  await appendBehaviorEvent({
    type: 'session',
    value: `dur:${min}`,
    context,
    weight: clamp(min / 12, 0.4, 8),
  });
}

export async function getBehaviorInsights(): Promise<BehaviorInsights> {
  const [events, bootstrap] = await Promise.all([
    loadBehaviorEventsInternal(),
    loadAlgorithmBootstrapPreferences(),
  ]);
  const searchTokenScores: Record<string, number> = {};
  const hourScores: Record<number, number> = {};
  const categoryScores: Record<string, number> = {};
  const rankingScores: Record<string, number> = {};
  const sessionMinutesByHour: Record<number, number> = {};

  const nowTs = Date.now();

  for (const entry of events.slice(0, 1800)) {
    const ts = new Date(entry.at).getTime();
    const ageH = Number.isFinite(ts) ? Math.max(0, (nowTs - ts) / 3_600_000) : 72;
    const recency = 1 / (1 + ageH / 96);
    const weight = entry.weight * recency;
    const hour = hourFromIso(entry.at);
    hourScores[hour] = (hourScores[hour] || 0) + weight;

    if (entry.type === 'search') {
      for (const token of toTokens(entry.value)) {
        searchTokenScores[token] = (searchTokenScores[token] || 0) + weight;
      }
      continue;
    }

    if (entry.type === 'category') {
      categoryScores[entry.value] = (categoryScores[entry.value] || 0) + weight;
      continue;
    }

    if (entry.type === 'ranking') {
      rankingScores[entry.value] = (rankingScores[entry.value] || 0) + weight;
      continue;
    }

    if (entry.type === 'session') {
      const min = Number(entry.value.replace('dur:', '')) || 0;
      sessionMinutesByHour[hour] = (sessionMinutesByHour[hour] || 0) + min;
    }
  }

  if (bootstrap) {
    for (const token of bootstrap.favoriteGenres) {
      searchTokenScores[token] = (searchTokenScores[token] || 0) + 8;
    }

    for (const category of bootstrap.favoriteCategories) {
      categoryScores[category] = (categoryScores[category] || 0) + 10;
    }

    if (bootstrap.preferredMood) {
      searchTokenScores[bootstrap.preferredMood] = (searchTokenScores[bootstrap.preferredMood] || 0) + 7;
    }

    if (bootstrap.preferredAge === 'kids') {
      categoryScores.infantil = (categoryScores.infantil || 0) + 12;
      searchTokenScores.familia = (searchTokenScores.familia || 0) + 6;
    } else if (bootstrap.preferredAge === 'teen') {
      searchTokenScores.aventura = (searchTokenScores.aventura || 0) + 5;
      searchTokenScores.anime = (searchTokenScores.anime || 0) + 4;
    } else if (bootstrap.preferredAge === 'adult') {
      searchTokenScores.drama = (searchTokenScores.drama || 0) + 4;
      searchTokenScores.suspense = (searchTokenScores.suspense || 0) + 4;
    }
  }

  return {
    searchTokenScores,
    hourScores,
    categoryScores,
    rankingScores,
    sessionMinutesByHour,
  };
}
