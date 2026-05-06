import { getDbValue, setDbValue } from '@/services/local-db';
import { scheduleAutoCloudBackup } from '@/services/backup-background';
import { loadProfileScopedValue, saveProfileScopedValue } from '@/services/profile-scoped-storage';

import { AccountSettingsState } from '@/services/account-settings';
import { loadAccountSettings } from '@/services/account-settings';
import { getAiLearningWindowMs, getAiSignalLimit, getAiSignalStoreLimit } from '@/services/ai-settings';
import { getBehaviorDataVersion, getBehaviorInsights } from '@/services/behavior-intelligence';
import { loadCatalogData, StreamItem, toText } from '@/services/catalog-data';
import { loadMovieProgressMap, MovieProgressMap } from '@/services/movie-progress';
import { loadSeriesProgressMap, SeriesProgressMap } from '@/services/series-progress';

export type TasteContentType = 'movie' | 'series' | 'live';

export type WatchSignal = {
  id: string;
  contentId: string;
  type: TasteContentType;
  progressPercent: number;
  positionMs: number;
  durationMs: number;
  updatedAt: string;
};

export type UserTasteProfile = {
  generatedAt: string;
  genreScores: Record<string, number>;
  categoryScores: Record<string, number>;
  titleTokenScores: Record<string, number>;
  hourScores: Record<number, number>;
  typeScores: Record<TasteContentType, number>;
  contentAffinity: Record<string, number>;
  rankingScores: Record<string, number>;
  favoriteHours: number[];
  prefersWeekend: boolean;
  kidsMode: boolean;
  averageWatchPercent: number;
  // Campos de inteligência dinâmica
  topGenreTokens: string[];
  topCategoryNames: string[];
  inProgressIds: Record<string, number>;
  completedIds: Record<string, number>;
  abandonedTokens: Record<string, number>;
  completionRate: number;
};

const WATCH_SIGNAL_KEY = 'taste.watchSignals.v1';
const TASTE_PROFILE_CACHE_KEY = 'taste.profile.cache.v1';
// Mantem a mesma seed enquanto o app esta aberto; so muda ao reiniciar o app.
const APP_BOOT_RECOMMENDATION_SEED = new Date().toISOString();
const PROFILE_CACHE_TTL_MS = 90 * 1000;
const PROFILE_PERSISTED_TTL_MS = 1000 * 60 * 60 * 24 * 2;

type CachedTasteProfileEntry = {
  profile: UserTasteProfile;
  fingerprint: string;
  cachedAt: number;
};

const tasteProfileCache = new Map<string, CachedTasteProfileEntry>();

async function loadPersistedTasteProfileEntry(): Promise<CachedTasteProfileEntry | null> {
  try {
    const raw = await loadProfileScopedValue<CachedTasteProfileEntry | null>(TASTE_PROFILE_CACHE_KEY, null);
    if (!raw || typeof raw !== 'object') return null;
    if (!raw.profile || !raw.fingerprint) return null;
    if (!Number.isFinite(Number(raw.cachedAt || 0))) return null;

    return {
      profile: raw.profile,
      fingerprint: String(raw.fingerprint),
      cachedAt: Number(raw.cachedAt),
    };
  } catch {
    return null;
  }
}

async function savePersistedTasteProfileEntry(entry: CachedTasteProfileEntry): Promise<void> {
  await saveProfileScopedValue(TASTE_PROFILE_CACHE_KEY, entry);
}

// ─── Tabelas de frases por contexto ─────────────────────────────────────────
const PHRASES_GENERAL = [
  'Você pode gostar disso',
  'Recomendado para você',
  'Baseado no seu gosto',
  'Escolha perfeita pra agora',
  'Isso combina com você',
  'Conteúdo ideal pra você',
  'Achamos isso pra você',
  'Você vai curtir isso',
  'Sugestão do momento',
  'Vale a pena assistir',
];

const PHRASES_TIME_NIGHT = [
  'Boa escolha pra noite',
  'Hora de maratonar',
  'Noite perfeita pra assistir',
  'Sessão da noite começando',
  'Ideal pra relaxar agora',
];

const PHRASES_TIME_DAY = [
  'Perfeito pra sua tarde',
  'Algo leve pra esse momento',
  'Ideal pra esse horário',
  'Perfeito pra assistir agora',
  'Comece algo novo agora',
];

const PHRASES_TIME_MORNING = [
  'Algo rápido pra você',
  'Assista sem compromisso',
  'Comece bem o dia',
  'Conteúdo leve pra manhã',
  'Perfeito pra esse horário',
];

const PHRASES_CONTINUE = [
  'Você parou aqui',
  'Volte de onde parou',
  'Terminar o que começou?',
  'Continue sua jornada',
  'Retome agora',
  'Ainda falta terminar',
  'Continue esse conteúdo',
  'Último assistido',
  'Seguir assistindo',
];

const PHRASES_BEHAVIOR = [
  'Você assistiu algo parecido',
  'Baseado no seu histórico',
  'Inspirado no que você viu',
  'Porque você gostou de outros',
  'Similar ao que você curte',
  'No seu estilo',
  'Do seu tipo',
  'Combina com seu perfil',
  'Recomendado pelo seu padrão',
  'Seu tipo de conteúdo',
];

