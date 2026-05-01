import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AppState,
  AppStateStatus,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackdrop } from '@/components/app-backdrop';
import { FeatureGate } from '@/components/feature-gate';
import { StreamingTheme } from '@/constants/streaming-theme';
import { usePlanGate } from '@/hooks/use-plan-gate';
import {
  cancelDownload,
  deleteDownloadedItem,
  DownloadedItem,
  DownloadJob,
  loadDownloadedItems,
  pauseDownload,
  resumeDownload,
  subscribeDownloadJobs,
} from '@/services/downloads';
import { hasInternetConnection } from '@/services/network';

export default function DownloadsScreen() {
  const router = useRouter();
  const { hasFeature, loading: planLoading } = usePlanGate();
  const [items, setItems] = useState<DownloadedItem[]>([]);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [isOfflineLocked, setIsOfflineLocked] = useState(false);

  const refresh = async () => {
    setItems(await loadDownloadedItems());
  };

  useEffect(() => {
    refresh();
    const unsubscribe = subscribeDownloadJobs((nextJobs) => {
      setJobs(nextJobs);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    let mounted = true;

    const syncConnectivity = async () => {
      const online = await hasInternetConnection();
      if (mounted) {
        setIsOfflineLocked(!online);
      }
    };

    syncConnectivity();

    const onStateChange = async (state: AppStateStatus) => {
      if (state === 'active') {
        await syncConnectivity();
      }
    };

    const subscription = AppState.addEventListener('change', onStateChange);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  const movies = useMemo(() => items.filter((item) => item.type === 'movie'), [items]);
  const seriesGroups = useMemo(() => {
    const map = new Map<string, { key: string; title: string; image?: string; episodes: DownloadedItem[] }>();
    items
      .filter((item) => item.type === 'series-episode')
      .forEach((item) => {
        const key = item.seriesId || item.seriesTitle || item.id;
        const current = map.get(key);
        if (current) {
          current.episodes.push(item);
          return;
        }
        map.set(key, {
          key,
          title: item.seriesTitle || 'Serie baixada',
          image: item.image,
          episodes: [item],
        });
      });

    return Array.from(map.values()).map((group) => ({
      ...group,
      episodes: group.episodes.sort((a, b) => {
        const seasonDiff = (a.seasonNumber || 0) - (b.seasonNumber || 0);
        if (seasonDiff !== 0) return seasonDiff;
        return (a.episodeNumber || 0) - (b.episodeNumber || 0);
      }),
    }));
  }, [items]);

  const openDownloaded = (item: DownloadedItem) => {
    router.push({
      pathname: '/player',
      params: {
        mode: 'movie',
        title: item.seriesTitle ? `${item.seriesTitle} - ${item.title}` : item.title,
        url: item.localUri,
      },
    });
  };

  const onDelete = (item: DownloadedItem) => {
    Alert.alert('Remover download', 'Deseja excluir este conteudo baixado?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Excluir',
        style: 'destructive',
        onPress: async () => {
          await deleteDownloadedItem(item.id);
          await refresh();
        },
      },
    ]);
  };

  return (
    <FeatureGate feature="downloads" locked={!planLoading && !hasFeature('downloads')}>
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <AppBackdrop blurIntensity={28} />

      <View style={styles.header}>
        {isOfflineLocked ? (
          <View style={[styles.iconBtn, styles.iconBtnDisabled]}>
            <MaterialIcons name="lock" size={18} color={StreamingTheme.colors.textMuted} />
          </View>
        ) : (
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
        )}
        <View>
          <Text style={styles.kicker}>Modo offline</Text>
          <Text style={styles.title}>Downloads</Text>
        </View>
        <TouchableOpacity style={styles.iconBtn} onPress={refresh}>
          <MaterialIcons name="refresh" size={20} color={StreamingTheme.colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>{items.length} conteudos disponiveis offline</Text>
          <Text style={styles.summaryText}>Quando nao houver internet, esta tela continua disponivel com seus downloads.</Text>
        </View>

        {jobs.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Downloads em andamento</Text>
            {jobs.map((job) => (
              <View key={job.id} style={styles.jobCard}>
                <View style={styles.jobTop}>
                  <View style={styles.jobMain}>
                    <Text style={styles.jobTitle} numberOfLines={1}>{job.title}</Text>
                    <Text style={styles.jobMeta}>
                      {job.progressPercent}% • {job.status === 'paused' ? 'Pausado' : job.status === 'failed' ? 'Falhou' : 'Baixando'}
                    </Text>
                  </View>
                  <View style={styles.jobActions}>
                    {job.status === 'paused' ? (
                      <TouchableOpacity style={styles.jobActionBtn} onPress={() => resumeDownload(job.id)}>
                        <MaterialIcons name="play-arrow" size={16} color={StreamingTheme.colors.textPrimary} />
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity style={styles.jobActionBtn} onPress={() => pauseDownload(job.id)}>
                        <MaterialIcons name="pause" size={16} color={StreamingTheme.colors.textPrimary} />
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity style={styles.jobActionBtn} onPress={() => cancelDownload(job.id)}>
                      <MaterialIcons name="close" size={16} color={StreamingTheme.colors.textPrimary} />
                    </TouchableOpacity>
                  </View>
                </View>
                <View style={styles.jobProgressTrack}>
                  <View style={[styles.jobProgressFill, { width: `${job.progressPercent}%` }]} />
                </View>
              </View>
            ))}
          </View>
        )}

        {movies.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Filmes baixados</Text>
            <View style={styles.grid}>
              {movies.map((item) => (
                <TouchableOpacity key={item.id} style={styles.card} onPress={() => openDownloaded(item)}>
                  {item.image ? (
                    <Image source={{ uri: item.image }} style={styles.poster} cachePolicy="disk" />
                  ) : (
                    <View style={[styles.poster, styles.posterPlaceholder]}>
                      <MaterialIcons name="movie" size={24} color={StreamingTheme.colors.textMuted} />
                    </View>
                  )}
                  <TouchableOpacity style={styles.deleteBtn} onPress={() => onDelete(item)}>
                    <MaterialIcons name="delete-outline" size={16} color={StreamingTheme.colors.textPrimary} />
                  </TouchableOpacity>
                  <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {seriesGroups.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Series baixadas</Text>
            {seriesGroups.map((group) => (
              <View key={group.key} style={styles.seriesCard}>
                <View style={styles.seriesHeader}>
                  <View style={styles.seriesTitleWrap}>
                    <Text style={styles.seriesTitle}>{group.title}</Text>
                    <Text style={styles.seriesMeta}>{group.episodes.length} episodios offline</Text>
                  </View>
                </View>

                {group.episodes.map((episode) => (
                  <TouchableOpacity key={episode.id} style={styles.episodeRow} onPress={() => openDownloaded(episode)}>
                    <View style={styles.episodeMain}>
                      <Text style={styles.episodeTitle} numberOfLines={1}>{episode.title}</Text>
                      <Text style={styles.episodeMeta}>
                        {episode.subtitle || `S${episode.seasonNumber} E${episode.episodeNumber}`}
                      </Text>
                    </View>
                    <TouchableOpacity style={styles.episodeDeleteBtn} onPress={() => onDelete(episode)}>
                      <MaterialIcons name="delete-outline" size={16} color={StreamingTheme.colors.textPrimary} />
                    </TouchableOpacity>
                  </TouchableOpacity>
                ))}
              </View>
            ))}
          </View>
        )}

        {items.length === 0 && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>Nenhum download encontrado</Text>
            <Text style={styles.emptyText}>Baixe filmes e episodios nas telas de detalhes para assistir sem internet.</Text>
          </View>
        )}
        </ScrollView>
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
  iconBtnDisabled: {
    opacity: 0.55,
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
  content: {
    padding: 16,
    paddingBottom: 120,
  },
  summaryCard: {
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
  section: {
    marginTop: 16,
  },
  jobCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 12,
    marginBottom: 10,
  },
  jobTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  jobMain: {
    flex: 1,
  },
  jobTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 13,
  },
  jobMeta: {
    marginTop: 3,
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  jobActions: {
    flexDirection: 'row',
    gap: 8,
  },
  jobActionBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  jobProgressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
    marginTop: 10,
  },
  jobProgressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: StreamingTheme.colors.accent,
  },
  sectionTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '800',
    marginBottom: 10,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 14,
  },
  card: {
    width: '30.5%',
  },
  poster: {
    width: '100%',
    aspectRatio: 0.67,
    borderRadius: 12,
    backgroundColor: StreamingTheme.colors.surface,
    marginBottom: 8,
  },
  posterPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  cardTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  seriesCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 10,
    marginBottom: 12,
  },
  seriesHeader: {
    marginBottom: 8,
  },
  seriesTitleWrap: {
    flex: 1,
  },
  seriesTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  seriesMeta: {
    marginTop: 3,
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  episodeRow: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    padding: 8,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  episodeMain: { flex: 1 },
  episodeTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  episodeMeta: {
    marginTop: 2,
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  episodeDeleteBtn: {
    width: 30,
    height: 30,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCard: {
    marginTop: 16,
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
});
