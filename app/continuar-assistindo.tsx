import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';

import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Dimensions,
  FlatList,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PageLoader } from '@/components/page-loader';
import { AppBackdrop } from '@/components/app-backdrop';
import { StreamingTheme } from '@/constants/streaming-theme';
import {
  AccessSnapshot,
  filterBlockedContent,
  loadAccessSnapshot,
  shouldHideContentImages,
} from '@/services/access-control';
import { loadCatalogData, sanitizeLabelText, StreamItem, toText } from '@/services/catalog-data';
import { loadMovieProgressMap, MovieProgressMap } from '@/services/movie-progress';
import { loadSeriesProgressMap, SeriesProgressMap } from '@/services/series-progress';

const { width: SCREEN_W } = Dimensions.get('window');
const CARD_W = (SCREEN_W - 48) / 2;

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
  seasonEp?: string;
};

export default function ContinuarAssistindoScreen() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [items, setItems] = useState<ContinueItem[]>([]);
  const [allMovies, setAllMovies] = useState<StreamItem[]>([]);
  const [allSeries, setAllSeries] = useState<StreamItem[]>([]);
  const [movieProgressMap, setMovieProgressMap] = useState<MovieProgressMap>({});
  const [seriesProgressMap, setSeriesProgressMap] = useState<SeriesProgressMap>({});
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'movie' | 'series'>('all');
  const [access, setAccess] = useState<AccessSnapshot | null>(null);

  const loadAll = async () => {
    const [{ vod, series }, movieMap, seriesMap, snapshot] = await Promise.all([
      loadCatalogData(),
      loadMovieProgressMap(),
      loadSeriesProgressMap(),
      loadAccessSnapshot(),
    ]);
    setAllMovies(vod as StreamItem[]);
    setAllSeries(series as StreamItem[]);
    setMovieProgressMap(movieMap);
    setSeriesProgressMap(seriesMap);
    setAccess(snapshot);
    setIsLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  // Recarregar progresso ao voltar para a tela
  useFocusEffect(
    React.useCallback(() => {
      const refresh = async () => {
        const [movieMap, seriesMap, snapshot] = await Promise.all([
          loadMovieProgressMap(),
          loadSeriesProgressMap(),
          loadAccessSnapshot(),
        ]);
        setMovieProgressMap(movieMap);
        setSeriesProgressMap(seriesMap);
        setAccess(snapshot);
      };
      refresh();
    }, [])
  );

  const continueItems: ContinueItem[] = useMemo(() => {
    const movieItems: ContinueItem[] = Object.entries(movieProgressMap)
      .filter(([, state]) => state.progressPercent > 0 && state.progressPercent < 95)
      .map(([movieId, state]) => {
        const movie = allMovies.find((item) => toText(item.stream_id) === movieId);
        if (!movie) return null;
        const mins = Math.floor(state.positionMs / 60000);
        return {
          id: `movie-${movieId}`,
          type: 'movie',
          title: sanitizeLabelText(movie.title || movie.name, 'Filme'),
          subtitle: mins > 0 ? `Retomar em ${mins} min` : 'Continuar assistindo',
          image: toText(movie.stream_icon || movie.cover),
          progress: state.progressPercent,
          positionMs: state.positionMs,
          updatedAt: state.updatedAt,
          streamId: movieId,
        };
      })
      .filter(Boolean) as ContinueItem[];

    const seriesItems: ContinueItem[] = Object.entries(seriesProgressMap)
      .map(([seriesId, seriesState]) => {
        const latestEpisode = Object.entries(seriesState.episodes || {})
          .filter(([, episode]) => episode.progress > 0 && episode.progress < 100)
          .sort((a, b) => (a[1].updatedAt > b[1].updatedAt ? -1 : 1))[0];

        if (!latestEpisode) return null;

        const [key, episodeState] = latestEpisode;
        const [season, episode] = key.split(':').map(Number);
        const series = allSeries.find((item) => toText(item.series_id) === seriesId);
        if (!series) return null;

        return {
          id: `series-${seriesId}`,
          type: 'series',
          title: sanitizeLabelText(series.title || series.name, 'Serie'),
          subtitle: `Temporada ${season}, Ep. ${episode}`,
          image: toText(series.stream_icon || series.cover),
          progress: episodeState.progress,
          positionMs: episodeState.positionMs,
          updatedAt: episodeState.updatedAt,
          seriesId,
          seasonEp: `S${season} E${episode}`,
        };
      })
      .filter(Boolean) as ContinueItem[];

    const merged = [...movieItems, ...seriesItems].sort((a, b) =>
      a.updatedAt > b.updatedAt ? -1 : 1
    );

    if (!access) return merged;
    return filterBlockedContent(access, merged, (item) => `${item.title} ${item.subtitle}`);
  }, [movieProgressMap, seriesProgressMap, allMovies, allSeries, access]);

  const hideImages = !!access && shouldHideContentImages(access);

  const filtered = useMemo(() => {
    let result = continueItems;
    if (activeFilter !== 'all') result = result.filter((item) => item.type === activeFilter);
    if (search.trim().length >= 2) {
      result = result.filter((item) =>
        item.title.toLowerCase().includes(search.trim().toLowerCase())
      );
    }
    return result;
  }, [continueItems, activeFilter, search]);

  const openItem = (item: ContinueItem) => {
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
      const series = allSeries.find((entry) => toText(entry.series_id) === item.seriesId);
      router.navigate({
        pathname: '/serie-detalhe',
        params: {
          seriesId: item.seriesId,
          title: item.title,
          cover: toText(series?.stream_icon || series?.cover),
          startPositionMs: String(item.positionMs || 0),
        },
      });
    }
  };

  const FILTERS = [
    { key: 'all', label: 'Todos' },
    { key: 'movie', label: 'Filmes' },
    { key: 'series', label: 'Séries' },
  ] as const;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isLoading} label="Carregando histórico" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.kicker}>Histórico</Text>
          <Text style={styles.title}>Continue Assistindo</Text>
        </View>
        <View style={styles.backBtn} />
      </View>

      {/* Search */}
      <View style={styles.searchWrap}>
        <MaterialIcons name="search" size={18} color={StreamingTheme.colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Buscar no histórico"
          placeholderTextColor={StreamingTheme.colors.textMuted}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')}>
            <MaterialIcons name="close" size={18} color={StreamingTheme.colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {/* Filters */}
      <View style={styles.filterRow}>
        {FILTERS.map((f) => (
          <TouchableOpacity
            key={f.key}
            style={[styles.filterChip, activeFilter === f.key && styles.filterChipActive]}
            onPress={() => setActiveFilter(f.key)}
          >
            <Text style={[styles.filterText, activeFilter === f.key && styles.filterTextActive]}>
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
        <Text style={styles.countText}>{filtered.length} {filtered.length === 1 ? 'item' : 'itens'}</Text>
      </View>

      {/* Empty state */}
      {!isLoading && filtered.length === 0 && (
        <View style={styles.emptyState}>
          <MaterialIcons name="history" size={52} color={StreamingTheme.colors.textMuted} />
          <Text style={styles.emptyTitle}>
            {continueItems.length === 0 ? 'Nenhum conteúdo iniciado' : 'Nenhum resultado'}
          </Text>
          <Text style={styles.emptyDesc}>
            {continueItems.length === 0
              ? 'Comece a assistir um filme ou série para vê-lo aqui.'
              : 'Tente mudar o filtro ou a busca.'}
          </Text>
        </View>
      )}

      {/* Grid 2 colunas */}
      <FlatList
        data={filtered}
        numColumns={2}
        removeClippedSubviews
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={7}
        updateCellsBatchingPeriod={40}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={styles.columnWrap}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} onPress={() => openItem(item)}>
            <View style={styles.imageWrap}>
              {hideImages ? (
                <View style={[styles.thumbnail, styles.thumbnailHidden]}>
                  <MaterialIcons name="image-not-supported" size={24} color={StreamingTheme.colors.textMuted} />
                </View>
              ) : (
                <Image source={{ uri: item.image }} style={styles.thumbnail} cachePolicy="disk" />
              )}
              {/* Barra de progresso */}
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${item.progress}%` }]} />
              </View>
              {/* Badge de progresso */}
              <View style={styles.progressBadge}>
                <Text style={styles.progressBadgeText}>{item.progress}%</Text>
              </View>
              {/* Badge de tipo */}
              <View style={[styles.typeBadge, item.type === 'series' && styles.typeBadgeSeries]}>
                <Text style={styles.typeBadgeText}>
                  {item.type === 'movie' ? 'FILME' : 'SÉRIE'}
                </Text>
              </View>
            </View>

            <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
            <Text style={styles.cardSubtitle} numberOfLines={1}>{item.subtitle}</Text>

            {/* Botão continuar */}
            <View style={styles.resumeBtn}>
              <MaterialIcons name="play-arrow" size={14} color="#fff" />
              <Text style={styles.resumeBtnText}>Continuar</Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
  },
  backBtn: {
    width: 42,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: { alignItems: 'center' },
  kicker: {
    color: StreamingTheme.colors.accentAlt,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '900',
  },

  searchWrap: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    borderRadius: 14,
    backgroundColor: StreamingTheme.colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
  },
  searchInput: { flex: 1, height: 46, color: StreamingTheme.colors.textPrimary },

  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 16,
  },
  filterChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  filterChipActive: {
    backgroundColor: 'rgba(255,59,48,0.24)',
    borderColor: 'rgba(255,59,48,0.5)',
  },
  filterText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '700',
  },
  filterTextActive: { color: StreamingTheme.colors.textPrimary },
  countText: {
    marginLeft: 'auto',
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
  },

  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
  },
  emptyDesc: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },

  grid: { paddingHorizontal: 12, paddingBottom: 120 },
  columnWrap: { gap: 12, marginBottom: 16 },
  card: { width: CARD_W },

  imageWrap: { position: 'relative', marginBottom: 8 },
  thumbnail: {
    width: '100%',
    aspectRatio: 1.5,
    borderRadius: 12,
    backgroundColor: StreamingTheme.colors.surface,
  },
  thumbnailHidden: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressTrack: {
    position: 'absolute',
    left: 6,
    right: 6,
    bottom: 6,
    height: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.55)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: StreamingTheme.colors.accent,
  },
  progressBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
    backgroundColor: 'rgba(30,144,255,0.9)',
  },
  progressBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '900',
  },
  typeBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    borderRadius: 6,
    backgroundColor: 'rgba(255,59,48,0.85)',
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  typeBadgeSeries: { backgroundColor: 'rgba(93,169,255,0.85)' },
  typeBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
  },

  cardTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
    marginBottom: 2,
  },
  cardSubtitle: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
    marginBottom: 8,
  },

  resumeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    backgroundColor: StreamingTheme.colors.accent,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  resumeBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
});