const PHRASES_TRENDING = [
  'Em alta agora',
  'Todo mundo está vendo',
  'Tendência do momento',
  'Popular hoje',
  'O mais assistido',
  'Bombando agora',
  'Top da semana',
  'Destaque do dia',
  'Sucesso entre usuários',
  'Viral no momento',
];

const PHRASES_ENGAGEMENT = [
  'Comece agora',
  'Assista já',
  'Não perca',
  'Vale o play',
  'Dá uma chance',
  'Só um episódio',
  'Teste rápido',
  'Veja agora',
  'Play imediato',
  'Clique e assista',
];

type GenreMood = 'comedy' | 'action' | 'drama' | 'horror' | 'romance' | 'animation' | 'scifi' | 'binge';

const GENRE_MOOD_PHRASES: Record<GenreMood, string[]> = {
  comedy:    ['Para rir agora', 'Comédia leve', 'Levanta o humor', 'Diversão garantida'],
  action:    ['Cheio de ação', 'Adrenalina garantida', 'Para quem curte ação', 'Conteúdo intenso'],
  drama:     ['Drama envolvente', 'História que emociona', 'Prepare o coração', 'Para se emocionar'],
  horror:    ['Suspense garantido', 'Para os corajosos', 'Arrepios garantidos', 'Tensão do início ao fim'],
  romance:   ['História de amor', 'Romance envolvente', 'Para se emocionar', 'Clima de romance'],
  animation: ['Animação imperdível', 'Para toda a família', 'Aventura animada', 'Leveza garantida'],
  scifi:     ['Ficção científica incrível', 'Ciência e fantasia', 'Viagem ao futuro', 'Mundo imaginário'],
  binge:     ['História viciante', 'Para maratonar', 'Um episódio puxa outro', 'Impossível parar'],
};

const GENRE_MOOD_KEYWORDS: Array<{ mood: GenreMood; keys: string[] }> = [
  { mood: 'comedy',    keys: ['comedia', 'comédia', 'comedy', 'humor', 'divertido', 'comico', 'cômico', 'funny'] },
  { mood: 'horror',    keys: ['terror', 'horror', 'medo', 'assombro', 'suspense', 'thriller'] },
  { mood: 'romance',   keys: ['romance', 'amor', 'love', 'paixao', 'paixão', 'romantico', 'romântico', 'romantic'] },
  { mood: 'animation', keys: ['animacao', 'animação', 'animation', 'anime', 'infantil', 'cartoon'] },
  { mood: 'scifi',     keys: ['ficcao', 'ficção', 'sci-fi', 'scifi', 'espaco', 'espaço', 'space', 'science', 'futuro', 'robo', 'robô'] },
  { mood: 'action',    keys: ['acao', 'ação', 'action', 'combate', 'guerra', 'luta', 'policial', 'aventura', 'adventure'] },
  { mood: 'binge',     keys: ['serie', 'série', 'temporada', 'season', 'episodio', 'episódio', 'episode', 'maratona'] },
  { mood: 'drama',     keys: ['drama', 'emocional', 'familia', 'família', 'family', 'crime', 'misterio', 'mistério', 'mystery'] },
];

