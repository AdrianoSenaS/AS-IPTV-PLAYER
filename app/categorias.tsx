import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PageLoader } from '@/components/page-loader';
import { AppBackdrop } from '@/components/app-backdrop';
import { ParentalUnlockModal } from '@/components/parental-unlock-modal';
import { StreamingTheme } from '@/constants/streaming-theme';
import {
  AccessSnapshot,
  filterBlockedContent,
  loadAccessSnapshot,
  unlockParentalAccess,
} from '@/services/access-control';
import { loadCatalogData, sanitizeLabelText, StreamItem, toText } from '@/services/catalog-data';

type SectionType = 'filmes' | 'series' | 'ao-vivo';

const sectionMeta: Record<SectionType, { title: string; kicker: string }> = {
  filmes: {
    title: 'Categorias de filmes',
    kicker: 'Filtrar catalogo de filmes',
  },
  series: {
    title: 'Categorias de series',
    kicker: 'Filtrar catalogo de series',
  },
  'ao-vivo': {
    title: 'Categorias de TV ao vivo',
    kicker: 'Filtrar canais ao vivo',
  },
};

export default function CategoriasScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tipo?: string }>();
  const [isLoading, setIsLoading] = useState(true);
  const [categories, setCategories] = useState<StreamItem[]>([]);
  const [access, setAccess] = useState<AccessSnapshot | null>(null);
  const [showUnlockModal, setShowUnlockModal] = useState(false);

  const sectionType: SectionType =
    params.tipo === 'series' || params.tipo === 'ao-vivo' || params.tipo === 'filmes'
      ? params.tipo
      : 'filmes';

  const meta = sectionMeta[sectionType];

  useEffect(() => {
    const bootstrap = async () => {
      const { vodCategories, seriesCategories: seriesCat, liveCategories: liveCat } = await loadCatalogData();
      if (!vodCategories.length && !seriesCat.length && !liveCat.length) {
        router.replace('/loading');
        return;
      }

      if (sectionType === 'filmes') {
        setCategories(vodCategories);
      } else if (sectionType === 'series') {
        setCategories(seriesCat);
      } else {
        setCategories(liveCat);
      }

      setAccess(await loadAccessSnapshot());

      setIsLoading(false);
    };

    bootstrap();
  }, [sectionType]);

  const filteredCategories = React.useMemo(() => {
    if (!access) return categories;

    return filterBlockedContent(
      access,
      categories,
      (item) => `${toText(item.category_name)} ${toText(item.name || item.title)}`
    );
  }, [categories, access]);

  const handleUnlock = async (pin: string) => {
    const ok = await unlockParentalAccess(pin);
    if (!ok) {
      Alert.alert('PIN incorreto', 'Nao foi possivel desbloquear o conteudo.');
      return;
    }

    setShowUnlockModal(false);
    setAccess(await loadAccessSnapshot());
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isLoading} label="Carregando categorias" />

      <View style={styles.header}>
        <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
        </TouchableOpacity>
        <View>
          <Text style={styles.kicker}>{meta.kicker}</Text>
          <Text style={styles.title}>Categorias</Text>
        </View>
        <View style={styles.iconBtn} />
      </View>

      <SectionTitle title={meta.title} count={filteredCategories.length} />
      <FlatList
          data={filteredCategories}
          keyExtractor={(item, index) => String(item.category_id ?? `cat-${index}`)}
          contentContainerStyle={styles.sectionListBottom}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.card}
              onPress={() => {
                if (sectionType === 'filmes') {
                  router.navigate({ pathname: '/filmes', params: { categoryId: toText(item.category_id) } });
                } else if (sectionType === 'series') {
                  router.navigate({ pathname: '/series', params: { categoryId: toText(item.category_id) } });
                } else {
                  router.navigate({ pathname: '/ao-vivo', params: { categoryId: toText(item.category_id) } });
                }
              }}
            >
              <Text style={styles.cardTitle}>{sanitizeLabelText(item.category_name, 'Categoria')}</Text>
              <MaterialIcons name="chevron-right" size={20} color={StreamingTheme.colors.textMuted} />
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

function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionCount}>{count}</Text>
    </View>
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
    marginBottom: 8,
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
  sectionHeader: {
    marginTop: 10,
    marginBottom: 8,
    paddingHorizontal: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '800',
  },
  sectionCount: {
    color: StreamingTheme.colors.textMuted,
    fontWeight: '700',
  },
  lockBanner: {
    marginTop: 4,
    marginBottom: 8,
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
  sectionList: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  sectionListBottom: {
    paddingHorizontal: 16,
    paddingBottom: 120,
    gap: 8,
  },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 14,
  },
});
