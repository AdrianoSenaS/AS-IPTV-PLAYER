import { MaterialIcons } from '@expo/vector-icons';
import { getDbValue } from '@/services/local-db';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
  Alert,
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
  buildMovieDetailsHash,
  loadCachedContentDetails,
  saveCachedContentDetails,
} from '@/services/content-details-cache';
import { downloadMovie } from '@/services/downloads';
import { getDemoVodInfo, isDemoModeEnabled } from '@/services/demo-mode';
import { getMovieProgress, loadMovieProgressMap, MovieProgressMap } from '@/services/movie-progress';
import { buildMovieUrl } from '@/services/stream-url';
import { loadCatalogData, sanitizeLabelText, StreamItem, toText } from '@/services/catalog-data';
import { hasFeature as subscriptionHasFeature } from '@/services/subscription';
import {
  fetchTmdbContentDetailsByTitle,
  fetchTmdbPersonBio,
  TmdbCastMember,
  TmdbContentDetails,
  TmdbPersonBio,
} from '@/services/tmdb';

type VodInfoPayload = {
  info?: {
    name?: string;
    o_name?: string;
    plot?: string;
    duration?: string;
    movie_image?: string;
    rating?: string | number;
    genre?: string;
    year?: string;
    cast?: string;
    director?: string;
    releasedate?: string;
  };
};

async function getVodInfo(vodId: string): Promise<VodInfoPayload> {
  if (await isDemoModeEnabled()) {
    return getDemoVodInfo(vodId);
  }

  const [url, username, password] = await Promise.all([
    getDbValue<string>('url'),
    getDbValue<string>('username'),
    getDbValue<string>('password'),
  ]);

  if (!url || !username || !password || !vodId) {
    return {};
  }

  const endpoint = `${url}/player_api.php?username=${username}&password=${password}&action=get_vod_info&vod_id=${vodId}`;
  return (await fetch(endpoint)).json();
}