function foldText(value: string) {
  return normalize(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function toFoldedTokens(value: string) {
  return foldText(value)
    .replace(/[.,;:()\[\]{}|/\\!?"'`´~^+=*_<>-]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function extractReleaseYear(item: StreamItem): number | null {
  const raw = `${toText((item as any).year)} ${toText((item as any).release_date)} ${toText((item as any).releasedate)} ${toText((item as any).releaseDate)} ${toText((item as any).releaseYear)}`;
  const match = raw.match(/(19|20)\d{2}/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function getNormalizedRating(item: StreamItem) {
  const rawRating = parseFloat(String((item as any).rating || 0));
  const rawRating5 = parseFloat(String((item as any).rating_5based || 0));
  return rawRating >= 1 ? rawRating : rawRating5 * 2;
}

function getMoodKeywordSet(mood: GenreMood) {
  return GENRE_MOOD_KEYWORDS.find((entry) => entry.mood === mood)?.keys || [];
}

function getMoodProfileAffinity(mood: GenreMood, profile: UserTasteProfile) {
  const keys = getMoodKeywordSet(mood).map((token) => foldText(token));
  if (!keys.length) return 0;

  const scores = keys.map((token) => {
    const genre = profile.genreScores[token] || 0;
    const title = profile.titleTokenScores[token] || 0;
    return genre * 1.1 + title * 0.8;
  });

  const top = scores.sort((a, b) => b - a).slice(0, 4);
  return top.length ? top.reduce((sum, value) => sum + value, 0) / top.length : 0;
}

function getMoodMatches(item: StreamItem) {
  const genreAndCategory = foldText(`${toText((item as any).genre)} ${toText((item as any).category_name)}`);
  const titleAndPlot = foldText(`${toText(item.title || item.name)} ${toText((item as any).plot)}`);
  const foldedTokens = new Set(toFoldedTokens(`${genreAndCategory} ${titleAndPlot}`));

  const matches = GENRE_MOOD_KEYWORDS.map(({ mood, keys }) => {
    let score = 0;
    keys.forEach((key) => {
      const foldedKey = foldText(key);
      if (genreAndCategory.includes(foldedKey)) score += 2.2;
      if (titleAndPlot.includes(foldedKey)) score += 1.1;
      if (foldedTokens.has(foldedKey)) score += 0.6;
    });
    return { mood, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return matches;
}

function detectGenreMood(item: StreamItem): GenreMood | null {
  const matches = getMoodMatches(item);
  const top = matches[0];
  if (!top) return null;
  if (top.score < 2.2) return null;
  return top.mood;
}

function getTasteProfileCacheKey(settings?: Pick<AccountSettingsState, 'activeProfileId'> | null) {
  return String(settings?.activeProfileId || 'default');
}

function getLatestMovieProgressStamp(movieProgressMap: MovieProgressMap) {
  let latest = '';
  let count = 0;
  Object.values(movieProgressMap).forEach((state) => {
    count += 1;
    if (state.updatedAt && state.updatedAt > latest) {
      latest = state.updatedAt;
    }
  });
  return `${count}:${latest}`;
}

function getLatestSeriesProgressStamp(seriesProgressMap: SeriesProgressMap) {
  let latest = '';
  let count = 0;
  Object.values(seriesProgressMap).forEach((seriesState) => {
    Object.values(seriesState.episodes || {}).forEach((episodeState) => {
      count += 1;
      if (episodeState.updatedAt && episodeState.updatedAt > latest) {
        latest = episodeState.updatedAt;
      }
    });
  });
  return `${count}:${latest}`;
}

function buildTasteFingerprint(input: {
  settings: AccountSettingsState;
  catalog: { vod: StreamItem[]; series: StreamItem[]; liveStreams: StreamItem[] };
  movieProgressMap: MovieProgressMap;
  seriesProgressMap: SeriesProgressMap;
  storedSignals: WatchSignal[];
  behaviorVersion: string;
}) {
  const activeProfile = input.settings.profiles.find((profile) => profile.id === input.settings.activeProfileId);
  const latestSignalAt = input.storedSignals[0]?.updatedAt || '';
  return [
    input.settings.activeProfileId,
    activeProfile?.kidsMode ? 'kids' : 'adult',
    input.catalog.vod.length,
    input.catalog.series.length,
    input.catalog.liveStreams.length,
    getLatestMovieProgressStamp(input.movieProgressMap),
    getLatestSeriesProgressStamp(input.seriesProgressMap),
    input.storedSignals.length,
    latestSignalAt,
    input.behaviorVersion,
  ].join('|');
}

export function getCachedTasteProfileSnapshot(settings?: Pick<AccountSettingsState, 'activeProfileId'> | null) {
  const entry = tasteProfileCache.get(getTasteProfileCacheKey(settings));
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > PROFILE_CACHE_TTL_MS) return null;
  return entry.profile;
}

export async function getPersistedTasteProfileSnapshot(
  settings?: Pick<AccountSettingsState, 'activeProfileId'> | null,
  maxAgeMs?: number
) {
  const safeMaxAgeMs = typeof maxAgeMs === 'number' ? maxAgeMs : await getAiLearningWindowMs();
  const memory = getCachedTasteProfileSnapshot(settings);
  if (memory) return memory;

  const persisted = await loadPersistedTasteProfileEntry();
  if (!persisted) return null;
  if (Date.now() - persisted.cachedAt > safeMaxAgeMs) return null;

  const cacheKey = getTasteProfileCacheKey(settings);
  tasteProfileCache.set(cacheKey, persisted);
  return persisted.profile;
}

export async function shouldRefreshTasteProfile(
  settings?: Pick<AccountSettingsState, 'activeProfileId'> | null,
  refreshWindowMs?: number
) {
  const safeRefreshWindowMs = typeof refreshWindowMs === 'number' ? refreshWindowMs : await getAiLearningWindowMs();
  const memoryEntry = tasteProfileCache.get(getTasteProfileCacheKey(settings));
  if (memoryEntry && Date.now() - memoryEntry.cachedAt <= safeRefreshWindowMs) {
    return false;
  }

  const persisted = await loadPersistedTasteProfileEntry();
  if (!persisted) return true;
  return Date.now() - persisted.cachedAt > safeRefreshWindowMs;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const normalize = (value: string) => value.trim().toLowerCase();

const toTokens = (value: string) =>
  normalize(value)
    .replace(/[.,;:()\[\]{}|/\\!?"'`´~^+=*_<>-]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);

async function saveWatchSignals(signals: WatchSignal[]) {
  await saveProfileScopedValue(WATCH_SIGNAL_KEY, signals);
}

export async function loadWatchSignals(): Promise<WatchSignal[]> {
  try {
    const parsed = await loadProfileScopedValue<WatchSignal[]>(WATCH_SIGNAL_KEY, []);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((entry) => entry && entry.contentId && entry.type)
      .map((entry) => ({
        id: String(entry.id || `${entry.type}-${entry.contentId}-${entry.updatedAt || Date.now()}`),
        contentId: String(entry.contentId),
        type: (entry.type === 'series' || entry.type === 'live' ? entry.type : 'movie') as TasteContentType,
        progressPercent: clamp(Number(entry.progressPercent || 0), 0, 100),
        positionMs: Math.max(0, Number(entry.positionMs || 0)),
        durationMs: Math.max(0, Number(entry.durationMs || 0)),
        updatedAt: String(entry.updatedAt || new Date().toISOString()),
      }))
      .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
  } catch {
    return [];
  }
}

export async function recordWatchSignal(input: {
  contentId: string;
  type: TasteContentType;
  progressPercent: number;
  positionMs: number;
  durationMs: number;
}) {
  const contentId = String(input.contentId || '').trim();
  if (!contentId) return;

  const now = new Date().toISOString();
  const nextEntry: WatchSignal = {
    id: `${input.type}-${contentId}-${Date.now()}`,
    contentId,
    type: input.type,
    progressPercent: clamp(Math.round(input.progressPercent), 0, 100),
    positionMs: Math.max(0, Math.floor(input.positionMs || 0)),
    durationMs: Math.max(0, Math.floor(input.durationMs || 0)),
    updatedAt: now,
  };

  const current = await loadWatchSignals();
  const deDupeWindowMs = 90 * 1000;
  const merged = [nextEntry, ...current].filter((entry, index, list) => {
    if (index === 0) return true;
    const latestSimilar = list
      .slice(0, index)
      .find((probe) => probe.contentId === entry.contentId && probe.type === entry.type);

    if (!latestSimilar) return true;

    const t1 = new Date(latestSimilar.updatedAt).getTime();
    const t2 = new Date(entry.updatedAt).getTime();
    if (Math.abs(t1 - t2) < deDupeWindowMs) {
      return false;
    }

    return true;
  });

  const signalStoreLimit = await getAiSignalStoreLimit();
  await saveWatchSignals(merged.slice(0, signalStoreLimit));
  scheduleAutoCloudBackup();
}

function addWeight(bucket: Record<string, number>, key: string, weight: number) {
  if (!key) return;
  bucket[key] = (bucket[key] || 0) + weight;
}

function addHourWeight(bucket: Record<number, number>, hour: number, weight: number) {
  const safeHour = clamp(Math.floor(hour), 0, 23);
  bucket[safeHour] = (bucket[safeHour] || 0) + weight;
}

function extractItemGenreText(item?: StreamItem) {
  if (!item) return '';
  return `${toText((item as any).genre)} ${toText(item.title || item.name)} ${toText((item as any).plot)}`;
}

function extractCategoryName(item?: StreamItem) {
  if (!item) return '';
  return toText((item as any).category_name);
}

function parseHour(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 20;
  return date.getHours();
}

function isWeekendIso(iso: string) {
  const day = new Date(iso).getDay();
  return day === 0 || day === 6;
}

function buildCatalogIndexes(catalog: {
  vod: StreamItem[];
  series: StreamItem[];
  liveStreams: StreamItem[];
}) {
  const movieById: Record<string, StreamItem> = {};
  const seriesById: Record<string, StreamItem> = {};
  const liveById: Record<string, StreamItem> = {};

  catalog.vod.forEach((item) => {
    const id = toText(item.stream_id);
    if (id) movieById[id] = item;
  });

  catalog.series.forEach((item) => {
    const id = toText(item.series_id);
    if (id) seriesById[id] = item;
  });

  catalog.liveStreams.forEach((item) => {
    const id = toText(item.stream_id);
    if (id) liveById[id] = item;
  });

  return { movieById, seriesById, liveById };
}

function synthesizeSignalsFromProgress(
  movieProgressMap: MovieProgressMap,
  seriesProgressMap: SeriesProgressMap
): WatchSignal[] {
  const movieSignals = Object.entries(movieProgressMap)
    .filter(([, state]) => state.progressPercent > 0)
    .map(([movieId, state]) => ({
      id: `movie-${movieId}-${state.updatedAt}`,
      contentId: movieId,
      type: 'movie' as const,
      progressPercent: clamp(state.progressPercent || 0, 0, 100),
      positionMs: Math.max(0, state.positionMs || 0),
      durationMs: Math.max(0, state.durationMs || 0),
      updatedAt: state.updatedAt || new Date().toISOString(),
    }));

  const seriesSignals: WatchSignal[] = [];
  Object.entries(seriesProgressMap).forEach(([seriesId, seriesState]) => {
    Object.values(seriesState.episodes || {}).forEach((episodeState) => {
      if ((episodeState.progress || 0) <= 0) return;
      seriesSignals.push({
        id: `series-${seriesId}-${episodeState.updatedAt}`,
        contentId: seriesId,
        type: 'series',
        progressPercent: clamp(episodeState.progress || 0, 0, 100),
        positionMs: Math.max(0, episodeState.positionMs || 0),
        durationMs: Math.max(0, episodeState.durationMs || 0),
        updatedAt: episodeState.updatedAt || new Date().toISOString(),
      });
    });
  });

  return [...movieSignals, ...seriesSignals];
}

export async function buildUserTasteProfile(input?: {
  settings?: AccountSettingsState;
  catalog?: { vod: StreamItem[]; series: StreamItem[]; liveStreams: StreamItem[] };
  movieProgressMap?: MovieProgressMap;
  seriesProgressMap?: SeriesProgressMap;
}) {
  const [settings, catalogRaw, movieProgressMap, seriesProgressMap, storedSignals, behaviorVersion, signalLimit, learningWindowMs] = await Promise.all([
    input?.settings ? Promise.resolve(input.settings) : loadAccountSettings(),
    input?.catalog
      ? Promise.resolve(input.catalog)
      : loadCatalogData().then((catalog) => ({
          vod: catalog.vod,
          series: catalog.series,
          liveStreams: catalog.liveStreams,
        })),
    input?.movieProgressMap ? Promise.resolve(input.movieProgressMap) : loadMovieProgressMap(),
    input?.seriesProgressMap ? Promise.resolve(input.seriesProgressMap) : loadSeriesProgressMap(),
    loadWatchSignals(),
    getBehaviorDataVersion(),
    getAiSignalLimit(),
    getAiLearningWindowMs(),
  ]);

  const catalog = catalogRaw;
  const cacheKey = getTasteProfileCacheKey(settings);
  const fingerprint = buildTasteFingerprint({
    settings,
    catalog,
    movieProgressMap,
    seriesProgressMap,
    storedSignals,
    behaviorVersion,
  });
  const cached = tasteProfileCache.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint && Date.now() - cached.cachedAt <= PROFILE_CACHE_TTL_MS) {
    return cached.profile;
  }

  const persisted = await loadPersistedTasteProfileEntry();
  if (persisted && persisted.fingerprint === fingerprint && Date.now() - persisted.cachedAt <= learningWindowMs) {
    tasteProfileCache.set(cacheKey, persisted);
    return persisted.profile;
  }

  const behavior = await getBehaviorInsights();
  const indexes = buildCatalogIndexes(catalog);
  const fallbackSignals = synthesizeSignalsFromProgress(movieProgressMap, seriesProgressMap);

  const mergedSignals = [...storedSignals, ...fallbackSignals];
  const allSignals =
    mergedSignals.length > signalLimit
      ? mergedSignals
          .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1))
          .slice(0, signalLimit)
      : mergedSignals;

  const genreScores: Record<string, number> = {};
  const categoryScores: Record<string, number> = {};
  const titleTokenScores: Record<string, number> = {};
  const hourScores: Record<number, number> = {};
  const typeScores: Record<TasteContentType, number> = { movie: 0, series: 0, live: 0 };
  const contentAffinity: Record<string, number> = {};
  const rankingScores: Record<string, number> = { ...behavior.rankingScores };

  const inProgressIds: Record<string, number> = {};
  const completedIds: Record<string, number> = {};
  const abandonedTokens: Record<string, number> = {};

  let weekendWeight = 0;
  let weekdayWeight = 0;
  let progressAccumulator = 0;

  const now = Date.now();
  const sourceTraitsCache = new Map<
    string,
    {
      categoryId: string;
      categoryName: string;
      genreTokens: string[];
      titleTokens: string[];
    }
  >();

  allSignals.forEach((signal) => {
    const sourceItem =
      signal.type === 'movie'
        ? indexes.movieById[signal.contentId]
        : signal.type === 'series'
          ? indexes.seriesById[signal.contentId]
          : indexes.liveById[signal.contentId];

    const signalTime = new Date(signal.updatedAt).getTime();
    const ageHours = Number.isFinite(signalTime) ? Math.max(0, (now - signalTime) / 3_600_000) : 24;
    const recencyBoost = 1 / (1 + ageHours / 72);

    const watchDepth = clamp(signal.progressPercent / 100, 0.05, 1);
    const durationMin = signal.durationMs > 0 ? signal.durationMs / 60000 : signal.positionMs / 60000;
    const durationBoost = clamp(durationMin / 45, 0.35, 2.2);
    const weight = watchDepth * durationBoost * recencyBoost;

    // Rastreia progresso: em andamento, concluído e abandonado
    if (signal.progressPercent >= 90) {
      completedIds[signal.contentId] = (completedIds[signal.contentId] || 0) + 1;
    } else if (signal.progressPercent >= 5) {
      const prev = inProgressIds[signal.contentId] || 0;
      if (signal.progressPercent > prev) {
        inProgressIds[signal.contentId] = signal.progressPercent;
      }
    }
    if (signal.progressPercent < 22 && signal.durationMs > 180_000) {
      toTokens(extractItemGenreText(sourceItem)).forEach((token) => {
        abandonedTokens[token] = (abandonedTokens[token] || 0) + 0.25;
      });
    }

    progressAccumulator += signal.progressPercent;
    typeScores[signal.type] += weight;
    contentAffinity[`${signal.type}:${signal.contentId}`] =
      (contentAffinity[`${signal.type}:${signal.contentId}`] || 0) + weight;

    const cacheKeyForSignal = `${signal.type}:${signal.contentId}`;
    let traits = sourceTraitsCache.get(cacheKeyForSignal);
    if (!traits) {
      traits = {
        categoryId: toText((sourceItem as any)?.category_id),
        categoryName: normalize(extractCategoryName(sourceItem)),
        genreTokens: toTokens(extractItemGenreText(sourceItem)),
        titleTokens: toTokens(toText((sourceItem as any)?.title || (sourceItem as any)?.name)),
      };
      sourceTraitsCache.set(cacheKeyForSignal, traits);
    }

    const categoryId = traits.categoryId;
    if (categoryId) {
      addWeight(categoryScores, categoryId, weight * 1.4);
    }

    const categoryName = traits.categoryName;
    if (categoryName) {
      addWeight(categoryScores, categoryName, weight * 1.15);
    }

    traits.genreTokens.forEach((token) => addWeight(genreScores, token, weight));
    traits.titleTokens.forEach((token) => addWeight(titleTokenScores, token, weight * 0.85));

    const hour = parseHour(signal.updatedAt);
    addHourWeight(hourScores, hour, weight);

    if (isWeekendIso(signal.updatedAt)) weekendWeight += weight;
    else weekdayWeight += weight;
  });

  Object.entries(behavior.searchTokenScores).forEach(([token, score]) => {
    addWeight(genreScores, token, score * 0.95);
    addWeight(titleTokenScores, token, score * 0.75);
  });

  Object.entries(behavior.categoryScores).forEach(([cat, score]) => {
    addWeight(categoryScores, cat, score * 1.25);
  });

  Object.entries(behavior.hourScores).forEach(([hour, score]) => {
    const h = Number(hour);
    addHourWeight(hourScores, h, score * 0.9);
  });

  const favoriteHours = Object.entries(hourScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([hour]) => Number(hour));

  const activeProfile = settings.profiles.find((profile) => profile.id === settings.activeProfileId);

  const topGenreTokens = Object.entries(genreScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([token]) => token);

  const topCategoryNames = Object.entries(categoryScores)
    .filter(([key]) => Number.isNaN(Number(key)) && key.length > 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);

  const completedCount = Object.values(completedIds).reduce((sum, n) => sum + n, 0);
  const completionRate = allSignals.length > 0
    ? Math.round((completedCount / Math.max(1, allSignals.length)) * 100)
    : 0;

  const nextProfile = {
    generatedAt: APP_BOOT_RECOMMENDATION_SEED,
    genreScores,
    categoryScores,
    titleTokenScores,
    hourScores,
    typeScores,
    contentAffinity,
    rankingScores,
    favoriteHours,
    prefersWeekend: weekendWeight >= weekdayWeight,
    kidsMode: !!activeProfile?.kidsMode,
    averageWatchPercent: allSignals.length ? Math.round(progressAccumulator / allSignals.length) : 0,
    topGenreTokens,
    topCategoryNames,
    inProgressIds,
    completedIds,
    abandonedTokens,
    completionRate,
  } satisfies UserTasteProfile;

  tasteProfileCache.set(cacheKey, {
    profile: nextProfile,
    fingerprint,
    cachedAt: Date.now(),
  });

  await savePersistedTasteProfileEntry({
    profile: nextProfile,
    fingerprint,
    cachedAt: Date.now(),
  });

  return nextProfile;
}

function hourDistance(a: number, b: number) {
  const direct = Math.abs(a - b);
  return Math.min(direct, 24 - direct);
}

function inferMatureContentScore(item: StreamItem) {
  const text = `${toText(item.title || item.name)} ${toText((item as any).genre)} ${toText((item as any).category_name)}`.toLowerCase();
  const adultSignals = ['adult', '18+', 'xxx', 'porn', 'erot', 'sex'];
  return adultSignals.some((flag) => text.includes(flag)) ? 1 : 0;
}

function inferBingePotential(item: StreamItem) {
  const text = `${toText(item.title || item.name)} ${toText((item as any).genre)} ${toText((item as any).plot)}`.toLowerCase();
  const bingeSignals = ['serie', 'série', 'temporada', 'season', 'episodio', 'episode', 'maratona'];
  return bingeSignals.some((flag) => text.includes(flag)) ? 1 : 0;
}

export function scoreItemByTaste(
  item: StreamItem,
  type: TasteContentType,
  profile: UserTasteProfile,
  nowDate = new Date()
) {
  const title = toText(item.title || item.name, '');
  const description = toText((item as any).plot, '');
  const categoryId = toText((item as any).category_id);
  const categoryName = normalize(toText((item as any).category_name));
  const genreText = `${toText((item as any).genre)} ${title} ${description}`;
  const tokens = toTokens(genreText);

  const genreScore = tokens.reduce((acc, token) => acc + (profile.genreScores[token] || 0), 0);

  const categoryScore =
    (categoryId ? profile.categoryScores[categoryId] || 0 : 0) +
    (categoryName ? profile.categoryScores[categoryName] || 0 : 0);

  const titleTokenScore = toTokens(title).reduce((acc, token) => acc + (profile.titleTokenScores[token] || 0), 0);
  const descriptionTokenScore = toTokens(description).reduce(
    (acc, token) => acc + (profile.genreScores[token] || 0) * 0.65 + (profile.titleTokenScores[token] || 0) * 0.35,
    0
  );

  const contentId =
    type === 'movie' ? toText(item.stream_id) : type === 'series' ? toText(item.series_id) : toText(item.stream_id);

  const affinityScore = profile.contentAffinity[`${type}:${contentId}`] || 0;

  const moodMatches = getMoodMatches(item);
  const moodAffinityScore = moodMatches.slice(0, 2).reduce((sum, entry) => {
    const affinity = getMoodProfileAffinity(entry.mood, profile);
    return sum + entry.score * (0.8 + affinity * 0.06);
  }, 0);

  const releaseYear = extractReleaseYear(item);
  const yearsDistance = releaseYear ? Math.abs(nowDate.getFullYear() - releaseYear) : 20;
  const recencyScore = clamp(1 - yearsDistance / 20, 0, 1);
  const releaseIntent = Math.min(6, Math.max(0, profile.rankingScores.release || 0));
  const ratedIntent = Math.min(6, Math.max(0, profile.rankingScores.rated || 0));
  const ratingScore = getNormalizedRating(item);
  const yearBoost = releaseYear ? recencyScore * releaseIntent * 0.3 : 0;
  const ratedBoost = ratingScore >= 7 ? ((ratingScore - 6) / 4) * ratedIntent * 0.26 : 0;

  // Boost para conteúdo em andamento (usuário já iniciou)
  const inProgressPct = profile.inProgressIds?.[contentId] || 0;
  const inProgressBoost = inProgressPct >= 5 ? 3.2 + (inProgressPct / 100) * 2.5 : 0;

  // Boost leve para conteúdo que o usuário já concluiu (pode rever)
  const completedBoost = (profile.completedIds?.[contentId] || 0) * 0.8;

  // Penalidade para gêneros onde o usuário costuma abandonar o conteúdo
  const abandonedPenalty = tokens.reduce(
    (sum, token) => sum + (profile.abandonedTokens?.[token] || 0),
    0
  ) * 0.45;

  const typeTotal = profile.typeScores.movie + profile.typeScores.series + profile.typeScores.live || 1;
  const typeScore = (profile.typeScores[type] || 0) / typeTotal;

  const hour = nowDate.getHours();
  const hourScore = profile.favoriteHours.length
    ? profile.favoriteHours.reduce((best, candidate) => {
        const distance = hourDistance(hour, candidate);
        return Math.max(best, 1 - distance / 6);
      }, 0)
    : 0.2;

  const weekendBonus = profile.prefersWeekend && [0, 6].includes(nowDate.getDay()) ? 0.35 : 0;

  const isNight = hour >= 18 && hour < 24;
  const isWeekend = [0, 6].includes(nowDate.getDay());

  const nightTypeBoostMap: Record<TasteContentType, number> = {
    movie: 0.42,
    series: 0.3,
    live: 0.12,
  };

  const weekendTypeBoostMap: Record<TasteContentType, number> = {
    movie: 0.24,
    series: 0.48,
    live: 0.1,
  };

  const contextBaseBoost =
    (isNight ? nightTypeBoostMap[type] : 0) +
    (isWeekend ? weekendTypeBoostMap[type] : 0);

  const typeContextBoost = contextBaseBoost * (0.7 + typeScore);

  const longSessionBoost =
    isNight && (type === 'movie' || type === 'series') && profile.averageWatchPercent >= 48 ? 0.24 : 0;

  const bingeSessionBoost =
    isWeekend &&
    type === 'series' &&
    profile.averageWatchPercent >= 52
      ? 0.22 + inferBingePotential(item) * 0.22
      : 0;

  const maturityPenalty = profile.kidsMode ? inferMatureContentScore(item) * 5 : 0;

  return (
    genreScore * 1.6 +
    categoryScore * 2.0 +
    titleTokenScore * 1.2 +
    descriptionTokenScore * 0.9 +
    moodAffinityScore * 0.8 +
    affinityScore * 2.8 +
    typeScore * 4 +
    hourScore * 2 +
    typeContextBoost +
    longSessionBoost +
    bingeSessionBoost +
    weekendBonus -
    maturityPenalty +
    inProgressBoost +
    yearBoost +
    ratedBoost +
    completedBoost -
    abandonedPenalty
  );
}

function pickTopTokenByScore(tokens: string[], scoreMap: Record<string, number>) {
  const uniq = Array.from(new Set(tokens));
  const sorted = uniq
    .map((token) => ({ token, score: scoreMap[token] || 0 }))
    .sort((a, b) => b.score - a.score);
  return sorted[0];
}

function hourToLabel(hour: number) {
  const safe = clamp(Math.floor(hour), 0, 23);
  if (safe >= 5 && safe < 12) return 'de manha';
  if (safe >= 12 && safe < 18) return 'de tarde';
  if (safe >= 18 && safe < 24) return 'de noite';
  return 'de madrugada';
}

function hashSeed(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 33 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function pickVariant(options: string[], seed: string) {
  if (!options.length) return '';
  return options[hashSeed(seed) % options.length];
}

export function getRecommendationReasons(
  item: StreamItem,
  type: TasteContentType,
  profile: UserTasteProfile,
  nowDate = new Date()
) {
  const baseDate = nowDate;
  const nowHour = baseDate.getHours();
  const isNight = nowHour >= 18 && nowHour < 24;
  const isMorning = nowHour >= 5 && nowHour < 12;
  const isWeekendNow = [0, 6].includes(baseDate.getDay());

  const title = toText(item.title || item.name, '');
  const contentId =
    type === 'movie' ? toText(item.stream_id) : type === 'series' ? toText(item.series_id) : toText(item.stream_id);
  const phraseSeed = `${profile.generatedAt}-${type}-${contentId || title}`;
  const categoryId = toText((item as any).category_id);
  const categoryName = normalize(toText((item as any).category_name));
  const genreText = `${toText((item as any).genre)} ${title} ${toText((item as any).plot)}`;
  const genreTokens = toTokens(genreText);
  const topMoodMatch = getMoodMatches(item)[0];
  const topMoodAffinity = topMoodMatch ? getMoodProfileAffinity(topMoodMatch.mood, profile) : 0;
  const releaseYear = extractReleaseYear(item);
  const ratingScore = getNormalizedRating(item);
  const catScore =
    (categoryId ? profile.categoryScores[categoryId] || 0 : 0) +
    (categoryName ? profile.categoryScores[categoryName] || 0 : 0);

  const candidates: Array<{ phrase: string; priority: number }> = [];
  const push = (phrase: string, priority: number) => {
    if (phrase) candidates.push({ phrase, priority });
  };

  // 1. CONTINUAÇÃO: usuário já iniciou este conteúdo — prioridade máxima
  const inProgressPct = profile.inProgressIds?.[contentId] || 0;
  if (inProgressPct >= 5) {
    push(pickVariant(PHRASES_CONTINUE, phraseSeed + '-continue'), 100);
  }

  // 2. HUMOR/GÊNERO: baseado no tipo de conteúdo detectado
  const mood = detectGenreMood(item);
  if (mood && topMoodMatch && topMoodMatch.score >= 2.6 && (topMoodAffinity >= 0.2 || catScore >= 0.25)) {
    push(pickVariant(GENRE_MOOD_PHRASES[mood], phraseSeed + '-mood'), type === 'live' ? 66 : 82);
  }

  // 3. COMPORTAMENTO: afinidade ou categoria forte no perfil
  const affinity = profile.contentAffinity[`${type}:${contentId}`] || 0;
  if (affinity > 0.3 || catScore > 0.25) {
    push(pickVariant(PHRASES_BEHAVIOR, phraseSeed + '-behavior'), 78);
  }

  // 4. GÊNERO PRINCIPAL: token com maior peso no perfil do usuário
  const topGenre = pickTopTokenByScore(genreTokens, profile.genreScores);
  if (topGenre && topGenre.score > 0.2) {
    push(
      pickVariant(
        [
          `Seu perfil combina com ${topGenre.token}`,
          `Seu gosto aponta para ${topGenre.token}`,
          `Match com seu interesse em ${topGenre.token}`,
          `Baseado no seu histórico de ${topGenre.token}`,
        ],
        phraseSeed + '-genre'
      ),
      72
    );
  }

  // 5. FIM DE SEMANA: usuário assiste mais nos fins de semana
  if (isWeekendNow && profile.prefersWeekend) {
    push(
      pickVariant(
        [
          'Fim de semana perfeito pra maratonar',
          'Fim de semana no ar: hora de assistir',
          'Seu horário clássico de fim de semana',
          'Maratona de fim de semana detectada',
        ],
        phraseSeed + '-weekend'
      ),
      76
    );
  }

  // 6. HORÁRIO: horário atual próximo do pico de uso
  const closeHour = profile.favoriteHours.find((h) => hourDistance(h, nowHour) <= 2);
  if (closeHour !== undefined || isNight) {
    const timePool = isNight ? PHRASES_TIME_NIGHT : isMorning ? PHRASES_TIME_MORNING : PHRASES_TIME_DAY;
    push(pickVariant(timePool, phraseSeed + '-time'), isNight ? 74 : 58);
  }

  // 7. TENDÊNCIA: item bem avaliado
  const rawRating = parseFloat(String((item as any).rating || 0));
  const rawRating5 = parseFloat(String((item as any).rating_5based || 0));
  const normalizedRating = rawRating >= 1 ? rawRating : rawRating5 * 2;
  if (normalizedRating >= 7.5) {
    push(pickVariant(PHRASES_TRENDING, phraseSeed + '-trending'), 66);
  }

  // 8.5 LANÇAMENTO/ANO: reforça match quando perfil gosta de novidades
  const releaseIntent = Math.min(6, Math.max(0, profile.rankingScores.release || 0));
  if (releaseYear && releaseIntent >= 1.5 && Math.abs(baseDate.getFullYear() - releaseYear) <= 3) {
    push(
      pickVariant(
        [
          'Sugestão do momento',
          'Conteúdo ideal pra você',
          'Você vai curtir isso',
          'Recomendado para você',
        ],
        phraseSeed + '-release'
      ),
      62
    );
  }

  // 8. CATEGORIA FAVORITA: categoria relevante no perfil
  if (catScore > 0.35 && categoryName) {
    push(
      pickVariant(
        [
          `Você consome bastante ${categoryName}`,
          `${categoryName} está no seu perfil`,
          `Sua categoria favorita: ${categoryName}`,
          `Alta afinidade com ${categoryName}`,
        ],
        phraseSeed + '-category'
      ),
      64
    );
  }

  // 9. ENGAJAMENTO: fallback para incentivar o play
  push(pickVariant(PHRASES_ENGAGEMENT, phraseSeed + '-engage'), type === 'live' ? 40 : 12);

  // 10. GERAL: fallback genérico
  push(pickVariant(PHRASES_GENERAL, phraseSeed + '-general'), 6);

  return candidates
    .sort((a, b) => b.priority - a.priority)
    .map((c) => c.phrase)
    .filter(Boolean)
    .slice(0, 2);
}

export function rankContentByTaste(
  items: StreamItem[],
  type: TasteContentType,
  profile: UserTasteProfile,
  limit?: number
) {
  const ranked = [...items]
    .map((item, index) => ({
      item,
      index,
      score: scoreItemByTaste(item, type, profile),
    }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index))
    .map((entry) => entry.item);

  if (typeof limit === 'number') {
    return ranked.slice(0, Math.max(0, limit));
  }

  return ranked;
}

export function getHabitHours(profile: UserTasteProfile) {
  if (profile.favoriteHours.length) {
    return profile.favoriteHours.slice(0, 3);
  }
  return [20, 21];
}
