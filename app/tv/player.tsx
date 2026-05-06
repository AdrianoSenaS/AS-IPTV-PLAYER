import { MaterialIcons } from '@expo/vector-icons';
import { useKeepAwake } from 'expo-keep-awake';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, findNodeHandle, View, useWindowDimensions } from 'react-native';

import { StreamingTheme } from '@/constants/streaming-theme';
import { updateMovieProgress } from '@/services/movie-progress';
import { updateEpisodeProgress, loadSeriesProgressMap, getSeriesSummary } from '@/services/series-progress';
import { loadSeriesPlaylist, PlaylistItem } from '@/services/series-playlist';
import { PageLoader } from '@/components/page-loader';
import { schedulePushWatchProgress } from '@/services/watch-sync';

function formatMs(value: number) {
  const total = Math.max(0, Math.floor(value / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export default function TvPlayerScreen() {
  const player = useVideoPlayer('tv-player');
  const { width } = useWindowDimensions();
  const router = useRouter();
  const params = useLocalSearchParams<{
    url?: string;
    title?: string;
    mode?: string;
    contentId?: string;
    seriesId?: string;
    seasonNumber?: string;
    episodeNumber?: string;
    startPositionMs?: string;
  }>();

  useKeepAwake();

  const sourceUrl = String(params.url || '');
  const mode = String(params.mode || 'movie');
  const contentId = String(params.contentId || '');
  const seriesId = String(params.seriesId || '');
  const seasonNumber = Number(params.seasonNumber || 0) || 0;
  const episodeNumber = Number(params.episodeNumber || 0) || 0;
  const startPositionMs = Math.max(0, Number(params.startPositionMs || 0) || 0);

  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [focusedControl, setFocusedControl] = useState('play');
  const [showControls, setShowControls] = useState(true);
  const [isBuffering, setIsBuffering] = useState(true);
  const [nextEpisode, setNextEpisode] = useState<PlaylistItem | null>(null);
  const [playlist, setPlaylist] = useState<PlaylistItem[]>([]);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistTickRef = useRef<any>(null);
  const backBtnRef = useRef<React.ElementRef<typeof Pressable>>(null);
  const rewindBtnRef = useRef<React.ElementRef<typeof Pressable>>(null);
  const playBtnRef = useRef<React.ElementRef<typeof Pressable>>(null);
  const forwardBtnRef = useRef<React.ElementRef<typeof Pressable>>(null);
  const nextBtnRef = useRef<React.ElementRef<typeof Pressable>>(null);
  const getHandle = (node: unknown) => findNodeHandle(node as any) ?? undefined;
  const useTVEventHandlerCompat = (require('react-native') as any).useTVEventHandler as
    | ((handler: (event: any) => void) => void)
    | undefined;
  // Carrega playlist e determina próximo episódio (apenas para séries)
  useEffect(() => {
    let mounted = true;
    async function fetchPlaylistAndNext() {
      if (mode !== 'series' || !seriesId || !seasonNumber || !episodeNumber) return;
      const key = `series-playlist-${seriesId}`;
      const list = await loadSeriesPlaylist(key);
      if (!mounted) return;
      setPlaylist(list);
      const idx = list.findIndex(
        (ep) => ep.seasonNumber === seasonNumber && ep.episodeNumber === episodeNumber
      );
      if (idx >= 0 && idx + 1 < list.length) {
        setNextEpisode(list[idx + 1]);
      } else {
        setNextEpisode(null);
      }
    }
    fetchPlaylistAndNext();
    return () => {
      mounted = false;
    };
  }, [mode, seriesId, seasonNumber, episodeNumber]);
  // Responsividade dinâmica
  let iconSize = 36;
  let controlBtnSize = 72;
  let controlBtnFont = 15;
  let progressFont = 13;
  let titleFont = 19;
  let overlayPad = 20;
  let progressHeight = 8;
  if (width <= 1280) {
    iconSize = 22;
    controlBtnSize = 48;
    controlBtnFont = 11;
    progressFont = 10;
    titleFont = 13;
    overlayPad = 8;
    progressHeight = 5;
  }

  // Cálculo do progresso
  const progressPercent = durationMs > 0 ? (positionMs / durationMs) * 100 : 0;

  // Função utilitária para montar a URL do episódio (igual buildSeriesEpisodeUrl, mas inline para evitar import cíclico)
  function sourceUrlForEpisode(ep: PlaylistItem) {
    if (!ep?.episodeId || !ep?.extension) return '';
    if (!seriesId) return '';
    // Assume que a URL base é igual à do episódio atual, trocando o id/ext
    // Exemplo: .../series/{episodeId}.{ext}
    const base = String(sourceUrl || '');
    const idx = base.lastIndexOf('/');
    if (idx < 0) return base;
    return base.slice(0, idx + 1) + `${ep.episodeId}.${ep.extension}`;
  }

  useEffect(() => {
    persistTickRef.current = setInterval(() => {
      if (!contentId) return;

      if (mode === 'series' && seriesId && seasonNumber > 0 && episodeNumber > 0) {
        const pct = durationMs > 0 ? (positionMs / durationMs) * 100 : 0;
        void updateEpisodeProgress(seriesId, seasonNumber, episodeNumber, pct, positionMs, durationMs);
        return;
      }

      if (mode === 'vod' || mode === 'movie') {
        void updateMovieProgress(contentId, positionMs, durationMs);
      }
      schedulePushWatchProgress();
    }, 4000);

    return () => {
      if (persistTickRef.current) {
        clearInterval(persistTickRef.current);
      }
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
    };
  }, [contentId, durationMs, episodeNumber, mode, positionMs, seasonNumber, seriesId]);


  const togglePlay = () => {
    if (isPlaying) {
      player.pause();
      setIsPlaying(false);
    } else {
      player.play();
      setIsPlaying(true);
    }
  };

  // Força play após seek manual
  const seekDelta = (seconds: number) => {
    const next = Math.max(0, Math.min(durationMs, positionMs + seconds * 1000));
    player.currentTime = next / 1000;
    setPositionMs(next);
    setTimeout(() => {
      try { player.play(); } catch {}
    }, 200);
  };

  useTVEventHandlerCompat?.((event: any) => {
    const type = String(event?.eventType || '').toLowerCase();
    if (type === 'playpause' || type === 'select') {
      togglePlay();
      return;
    }
    if (type === 'menu' || type === 'back') {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      router.back();
    }
  });

  return (
    <SafeAreaView style={styles.container}>
      <VideoView style={styles.video} player={player} nativeControls={false} allowsFullscreen allowsPictureInPicture={false} />

      <PageLoader visible={isBuffering} label={String(params.title || 'Carregando...')} />

      <View style={[styles.overlay, !showControls && styles.overlayHidden]}>
        <View style={styles.topBar}>
          <Pressable
            ref={backBtnRef}
            style={[styles.backBtn, focusedControl === 'back' && styles.controlBtnFocused]}
            onPress={() => router.back()}
            onFocus={() => setFocusedControl('back')}
            {...({ nextFocusDown: getHandle(playBtnRef.current) } as any)}
          >
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
            <Text style={styles.backText}>Voltar</Text>
          </Pressable>
          <Text numberOfLines={1} style={styles.title}>{String(params.title || 'Player TV')}</Text>
        </View>

        <View style={styles.controlsBar}>
          <Pressable
            ref={rewindBtnRef}
            style={[styles.controlBtn, focusedControl === 'rewind' && styles.controlBtnFocused]}
            onFocus={() => setFocusedControl('rewind')}
            onPress={() => seekDelta(-15)}
            {...({
              nextFocusUp: getHandle(backBtnRef.current),
              nextFocusRight: getHandle(playBtnRef.current),
            } as any)}
          >
            <MaterialIcons name="replay-10" size={28} color={StreamingTheme.colors.textPrimary} />
          </Pressable>

          <Pressable
            ref={playBtnRef}
            style={[styles.controlBtn, focusedControl === 'play' && styles.controlBtnFocused]}
            onFocus={() => setFocusedControl('play')}
            onPress={togglePlay}
            hasTVPreferredFocus
            {...({
              nextFocusUp: getHandle(backBtnRef.current),
              nextFocusLeft: getHandle(rewindBtnRef.current),
              nextFocusRight: nextEpisode ? getHandle(nextBtnRef.current) : getHandle(forwardBtnRef.current),
            } as any)}
          >
            <MaterialIcons
              name={isPlaying ? 'pause-circle-filled' : 'play-circle-filled'}
              size={36}
              color={StreamingTheme.colors.textPrimary}
            />
          </Pressable>

          {nextEpisode ? (
              <Pressable
                ref={nextBtnRef}
                style={[styles.controlBtn, focusedControl === 'next' && styles.controlBtnFocused]}
                onFocus={() => setFocusedControl('next')}
                onPress={() => {
                  router.replace({
                    pathname: '/tv/player' as any,
                    params: {
                      mode: 'series',
                      title: nextEpisode.title,
                      url: sourceUrlForEpisode(nextEpisode),
                      contentId: nextEpisode.episodeId,
                      seriesId,
                      seasonNumber: String(nextEpisode.seasonNumber),
                      episodeNumber: String(nextEpisode.episodeNumber),
                      startPositionMs: '0',
                    },
                  });
                }}
                {...({
                  nextFocusUp: getHandle(backBtnRef.current),
                  nextFocusLeft: getHandle(playBtnRef.current),
                  nextFocusRight: getHandle(forwardBtnRef.current),
                } as any)}
              >
              <MaterialIcons name="skip-next" size={32} color={StreamingTheme.colors.accentAlt} />
              <Text style={{ color: StreamingTheme.colors.accentAlt, fontWeight: 'bold', fontSize: 15 }}>Próximo episódio</Text>
            </Pressable>
          ) : null}

          <Pressable
            ref={forwardBtnRef}
            style={[styles.controlBtn, focusedControl === 'forward' && styles.controlBtnFocused]}
            onFocus={() => setFocusedControl('forward')}
            onPress={() => seekDelta(15)}
            {...({
              nextFocusUp: getHandle(backBtnRef.current),
              nextFocusLeft: nextEpisode ? getHandle(nextBtnRef.current) : getHandle(playBtnRef.current),
            } as any)}
          >
            <MaterialIcons name="forward-10" size={28} color={StreamingTheme.colors.textPrimary} />
          </Pressable>
        </View>

        <View style={styles.progressWrap}>
          <Text style={styles.progressText}>{formatMs(positionMs)}</Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${progressPercent}%` },
              ]}
            />
          </View>
          <Text style={styles.progressText}>{formatMs(durationMs)}</Text>
        </View>

        <Text style={styles.footerInfo}>Progresso: {progressPercent}%</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  video: {
    ...StyleSheet.absoluteFillObject,
  },
  overlay: {
    flex: 1,
    justifyContent: 'space-between',
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  overlayHidden: {
    opacity: 0,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  backText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 19,
    fontWeight: '900',
    flex: 1,
  },
  controlsBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  controlBtn: {
    width: 86,
    height: 72,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  controlBtnFocused: {
    borderWidth: 5,
    borderColor: StreamingTheme.colors.accentAlt,
    backgroundColor: 'rgba(255,143,58,0.22)',
  },
  progressWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  progressTrack: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
    backgroundColor: StreamingTheme.colors.accentAlt,
  },
  progressText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    minWidth: 62,
    textAlign: 'center',
    fontWeight: '700',
  },
  footerInfo: {
    color: StreamingTheme.colors.textMuted,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '700',
  },
});