export default function FilmeDetalheScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ streamId?: string }>();

  const { hasFeature, loading: planLoading } = usePlanGate();
  const tmdbLocked = !planLoading && !hasFeature('tmdb_details');
  const listLocked = !planLoading && !hasFeature('lists');
  const downloadLocked = !planLoading && !hasFeature('downloads');

  const [isLoading, setIsLoading] = useState(true);
  const [movie, setMovie] = useState<StreamItem | null>(null);
  const [allMovies, setAllMovies] = useState<StreamItem[]>([]);
  const [vodInfo, setVodInfo] = useState<VodInfoPayload>({});
  const [progressMap, setProgressMap] = useState<MovieProgressMap>({});
  const [showAddToList, setShowAddToList] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [tmdbDetails, setTmdbDetails] = useState<TmdbContentDetails | null>(null);
  const [selectedActor, setSelectedActor] = useState<TmdbCastMember | null>(null);
  const [selectedActorBio, setSelectedActorBio] = useState<TmdbPersonBio | null>(null);
  const [isLoadingBio, setIsLoadingBio] = useState(false);

  const streamId = String(params.streamId || '');

  useEffect(() => {
    const bootstrap = async () => {
      if (!streamId) {
        router.back();
        return;
      }

      const [{ vod }, info, map, cachedDetails] = await Promise.all([
        loadCatalogData(),
        getVodInfo(streamId),
        loadMovieProgressMap(),
        loadCachedContentDetails('movie', streamId),
      ]);
      const foundMovie = vod.find((item) => String(item.stream_id) === streamId) || null;

      setMovie(foundMovie);
      setAllMovies(vod);
      setVodInfo(info || {});
      setProgressMap(map);
      if (cachedDetails?.tmdbDetails) {
        setTmdbDetails(cachedDetails.tmdbDetails);
      }

      setIsLoading(false);

      const titleForTmdb = sanitizeLabelText(
        info?.info?.name || foundMovie?.title || foundMovie?.name,
        ''
      );
      const yearForTmdb = Number(String(info?.info?.year || '').slice(0, 4)) || undefined;
      const sourceHash = buildMovieDetailsHash({
        streamId,
        title: titleForTmdb,
        year: info?.info?.year,
        genre: info?.info?.genre || foundMovie?.genre,
        duration: info?.info?.duration || foundMovie?.duration,
        plot: info?.info?.plot || foundMovie?.plot,
        releaseDate: info?.info?.releasedate || foundMovie?.release_date,
        cast: info?.info?.cast,
      });

      const shouldRefreshTmdb =
        !!titleForTmdb && (!cachedDetails || cachedDetails.sourceHash !== sourceHash || !cachedDetails.tmdbDetails);

      const canFetchTmdb = await subscriptionHasFeature('tmdb_details');
      if (canFetchTmdb && shouldRefreshTmdb) {
        const fresh = await fetchTmdbContentDetailsByTitle('movie', titleForTmdb, yearForTmdb);
        setTmdbDetails(fresh);
        await saveCachedContentDetails({
          kind: 'movie',
          contentId: streamId,
          sourceHash,
          tmdbDetails: fresh,
          titleHint: titleForTmdb,
          yearHint: yearForTmdb,
        });
      }
    };

    bootstrap();
  }, [streamId]);

  useFocusEffect(
    React.useCallback(() => {
      let mounted = true;
      const refreshProgress = async () => {
        const map = await loadMovieProgressMap();
        if (mounted) {
          setProgressMap(map);
        }
      };

      refreshProgress();

      return () => {
        mounted = false;
      };
    }, [])
  );

  const movieProgress = useMemo(() => getMovieProgress(progressMap, streamId), [progressMap, streamId]);

  const relatedMovies = useMemo(() => {
    if (!movie || !allMovies.length) return [];

    const rawGenre = toText(vodInfo.info?.genre || movie.genre).toLowerCase();
    const genreTokens = rawGenre
      .split(/[\/,|;-]/g)
      .map((part) => part.trim())
      .filter(Boolean);
    const categoryId = toText(movie.category_id);

    const scored = allMovies
      .filter((item) => String(item.stream_id) !== streamId)
      .map((item) => {
        let score = 0;
        const itemGenre = toText(item.genre).toLowerCase();
        if (genreTokens.length && genreTokens.some((token) => itemGenre.includes(token))) {
          score += 2;
        }
        if (categoryId && toText(item.category_id) === categoryId) {
          score += 1;
        }
        return { item, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((entry) => entry.item);

    return scored;
  }, [movie, allMovies, vodInfo.info?.genre, streamId]);

  const openPlayer = async () => {
    if (!movie) return;

    const url = await buildMovieUrl(movie);
    if (!url) return;

    router.navigate({
      pathname: '/player',
      params: {
        mode: 'movie',
        contentId: streamId,
        title: sanitizeLabelText(vodInfo.info?.name || movie.title || movie.name, 'Filme'),
        url,
        startPositionMs: String(movieProgress?.positionMs || 0),
      },
    });
  };

  const openMovieDetails = (nextMovie: StreamItem) => {
    const nextId = toText(nextMovie.stream_id);
    if (!nextId) return;
    router.push(`/filme-detalhe?streamId=${encodeURIComponent(nextId)}` as any);
  };

  const downloadCurrentMovie = async () => {
    if (!movie) return;

    if (downloadLocked) {
      router.push({ pathname: '/assinar', params: { feature: 'downloads' } });
      return;
    }

    try {
      setIsDownloading(true);
      const url = await buildMovieUrl(movie);
      if (!url) {
        Alert.alert('Download indisponivel', 'Nao foi possivel resolver a URL do filme.');
        return;
      }

      await downloadMovie({
        contentId: streamId,
        title,
        image: cover,
        sourceUrl: url,
      });
      Alert.alert('Download concluido', 'O filme foi salvo na tela de downloads.');
    } catch (error: any) {
      Alert.alert('Erro ao baixar', String(error?.message || error || 'Nao foi possivel baixar o filme.'));
    } finally {
      setIsDownloading(false);
    }
  };

  const title = sanitizeLabelText(vodInfo.info?.name || movie?.title || movie?.name, 'Filme');
  const cover = toText(vodInfo.info?.movie_image || movie?.stream_icon || movie?.cover);
  const description = toText(
    tmdbDetails?.overview || vodInfo.info?.plot || movie?.plot,
    'Descricao indisponivel para este conteudo no provedor.'
  );
  const duration =
    tmdbDetails?.runtimeMinutes
      ? `${tmdbDetails.runtimeMinutes} min`
      : toText(vodInfo.info?.duration || movie?.duration, 'Duracao indisponivel');
  const rating =
    typeof tmdbDetails?.rating === 'number'
      ? String(tmdbDetails.rating)
      : toText(vodInfo.info?.rating || movie?.rating, 'N/A');
  const genre =
    tmdbDetails?.genres?.length
      ? tmdbDetails.genres.join(', ')
      : toText(vodInfo.info?.genre || movie?.genre, 'Genero nao informado');
  const castText = tmdbDetails?.cast?.length
    ? tmdbDetails.cast.slice(0, 5).map((person) => person.name).join(', ')
    : toText(vodInfo.info?.cast, '-');

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

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isLoading} label="Carregando detalhes do filme" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Detalhes do filme</Text>
          <View style={styles.iconBtn} />
        </View>

        <View style={styles.heroCard}>
          <Image source={{ uri: cover }} style={styles.poster} cachePolicy="disk" />
          <View style={styles.heroInfo}>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.meta}>{genre}</Text>
            <View style={styles.ratingRow}>
              <MaterialIcons name="star" size={16} color={StreamingTheme.colors.warning} />
              <Text style={styles.ratingText}>{rating}</Text>
            </View>
            <Text style={styles.duration}>Duracao: {duration}</Text>
          </View>
        </View>

        <View style={styles.summaryCard}>
          <Text style={styles.sectionTitle}>Sinopse</Text>
          <Text style={styles.description}>{description}</Text>

          <View style={styles.infoGrid}>
            <Info label="Ano" value={toText(vodInfo.info?.year || (movie as any)?.year, '-')} />
            <Info label="Direcao" value={toText(tmdbDetails?.director || vodInfo.info?.director, '-')} />
            <Info label="Elenco" value={castText} />
            <Info label="Lancamento" value={toText(vodInfo.info?.releasedate, '-')} />
          </View>
        </View>

        <View style={styles.progressCard}>
          <Text style={styles.sectionTitle}>Continuar assistindo</Text>
          <Text style={styles.progressText}>
            {movieProgress
              ? `Voce parou em ${movieProgress.progressPercent}% (${Math.floor(movieProgress.positionMs / 60000)} min).`
              : 'Voce ainda nao iniciou este filme.'}
          </Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${movieProgress?.progressPercent || 0}%` }]} />
          </View>

          <TouchableOpacity style={styles.playBtn} onPress={openPlayer}>
            <MaterialIcons name="play-arrow" size={22} color={StreamingTheme.colors.textPrimary} />
            <Text style={styles.playText}>{movieProgress ? 'Continuar de onde parou' : 'Assistir agora'}</Text>
          </TouchableOpacity>

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
            <Text style={styles.addListText}>{listLocked ? 'Listas Premium' : 'Adicionar a lista'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.downloadBtn, downloadLocked && styles.ctaLockedBtn]}
            onPress={downloadCurrentMovie}
            disabled={isDownloading && !downloadLocked}>
            <MaterialIcons
              name={downloadLocked ? 'workspace-premium' : 'download'}
              size={20}
              color={StreamingTheme.colors.textPrimary}
            />
            <Text style={styles.downloadText}>
              {downloadLocked ? 'Download Premium' : isDownloading ? 'Baixando...' : 'Baixar filme'}
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
              <Text style={styles.description}>Elenco completo disponível para assinantes.</Text>
            )}
          </View>
        </PlanGateBlur>

        {relatedMovies.length > 0 && (
          <View style={styles.relatedSection}>
            <Text style={styles.sectionTitle}>Filmes relacionados</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.relatedList}>
              {relatedMovies.map((item) => {
                const relatedProgress = getMovieProgress(progressMap, toText(item.stream_id));
                const badgeTone = getProgressBadgeTone(relatedProgress?.progressPercent || 0);

                return (
                  <TouchableOpacity
                    key={toText(item.stream_id)}
                    style={styles.relatedCard}
                    onPress={() => openMovieDetails(item)}>
                    <Image
                      source={{ uri: toText(item.stream_icon || item.cover) }}
                      style={styles.relatedPoster}
                      cachePolicy="disk"
                    />
                    {relatedProgress && (
                      <View style={[styles.relatedProgressBadge, badgeTone]}>
                        <Text style={styles.relatedProgressText}>{relatedProgress.progressPercent}%</Text>
                      </View>
                    )}
                    <Text style={styles.relatedTitle} numberOfLines={2}>
                      {sanitizeLabelText(item.title || item.name, 'Sem titulo')}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}
      </ScrollView>

      {movie && (
        <AddToListModal
          visible={showAddToList}
          onClose={() => setShowAddToList(false)}
          item={{
            type: 'movie',
            contentId: streamId,
            title,
            subtitle: genre,
            image: cover,
          }}
        />
      )}

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
                  {selectedActorBio?.knownForDepartment || selectedActor?.knownForDepartment || 'Atuacao'}
                </Text>
                {!!selectedActorBio?.birthday && (
                  <Text style={styles.bioMeta}>Nascimento: {selectedActorBio.birthday}</Text>
                )}
                {!!selectedActorBio?.placeOfBirth && (
                  <Text style={styles.bioMeta}>Origem: {selectedActorBio.placeOfBirth}</Text>
                )}
                <Text style={styles.bioText}>
                  {selectedActorBio?.biography || 'Biografia nao informada para este ator.'}
                </Text>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoItem}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} numberOfLines={2}>{value}</Text>
    </View>
  );
}

function getProgressBadgeTone(progressPercent: number) {
  if (progressPercent < 30) {
    return {
      backgroundColor: 'rgba(255,107,0,0.82)',
      borderColor: 'rgba(255,184,108,0.95)',
    };
  }

  if (progressPercent <= 80) {
    return {
      backgroundColor: 'rgba(30,144,255,0.82)',
      borderColor: 'rgba(138,199,255,0.95)',
    };
  }

  return {
    backgroundColor: 'rgba(46,204,113,0.82)',
    borderColor: 'rgba(132,255,187,0.95)',
  };
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },
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
    fontSize: 18,
    fontWeight: '800',
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
  poster: {
    width: 122,
    height: 182,
    borderRadius: 10,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
  },
  heroInfo: { flex: 1 },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 22,
    fontWeight: '900',
  },
  meta: {
    marginTop: 4,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
  },
  ratingRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  ratingText: {
    color: StreamingTheme.colors.warning,
    fontWeight: '800',
  },
  duration: {
    marginTop: 10,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  summaryCard: {
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 12,
    gap: 8,
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
  sectionTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 17,
  },
  description: {
    color: StreamingTheme.colors.textSecondary,
    lineHeight: 22,
    fontSize: 14,
  },
  infoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  infoItem: {
    width: '48%',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    padding: 10,
  },
  infoLabel: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  infoValue: {
    marginTop: 4,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    lineHeight: 18,
  },
  progressCard: {
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,59,48,0.14)',
    padding: 12,
    gap: 8,
  },
  progressText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
  },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.2)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: StreamingTheme.colors.accent,
  },
  playBtn: {
    marginTop: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,59,48,0.5)',
    backgroundColor: 'rgba(255,59,48,0.24)',
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  playText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  addListBtn: {
    marginTop: 6,
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
    fontSize: 13,
    fontWeight: '800',
  },
  downloadBtn: {
    marginTop: 6,
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
  downloadText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
  },
  ctaLockedBtn: {
    borderColor: 'rgba(255,159,67,0.6)',
    backgroundColor: 'rgba(255,159,67,0.22)',
  },
  relatedSection: {
    marginTop: 12,
    gap: 10,
  },
  relatedList: {
    gap: 10,
    paddingRight: 8,
  },
  relatedCard: {
    width: 124,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 6,
  },
  relatedPoster: {
    width: '100%',
    height: 160,
    borderRadius: 8,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
  },
  relatedTitle: {
    marginTop: 6,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 16,
  },
  relatedProgressBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  relatedProgressText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 11,
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
