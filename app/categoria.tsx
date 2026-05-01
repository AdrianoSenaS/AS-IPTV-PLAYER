import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
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

import { PageLoader } from '@/components/page-loader';
import { AppBackdrop } from '@/components/app-backdrop';
import { StreamingTheme } from '@/constants/streaming-theme';

type CatalogItem = {
  id: string;
  title: string;
  year: string;
  rating: number;
  kind: 'Filme' | 'Serie';
  poster: string;
  duration: string;
  isNew?: boolean;
};

const items: CatalogItem[] = [
  {
    id: '1',
    title: 'Duna: Parte Dois',
    year: '2024',
    rating: 4.8,
    kind: 'Filme',
    poster: 'https://image.tmdb.org/t/p/w300/8b8R8l88Qje9dn9OE8PY05Nxl1X.jpg',
    duration: '2h 46m',
    isNew: true,
  },
  {
    id: '2',
    title: 'The Last of Us',
    year: '2023',
    rating: 4.7,
    kind: 'Serie',
    poster: 'https://image.tmdb.org/t/p/w300/uKvVjHNqB5VmOrdxqAt2F7J78ED.jpg',
    duration: '2 Temporadas',
  },
  {
    id: '3',
    title: 'Godzilla Minus One',
    year: '2023',
    rating: 4.6,
    kind: 'Filme',
    poster: 'https://image.tmdb.org/t/p/w300/2Hz6XD4gUE2MSLQqYlR3qA4s9V4.jpg',
    duration: '2h 4m',
  },
  {
    id: '4',
    title: 'Severance',
    year: '2024',
    rating: 4.9,
    kind: 'Serie',
    poster: 'https://image.tmdb.org/t/p/w300/7zI4x6R8G6jY8QmQHIiph0QGlpY.jpg',
    duration: '2 Temporadas',
    isNew: true,
  },
  {
    id: '5',
    title: 'Furiosa',
    year: '2024',
    rating: 4.5,
    kind: 'Filme',
    poster: 'https://image.tmdb.org/t/p/w300/iADOJ8Zymht2JPMoy3R7xceZprc.jpg',
    duration: '2h 28m',
  },
];

const filters = ['Todos', 'Filme', 'Serie'];

export default function CategoriaScreen() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedFilter, setSelectedFilter] = useState('Todos');
  const [isGrid, setIsGrid] = useState(true);

  useEffect(() => {
    const timeout = setTimeout(() => setIsLoading(false), 260);
    return () => clearTimeout(timeout);
  }, []);

  const filtered = useMemo(() => {
    return items.filter((item) => {
      const bySearch = item.title.toLowerCase().includes(search.toLowerCase());
      const byFilter = selectedFilter === 'Todos' || item.kind === selectedFilter;
      return bySearch && byFilter;
    });
  }, [search, selectedFilter]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isLoading} label="Carregando categoria" />

      <View style={styles.header}>
        <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
        </TouchableOpacity>

        <View style={styles.headerText}>
          <Text style={styles.kicker}>Catalogo</Text>
          <Text style={styles.title}>Categorias</Text>
        </View>

        <TouchableOpacity style={styles.iconBtn} onPress={() => setIsGrid((prev) => !prev)}>
          <MaterialIcons
            name={isGrid ? 'view-list' : 'grid-view'}
            size={20}
            color={StreamingTheme.colors.textPrimary}
          />
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
        <MaterialIcons name="search" size={18} color={StreamingTheme.colors.textMuted} />
        <TextInput
          placeholder="Buscar filme ou serie"
          placeholderTextColor={StreamingTheme.colors.textMuted}
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filtersRow}
      >
        {filters.map((filter) => {
          const active = filter === selectedFilter;
          return (
            <TouchableOpacity
              key={filter}
              style={[styles.filterChip, active && styles.filterChipActive]}
              onPress={() => setSelectedFilter(filter)}
            >
              <Text style={[styles.filterText, active && styles.filterTextActive]}>{filter}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <Text style={styles.countText}>{filtered.length} resultados</Text>

      <FlatList
        data={filtered}
        key={isGrid ? 'grid' : 'list'}
        numColumns={isGrid ? 2 : 1}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        columnWrapperStyle={isGrid ? { gap: 12 } : undefined}
        renderItem={({ item }) =>
          isGrid ? (
            <TouchableOpacity style={styles.gridCard}>
              <Image source={{ uri: item.poster }} style={styles.gridPoster} cachePolicy="disk" />
              {item.isNew && (
                <View style={styles.newBadge}>
                  <Text style={styles.newText}>NOVO</Text>
                </View>
              )}
              <Text style={styles.gridTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.gridMeta}>{item.year} • {item.duration}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.listCard}>
              <Image source={{ uri: item.poster }} style={styles.listPoster} cachePolicy="disk" />
              <View style={styles.listInfo}>
                <Text style={styles.listTitle}>{item.title}</Text>
                <Text style={styles.listMeta}>{item.kind} • {item.year}</Text>
                <View style={styles.ratingRow}>
                  <MaterialIcons name="star" size={14} color={StreamingTheme.colors.warning} />
                  <Text style={styles.ratingText}>{item.rating}</Text>
                </View>
              </View>
            </TouchableOpacity>
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: StreamingTheme.colors.background,
  },
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
  headerText: {
    alignItems: 'center',
  },
  kicker: {
    color: StreamingTheme.colors.accentAlt,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 22,
    fontWeight: '900',
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
  searchInput: {
    flex: 1,
    height: 48,
    color: StreamingTheme.colors.textPrimary,
  },
  filtersRow: {
    paddingHorizontal: 16,
    paddingTop: 14,
    gap: 10,
  },
  filterChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: StreamingTheme.colors.surface,
  },
  filterChipActive: {
    backgroundColor: 'rgba(255,59,48,0.25)',
    borderColor: 'rgba(255,59,48,0.45)',
  },
  filterText: {
    color: StreamingTheme.colors.textSecondary,
    fontWeight: '700',
    fontSize: 12,
  },
  filterTextActive: {
    color: StreamingTheme.colors.textPrimary,
  },
  countText: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
    paddingBottom: 120,
  },
  gridCard: {
    flex: 1,
    marginBottom: 12,
  },
  gridPoster: {
    width: '100%',
    height: 220,
    borderRadius: 14,
    backgroundColor: StreamingTheme.colors.surface,
    marginBottom: 8,
  },
  newBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: StreamingTheme.colors.accent,
  },
  newText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 10,
  },
  gridTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 14,
  },
  gridMeta: {
    color: StreamingTheme.colors.textMuted,
    marginTop: 4,
    fontSize: 12,
  },
  listCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 10,
    flexDirection: 'row',
    gap: 10,
  },
  listPoster: {
    width: 88,
    height: 118,
    borderRadius: 10,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
  },
  listInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  listTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '800',
  },
  listMeta: {
    color: StreamingTheme.colors.textSecondary,
    marginTop: 4,
  },
  ratingRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ratingText: {
    color: StreamingTheme.colors.warning,
    fontWeight: '700',
  },
});
