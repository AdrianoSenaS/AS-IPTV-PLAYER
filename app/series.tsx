import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackdrop } from '@/components/app-backdrop';
import { PageLoader } from '@/components/page-loader';
import { ParentalUnlockModal } from '@/components/parental-unlock-modal';
import { RecommendationChip } from '@/components/recommendation-chip';
import { StreamingTheme } from '@/constants/streaming-theme';
import { usePlanGate } from '@/hooks/use-plan-gate';
import {
  AccessSnapshot,
  filterBlockedContent,
  loadAccessSnapshot,
  shouldHideContentImages,
  unlockParentalAccess,
} from '@/services/access-control';
import {
  queryCatalogCategories,
  queryCatalogCount,
  queryCatalogPage,
  sanitizeLabelText,
  StreamItem,
  toText,
} from '../services/catalog-data';
import { DownloadJob, subscribeDownloadJobs } from '@/services/downloads';
import { getSeriesSummary, loadSeriesProgressMap, SeriesProgressMap } from '@/services/series-progress';
import { buildUserTasteProfile, getRecommendationReasons, rankContentByTaste, UserTasteProfile } from '@/services/taste-recommender';
import { buildTmdbMetadataForCatalog, rankCatalogByTmdb, TmdbMeta } from '@/services/tmdb';

const PAGE_SIZE = 90;

