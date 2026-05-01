import { getDbValue, setDbValue } from '@/services/local-db';

const KEY = 'movieProgressMap';

export type MovieProgressState = {
  positionMs: number;
  durationMs: number;
  progressPercent: number;
  updatedAt: string;
};

export type MovieProgressMap = Record<string, MovieProgressState>;

export async function loadMovieProgressMap(): Promise<MovieProgressMap> {
  try {
    const parsed = await getDbValue<MovieProgressMap>(KEY);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveMovieProgressMap(map: MovieProgressMap) {
  await setDbValue(KEY, map);
}

export async function updateMovieProgress(
  movieId: string,
  positionMs: number,
  durationMs: number
): Promise<MovieProgressMap> {
  if (!movieId) {
    return loadMovieProgressMap();
  }

  const safePosition = Math.max(0, Math.floor(positionMs));
  const safeDuration = Math.max(0, Math.floor(durationMs));
  const pct = safeDuration > 0 ? Math.min(100, Math.round((safePosition / safeDuration) * 100)) : 0;

  const map = await loadMovieProgressMap();
  map[movieId] = {
    positionMs: safePosition,
    durationMs: safeDuration,
    progressPercent: pct,
    updatedAt: new Date().toISOString(),
  };

  await saveMovieProgressMap(map);
  return map;
}

export function getMovieProgress(map: MovieProgressMap, movieId: string): MovieProgressState | null {
  return map[movieId] || null;
}
