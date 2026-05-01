import { getDbValue, setDbValue } from '@/services/local-db';

const KEY = 'seriesProgressMap';

type EpisodeState = {
  progress: number;
  watched: boolean;
  positionMs: number;
  durationMs: number;
  updatedAt: string;
};

type SeriesState = {
  lastSeason: number;
  lastEpisode: number;
  episodes: Record<string, EpisodeState>;
};

export type SeriesProgressMap = Record<string, SeriesState>;

const makeEpisodeKey = (season: number, episode: number) => `${season}:${episode}`;

export async function loadSeriesProgressMap(): Promise<SeriesProgressMap> {
  try {
    const parsed = await getDbValue<SeriesProgressMap>(KEY);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveSeriesProgressMap(map: SeriesProgressMap) {
  await setDbValue(KEY, map);
}

export async function updateEpisodeProgress(
  seriesId: string,
  season: number,
  episode: number,
  progress: number,
  positionMs = 0,
  durationMs = 0
) {
  const safeProgress = Math.max(0, Math.min(100, Math.round(progress)));
  const safePosition = Math.max(0, Math.floor(positionMs));
  const safeDuration = Math.max(0, Math.floor(durationMs));
  const map = await loadSeriesProgressMap();
  const currentSeries = map[seriesId] || { lastSeason: season, lastEpisode: episode, episodes: {} };

  currentSeries.lastSeason = season;
  currentSeries.lastEpisode = episode;
  currentSeries.episodes[makeEpisodeKey(season, episode)] = {
    progress: safeProgress,
    watched: safeProgress >= 95,
    positionMs: safePosition,
    durationMs: safeDuration,
    updatedAt: new Date().toISOString(),
  };

  map[seriesId] = currentSeries;
  await saveSeriesProgressMap(map);
  return map;
}

export function getEpisodeProgress(map: SeriesProgressMap, seriesId: string, season: number, episode: number) {
  return map[seriesId]?.episodes?.[makeEpisodeKey(season, episode)] || null;
}

export function getSeriesSummary(map: SeriesProgressMap, seriesId: string) {
  const state = map[seriesId];
  if (!state) {
    return {
      trackedCount: 0,
      watchedCount: 0,
      averageProgress: 0,
      lastSeason: 1,
      lastEpisode: 1,
      continueSeason: 1,
      continueEpisode: 1,
    };
  }

  const entries = Object.entries(state.episodes);
  const trackedCount = entries.length;
  const watchedCount = entries.filter(([, value]) => value.watched).length;
  const totalProgress = entries.reduce((acc, [, value]) => acc + value.progress, 0);
  const averageProgress = trackedCount ? Math.round(totalProgress / trackedCount) : 0;

  const partial = entries
    .filter(([, value]) => value.progress > 0 && value.progress < 100)
    .sort((a, b) => (a[1].updatedAt > b[1].updatedAt ? -1 : 1))[0];

  let continueSeason = state.lastSeason;
  let continueEpisode = state.lastEpisode;

  if (partial) {
    const [season, episode] = partial[0].split(':').map(Number);
    continueSeason = season;
    continueEpisode = episode;
  }

  return {
    trackedCount,
    watchedCount,
    averageProgress,
    lastSeason: state.lastSeason,
    lastEpisode: state.lastEpisode,
    continueSeason,
    continueEpisode,
  };
}
