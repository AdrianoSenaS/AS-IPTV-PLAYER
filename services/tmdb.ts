type TmdbKind = 'movie' | 'tv';

type TmdbItem = {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  popularity?: number;
  release_date?: string;
  first_air_date?: string;
};

type TmdbGenre = {
  id: number;
  name: string;
};

type TmdbPerson = {
  id: number;
  name?: string;
  biography?: string;
  birthday?: string;
  place_of_birth?: string;
  known_for_department?: string;
  profile_path?: string | null;
};

type TmdbCreditCast = {
  id: number;
  name?: string;
  character?: string;
  known_for_department?: string;
  profile_path?: string | null;
};

type TmdbCreditCrew = {
  id: number;
  name?: string;
  job?: string;
};

type TmdbCreditsResponse = {
  cast?: TmdbCreditCast[];
  crew?: TmdbCreditCrew[];
};

type TmdbMovieDetailsResponse = {
  id: number;
  overview?: string;
  vote_average?: number;
  genres?: TmdbGenre[];
  runtime?: number;
  release_date?: string;
};

type TmdbTvDetailsResponse = {
  id: number;
  overview?: string;
  vote_average?: number;
  genres?: TmdbGenre[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  first_air_date?: string;
  episode_run_time?: number[];
};

type TmdbResponse = {
  results?: TmdbItem[];
};

export type TmdbMeta = {
  title: string;
  posterUrl?: string;
  backdropUrl?: string;
  rating?: number;
  popularity?: number;
  releaseDate?: string;
  releaseYear?: number;
};

export type TmdbCastMember = {
  id: number;
  name: string;
  character: string;
  knownForDepartment?: string;
  profileUrl?: string;
};

export type TmdbPersonBio = {
  id: number;
  name: string;
  biography: string;
  birthday?: string;
  placeOfBirth?: string;
  knownForDepartment?: string;
  profileUrl?: string;
};

export type TmdbContentDetails = {
  id: number;
  overview?: string;
  rating?: number;
  genres: string[];
  runtimeMinutes?: number;
  releaseDate?: string;
  seasons?: number;
  episodes?: number;
  director?: string;
  cast: TmdbCastMember[];
};

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const TMDB_BEARER =
  'Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIzMWEzMzM5Yjg1MGE0ZDI4NDNiMjU5ZmI5ZWJiYTNmZiIsIm5iZiI6MTcyNzIxNjM0NC42OCwic3ViIjoiNjZmMzNhZDg1MDUxMzI4MzBlMjE2NDFhIiwic2NvcGVzIjpbImFwaV9yZWFkIl0sInZlcnNpb24iOjF9.ymyuM-JNxbypJmoe1ByMoONM24elHMV_053-HYEQxl0';

const cache = new Map<string, { expiresAt: number; data: any }>();

const normalizeTitle = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .toLowerCase();

const parseYear = (value?: string) => {
  if (!value) return undefined;
  const year = Number(value.slice(0, 4));
  return Number.isFinite(year) ? year : undefined;
};

const profileUrlFromPath = (path?: string | null) => (path ? `${TMDB_IMAGE_BASE}${path}` : undefined);

const pickTmdbSearchResult = (items: TmdbItem[], title: string, year?: number) => {
  if (!items.length) return null;
  const normalizedTarget = normalizeTitle(title);

  const ranked = [...items].sort((a, b) => {
    const titleA = normalizeTitle(String(a.title || a.name || a.original_title || a.original_name || ''));
    const titleB = normalizeTitle(String(b.title || b.name || b.original_title || b.original_name || ''));
    const scoreA = titleA === normalizedTarget ? 3 : titleA.includes(normalizedTarget) ? 2 : 0;
    const scoreB = titleB === normalizedTarget ? 3 : titleB.includes(normalizedTarget) ? 2 : 0;

    if (year) {
      const yearA = parseYear(a.release_date || a.first_air_date) || 0;
      const yearB = parseYear(b.release_date || b.first_air_date) || 0;
      const yearPenaltyA = Math.abs(yearA - year);
      const yearPenaltyB = Math.abs(yearB - year);
      if (scoreA === scoreB && yearPenaltyA !== yearPenaltyB) {
        return yearPenaltyA - yearPenaltyB;
      }
    }

    if (scoreA !== scoreB) return scoreB - scoreA;
    return (b.popularity || 0) - (a.popularity || 0);
  });

  return ranked[0] || null;
};

function toMeta(item: TmdbItem): TmdbMeta {
  const title = item.title || item.name || item.original_title || item.original_name || 'Sem titulo';
  const releaseDate = item.release_date || item.first_air_date;
  return {
    title,
    posterUrl: item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : undefined,
    backdropUrl: item.backdrop_path ? `${TMDB_IMAGE_BASE}${item.backdrop_path}` : undefined,
    rating: typeof item.vote_average === 'number' ? Number(item.vote_average.toFixed(1)) : undefined,
    popularity: typeof item.popularity === 'number' ? item.popularity : undefined,
    releaseDate,
    releaseYear: parseYear(releaseDate),
  };
}

async function fetchTmdb(path: string) {
  const url = `${TMDB_BASE_URL}${path}${path.includes('?') ? '&' : '?'}language=pt-BR`;
  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      Authorization: TMDB_BEARER,
    },
  });

  if (!response.ok) {
    throw new Error(`TMDB ${response.status}`);
  }

  const data = (await response.json()) as TmdbResponse;
  cache.set(url, { expiresAt: Date.now() + 1000 * 60 * 25, data });
  return data;
}

