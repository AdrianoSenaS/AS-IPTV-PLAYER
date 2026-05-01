import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeatureGate } from '@/components/feature-gate';
import { PageLoader } from '@/components/page-loader';
import { AppBackdrop } from '@/components/app-backdrop';
import { StreamingTheme } from '@/constants/streaming-theme';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { loadAccountSettings, updateParentalSettings } from '@/services/account-settings';
import { loadCatalogData, sanitizeLabelText, toText } from '@/services/catalog-data';

type CategoryItem = {
  id: string;
  name: string;
  kind: 'filme' | 'serie' | 'tv';
};

type ContentItem = {
  id: string;
  title: string;
  kind: 'filme' | 'serie' | 'tv';
};

export default function ConfiguracoesParentalFiltrosScreen() {
  const router = useRouter();
  const { hasFeature, loading: planLoading } = usePlanGate();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const [categorySearch, setCategorySearch] = useState('');
  const [contentSearch, setContentSearch] = useState('');

  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [contents, setContents] = useState<ContentItem[]>([]);

  const [blockedCategoryIds, setBlockedCategoryIds] = useState<string[]>([]);
  const [blockedCategoryNames, setBlockedCategoryNames] = useState<string[]>([]);
  const [blockedContentTitles, setBlockedContentTitles] = useState<string[]>([]);
  const firstHydrationDone = useMemo(() => categories.length > 0 || contents.length > 0, [categories.length, contents.length]);
  const parentalLocked = !planLoading && !hasFeature('parental_controls');

  if (parentalLocked) {
    return <FeatureGate feature="parental_controls" locked>{null}</FeatureGate>;
  }

  const hydrate = useCallback(async () => {
    if (!firstHydrationDone) {
      setIsLoading(true);
    }
    try {
      const [settings, catalog] = await Promise.all([loadAccountSettings(), loadCatalogData()]);

      const map = new Map<string, CategoryItem>();
      catalog.vodCategories.forEach((item) => {
        const id = toText(item.category_id);
        const name = sanitizeLabelText(item.category_name || item.name, 'Sem categoria');
        if (id) map.set(`filme-${id}`, { id, name, kind: 'filme' });
      });
      catalog.seriesCategories.forEach((item) => {
        const id = toText(item.category_id);
        const name = sanitizeLabelText(item.category_name || item.name, 'Sem categoria');
        if (id) map.set(`serie-${id}`, { id, name, kind: 'serie' });
      });
      catalog.liveCategories.forEach((item) => {
        const id = toText(item.category_id);
        const name = sanitizeLabelText(item.category_name || item.name, 'Sem categoria');
        if (id) map.set(`tv-${id}`, { id, name, kind: 'tv' });
      });

      const contentMap = new Map<string, ContentItem>();
      catalog.vod.forEach((item) => {
        const title = sanitizeLabelText(item.title || item.name, '');
        if (!title) return;
        contentMap.set(`filme-${title.toLowerCase()}`, { id: toText(item.stream_id || title), title, kind: 'filme' });
      });
      catalog.series.forEach((item) => {
        const title = sanitizeLabelText(item.title || item.name, '');
        if (!title) return;
        contentMap.set(`serie-${title.toLowerCase()}`, { id: toText(item.series_id || title), title, kind: 'serie' });
      });
      catalog.liveStreams.forEach((item) => {
        const title = sanitizeLabelText(item.title || item.name, '');
        if (!title) return;
        contentMap.set(`tv-${title.toLowerCase()}`, { id: toText(item.stream_id || title), title, kind: 'tv' });
      });

      setCategories(Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name)));
      setContents(Array.from(contentMap.values()).sort((a, b) => a.title.localeCompare(b.title)).slice(0, 1000));

      setBlockedCategoryIds(settings.parental.blockedCategoryIds || []);
      setBlockedCategoryNames(settings.parental.blockedCategoryNames || []);
      setBlockedContentTitles(settings.parental.blockedContentTitles || []);
    } finally {
      setIsLoading(false);
    }
  }, [firstHydrationDone]);

  useFocusEffect(
    useCallback(() => {
      hydrate();
    }, [hydrate])
  );

  const filteredCategories = useMemo(() => {
    const q = categorySearch.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((item) => item.name.toLowerCase().includes(q) || item.kind.includes(q));
  }, [categories, categorySearch]);

  const filteredContents = useMemo(() => {
    const q = contentSearch.trim().toLowerCase();
    if (!q) return contents.slice(0, 120);
    return contents.filter((item) => item.title.toLowerCase().includes(q) || item.kind.includes(q)).slice(0, 120);
  }, [contents, contentSearch]);

  const toggleCategory = (item: CategoryItem) => {
    const nextId = blockedCategoryIds.includes(item.id)
      ? blockedCategoryIds.filter((id) => id !== item.id)
      : [...blockedCategoryIds, item.id];

    const normalizedName = item.name.toLowerCase();
    const nextNames = blockedCategoryNames.includes(normalizedName)
      ? blockedCategoryNames.filter((name) => name !== normalizedName)
      : [...blockedCategoryNames, normalizedName];

    setBlockedCategoryIds(nextId);
    setBlockedCategoryNames(nextNames);
  };

  const toggleContent = (item: ContentItem) => {
    const normalized = item.title.toLowerCase();
    const next = blockedContentTitles.includes(normalized)
      ? blockedContentTitles.filter((title) => title !== normalized)
      : [...blockedContentTitles, normalized];
    setBlockedContentTitles(next);
  };

  const onSave = async () => {
    try {
      setIsSaving(true);
      await updateParentalSettings({
        blockedCategoryIds,
        blockedCategoryNames,
        blockedContentTitles,
      });
      Alert.alert('Filtro parental', 'Bloqueios por categoria e conteudo salvos.');
      router.back();
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel salvar.'));
    } finally {
      setIsSaving(false);
    }
  };

  const countText = `Categorias bloqueadas: ${blockedCategoryIds.length} • Conteudos bloqueados: ${blockedContentTitles.length}`;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isLoading || isSaving} label={isLoading ? 'Carregando filtros parentais' : 'Salvando filtros'} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.kicker}>BLOQUEIOS AVANCADOS</Text>
            <Text style={styles.title}>Categorias e conteudos</Text>
          </View>
          <View style={styles.iconBtn} />
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Resumo</Text>
          <Text style={styles.summaryText}>{countText}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Bloquear categorias do servidor</Text>
          <TextInput
            style={styles.input}
            placeholder="Pesquisar categoria (ex: terror)"
            placeholderTextColor={StreamingTheme.colors.textMuted}
            value={categorySearch}
            onChangeText={setCategorySearch}
          />

          {filteredCategories.map((item) => {
            const active = blockedCategoryIds.includes(item.id);
            return (
              <TouchableOpacity key={`${item.kind}-${item.id}`} style={[styles.rowItem, active && styles.rowItemActive]} onPress={() => toggleCategory(item)}>
                <Text style={styles.rowTitle}>{item.name}</Text>
                <Text style={styles.rowSub}>{item.kind.toUpperCase()}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Bloquear filmes/series/canais por nome</Text>
          <TextInput
            style={styles.input}
            placeholder="Pesquisar titulo (ex: transformers)"
            placeholderTextColor={StreamingTheme.colors.textMuted}
            value={contentSearch}
            onChangeText={setContentSearch}
          />

          {filteredContents.map((item) => {
            const active = blockedContentTitles.includes(item.title.toLowerCase());
            return (
              <TouchableOpacity key={`${item.kind}-${item.id}-${item.title}`} style={[styles.rowItem, active && styles.rowItemActive]} onPress={() => toggleContent(item)}>
                <Text style={styles.rowTitle}>{item.title}</Text>
                <Text style={styles.rowSub}>{item.kind.toUpperCase()}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <TouchableOpacity style={styles.saveBtn} onPress={onSave}>
          <MaterialIcons name="save" size={18} color={StreamingTheme.colors.textPrimary} />
          <Text style={styles.saveText}>Salvar filtros avancados</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: StreamingTheme.colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 120,
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTextWrap: { flex: 1 },
  kicker: {
    color: StreamingTheme.colors.accentAlt,
    fontWeight: '700',
    letterSpacing: 1,
    fontSize: 12,
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '900',
    fontSize: 24,
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(16,21,37,0.86)',
    padding: 12,
    gap: 8,
  },
  sectionTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '900',
    fontSize: 16,
  },
  summaryText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
  },
  input: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    height: 46,
    paddingHorizontal: 12,
    color: StreamingTheme.colors.textPrimary,
  },
  rowItem: {
    borderRadius: 11,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    paddingHorizontal: 10,
    paddingVertical: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowItemActive: {
    borderColor: 'rgba(255,59,48,0.55)',
    backgroundColor: 'rgba(255,59,48,0.18)',
  },
  rowTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 13,
    flex: 1,
    paddingRight: 8,
  },
  rowSub: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  saveBtn: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,59,48,0.5)',
    backgroundColor: 'rgba(255,59,48,0.24)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  saveText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
  },
});
