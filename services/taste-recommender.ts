import { getDbValue, setDbValue } from '@/services/local-db';

import { AccountSettingsState } from '@/services/account-settings';
import { loadAccountSettings } from '@/services/account-settings';
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
  favoriteHours: number[];
  prefersWeekend: boolean;
  kidsMode: boolean;
  averageWatchPercent: number;
};

const WATCH_SIGNAL_KEY = 'taste.watchSignals.v1';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const normalize = (value: string) => value.trim().toLowerCase();

const toTokens = (value: string) =>
  normalize(value)
    .replace(/[.,;:()\[\]{}|/\\!?"'`´~^+=*_<>-]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);

async function saveWatchSignals(signals: WatchSignal[]) {
  await setDbValue(WATCH_SIGNAL_KEY, signals);
}

export async function loadWatchSignals(): Promise<WatchSignal[]> {
  try {
    const parsed = await getDbValue<WatchSignal[]>(WATCH_SIGNAL_KEY);
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

  await saveWatchSignals(merged.slice(0, 1400));
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
  const [settings, catalogRaw, movieProgressMap, seriesProgressMap, storedSignals] = await Promise.all([
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
  ]);

  const catalog = catalogRaw;
  const indexes = buildCatalogIndexes(catalog);
  const fallbackSignals = synthesizeSignalsFromProgress(movieProgressMap, seriesProgressMap);

  const allSignals = [...storedSignals, ...fallbackSignals]
    .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1))
    .slice(0, 1600);

  const genreScores: Record<string, number> = {};
  const categoryScores: Record<string, number> = {};
  const titleTokenScores: Record<string, number> = {};
  const hourScores: Record<number, number> = {};
  const typeScores: Record<TasteContentType, number> = { movie: 0, series: 0, live: 0 };
  const contentAffinity: Record<string, number> = {};

  let weekendWeight = 0;
  let weekdayWeight = 0;
  let progressAccumulator = 0;

  const now = Date.now();

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

    progressAccumulator += signal.progressPercent;
    typeScores[signal.type] += weight;
    contentAffinity[`${signal.type}:${signal.contentId}`] =
      (contentAffinity[`${signal.type}:${signal.contentId}`] || 0) + weight;

    const categoryId = toText((sourceItem as any)?.category_id);
    if (categoryId) {
      addWeight(categoryScores, categoryId, weight * 1.4);
    }

    const categoryName = normalize(extractCategoryName(sourceItem));
    if (categoryName) {
      addWeight(categoryScores, categoryName, weight * 1.15);
    }

    toTokens(extractItemGenreText(sourceItem)).forEach((token) => addWeight(genreScores, token, weight));
    toTokens(toText((sourceItem as any)?.title || (sourceItem as any)?.name)).forEach((token) =>
      addWeight(titleTokenScores, token, weight * 0.85)
    );

    const hour = parseHour(signal.updatedAt);
    addHourWeight(hourScores, hour, weight);

    if (isWeekendIso(signal.updatedAt)) weekendWeight += weight;
    else weekdayWeight += weight;
  });

  const favoriteHours = Object.entries(hourScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([hour]) => Number(hour));

  const activeProfile = settings.profiles.find((profile) => profile.id === settings.activeProfileId);

  return {
    generatedAt: new Date().toISOString(),
    genreScores,
    categoryScores,
    titleTokenScores,
    hourScores,
    typeScores,
    contentAffinity,
    favoriteHours,
    prefersWeekend: weekendWeight >= weekdayWeight,
    kidsMode: !!activeProfile?.kidsMode,
    averageWatchPercent: allSignals.length ? Math.round(progressAccumulator / allSignals.length) : 0,
  } satisfies UserTasteProfile;
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
  const categoryId = toText((item as any).category_id);
  const categoryName = normalize(toText((item as any).category_name));
  const genreText = `${toText((item as any).genre)} ${title} ${toText((item as any).plot)}`;
  const tokens = toTokens(genreText);

  const genreScore = tokens.reduce((acc, token) => acc + (profile.genreScores[token] || 0), 0);

  const categoryScore =
    (categoryId ? profile.categoryScores[categoryId] || 0 : 0) +
    (categoryName ? profile.categoryScores[categoryName] || 0 : 0);

  const titleTokenScore = toTokens(title).reduce((acc, token) => acc + (profile.titleTokenScores[token] || 0), 0);

  const contentId =
    type === 'movie' ? toText(item.stream_id) : type === 'series' ? toText(item.series_id) : toText(item.stream_id);

  const affinityScore = profile.contentAffinity[`${type}:${contentId}`] || 0;

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
    affinityScore * 2.8 +
    typeScore * 4 +
    hourScore * 2 +
    typeContextBoost +
    longSessionBoost +
    bingeSessionBoost +
    weekendBonus -
    maturityPenalty
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

export function getRecommendationReasons(
  item: StreamItem,
  type: TasteContentType,
  profile: UserTasteProfile,
  nowDate = new Date()
) {
  const reasonCandidates: Array<{ reason: string; priority: number }> = [];
  const nowHour = nowDate.getHours();
  const isNightNow = nowHour >= 18 && nowHour < 24;
  const isWeekendNow = [0, 6].includes(nowDate.getDay());

  const pushReason = (reason: string, basePriority: number, contextBoost = 0) => {
    if (!reason) return;
    reasonCandidates.push({ reason, priority: basePriority + contextBoost });
  };

  const title = toText(item.title || item.name, '');
  const categoryId = toText((item as any).category_id);
  const categoryName = normalize(toText((item as any).category_name));
  const genreText = `${toText((item as any).genre)} ${title} ${toText((item as any).plot)}`;
  const genreTokens = toTokens(genreText);

  const topGenre = pickTopTokenByScore(genreTokens, profile.genreScores);
  if (topGenre && topGenre.score > 0.25) {
    pushReason(`Combina com seu interesse por ${topGenre.token}`, 52);
  }

  const categoryScore =
    (categoryId ? profile.categoryScores[categoryId] || 0 : 0) +
    (categoryName ? profile.categoryScores[categoryName] || 0 : 0);
  if (categoryScore > 0.35 && categoryName) {
    pushReason(`Voce assiste bastante ${categoryName}`, 50);
  }

  const contentId =
    type === 'movie' ? toText(item.stream_id) : type === 'series' ? toText(item.series_id) : toText(item.stream_id);
  const affinity = profile.contentAffinity[`${type}:${contentId}`] || 0;
  if (affinity > 0.45) {
    pushReason('Parecido com conteudos que voce viu por mais tempo', 46);
  }

  if (profile.favoriteHours.length) {
    const closeHour = profile.favoriteHours.find((hour) => hourDistance(hour, nowHour) <= 2);
    if (typeof closeHour === 'number') {
      pushReason(
        `Horario que voce costuma assistir ${hourToLabel(closeHour)}`,
        55,
        isNightNow ? 35 : 0
      );
    }
  }

  if (profile.prefersWeekend && isWeekendNow) {
    pushReason('Voce costuma maratonar mais no fim de semana', 54, 35);
  }

  return reasonCandidates
    .sort((a, b) => b.priority - a.priority)
    .map((entry) => entry.reason)
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