async function fetchBuckets(kind: TmdbKind) {
  const endpoints =
    kind === 'movie'
      ? ['/movie/now_playing?page=1', '/movie/popular?page=1', '/movie/top_rated?page=1']
      : ['/tv/on_the_air?page=1', '/tv/popular?page=1', '/tv/top_rated?page=1'];

  const [releasesRaw, popularRaw, topRatedRaw] = await Promise.all(endpoints.map((endpoint) => fetchTmdb(endpoint)));

  const releases = Array.isArray(releasesRaw.results) ? releasesRaw.results : [];
  const popular = Array.isArray(popularRaw.results) ? popularRaw.results : [];
  const topRated = Array.isArray(topRatedRaw.results) ? topRatedRaw.results : [];
  return { releases, popular, topRated };
}

function buildTitleMap(items: TmdbItem[]) {
  const map = new Map<string, TmdbMeta>();
  for (const item of items) {
    const meta = toMeta(item);
    const names = [item.title, item.name, item.original_title, item.original_name]
      .filter(Boolean)
      .map((name) => normalizeTitle(String(name)));

    for (const name of names) {
      const current = map.get(name);
      if (!current || (meta.popularity || 0) > (current.popularity || 0)) {
        map.set(name, meta);
      }
    }
  }
  return map;
}

export async function buildTmdbMetadataForCatalog<T>(
  items: T[],
  kind: TmdbKind,
  getId: (item: T) => string,
  getTitle: (item: T) => string
) {
  try {
    const buckets = await fetchBuckets(kind);
    const all = [...buckets.releases, ...buckets.popular, ...buckets.topRated];
    const titleMap = buildTitleMap(all);

    const result: Record<string, TmdbMeta> = {};
    for (const item of items) {
      const id = getId(item);
      const title = normalizeTitle(getTitle(item));
      if (!id || !title) continue;

      const match = titleMap.get(title);
      if (match) {
        result[id] = match;
      }
    }

    return result;
  } catch {
    return {} as Record<string, TmdbMeta>;
  }
}

export function rankCatalogByTmdb<T>(
  items: T[],
  metadataMap: Record<string, TmdbMeta>,
  getId: (item: T) => string,
  mode: 'release' | 'popular' | 'rated',
  limit = 40
) {
  const scored = [...items].sort((a, b) => {
    const metaA = metadataMap[getId(a)];
    const metaB = metadataMap[getId(b)];

    if (mode === 'release') {
      return (metaB?.releaseYear || 0) - (metaA?.releaseYear || 0);
    }
    if (mode === 'popular') {
      return (metaB?.popularity || 0) - (metaA?.popularity || 0);
    }
    return (metaB?.rating || 0) - (metaA?.rating || 0);
  });

  return scored.slice(0, limit);
}

export async function fetchTmdbContentDetailsByTitle(
  kind: TmdbKind,
  title: string,
  year?: number
): Promise<TmdbContentDetails | null> {
  try {
    const query = encodeURIComponent(title.trim());
    if (!query) return null;

    const search = (await fetchTmdb(`/search/${kind}?query=${query}&include_adult=false&page=1`)) as TmdbResponse;
    const searchItems = Array.isArray(search.results) ? search.results : [];
    const picked = pickTmdbSearchResult(searchItems, title, year);
    if (!picked?.id) return null;

    const [detailsRaw, creditsRaw] = await Promise.all([
      fetchTmdb(`/${kind}/${picked.id}`),
      fetchTmdb(`/${kind}/${picked.id}/credits`),
    ]);

    const details = detailsRaw as TmdbMovieDetailsResponse | TmdbTvDetailsResponse;
    const credits = creditsRaw as TmdbCreditsResponse;
    const cast = (Array.isArray(credits.cast) ? credits.cast : []).slice(0, 18).map((person) => ({
      id: person.id,
      name: person.name || 'Ator',
      character: person.character || '-',
      knownForDepartment: person.known_for_department,
      profileUrl: profileUrlFromPath(person.profile_path),
    }));

    const director = (Array.isArray(credits.crew) ? credits.crew : []).find(
      (person) => String(person.job || '').toLowerCase() === 'director'
    )?.name;

    return {
      id: picked.id,
      overview: details.overview,
      rating:
        typeof details.vote_average === 'number' ? Number(details.vote_average.toFixed(1)) : undefined,
      genres: Array.isArray(details.genres) ? details.genres.map((genre) => genre.name).filter(Boolean) : [],
      runtimeMinutes:
        kind === 'movie'
          ? (details as TmdbMovieDetailsResponse).runtime
          : (details as TmdbTvDetailsResponse).episode_run_time?.[0],
      releaseDate:
        kind === 'movie'
          ? (details as TmdbMovieDetailsResponse).release_date
          : (details as TmdbTvDetailsResponse).first_air_date,
      seasons: kind === 'tv' ? (details as TmdbTvDetailsResponse).number_of_seasons : undefined,
      episodes: kind === 'tv' ? (details as TmdbTvDetailsResponse).number_of_episodes : undefined,
      director,
      cast,
    };
  } catch {
    return null;
  }
}

export async function fetchTmdbPersonBio(personId: number): Promise<TmdbPersonBio | null> {
  try {
    const raw = (await fetchTmdb(`/person/${personId}`)) as TmdbPerson;
    if (!raw?.id) return null;

    return {
      id: raw.id,
      name: raw.name || 'Pessoa',
      biography: raw.biography || 'Biografia nao informada.',
      birthday: raw.birthday || undefined,
      placeOfBirth: raw.place_of_birth || undefined,
      knownForDepartment: raw.known_for_department || undefined,
      profileUrl: profileUrlFromPath(raw.profile_path),
    };
  } catch {
    return null;
  }
}