export default function SeriesScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ categoryId?: string }>();
  const { hasFeature, loading: planLoading } = usePlanGate();
  const [isLoading, setIsLoading] = useState(true);
  const [items, setItems] = useState<StreamItem[]>([]);
  const [categories, setCategories] = useState<StreamItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [progressMap, setProgressMap] = useState<SeriesProgressMap>({});
  const [downloadJobs, setDownloadJobs] = useState<DownloadJob[]>([]);
  const [tmdbMap, setTmdbMap] = useState<Record<string, TmdbMeta>>({});
  const [rankingMode, setRankingMode] = useState<'default' | 'release' | 'popular' | 'rated'>('default');
  const [search, setSearch] = useState('');
  const [access, setAccess] = useState<AccessSnapshot | null>(null);
  const [tasteProfile, setTasteProfile] = useState<UserTasteProfile | null>(null);
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isPageLoading, setIsPageLoading] = useState(false);

  const downloadLocked = !planLoading && !hasFeature('downloads');

  useEffect(() => {
    setSelectedCategory(params.categoryId ? String(params.categoryId) : 'all');
  }, [params.categoryId]);

  const loadPage = useCallback(
    async (reset: boolean) => {
      if (isPageLoading) return;

      setIsPageLoading(true);
      try {
        const nextOffset = reset ? 0 : offset;
        const [count, page] = await Promise.all([
          queryCatalogCount({ kind: 'series', categoryId: selectedCategory, search }),
          queryCatalogPage({
            kind: 'series',
            categoryId: selectedCategory,
            search,
            offset: nextOffset,
            limit: PAGE_SIZE,
          }),
        ]);

        if (reset && count === 0) {
          setItems([]);
          setTmdbMap({});
          setTotalCount(0);
          setOffset(0);
          setHasMore(false);
          return;
        }

        if (reset) {
          setItems(page);
          setTmdbMap({});
          setOffset(page.length);
        } else {
          setItems((prev) => [...prev, ...page]);
          setOffset((prev) => prev + page.length);
        }

        setTotalCount(count);
        const loaded = (reset ? 0 : nextOffset) + page.length;
        setHasMore(loaded < count);

        if (page.length) {
          const pageTmdbMap = await buildTmdbMetadataForCatalog(
            page,
            'tv',
            (item) => toText(item.series_id),
            (item) => sanitizeLabelText(item.title || item.name, '')
          );
          setTmdbMap((prev) => ({ ...prev, ...pageTmdbMap }));
        }
      } finally {
        setIsPageLoading(false);
      }
    },
    [isPageLoading, offset, search, selectedCategory]
  );

  useEffect(() => {
    const bootstrap = async () => {
      const [seriesCategories, seriesMap, snapshot] = await Promise.all([
        queryCatalogCategories('series'),
        loadSeriesProgressMap(),
        loadAccessSnapshot(),
      ]);

      setCategories(seriesCategories);
      setProgressMap(seriesMap);
      setAccess(snapshot);
      setIsLoading(false);
    };

    bootstrap();
  }, []);

  useEffect(() => {
    if (isLoading) return;
    void loadPage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, selectedCategory, search]);

  useFocusEffect(
    React.useCallback(() => {
      let mounted = true;
      const refreshProgress = async () => {
        const [map, snapshot] = await Promise.all([loadSeriesProgressMap(), loadAccessSnapshot()]);
        if (mounted) {
          setProgressMap(map);
          setAccess(snapshot);
          setTasteProfile(
            await buildUserTasteProfile({
              settings: snapshot.settings,
              catalog: { vod: [], series: items, liveStreams: [] },
              seriesProgressMap: map,
            })
          );
        }
      };

      refreshProgress();

      return () => {
        mounted = false;
      };
    }, [])
  );

  useEffect(() => {
    const unsubscribe = subscribeDownloadJobs(setDownloadJobs);
    return unsubscribe;
  }, []);

  const quickDownloadSeries = async (item: StreamItem) => {
    try {
      if (downloadLocked) {
        router.push({ pathname: '/assinar', params: { feature: 'downloads' } });
        return;
      }

      const seriesId = toText(item.series_id);
      router.push({
        pathname: '/serie-detalhe',
        params: {
          seriesId,
          title: sanitizeLabelText(item.title || item.name, 'Sem titulo'),
          cover: toText(item.stream_icon || item.cover),
        },
      });
      Alert.alert('Abrir detalhe', 'Para baixar a serie completa, o app vai abrir a tela da serie com o botao de download completo.');
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel abrir a serie.'));
    }
  };

  const filtered = useMemo(() => {
    const protectedItems = !access
      ? items
      : filterBlockedContent(
      access,
      items,
      (serie) =>
        `${toText(serie.title || serie.name)} ${toText(serie.category_name)} ${toText(serie.genre)} ${toText(serie.plot)}`
    );

    if (rankingMode === 'default') {
      if (!tasteProfile) return protectedItems;
      return rankContentByTaste(protectedItems, 'series', tasteProfile);
    }

    return rankCatalogByTmdb(
      protectedItems,
      tmdbMap,
      (serie) => toText(serie.series_id),
      rankingMode,
      protectedItems.length
    );
  }, [items, access, rankingMode, tmdbMap, tasteProfile]);

  const hideImages = !!access && shouldHideContentImages(access);

  const handleUnlock = async (pin: string) => {
    const ok = await unlockParentalAccess(pin);
    if (!ok) {
      Alert.alert('PIN incorreto', 'Nao foi possivel desbloquear o conteudo.');
      return;
    }

    setShowUnlockModal(false);
    setAccess(await loadAccessSnapshot());
  };

  const getReasonLabel = (item: StreamItem) => {
    if (!tasteProfile) return '';
    return getRecommendationReasons(item, 'series', tasteProfile)[0] || '';
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isLoading} label="Carregando series" />

      <View style={styles.header}>
        <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
        </TouchableOpacity>
        <View>
          <Text style={styles.kicker}>Catalogo completo</Text>
          <Text style={styles.title}>Todas as series</Text>
        </View>
        <TouchableOpacity style={styles.iconBtn} onPress={() => router.navigate({ pathname: '/categorias', params: { tipo: 'series' } })}>
          <MaterialIcons name="category" size={20} color={StreamingTheme.colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
        <MaterialIcons name="search" size={18} color={StreamingTheme.colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Buscar serie"
          placeholderTextColor={StreamingTheme.colors.textMuted}
        />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
        <TouchableOpacity
          style={[styles.chip, selectedCategory === 'all' && styles.chipActive]}
          onPress={() => setSelectedCategory('all')}
        >
          <Text style={[styles.chipText, selectedCategory === 'all' && styles.chipTextActive]}>Todas</Text>
        </TouchableOpacity>
        {categories.map((category, index) => {
          const categoryId = toText(category.category_id, `series-cat-${index}`);
          const active = selectedCategory === categoryId;
          return (
            <TouchableOpacity
              key={categoryId}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => setSelectedCategory(categoryId)}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={2}>
                {sanitizeLabelText(category.category_name, 'Categoria')}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <Text style={styles.count}>{filtered.length} exibidas • {totalCount} no total</Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rankRow}>
        {[
          { id: 'default', label: 'Relevantes' },
          { id: 'release', label: 'Lancamentos' },
          { id: 'popular', label: 'Mais assistidas' },
          { id: 'rated', label: 'Mais votadas' },
        ].map((item) => {
          const active = rankingMode === (item.id as any);
          return (
            <TouchableOpacity
              key={item.id}
              style={[styles.rankChip, active && styles.rankChipActive]}
              onPress={() => setRankingMode(item.id as any)}
            >
              <Text style={[styles.rankChipText, active && styles.rankChipTextActive]}>{item.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <FlatList
        data={filtered}
        numColumns={3}
        removeClippedSubviews
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        updateCellsBatchingPeriod={40}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item, index) => String(item.series_id ?? `series-${index}`)}
        contentContainerStyle={styles.listContent}
        columnWrapperStyle={styles.columnWrap}
        onEndReachedThreshold={0.45}
        onEndReached={() => {
          if (!isPageLoading && hasMore) {
            void loadPage(false);
          }
        }}
        ListFooterComponent={
          isPageLoading ? (
            <View style={styles.pageLoaderWrap}>
              <ActivityIndicator color={StreamingTheme.colors.accentAlt} />
              <Text style={styles.pageLoaderText}>Carregando mais series...</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const seriesId = toText(item.series_id);
          const tmdb = tmdbMap[seriesId];
          const summary = getSeriesSummary(progressMap, seriesId);
          const seriesJobs = downloadJobs.filter((job) => job.seriesId === seriesId);
          const avgDownload = seriesJobs.length
            ? Math.round(seriesJobs.reduce((sum, job) => sum + job.progressPercent, 0) / seriesJobs.length)
            : 0;
          return (
            <TouchableOpacity
              style={styles.card}
              onPress={() =>
                router.navigate({
                  pathname: '/serie-detalhe',
                  params: {
                    seriesId,
                    title: sanitizeLabelText(item.title || item.name, 'Sem titulo'),
                    cover: toText(item.stream_icon || item.cover),
                  },
                })
              }
            >
              <View>
                {hideImages ? (
                  <View style={[styles.poster, styles.posterHidden]}>
                    <MaterialIcons name="image-not-supported" size={24} color={StreamingTheme.colors.textMuted} />
                  </View>
                ) : (
                  <Image source={{ uri: tmdb?.posterUrl || toText(item.stream_icon || item.cover) }} style={styles.poster} cachePolicy="disk" />
                )}
                {summary.averageProgress > 0 && (
                  <View style={styles.thumbProgressTrack}>
                    <View style={[styles.thumbProgressFill, { width: `${summary.averageProgress}%` }]} />
                  </View>
                )}
                {summary.watchedCount > 0 && (
                  <View style={styles.watchedBadge}>
                    <MaterialIcons name="check" size={11} color={StreamingTheme.colors.textPrimary} />
                    <Text style={styles.watchedBadgeText}>{summary.watchedCount}</Text>
                  </View>
                )}
                {summary.averageProgress > 0 && (
                  <View style={styles.watchingBadge}>
                    <Text style={styles.watchingBadgeText}>Continuar assistindo</Text>
                  </View>
                )}
                {seriesJobs.length > 0 && (
                  <View style={styles.downloadBadge}>
                    <Text style={styles.downloadBadgeText}>{avgDownload}%</Text>
                  </View>
                )}
              </View>
              <Text style={styles.cardTitle} numberOfLines={1}>{sanitizeLabelText(item.title || item.name, 'Sem titulo')}</Text>
              <Text style={styles.cardMeta} numberOfLines={1}>
                {tmdb?.rating ? `★ ${tmdb.rating}` : 'Serie'}
                {tmdb?.releaseYear ? ` • ${tmdb.releaseYear}` : ''}
              </Text>
              {!!tasteProfile && (
                <RecommendationChip reason={getReasonLabel(item)} numberOfLines={2} style={styles.reasonChip} />
              )}
              {summary.averageProgress > 0 && (
                <Text style={styles.cardMeta} numberOfLines={1}>
                  Continuar: S{summary.continueSeason} E{summary.continueEpisode}
                </Text>
              )}
              <TouchableOpacity
                style={[styles.downloadQuickBtn, downloadLocked && styles.downloadQuickBtnLocked]}
                onPress={() => quickDownloadSeries(item)}>
                <MaterialIcons
                  name={downloadLocked ? 'workspace-premium' : 'download'}
                  size={14}
                  color={StreamingTheme.colors.textPrimary}
                />
                <Text style={styles.downloadQuickText}>
                  {downloadLocked ? 'Download Premium' : seriesJobs.length > 0 ? 'Baixando' : 'Baixar'}
                </Text>
              </TouchableOpacity>
            </TouchableOpacity>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kicker: {
    color: StreamingTheme.colors.accentAlt,
    fontWeight: '700',
    letterSpacing: 1,
    fontSize: 12,
    textAlign: 'center',
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
  },
  searchWrap: {
    marginTop: 14,
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    borderRadius: 14,
    backgroundColor: StreamingTheme.colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
  },
  searchInput: { flex: 1, height: 48, color: StreamingTheme.colors.textPrimary },
  chipsRow: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
    gap: 8,
    alignItems: 'center',
  },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    minHeight: 42,
    minWidth: 96,
    maxWidth: 220,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: 'rgba(255,59,48,0.25)',
    borderColor: 'rgba(255,59,48,0.45)',
  },
  chipText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 14,
    fontWeight: '700',
    includeFontPadding: false,
    textAlign: 'center',
    lineHeight: 18,
  },
  chipTextActive: {
    color: StreamingTheme.colors.textPrimary,
  },
  count: {
    paddingHorizontal: 16,
    marginTop: 4,
    marginBottom: 4,
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
  },
  rankRow: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 16,
    gap: 8,
    alignItems: 'center',
  },
  rankChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    minHeight: 42,
    minWidth: 108,
    paddingHorizontal: 18,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rankChipActive: {
    borderColor: 'rgba(255,59,48,0.45)',
    backgroundColor: 'rgba(255,59,48,0.24)',
  },
  rankChipText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 18,
  },
  rankChipTextActive: {
    color: StreamingTheme.colors.textPrimary,
  },
  lockBanner: {
    marginTop: 8,
    marginHorizontal: 16,
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
  listContent: { padding: 16, paddingBottom: 120, gap: 12 },
  columnWrap: { gap: 10 },
  card: { flex: 1 },
  poster: {
    width: '100%',
    aspectRatio: 0.65,
    borderRadius: 12,
    backgroundColor: StreamingTheme.colors.surface,
    marginBottom: 6,
  },
  posterHidden: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbProgressTrack: {
    position: 'absolute',
    left: 4,
    right: 4,
    bottom: 10,
    height: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.5)',
    overflow: 'hidden',
  },
  thumbProgressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: StreamingTheme.colors.accent,
  },
  watchedBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: 'rgba(44,208,127,0.92)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  watchedBadgeText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 10,
    fontWeight: '900',
  },
  watchingBadge: {
    position: 'absolute',
    left: 8,
    bottom: 18,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: 'rgba(255,59,48,0.9)',
  },
  watchingBadgeText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 10,
    fontWeight: '900',
  },
  downloadBadge: {
    position: 'absolute',
    left: 8,
    top: 8,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: 'rgba(46,204,113,0.92)',
  },
  downloadBadgeText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 10,
    fontWeight: '900',
  },
  cardTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  cardMeta: {
    marginTop: 2,
    color: StreamingTheme.colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
  },
  reasonChip: {
    marginTop: 4,
  },
  downloadQuickBtn: {
    marginTop: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  downloadQuickBtnLocked: {
    borderColor: 'rgba(255,159,67,0.55)',
    backgroundColor: 'rgba(255,159,67,0.2)',
  },
  downloadQuickText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  pageLoaderWrap: {
    width: '100%',
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  pageLoaderText: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
});
