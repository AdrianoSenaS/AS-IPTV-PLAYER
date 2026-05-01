import { MaterialIcons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import * as Brightness from 'expo-brightness';
import { useKeepAwake } from 'expo-keep-awake';
import * as NavigationBar from 'expo-navigation-bar';
import { VideoAirPlayButton, VideoView, isPictureInPictureSupported } from 'expo-video';

import * as ScreenOrientation from 'expo-screen-orientation';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  AppStateStatus,
  Modal,
  PanResponder,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { PageLoader } from '@/components/page-loader';
import { AppBackdrop } from '@/components/app-backdrop';
import { usePlayback } from '@/components/playback-provider';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { StreamingTheme } from '@/constants/streaming-theme';
import { clearMiniPlayerState, setMiniPlayerState } from '@/services/mini-player';
import { updateMovieProgress } from '@/services/movie-progress';
import { updateEpisodeProgress } from '@/services/series-progress';
import { loadSeriesPlaylist, PlaylistItem } from '@/services/series-playlist';
import { buildSeriesEpisodeUrl } from '@/services/stream-url';
import { recordWatchSignal } from '@/services/taste-recommender';
import {
  isContentBlocked,
  onContentBlocked,
  reportStoppedWatching,
  reportWatching,
} from '@/services/realtime-presence';

let VolumeManager: any = null;
try {
  // Carregamento opcional para evitar crash em ambientes sem modulo nativo (ex.: Expo Go).
  const volumeModule = require('react-native-volume-manager');
  VolumeManager = volumeModule?.default || volumeModule;
} catch {
  VolumeManager = null;
}

let GoogleCast: any = null;
let CastButton: any = () => null;
let CastState: any = { CONNECTED: 'connected' };
let MediaStreamType: any = { LIVE: 'LIVE', BUFFERED: 'BUFFERED' };
let useCastState: any = () => null;
let useRemoteMediaClient: any = () => null;

try {
  const castModule = require('react-native-google-cast');
  GoogleCast = castModule?.default || castModule;
  CastButton = castModule?.CastButton || (() => null);
  CastState = castModule?.CastState || CastState;
  MediaStreamType = castModule?.MediaStreamType || MediaStreamType;
  useCastState = castModule?.useCastState || useCastState;
  useRemoteMediaClient = castModule?.useRemoteMediaClient || useRemoteMediaClient;
} catch {
  GoogleCast = null;
}

type PlaybackStatus = {
  isLoaded?: boolean;
  isPlaying?: boolean;
  durationMillis?: number;
  positionMillis?: number;
  isBuffering?: boolean;
  didJustFinish?: boolean;
};

type Side = 'left' | 'right';
type Quality = 'Auto' | 'Alta' | 'Media' | 'Baixa';
type AudioMode = 'Stereo' | 'Mono' | 'Mudo';
type SubtitleMode = 'Desligada' | 'Auto';
type ScreenMode = 'Auto' | '4:3' | '16:9' | '16:10' | '21:9' | 'Preencher';
type ZoomLevel = '100%' | '115%' | '130%' | '145%';

const PLAYER_FALLBACK = {
  currentTime: 0,
  duration: 0,
  muted: false,
  volume: 1,
  play() {},
  pause() {},
  addListener() {
    return { remove() {} };
  },
} as any;

const formatMs = (value: number) => {
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export default function PlayerScreen() {
  const router = useRouter();
  const { hasFeature, loading: planLoading } = usePlanGate();
  useKeepAwake();
  const params = useLocalSearchParams<{
    mode?: string;
    title?: string;
    url?: string;
    contentId?: string;
    seriesId?: string;
    startPositionMs?: string;
    playlistKey?: string;
    playlistIndex?: string;
  }>();

  const videoViewRef = useRef<VideoView>(null);
  const singleTapTimerRef = useRef<any>(null);
  const doubleTapRef = useRef<{ left: number; right: number }>({ left: 0, right: 0 });
  const gestureBaseRef = useRef<{ left: number; right: number }>({ left: 0.6, right: 1 });
  const brightnessRef = useRef(0.6);
  const volumeRef = useRef(1);
  const latestPositionRef = useRef(0);
  const latestDurationRef = useRef(0);
  const pendingStartPositionMsRef = useRef(0);
  const playRetryCountRef = useRef(0);
  const liveUrlRetryRef = useRef(false);
  const hasShownGestureTutorialRef = useRef(false);
  const keepPlaybackOnExitRef = useRef(false);
  const lastSavedSecondRef = useRef(-1);
  const persistTickInFlightRef = useRef(false);
  const prefetchedEpisodeUrlRef = useRef<Record<number, string>>({});
  const sourceStallTimerRef = useRef<any>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [status, setStatus] = useState<PlaybackStatus>({});
  const [isLocked, setIsLocked] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [skipHint, setSkipHint] = useState<{ side: Side; text: string } | null>(null);
  const [gestureHint, setGestureHint] = useState<string | null>(null);

  const [brightness, setBrightness] = useState(0.6);
  const [volume, setVolume] = useState(1);
  const [playlist, setPlaylist] = useState<PlaylistItem[]>([]);
  const [playlistIndex, setPlaylistIndex] = useState(Number(params.playlistIndex || 0));
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);
  const [skippedIntroByEpisode, setSkippedIntroByEpisode] = useState<Record<number, boolean>>({});

  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubPreviewMs, setScrubPreviewMs] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);

  const [quality, setQuality] = useState<Quality>('Auto');
  const [audioMode, setAudioMode] = useState<AudioMode>('Stereo');
  const [subtitleMode, setSubtitleMode] = useState<SubtitleMode>('Auto');
  const [screenMode, setScreenMode] = useState<ScreenMode>('Auto');
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>('100%');
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [isPlaybackRequested, setIsPlaybackRequested] = useState(true);
  const [hasFirstFrame, setHasFirstFrame] = useState(false);
  const [pipRequiresHomeFallback, setPipRequiresHomeFallback] = useState(false);
  const [pendingCastLoad, setPendingCastLoad] = useState(false);
  const [showGestureTutorial, setShowGestureTutorial] = useState(false);

  const mode = String(params.mode || 'movie');
  const contentId = String(params.contentId || '');
  const seriesId = String(params.seriesId || '');
  const isAppActive = appState !== 'background';
  const castState = useCastState();
  const remoteMediaClient = useRemoteMediaClient();
  const canUsePip = !planLoading && hasFeature('pip');
  const canUseCastMirror = !planLoading && hasFeature('cast_mirror');
  const { player, sourceUrl, setSourceUrl } = usePlayback();
  const playbackPlayer = player ?? PLAYER_FALLBACK;

  // Erros não-fatais do player no Android: foco de áudio, Activity destruída ou keep-awake indisponível.
  const isNonFatalPlayerError = (error: unknown) => {
    const message = String((error as any)?.message || error || '');
    return (
      message.includes('AudioFocusNotAcquiredException') ||
      message.includes('activity is no longer available') ||
      message.includes('Unable to activate keep awake') ||
      message.includes('VideoPlayer.constructor')
    );
  };

  const getAlternateLiveUrl = (currentUrl: string) => {
    if (/\.ts(\?|$)/i.test(currentUrl)) {
      return currentUrl.replace(/\.ts(\?|$)/i, '.m3u8$1');
    }

    if (/\.m3u8(\?|$)/i.test(currentUrl)) {
      return currentUrl.replace(/\.m3u8(\?|$)/i, '.ts$1');
    }

    return '';
  };

  const tryLiveFallbackSource = (reasonLabel: string) => {
    if (mode !== 'live' || liveUrlRetryRef.current || !sourceUrl) {
      return false;
    }

    const fallbackUrl = getAlternateLiveUrl(sourceUrl);
    if (!fallbackUrl || fallbackUrl === sourceUrl) {
      return false;
    }

    liveUrlRetryRef.current = true;
    playRetryCountRef.current = 0;
    setGestureHint(reasonLabel);
    setTimeout(() => setGestureHint(null), 1100);
    setIsLoading(true);
    setHasFirstFrame(false);
    setIsPlaybackRequested(true);
    setSourceUrl(fallbackUrl);
    return true;
  };

  const safeRunPlayback = async (action: () => Promise<unknown>) => {
    if (!isAppActive) {
      return;
    }

    try {
      await action();
    } catch (error) {
      if (!isNonFatalPlayerError(error)) {
        throw error;
      }
    }
  };

  const requestPlayNow = async () => {
    setIsPlaybackRequested(true);
    await safeRunPlayback(async () => {
      playbackPlayer.play();
    });
  };

  const persistExactProgress = async () => {
    const currentPosition = latestPositionRef.current;
    const currentDuration = latestDurationRef.current;

    if (!currentDuration || !currentPosition) return;

    if (mode === 'movie' && contentId) {
      await updateMovieProgress(contentId, currentPosition, currentDuration);
      await recordWatchSignal({
        contentId,
        type: 'movie',
        progressPercent: Math.min(100, Math.round((currentPosition / currentDuration) * 100)),
        positionMs: currentPosition,
        durationMs: currentDuration,
      });
      return;
    }

    if (mode === 'series' && seriesId) {
      const currentEpisode = playlist[playlistIndex];
      if (!currentEpisode) return;
      const progress = Math.min(100, Math.round((currentPosition / currentDuration) * 100));
      await updateEpisodeProgress(
        seriesId,
        currentEpisode.seasonNumber,
        currentEpisode.episodeNumber,
        progress,
        currentPosition,
        currentDuration
      );
      await recordWatchSignal({
        contentId: seriesId,
        type: 'series',
        progressPercent: progress,
        positionMs: currentPosition,
        durationMs: currentDuration,
      });
      return;
    }

    if (mode === 'live') {
      const liveId = String(params.contentId || params.title || sourceUrl || '').trim();
      if (!liveId) return;

      await recordWatchSignal({
        contentId: liveId,
        type: 'live',
        progressPercent: 55,
        positionMs: currentPosition,
        durationMs: currentDuration,
      });
    }
  };

  const closePlayerAndExit = async () => {
    keepPlaybackOnExitRef.current = false;
    await persistExactProgress();
    setIsPlaybackRequested(false);
    clearMiniPlayerState();

    try {
      playbackPlayer.pause();
    } catch {
      // Ignora falhas de pause quando o player estiver entre estados.
    }
    router.back();
  };

  useEffect(() => {
    if (!isAppActive || !isPlaybackRequested || !sourceUrl) return;

    const timer = setTimeout(() => {
      requestPlayNow();
    }, 120);

    return () => clearTimeout(timer);
  }, [isAppActive, isPlaybackRequested, sourceUrl]);

  useEffect(() => {
    const isLoaded = !!(status as any).isLoaded;
    const isPlaying = !!status.isPlaying;
    const isBuffering = !!status.isBuffering;

    if (!isLoaded || isPlaying || isBuffering || !isPlaybackRequested || !isAppActive) {
      return;
    }

    if (playRetryCountRef.current >= 3) {
      return;
    }

    playRetryCountRef.current += 1;
    const timer = setTimeout(() => {
      requestPlayNow();
    }, 220);

    return () => clearTimeout(timer);
  }, [status.isPlaying, status.isBuffering, (status as any).isLoaded, isPlaybackRequested, isAppActive]);

  const toggleControlsByTap = () => {
    setShowControls((prev) => !prev);
    if (showSettings) {
      setShowSettings(false);
    }
  };

  useEffect(() => {
    if (!VolumeManager?.getVolume || !VolumeManager?.addVolumeListener) {
      return;
    }

    VolumeManager.getVolume()
      .then((result: { volume: number }) => {
        const sysVol = result.volume ?? 1;
        setVolume(sysVol);
        volumeRef.current = sysVol;
      })
      .catch(() => {});

    const volSub = VolumeManager.addVolumeListener((result: { volume: number }) => {
      setVolume(result.volume);
      volumeRef.current = result.volume;
    });
    return () => volSub?.remove?.();
  }, []);

  useEffect(() => {
    brightnessRef.current = brightness;
  }, [brightness]);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  useEffect(() => {
    const bootstrap = async () => {
      let resolvedUrl = String(params.url || '');

      if (mode === 'series' && params.playlistKey) {
        const loaded = await loadSeriesPlaylist(String(params.playlistKey));
        setPlaylist(loaded);
        const currentIndex = Number(params.playlistIndex || 0);
        const item = loaded[currentIndex];

        if (item) {
          const nextUrl = await buildSeriesEpisodeUrl(item.episodeId, item.extension || 'mp4');
          resolvedUrl = nextUrl || '';
        }

        const nextItem = loaded[currentIndex + 1];
        if (nextItem?.episodeId) {
          buildSeriesEpisodeUrl(nextItem.episodeId, nextItem.extension || 'mp4')
            .then((nextEpisodeUrl) => {
              if (nextEpisodeUrl) {
                prefetchedEpisodeUrlRef.current[currentIndex + 1] = nextEpisodeUrl;
              }
            })
            .catch(() => {
              // Falha de prefetch nao deve interromper bootstrap.
            });
        }
      }

      if (!resolvedUrl) {
        router.back();
        return;
      }

      Brightness.getBrightnessAsync()
        .then((current) => {
          setBrightness(current || 0.6);
        })
        .catch(() => {
          // Continua com brilho padrao quando nao for possivel ler o brilho atual.
        });

      const isSameSource = resolvedUrl === sourceUrl && sourceUrl.length > 0;
      playRetryCountRef.current = 0;

      if (!isSameSource) {
        setSourceUrl(resolvedUrl);
        liveUrlRetryRef.current = false;
        setIsLoading(true);
        setIsPlaybackRequested(true);
        setHasFirstFrame(false);
      } else {
        setIsLoading(false);
        setIsPlaybackRequested(true);
        setHasFirstFrame(true);
      }

      const startPosition = Number(params.startPositionMs || 0);
      pendingStartPositionMsRef.current =
        !isSameSource && startPosition > 0 && mode !== 'live' ? startPosition : 0;

      if (pendingStartPositionMsRef.current > 0) {
        setTimeout(async () => {
          try {
            playbackPlayer.currentTime = pendingStartPositionMsRef.current / 1000;
            pendingStartPositionMsRef.current = 0;
          } catch {
            // Ignora se o video ainda nao estiver pronto; sourceLoad tentara novamente.
          }
        }, 250);
      }
    };

    bootstrap();

    return () => {
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') {
        persistExactProgress();
      }
      setAppState(nextState);
    });

    return () => {
      persistExactProgress();
      subscription.remove();
    };
  }, [mode, contentId, seriesId, playlist, playlistIndex]);

  useEffect(() => {
    return () => {
      if (sourceStallTimerRef.current) {
        clearTimeout(sourceStallTimerRef.current);
        sourceStallTimerRef.current = null;
      }

      if (keepPlaybackOnExitRef.current) {
        return;
      }

      setIsPlaybackRequested(false);
      clearMiniPlayerState();

      try {
        playbackPlayer.pause();
      } catch {
        // Ignora falhas ao pausar durante desmontagem da tela.
      }
    };
  }, [playbackPlayer]);

  useEffect(() => {
    const lockLandscape = async () => {
      try {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
      } catch {
        // Ignora quando o dispositivo nao permite lock de orientacao.
      }
    };

    lockLandscape();

    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {
        // Ignora falha ao restaurar retrato ao sair do player.
      });
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const enableImmersive = async () => {
      try {
        await NavigationBar.setPositionAsync('absolute');
        await NavigationBar.setBackgroundColorAsync('#00000000');
        await NavigationBar.setBehaviorAsync('overlay-swipe');
        await NavigationBar.setVisibilityAsync('hidden');
      } catch {
        // Ignora dispositivos sem suporte ao controle de navigation bar.
      }
    };

    enableImmersive();

    return () => {
      NavigationBar.setVisibilityAsync('visible').catch(() => {
        // Ignora falha ao restaurar barra de navegacao.
      });
    };
  }, []);

  useEffect(() => {
    if (!hasFirstFrame || hasShownGestureTutorialRef.current) return;
    hasShownGestureTutorialRef.current = true;
    setShowGestureTutorial(true);
  }, [hasFirstFrame]);

  // ── Presença real-time: reportar conteúdo que está assistindo ──
  useEffect(() => {
    if (!hasFirstFrame) return;

    const title = String(params.title || '');
    const cid = contentId || seriesId;
    if (!cid || !title) return;

    const type = mode === 'live' ? 'live' : mode === 'series' ? 'series' : 'movie';

    // Verifica se o conteúdo está bloqueado pelos pais
    isContentBlocked(cid).then((blocked) => {
      if (blocked) {
        Alert.alert(
          'Conteúdo bloqueado',
          'Este conteúdo foi bloqueado pelos responsáveis.',
          [{ text: 'Voltar', onPress: () => router.back() }],
          { cancelable: false }
        );
        return;
      }
      reportWatching(cid, title, type);
    });

    return () => {
      reportStoppedWatching();
    };
  }, [hasFirstFrame]);

  // ── Presença real-time: receber comando de bloqueio em tempo real ──
  useEffect(() => {
    const unsub = onContentBlocked(({ contentId: blockedId }) => {
      const cid = contentId || seriesId;
      if (blockedId && cid && blockedId === cid) {
        Alert.alert(
          'Conteúdo bloqueado',
          'Um responsável bloqueou este conteúdo.',
          [{ text: 'Voltar', onPress: () => router.back() }],
          { cancelable: false }
        );
      }
    });
    return () => { unsub(); };
  }, [contentId, seriesId, router]);

  useEffect(() => {
    const currentPosition = status.positionMillis || 0;
    const currentDuration = status.durationMillis || 0;

    if (mode !== 'movie' || !contentId || !currentDuration || !currentPosition) return;
    const currentSecond = Math.floor(currentPosition / 1000);
    if (currentSecond % 5 !== 0 || currentSecond === lastSavedSecondRef.current || persistTickInFlightRef.current) {
      return;
    }

    lastSavedSecondRef.current = currentSecond;
    persistTickInFlightRef.current = true;
    const progressPercent = Math.min(100, Math.round((currentPosition / currentDuration) * 100));

    Promise.all([
      updateMovieProgress(contentId, currentPosition, currentDuration),
      recordWatchSignal({
        contentId,
        type: 'movie',
        progressPercent,
        positionMs: currentPosition,
        durationMs: currentDuration,
      }),
    ]).finally(() => {
      persistTickInFlightRef.current = false;
    });
  }, [mode, contentId, status.positionMillis, status.durationMillis]);

  useEffect(() => {
    const currentPosition = status.positionMillis || 0;
    const currentDuration = status.durationMillis || 0;

    if (mode !== 'series' || !seriesId || !currentDuration || !currentPosition) return;
    const currentEpisode = playlist[playlistIndex];
    if (!currentEpisode) return;

    const currentSecond = Math.floor(currentPosition / 1000);
    if (currentSecond % 5 !== 0 || currentSecond === lastSavedSecondRef.current || persistTickInFlightRef.current) {
      return;
    }

    lastSavedSecondRef.current = currentSecond;
    persistTickInFlightRef.current = true;
    const progress = Math.min(100, Math.round((currentPosition / currentDuration) * 100));

    Promise.all([
      updateEpisodeProgress(
        seriesId,
        currentEpisode.seasonNumber,
        currentEpisode.episodeNumber,
        progress,
        currentPosition,
        currentDuration
      ),
      recordWatchSignal({
        contentId: seriesId,
        type: 'series',
        progressPercent: progress,
        positionMs: currentPosition,
        durationMs: currentDuration,
      }),
    ]).finally(() => {
      persistTickInFlightRef.current = false;
    });
  }, [mode, seriesId, playlist, playlistIndex, status.positionMillis, status.durationMillis]);

  useEffect(() => {
    if (!showControls || isLocked) return;
    const timer = setTimeout(() => setShowControls(false), 5000);
    return () => clearTimeout(timer);
  }, [showControls, isLocked, status.positionMillis]);

  useEffect(() => {
    if (nextCountdown === null) return;
    if (nextCountdown <= 0) {
      setNextCountdown(null);
      goNextEpisode();
      return;
    }

    const timer = setTimeout(() => setNextCountdown((prev) => (prev === null ? null : prev - 1)), 1000);
    return () => clearTimeout(timer);
  }, [nextCountdown]);

  const duration = status.durationMillis || 0;
  const position = status.positionMillis || 0;
  const progress = duration > 0 ? position / duration : 0;

  useEffect(() => {
    latestPositionRef.current = position;
    latestDurationRef.current = duration;
  }, [position, duration]);

  const hasNextEpisode = mode === 'series' && playlistIndex < playlist.length - 1;

  const currentEpisodeLabel = useMemo(() => {
    if (mode !== 'series' || !playlist.length) return '';
    const item = playlist[playlistIndex];
    if (!item) return '';
    return `S${item.seasonNumber} • E${item.episodeNumber}`;
  }, [mode, playlist, playlistIndex]);

  const showSkipIntro =
    mode === 'series' &&
    !isLocked &&
    !skippedIntroByEpisode[playlistIndex] &&
    position > 0 &&
    position < Math.min(duration * 0.2, 90_000);

  const togglePlay = async () => {
    if (isLocked) return;
    if (status.isPlaying) {
      setIsPlaybackRequested(false);
      await safeRunPlayback(async () => {
        playbackPlayer.pause();
      });
      return;
    }

    setIsPlaybackRequested(true);
    await safeRunPlayback(async () => {
      playbackPlayer.play();
    });
  };

  const seekTo = async (value: number) => {
    if (isLocked || mode === 'live') return;
    const currentDuration = latestDurationRef.current;
    if (!currentDuration) return;

    setIsSeeking(true);
    try {
      playbackPlayer.currentTime = (value * currentDuration) / 1000;
    } finally {
      setTimeout(() => setIsSeeking(false), 250);
    }
  };

  const seekRelative = async (deltaMs: number, side: Side) => {
    if (isLocked || mode === 'live') return;
    const currentDuration = latestDurationRef.current;
    const currentPosition = latestPositionRef.current;
    const nextPos = Math.max(0, Math.min(currentDuration, currentPosition + deltaMs));
    setIsSeeking(true);
    try {
      playbackPlayer.currentTime = nextPos / 1000;
    } finally {
      setTimeout(() => setIsSeeking(false), 250);
    }
    setSkipHint({ side, text: deltaMs > 0 ? '+10s' : '-10s' });
    setTimeout(() => setSkipHint(null), 700);
  };

  const handleTapSide = (side: Side) => {
    if (isLocked) return;

    const now = Date.now();
    const lastTap = doubleTapRef.current[side];

    if (mode !== 'live' && now - lastTap <= 250) {
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
      }
      doubleTapRef.current[side] = 0;
      seekRelative(side === 'left' ? -10000 : 10000, side);
      return;
    }

    doubleTapRef.current[side] = now;

    if (singleTapTimerRef.current) {
      clearTimeout(singleTapTimerRef.current);
    }

    singleTapTimerRef.current = setTimeout(() => {
      toggleControlsByTap();
    }, 180);
  };

  const setPlayerVolume = (value: number) => {
    const nextValue = Math.max(0, Math.min(1, value));
    setVolume(nextValue);
    volumeRef.current = nextValue;
    try {
      if (nextValue > 0 && playbackPlayer.muted) {
        playbackPlayer.muted = false;
      }
      if (nextValue > 0 && audioMode === 'Mudo') {
        setAudioMode('Stereo');
      }
      playbackPlayer.volume = audioMode === 'Mono' ? Math.min(0.8, nextValue) : nextValue;
      if (VolumeManager?.setVolume) {
        VolumeManager.setVolume(nextValue, { showUI: true, type: 'music' }).catch(() => {});
      }
    } catch {
      // Ignora falha de volume em alguns players/dispositivos.
    }
  };

  const setPlayerBrightness = (value: number) => {
    const nextValue = Math.max(0.1, Math.min(1, value));
    setBrightness(nextValue);
    brightnessRef.current = nextValue;
    Brightness.setBrightnessAsync(nextValue).catch(() => {
      // Ignora se o dispositivo nao permitir ajustar brilho por app.
    });
  };

  const openFullscreen = async () => {
    // Mantemos fullscreen customizado no proprio layout para preservar controles personalizados.
    return;
  };

  const openPip = async () => {
    if (isLocked) return;
    if (!canUsePip) {
      router.push('/assinar?feature=pip');
      return;
    }

    if (Platform.OS === 'android') {
      if (!sourceUrl) return;

      keepPlaybackOnExitRef.current = true;

      await persistExactProgress();
      setMiniPlayerState({
        mode,
        title: String(params.title || 'Player'),
        url: sourceUrl,
        contentId: contentId || undefined,
        seriesId: seriesId || undefined,
        playlistKey: params.playlistKey ? String(params.playlistKey) : undefined,
        playlistIndex,
        positionMs: latestPositionRef.current,
      });

      setIsPlaybackRequested(false);
      router.back();
      return;
    }

    try {
      setPipRequiresHomeFallback(false);
      await videoViewRef.current?.startPictureInPicture();
    } catch {
      setPipRequiresHomeFallback(true);
      Alert.alert(
        'Falha ao iniciar PiP',
        'Nao foi possivel iniciar o PiP em miniatura agora. Se seu aparelho suportar PiP automatico, use o botao Home com o video tocando.'
      );
    }
  };

  const toggleQuickFillMode = () => {
    if (screenMode === 'Preencher') {
      setScreenMode('Auto');
      return;
    }

    setScreenMode('Preencher');
    if (zoomLevel === '100%') {
      setZoomLevel('115%');
    }
  };

  const applyAudioMode = async (modeValue: AudioMode) => {
    setAudioMode(modeValue);

    if (modeValue === 'Mudo') {
      playbackPlayer.muted = true;
      return;
    }

    playbackPlayer.muted = false;
    playbackPlayer.volume = modeValue === 'Mono' ? Math.min(0.8, volume) : volume;
  };

  const goNextEpisode = async () => {
    if (mode !== 'series') return;
    const nextIndex = playlistIndex + 1;
    const nextItem = playlist[nextIndex];
    if (!nextItem) return;

    const prefetchedUrl = prefetchedEpisodeUrlRef.current[nextIndex];
    const nextUrl =
      prefetchedUrl ||
      (await buildSeriesEpisodeUrl(nextItem.episodeId, nextItem.extension || 'mp4'));
    if (!nextUrl) return;

    setPlaylistIndex(nextIndex);
    lastSavedSecondRef.current = -1;
    playRetryCountRef.current = 0;
    setIsPlaybackRequested(true);
    setSourceUrl(nextUrl);
    setHasFirstFrame(false);
    setNextCountdown(null);
    setShowControls(true);
    setIsLoading(true);
  };

  const cancelAutoplay = () => setNextCountdown(null);

  const skipIntro = async () => {
    if (mode !== 'series' || isLocked) return;
    const target = Math.min(duration > 0 ? duration - 1000 : 90_000, 90_000);
    playbackPlayer.currentTime = target / 1000;
    setSkippedIntroByEpisode((prev) => ({ ...prev, [playlistIndex]: true }));
    setGestureHint('Abertura pulada');
    setTimeout(() => setGestureHint(null), 800);
  };

  const inferContentType = (url: string) => {
    const cleanUrl = url.toLowerCase().split('?')[0];
    if (cleanUrl.endsWith('.m3u8')) return 'application/x-mpegURL';
    if (cleanUrl.endsWith('.mpd')) return 'application/dash+xml';
    if (cleanUrl.endsWith('.mov')) return 'video/quicktime';
    if (cleanUrl.endsWith('.webm')) return 'video/webm';
    return 'video/mp4';
  };

  const requestCast = async () => {
    if (!sourceUrl || isLocked) return;
    if (!canUseCastMirror) {
      router.push('/assinar?feature=cast_mirror');
      return;
    }

    if (!GoogleCast?.showCastDialog) {
      Alert.alert('Cast indisponivel', 'Este build nao tem suporte ao Google Cast.');
      return;
    }

    setPendingCastLoad(true);

    if (remoteMediaClient) {
      return;
    }

    const shown = await GoogleCast.showCastDialog();
    if (!shown) {
      setPendingCastLoad(false);
      Alert.alert('Sem dispositivos', 'Nenhum dispositivo compativel foi encontrado para espelhamento/cast.');
    }
  };

  useEffect(() => {
    if (!pendingCastLoad || !remoteMediaClient || !sourceUrl) return;

    const loadOnCast = async () => {
      try {
        await remoteMediaClient.loadMedia({
          autoplay: true,
          startTime: mode === 'live' ? 0 : Math.floor(position / 1000),
          mediaInfo: {
            contentUrl: sourceUrl,
            contentType: inferContentType(sourceUrl),
            streamType: mode === 'live' ? MediaStreamType.LIVE : MediaStreamType.BUFFERED,
            metadata: {
              type: mode === 'series' ? 'tvShow' : 'movie',
              title: String(params.title || 'Player'),
              subtitle: currentEpisodeLabel || undefined,
            },
          },
        });

        setGestureHint('Transmitindo para TV');
        setTimeout(() => setGestureHint(null), 900);
        setIsPlaybackRequested(false);
        playbackPlayer.pause();
      } catch (error) {
        const message = String((error as any)?.message || error || 'Falha ao iniciar transmissao.');
        Alert.alert('Falha no cast', message);
      } finally {
        setPendingCastLoad(false);
      }
    };

    loadOnCast();
  }, [pendingCastLoad, remoteMediaClient, sourceUrl, mode, position, params.title, currentEpisodeLabel]);

  useEffect(() => {
    if (sourceStallTimerRef.current) {
      clearTimeout(sourceStallTimerRef.current);
      sourceStallTimerRef.current = null;
    }

    if (mode !== 'live' || !sourceUrl || hasFirstFrame || !isPlaybackRequested || !isAppActive) {
      return;
    }

    // Se live demorar para renderizar o primeiro frame, tenta fallback de extensao cedo.
    sourceStallTimerRef.current = setTimeout(() => {
      tryLiveFallbackSource('Tentando formato alternativo...');
      sourceStallTimerRef.current = null;
    }, 3600);

    return () => {
      if (sourceStallTimerRef.current) {
        clearTimeout(sourceStallTimerRef.current);
        sourceStallTimerRef.current = null;
      }
    };
  }, [mode, sourceUrl, hasFirstFrame, isPlaybackRequested, isAppActive]);

  useEffect(() => {
    if (mode !== 'series') {
      return;
    }

    const nextIndex = playlistIndex + 1;
    const nextItem = playlist[nextIndex];
    if (!nextItem || prefetchedEpisodeUrlRef.current[nextIndex]) {
      return;
    }

    buildSeriesEpisodeUrl(nextItem.episodeId, nextItem.extension || 'mp4')
      .then((nextUrl) => {
        if (nextUrl) {
          prefetchedEpisodeUrlRef.current[nextIndex] = nextUrl;
        }
      })
      .catch(() => {
        // Prefetch falhou. O goNextEpisode resolve sob demanda.
      });
  }, [mode, playlist, playlistIndex]);

  useEffect(() => {
    if (!sourceUrl) return;

    const subs = [
      playbackPlayer.addListener('statusChange', ({ status: playerStatus, error }: any) => {
        setStatus((prev) => ({
          ...prev,
          isLoaded: playerStatus !== 'idle',
          isBuffering: playerStatus === 'loading',
        }));

        if (playerStatus === 'error' && error?.message) {
          const message = String(error.message || '');

          if (tryLiveFallbackSource('Tentando formato alternativo...')) {
            return;
          }

          setIsLoading(false);
          // Erros de Activity ou keep-awake são não-fatais; não exibir alerta ao usuário.
          if (!isNonFatalPlayerError(message)) {
            Alert.alert('Erro no player', message);
          }
        }
      }),
      playbackPlayer.addListener('playingChange', ({ isPlaying }: any) => {
        if (isPlaying) {
          playRetryCountRef.current = 0;
        }
        setStatus((prev) => ({ ...prev, isPlaying }));
      }),
      playbackPlayer.addListener('sourceLoad', ({ duration: loadedDuration }: any) => {
        if (pendingStartPositionMsRef.current > 0 && mode !== 'live') {
          try {
            playbackPlayer.currentTime = pendingStartPositionMsRef.current / 1000;
          } catch {
            // Ignora quando ainda nao for possivel ajustar posicao neste instante.
          } finally {
            pendingStartPositionMsRef.current = 0;
          }
        }

        setStatus((prev) => ({
          ...prev,
          isLoaded: true,
          durationMillis: Math.floor(loadedDuration * 1000),
        }));
        setHasFirstFrame(true);
        setIsLoading(false);

        if (isPlaybackRequested) {
          requestPlayNow();
        }
      }),
      playbackPlayer.addListener('timeUpdate', ({ currentTime, bufferedPosition }: any) => {
        const durationSeconds = Number.isFinite(playbackPlayer.duration)
          ? Math.max(0, playbackPlayer.duration)
          : 0;
        const nextPositionMillis = Math.floor(currentTime * 1000);
        const nextDurationMillis = Math.floor(durationSeconds * 1000);

        setStatus((prev) => ({
          ...prev,
          isLoaded: true,
          durationMillis: nextDurationMillis,
          positionMillis: nextPositionMillis,
          isBuffering: bufferedPosition > -1 && bufferedPosition <= currentTime,
          didJustFinish: false,
        }));

        if (nextPositionMillis > 0) {
          setHasFirstFrame(true);
          setIsLoading(false);
        }
      }),
      playbackPlayer.addListener('playToEnd', () => {
        setStatus((prev) => ({ ...prev, didJustFinish: true }));
        if (mode === 'series' && hasNextEpisode) {
          setNextCountdown(8);
        }
      }),
    ];

    return () => {
      subs.forEach((sub) => sub.remove());
    };
  }, [playbackPlayer, sourceUrl, mode, hasNextEpisode]);

  useEffect(() => {
    if (castState === CastState.CONNECTED) {
      setGestureHint('Dispositivo de TV conectado');
      setTimeout(() => setGestureHint(null), 900);
    }
  }, [castState]);

  const makeSideResponder = (side: Side) =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => !isLocked,
      onMoveShouldSetPanResponder: (_, gesture) => !isLocked && Math.abs(gesture.dy) > 8,
      onPanResponderGrant: () => {
        gestureBaseRef.current[side] = side === 'left' ? brightnessRef.current : volumeRef.current;
      },
      onPanResponderMove: (_, gesture) => {
        if (isLocked) return;
        const delta = -gesture.dy / 300;
        const next = Math.max(0, Math.min(1, gestureBaseRef.current[side] + delta));

        if (side === 'left') {
          setPlayerBrightness(next);
          setGestureHint(`Brilho ${Math.round(next * 100)}%`);
        } else {
          setPlayerVolume(next);
          setGestureHint(`Volume ${Math.round(next * 100)}%`);
        }
      },
      onPanResponderRelease: (_, gesture) => {
        if (Math.abs(gesture.dy) <= 8) {
          handleTapSide(side);
        }
        setTimeout(() => setGestureHint(null), 700);
      },
      onPanResponderTerminate: () => {
        setTimeout(() => setGestureHint(null), 700);
      },
    });

  const zoomScale = useMemo(() => {
    if (zoomLevel === '145%') return 1.45;
    if (zoomLevel === '130%') return 1.3;
    if (zoomLevel === '115%') return 1.15;
    return 1;
  }, [zoomLevel]);

  const isFillMode = screenMode === 'Preencher' || zoomScale > 1;

  const videoViewportStyle = useMemo(() => {
    if (screenMode === 'Preencher') {
      return styles.videoViewportAuto;
    }

    if (screenMode === '4:3') {
      return [styles.videoViewportAspectBase, { aspectRatio: 4 / 3 }] as const;
    }

    if (screenMode === '16:9') {
      return [styles.videoViewportAspectBase, { aspectRatio: 16 / 9 }] as const;
    }

    if (screenMode === '16:10') {
      return [styles.videoViewportAspectBase, { aspectRatio: 16 / 10 }] as const;
    }

    if (screenMode === '21:9') {
      return [styles.videoViewportAspectBase, { aspectRatio: 21 / 9 }] as const;
    }

    return styles.videoViewportAuto;
  }, [screenMode]);

  const leftResponder = useMemo(() => makeSideResponder('left'), [isLocked, mode]);
  const rightResponder = useMemo(() => makeSideResponder('right'), [isLocked, mode]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar hidden />
      <AppBackdrop blurIntensity={28} />

      <View style={styles.playerArea}>
        <View style={[styles.videoViewport, videoViewportStyle]}>
          {player ? (
            <VideoView
              ref={videoViewRef}
              player={player}
              style={[styles.video, isFillMode && { transform: [{ scale: zoomScale }] }]}
              nativeControls={false}
              contentFit={isFillMode ? 'cover' : 'contain'}
              allowsPictureInPicture={canUsePip}
              startsPictureInPictureAutomatically={false}
              onFirstFrameRender={() => {
                setHasFirstFrame(true);
                setIsLoading(false);
              }}
              onPictureInPictureStart={() => {
                setGestureHint('PiP ativo');
                setTimeout(() => setGestureHint(null), 700);
              }}
              onPictureInPictureStop={() => {
                setGestureHint('PiP encerrado');
                setTimeout(() => setGestureHint(null), 700);
              }}
            />
          ) : (
            <View style={styles.video} />
          )}
        </View>

        <View style={styles.tapZones} pointerEvents="box-none">
          <View style={styles.tapZone} {...leftResponder.panHandlers} />
          <View style={styles.tapZone} {...rightResponder.panHandlers} />
        </View>
      </View>

      <PageLoader visible={isLoading && !hasFirstFrame} label="Iniciando player" />

      {(isSeeking || (!!status.isBuffering && !isLoading && !status.isPlaying)) && (
        <View style={styles.miniLoadingOverlay} pointerEvents="none">
          <View style={styles.miniLoadingCard}>
            <ActivityIndicator size="small" color={StreamingTheme.colors.textPrimary} />
            <Text style={styles.miniLoadingText}>Carregando...</Text>
          </View>
        </View>
      )}

      {skipHint && <View style={styles.skipHint}><Text style={styles.skipHintText}>{skipHint.text}</Text></View>}
      {gestureHint && <View style={styles.gestureHint}><Text style={styles.gestureHintText}>{gestureHint}</Text></View>}

      {showGestureTutorial && !isLocked && (
        <View style={styles.gestureTutorialCard}>
          <View style={styles.gestureTutorialHeader}>
            <Text style={styles.gestureTutorialTitle}>Gestos do player</Text>
            <TouchableOpacity onPress={() => setShowGestureTutorial(false)}>
              <MaterialIcons name="close" size={16} color={StreamingTheme.colors.textPrimary} />
            </TouchableOpacity>
          </View>
          <Text style={styles.gestureTutorialLine}>Esquerda: deslize vertical para brilho</Text>
          <Text style={styles.gestureTutorialLine}>Direita: deslize vertical para volume</Text>
          <Text style={styles.gestureTutorialLine}>2 toques esquerda: voltar 10s</Text>
          <Text style={styles.gestureTutorialLine}>2 toques direita: avancar 10s</Text>
        </View>
      )}

      {showSkipIntro && (
        <TouchableOpacity style={styles.skipIntroBtn} onPress={skipIntro}>
          <MaterialIcons name="fast-forward" size={18} color={StreamingTheme.colors.textPrimary} />
          <Text style={styles.skipIntroText}>Pular abertura</Text>
        </TouchableOpacity>
      )}

      {isLocked ? (
        <TouchableOpacity style={styles.unlockBtn} onPress={() => setIsLocked(false)}>
          <MaterialIcons name="lock-open" size={22} color={StreamingTheme.colors.textPrimary} />
        </TouchableOpacity>
      ) : (
        showControls && (
          <View style={styles.controlsLayer} pointerEvents="box-none">
            <View style={styles.topBar}>
              <TouchableOpacity style={styles.iconBtn} onPress={closePlayerAndExit}>
                <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
              </TouchableOpacity>
              <View style={styles.titleWrap}>
                <Text style={styles.titleText} numberOfLines={1}>
                  {String(params.title || 'Player')}
                </Text>
                {!!currentEpisodeLabel && <Text style={styles.subTitle}>{currentEpisodeLabel}</Text>}
              </View>
              <TouchableOpacity style={styles.iconBtn} onPress={() => setIsLocked(true)}>
                <MaterialIcons name="lock" size={20} color={StreamingTheme.colors.textPrimary} />
              </TouchableOpacity>
            </View>

            <View style={styles.centerControls}>
              <TouchableOpacity style={styles.mainAction} onPress={togglePlay}>
                <MaterialIcons
                  name={status.isPlaying ? 'pause' : 'play-arrow'}
                  size={44}
                  color={StreamingTheme.colors.textPrimary}
                />
              </TouchableOpacity>

              {hasNextEpisode && (
                <TouchableOpacity style={styles.nextBtn} onPress={goNextEpisode}>
                  <MaterialIcons name="skip-next" size={24} color={StreamingTheme.colors.textPrimary} />
                  <Text style={styles.nextText}>Proximo episodio</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.bottomPanel}>
              {mode !== 'live' && (
                <>
                  {isScrubbing && (
                    <View style={styles.scrubPreviewCard}>
                      <MaterialIcons name="preview" size={16} color={StreamingTheme.colors.textPrimary} />
                      <Text style={styles.scrubPreviewText}>{formatMs(scrubPreviewMs)}</Text>
                    </View>
                  )}
                  <Slider
                    value={progress}
                    onSlidingStart={() => {
                      setIsScrubbing(true);
                      setScrubPreviewMs(position);
                    }}
                    onValueChange={(value) => {
                      if (!duration) return;
                      setScrubPreviewMs(Math.floor(value * duration));
                    }}
                    onSlidingComplete={async (value) => {
                      await seekTo(value);
                      setIsScrubbing(false);
                    }}
                    minimumValue={0}
                    maximumValue={1}
                    minimumTrackTintColor={StreamingTheme.colors.accent}
                    maximumTrackTintColor="rgba(255,255,255,0.2)"
                    thumbTintColor={StreamingTheme.colors.textPrimary}
                  />
                  <View style={styles.timeRow}>
                    <Text style={styles.timeText}>{formatMs(position)}</Text>
                    <Text style={styles.timeText}>{formatMs(duration)}</Text>
                  </View>
                </>
              )}

              <View style={styles.actionsRow}>
                {canUsePip && (
                  <TouchableOpacity style={styles.actionBtn} onPress={openPip}>
                    <MaterialIcons name="picture-in-picture-alt" size={20} color={StreamingTheme.colors.textPrimary} />
                    <Text style={styles.actionLabel}>{Platform.OS === 'android' ? 'Mini app' : 'PiP'}</Text>
                  </TouchableOpacity>
                )}
                {canUseCastMirror && (
                  <TouchableOpacity style={styles.actionBtn} onPress={requestCast}>
                    <MaterialIcons
                      name={castState === CastState.CONNECTED ? 'cast-connected' : 'cast'}
                      size={20}
                      color={StreamingTheme.colors.textPrimary}
                    />
                    <Text style={styles.actionLabel}>Espelhar TV</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[styles.actionBtn, screenMode === 'Preencher' && styles.optionChipActive]}
                  onPress={toggleQuickFillMode}>
                  <MaterialIcons
                    name={screenMode === 'Preencher' ? 'crop-free' : 'fit-screen'}
                    size={20}
                    color={StreamingTheme.colors.textPrimary}
                  />
                  <Text style={styles.actionLabel}>{screenMode === 'Preencher' ? 'Auto' : 'Preencher'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={() => setShowSettings((prev) => !prev)}>
                  <MaterialIcons name="tune" size={20} color={StreamingTheme.colors.textPrimary} />
                  <Text style={styles.actionLabel}>Opcoes</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={() => setShowGestureTutorial(true)}>
                  <MaterialIcons name="touch-app" size={20} color={StreamingTheme.colors.textPrimary} />
                  <Text style={styles.actionLabel}>Gestos</Text>
                </TouchableOpacity>
              </View>

              {Platform.OS === 'ios' && canUseCastMirror && (
                <View style={styles.airplayRow}>
                  <VideoAirPlayButton
                    style={styles.airplayBtn}
                    prioritizeVideoDevices
                    activeTint={StreamingTheme.colors.accent}
                    tint={StreamingTheme.colors.textPrimary}
                  />
                  <Text style={styles.airplayLabel}>AirPlay</Text>
                </View>
              )}

              {pipRequiresHomeFallback && (
                <View style={styles.pipFallbackHint}>
                  <MaterialIcons name="home" size={14} color={StreamingTheme.colors.textMuted} />
                  <Text style={styles.pipFallbackHintText}>PiP via Home (video tocando)</Text>
                </View>
              )}
            </View>
          </View>
        )
      )}

      <Modal visible={showSettings} transparent animationType="fade" onRequestClose={() => setShowSettings(false)}>
        <TouchableOpacity style={styles.settingsBackdrop} activeOpacity={1} onPress={() => setShowSettings(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.settingsModalCard} onPress={() => {}}>
            <View style={styles.settingsModalHeader}>
              <Text style={styles.settingsModalTitle}>Opcoes do player</Text>
              <TouchableOpacity style={styles.iconBtn} onPress={() => setShowSettings(false)}>
                <MaterialIcons name="close" size={18} color={StreamingTheme.colors.textPrimary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.settingsScroll}
              contentContainerStyle={styles.settingsScrollContent}
              showsVerticalScrollIndicator={false}>
              <Text style={styles.settingsTitle}>Qualidade</Text>
              <OptionRow
                options={['Auto', 'Alta', 'Media', 'Baixa']}
                selected={quality}
                onSelect={(value) => setQuality(value as Quality)}
              />

              <Text style={styles.settingsTitle}>Audio</Text>
              <OptionRow
                options={['Stereo', 'Mono', 'Mudo']}
                selected={audioMode}
                onSelect={(value) => applyAudioMode(value as AudioMode)}
              />

              <Text style={styles.settingsTitle}>Legenda</Text>
              <OptionRow
                options={['Desligada', 'Auto']}
                selected={subtitleMode}
                onSelect={(value) => setSubtitleMode(value as SubtitleMode)}
              />

              <Text style={styles.settingsTitle}>Proporcao</Text>
              <OptionRow
                options={['Auto', '4:3', '16:9', '16:10', '21:9', 'Preencher']}
                selected={screenMode}
                onSelect={(value) => {
                  setScreenMode(value as ScreenMode);
                  if (value === 'Preencher' && zoomLevel === '100%') {
                    setZoomLevel('115%');
                  }
                }}
              />

              <Text style={styles.settingsTitle}>Zoom (preencher tarjas)</Text>
              <OptionRow
                options={['100%', '115%', '130%', '145%']}
                selected={zoomLevel}
                onSelect={(value) => {
                  const next = value as ZoomLevel;
                  setZoomLevel(next);
                  if (next !== '100%' && screenMode !== 'Preencher') {
                    setScreenMode('Preencher');
                  }
                }}
              />

              <Text style={styles.settingsFoot}>
                Qualidade e legenda funcionam conforme suporte da fonte de video.
              </Text>
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {nextCountdown !== null && hasNextEpisode && (
        <View style={styles.autoplayCard}>
          <Text style={styles.autoplayTitle}>Proximo episodio em {nextCountdown}s</Text>
          <View style={styles.autoplayActions}>
            <TouchableOpacity style={styles.autoplayBtn} onPress={cancelAutoplay}>
              <Text style={styles.autoplayBtnText}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.autoplayBtn, styles.autoplayBtnStrong]} onPress={goNextEpisode}>
              <Text style={[styles.autoplayBtnText, styles.autoplayBtnTextStrong]}>Reproduzir agora</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {subtitleMode === 'Auto' && mode === 'series' && !isLocked && showControls && (
        <View style={styles.subtitleHint}>
          <Text style={styles.subtitleHintText}>Legenda: auto (quando disponivel)</Text>
        </View>
      )}

      {canUseCastMirror && !!GoogleCast && <CastButton style={styles.hiddenCastBtn} />}
    </SafeAreaView>
  );
}

function OptionRow({
  options,
  selected,
  onSelect,
}: {
  options: string[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  return (
    <View style={styles.optionRow}>
      {options.map((option) => {
        const active = option === selected;
        return (
          <TouchableOpacity
            key={option}
            style={[styles.optionChip, active && styles.optionChipActive]}
            onPress={() => onSelect(option)}
          >
            <Text style={[styles.optionText, active && styles.optionTextActive]}>{option}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  playerArea: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoViewport: {
    width: '100%',
    alignSelf: 'center',
  },
  videoViewportAuto: {
    width: '100%',
    height: '100%',
  },
  videoViewportAspectBase: {
    width: '100%',
    maxHeight: '100%',
  },
  video: {
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
  },
  tapZones: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
  },
  tapZone: {
    flex: 1,
  },
  controlsLayer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    backgroundColor: 'rgba(0,0,0,0.42)',
    padding: 14,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: 'rgba(16,21,37,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleWrap: {
    flex: 1,
  },
  titleText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  subTitle: {
    color: StreamingTheme.colors.textSecondary,
    marginTop: 2,
    fontSize: 12,
  },
  centerControls: {
    alignItems: 'center',
    gap: 14,
  },
  mainAction: {
    width: 86,
    height: 86,
    borderRadius: 50,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextBtn: {
    borderRadius: 999,
    backgroundColor: 'rgba(255,59,48,0.26)',
    borderWidth: 1,
    borderColor: 'rgba(255,59,48,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 5,
  },
  nextText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 12,
  },
  bottomPanel: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(16,21,37,0.82)',
    padding: 10,
    gap: 6,
  },
  scrubPreviewCard: {
    alignSelf: 'center',
    marginBottom: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(7,9,15,0.86)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  scrubPreviewText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 12,
  },
  timeRow: {
    marginTop: -4,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  timeText: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  slidersRow: {
    marginTop: 4,
    gap: 8,
  },
  sliderItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  actionsRow: {
    marginTop: 4,
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 5,
  },
  actionLabel: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 12,
  },
  airplayRow: {
    marginTop: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingVertical: 8,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  airplayBtn: {
    width: 20,
    height: 20,
  },
  airplayLabel: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 12,
  },
  pipFallbackHint: {
    marginTop: 4,
    alignSelf: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  pipFallbackHintText: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  gestureTutorialCard: {
    position: 'absolute',
    left: 12,
    right: 12,
    top: 56,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(16,21,37,0.9)',
    padding: 10,
    gap: 4,
  },
  gestureTutorialHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  gestureTutorialTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },
  gestureTutorialLine: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  settingsPanel: {
    marginTop: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    backgroundColor: 'rgba(7,9,15,0.85)',
    maxHeight: 220,
    overflow: 'hidden',
  },
  settingsScroll: {
    maxHeight: 220,
  },
  settingsScrollContent: {
    padding: 10,
    gap: 6,
  },
  settingsBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  settingsModalCard: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '70%',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(7,9,15,0.95)',
    overflow: 'hidden',
  },
  settingsModalHeader: {
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  settingsModalTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  settingsTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },
  optionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  optionChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  optionChipActive: {
    borderColor: 'rgba(255,59,48,0.55)',
    backgroundColor: 'rgba(255,59,48,0.24)',
  },
  optionText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  optionTextActive: {
    color: StreamingTheme.colors.textPrimary,
  },
  settingsFoot: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 10,
  },
  unlockBtn: {
    position: 'absolute',
    right: 16,
    top: 54,
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(16,21,37,0.8)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipHint: {
    position: 'absolute',
    top: '45%',
    alignSelf: 'center',
    borderRadius: 999,
    backgroundColor: 'rgba(16,21,37,0.8)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  skipHintText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 14,
  },
  gestureHint: {
    position: 'absolute',
    top: 96,
    alignSelf: 'center',
    borderRadius: 999,
    backgroundColor: 'rgba(16,21,37,0.82)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  gestureHintText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 12,
  },
  skipIntroBtn: {
    position: 'absolute',
    right: 16,
    bottom: 170,
    borderRadius: 999,
    backgroundColor: 'rgba(255,59,48,0.26)',
    borderWidth: 1,
    borderColor: 'rgba(255,59,48,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  skipIntroText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },
  autoplayCard: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
    width: '86%',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(16,21,37,0.88)',
    padding: 12,
    gap: 10,
  },
  autoplayTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 14,
    textAlign: 'center',
  },
  autoplayActions: {
    flexDirection: 'row',
    gap: 8,
  },
  autoplayBtn: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingVertical: 8,
    alignItems: 'center',
  },
  autoplayBtnStrong: {
    borderColor: 'rgba(255,59,48,0.5)',
    backgroundColor: 'rgba(255,59,48,0.24)',
  },
  autoplayBtnText: {
    color: StreamingTheme.colors.textSecondary,
    fontWeight: '700',
    fontSize: 12,
  },
  autoplayBtnTextStrong: {
    color: StreamingTheme.colors.textPrimary,
  },
  subtitleHint: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 100,
    alignItems: 'center',
  },
  subtitleHintText: {
    color: StreamingTheme.colors.textPrimary,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    fontSize: 12,
  },
  miniLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniLoadingCard: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(16,21,37,0.82)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  miniLoadingText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  hiddenCastBtn: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    top: 0,
    left: 0,
  },
});
