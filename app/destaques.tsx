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
import { buildTmdbMetadataForCatalog, rankCatalogByTmdb, TmdbMeta } from '@/services/tmdb';

const { width: SCREEN_W } = Dimensions.get('window');
const CARD_W = (SCREEN_W - 48) / 3;

type Item = {
  id: string;
  type: 'movie' | 'series';
  title: string;
  data: StreamItem;
  meta?: TmdbMeta;
};

export default function DestaquesScreen() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'movie' | 'series'>('all');
  const [access, setAccess] = useState<AccessSnapshot | null>(null);

  useEffect(() => {
    const bootstrap = async () => {
      const [{ vod, series }, snapshot] = await Promise.all([
        loadCatalogData(),
        loadAccessSnapshot(),
      ]);
      setAccess(snapshot);

      const [movieMeta, seriesMeta] = await Promise.all([
        buildTmdbMetadataForCatalog(
          vod as StreamItem[],
          'movie',
          (item) => toText(item.stream_id),
          (item) => sanitizeLabelText(item.title || item.name, '')
        ),
        buildTmdbMetadataForCatalog(
          series as StreamItem[],
          'tv',
          (item) => toText(item.series_id),
          (item) => sanitizeLabelText(item.title || item.name, '')
        ),
      ]);

      const topMovies = rankCatalogByTmdb(
        vod as StreamItem[],
        movieMeta,
        (item) => toText(item.stream_id),
        'popular',
        80
      ).map((item) => ({
        id: `movie-${toText(item.stream_id)}`,
        type: 'movie' as const,
        title: sanitizeLabelText(item.title || item.name, 'Filme'),
        data: item,
        meta: movieMeta[toText(item.stream_id)],
      }));

      const topSeries = rankCatalogByTmdb(
        series as StreamItem[],
        seriesMeta,
        (item) => toText(item.series_id),
        'popular',
        80
      ).map((item) => ({
        id: `series-${toText(item.series_id)}`,
        type: 'series' as const,
        title: sanitizeLabelText(item.title || item.name, 'Serie'),
        data: item,
        meta: seriesMeta[toText(item.series_id)],
      }));

      // intercalar filmes e séries
      const mixed: Item[] = [];
      const maxLen = Math.max(topMovies.length, topSeries.length);
      for (let i = 0; i < maxLen; i++) {
        if (topMovies[i]) mixed.push(topMovies[i]);
        if (topSeries[i]) mixed.push(topSeries[i]);
      }

      setItems(mixed);
      setIsLoading(false);
    };
    bootstrap();
  }, []);

  const hideImages = !!access && shouldHideContentImages(access);

  const filtered = useMemo(() => {
    let result = items;

    if (activeFilter !== 'all') {
      result = result.filter((item) => item.type === activeFilter);
    }

    if (search.trim().length >= 2) {
      result = result.filter((item) =>
        item.title.toLowerCase().includes(search.trim().toLowerCase())
      );
    }

    if (!access) return result;
    return filterBlockedContent(access, result, (item) => item.title);
  }, [items, search, activeFilter, access]);

  const openItem = (item: Item) => {
    if (item.type === 'movie') {
      const id = toText(item.data.stream_id);
      if (id) router.navigate(`/filme-detalhe?streamId=${encodeURIComponent(id)}` as any);
    } else {
      const id = toText(item.data.series_id);
      if (!id) return;
      router.navigate({
        pathname: '/serie-detalhe',
        params: {
          seriesId: id,
          title: item.title,
          cover: toText(item.data.stream_icon || item.data.cover),
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
      <PageLoader visible={isLoading} label="Carregando destaques" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.kicker}>Populares</Text>
          <Text style={styles.title}>Em Destaque</Text>
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
          placeholder="Buscar nos destaques"
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
        <Text style={styles.countText}>{filtered.length} itens</Text>
      </View>

      {/* Grid */}
      <FlatList
        data={filtered}
        numColumns={3}
        removeClippedSubviews
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        updateCellsBatchingPeriod={40}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={styles.columnWrap}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} onPress={() => openItem(item)}>
            {hideImages ? (
              <View style={[styles.poster, styles.posterHidden]}>
                <MaterialIcons name="image-not-supported" size={22} color={StreamingTheme.colors.textMuted} />
              </View>
            ) : (
              <Image
                source={{ uri: item.meta?.posterUrl || toText(item.data.stream_icon || item.data.cover) }}
                style={styles.poster}
                cachePolicy="disk"
              />
            )}
            <View style={[styles.typeBadge, item.type === 'series' && styles.typeBadgeSeries]}>
              <Text style={styles.typeBadgeText}>
                {item.type === 'movie' ? 'FILME' : 'SÉRIE'}
              </Text>
            </View>
            <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
            {item.meta?.rating ? (
              <Text style={styles.cardMeta}>★ {item.meta.rating}{item.meta.releaseYear ? ` • ${item.meta.releaseYear}` : ''}</Text>
            ) : null}
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
    fontSize: 20,
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
    marginBottom: 14,
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

  grid: { paddingHorizontal: 12, paddingBottom: 120 },
  columnWrap: { gap: 10, marginBottom: 14 },
  card: { width: CARD_W },
  poster: {
    width: '100%',
    aspectRatio: 0.66,
    borderRadius: 12,
    backgroundColor: StreamingTheme.colors.surface,
    marginBottom: 6,
  },
  posterHidden: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  typeBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
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
    fontSize: 12,
    fontWeight: '700',
  },
  cardMeta: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
});
