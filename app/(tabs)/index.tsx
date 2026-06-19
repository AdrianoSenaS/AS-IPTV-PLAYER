import { MaterialIcons } from '@expo/vector-icons';
import { getDbValue } from '@/services/local-db';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  FlatList,
  InteractionManager,
  RefreshControl,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  ViewToken,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackdrop } from '@/components/app-backdrop';
import { PageLoader } from '@/components/page-loader';
import { ParentalUnlockModal } from '@/components/parental-unlock-modal';
import { RecommendationChip } from '@/components/recommendation-chip';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { useScreenBenchmark } from '@/hooks/use-screen-benchmark';
import {
  DEFAULT_AI_RUNTIME_TUNING,
  loadAiRuntimeTuning,
  loadAiSettings,
} from '@/services/ai-settings';
import { recordSearchEvent } from '@/services/behavior-intelligence';
import {
  AccessSnapshot,
  filterBlockedContent,
  loadAccessSnapshot,
  shouldHideContentImages,
  unlockParentalAccess,
} from '@/services/access-control';
import {
  queryCatalogItemsByIds,
  queryCatalogPage,
  sanitizeLabelText,
  StreamItem,
  toText,
} from '../../services/catalog-data';
import { StreamingTheme } from '@/constants/streaming-theme';
import { BackupJobState, getBackupJobState, subscribeToBackupJob } from '@/services/backup-background';
import { loadAccountSettings } from '@/services/account-settings';
import { loadMovieProgressMap, MovieProgressMap } from '@/services/movie-progress';
import { loadSeriesProgressMap, SeriesProgressMap } from '@/services/series-progress';
import { buildLiveUrl } from '@/services/stream-url';
import {
  buildUserTasteProfile,
  getCachedTasteProfileSnapshot,
  getPersistedTasteProfileSnapshot,
  getRecommendationReasons,
  rankContentByTaste,
  shouldRefreshTasteProfile,
  UserTasteProfile,
} from '@/services/taste-recommender';
import { hasFeature as subscriptionHasFeature } from '@/services/subscription';
import { buildTmdbMetadataForCatalog, rankCatalogByTmdb, TmdbMeta } from '@/services/tmdb';

type ContinueItem = {
  id: string;
  type: 'movie' | 'series';
  title: string;
  subtitle: string;
  image: string;
  progress: number;
  positionMs?: number;
  updatedAt: string;
  streamId?: string;
  seriesId?: string;
};

type FeaturedItem = {
  id: string;
  type: 'movie' | 'series';
  data: StreamItem;
};

type SearchItem = {
  id: string;
  type: 'movie' | 'series' | 'live';
  title: string;
  subtitle: string;
  image: string;
  data: StreamItem;
};

type ContextBannerMeta = {
  message: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  tint: string;
  background: string;
  border: string;
};

type HomeSectionId =
  | 'featured'
  | 'continue'
  | 'movies'
  | 'actionMovies'
  | 'comedyMovies'
  | 'sciFiMovies'
  | 'series'
  | 'actionSeries'
  | 'comedySeries'
  | 'sciFiSeries'
  | 'live'
  | 'sportsLive'
  | 'newsLive';

const HOME_SEARCH_LIMIT = 8;
const HOME_STAGE_MOVIES = 1;
const HOME_STAGE_SERIES = 2;
const HOME_STAGE_LIVE = 9;
const SECTION_VIEWABILITY_CONFIG = {
  itemVisiblePercentThreshold: 20,
  minimumViewTime: 120,
};

const SECTION_PLACEHOLDER_HEIGHT: Record<HomeSectionId, number> = {
  featured: 220,
  continue: 180,
  movies: 250,
  actionMovies: 250,
  comedyMovies: 250,
  sciFiMovies: 250,
  series: 250,
  actionSeries: 250,
  comedySeries: 250,
  sciFiSeries: 250,
  live: 220,
  sportsLive: 220,
  newsLive: 220,
};

