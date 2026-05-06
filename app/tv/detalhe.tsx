import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import {
  FlatList,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  findNodeHandle,
  View,
} from 'react-native';

import { AppBackdrop } from '@/components/app-backdrop';
import { StreamingTheme } from '@/constants/streaming-theme';
import { StreamItem, toText, queryCatalogItemsByIds } from '@/services/catalog-data';
import { getDbValue } from '@/services/local-db';
import { getMovieProgress, loadMovieProgressMap } from '@/services/movie-progress';
import { getSeriesSummary, loadSeriesProgressMap } from '@/services/series-progress';
import { buildLiveUrl, buildMovieUrl, buildSeriesEpisodeUrl } from '@/services/stream-url';

type CatalogKind = 'vod' | 'series' | 'live';

type Episode = {
  seasonNumber: number;
  episodeNumber: number;
  episodeId: string;
  extension: string;
  title: string;
};

type SeriesInfoPayload = {
  info?: {
    name?: string;
    cover?: string;
    plot?: string;
    genre?: string;
  };
  episodes?: Record<string, Array<any>>;
};

function normalizeKind(kind: string): CatalogKind {
  if (kind === 'vod' || kind === 'series' || kind === 'live') {
    return kind;
  }
  return 'live';
}

function normalizeEpisodes(payload: SeriesInfoPayload): Episode[] {
  if (!payload?.episodes || typeof payload.episodes !== 'object') {
    return [];
  }

  const list: Episode[] = [];

  Object.entries(payload.episodes).forEach(([season, episodes]) => {
    const seasonNumber = Number(season);
    episodes.forEach((ep: any, index: number) => {
      const episodeNumber = Number(ep?.episode_num ?? index + 1);
      list.push({
        seasonNumber,
        episodeNumber,
        episodeId: String(ep?.id || ep?.episode_id || ''),
        extension: String(ep?.container_extension || 'mp4'),
        title: String(ep?.title || `Episodio ${episodeNumber}`),
      });
    });
  });

  return list.sort((a, b) =>
    a.seasonNumber === b.seasonNumber
      ? a.episodeNumber - b.episodeNumber
      : a.seasonNumber - b.seasonNumber
  );
}

async function getSeriesInfo(seriesId: string): Promise<SeriesInfoPayload> {
  const [url, username, password] = await Promise.all([
    getDbValue<string>('url'),
    getDbValue<string>('username'),
    getDbValue<string>('password'),
  ]);

  if (!url || !username || !password || !seriesId) {
    return {};
  }

  const endpoint = `${url}/player_api.php?username=${username}&password=${password}&action=get_series_info&series_id=${seriesId}`;
  return (await fetch(endpoint)).json();
}

