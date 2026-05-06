import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  ListRenderItemInfo,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  findNodeHandle,
  useWindowDimensions,
  View,
} from 'react-native';

import { AppBackdrop } from '@/components/app-backdrop';
import { StreamingTheme } from '@/constants/streaming-theme';
import { CatalogKind, queryCatalogCategories, StreamItem, toText } from '@/services/catalog-data';

type CatItem = {
  id: string;
  name: string;
};

const H_PAD = 20;
const CARD_MARGIN = 10;
const CARD_COLS_MIN = 3;

function getCatLayout(width: number): { columns: number; cardWidth: number } {
  let columns: number;
  if (width >= 3200) columns = 9;
  else if (width >= 2400) columns = 8;
  else if (width >= 1800) columns = 7;
  else if (width >= 1200) columns = 6;
  else if (width >= 900) columns = 5;
  else columns = CARD_COLS_MIN;

  const cardWidth = Math.floor(
    (width - H_PAD * 2 - columns * CARD_MARGIN * 2) / columns
  );

  return { columns, cardWidth };
}

function normalizeKind(k: string): CatalogKind {
  if (k === 'vod' || k === 'series' || k === 'live') return k;
  return 'live';
}

export default function TvCategoriaScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ kind?: string; title?: string }>();
  const { width } = useWindowDimensions();

  const kind = normalizeKind(String(params.kind || 'vod'));
  const screenTitle = String(params.title || 'Categorias');

  const [categories, setCategories] = useState<CatItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [focusedBack, setFocusedBack] = useState(false);

  const layout = useMemo(() => getCatLayout(width), [width]);

  const flatListRef = useRef<FlatList<CatItem>>(null);
  const lastFocusedRowRef = useRef(-1);
  const backBtnRef = useRef<React.ElementRef<typeof Pressable>>(null);
  const cardRefs = useRef<Record<number, React.ElementRef<typeof Pressable> | null>>({});

  const getHandle = useCallback((node: unknown) => findNodeHandle(node as any) ?? undefined, []);
  const getCardHandle = useCallback(
    (index: number) => {
      if (index < 0 || index >= categories.length) return undefined;
      return getHandle(cardRefs.current[index]);
    },
    [categories.length, getHandle]
  );

  const useTVEventHandlerCompat = (require('react-native') as any).useTVEventHandler as
    | ((handler: (event: any) => void) => void)
    | undefined;

  useTVEventHandlerCompat?.((event: any) => {
    const type = String(event?.eventType || '').toLowerCase();
    if (type === 'menu' || type === 'back') {
      router.back();
    }
  });

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setIsLoading(true);
      try {
        const cats = await queryCatalogCategories(kind);
        if (!mounted) return;
        const parsed: CatItem[] = cats.map((c: StreamItem) => ({
          id: toText(c.category_id),
          name: toText(c.category_name, 'Categoria'),
        }));
        setCategories(parsed);
      } catch {
        // silencia
      }
      if (mounted) setIsLoading(false);
    };
    void load();
    return () => { mounted = false; };
  }, [kind]);

  useEffect(() => {
    lastFocusedRowRef.current = -1;
    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [kind]);

  const syncScrollWithFocus = useCallback(
    (index: number) => {
      const row = Math.floor(index / Math.max(1, layout.columns));
      if (row === lastFocusedRowRef.current) return;
      lastFocusedRowRef.current = row;
      flatListRef.current?.scrollToIndex({
        index,
        viewPosition: 0.18,
        animated: false,
      });
    },
    [layout.columns]
  );

  const goToLista = useCallback(
    (cat: CatItem) => {
      router.push({
        pathname: '/tv/lista' as any,
        params: {
          kind,
          title: cat.name,
          categoryId: cat.id,
        },
      });
    },
    [kind, router]
  );

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<CatItem>) => {
      const col = index % layout.columns;
      const row = Math.floor(index / layout.columns);
      const leftIndex = col === 0 ? index : index - 1;
      const rightIndex = col === layout.columns - 1 ? index : Math.min(categories.length - 1, index + 1);
      const upIndex = row === 0 ? -1 : index - layout.columns;
      const downIndex = index + layout.columns;

      return (
        <Pressable
          ref={(el) => { cardRefs.current[index] = el; }}
          onPress={() => goToLista(item)}
          onFocus={() => syncScrollWithFocus(index)}
          hasTVPreferredFocus={index === 0}
          style={({ pressed }) => [
            styles.card,
            { width: layout.cardWidth },
            pressed && styles.cardPressed,
          ]}
          {...({
            nextFocusLeft: getCardHandle(leftIndex),
            nextFocusRight: getCardHandle(rightIndex),
            nextFocusUp: upIndex >= 0 ? getCardHandle(upIndex) : getHandle(backBtnRef.current),
            nextFocusDown: downIndex < categories.length ? getCardHandle(downIndex) : undefined,
          } as any)}
        >
          {({ focused }: { focused: boolean }) => (
            <>
              <MaterialIcons
                name={kind === 'live' ? 'live-tv' : kind === 'series' ? 'smart-display' : 'movie'}
                size={30}
                color={focused ? StreamingTheme.colors.accentAlt : StreamingTheme.colors.textMuted}
              />
              <Text numberOfLines={3} style={[styles.catName, focused && styles.catNameFocused]}>
                {item.name}
              </Text>
            </>
          )}
        </Pressable>
      );
    },
    [categories.length, getCardHandle, getHandle, goToLista, kind, layout]
  );

  return (
    <SafeAreaView style={styles.container}>
      <AppBackdrop blurIntensity={22} />

      <View style={styles.header}>
        <Pressable
          ref={backBtnRef}
          style={[styles.backBtn, focusedBack && styles.backBtnFocused]}
          onPress={() => router.back()}
          onFocus={() => setFocusedBack(true)}
          onBlur={() => setFocusedBack(false)}
          {...({
            nextFocusDown: getCardHandle(0),
          } as any)}
        >
          <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          <Text style={styles.backText}>Voltar</Text>
        </Pressable>
        <Text style={styles.title}>{screenTitle}</Text>
        <Text style={styles.subtitle}>
          {isLoading ? 'Carregando...' : `${categories.length} categorias`}
        </Text>
      </View>

      {isLoading ? (
        <View style={styles.centerWrap}>
          <Text style={styles.emptyText}>Carregando categorias...</Text>
        </View>
      ) : categories.length === 0 ? (
        <View style={styles.centerWrap}>
          <Text style={styles.emptyText}>Nenhuma categoria encontrada.</Text>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={categories}
          renderItem={renderItem}
          keyExtractor={(cat) => cat.id}
          numColumns={layout.columns}
          key={`cat-grid-${layout.columns}-${kind}`}
          scrollEnabled={false}
          extraData={layout.columns}
          initialNumToRender={20}
          maxToRenderPerBatch={24}
          windowSize={8}
          removeClippedSubviews
          onScrollToIndexFailed={({ index, averageItemLength }) => {
            const fallbackOffset = Math.max(0, Math.floor(index * Math.max(averageItemLength || 0, 1)));
            flatListRef.current?.scrollToOffset({ offset: fallbackOffset, animated: false });
            setTimeout(() => {
              flatListRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.18 });
            }, 0);
          }}
          contentContainerStyle={styles.listContent}
        />
      )}
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
    gap: 14,
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
  subtitle: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 'auto',
  },
  listContent: {
    paddingHorizontal: H_PAD,
    paddingBottom: 36,
    paddingTop: 12,
  },
  card: {
    margin: CARD_MARGIN,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 18,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 110,
    gap: 10,
  },
  cardFocused: {
    borderWidth: 5,
    borderColor: StreamingTheme.colors.accentAlt,
    backgroundColor: 'rgba(255,143,58,0.12)',
    transform: [{ scale: 1.04 }],
  },
  cardPressed: {
    opacity: 0.88,
  },
  catName: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 20,
  },
  catNameFocused: {
    color: StreamingTheme.colors.textPrimary,
  },
  centerWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 18,
    fontWeight: '600',
  },
});
