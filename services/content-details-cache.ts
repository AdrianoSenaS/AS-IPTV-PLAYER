import { TmdbContentDetails } from '@/services/tmdb';
import { getDbValue, pruneDbValuesByPrefixOlderThan, setDbValue } from '@/services/local-db';

export type ContentDetailsKind = 'movie' | 'series';

export type CachedContentDetails = {
  kind: ContentDetailsKind;
  contentId: string;
  sourceHash: string;
  tmdbDetails: TmdbContentDetails | null;
  titleHint?: string;
  yearHint?: number;
  updatedAt: string;
};

const cacheKey = (kind: ContentDetailsKind, contentId: string) =>
  `content.details.${kind}.${contentId}.v1`;
const CACHE_PREFIX = 'content.details.';

const toSafeText = (value: unknown) => String(value || '').trim().toLowerCase();

export function buildMovieDetailsHash(params: {
  streamId: string;
  title?: string;
  year?: string | number;
  genre?: string;
  duration?: string;
  plot?: string;
  releaseDate?: string;
  cast?: string;
}) {
  return [
    toSafeText(params.streamId),
    toSafeText(params.title),
    toSafeText(params.year),
    toSafeText(params.genre),
    toSafeText(params.duration),
    toSafeText(params.plot),
    toSafeText(params.releaseDate),
    toSafeText(params.cast),
  ].join('|');
}

export function buildSeriesDetailsHash(params: {
  seriesId: string;
  title?: string;
  releaseDate?: string;
  genre?: string;
  episodesCount?: number;
  seasonsCount?: number;
  firstEpisodeId?: string;
  lastEpisodeId?: string;
}) {
  return [
    toSafeText(params.seriesId),
    toSafeText(params.title),
    toSafeText(params.releaseDate),
    toSafeText(params.genre),
    toSafeText(params.episodesCount),
    toSafeText(params.seasonsCount),
    toSafeText(params.firstEpisodeId),
    toSafeText(params.lastEpisodeId),
  ].join('|');
}

export async function loadCachedContentDetails(
  kind: ContentDetailsKind,
  contentId: string
): Promise<CachedContentDetails | null> {
  if (!contentId) {
    return null;
  }

  const raw = await getDbValue<Partial<CachedContentDetails>>(cacheKey(kind, contentId));
  if (!raw || !raw.contentId) {
    return null;
  }

  return {
    kind,
    contentId,
    sourceHash: String(raw.sourceHash || ''),
    tmdbDetails: (raw.tmdbDetails || null) as TmdbContentDetails | null,
    titleHint: raw.titleHint ? String(raw.titleHint) : undefined,
    yearHint: typeof raw.yearHint === 'number' ? raw.yearHint : undefined,
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
  };
}

export async function saveCachedContentDetails(record: Omit<CachedContentDetails, 'updatedAt'>) {
  if (!record.contentId) {
    return;
  }

  await setDbValue(cacheKey(record.kind, record.contentId), {
    ...record,
    updatedAt: new Date().toISOString(),
  } as CachedContentDetails);
}

export async function cleanupOldContentDetailsCache(maxAgeMs = 1000 * 60 * 60 * 24 * 14) {
  return pruneDbValuesByPrefixOlderThan(CACHE_PREFIX, maxAgeMs);
}
