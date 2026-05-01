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
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackdrop } from '@/components/app-backdrop';
import { PageLoader } from '@/components/page-loader';
import { ParentalUnlockModal } from '@/components/parental-unlock-modal';
import { RecommendationChip } from '@/components/recommendation-chip';
import { StreamingTheme } from '@/constants/streaming-theme';
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
} from '@/services/catalog-data';
import { buildLiveUrl } from '@/services/stream-url';
import { buildUserTasteProfile, getRecommendationReasons, rankContentByTaste, UserTasteProfile } from '@/services/taste-recommender';

const PAGE_SIZE = 120;

export default function AoVivoScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ categoryId?: string }>();
  const [isLoading, setIsLoading] = useState(true);
  const [items, setItems] = useState<StreamItem[]>([]);
  const [categories, setCategories] = useState<StreamItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [access, setAccess] = useState<AccessSnapshot | null>(null);
  const [tasteProfile, setTasteProfile] = useState<UserTasteProfile | null>(null);
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isPageLoading, setIsPageLoading] = useState(false);

  const openLivePlayer = async (item: StreamItem) => {
    const url = await buildLiveUrl(item);
    if (!url) {
      Alert.alert('Erro', 'Nao foi possivel obter a URL do canal.');
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
  };

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
          queryCatalogCount({ kind: 'live', categoryId: selectedCategory, search }),
          queryCatalogPage({
            kind: 'live',
            categoryId: selectedCategory,
            search,
            offset: nextOffset,
            limit: PAGE_SIZE,
          }),
        ]);

        if (reset && count === 0) {
          setItems([]);
          setTotalCount(0);
          setOffset(0);
          setHasMore(false);
          return;
        }

        if (reset) {
          setItems(page);
          setOffset(page.length);
        } else {
          setItems((prev) => [...prev, ...page]);
          setOffset((prev) => prev + page.length);
        }

        setTotalCount(count);
        const loaded = (reset ? 0 : nextOffset) + page.length;
        setHasMore(loaded < count);
      } finally {
        setIsPageLoading(false);
      }
    },
    [isPageLoading, offset, search, selectedCategory]
  );

  useEffect(() => {
    const bootstrap = async () => {
      const [liveCategories, snapshot] = await Promise.all([
        queryCatalogCategories('live'),
        loadAccessSnapshot(),
      ]);

      setCategories(liveCategories);
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

  const filtered = useMemo(() => {
    const protectedItems = !access
      ? items
      : filterBlockedContent(
      access,
      items,
      (channel) => `${toText(channel.name || channel.title)} ${toText(channel.category_name)}`
    );

    if (!tasteProfile) return protectedItems;
    return rankContentByTaste(protectedItems, 'live', tasteProfile);
  }, [items, access, tasteProfile]);

  useEffect(() => {
    const refreshTaste = async () => {
      if (!access) return;
      setTasteProfile(
        await buildUserTasteProfile({
          settings: access.settings,
          catalog: { vod: [], series: [], liveStreams: items },
        })
      );
    };

    void refreshTaste();
  }, [access, items]);

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
    return getRecommendationReasons(item, 'live', tasteProfile)[0] || '';
  };


  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isLoading} label="Carregando TV ao vivo" />

      <View style={styles.header}>
        <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
        </TouchableOpacity>
        <View>
          <Text style={styles.kicker}>Programacao</Text>
          <Text style={styles.title}>TV ao vivo</Text>
        </View>
        <TouchableOpacity style={styles.iconBtn} onPress={() => router.navigate({ pathname: '/categorias', params: { tipo: 'ao-vivo' } })}>
          <MaterialIcons name="category" size={20} color={StreamingTheme.colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
        <MaterialIcons name="search" size={18} color={StreamingTheme.colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Buscar canal"
          placeholderTextColor={StreamingTheme.colors.textMuted}
        />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
        <TouchableOpacity
          style={[styles.chip, selectedCategory === 'all' && styles.chipActive]}
          onPress={() => setSelectedCategory('all')}
        >
          <Text style={[styles.chipText, selectedCategory === 'all' && styles.chipTextActive]}>Todos</Text>
        </TouchableOpacity>
        {categories.map((category, index) => {
          const categoryId = toText(category.category_id, `tv-cat-${index}`);
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

      <Text style={styles.count}>{filtered.length} exibidos • {totalCount} no total</Text>

      <FlatList
        data={filtered}
        removeClippedSubviews
        initialNumToRender={14}
        maxToRenderPerBatch={14}
        windowSize={8}
        updateCellsBatchingPeriod={40}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item, index) => String(item.stream_id ?? `live-${index}`)}
        contentContainerStyle={styles.listContent}
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
              <Text style={styles.pageLoaderText}>Carregando mais canais...</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} onPress={() => openLivePlayer(item)}>
            <View style={styles.logoRow}>
              {hideImages ? (
                <View style={styles.logoHidden}>
                  <MaterialIcons name="image-not-supported" size={22} color={StreamingTheme.colors.textMuted} />
                </View>
              ) : (
                <Image source={{ uri: toText(item.stream_icon || item.cover) }} style={styles.logo} cachePolicy="disk" />
              )}
            </View>
            <View style={styles.cardTop}>
              <Text style={styles.cardTitle}>{sanitizeLabelText(item.name || item.title, 'Canal')}</Text>
              <View style={styles.liveTag}>
                <View style={styles.liveDot} />
                <Text style={styles.liveText}>AO VIVO</Text>
              </View>
            </View>
            {!!tasteProfile && (
              <RecommendationChip reason={getReasonLabel(item)} numberOfLines={2} style={styles.reasonChip} />
            )}
            <Text style={styles.cardSub}>{sanitizeLabelText(item.category_name, 'Programacao ao vivo')}</Text>
          </TouchableOpacity>
        )}
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
    paddingBottom: 16,
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
    marginBottom: 12,
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
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
  listContent: { padding: 16, paddingBottom: 120, gap: 10 },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    padding: 14,
  },
  logoRow: {
    height: 58,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  logo: {
    width: '70%',
    height: '72%',
  },
  logoHidden: {
    width: '70%',
    height: '72%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  cardTitle: {
    flex: 1,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  reasonChip: {
    marginTop: 6,
  },
  cardSub: {
    marginTop: 8,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
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
  liveTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,59,48,0.2)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: StreamingTheme.colors.accent,
  },
  liveText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 10,
    fontWeight: '800',
  },
});
