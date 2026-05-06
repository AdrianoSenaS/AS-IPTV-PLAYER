import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  Animated,
} from 'react-native';

import { AppBackdrop } from '@/components/app-backdrop';
import { PageLoader } from '@/components/page-loader';
import { StreamingTheme } from '@/constants/streaming-theme';
import {
  CatalogKind,
  queryCatalogCategories,
  queryCatalogItemsByIds,
  queryCatalogPage,
  StreamItem,
  toText,
} from '@/services/catalog-data';
import { getDeviceUiProfile } from '@/services/device-profile';
import { loadMovieProgressMap } from '@/services/movie-progress';
import { loadSeriesProgressMap } from '@/services/series-progress';
import { buildLiveUrl, buildMovieUrl } from '@/services/stream-url';
import { pullWatchProgress } from '@/services/watch-sync';

type ScreenKind = CatalogKind | 'continue';

type TvItem = {
  id: string;
  kind: CatalogKind;
  title: string;
  subtitle: string;
  image: string;
  payload: StreamItem;
  updatedAt: string;
};

// Otimização: reduzir PAGE_SIZE para evitar sobrecarga em dispositivos fracos
const PAGE_SIZE = 36;

function normalizeKind(input: string): ScreenKind {
  if (input === 'live' || input === 'vod' || input === 'series' || input === 'continue') {
    return input;
  }
  return 'live';
}

function getItemId(item: StreamItem, kind: CatalogKind) {
  return kind === 'series' ? toText(item.series_id) : toText(item.stream_id);
}

function toTvItem(item: StreamItem, kind: CatalogKind, updatedAt = ''): TvItem {
  return {
    id: getItemId(item, kind),
    kind,
    title: toText(item.title || item.name, 'Sem titulo'),
    subtitle: toText(item.category_name || item.genre, kind === 'live' ? 'Canal' : 'Catalogo'),
    image: toText(item.cover || item.stream_icon),
    payload: item,
    updatedAt,
  };
}

const LIST_H_PAD = 16;
const CARD_MARGIN = 8;

function getGridLayout(width: number) {
  const profile = getDeviceUiProfile();

  // Ajuste para TVs pequenas e Chromebooks
  let columns: number;
  let cardAspect = 0.72;
  let cardMinWidth = 110;
  let cardMaxWidth = 220;

  if (width >= 3200) columns = 9;
  else if (width >= 2400) columns = 8;
  else if (width >= 1800) columns = 6;
  else if (width >= 1200) columns = 5;
  else if (profile === 'tablet' || width >= 900) columns = 4;
  else columns = 3;

  // Para telas pequenas, diminui o tamanho dos cards
  if (width <= 1280) {
    cardAspect = 0.68;
    cardMinWidth = 90;
    cardMaxWidth = 150;
  }

  let cardWidth = Math.floor(
    (width - LIST_H_PAD * 2 - columns * CARD_MARGIN * 2) / columns
  );
  cardWidth = Math.max(cardMinWidth, Math.min(cardWidth, cardMaxWidth));

  return { columns, cardWidth, cardAspect };
}