const SECTION_ORDER: HomeSectionId[] = [
  'featured',
  'continue',
  'movies',
  'actionMovies',
  'comedyMovies',
  'sciFiMovies',
  'series',
  'actionSeries',
  'comedySeries',
  'sciFiSeries',
  'live',
  'sportsLive',
  'newsLive',
];

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve(fallback);
    }, timeoutMs);

    promise
      .then((value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

function filterContentByGenre(items: StreamItem[], genreKeywords: string[]): StreamItem[] {
  return items.filter((item) => {
    const genres = `${toText(item.genre)} ${toText(item.category_name)}`.toLowerCase();
    return genreKeywords.some((keyword) => genres.includes(keyword.toLowerCase()));
  });
}

export default function HomeScreen() {
  const router = useRouter();
  useScreenBenchmark('home');

  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [userName, setUserName] = useState('');
  const [activeProfileAvatar, setActiveProfileAvatar] = useState('');
  const { hasFeature, isFree } = usePlanGate();
  const [aiEnabled, setAiEnabled] = useState(true);
  const [aiRuntime, setAiRuntime] = useState(DEFAULT_AI_RUNTIME_TUNING);
  const [aiLearningWindowMs, setAiLearningWindowMs] = useState(1000 * 60 * 60 * 24 * 2);
  const hasRecommendationAlgorithm = aiEnabled && hasFeature('recommendation_algorithm');


  const [featuredItems, setFeaturedItems] = useState<FeaturedItem[]>([]);
  const [popularMovies, setPopularMovies] = useState<StreamItem[]>([]);
  const [liveChannels, setLiveChannels] = useState<StreamItem[]>([]);
  const [featuredSeries, setFeaturedSeries] = useState<StreamItem[]>([]);
  const [homeSearch, setHomeSearch] = useState('');
  const [activeFeaturedIndex, setActiveFeaturedIndex] = useState(0);
  const [searchResults, setSearchResults] = useState<SearchItem[]>([]);
  const [continueWatchingItems, setContinueWatchingItems] = useState<ContinueItem[]>([]);
  const [movieTmdbMap, setMovieTmdbMap] = useState<Record<string, TmdbMeta>>({});
  const [seriesTmdbMap, setSeriesTmdbMap] = useState<Record<string, TmdbMeta>>({});
  const [movieProgressMap, setMovieProgressMap] = useState<MovieProgressMap>({});
  const [seriesProgressMap, setSeriesProgressMap] = useState<SeriesProgressMap>({});
  const [access, setAccess] = useState<AccessSnapshot | null>(null);
  const [tasteProfile, setTasteProfile] = useState<UserTasteProfile | null>(null);
  const [isAlgorithmLoading, setIsAlgorithmLoading] = useState(false);
  const [backupJob, setBackupJob] = useState<BackupJobState>(() => getBackupJobState());
  const [lastSyncedAt, setLastSyncedAt] = useState('');
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  const [contentStage, setContentStage] = useState(0);
  const [mountedSections, setMountedSections] = useState<Record<HomeSectionId, boolean>>({
    featured: true,
    continue: false,
    movies: false,
    actionMovies: false,
    comedyMovies: false,
    sciFiMovies: false,
    series: false,
    actionSeries: false,
    comedySeries: false,
    sciFiSeries: false,
    live: false,
    sportsLive: false,
    newsLive: false,
  });
  const bannerTransition = useRef(new Animated.Value(1)).current;
  const bannerContentTransition = useRef(new Animated.Value(1)).current;
  const [bannerFrom, setBannerFrom] = useState<{ background: string; border: string } | null>(null);
  const [bannerTo, setBannerTo] = useState<{ background: string; border: string } | null>(null);
  const featuredListRef = useRef<FlatList<FeaturedItem>>(null);
  const loadVersionRef = useRef(0);
  const focusRefreshAtRef = useRef(0);

  const loadUser = async () => {
    const [name, settings] = await Promise.all([getDbValue<string>('name'), loadAccountSettings()]);
    const activeProfile = settings.profiles.find((item) => item.id === settings.activeProfileId);
    setUserName(
      activeProfile?.name
        ? `Perfil ativo: ${activeProfile.name}`
        : name
          ? `Conta: ${name}`
          : 'Seu perfil'
    );
    setActiveProfileAvatar(activeProfile?.avatarUri || '');
  };

  const loadData = async (options?: { lightweight?: boolean; runtime?: typeof aiRuntime }) => {
    const runtime = aiRuntime || options?.runtime;
    const lightweight = !!options?.lightweight;
    const vodLimit = lightweight ? runtime.homeBootVodLimit : runtime.homeVodPoolLimit;
    const seriesLimit = lightweight ? runtime.homeBootSeriesLimit : runtime.homeSeriesPoolLimit;
    const liveLimit = lightweight ? runtime.homeBootLiveLimit : runtime.homeLivePoolLimit;

    const version = ++loadVersionRef.current;
    setIsAlgorithmLoading(hasRecommendationAlgorithm && runtime.enableTmdbEnrichment);
    const [vod, series, liveStreams, movieMap, seriesMap, snapshot] = await Promise.all([
      withTimeout(
        queryCatalogPage({ kind: 'vod', offset: 0, limit: vodLimit }),
        runtime.homeQueryTimeoutMs,
        [] as StreamItem[]
      ),
      withTimeout(
        queryCatalogPage({ kind: 'series', offset: 0, limit: seriesLimit }),
        runtime.homeQueryTimeoutMs,
        [] as StreamItem[]
      ),
      withTimeout(
        queryCatalogPage({ kind: 'live', offset: 0, limit: liveLimit }),
        runtime.homeQueryTimeoutMs,
        [] as StreamItem[]
      ),
      loadMovieProgressMap(),
      loadSeriesProgressMap(),
      loadAccessSnapshot(),
    ]);

    // Não redireciona de volta ao loading: alguns servidores não têm séries
    // e o redirect causava loop infinito. A tela trata listas vazias com estado vazio.
    if (!vod.length && !series.length && !liveStreams.length) {
      setIsAlgorithmLoading(false);
      return;
    }

    const vodList = vod as StreamItem[];
    const seriesList = series as StreamItem[];
    const liveList = liveStreams as StreamItem[];

    setMovieProgressMap(movieMap);
    setSeriesProgressMap(seriesMap);
    setAccess(snapshot);

    const quickHighlights = vodList.slice(0, 12);
    const quickMovies = vodList.slice(0, 40);
    const quickSeries = seriesList.slice(0, 40);
    const quickLive = liveList.slice(0, 40);

    const featureMovies = quickHighlights.slice(0, 6).map((item, index) => ({
      id: `featured-movie-${toText(item.stream_id, String(index))}`,
      type: 'movie' as const,
      data: item,
    }));
    const featureSeries = seriesList.slice(0, 6).map((item, index) => ({
      id: `featured-series-${toText(item.series_id, String(index))}`,
      type: 'series' as const,
      data: item,
    }));

    const mixedFeatured = [...featureMovies, ...featureSeries].slice(0, 12);

   
    setFeaturedItems(mixedFeatured);
    setPopularMovies(quickMovies);
    setLiveChannels(quickLive);
    setFeaturedSeries(quickSeries);
    try {
      const sampledVod = vodList.slice(0, runtime.homeProfileSampleLimit);
      const sampledSeries = seriesList.slice(0, runtime.homeProfileSampleLimit);
      const sampledLive = liveList.slice(0, Math.max(40, Math.floor(runtime.homeProfileSampleLimit / 2)));

      const planHasAlgorithm = aiEnabled
        ? await subscriptionHasFeature('recommendation_algorithm')
        : false;

      let movieMeta: Record<string, TmdbMeta> = {};
      let seriesMeta: Record<string, TmdbMeta> = {};
      let highlights = vodList.slice(0, 12);
      let launchMovies = vodList.slice(0, 40);
      let launchSeries = seriesList.slice(0, 40);
      let topSeries = seriesList.slice(0, 40);

      if (runtime.enableTmdbEnrichment) {
        [movieMeta, seriesMeta] = await Promise.all([
          withTimeout(
            buildTmdbMetadataForCatalog(
              sampledVod,
              'movie',
              (item) => toText(item.stream_id),
              (item) => sanitizeLabelText(item.title || item.name, '')
            ),
            runtime.homeEnrichTimeoutMs,
            {} as Record<string, TmdbMeta>
          ),
          withTimeout(
            buildTmdbMetadataForCatalog(
              sampledSeries,
              'tv',
              (item) => toText(item.series_id),
              (item) => sanitizeLabelText(item.title || item.name, '')
            ),
            runtime.homeEnrichTimeoutMs,
            {} as Record<string, TmdbMeta>
          ),
        ]);

        [highlights, launchMovies, launchSeries, topSeries] = await Promise.all([
          rankCatalogByTmdb(vodList, movieMeta, (item) => toText(item.stream_id), 'popular', 12),
          rankCatalogByTmdb(vodList, movieMeta, (item) => toText(item.stream_id), 'release', 40),
          rankCatalogByTmdb(seriesList, seriesMeta, (item) => toText(item.series_id), 'release', 40),
          rankCatalogByTmdb(seriesList, seriesMeta, (item) => toText(item.series_id), 'rated', 40),
        ]);
      }

      if (version !== loadVersionRef.current) return;

      setMovieTmdbMap(movieMeta);
      setSeriesTmdbMap(seriesMeta);

      const taste = (() => {
        if (!planHasAlgorithm) return Promise.resolve(null as UserTasteProfile | null);

        return (async () => {
          const cachedProfile = getCachedTasteProfileSnapshot(snapshot.settings);
          const persistedProfile = await getPersistedTasteProfileSnapshot(
            snapshot.settings,
            aiLearningWindowMs
          );

          const baseProfile = cachedProfile || persistedProfile;
          if (baseProfile) {
            setTasteProfile(baseProfile);
          }

          const shouldRefresh = await shouldRefreshTasteProfile(
            snapshot.settings,
            aiLearningWindowMs
          );

          if (!shouldRefresh) {
            return baseProfile || null;
          }

          const rebuilt = await Promise.race([
            buildUserTasteProfile({
              settings: snapshot.settings,
              catalog: {
                vod: sampledVod,
                series: sampledSeries,
                liveStreams: sampledLive,
              },
              movieProgressMap: movieMap,
              seriesProgressMap: seriesMap,
            }),
            new Promise<UserTasteProfile | null>((resolve) => {
              setTimeout(() => resolve(baseProfile || null), 1000);
            }),
          ]);

          return rebuilt || baseProfile || null;
        })();
      })();

      const resolvedTaste = await taste;

      if (version !== loadVersionRef.current) return;

      setTasteProfile(resolvedTaste || null);

      const rankedHighlights = resolvedTaste
        ? rankContentByTaste(highlights, 'movie', resolvedTaste, 12)
        : highlights.slice(0, 12);
      const rankedMovies = resolvedTaste
        ? rankContentByTaste(
          launchMovies.length ? launchMovies : vodList.slice(0, 40),
          'movie',
          resolvedTaste,
          40
        )
        : (launchMovies.length ? launchMovies : vodList.slice(0, 40)).slice(0, 40);
      const rankedSeries = resolvedTaste
        ? rankContentByTaste(
          launchSeries.length ? launchSeries : topSeries.length ? topSeries : seriesList.slice(0, 40),
          'series',
          resolvedTaste,
          40
        )
        : (launchSeries.length ? launchSeries : topSeries.length ? topSeries : seriesList.slice(0, 40)).slice(0, 40);
      const rankedLive = resolvedTaste
        ? rankContentByTaste(liveList, 'live', resolvedTaste, 40)
        : liveList.slice(0, 40);

      
      setPopularMovies(rankedMovies);
      setLiveChannels(rankedLive);
      setFeaturedSeries(rankedSeries);

      
    } catch (error) {
      console.error('[Home] Erro ao enriquecer conteúdo:', error);
    } finally {
      if (version === loadVersionRef.current) {
        setIsAlgorithmLoading(false);
      }
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.allSettled([loadUser(), loadData({ lightweight: false })]);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const aiSettings = await loadAiSettings();
        const runtime = await loadAiRuntimeTuning(aiSettings);
        setAiEnabled(aiSettings.enabled);
        setAiRuntime(runtime);
        setAiLearningWindowMs(
          aiSettings.learningWindow === '1d'
            ? 1000 * 60 * 60 * 24
            : aiSettings.learningWindow === '7d'
              ? 1000 * 60 * 60 * 24 * 7
              : 1000 * 60 * 60 * 24 * 2
        );

        const username = await getDbValue<string>('username');
        if (!username) {
          router.replace('/login');
          return;
        }

        await loadData();

      } finally {
        setIsLoading(false);
      }
    };

    bootstrap();

  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToBackupJob((next) => {
      setBackupJob(next);
      if (next.syncedAt) {
        setLastSyncedAt(next.syncedAt);
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);



  const normalizedSearch = homeSearch.trim().toLowerCase();

  useEffect(() => {
    let canceled = false;

    if (normalizedSearch.length < 2) {
      setSearchResults([]);
      return () => {
        canceled = true;
      };
    }

    void recordSearchEvent(normalizedSearch, 'home');

    void (async () => {
      const [movies, series, live] = await Promise.all([
        queryCatalogPage({ kind: 'vod', search: normalizedSearch, offset: 0, limit: HOME_SEARCH_LIMIT }),
        queryCatalogPage({ kind: 'series', search: normalizedSearch, offset: 0, limit: HOME_SEARCH_LIMIT }),
        queryCatalogPage({ kind: 'live', search: normalizedSearch, offset: 0, limit: HOME_SEARCH_LIMIT }),
      ]);

      if (canceled) return;

      const mappedMovies = movies.map((item) => ({
        id: `search-movie-${toText(item.stream_id)}`,
        type: 'movie' as const,
        title: sanitizeLabelText(item.title || item.name, 'Filme'),
        subtitle: 'Filme',
        image: movieTmdbMap[toText(item.stream_id)]?.posterUrl || toText(item.stream_icon || item.cover),
        data: item,
      }));

      const mappedSeries = series.map((item) => ({
        id: `search-series-${toText(item.series_id)}`,
        type: 'series' as const,
        title: sanitizeLabelText(item.title || item.name, 'Serie'),
        subtitle: 'Serie',
        image: seriesTmdbMap[toText(item.series_id)]?.posterUrl || toText(item.stream_icon || item.cover),
        data: item,
      }));

      const mappedLive = live.map((item) => ({
        id: `search-live-${toText(item.stream_id)}`,
        type: 'live' as const,
        title: sanitizeLabelText(item.name || item.title, 'Canal ao vivo'),
        subtitle: 'TV ao vivo',
        image: toText(item.stream_icon || item.cover),
        data: item,
      }));

      const merged = [...mappedMovies, ...mappedSeries, ...mappedLive].slice(0, HOME_SEARCH_LIMIT * 3);
      setSearchResults(
        access
          ? filterBlockedContent(access, merged, (item) => `${item.title} ${item.subtitle}`)
          : merged
      );
    })().catch(() => {
      if (!canceled) {
        setSearchResults([]);
      }
    });

    return () => {
      canceled = true;
    };
  }, [normalizedSearch, access, movieTmdbMap, seriesTmdbMap]);

  const openMovie = useCallback((item: StreamItem) => {
    const id = toText(item.stream_id);
    if (!id) return;
    router.navigate(`/filme-detalhe?streamId=${encodeURIComponent(id)}` as any);
  }, [router]);

  const openSeries = useCallback((item: StreamItem) => {
    const id = toText(item.series_id);
    if (!id) return;
    router.navigate({
      pathname: '/serie-detalhe',
      params: {
        seriesId: id,
        title: sanitizeLabelText(item.title || item.name, 'Serie'),
        cover: toText(item.stream_icon || item.cover),
      },
    });
  }, [router]);

  const openLive = useCallback(async (item: StreamItem) => {
    const url = await buildLiveUrl(item);
    if (!url) {
      Alert.alert('Erro', 'Nao foi possivel carregar o canal ao vivo.');
      return;
    }
    router.navigate({
      pathname: '/player',
      params: {
        mode: 'live',
        contentId: toText(item.stream_id || item.name || item.title),
        title: sanitizeLabelText(item.name || item.title, 'Canal ao vivo'),
        url,
      },
    });
  }, [router]);

  const openSearchResult = useCallback((item: SearchItem) => {
    if (item.type === 'movie') {
      openMovie(item.data);
      return;
    }
    if (item.type === 'series') {
      openSeries(item.data);
      return;
    }
    openLive(item.data);
  }, [openLive, openMovie, openSeries]);

  const openFeatured = useCallback((item: FeaturedItem) => {
    if (item.type === 'movie') {
      openMovie(item.data);
      return;
    }
    openSeries(item.data);
  }, [openMovie, openSeries]);

  useEffect(() => {
    let canceled = false;

    void (async () => {
      const movieProgressEntries = Object.entries(movieProgressMap)
        .filter(([, state]) => state.progressPercent > 0 && state.progressPercent < 95)
        .sort((a, b) => (a[1].updatedAt > b[1].updatedAt ? -1 : 1));

      const seriesProgressEntries = Object.entries(seriesProgressMap)
        .map(([seriesId, seriesState]) => {
          const latestEpisode = Object.entries(seriesState.episodes || {})
            .filter(([, episode]) => episode.progress > 0 && episode.progress < 100)
            .sort((a, b) => (a[1].updatedAt > b[1].updatedAt ? -1 : 1))[0];

          if (!latestEpisode) return null;

          return { seriesId, latestEpisode };
        })
        .filter(Boolean) as Array<{
          seriesId: string;
          latestEpisode: [string, { progress: number; positionMs: number; updatedAt: string }];
        }>;

      const [movieById, seriesById] = await Promise.all([
        queryCatalogItemsByIds(
          'vod',
          movieProgressEntries.slice(0, 50).map(([movieId]) => movieId)
        ),
        queryCatalogItemsByIds(
          'series',
          seriesProgressEntries.slice(0, 50).map((entry) => entry.seriesId)
        ),
      ]);

      if (canceled) return;

      const movieItems: ContinueItem[] = movieProgressEntries
        .map(([movieId, state]) => {
          const movie = movieById[movieId];
          if (!movie) return null;

          return {
            id: `movie-${movieId}`,
            type: 'movie',
            title: sanitizeLabelText(movie.title || movie.name, 'Filme'),
            subtitle: `Retomar em ${Math.floor(state.positionMs / 60000)} min`,
            image: toText(movie.stream_icon || movie.cover),
            progress: state.progressPercent,
            positionMs: state.positionMs,
            updatedAt: state.updatedAt,
            streamId: movieId,
          };
        })
        .filter(Boolean) as ContinueItem[];

      const seriesItems: ContinueItem[] = seriesProgressEntries
        .map(({ seriesId, latestEpisode }) => {
          const [key, episodeState] = latestEpisode;
          const [season, episode] = key.split(':').map(Number);
          const series = seriesById[seriesId];
          if (!series) return null;

          return {
            id: `series-${seriesId}`,
            type: 'series',
            title: sanitizeLabelText(series.title || series.name, 'Serie'),
            subtitle: `S${season} E${episode}`,
            image: toText(series.stream_icon || series.cover),
            progress: episodeState.progress,
            positionMs: episodeState.positionMs,
            updatedAt: episodeState.updatedAt,
            seriesId,
          };
        })
        .filter(Boolean) as ContinueItem[];

      const merged = [...movieItems, ...seriesItems]
        .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1))
        .slice(0, 20);

      setContinueWatchingItems(
        access
          ? filterBlockedContent(access, merged, (item) => `${item.title} ${item.subtitle}`)
          : merged
      );
    })().catch(() => {
      if (!canceled) {
        setContinueWatchingItems([]);
      }
    });

    return () => {
      canceled = true;
    };
  }, [movieProgressMap, seriesProgressMap, access]);

  const displayFeaturedItems = useMemo(() => {
    if (!access) return featuredItems;

    return filterBlockedContent(
      access,
      featuredItems,
      (item) =>
        `${toText(item.data.title || item.data.name)} ${toText(item.data.category_name)} ${toText(item.data.genre)} ${toText(item.data.plot)}`
    );
  }, [featuredItems, access]);

  const displayPopularMovies = useMemo(() => {
    if (!access) return popularMovies;

    return filterBlockedContent(
      access,
      popularMovies,
      (item) => `${toText(item.title || item.name)} ${toText(item.category_name)} ${toText(item.genre)} ${toText(item.plot)}`
    );
  }, [popularMovies, access]);

  const displayFeaturedSeries = useMemo(() => {
    if (!access) return featuredSeries;

    return filterBlockedContent(
      access,
      featuredSeries,
      (item) => `${toText(item.title || item.name)} ${toText(item.category_name)} ${toText(item.genre)} ${toText(item.plot)}`
    );
  }, [featuredSeries, access]);

  const displayLiveChannels = useMemo(() => {
    if (!access) return liveChannels;

    return filterBlockedContent(
      access,
      liveChannels,
      (item) => `${toText(item.name || item.title)} ${toText(item.category_name)}`
    );
  }, [liveChannels, access]);

  const hideImages = !!access && shouldHideContentImages(access);

  useEffect(() => {
    if (isLoading) return;

    setContentStage(HOME_STAGE_MOVIES);

    let isCanceled = false;
    InteractionManager.runAfterInteractions(() => {
      if (isCanceled) return;
      setTimeout(() => {
        if (isCanceled) return;
        setContentStage(HOME_STAGE_SERIES);
      }, 120);

      setTimeout(() => {
        if (isCanceled) return;
        setContentStage(HOME_STAGE_LIVE);
      }, 260);
    });

    return () => {
      isCanceled = true;
    };
  }, [
    isLoading,
    displayPopularMovies.length,
    displayFeaturedSeries.length,
    displayLiveChannels.length,
  ]);

  const handleUnlock = async (pin: string) => {
    const ok = await unlockParentalAccess(pin);
    if (!ok) {
      Alert.alert('PIN incorreto', 'Nao foi possivel desbloquear o conteudo.');
      return;
    }

    setShowUnlockModal(false);
    setAccess(await loadAccessSnapshot());
  };

  useEffect(() => {
    if (displayFeaturedItems.length <= 1) return;

    const timer = setInterval(() => {
      setActiveFeaturedIndex((prev) => {
        const next = (prev + 1) % displayFeaturedItems.length;
        featuredListRef.current?.scrollToIndex({ index: next, animated: true });
        return next;
      });
    }, 4500);

    return () => clearInterval(timer);
  }, [displayFeaturedItems.length]);

  const openContinueItem = useCallback((item: ContinueItem) => {
    if (item.type === 'movie' && item.streamId) {
      router.navigate({
        pathname: '/filme-detalhe',
        params: {
          streamId: item.streamId,
          startPositionMs: String(item.positionMs || 0),
        },
      } as any);
      return;
    }

    if (item.type === 'series' && item.seriesId) {
      router.navigate({
        pathname: '/serie-detalhe',
        params: {
          seriesId: item.seriesId,
          title: sanitizeLabelText(item.title, 'Serie'),
          cover: toText(item.image),
          startPositionMs: String(item.positionMs || 0),
        },
      });
    }
  }, [router]);

  const getReasonLabel = (item: StreamItem, type: 'movie' | 'series' | 'live') => {
    if (!tasteProfile) return '';
    return getRecommendationReasons(item, type, tasteProfile)[0] || '';
  };

  const contextualNudge = useMemo<ContextBannerMeta>(() => {
    const now = new Date();
    const hour = now.getHours();
    const isNight = hour >= 18 && hour < 24;
    const isWeekend = [0, 6].includes(now.getDay());

    if (!tasteProfile) {
      if (isNight) {
        return {
          message: 'Boa noite: selecionamos titulos para relaxar e assistir por mais tempo.',
          icon: 'nights-stay',
          tint: '#5DA8FF',
          background: 'rgba(93,168,255,0.14)',
          border: 'rgba(93,168,255,0.36)',
        };
      }
      if (isWeekend) {
        return {
          message: 'Fim de semana no ar: aproveite para descobrir algo novo.',
          icon: 'event',
          tint: '#FFD166',
          background: 'rgba(255,209,102,0.15)',
          border: 'rgba(255,209,102,0.38)',
        };
      }
      return {
        message: 'Sua selecao se adapta ao seu ritmo de uso no app.',
        icon: 'auto-awesome',
        tint: StreamingTheme.colors.accentAlt,
        background: 'rgba(255,143,58,0.14)',
        border: 'rgba(255,143,58,0.38)',
      };
    }

    const movieScore = tasteProfile.typeScores.movie || 0;
    const seriesScore = tasteProfile.typeScores.series || 0;
    const liveScore = tasteProfile.typeScores.live || 0;

    const topType: 'movie' | 'series' | 'live' =
      seriesScore >= movieScore && seriesScore >= liveScore
        ? 'series'
        : movieScore >= liveScore
          ? 'movie'
          : 'live';

    if (isWeekend && topType === 'series') {
      return {
        message: 'Fim de semana com cara de maratona: mais series relevantes para voce.',
        icon: 'local-fire-department',
        tint: '#FF9F43',
        background: 'rgba(255,159,67,0.16)',
        border: 'rgba(255,159,67,0.4)',
      };
    }

    if (isNight && (topType === 'movie' || topType === 'series')) {
      return {
        message: `Noite ideal para ${topType === 'movie' ? 'filmes' : 'series'}: ranqueamos opcoes com maior match.`,
        icon: topType === 'movie' ? 'movie' : 'tv',
        tint: '#8EC5FF',
        background: 'rgba(142,197,255,0.16)',
        border: 'rgba(142,197,255,0.42)',
      };
    }

    if (isWeekend) {
      return {
        message: 'Fim de semana ativo: seu ranking recebeu boost para sessoes mais longas.',
        icon: 'event',
        tint: '#FFD166',
        background: 'rgba(255,209,102,0.15)',
        border: 'rgba(255,209,102,0.38)',
      };
    }

    if (isNight) {
      return {
        message: 'Horario nobre: priorizamos conteudos que combinam com seu habito noturno.',
        icon: 'schedule',
        tint: '#5DA8FF',
        background: 'rgba(93,168,255,0.14)',
        border: 'rgba(93,168,255,0.36)',
      };
    }

    return {
      message: 'Recomendacoes inteligentes atualizadas conforme seu perfil e horario.',
      icon: 'auto-awesome',
      tint: StreamingTheme.colors.accentAlt,
      background: 'rgba(255,143,58,0.14)',
      border: 'rgba(255,143,58,0.38)',
    };
  }, [tasteProfile]);

  useEffect(() => {
    const next = { background: contextualNudge.background, border: contextualNudge.border };

    if (!bannerTo) {
      setBannerFrom(next);
      setBannerTo(next);
      return;
    }

    const unchanged =
      bannerTo.background === next.background &&
      bannerTo.border === next.border;

    if (unchanged) return;

    setBannerFrom(bannerTo);
    setBannerTo(next);
    bannerTransition.setValue(0);
    Animated.timing(bannerTransition, {
      toValue: 1,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [contextualNudge.background, contextualNudge.border, bannerTo, bannerTransition]);

  useEffect(() => {
    bannerContentTransition.setValue(0);
    Animated.timing(bannerContentTransition, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [contextualNudge.message, contextualNudge.icon, contextualNudge.tint, bannerContentTransition]);

  const animatedBannerBackground = bannerTransition.interpolate({
    inputRange: [0, 1],
    outputRange: [
      bannerFrom?.background || contextualNudge.background,
      bannerTo?.background || contextualNudge.background,
    ],
  });

  const animatedBannerBorder = bannerTransition.interpolate({
    inputRange: [0, 1],
    outputRange: [
      bannerFrom?.border || contextualNudge.border,
      bannerTo?.border || contextualNudge.border,
    ],
  });

  const animatedBannerContentY = bannerContentTransition.interpolate({
    inputRange: [0, 1],
    outputRange: [5, 0],
  });

  const syncBanner = useMemo(() => {
    if (backupJob.isRunning) {
      return {
        icon: 'sync' as const,
        text: `Sincronizando em segundo plano • ${backupJob.progress}%`,
        background: 'rgba(93,169,255,0.14)',
        border: 'rgba(93,169,255,0.32)',
        tint: '#5DA9FF',
      };
    }

    if (backupJob.stage === 'error') {
      return {
        icon: 'sync-problem' as const,
        text: 'Falha na sincronizacao em segundo plano',
        background: 'rgba(255,59,48,0.14)',
        border: 'rgba(255,59,48,0.32)',
        tint: '#FF6B6B',
      };
    }

    const syncedAt = backupJob.syncedAt || lastSyncedAt;
    if (!syncedAt) {
      return null;
    }

    return {
      icon: 'cloud-done' as const,
      text: `Sincronizado: ${new Date(syncedAt).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
      })}`,
      background: 'rgba(70,215,183,0.14)',
      border: 'rgba(70,215,183,0.32)',
      tint: '#46D7B7',
    };
  }, [backupJob, lastSyncedAt]);

  const homeSections = useMemo<HomeSectionId[]>(() => {
    const sections: HomeSectionId[] = ['featured'];
    if (continueWatchingItems.length > 0) {
      sections.push('continue');
    }
    if (contentStage >= HOME_STAGE_MOVIES) {
      sections.push('movies');
    }
    if (contentStage >= HOME_STAGE_SERIES) {
      sections.push('series');
    }
    if (contentStage >= HOME_STAGE_LIVE) {
      sections.push('live');
    }
    return sections;
  }, [continueWatchingItems.length, contentStage]);

  useEffect(() => {
    setMountedSections((prev) => {
      let changed = false;
      const next = { ...prev, featured: true };
      for (const section of homeSections) {
        if (next[section] === undefined) {
          next[section] = false;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [homeSections]);

  const onSectionsViewableChanged = useRef(({ viewableItems }: { viewableItems: Array<ViewToken> }) => {
    setMountedSections((prev) => {
      const next = { ...prev };
      let changed = false;

      for (const token of viewableItems) {
        const section = token.item as HomeSectionId;
        if (!section) continue;
        if (!next[section]) {
          next[section] = true;
          changed = true;
        }

        const currentIndex = SECTION_ORDER.indexOf(section);
        if (currentIndex >= 0 && currentIndex < SECTION_ORDER.length - 1) {
          const preloadSection = SECTION_ORDER[currentIndex + 1];
          if (!next[preloadSection]) {
            next[preloadSection] = true;
            changed = true;
          }
        }
      }

      return changed ? next : prev;
    });
  }).current;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={30} />
      <PageLoader visible={isLoading || (hasRecommendationAlgorithm && isAlgorithmLoading)} label="Atualizando inicio" />

      <FlatList<HomeSectionId>
        data={homeSections}
        keyExtractor={(item) => item}
        removeClippedSubviews
        initialNumToRender={2}
        maxToRenderPerBatch={2}
        windowSize={5}
        updateCellsBatchingPeriod={55}
        viewabilityConfig={SECTION_VIEWABILITY_CONFIG}
        onViewableItemsChanged={onSectionsViewableChanged}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />}
        ListHeaderComponent={(
          <>
            <View style={styles.header}>
              <View>
                <Text style={styles.kicker}>Sua sala de cinema</Text>
                <Text style={styles.title}>Inicio</Text>
                <Text style={styles.userName}>{userName}</Text>
              </View>
              <TouchableOpacity style={styles.activeProfileBadge} onPress={() => router.push('/conta')}>
                {activeProfileAvatar ? (
                  <Image source={{ uri: activeProfileAvatar }} style={styles.activeProfileAvatar} cachePolicy="disk" />
                ) : (
                  <View style={[styles.activeProfileAvatar, styles.activeProfileAvatarFallback]}>
                    <MaterialIcons name="person" size={16} color={StreamingTheme.colors.textPrimary} />
                  </View>
                )}
                <View style={styles.activeProfileTextWrap}>
                  <Text style={styles.activeProfileLabel}>Perfil atual</Text>
                  <Text style={styles.activeProfileName} numberOfLines={1}>
                    {userName.replace('Perfil ativo: ', '').replace('Conta: ', '')}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>

            {isFree ? (
              <TouchableOpacity
                style={styles.upgradeBanner}
                onPress={() => router.push('/assinar')}
                activeOpacity={0.85}
              >
                <MaterialIcons name="workspace-premium" size={15} color="#FF8F3A" />
                <Text style={styles.upgradeBannerText}>
                  Desbloqueie Explorar, Downloads, Listas e muito mais
                </Text>
                <MaterialIcons name="chevron-right" size={16} color="#FF8F3A" />
              </TouchableOpacity>
            ) : (
              <Animated.View
                style={[
                  styles.contextBanner,
                  { backgroundColor: animatedBannerBackground, borderColor: animatedBannerBorder },
                ]}
              >
                <Animated.View
                  style={[
                    styles.contextBannerContent,
                    {
                      opacity: bannerContentTransition,
                      transform: [{ translateY: animatedBannerContentY }],
                    },
                  ]}
                >
                  <MaterialIcons name={contextualNudge.icon} size={14} color={contextualNudge.tint} />
                  <Text style={styles.contextBannerText}>{contextualNudge.message}</Text>
                </Animated.View>
              </Animated.View>
            )}

            {syncBanner ? (
              <View
                style={[
                  styles.syncBanner,
                  {
                    backgroundColor: syncBanner.background,
                    borderColor: syncBanner.border,
                  },
                ]}
              >
                <MaterialIcons name={syncBanner.icon} size={14} color={syncBanner.tint} />
                <Text style={styles.syncBannerText}>{syncBanner.text}</Text>
              </View>
            ) : null}

            <View style={styles.searchWrap}>
              <MaterialIcons name="search" size={18} color={StreamingTheme.colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                value={homeSearch}
                onChangeText={setHomeSearch}
                placeholder="Buscar filme, serie ou canal"
                placeholderTextColor={StreamingTheme.colors.textMuted}
              />
            </View>

            {searchResults.length > 0 && (
              <>
                <Section title="Resultados da busca" action="Limpar" onPress={() => setHomeSearch('')} />
                <View style={styles.searchResultsWrap}>
                  {searchResults.map((item) => (
                    <TouchableOpacity key={item.id} style={styles.searchResultCard} onPress={() => openSearchResult(item)}>
                      {hideImages ? (
                        <View style={[styles.searchResultImage, styles.hiddenImageWrap]}>
                          <MaterialIcons name="image-not-supported" size={18} color={StreamingTheme.colors.textMuted} />
                        </View>
                      ) : (
                        <Image source={{ uri: item.image }} style={styles.searchResultImage} cachePolicy="disk" />
                      )}
                      <View style={styles.searchResultMain}>
                        <Text style={styles.searchResultTitle} numberOfLines={1}>{item.title}</Text>
                        <Text style={styles.searchResultSub}>{item.subtitle}</Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
          </>
        )}
        renderItem={({ item }) => {
          if (!mountedSections[item]) {
            return <View style={[styles.sectionPlaceholder, { height: SECTION_PLACEHOLDER_HEIGHT[item] }]} />;
          }

          if (item === 'featured') {
            return (
              <>
                <Section title="Em destaque" action="Ver todos" onPress={() => router.navigate('/destaques' as any)} />
                <FlatList
                  ref={featuredListRef}
                  horizontal
                  removeClippedSubviews
                  initialNumToRender={3}
                  maxToRenderPerBatch={3}
                  windowSize={4}
                  updateCellsBatchingPeriod={40}
                  pagingEnabled
                  decelerationRate="fast"
                  snapToAlignment="center"
                  data={displayFeaturedItems}
                  renderItem={({ item: featured }) => (
                    <TouchableOpacity style={styles.heroCard} onPress={() => openFeatured(featured)}>
                      {hideImages ? (
                        <View style={[styles.heroImage, styles.hiddenImageWrap]}>
                          <MaterialIcons name="image-not-supported" size={26} color={StreamingTheme.colors.textMuted} />
                        </View>
                      ) : (
                        <Image
                          source={{
                            uri:
                              featured.type === 'movie'
                                ? movieTmdbMap[toText(featured.data.stream_id)]?.backdropUrl || movieTmdbMap[toText(featured.data.stream_id)]?.posterUrl || toText(featured.data.stream_icon || featured.data.cover)
                                : seriesTmdbMap[toText(featured.data.series_id)]?.backdropUrl || seriesTmdbMap[toText(featured.data.series_id)]?.posterUrl || toText(featured.data.stream_icon || featured.data.cover),
                          }}
                          style={styles.heroImage}
                          cachePolicy="disk"
                        />
                      )}
                      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.9)']} style={styles.heroOverlay}>
                        <Text style={styles.heroTitle} numberOfLines={1}>
                          {sanitizeLabelText(featured.data.title || featured.data.name, 'Sem titulo')}
                        </Text>
                        <Text style={styles.heroSubtitle} numberOfLines={1}>
                          {sanitizeLabelText(featured.data.plot, featured.type === 'series' ? 'Serie em destaque' : 'Filme em destaque')}
                        </Text>
                        {!!tasteProfile && hasRecommendationAlgorithm && aiRuntime.enableRecommendationChips && (
                          <RecommendationChip
                            reason={getReasonLabel(featured.data, featured.type)}
                            overlay
                            numberOfLines={1}
                            style={styles.reasonChipOverlay}
                          />
                        )}
                      </LinearGradient>
                    </TouchableOpacity>
                  )}
                  onMomentumScrollEnd={(event) => {
                    const width = 302;
                    const index = Math.round(event.nativeEvent.contentOffset.x / width);
                    setActiveFeaturedIndex(index);
                  }}
                  keyExtractor={(featured) => featured.id}
                  getItemLayout={(_data, index) => ({ length: 302, offset: 302 * index, index })}
                  onScrollToIndexFailed={(info) => {
                    featuredListRef.current?.scrollToOffset({ offset: info.index * 302, animated: true });
                  }}
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.horizontalList}
                />
                <View style={styles.dotsRow}>
                  {displayFeaturedItems.map((featured, index) => (
                    <View
                      key={`dot-${featured.id}`}
                      style={[styles.dot, activeFeaturedIndex === index && styles.dotActive]}
                    />
                  ))}
                </View>
              </>
            );
          }

          if (item === 'continue') {
            return (
              <>
                <Section title="Continue Assistindo" action="Ver todos" onPress={() => router.navigate('/continuar-assistindo' as any)} />
                <FlatList
                  horizontal
                  data={continueWatchingItems}
                  removeClippedSubviews
                  initialNumToRender={4}
                  maxToRenderPerBatch={4}
                  windowSize={4}
                  updateCellsBatchingPeriod={40}
                  renderItem={({ item: continueItem }) => (
                    <ContinueCard
                      item={continueItem}
                      hideImage={hideImages}
                      onPress={() => openContinueItem(continueItem)}
                    />
                  )}
                  keyExtractor={(continueItem) => continueItem.id}
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.horizontalList}
                />
              </>
            );
          }

          if (item === 'movies') {
            return (
              <>
                <Section title="Filmes" action="Ver todos" onPress={() => router.navigate('/filmes')} />
                <FlatList
                  horizontal
                  data={displayPopularMovies}
                  removeClippedSubviews
                  initialNumToRender={3}
                  maxToRenderPerBatch={3}
                  windowSize={3}
                  updateCellsBatchingPeriod={55}
                  renderItem={({ item: movie }) => (
                    <PosterCard
                      item={movie}
                      onPress={() => openMovie(movie)}
                      hideImage={hideImages}
                      meta={movieTmdbMap[toText(movie.stream_id)]}
                      reason={hasRecommendationAlgorithm && aiRuntime.enableRecommendationChips ? getReasonLabel(movie, 'movie') : ''}
                    />
                  )}
                  keyExtractor={(movie, i) => String(movie.stream_id ?? `movie-${i}`)}
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.horizontalList}
                />
              </>
            );
          }

          if (item === 'series') {
            return (
              <>
                <Section title="Series" action="Ver todas" onPress={() => router.navigate('/series')} />
                <FlatList
                  horizontal
                  data={displayFeaturedSeries}
                  removeClippedSubviews
                  initialNumToRender={3}
                  maxToRenderPerBatch={3}
                  windowSize={3}
                  updateCellsBatchingPeriod={55}
                  renderItem={({ item: seriesItem }) => (
                    <PosterCard
                      item={seriesItem}
                      onPress={() => openSeries(seriesItem)}
                      hideImage={hideImages}
                      meta={seriesTmdbMap[toText(seriesItem.series_id)]}
                      reason={hasRecommendationAlgorithm && aiRuntime.enableRecommendationChips ? getReasonLabel(seriesItem, 'series') : ''}
                    />
                  )}
                  keyExtractor={(seriesItem, i) => String(seriesItem.series_id ?? `series-${i}`)}
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.horizontalList}
                />
              </>
            );
          }

          return (
            <>
              <Section title="Canais ao vivo" action="Ver todos" onPress={() => router.navigate('/ao-vivo')} />
              <FlatList
                horizontal
                data={displayLiveChannels}
                removeClippedSubviews
                initialNumToRender={3}
                maxToRenderPerBatch={3}
                windowSize={3}
                onContentSizeChange={() => setIsLoading(false)}
                updateCellsBatchingPeriod={55}
                renderItem={({ item: live }) => (
                  <LiveCard
                    item={live}
                    hideImage={hideImages}
                    reason={!!tasteProfile && hasRecommendationAlgorithm && aiRuntime.enableRecommendationChips ? getReasonLabel(live, 'live') : ''}
                    onPress={() => openLive(live)}
                  />
                )}
                keyExtractor={(live, i) => String(live.stream_id ?? `live-${i}`)}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.horizontalList}
              />
            </>
          );
        }}
      />

      <ParentalUnlockModal
        visible={showUnlockModal}
        onClose={() => setShowUnlockModal(false)}
        onConfirm={handleUnlock}
      />
    </SafeAreaView>
  );
}

function Section({ title, action, onPress }: { title: string; action: string; onPress: () => void }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <TouchableOpacity onPress={onPress}>
        <Text style={styles.sectionAction}>{action}</Text>
      </TouchableOpacity>
    </View>
  );
}

const PosterCard = React.memo(function PosterCard({
  item,
  onPress,
  hideImage,
  meta,
  reason,
}: {
  item: StreamItem;
  onPress: () => void;
  hideImage: boolean;
  meta?: TmdbMeta;
  reason?: string;
}) {
  return (
    <TouchableOpacity style={styles.posterCard} onPress={onPress}>
      {hideImage ? (
        <View style={[styles.posterImage, styles.hiddenImageWrap]}>
          <MaterialIcons name="image-not-supported" size={22} color={StreamingTheme.colors.textMuted} />
        </View>
      ) : (
        <Image source={{ uri: meta?.posterUrl || toText(item.stream_icon || item.cover) }} style={styles.posterImage} cachePolicy="disk" />
      )}
      <Text style={styles.posterTitle} numberOfLines={1}>
        {sanitizeLabelText(item.title || item.name, 'Sem titulo')}
      </Text>
      <View style={styles.posterMetaRow}>
        <MaterialIcons name="star" size={12} color={StreamingTheme.colors.warning} />
        <Text style={styles.posterMeta}>{meta?.rating ? String(meta.rating) : toText(item.rating || item.rating_5based, 'N/A')}</Text>
        {!!meta?.releaseYear && <Text style={styles.posterMeta}>• {meta.releaseYear}</Text>}
      </View>
      {!!reason && <RecommendationChip reason={reason} numberOfLines={2} style={styles.reasonChipPoster} />}
    </TouchableOpacity>
  );
}, (prev, next) => {
  return (
    prev.hideImage === next.hideImage &&
    prev.reason === next.reason &&
    toText(prev.item.stream_id) === toText(next.item.stream_id) &&
    toText(prev.item.series_id) === toText(next.item.series_id) &&
    prev.meta?.posterUrl === next.meta?.posterUrl &&
    prev.meta?.rating === next.meta?.rating &&
    prev.meta?.releaseYear === next.meta?.releaseYear
  );
});

const ContinueCard = React.memo(function ContinueCard({
  item,
  hideImage,
  onPress,
}: {
  item: ContinueItem;
  hideImage: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.continueCard} onPress={onPress}>
      {hideImage ? (
        <View style={[styles.continueImage, styles.hiddenImageWrap]}>
          <MaterialIcons name="image-not-supported" size={22} color={StreamingTheme.colors.textMuted} />
        </View>
      ) : (
        <Image source={{ uri: item.image }} style={styles.continueImage} cachePolicy="disk" />
      )}
      <View style={styles.continueProgressTrack}>
        <View style={[styles.continueProgressFill, { width: `${item.progress}%` }]} />
      </View>
      <Text style={styles.continueTitle} numberOfLines={1}>{item.title}</Text>
      <Text style={styles.continueSubTitle} numberOfLines={1}>{item.subtitle}</Text>
    </TouchableOpacity>
  );
}, (prev, next) => {
  return (
    prev.hideImage === next.hideImage &&
    prev.item.id === next.item.id &&
    prev.item.image === next.item.image &&
    prev.item.title === next.item.title &&
    prev.item.subtitle === next.item.subtitle &&
    prev.item.progress === next.item.progress
  );
});

const LiveCard = React.memo(function LiveCard({
  item,
  hideImage,
  reason,
  onPress,
}: {
  item: StreamItem;
  hideImage: boolean;
  reason?: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.liveCard} onPress={onPress}>
      <View style={styles.liveLogoWrap}>
        {hideImage ? (
          <View style={styles.hiddenLiveLogo}>
            <MaterialIcons name="image-not-supported" size={20} color={StreamingTheme.colors.textMuted} />
          </View>
        ) : (
          <Image source={{ uri: toText(item.stream_icon || item.cover) }} style={styles.liveLogo} cachePolicy="disk" />
        )}
      </View>
      <Text style={styles.liveTitle} numberOfLines={2}>
        {sanitizeLabelText(item.name || item.title || item.category_name, 'Canal')}
      </Text>
      {!!reason && (
        <RecommendationChip
          reason={reason}
          numberOfLines={2}
          style={styles.reasonChipLive}
        />
      )}
      <View style={styles.liveTag}>
        <View style={styles.liveDot} />
        <Text style={styles.liveTagText}>AO VIVO</Text>
      </View>
    </TouchableOpacity>
  );
}, (prev, next) => {
  return (
    prev.hideImage === next.hideImage &&
    prev.reason === next.reason &&
    toText(prev.item.stream_id) === toText(next.item.stream_id) &&
    toText(prev.item.name || prev.item.title) === toText(next.item.name || next.item.title) &&
    toText(prev.item.stream_icon || prev.item.cover) === toText(next.item.stream_icon || next.item.cover)
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },
  content: { paddingBottom: 120 },
  sectionPlaceholder: {
    marginTop: 14,
    marginHorizontal: 18,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  header: {
    paddingHorizontal: 18,
    paddingTop: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  kicker: {
    color: StreamingTheme.colors.accentAlt,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 4,
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 30,
    fontWeight: '900',
  },
  userName: {
    color: StreamingTheme.colors.textSecondary,
    marginTop: 4,
  },
  activeProfileBadge: {
    minWidth: 124,
    maxWidth: 180,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  activeProfileAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  activeProfileAvatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  activeProfileTextWrap: {
    flex: 1,
    gap: 2,
  },
  activeProfileLabel: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  activeProfileName: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
  },
  searchWrap: {
    marginTop: 14,
    marginHorizontal: 18,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    borderRadius: 14,
    backgroundColor: StreamingTheme.colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    height: 46,
    color: StreamingTheme.colors.textPrimary,
  },
  searchResultsWrap: {
    paddingHorizontal: 18,
    gap: 8,
  },
  contextBanner: {
    marginTop: 10,
    marginHorizontal: 18,
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 40,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  contextBannerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flex: 1,
  },
  contextBannerText: {
    flex: 1,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  upgradeBanner: {
    marginTop: 10,
    marginHorizontal: 18,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,143,58,0.28)',
    backgroundColor: 'rgba(255,143,58,0.12)',
    minHeight: 42,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  upgradeBannerText: {
    flex: 1,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },
  syncBanner: {
    marginTop: 8,
    marginHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1,
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  syncBannerText: {
    flex: 1,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  lockBanner: {
    marginTop: 10,
    marginHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,59,48,0.45)',
    backgroundColor: 'rgba(255,59,48,0.2)',
    minHeight: 38,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  lockBannerText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  hiddenImageWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: StreamingTheme.colors.surface,
  },
  searchResultCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchResultImage: {
    width: 52,
    height: 52,
    borderRadius: 8,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
  },
  searchResultMain: {
    flex: 1,
  },
  searchResultTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
  },
  searchResultSub: {
    marginTop: 2,
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  sectionHeader: {
    marginTop: 20,
    marginBottom: 10,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 19,
    fontWeight: '800',
  },
  sectionAction: {
    color: StreamingTheme.colors.accentAlt,
    fontWeight: '700',
  },
  horizontalList: {
    paddingHorizontal: 18,
    gap: 12,
  },
  heroCard: {
    width: 290,
    height: 160,
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
  },
  dotsRow: {
    marginTop: 8,
    marginBottom: 2,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  dotActive: {
    width: 16,
    backgroundColor: StreamingTheme.colors.accentAlt,
  },
  heroImage: { width: '100%', height: '100%' },
  heroOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 12,
  },
  heroTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '800',
  },
  heroSubtitle: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    marginTop: 4,
  },
  reasonChipOverlay: {
    marginTop: 6,
  },
  posterCard: {
    width: 152,
  },
  posterImage: {
    width: 152,
    height: 228,
    borderRadius: 12,
    backgroundColor: StreamingTheme.colors.surface,
    marginBottom: 8,
  },
  posterTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  posterMetaRow: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  posterMeta: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  reasonChipPoster: {
    marginTop: 4,
  },
  continueCard: {
    width: 148,
  },
  continueImage: {
    width: 148,
    height: 96,
    borderRadius: 12,
    backgroundColor: StreamingTheme.colors.surface,
    marginBottom: 8,
  },
  continueProgressTrack: {
    height: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.2)',
    overflow: 'hidden',
    marginBottom: 6,
  },
  continueProgressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: StreamingTheme.colors.accent,
  },
  continueTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },
  continueSubTitle: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  liveCard: {
    width: 170,
    minHeight: 160,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    padding: 12,
    justifyContent: 'space-between',
  },
  liveLogoWrap: {
    height: 54,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
    overflow: 'hidden',
  },
  liveLogo: {
    width: '80%',
    height: '70%',
  },
  hiddenLiveLogo: {
    width: '80%',
    height: '70%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 14,
    minHeight: 34,
  },
  reasonChipLive: {
    marginTop: 4,
    marginBottom: 8,
  },
  liveTag: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    backgroundColor: 'rgba(255,59,48,0.2)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: StreamingTheme.colors.accent,
  },
  liveTagText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 10,
  },
});
