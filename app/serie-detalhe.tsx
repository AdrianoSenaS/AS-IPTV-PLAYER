import { MaterialIcons } from '@expo/vector-icons';
import { getDbValue } from '@/services/local-db';
import { Image } from 'expo-image';

import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AddToListModal } from '@/components/add-to-list-modal';
import { PageLoader } from '@/components/page-loader';
import { AppBackdrop } from '@/components/app-backdrop';
import { PlanGateBlur } from '@/components/plan-gate-blur';
import { StreamingTheme } from '@/constants/streaming-theme';
import { usePlanGate } from '@/hooks/use-plan-gate';
import {
  buildSeriesDetailsHash,
  loadCachedContentDetails,
  saveCachedContentDetails,
} from '@/services/content-details-cache';
import { downloadEntireSeries, downloadSeriesEpisode, isItemDownloaded, getDownloadedItemsByContentId, deleteDownloadedItem } from '@/services/downloads';
import { isItemInAnyList, getItemsInAllLists } from '@/services/user-lists';
import { getDemoSeriesInfo, isDemoModeEnabled } from '@/services/demo-mode';
import {
  getEpisodeProgress,
  getSeriesSummary,
  loadSeriesProgressMap,
  SeriesProgressMap,
  updateEpisodeProgress,
} from '@/services/series-progress';
import { saveSeriesPlaylist } from '@/services/series-playlist';
import { coerceDurationMs } from '@/services/media-duration';
import { recordWatchSignal } from '@/services/taste-recommender';
import { hasFeature as subscriptionHasFeature } from '@/services/subscription';
import {
  fetchTmdbContentDetailsByTitle,
  fetchTmdbPersonBio,
  TmdbCastMember,
  TmdbContentDetails,
  TmdbPersonBio,
} from '@/services/tmdb';
import { isContentBlocked } from '@/services/realtime-presence';
import { setGlobalCastState } from '@/services/global-cast-session';

type Episode = {
  seasonNumber: number;
  episodeNumber: number;
  episodeId: string;
  extension: string;
  title: string;
  description: string;
  duration: string;
  durationMs: number;
  image: string;
  releaseDate: string;
};

type SeriesInfoPayload = {
  info?: {
    name?: string;
    cover?: string;
    plot?: string;
    genre?: string;
    releaseDate?: string;
    rating?: string | number;
    backdrop_path?: string[];
  };
  seasons?: Array<any>;
  episodes?: Record<string, Array<any>>;
};

async function getSeriesInfo(seriesId: string) {
  if (await isDemoModeEnabled()) {
    return getDemoSeriesInfo(seriesId);
  }

  const [url, username, password] = await Promise.all([
    getDbValue<string>('url'),
    getDbValue<string>('username'),
    getDbValue<string>('password'),
  ]);

  const endpoint = `${url}/player_api.php?username=${username}&password=${password}&action=get_series_info&series_id=${seriesId}`;
  return (await fetch(endpoint)).json();
}

function normalizeEpisodes(payload: SeriesInfoPayload): Episode[] {
  if (!payload?.episodes || typeof payload.episodes !== 'object') {
    return [];
  }

  const episodes: Episode[] = [];

  Object.entries(payload.episodes).forEach(([season, episodeList]) => {
    const seasonNumber = Number(season);
    episodeList.forEach((ep: any, index: number) => {
      const info = ep?.info || {};
      const episodeNumber = Number(ep?.episode_num ?? index + 1);
      episodes.push({
        seasonNumber,
        episodeNumber,
        episodeId: String(ep?.id || ep?.episode_id || ''),
        extension: String(ep?.container_extension || 'mp4'),
        title: ep?.title || `Episódio ${episodeNumber}`,
        description:
          info?.plot ||
          'Sem descrição detalhada para este episódio no provedor. Toque em assistido para registrar progresso.',
        duration: info?.duration || info?.duration_secs ? `${info?.duration || Math.round((info?.duration_secs || 0) / 60)} min` : 'Duração indisponível',
        durationMs: coerceDurationMs({ text: info?.duration, seconds: info?.duration_secs }),
        image: info?.movie_image || '',
        releaseDate: info?.releasedate || '-',
      });
    });
  });

  return episodes.sort((a, b) =>
    a.seasonNumber === b.seasonNumber
      ? a.episodeNumber - b.episodeNumber
      : a.seasonNumber - b.seasonNumber
  );
}