export default function TvListScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ kind?: string; title?: string; categoryId?: string }>();
  const { width } = useWindowDimensions();
  const screenKind = normalizeKind(String(params.kind || 'live'));
  const title = String(params.title || 'Catalogo');
  const initialCategoryId = String(params.categoryId || 'all');

  const [items, setItems] = useState<TvItem[]>([]);
  const [categories, setCategories] = useState<StreamItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState(initialCategoryId);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);

  const backBtnRef = React.useRef(null);
  const allCategoryRef = React.useRef(null);
  const categoryRefs = React.useRef<any[]>([]);

  const layout = useMemo(() => getGridLayout(width), [width]);
  const hasCategories = screenKind !== 'continue';

  // Ref para scroll automático
  const scrollRef = React.useRef<ScrollView>(null);



  const goToDetails = useCallback(
    (entry: TvItem) => {
      if (entry.kind === 'series') {
        router.push({
          pathname: '/tv/detalhe' as any,
          params: { kind: entry.kind, id: entry.id, title: entry.title, cover: entry.image },
        });
        return;
      }
      // live e vod: abre player direto
      (async () => {
        try {
          const url =
            entry.kind === 'live'
              ? await buildLiveUrl(entry.payload)
              : await buildMovieUrl(entry.payload);
          if (!url) {
            router.push({
              pathname: '/tv/detalhe' as any,
              params: { kind: entry.kind, id: entry.id, title: entry.title, cover: entry.image },
            });
            return;
          }
          let startPositionMs = 0;
          if (entry.kind === 'vod') {
            const progressMap = await loadMovieProgressMap();
            startPositionMs = progressMap[entry.id]?.positionMs || 0;
          }
          router.push({
            pathname: '/tv/player' as any,
            params: {
              mode: entry.kind,
              title: entry.title,
              url,
              contentId: entry.id,
              posterUrl: entry.image,
              startPositionMs: String(startPositionMs),
            },
          });
        } catch {
          router.push({
            pathname: '/tv/detalhe' as any,
            params: { kind: entry.kind, id: entry.id, title: entry.title, cover: entry.image },
          });
        }
      })();
    },
    [router]
  );

  const loadContinueList = useCallback(async () => {
    const [movieMap, seriesMap, remoteItems] = await Promise.all([
      loadMovieProgressMap(),
      loadSeriesProgressMap(),
      pullWatchProgress(),
    ]);

    // Mescla progresso remoto no mapa local (remoto prevalece se mais recente)
    for (const remote of remoteItems) {
      if (remote.kind === 'vod') {
        const local = movieMap[remote.id];
        if (!local || remote.updatedAt > local.updatedAt) {
          const pct = remote.durationMs > 0
            ? Math.round((remote.positionMs / remote.durationMs) * 100)
            : 0;
          movieMap[remote.id] = {
            positionMs: remote.positionMs,
            durationMs: remote.durationMs,
            progressPercent: pct,
            updatedAt: remote.updatedAt,
          };
        }
      }
    }

    const movieIds = Object.keys(movieMap)
      .map((id) => id.trim())
      .filter(Boolean);

    const seriesIds = Object.keys(seriesMap)
      .map((id) => id.trim())
      .filter(Boolean);

    const [movieById, seriesById] = await Promise.all([
      queryCatalogItemsByIds('vod', movieIds),
      queryCatalogItemsByIds('series', seriesIds),
    ]);

    const merged: TvItem[] = [];

    for (const id of movieIds) {
      const item = movieById[id];
      if (!item) continue;
      merged.push(toTvItem(item, 'vod', movieMap[id]?.updatedAt || ''));
    }

    for (const id of seriesIds) {
      const item = seriesById[id];
      if (!item) continue;
      const updatedAt = seriesMap[id]?.episodes
        ? Object.values(seriesMap[id].episodes)
            .map((entry) => entry.updatedAt)
            .sort((a, b) => (a > b ? -1 : 1))[0] || ''
        : '';
      merged.push(toTvItem(item, 'series', updatedAt));
    }

    merged.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
    setItems(merged);
    setHasMore(false);
    setOffset(0);
  }, []);

  const loadFirstPage = useCallback(async () => {
    let timeoutId: any;
    try {
      console.log('[TvListScreen] Iniciando loadFirstPage');
      setIsLoading(true);
      setIsLoadingMore(false);

      // Timeout de segurança para evitar travamento infinito
      timeoutId = setTimeout(() => {
        setIsLoading(false);
        setIsLoadingMore(false);
        Alert.alert('Tempo excedido', 'O carregamento demorou demais. Tente novamente.');
      }, 20000); // 20 segundos

      if (screenKind === 'continue') {
        try {
          await loadContinueList();
        } catch (err) {
          console.error('[TvListScreen] Erro em loadContinueList:', err);
          Alert.alert('Erro ao carregar continuar assistindo', String(err));
        }
        setIsLoading(false);
        clearTimeout(timeoutId);
        console.log('[TvListScreen] Lista de continuar assistindo carregada');
        return;
      }

      const kind = screenKind as CatalogKind;
      // Sempre carrega todas as categorias
      let cats: StreamItem[] = [];
      try {
        cats = await queryCatalogCategories(kind);
        setCategories(Array.isArray(cats) ? cats : []);
        console.log('[TvListScreen] Categorias carregadas:', cats.length);
      } catch (err) {
        setCategories([]);
        console.error('[TvListScreen] Erro ao carregar categorias:', err);
        Alert.alert('Erro ao carregar categorias', String(err));
      }

      // Se categoria for 'all', carrega todos os conteúdos do tipo
      let page: StreamItem[] = [];
      try {
        if (selectedCategory === 'all') {
          page = await queryCatalogPage({ kind, categoryId: undefined, offset: 0, limit: PAGE_SIZE });
        } else {
          page = await queryCatalogPage({ kind, categoryId: selectedCategory, offset: 0, limit: PAGE_SIZE });
        }
        if (!Array.isArray(page)) page = [];
        console.log('[TvListScreen] Itens carregados:', page.length);
      } catch (err) {
        page = [];
        console.error('[TvListScreen] Erro ao carregar itens:', err);
        Alert.alert('Erro ao carregar itens', String(err));
      }

      const parsed = Array.isArray(page) ? page.slice(0, PAGE_SIZE).map((item) => toTvItem(item, kind)) : [];
      setItems(parsed);
      setOffset(parsed.length);
      setHasMore(parsed.length >= PAGE_SIZE);
      setIsLoading(false);
      clearTimeout(timeoutId);
      console.log('[TvListScreen] Página carregada com sucesso');
    } catch (err) {
      setIsLoading(false);
      setIsLoadingMore(false);
      clearTimeout(timeoutId);
      console.error('[TvListScreen] Erro ao carregar:', err);
      const msg = (typeof err === 'object' && err !== null && 'message' in err) ? (err as any).message : String(err);
      Alert.alert('Erro ao carregar catálogo', msg);
    }
  }, [loadContinueList, screenKind, selectedCategory]);

  const loadMore = useCallback(async () => {
    if (screenKind === 'continue' || !hasMore || isLoadingMore || isLoading) {
      return;
    }

    setIsLoadingMore(true);
    let page: StreamItem[] = [];
    try {
      const kind = screenKind as CatalogKind;
      page = await queryCatalogPage({
        kind,
        categoryId: selectedCategory,
        offset,
        limit: PAGE_SIZE,
      });
      if (!Array.isArray(page)) page = [];
    } catch (err) {
      page = [];
      console.error('[TvListScreen] Erro ao carregar mais itens:', err);
      Alert.alert('Erro ao carregar mais itens', String(err));
    }

    const parsed = Array.isArray(page) ? page.slice(0, PAGE_SIZE).map((item) => toTvItem(item, screenKind as CatalogKind)) : [];
    setItems((prev) => [...prev, ...parsed]);
    setOffset((prev) => prev + parsed.length);
    setHasMore(parsed.length >= PAGE_SIZE);
    setIsLoadingMore(false);
  }, [hasMore, isLoading, isLoadingMore, offset, screenKind, selectedCategory]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  // Remover refs e funções de scroll herdadas do FlatList
  useEffect(() => {
    setFocusedIndex(0);
    // Sempre rola para o topo ao trocar categoria/tela
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ y: 0, animated: false });
    }
  }, [selectedCategory, screenKind]);

  // Scroll automático para manter o card focado visível
  useEffect(() => {
    if (!scrollRef.current || isLoading || items.length === 0) return;
    // Só rola se o foco não estiver na primeira linha (evita reset ao navegar)
    const row = Math.floor(focusedIndex / layout.columns);
    if (row === 0) return;
    const cardHeight = layout.cardWidth * 1.4 + CARD_MARGIN * 2;
    const scrollY = row * cardHeight;
    scrollRef.current.scrollTo({ y: scrollY - cardHeight, animated: true });
  }, [focusedIndex, layout, isLoading, items.length]);

  const handleSelectCategory = useCallback((categoryId: string) => {
    setFocusedIndex(0);
    setSelectedCategory(categoryId);
  }, []);

  // Não precisa mais de renderItem nem refs

  return (
    <SafeAreaView style={styles.container}>
      <AppBackdrop blurIntensity={22} />

      <PageLoader visible={isLoading} label="Carregando catálogo..." />

      <View style={styles.header}>
        <Pressable
          ref={backBtnRef}
          style={({ pressed }) => [styles.backBtn, pressed && styles.backBtnFocused]}
          onPress={() => router.back()}
          hasTVPreferredFocus={focusedIndex === -2}
          onFocus={() => setFocusedIndex(-2)}
        >
          <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          <Text style={styles.backText}>Voltar</Text>
        </Pressable>
        <Text style={styles.title}>{title}</Text>
      </View>

      {screenKind !== 'continue' && categories.length > 0 ? (
        <ScrollView horizontal style={styles.categoryRow} contentContainerStyle={styles.categoryContent}>
          <Pressable
            ref={allCategoryRef}
            onPress={() => handleSelectCategory('all')}
            style={({ pressed }) => [
              styles.categoryChip,
              selectedCategory === 'all' && styles.categoryChipActive,
              pressed && styles.categoryChipFocused,
            ]}
            hasTVPreferredFocus={focusedIndex === -1}
            onFocus={() => setFocusedIndex(-1)}
          >
            <Text style={[styles.categoryText, selectedCategory === 'all' && styles.categoryTextActive]}>Todas</Text>
          </Pressable>
          {categories.map((category, index) => {
            const cid = toText(category.category_id);
            const selected = selectedCategory === cid;
            return (
              <Pressable
                key={cid}
                ref={(el) => {
                  categoryRefs.current[index] = el;
                }}
                onPress={() => handleSelectCategory(cid)}
                style={({ pressed }) => [
                  styles.categoryChip,
                  selected && styles.categoryChipActive,
                  pressed && styles.categoryChipFocused,
                ]}
                hasTVPreferredFocus={focusedIndex === index - 1000}
                onFocus={() => setFocusedIndex(index - 1000)}
              >
                <Text style={[styles.categoryText, selected && styles.categoryTextActive]} numberOfLines={1}>
                  {toText(category.category_name, 'Categoria')}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={[styles.listContent, { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'flex-start', minHeight: 0 }]}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
      >
        {items.length === 0 && !isLoading ? (
          <Text style={styles.emptyText}>Nenhum conteudo encontrado.</Text>
        ) : (
          items.map((item, index) => {
            const focused = focusedIndex === index;
            return (
              <Pressable
                key={item.id}
                onPress={() => goToDetails(item)}
                onFocus={() => setFocusedIndex(index)}
                style={({ pressed }) => [
                  styles.card,
                  { width: layout.cardWidth },
                  focused && styles.cardFocused,
                  pressed && styles.cardPressed,
                ]}
                hasTVPreferredFocus={index === 0 && focusedIndex === 0}
                // Navegação de foco: para cima vai para chip/categoria ou botão voltar
                {...{
                  nextFocusUp: (screenKind !== 'continue' && categories.length > 0)
                    ? (selectedCategory === 'all' ? allCategoryRef.current : (categoryRefs.current.find((el, i) => toText(categories[i].category_id) === selectedCategory) || allCategoryRef.current))
                    : backBtnRef.current
                }}
              >
                {item.image ? (
                  <Image source={{ uri: item.image }} style={[styles.poster, { aspectRatio: layout.cardAspect }]} contentFit="cover" />
                ) : (
                  <View style={[styles.poster, styles.posterFallback, { aspectRatio: layout.cardAspect }]}> 
                    <MaterialIcons name={item.kind === 'live' ? 'live-tv' : item.kind === 'series' ? 'smart-display' : 'movie'} size={Math.max(22, Math.floor(layout.cardWidth * 0.22))} color={StreamingTheme.colors.textMuted} />
                  </View>
                )}
                <View style={styles.meta}>
                  <Text numberOfLines={2} style={styles.cardTitle}>{item.title}</Text>
                  <Text numberOfLines={1} style={styles.cardSubtitle}>{item.subtitle}</Text>
                </View>
                {focused && <View style={[StyleSheet.absoluteFill, styles.cardFocused]} pointerEvents="none" />}
              </Pressable>
            );
          })
        )}
        {isLoadingMore && (
          <View style={{alignItems: 'center', width: '100%'}}>
            <View style={{width: layout.cardWidth, height: layout.cardWidth * 1.4, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.08)', marginBottom: 8}} />
            <Text style={styles.footerText}>Carregando mais...</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: StreamingTheme.colors.background,
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  backBtnFocused: {
    borderWidth: 4,
    borderColor: StreamingTheme.colors.accentAlt,
  },
  backText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 28,
    fontWeight: '900',
  },
  categoryRow: {
    height: 72,
  },
  categoryContent: {
    paddingHorizontal: 24,
    gap: 10,
    alignItems: 'center',
    paddingVertical: 0,
  },
  categoryChip: {
    height: 48,
    paddingHorizontal: 18,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryChipActive: {
    borderColor: StreamingTheme.colors.accentAlt,
    backgroundColor: 'rgba(255,143,58,0.2)',
  },
  categoryChipFocused: {
    borderWidth: 4,
    borderColor: StreamingTheme.colors.accentAlt,
  },
  categoryText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 15,
    fontWeight: '700',
  },
  categoryTextActive: {
    color: StreamingTheme.colors.textPrimary,
  },
  listContent: {
    paddingHorizontal: LIST_H_PAD,
    paddingBottom: 36,
    paddingTop: 12,
  },
  card: {
    margin: CARD_MARGIN,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  cardFocused: {
    borderWidth: 5,
    borderColor: StreamingTheme.colors.accentAlt,
    transform: [{ scale: 1.03 }],
  },
  cardPressed: {
    opacity: 0.92,
  },
  poster: {
    width: '100%',
    // aspectRatio agora é dinâmico
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  posterFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  meta: {
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 74,
  },
  cardTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  cardSubtitle: {
    marginTop: 4,
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
  },
  emptyText: {
    color: StreamingTheme.colors.textMuted,
    textAlign: 'center',
    marginTop: 42,
    fontSize: 16,
  },
  footerText: {
    color: StreamingTheme.colors.textMuted,
    textAlign: 'center',
    marginTop: 16,
  },
});
