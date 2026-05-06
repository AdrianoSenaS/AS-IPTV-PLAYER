import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AppState,
  AppStateStatus,
  Modal,
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

type DownloadedSeriesGroup = {
  key: string;
  title: string;
  image?: string;
  episodes: DownloadedItem[];
  seasons: number[];
  totalSizeBytes: number;
  latestDownloadedAt: string;
};

function parseSeasonEpisodeFromSubtitle(subtitle?: string) {
  const text = String(subtitle || '');
  const match = text.match(/S\s*(\d+)\s*E\s*(\d+)/i);
  return {
    seasonNumber: match ? Number(match[1]) : 0,
    episodeNumber: match ? Number(match[2]) : 0,
  };
}

function getEpisodePosition(item: DownloadedItem) {
  const parsed = parseSeasonEpisodeFromSubtitle(item.subtitle);
  const seasonNumber = Number(item.seasonNumber || parsed.seasonNumber || 0);
  const episodeNumber = Number(item.episodeNumber || parsed.episodeNumber || 0);
  return { seasonNumber, episodeNumber };
}

function formatSize(bytes: number) {
  const safe = Math.max(0, Number(bytes || 0));
  if (!safe) return '0 MB';
  const mb = safe / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export default function DownloadsScreen() {
  const router = useRouter();
  const { hasFeature, loading: planLoading } = usePlanGate();
  const [items, setItems] = useState<DownloadedItem[]>([]);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [isOfflineLocked, setIsOfflineLocked] = useState(false);
  const [selectedSeriesKey, setSelectedSeriesKey] = useState('');
  const [selectedSeason, setSelectedSeason] = useState(0);

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

  const seriesGroups = useMemo<DownloadedSeriesGroup[]>(() => {
    const map = new Map<string, DownloadedSeriesGroup>();

    items
      .filter((item) => item.type === 'series-episode')
      .forEach((item) => {
        const key = item.seriesId || item.seriesTitle || item.id;
        const current = map.get(key);
        if (current) {
          current.episodes.push(item);
          current.totalSizeBytes += Number(item.sizeBytes || 0);
          if (!current.latestDownloadedAt || String(item.downloadedAt || '') > current.latestDownloadedAt) {
            current.latestDownloadedAt = String(item.downloadedAt || '');
          }
          return;
        }

        map.set(key, {
          key,
          title: item.seriesTitle || 'Série baixada',
          image: item.image,
          episodes: [item],
          seasons: [],
          totalSizeBytes: Number(item.sizeBytes || 0),
          latestDownloadedAt: String(item.downloadedAt || ''),
        });
      });

    return Array.from(map.values())
      .map((group) => {
        const orderedEpisodes = [...group.episodes].sort((a, b) => {
          const posA = getEpisodePosition(a);
          const posB = getEpisodePosition(b);
          const seasonDiff = posA.seasonNumber - posB.seasonNumber;
          if (seasonDiff !== 0) return seasonDiff;

          const epDiff = posA.episodeNumber - posB.episodeNumber;
          if (epDiff !== 0) return epDiff;

          return String(a.downloadedAt || '').localeCompare(String(b.downloadedAt || ''));
        });

        const seasons = Array.from(
          new Set(orderedEpisodes.map((episode) => getEpisodePosition(episode).seasonNumber).filter((season) => season > 0))
        ).sort((a, b) => a - b);

        return {
          ...group,
          episodes: orderedEpisodes,
          seasons,
        };
      })
      .sort((a, b) => b.latestDownloadedAt.localeCompare(a.latestDownloadedAt));
  }, [items]);

  const selectedSeries = useMemo(
    () => seriesGroups.find((group) => group.key === selectedSeriesKey) || null,
    [seriesGroups, selectedSeriesKey]
  );

  useEffect(() => {
    if (!selectedSeries) {
      setSelectedSeason(0);
      return;
    }

    if (selectedSeries.seasons.length && !selectedSeries.seasons.includes(selectedSeason)) {
      setSelectedSeason(selectedSeries.seasons[0]);
      return;
    }

    if (!selectedSeason && selectedSeries.seasons.length) {
      setSelectedSeason(selectedSeries.seasons[0]);
    }
  }, [selectedSeries, selectedSeason]);

  const filteredSeriesEpisodes = useMemo(() => {
    if (!selectedSeries) return [];
    if (!selectedSeason) return selectedSeries.episodes;
    return selectedSeries.episodes.filter((episode) => getEpisodePosition(episode).seasonNumber === selectedSeason);
  }, [selectedSeries, selectedSeason]);

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
    Alert.alert('Remover download', 'Deseja excluir este conteúdo baixado?', [
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

  const onDeleteSeriesGroup = (group: DownloadedSeriesGroup) => {
    Alert.alert('Remover série', `Excluir todos os episódios de ${group.title}?`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Excluir tudo',
        style: 'destructive',
        onPress: async () => {
          for (const episode of group.episodes) {
            await deleteDownloadedItem(episode.id);
          }
          await refresh();
          if (selectedSeriesKey === group.key) {
            setSelectedSeriesKey('');
          }
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
          <LinearGradient colors={['rgba(255,59,48,0.22)', 'rgba(22,27,46,0.96)']} style={styles.summaryCard}>
            <Text style={styles.summaryTitle}>{items.length} conteúdos disponíveis offline</Text>
            <Text style={styles.summaryText}>Quando não houver internet, esta tela continua disponível com seus downloads.</Text>
            <View style={styles.summaryStatsRow}>
              <View style={styles.summaryStatPill}>
                <MaterialIcons name="movie" size={14} color={StreamingTheme.colors.accentAlt} />
                <Text style={styles.summaryStatText}>{movies.length} filmes</Text>
              </View>
              <View style={styles.summaryStatPill}>
                <MaterialIcons name="theaters" size={14} color={StreamingTheme.colors.accentAlt} />
                <Text style={styles.summaryStatText}>{seriesGroups.length} séries</Text>
              </View>
            </View>
          </LinearGradient>

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
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalList}>
                {movies.map((item) => (
                  <TouchableOpacity key={item.id} style={styles.movieCard} onPress={() => openDownloaded(item)}>
                    {item.image ? (
                      <Image source={{ uri: item.image }} style={styles.moviePoster} cachePolicy="disk" />
                    ) : (
                      <View style={[styles.moviePoster, styles.posterPlaceholder]}>
                        <MaterialIcons name="movie" size={24} color={StreamingTheme.colors.textMuted} />
                      </View>
                    )}
                    <LinearGradient colors={['transparent', 'rgba(7,9,15,0.95)']} style={styles.movieOverlay}>
                      <Text style={styles.movieTitle} numberOfLines={2}>{item.title}</Text>
                      <View style={styles.movieMetaRow}>
                        <MaterialIcons name="play-circle" size={14} color={StreamingTheme.colors.accentAlt} />
                        <Text style={styles.movieMeta}>Offline</Text>
                      </View>
                    </LinearGradient>
                    <TouchableOpacity style={styles.deleteBtn} onPress={() => onDelete(item)}>
                      <MaterialIcons name="delete-outline" size={16} color={StreamingTheme.colors.textPrimary} />
                    </TouchableOpacity>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {seriesGroups.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Séries baixadas</Text>
              {seriesGroups.map((group) => (
                <View key={group.key} style={styles.seriesCard}>
                  <View style={styles.seriesHeader}>
                    {group.image ? (
                      <Image source={{ uri: group.image }} style={styles.seriesCover} cachePolicy="disk" />
                    ) : (
                      <View style={[styles.seriesCover, styles.posterPlaceholder]}>
                        <MaterialIcons name="theaters" size={20} color={StreamingTheme.colors.textMuted} />
                      </View>
                    )}
                    <View style={styles.seriesTitleWrap}>
                      <Text style={styles.seriesTitle}>{group.title}</Text>
                      <Text style={styles.seriesMeta}>{group.episodes.length} episódios offline</Text>
                      <Text style={styles.seriesMeta}>Temporadas: {group.seasons.length || 1} • {formatSize(group.totalSizeBytes)}</Text>
                    </View>
                    <View style={styles.seriesTopActions}>
                      <TouchableOpacity style={styles.seriesActionBtn} onPress={() => setSelectedSeriesKey(group.key)}>
                        <MaterialIcons name="info-outline" size={16} color={StreamingTheme.colors.textPrimary} />
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.seriesActionBtn} onPress={() => onDeleteSeriesGroup(group)}>
                        <MaterialIcons name="delete-outline" size={16} color={StreamingTheme.colors.textPrimary} />
                      </TouchableOpacity>
                    </View>
                  </View>

                  <TouchableOpacity style={styles.seriesDetailsBtn} onPress={() => setSelectedSeriesKey(group.key)}>
                    <MaterialIcons name="list" size={16} color={StreamingTheme.colors.accentAlt} />
                    <Text style={styles.seriesDetailsBtnText}>Ver detalhes dos downloads</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {items.length === 0 && (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>Nenhum download encontrado</Text>
              <Text style={styles.emptyText}>Baixe filmes e episódios nas telas de detalhes para assistir sem internet.</Text>
            </View>
          )}
        </ScrollView>

        <Modal
          visible={!!selectedSeries}
          transparent
          animationType="slide"
          onRequestClose={() => setSelectedSeriesKey('')}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              {selectedSeries ? (
                <>
                  <View style={styles.modalHeader}>
                    <View style={styles.modalTitleWrap}>
                      <Text style={styles.modalTitle}>{selectedSeries.title}</Text>
                      <Text style={styles.modalSubtitle}>
                        {selectedSeries.episodes.length} episódios • {selectedSeries.seasons.length || 1} temporada(s) • {formatSize(selectedSeries.totalSizeBytes)}
                      </Text>
                    </View>
                    <TouchableOpacity style={styles.modalCloseBtn} onPress={() => setSelectedSeriesKey('')}>
                      <MaterialIcons name="close" size={18} color={StreamingTheme.colors.textPrimary} />
                    </TouchableOpacity>
                  </View>

                  <View style={styles.modalHero}>
                    {selectedSeries.image ? (
                      <Image source={{ uri: selectedSeries.image }} style={styles.modalHeroImage} cachePolicy="disk" />
                    ) : (
                      <View style={[styles.modalHeroImage, styles.posterPlaceholder]}>
                        <MaterialIcons name="theaters" size={24} color={StreamingTheme.colors.textMuted} />
                      </View>
                    )}
                    <View style={styles.modalHeroTextWrap}>
                      <Text style={styles.modalHeroDescription}>
                        Conteúdo baixado para modo offline. Toque no episódio para reproduzir sem internet.
                      </Text>
                    </View>
                  </View>

                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.seasonTabs}>
                    {selectedSeries.seasons.map((season) => (
                      <TouchableOpacity
                        key={`season-${season}`}
                        style={[styles.seasonTab, selectedSeason === season && styles.seasonTabActive]}
                        onPress={() => setSelectedSeason(season)}
                      >
                        <Text style={[styles.seasonTabText, selectedSeason === season && styles.seasonTabTextActive]}>
                          Temporada {season}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>

                  <ScrollView style={styles.modalEpisodesList} contentContainerStyle={{ paddingBottom: 12 }}>
                    {filteredSeriesEpisodes.map((episode) => {
                      const pos = getEpisodePosition(episode);
                      return (
                        <TouchableOpacity key={episode.id} style={styles.episodeRow} onPress={() => openDownloaded(episode)}>
                          <View style={styles.episodeBadge}>
                            <Text style={styles.episodeBadgeText}>S{pos.seasonNumber || '-'}E{pos.episodeNumber || '-'}</Text>
                          </View>
                          <View style={styles.episodeMain}>
                            <Text style={styles.episodeTitle} numberOfLines={1}>{episode.title}</Text>
                            <Text style={styles.episodeMeta}>{episode.subtitle || `Temporada ${pos.seasonNumber} Episódio ${pos.episodeNumber}`}</Text>
                          </View>
                          <TouchableOpacity style={styles.episodeDeleteBtn} onPress={() => onDelete(episode)}>
                            <MaterialIcons name="delete-outline" size={16} color={StreamingTheme.colors.textPrimary} />
                          </TouchableOpacity>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </>
              ) : null}
            </View>
          </View>
        </Modal>
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
  summaryStatsRow: {
    marginTop: 10,
    flexDirection: 'row',
    gap: 8,
  },
  summaryStatPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    paddingHorizontal: 10,
    minHeight: 30,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  summaryStatText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
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
  horizontalList: {
    flexDirection: 'row',
    gap: 12,
  },
  movieCard: {
    width: 136,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
  },
  moviePoster: {
    width: '100%',
    aspectRatio: 0.67,
    backgroundColor: StreamingTheme.colors.surface,
  },
  posterPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  movieOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  movieTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },
  movieMetaRow: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  movieMeta: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
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
  seriesCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 10,
    marginBottom: 12,
  },
  seriesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  seriesCover: {
    width: 52,
    height: 74,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
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
  seriesTopActions: {
    flexDirection: 'row',
    gap: 6,
  },
  seriesActionBtn: {
    width: 30,
    height: 30,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  seriesDetailsBtn: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,143,58,0.32)',
    backgroundColor: 'rgba(255,143,58,0.12)',
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  seriesDetailsBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 12,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.68)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    maxHeight: '88%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.backgroundSoft,
    padding: 14,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  modalTitleWrap: { flex: 1 },
  modalTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '900',
  },
  modalSubtitle: {
    marginTop: 4,
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
  },
  modalCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalHero: {
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 10,
    flexDirection: 'row',
    gap: 10,
  },
  modalHeroImage: {
    width: 76,
    height: 106,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
  },
  modalHeroTextWrap: {
    flex: 1,
    justifyContent: 'center',
  },
  modalHeroDescription: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  seasonTabs: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    paddingBottom: 2,
  },
  seasonTab: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    minHeight: 32,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  seasonTabActive: {
    borderColor: 'rgba(255,143,58,0.45)',
    backgroundColor: 'rgba(255,143,58,0.16)',
  },
  seasonTabText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  seasonTabTextActive: {
    color: StreamingTheme.colors.textPrimary,
  },
  modalEpisodesList: {
    marginTop: 10,
    maxHeight: 390,
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
  episodeBadge: {
    minWidth: 54,
    minHeight: 28,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  episodeBadgeText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 10,
    fontWeight: '800',
  },
  episodeMain: {
    flex: 1,
  },
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