export default function TvDetailScreen() {
  const { width } = useWindowDimensions();
  const router = useRouter();
  const params = useLocalSearchParams<{ kind?: string; id?: string; title?: string; cover?: string }>();

  const kind = normalizeKind(String(params.kind || 'live'));
  const id = String(params.id || '');

  const [item, setItem] = useState<StreamItem | null>(null);
  const [seriesInfo, setSeriesInfo] = useState<SeriesInfoPayload>({});
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selectedSeason, setSelectedSeason] = useState(1);
  const [moviePositionMs, setMoviePositionMs] = useState(0);
  const [seriesContinue, setSeriesContinue] = useState<{ season: number; episode: number }>({ season: 1, episode: 1 });
  const [focusedEpisodeId, setFocusedEpisodeId] = useState('');
  // Guardar episódio de continuar
  const [continueEpisodeId, setContinueEpisodeId] = useState('');
  const [focusedAction, setFocusedAction] = useState('');
  const [focusedSeason, setFocusedSeason] = useState(0);

  const backBtnRef = React.useRef<React.ElementRef<typeof Pressable>>(null);
  const playBtnRef = React.useRef<React.ElementRef<typeof Pressable>>(null);
  const episodeListRef = React.useRef<FlatList<Episode>>(null);
  const lastFocusedEpisodeRowRef = React.useRef(-1);
  const seasonRefs = React.useRef<Array<React.ElementRef<typeof Pressable> | null>>([]);
  const episodeRefs = React.useRef<Array<React.ElementRef<typeof Pressable> | null>>([]);

  const getHandle = React.useCallback((node: unknown) => findNodeHandle(node as any) ?? undefined, []);
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

    const bootstrap = async () => {
      if (!id) return;

      const found = await queryCatalogItemsByIds(kind === 'series' ? 'series' : kind, [id]);
      const current = found[id] || null;
      if (!mounted) return;
      setItem(current);

      if (kind === 'vod') {
        const map = await loadMovieProgressMap();
        const state = getMovieProgress(map, id);
        if (mounted) {
          setMoviePositionMs(state?.positionMs || 0);
        }
      }

      if (kind === 'series') {
        const [payload, progressMap] = await Promise.all([getSeriesInfo(id), loadSeriesProgressMap()]);
        if (!mounted) return;
        const normalized = normalizeEpisodes(payload);
        const summary = getSeriesSummary(progressMap, id);

        setSeriesInfo(payload);
        setEpisodes(normalized);
        setSeriesContinue({ season: summary.continueSeason, episode: summary.continueEpisode });
        setSelectedSeason(summary.continueSeason || normalized[0]?.seasonNumber || 1);

        // Descobre o episódioId do continuar
        const cont = normalized.find(
          (ep) => ep.seasonNumber === summary.continueSeason && ep.episodeNumber === summary.continueEpisode
        );
        setContinueEpisodeId(cont?.episodeId || '');
      }
    };

    void bootstrap();

    return () => {
      mounted = false;
    };
  }, [id, kind]);

  const seasons = useMemo(() => {
    const set = new Set<number>();
    episodes.forEach((ep) => set.add(ep.seasonNumber));
    return Array.from(set.values()).sort((a, b) => a - b);
  }, [episodes]);

  const visibleEpisodes = useMemo(
    () => episodes.filter((ep) => ep.seasonNumber === selectedSeason),
    [episodes, selectedSeason]
  );
  const getEpisodeHandle = React.useCallback(
    (index: number) => {
      if (index < 0 || index >= visibleEpisodes.length) return undefined;
      return getHandle(episodeRefs.current[index]);
    },
    [getHandle, visibleEpisodes.length]
  );

  useEffect(() => {
    lastFocusedEpisodeRowRef.current = -1;
    episodeListRef.current?.scrollToOffset({ offset: 0, animated: false });
    // Foca automaticamente no episódio de continuar
    if (continueEpisodeId) {
      const idx = visibleEpisodes.findIndex((ep) => ep.episodeId === continueEpisodeId);
      if (idx >= 0) {
        setTimeout(() => {
          episodeRefs.current[idx]?.focus?.();
        }, 350);
      }
    }
  }, [selectedSeason, id, continueEpisodeId, visibleEpisodes]);

  const syncEpisodeScrollWithFocus = React.useCallback(
    (index: number) => {
      const row = Math.floor(index / 1);
      if (row === lastFocusedEpisodeRowRef.current) return;
      lastFocusedEpisodeRowRef.current = row;
      episodeListRef.current?.scrollToIndex({
        index,
        viewPosition: 0.2,
        animated: false,
      });
    },
    []
  );

  const handleSelectSeason = React.useCallback((season: number) => {
    lastFocusedEpisodeRowRef.current = -1;
    episodeListRef.current?.scrollToOffset({ offset: 0, animated: false });
    setSelectedSeason(season);
  }, []);

  const openMovieOrLive = async () => {
    if (!item) return;
    try {
      const url = kind === 'live' ? await buildLiveUrl(item) : await buildMovieUrl(item);
      if (!url) return;

      router.push({
        pathname: '/tv/player' as any,
        params: {
          mode: kind,
          title: toText(item.title || item.name),
          url,
          contentId: id,
          posterUrl: toText(item.cover || item.stream_icon),
          startPositionMs: kind === 'vod' ? String(moviePositionMs) : '0',
        },
      });
    } catch {
      // ignora erros de navegacao
    }
  };

  const openSeriesEpisode = async (episode: Episode) => {
    try {
      const url = await buildSeriesEpisodeUrl(episode.episodeId, episode.extension || 'mp4');
      if (!url) return;

      router.push({
        pathname: '/tv/player' as any,
        params: {
          mode: 'series',
          title: toText(seriesInfo.info?.name || item?.title || item?.name || params.title || 'Serie'),
          url,
          contentId: episode.episodeId,
          seriesId: id,
          posterUrl: toText(seriesInfo.info?.cover || item?.cover || item?.stream_icon || params.cover),
          seasonNumber: String(episode.seasonNumber),
          episodeNumber: String(episode.episodeNumber),
        },
      });
    } catch {
      // ignora erros de navegacao
    }
  };

  const title =
    toText(seriesInfo.info?.name) || toText(item?.title || item?.name) || toText(params.title, 'Conteudo');
  const cover = toText(seriesInfo.info?.cover || item?.cover || item?.stream_icon || params.cover);
  const summary = toText(seriesInfo.info?.plot || item?.plot || item?.genre, 'Sem descricao detalhada.');

  // Responsividade para TVs pequenas e Chromebooks
  let coverW = 240, coverH = 340, pad = 22, titleFont = 32, descFont = 16, playFont = 17, backFont = 15, episodeFont = 15, chipFont = 15, iconSize = 24;
  if (width <= 1280) {
    coverW = 110;
    coverH = 150;
    pad = 8;
    titleFont = 14;
    descFont = 10;
    playFont = 10;
    backFont = 10;
    episodeFont = 9;
    chipFont = 9;
    iconSize = 16;
  }

  return (
    <SafeAreaView style={styles.container}>
      <AppBackdrop blurIntensity={20} />

      <ScrollView contentContainerStyle={[styles.content, { paddingHorizontal: pad, paddingTop: pad, paddingBottom: pad * 4 }]}> 
        <Pressable
          ref={backBtnRef}
          style={[styles.backBtn, focusedAction === 'back' && styles.backBtnFocused]}
          onPress={() => router.back()}
          onFocus={() => setFocusedAction('back')}
          onBlur={() => setFocusedAction('')}
          {...({ nextFocusDown: getHandle(playBtnRef.current) } as any)}
        >
          <MaterialIcons name="arrow-back" size={backFont + 7} color={StreamingTheme.colors.textPrimary} />
          <Text style={[styles.backText, { fontSize: backFont }]}>Voltar</Text>
        </Pressable>

        <View style={styles.hero}>
          {cover ? (
            <Image source={{ uri: cover }} style={[styles.cover, { width: coverW, height: coverH }]} contentFit="cover" />
          ) : (
            <View style={[styles.cover, styles.coverFallback, { width: coverW, height: coverH }]}>
              <MaterialIcons name={kind === 'live' ? 'live-tv' : kind === 'series' ? 'smart-display' : 'movie'} size={iconSize * 2} color={StreamingTheme.colors.textMuted} />
            </View>
          )}

          <View style={styles.heroInfo}>
            <Text style={[styles.title, { fontSize: titleFont }]}>{title}</Text>
            <Text style={[styles.description, { fontSize: descFont }]}>{summary}</Text>

            {kind !== 'series' ? (
              <Pressable
                ref={playBtnRef}
                style={[styles.playBtn, focusedAction === 'play' && styles.playBtnFocused]}
                onPress={openMovieOrLive}
                onFocus={() => setFocusedAction('play')}
                onBlur={() => setFocusedAction('')}
                hasTVPreferredFocus
                {...({ nextFocusUp: getHandle(backBtnRef.current) } as any)}
              >
                <MaterialIcons name="play-arrow" size={iconSize} color={StreamingTheme.colors.textPrimary} />
                <Text style={[styles.playText, { fontSize: playFont }]}>{kind === 'live' ? 'Assistir agora' : 'Assistir'}</Text>
              </Pressable>
            ) : (
              <Pressable
                ref={playBtnRef}
                style={[styles.playBtn, focusedAction === 'play' && styles.playBtnFocused]}
                onPress={() => {
                  const nextEpisode =
                    episodes.find(
                      (ep) => ep.seasonNumber === seriesContinue.season && ep.episodeNumber === seriesContinue.episode
                    ) || episodes[0];
                  if (nextEpisode) {
                    void openSeriesEpisode(nextEpisode);
                  }
                }}
                onFocus={() => setFocusedAction('play')}
                onBlur={() => setFocusedAction('')}
                hasTVPreferredFocus
                {...({
                  nextFocusUp: getHandle(backBtnRef.current),
                  nextFocusDown: seasons.length ? getHandle(seasonRefs.current[0]) : getEpisodeHandle(0),
                } as any)}
              >
                <MaterialIcons name="play-arrow" size={iconSize} color={StreamingTheme.colors.textPrimary} />
                <Text style={[styles.playText, { fontSize: playFont }]}>
                  Continuar S{seriesContinue.season} E{seriesContinue.episode}
                </Text>
              </Pressable>
            )}
          </View>
        </View>

        {kind === 'series' ? (
          <>
            <View style={styles.seasonRow}>
              {seasons.map((season, index) => {
                const active = season === selectedSeason;
                return (
                  <Pressable
                    key={season}
                    ref={(el) => {
                      seasonRefs.current[index] = el;
                    }}
                    onPress={() => handleSelectSeason(season)}
                    onFocus={() => setFocusedSeason(season)}
                    onBlur={() => setFocusedSeason(0)}
                    style={[styles.seasonChip, active && styles.seasonChipActive, focusedSeason === season && styles.seasonChipFocused]}
                    {...({
                      nextFocusUp: getHandle(playBtnRef.current),
                      nextFocusDown: getEpisodeHandle(0),
                      nextFocusLeft:
                        index === 0 ? getHandle(seasonRefs.current[0]) : getHandle(seasonRefs.current[index - 1]),
                      nextFocusRight:
                        index === seasons.length - 1
                          ? getHandle(seasonRefs.current[index])
                          : getHandle(seasonRefs.current[index + 1]),
                    } as any)}
                  >
                    <Text style={[styles.seasonText, { fontSize: chipFont }, active && styles.seasonTextActive]}>Temporada {season}</Text>
                  </Pressable>
                );
              })}
            </View>

            <FlatList
              ref={episodeListRef}
              data={visibleEpisodes}
              key={`episodes-${selectedSeason}`}
              keyExtractor={(entry) => `${entry.seasonNumber}-${entry.episodeNumber}-${entry.episodeId}`}
              scrollEnabled={false}
              onScrollToIndexFailed={({ index, averageItemLength }) => {
                const fallbackOffset = Math.max(0, Math.floor(index * Math.max(averageItemLength || 0, 1)));
                episodeListRef.current?.scrollToOffset({ offset: fallbackOffset, animated: false });
                setTimeout(() => {
                  episodeListRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.2 });
                }, 0);
              }}
              renderItem={({ item: episode, index }) => {
                const focused = focusedEpisodeId === episode.episodeId;
                return (
                  <Pressable
                    ref={(el) => {
                      episodeRefs.current[index] = el;
                    }}
                    onPress={() => {
                      void openSeriesEpisode(episode);
                    }}
                    onFocus={() => {
                      setFocusedEpisodeId(episode.episodeId);
                      syncEpisodeScrollWithFocus(index);
                    }}
                    style={[styles.episodeCard, focused && styles.episodeCardFocused]}
                    {...({
                      nextFocusUp: seasons.length ? getHandle(seasonRefs.current[0]) : getHandle(playBtnRef.current),
                      nextFocusDown: getEpisodeHandle(index + 1) ?? getEpisodeHandle(index),
                    } as any)}
                  >
                    <Text style={[styles.episodeTitle, { fontSize: episodeFont }]}>S{episode.seasonNumber} E{episode.episodeNumber} • {episode.title}</Text>
                    <MaterialIcons name="play-circle" size={iconSize} color={StreamingTheme.colors.accentAlt} />
                  </Pressable>
                );
              }}
            />
          </>
        ) : null}
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
    paddingHorizontal: 22,
    paddingTop: 10,
    paddingBottom: 36,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderColor: StreamingTheme.colors.accentAlt,
  },
  backBtnFocused: {
    borderWidth: 4,
    borderColor: StreamingTheme.colors.accentAlt,
  },
  backText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
  },
  hero: {
    marginTop: 14,
    flexDirection: 'row',
    gap: 16,
  },
  cover: {
    width: 240,
    height: 340,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  coverFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroInfo: {
    flex: 1,
    justifyContent: 'flex-start',
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 32,
    fontWeight: '900',
  },
  description: {
    marginTop: 10,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 16,
    lineHeight: 24,
  },
  playBtn: {
    marginTop: 18,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(255,143,58,0.22)',
    borderWidth: 3,
    borderColor: StreamingTheme.colors.accentAlt,
  },
  playText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '800',
  },
  playBtnFocused: {
    borderWidth: 5,
    borderColor: StreamingTheme.colors.accentAlt,
  },
  seasonRow: {
    marginTop: 22,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  seasonChip: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  seasonChipActive: {
    borderColor: StreamingTheme.colors.accentAlt,
    backgroundColor: 'rgba(255,143,58,0.18)',
  },
  seasonChipFocused: {
    borderWidth: 4,
    borderColor: StreamingTheme.colors.accentAlt,
  },
  seasonText: {
    color: StreamingTheme.colors.textSecondary,
    fontWeight: '700',
  },
  seasonTextActive: {
    color: StreamingTheme.colors.textPrimary,
  },
  episodeCard: {
    marginTop: 10,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  episodeCardFocused: {
    borderWidth: 4,
    borderColor: StreamingTheme.colors.accentAlt,
  },
  episodeCardContinue: {
    borderWidth: 3,
    borderColor: StreamingTheme.colors.accentAlt,
    backgroundColor: 'rgba(255,143,58,0.10)',
  },
  episodeTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
    flex: 1,
    marginRight: 8,
  },
  episodeTitleContinue: {
    color: StreamingTheme.colors.accentAlt,
    fontWeight: 'bold',
  },
});
