import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';

import { useFocusEffect } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
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
import { FeatureGate } from '@/components/feature-gate';
import { StreamingTheme } from '@/constants/streaming-theme';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { loadCatalogData, sanitizeLabelText, StreamItem, toText } from '@/services/catalog-data';
import { buildLiveUrl } from '@/services/stream-url';
import { addItemToList, loadUserLists, removeItemFromList, UserList } from '@/services/user-lists';

type SearchItem = {
  id: string;
  type: 'movie' | 'series' | 'live';
  title: string;
  subtitle: string;
  image: string;
  contentId: string;
  raw: StreamItem;
};

export default function MinhaListaDetalheScreen() {
  const router = useRouter();
  const { hasFeature, loading: planLoading } = usePlanGate();
  const params = useLocalSearchParams<{ listId?: string }>();
  const listId = decodeURIComponent(String(params.listId || '')).trim();

  const [isLoading, setIsLoading] = useState(true);
  const [list, setList] = useState<UserList | null>(null);
  const [allMovies, setAllMovies] = useState<StreamItem[]>([]);
  const [allSeries, setAllSeries] = useState<StreamItem[]>([]);
  const [allLive, setAllLive] = useState<StreamItem[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'movie' | 'series' | 'live'>('all');

  const refresh = async () => {
    setIsLoading(true);
    const [lists, catalog] = await Promise.all([loadUserLists(), loadCatalogData()]);
    const found = lists.find((entry) => entry.id === listId) || null;
    setList(found);
    setAllMovies(catalog.vod);
    setAllSeries(catalog.series);
    setAllLive(catalog.liveStreams);
    setIsLoading(false);
  };

  useEffect(() => {
    refresh();
  }, [listId]);

  useFocusEffect(
    React.useCallback(() => {
      refresh();
    }, [listId])
  );

  const openItem = (type: 'movie' | 'series' | 'live', contentId: string, title: string, image?: string, playUrl?: string) => {
    if (type === 'movie') {
      router.push(`/filme-detalhe?streamId=${encodeURIComponent(contentId)}` as any);
      return;
    }

    if (type === 'series') {
      router.push({
        pathname: '/serie-detalhe',
        params: {
          seriesId: contentId,
          title,
          cover: image || '',
        },
      });
      return;
    }

    if (!playUrl) {
      Alert.alert('Canal sem URL', 'Nao foi possivel reproduzir este canal salvo.');
      return;
    }

    router.push({
      pathname: '/player',
      params: {
        mode: 'live',
        title,
        url: playUrl,
      },
    });
  };

  const results = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (normalized.length < 2) return [] as SearchItem[];

    const movies = allMovies
      .filter((item) => (filter === 'all' || filter === 'movie') && toText(item.title || item.name).toLowerCase().includes(normalized))
      .slice(0, 10)
      .map((item) => ({
        id: `movie-${toText(item.stream_id)}`,
        type: 'movie' as const,
        title: sanitizeLabelText(item.title || item.name, 'Filme'),
        subtitle: 'Filme',
        image: toText(item.stream_icon || item.cover),
        contentId: toText(item.stream_id),
        raw: item,
      }));

    const series = allSeries
      .filter((item) => (filter === 'all' || filter === 'series') && toText(item.title || item.name).toLowerCase().includes(normalized))
      .slice(0, 10)
      .map((item) => ({
        id: `series-${toText(item.series_id)}`,
        type: 'series' as const,
        title: sanitizeLabelText(item.title || item.name, 'Serie'),
        subtitle: 'Serie',
        image: toText(item.stream_icon || item.cover),
        contentId: toText(item.series_id),
        raw: item,
      }));

    const live = allLive
      .filter((item) => (filter === 'all' || filter === 'live') && toText(item.name || item.title).toLowerCase().includes(normalized))
      .slice(0, 10)
      .map((item) => ({
        id: `live-${toText(item.stream_id)}`,
        type: 'live' as const,
        title: sanitizeLabelText(item.name || item.title, 'Canal ao vivo'),
        subtitle: 'TV ao vivo',
        image: toText(item.stream_icon || item.cover),
        contentId: toText(item.stream_id),
        raw: item,
      }));

    return [...movies, ...series, ...live];
  }, [search, filter, allMovies, allSeries, allLive]);

  const addSearchResult = async (item: SearchItem) => {
    if (!list) return;

    const playUrl = item.type === 'live' ? (await buildLiveUrl(item.raw)) || undefined : undefined;
    await addItemToList(list.id, {
      type: item.type,
      contentId: item.contentId,
      title: item.title,
      subtitle: item.subtitle,
      image: item.image,
      playUrl,
    });
    await refresh();
    setSearch('');
  };

  const removeSavedItem = async (itemId: string) => {
    if (!list) return;
    await removeItemFromList(list.id, itemId);
    await refresh();
  };

  if (isLoading) {
    return (
      <FeatureGate feature="lists" locked={!planLoading && !hasFeature('lists')}>
        <SafeAreaView style={styles.container}>
          <AppBackdrop blurIntensity={28} />
          <View style={styles.centerState}>
            <Text style={styles.centerTitle}>Carregando lista...</Text>
          </View>
        </SafeAreaView>
      </FeatureGate>
    );
  }

  if (!list) {
    return (
      <FeatureGate feature="lists" locked={!planLoading && !hasFeature('lists')}>
        <SafeAreaView style={styles.container}>
          <AppBackdrop blurIntensity={28} />
          <View style={styles.centerState}>
            <Text style={styles.centerTitle}>Lista nao encontrada</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={() => router.back()}>
              <Text style={styles.primaryBtnText}>Voltar</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </FeatureGate>
    );
  }

  return (
    <FeatureGate feature="lists" locked={!planLoading && !hasFeature('lists')}>
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <AppBackdrop blurIntensity={28} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
        </TouchableOpacity>
        <View>
          <Text style={styles.kicker}>Sua playlist</Text>
          <Text style={styles.title}>{list.name}</Text>
        </View>
        <View style={styles.iconBtn}>
          <MaterialIcons name="queue-music" size={18} color={StreamingTheme.colors.textPrimary} />
        </View>
      </View>

      <View style={styles.summaryCard}>
        <Text style={styles.summaryTitle}>{list.items.length} itens salvos</Text>
        <Text style={styles.summaryText}>Adicione filmes, series e TV ao vivo pela busca abaixo.</Text>
      </View>

      <View style={styles.searchWrap}>
        <MaterialIcons name="search" size={18} color={StreamingTheme.colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Buscar para adicionar na lista"
          placeholderTextColor={StreamingTheme.colors.textMuted}
        />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
        {[
          { key: 'all', label: 'Todos' },
          { key: 'movie', label: 'Filmes' },
          { key: 'series', label: 'Series' },
          { key: 'live', label: 'TV' },
        ].map((entry) => {
          const active = filter === entry.key;
          return (
            <TouchableOpacity
              key={entry.key}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => setFilter(entry.key as any)}>
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{entry.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {results.length > 0 && (
        <View style={styles.searchResultsWrap}>
          <Text style={styles.sectionTitle}>Adicionar na lista</Text>
          {results.map((item) => (
            <TouchableOpacity key={item.id} style={styles.searchResultCard} onPress={() => addSearchResult(item)}>
              <Image source={{ uri: item.image }} style={styles.searchResultImage} cachePolicy="disk" />
              <View style={styles.searchResultMain}>
                <Text style={styles.searchResultTitle} numberOfLines={1}>{item.title}</Text>
                <Text style={styles.searchResultSub}>{item.subtitle}</Text>
              </View>
              <MaterialIcons name="playlist-add" size={20} color={StreamingTheme.colors.accentAlt} />
            </TouchableOpacity>
          ))}
        </View>
      )}

      <Text style={styles.sectionTitle}>Conteudos da lista</Text>
      <FlatList
        data={filter === 'all' ? list.items : list.items.filter((i) => i.type === filter)}
        keyExtractor={(item) => item.id}
        extraData={list}
        numColumns={3}
        contentContainerStyle={styles.listContent}
        columnWrapperStyle={styles.columnWrap}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.card}
            onPress={() => openItem(item.type, item.contentId, item.title, item.image, item.playUrl)}>
            <Image source={{ uri: item.image }} style={styles.poster} cachePolicy="disk" />
            <TouchableOpacity style={styles.removeBtn} onPress={() => removeSavedItem(item.id)}>
              <MaterialIcons name="close" size={16} color={StreamingTheme.colors.textPrimary} />
            </TouchableOpacity>
            <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
            <Text style={styles.cardMeta} numberOfLines={1}>{item.subtitle || item.type}</Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>Sua lista esta vazia</Text>
            <Text style={styles.emptyText}>Use a busca acima para adicionar filmes, series e canais.</Text>
          </View>
        }
      />
      </SafeAreaView>
    </FeatureGate>
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
    maxWidth: 200,
  },
  summaryCard: {
    marginTop: 14,
    marginHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 12,
  },
  summaryTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 14,
  },
  summaryText: {
    marginTop: 4,
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
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
    paddingTop: 12,
    paddingBottom: 2,
    gap: 8,
    alignItems: 'center',
  },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipActive: {
    backgroundColor: 'rgba(255,59,48,0.25)',
    borderColor: 'rgba(255,59,48,0.45)',
  },
  chipText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  chipTextActive: {
    color: StreamingTheme.colors.textPrimary,
  },
  sectionTitle: {
    marginTop: 14,
    marginBottom: 8,
    paddingHorizontal: 16,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '800',
  },
  searchResultsWrap: {
    paddingHorizontal: 16,
    gap: 8,
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
  searchResultMain: { flex: 1 },
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
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 120,
  },
  columnWrap: {
    justifyContent: 'flex-start',
    gap: 8,
    marginBottom: 10,
  },
  card: {
    width: '31%',
  },
  poster: {
    width: '100%',
    aspectRatio: 0.67,
    borderRadius: 12,
    backgroundColor: StreamingTheme.colors.surface,
    marginBottom: 8,
  },
  removeBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 26,
    height: 26,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  cardMeta: {
    marginTop: 2,
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  emptyCard: {
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 14,
  },
  emptyTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 14,
  },
  emptyText: {
    marginTop: 6,
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  centerTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 12,
  },
  primaryBtn: {
    borderRadius: 12,
    backgroundColor: StreamingTheme.colors.accent,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  primaryBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
  },
});