export default function SerieDetalheScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ seriesId?: string; title?: string; cover?: string; startPositionMs?: string }>();
  const { hasFeature, loading: planLoading } = usePlanGate();
  const tmdbLocked = !planLoading && !hasFeature('tmdb_details');
  const listLocked = !planLoading && !hasFeature('lists');
  const downloadLocked = !planLoading && !hasFeature('downloads');
  const castLocked = !planLoading && !hasFeature('cast_mirror');

  const [isLoading, setIsLoading] = useState(true);
  const [payload, setPayload] = useState<SeriesInfoPayload>({});
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selectedSeason, setSelectedSeason] = useState(1);
  const [progressMap, setProgressMap] = useState<SeriesProgressMap>({});
  const [showAddToList, setShowAddToList] = useState(false);
  const [isDownloadingFullSeries, setIsDownloadingFullSeries] = useState(false);
  const [downloadingEpisodeId, setDownloadingEpisodeId] = useState('');
  const [tmdbDetails, setTmdbDetails] = useState<TmdbContentDetails | null>(null);
  const [selectedActor, setSelectedActor] = useState<TmdbCastMember | null>(null);
  const [selectedActorBio, setSelectedActorBio] = useState<TmdbPersonBio | null>(null);
  const [isLoadingBio, setIsLoadingBio] = useState(false);
  const [isSeriesDownloaded, setIsSeriesDownloaded] = useState(false);
  const [isSeriesInList, setIsSeriesInList] = useState(false);
  const [blockedByParental, setBlockedByParental] = useState(false);
  const [isCastLoading, setIsCastLoading] = useState(false);

  const seriesId = String(params.seriesId || '');
  const incomingStartPositionMs = Math.max(0, Number(params.startPositionMs || 0) || 0);

  useEffect(() => {
    const bootstrap = async () => {
      if (!seriesId) {
        router.back();
        return;
      }

      const blocked = await isContentBlocked(seriesId).catch(() => false);
      setBlockedByParental(blocked);
      if (blocked) { setIsLoading(false); return; }

      const [response, map, cachedDetails] = await Promise.all([
        getSeriesInfo(seriesId),
        loadSeriesProgressMap(),
        loadCachedContentDetails('series', seriesId),
      ]);
      const normalized = normalizeEpisodes(response);
      const summary = getSeriesSummary(map, seriesId);

      setPayload(response || {});
      setEpisodes(normalized);
      setProgressMap(map);
      setSelectedSeason(summary.continueSeason || normalized[0]?.seasonNumber || 1);
      if (cachedDetails?.tmdbDetails) {
        setTmdbDetails(cachedDetails.tmdbDetails);
      }

      setIsLoading(false);

      const titleForTmdb = String(params.title || response?.info?.name || '').trim();
      const yearForTmdb = Number(String(response?.info?.releaseDate || '').slice(0, 4)) || undefined;
      const sourceHash = buildSeriesDetailsHash({
        seriesId,
        title: titleForTmdb,
        releaseDate: response?.info?.releaseDate,
        genre: response?.info?.genre,
        episodesCount: normalized.length,
        seasonsCount: Array.isArray(response?.seasons) ? response.seasons.length : undefined,
        firstEpisodeId: normalized[0]?.episodeId,
        lastEpisodeId: normalized[normalized.length - 1]?.episodeId,
      });

      const shouldRefreshTmdb =
        !!titleForTmdb && (!cachedDetails || cachedDetails.sourceHash !== sourceHash || !cachedDetails.tmdbDetails);

      const canFetchTmdb = await subscriptionHasFeature('tmdb_details');
      if (canFetchTmdb && shouldRefreshTmdb) {
        const fresh = await fetchTmdbContentDetailsByTitle('tv', titleForTmdb, yearForTmdb);
        setTmdbDetails(fresh);
        await saveCachedContentDetails({
          kind: 'series',
          contentId: seriesId,
          sourceHash,
          tmdbDetails: fresh,
          titleHint: titleForTmdb,
          yearHint: yearForTmdb,
        });
      }
    };

    bootstrap();
  }, [seriesId]);

  useEffect(() => {
    let mounted = true;
    const checkStates = async () => {
      if (!seriesId) return;
      const downloaded = await isItemDownloaded(seriesId, 'series-episode');
      const inList = await isItemInAnyList(seriesId, 'series');
      if (mounted) {
        setIsSeriesDownloaded(downloaded);
        setIsSeriesInList(inList);
      }
    };

    checkStates();
    return () => {
      mounted = false;
    };
  }, [seriesId]);

  const seasons = useMemo(() => {
    const set = new Set<number>();
    episodes.forEach((ep) => set.add(ep.seasonNumber));
    return Array.from(set.values()).sort((a, b) => a - b);
  }, [episodes]);

  const filteredEpisodes = useMemo(
    () => episodes.filter((ep) => ep.seasonNumber === selectedSeason),
    [episodes, selectedSeason]
  );

  const summary = useMemo(() => getSeriesSummary(progressMap, seriesId), [progressMap, seriesId]);

  const continueEpisode = useMemo(
    () =>
      episodes.find(
        (ep) => ep.seasonNumber === summary.continueSeason && ep.episodeNumber === summary.continueEpisode
      ),
    [episodes, summary]
  );

  const continueProgress = useMemo(() => {
    if (!continueEpisode) return null;
    return getEpisodeProgress(
      progressMap,
      seriesId,
      continueEpisode.seasonNumber,
      continueEpisode.episodeNumber
    );
  }, [continueEpisode, progressMap, seriesId]);

  const setEpisodeProgress = async (episode: Episode, progress: number) => {
    const next = await updateEpisodeProgress(seriesId, episode.seasonNumber, episode.episodeNumber, progress);
    setProgressMap(next);
    await recordWatchSignal({
      contentId: seriesId,
      type: 'series',
      progressPercent: progress,
      positionMs: 0,
      durationMs: 0,
    });
  };

  const downloadEpisode = async (episode: Episode) => {
    if (downloadLocked) {
      router.push({ pathname: '/assinar', params: { feature: 'downloads' } });
      return;
    }

    try {
      setDownloadingEpisodeId(episode.episodeId);
      await downloadSeriesEpisode({
        seriesId,
        seriesTitle: String(params.title || payload.info?.name || 'Série'),
        image: String(params.cover || payload.info?.cover || ''),
        episodeId: episode.episodeId,
        episodeTitle: episode.title,
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        extension: episode.extension,
      });
      Alert.alert('Download concluído', `O episódio ${episode.title} foi salvo em downloads.`);
    } catch (error: any) {
      Alert.alert('Erro ao baixar', String(error?.message || error || 'Não foi possível baixar este episódio.'));
    } finally {
      setDownloadingEpisodeId('');
    }
  };

  const toggleDownloadSeries = async () => {
    if (downloadLocked) {
      router.push({ pathname: '/assinar', params: { feature: 'downloads' } });
      return;
    }

    try {
      setIsDownloadingFullSeries(true);

      // Se já tem episódios baixados, remove todos
      if (isSeriesDownloaded) {
        const items = await getDownloadedItemsByContentId(seriesId, 'series-episode');
        for (const item of items) {
          await deleteDownloadedItem(item.id);
        }
        setIsSeriesDownloaded(false);
        Alert.alert('Downloads removidos', 'Os episódios foram removidos da lista de downloads.');
        return;
      }

      // Caso contrário, baixa tudo
      await downloadEntireSeries(
        seriesId,
        String(params.title || payload.info?.name || 'Serie'),
        String(params.cover || payload.info?.cover || ''),
        episodes.map((episode) => ({
          episodeId: episode.episodeId,
          title: episode.title,
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
          extension: episode.extension,
        }))
      );
      setIsSeriesDownloaded(true);
      Alert.alert('Série baixada', 'Todos os episódios disponíveis foram enviados para downloads.');
    } catch (error: any) {
      Alert.alert('Erro ao baixar', String(error?.message || error || 'Não foi possível baixar a série completa.'));
    } finally {
      setIsDownloadingFullSeries(false);
    }
  };

  const openActorBio = async (actor: TmdbCastMember) => {
    try {
      setSelectedActor(actor);
      setSelectedActorBio(null);
      setIsLoadingBio(true);
      setSelectedActorBio(await fetchTmdbPersonBio(actor.id));
    } finally {
      setIsLoadingBio(false);
    }
  };

  const seriesTitle = String(params.title || payload.info?.name || 'Série');
  const seriesCover = String(params.cover || payload.info?.cover || '');
  const seriesGenres = tmdbDetails?.genres?.length
    ? tmdbDetails.genres.join(', ')
    : String(payload.info?.genre || 'Gênero');
  const seriesRating =
    typeof tmdbDetails?.rating === 'number'
      ? String(tmdbDetails.rating)
      : String(payload.info?.rating || 'N/A');
  const seriesOverview =
    tmdbDetails?.overview ||
    payload.info?.plot ||
    'Descrição completa não informada pelo provedor. Use as temporadas abaixo para navegar pelos episódios.';

  const openEpisodePlayer = async (episode: Episode) => {
    if (blockedByParental) {
      Alert.alert('Conteúdo bloqueado', 'Esta série está bloqueada no controle parental. Desbloqueie no monitor parental para assistir novamente.');
      return;
    }
    const seasonEpisodes = episodes
      .filter((item) => item.seasonNumber === episode.seasonNumber)
      .map((item) => ({
        title: item.title,
        episodeId: item.episodeId,
        extension: item.extension || 'mp4',
        seasonNumber: item.seasonNumber,
        episodeNumber: item.episodeNumber,
        durationMs: item.durationMs || 0,
      }))
      .filter((item) => !!item.episodeId);

    const playlistKey = `series_playlist_${seriesId}_${episode.seasonNumber}`;
    await saveSeriesPlaylist(playlistKey, seasonEpisodes);

    const index = seasonEpisodes.findIndex((item) => item.episodeNumber === episode.episodeNumber);
    if (index < 0) {
      return;
    }

    router.navigate({
      pathname: '/player',
      params: {
        mode: 'series',
        seriesId,
        title: `${String(params.title || payload.info?.name || 'Série')} - ${episode.title}`,
        playlistKey,
        playlistIndex: String(index),
        startPositionMs: String(
          getEpisodeProgress(progressMap, seriesId, episode.seasonNumber, episode.episodeNumber)?.positionMs || 0
        ),
      },
    });
  };

  const requestCastDirectForSeries = async () => {
    if (!continueEpisode) {
      Alert.alert('Erro', 'Nenhum episódio selecionado para transmissão');
      return;
    }
    if (castLocked) {
      router.push({ pathname: '/assinar', params: { feature: 'cast_mirror' } });
      return;
    }
    if (blockedByParental) {
      Alert.alert('Conteúdo bloqueado', 'Esta série está bloqueada no controle parental. Desbloqueie no monitor parental para assistir novamente.');
      return;
    }

    setIsCastLoading(true);

    try {
      const title = `${String(params.title || payload.info?.name || 'Serie')} - ${continueEpisode.title}`;
      const seasonEpisodes = episodes
        .filter((item) => item.seasonNumber === continueEpisode.seasonNumber)
        .map((item) => ({
          title: item.title,
          episodeId: item.episodeId,
          extension: item.extension || 'mp4',
          seasonNumber: item.seasonNumber,
          episodeNumber: item.episodeNumber,
          durationMs: item.durationMs || 0,
        }))
        .filter((item) => !!item.episodeId);

      const playlistKey = `series_playlist_${seriesId}_${continueEpisode.seasonNumber}`;
      await saveSeriesPlaylist(playlistKey, seasonEpisodes);

      const index = seasonEpisodes.findIndex((item) => item.episodeNumber === continueEpisode.episodeNumber);
      if (index < 0) {
        setIsCastLoading(false);
        Alert.alert('Erro', 'Não foi possível preparar o episódio para transmissão.');
        return;
      }

      setGlobalCastState({
        isActive: true,
        url: '',
        title,
        subtitle: `S${continueEpisode.seasonNumber} E${continueEpisode.episodeNumber}`,
        mode: 'series',
        contentId: seriesId,
        startPositionMs: continueProgress?.positionMs || incomingStartPositionMs || 0,
      });

      router.navigate({
        pathname: '/player',
        params: {
          mode: 'series',
          seriesId,
          title,
          playlistKey,
          playlistIndex: String(index),
          startPositionMs: String(continueProgress?.positionMs || incomingStartPositionMs || 0),
          castPrep: '1',
        },
      });

      setIsCastLoading(false);
    } catch (error) {
      console.error('[SerieDetalhe] Erro ao iniciar Cast:', error);
      Alert.alert('Erro', 'Falha ao iniciar transmissão');
      setGlobalCastState({ isActive: false, url: '', title: '' });
      setIsCastLoading(false);
    }
  };

  if (blockedByParental) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <AppBackdrop blurIntensity={28} />
        <View style={styles.emptyStateWrap}>
          <MaterialIcons name="block" size={42} color="#EF4444" />
          <Text style={styles.emptyStateTitle}>Conteúdo bloqueado</Text>
          <Text style={styles.emptyStateDesc}>Esta série foi bloqueada pelos responsáveis e está oculta até ser liberada no controle parental.</Text>
          <TouchableOpacity style={styles.backPrimaryBtn} onPress={() => router.back()}>
            <Text style={styles.backPrimaryBtnText}>Voltar</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isLoading} label="Carregando temporada e episódios" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Detalhes da série</Text>
          <View style={styles.iconBtn} />
        </View>

        <View style={styles.heroCard}>
          <Image
            source={{ uri: seriesCover }}
            style={styles.heroPoster}
            cachePolicy="disk"
          />
          <View style={styles.heroInfo}>
            <Text style={styles.seriesTitle}>{seriesTitle}</Text>
            <Text style={styles.seriesMeta}>
              {seriesGenres} • Nota {seriesRating}
            </Text>
            <Text style={styles.seriesDescription}>{seriesOverview}</Text>
          </View>
        </View>

        <PlanGateBlur feature="tmdb_details" locked={tmdbLocked} style={styles.detailsCard}>
          <View>
            <Text style={styles.detailsLine}>Jornadas: {tmdbDetails?.seasons || '-'} temporadas • {tmdbDetails?.episodes || '-'} episódios</Text>
            <Text style={styles.detailsLine}>Direção: {tmdbDetails?.director || '-'}</Text>
            <Text style={styles.detailsLine}>Lançamento: {tmdbDetails?.releaseDate || String(payload.info?.releaseDate || '-')}</Text>
          </View>
        </PlanGateBlur>

        <View style={styles.resumeCard}>
          <Text style={styles.resumeTitle}>Continuar de onde parou</Text>
          <Text style={styles.resumeText}>
            {continueEpisode
              ? `S${continueEpisode.seasonNumber} • E${continueEpisode.episodeNumber} - ${continueEpisode.title}`
              : `S${summary.lastSeason} • E${summary.lastEpisode}`}
          </Text>
          <Text style={styles.resumeStats}>
            Assistidos: {summary.watchedCount} • Progresso médio: {summary.averageProgress}%
          </Text>
          {!!continueProgress?.positionMs && (
            <Text style={styles.resumeStats}>
              Retomar em {Math.floor(continueProgress.positionMs / 60000)} min
            </Text>
          )}
          <TouchableOpacity
            style={styles.resumeButton}
            onPress={() => {
              if (continueEpisode) {
                openEpisodePlayer(continueEpisode);
                return;
              }
              setSelectedSeason(summary.continueSeason || 1);
            }}
          >
            <MaterialIcons name="play-arrow" size={18} color={StreamingTheme.colors.textPrimary} />
            <Text style={styles.resumeButtonText}>
              {continueEpisode ? 'Continuar episódio' : 'Abrir temporada atual'}
            </Text>
          </TouchableOpacity>

          {!castLocked && !!continueEpisode && (
            <TouchableOpacity
              style={[styles.castBtn, isCastLoading && { opacity: 0.6 }]}
              onPress={requestCastDirectForSeries}
              disabled={isCastLoading}>
              {isCastLoading ? (
                <ActivityIndicator size="small" color={StreamingTheme.colors.textPrimary} />
              ) : (
                <MaterialIcons name="cast" size={18} color={StreamingTheme.colors.textPrimary} />
              )}
              <Text style={styles.castText}>{isCastLoading ? 'Conectando...' : 'Espelhar pra TV'}</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[styles.addListBtn, listLocked && styles.ctaLockedBtn]}
            onPress={() => {
              if (listLocked) {
                router.push({ pathname: '/assinar', params: { feature: 'lists' } });
                return;
              }
              setShowAddToList(true);
            }}>
            <MaterialIcons
              name={listLocked ? 'workspace-premium' : 'playlist-add'}
              size={20}
              color={StreamingTheme.colors.textPrimary}
            />
            <Text style={styles.addListText}>{listLocked ? 'Listas Premium' : 'Adicionar série à lista'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.downloadSeriesBtn, downloadLocked && styles.ctaLockedBtn]}
            onPress={toggleDownloadSeries}
            disabled={isDownloadingFullSeries && !downloadLocked}>
            <MaterialIcons
              name={downloadLocked ? 'workspace-premium' : isSeriesDownloaded ? 'delete-outline' : 'download'}
              size={20}
              color={StreamingTheme.colors.textPrimary}
            />
            <Text style={styles.downloadSeriesText}>
              {downloadLocked
                ? 'Download Premium'
                : isDownloadingFullSeries
                ? isSeriesDownloaded
                  ? 'Removendo...'
                  : 'Baixando série...'
                : isSeriesDownloaded
                ? 'Remover downloads'
                : 'Baixar série completa'}
            </Text>
          </TouchableOpacity>
        </View>

        <PlanGateBlur feature="tmdb_details" locked={tmdbLocked} style={styles.castSection}>
          <View>
            <Text style={styles.sectionTitle}>Elenco & Detalhes TMDB</Text>
            {tmdbDetails?.cast?.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.castRow}>
                {tmdbDetails.cast.map((actor) => (
                  <TouchableOpacity key={actor.id} style={styles.castCard} onPress={() => !tmdbLocked && openActorBio(actor)}>
                    {actor.profileUrl ? (
                      <Image source={{ uri: actor.profileUrl }} style={styles.castPhoto} cachePolicy="disk" />
                    ) : (
                      <View style={[styles.castPhoto, styles.castPhotoFallback]}>
                        <MaterialIcons name="person" size={28} color={StreamingTheme.colors.textMuted} />
                      </View>
                    )}
                    <Text style={styles.castName} numberOfLines={2}>{actor.name}</Text>
                    <Text style={styles.castRole} numberOfLines={2}>{actor.character || '-'}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            ) : (
              <Text style={styles.seriesDescription}>Elenco completo disponível para assinantes.</Text>
            )}
          </View>
        </PlanGateBlur>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.seasonsRow}>
          {seasons.map((season) => {
            const active = season === selectedSeason;
            return (
              <TouchableOpacity
                key={season}
                style={[styles.seasonChip, active && styles.seasonChipActive]}
                onPress={() => setSelectedSeason(season)}
              >
                <Text style={[styles.seasonChipText, active && styles.seasonChipTextActive]}>
                  Temporada {season}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <FlatList
          data={filteredEpisodes}
          keyExtractor={(item) => `${item.seasonNumber}-${item.episodeNumber}`}
          scrollEnabled={false}
          removeClippedSubviews
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={7}
          updateCellsBatchingPeriod={40}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.episodeList}
          renderItem={({ item }) => {
            const progress = getEpisodeProgress(progressMap, seriesId, item.seasonNumber, item.episodeNumber);
            const pct = progress?.progress || 0;
            const watched = progress?.watched || false;

            return (
              <View style={styles.episodeCard}>
                <View style={styles.episodeTop}>
                  <Image
                    source={{ uri: item.image || String(params.cover || payload.info?.cover || '') }}
                    style={styles.episodeThumb}
                    cachePolicy="disk"
                  />
                  <View style={styles.episodeMain}>
                    <View style={styles.episodeTitleRow}>
                      <Text style={styles.episodeTitle}>
                        E{item.episodeNumber} • {item.title}
                      </Text>
                      {watched && <MaterialIcons name="check-circle" size={18} color={StreamingTheme.colors.success} />}
                    </View>

                    <Text style={styles.episodeMeta}>
                      {item.duration} • Lançamento: {item.releaseDate}
                    </Text>
                    <Text style={styles.episodeDescription}>{item.description}</Text>

                    <View style={styles.progressTrack}>
                      <View style={[styles.progressFill, { width: `${pct}%` }]} />
                    </View>
                    <Text style={styles.progressLabel}>Progresso: {pct}%</Text>
                  </View>
                </View>

                <View style={styles.actionsRow}>
                  <ActionButton label="Assistir episódio" strong onPress={() => openEpisodePlayer(item)} />
                  <ActionButton label="25%" onPress={() => setEpisodeProgress(item, 25)} />
                  <ActionButton label="50%" onPress={() => setEpisodeProgress(item, 50)} />
                  <ActionButton label="75%" onPress={() => setEpisodeProgress(item, 75)} />
                  <ActionButton label="Assistido" onPress={() => setEpisodeProgress(item, 100)} />
                  <ActionButton label="Reset" onPress={() => setEpisodeProgress(item, 0)} />
                </View>

                <TouchableOpacity
                  style={[styles.downloadEpisodeBtn, downloadLocked && styles.ctaLockedBtn]}
                  onPress={() => downloadEpisode(item)}
                  disabled={downloadingEpisodeId === item.episodeId && !downloadLocked}>
                  <MaterialIcons
                    name={downloadLocked ? 'workspace-premium' : 'download'}
                    size={18}
                    color={StreamingTheme.colors.textPrimary}
                  />
                  <Text style={styles.downloadEpisodeText}>
                    {downloadLocked
                      ? 'Download Premium'
                      : downloadingEpisodeId === item.episodeId
                        ? 'Baixando episódio...'
                        : 'Baixar episódio'}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          }}
        />
      </ScrollView>

      <AddToListModal
        visible={showAddToList}
        onClose={() => setShowAddToList(false)}
        item={{
          type: 'series',
          contentId: seriesId,
          title: seriesTitle,
          subtitle: String(payload.info?.genre || 'Série'),
          image: seriesCover,
        }}
      />

      <Modal
        visible={!!selectedActor}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setSelectedActor(null);
          setSelectedActorBio(null);
        }}
      >
        <View style={styles.bioBackdrop}>
          <View style={styles.bioModal}>
            <View style={styles.bioHeader}>
              <Text style={styles.bioTitle}>Biografia</Text>
              <TouchableOpacity
                style={styles.bioCloseBtn}
                onPress={() => {
                  setSelectedActor(null);
                  setSelectedActorBio(null);
                }}
              >
                <MaterialIcons name="close" size={18} color={StreamingTheme.colors.textPrimary} />
              </TouchableOpacity>
            </View>

            {isLoadingBio ? (
              <View style={styles.bioLoadingWrap}>
                <ActivityIndicator color={StreamingTheme.colors.accentAlt} />
                <Text style={styles.bioLoadingText}>Carregando biografia...</Text>
              </View>
            ) : (
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.bioContent}>
                <Text style={styles.bioActorName}>{selectedActorBio?.name || selectedActor?.name}</Text>
                <Text style={styles.bioMeta}>
                  {selectedActorBio?.knownForDepartment || selectedActor?.knownForDepartment || 'Atuação'}
                </Text>
                {!!selectedActorBio?.birthday && (
                  <Text style={styles.bioMeta}>Nascimento: {selectedActorBio.birthday}</Text>
                )}
                {!!selectedActorBio?.placeOfBirth && (
                  <Text style={styles.bioMeta}>Origem: {selectedActorBio.placeOfBirth}</Text>
                )}
                <Text style={styles.bioText}>
                  {selectedActorBio?.biography || 'Biografia não informada para este ator.'}
                </Text>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function ActionButton({
  label,
  onPress,
  strong,
}: {
  label: string;
  onPress: () => void;
  strong?: boolean;
}) {
  return (
    <TouchableOpacity style={[styles.actionBtn, strong && styles.actionBtnStrong]} onPress={onPress}>
      <Text style={[styles.actionText, strong && styles.actionTextStrong]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },
  emptyStateWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 10 },
  emptyStateTitle: { color: StreamingTheme.colors.textPrimary, fontSize: 20, fontWeight: '800' },
  emptyStateDesc: { color: StreamingTheme.colors.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  backPrimaryBtn: { marginTop: 8, minHeight: 38, borderRadius: 10, backgroundColor: StreamingTheme.colors.accent, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  backPrimaryBtnText: { color: StreamingTheme.colors.textPrimary, fontWeight: '800', fontSize: 13 },
  content: { padding: 16, paddingBottom: 120 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
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
  headerTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 18,
  },
  heroCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 12,
    flexDirection: 'row',
    gap: 12,
  },
  heroPoster: {
    width: 110,
    height: 160,
    borderRadius: 10,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
  },
  heroInfo: {
    flex: 1,
  },
  seriesTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '900',
  },
  seriesMeta: {
    marginTop: 4,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
  },
  seriesDescription: {
    marginTop: 8,
    color: StreamingTheme.colors.textSecondary,
    lineHeight: 22,
    fontSize: 14,
  },
  detailsCard: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 14,
    gap: 8,
  },
  detailsLine: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  castSection: {
    marginTop: 12,
    gap: 8,
  },
  castRow: {
    gap: 12,
    paddingRight: 10,
    paddingVertical: 4,
  },
  castCard: {
    width: 156,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 12,
  },
  castPhoto: {
    width: '100%',
    height: 186,
    borderRadius: 10,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
  },
  castPhotoFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  castName: {
    marginTop: 8,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
    lineHeight: 19,
  },
  castRole: {
    marginTop: 4,
    color: StreamingTheme.colors.textMuted,
    fontSize: 13,
    lineHeight: 17,
  },
  resumeCard: {
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,59,48,0.16)',
    padding: 12,
  },
  resumeTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
  },
  sectionTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 17,
  },
  resumeText: {
    marginTop: 4,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
  },
  resumeStats: {
    marginTop: 4,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
  },
  resumeButton: {
    marginTop: 10,
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  resumeButtonText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 12,
  },
  castBtn: {
    marginTop: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  castText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
  },
  addListBtn: {
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  addListText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 13,
  },
  downloadSeriesBtn: {
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(46,204,113,0.45)',
    backgroundColor: 'rgba(46,204,113,0.18)',
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  downloadSeriesText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 13,
  },
  seasonsRow: {
    paddingTop: 12,
    gap: 8,
  },
  seasonChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  seasonChipActive: {
    backgroundColor: 'rgba(255,59,48,0.25)',
    borderColor: 'rgba(255,59,48,0.45)',
  },
  seasonChipText: {
    color: StreamingTheme.colors.textSecondary,
    fontWeight: '700',
    fontSize: 12,
  },
  seasonChipTextActive: {
    color: StreamingTheme.colors.textPrimary,
  },
  episodeList: {
    paddingTop: 12,
    gap: 10,
  },
  episodeCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 10,
  },
  episodeTop: {
    flexDirection: 'row',
    gap: 10,
  },
  episodeThumb: {
    width: 86,
    height: 86,
    borderRadius: 10,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
  },
  episodeMain: {
    flex: 1,
  },
  episodeTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
  },
  episodeTitle: {
    flex: 1,
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 14,
  },
  episodeMeta: {
    marginTop: 3,
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  episodeDescription: {
    marginTop: 5,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  progressTrack: {
    marginTop: 8,
    height: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: StreamingTheme.colors.accent,
  },
  progressLabel: {
    marginTop: 4,
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  actionsRow: {
    marginTop: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  downloadEpisodeBtn: {
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(46,204,113,0.45)',
    backgroundColor: 'rgba(46,204,113,0.16)',
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  downloadEpisodeText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 12,
  },
  ctaLockedBtn: {
    borderColor: 'rgba(255,159,67,0.6)',
    backgroundColor: 'rgba(255,159,67,0.22)',
  },
  actionBtn: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
  },
  actionBtnStrong: {
    width: '100%',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,59,48,0.24)',
    borderColor: 'rgba(255,59,48,0.45)',
  },
  actionText: {
    color: StreamingTheme.colors.textSecondary,
    fontWeight: '700',
    fontSize: 11,
  },
  actionTextStrong: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
  },
  bioBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.64)',
    padding: 18,
    justifyContent: 'center',
  },
  bioModal: {
    maxHeight: '72%',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 12,
  },
  bioHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  bioTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '900',
    fontSize: 16,
  },
  bioCloseBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bioLoadingWrap: {
    paddingVertical: 30,
    alignItems: 'center',
    gap: 8,
  },
  bioLoadingText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
  },
  bioContent: {
    paddingTop: 10,
    paddingBottom: 6,
    gap: 6,
  },
  bioActorName: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '900',
    fontSize: 18,
  },
  bioMeta: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
  },
  bioText: {
    marginTop: 6,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 20,
  },
});
