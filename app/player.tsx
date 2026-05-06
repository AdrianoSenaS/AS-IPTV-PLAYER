import { MaterialIcons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import * as Brightness from 'expo-brightness';
import { useKeepAwake } from 'expo-keep-awake';
import * as NavigationBar from 'expo-navigation-bar';
import { VideoAirPlayButton, VideoView, isPictureInPictureSupported, useVideoPlayer } from 'expo-video';

import * as ScreenOrientation from 'expo-screen-orientation';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  AppStateStatus,
  Keyboard,
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
import { getDbValue, setDbValue } from '@/services/local-db';
import { clearMiniPlayerState, setMiniPlayerState } from '@/services/mini-player';
import {
  isProxyEnabled,
  wrapUrlWithProxy,
  startProxyHeartbeat,
  stopProxyHeartbeat,
  closeProxySession,
} from '@/services/proxy-settings';
import { updateMovieProgress } from '@/services/movie-progress';
import { updateEpisodeProgress } from '@/services/series-progress';
import { loadSeriesPlaylist, PlaylistItem } from '@/services/series-playlist';
import { buildSeriesEpisodeUrl } from '@/services/stream-url';
import { coerceDurationMs } from '@/services/media-duration';
import { getAppServerUrl } from '@/services/app-server';
import { recordWatchSignal } from '@/services/taste-recommender';
import { isNonMobileDevice } from '@/services/device-profile';
import {
  isContentBlocked,
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
let useCastSession: any = () => null;
let useMediaStatus: any = () => null;

try {
  const castModule = require('react-native-google-cast');
  GoogleCast = castModule?.default || castModule;
  CastButton = castModule?.CastButton || (() => null);
  CastState = castModule?.CastState || CastState;
  MediaStreamType = castModule?.MediaStreamType || MediaStreamType;
  useCastState = castModule?.useCastState || useCastState;
  useRemoteMediaClient = castModule?.useRemoteMediaClient || useRemoteMediaClient;
  useCastSession = castModule?.useCastSession || useCastSession;
  useMediaStatus = castModule?.useMediaStatus || useMediaStatus;
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
const DEFAULT_QUALITY_OPTIONS: Quality[] = ['Auto', 'Alta', 'Media', 'Baixa'];

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

const GESTURE_TUTORIAL_PREF_KEY = 'player.gestureTutorial.enabled';
const MANUAL_RT_SYNC_MIN_DELTA_MS = 6000;
const DEFAULT_CAST_RECEIVER_APP_ID = 'CC1AD845';

const formatMs = (value: number) => {
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const toSafeNonNegativeNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
};

export default function PlayerScreen() {
  const router = useRouter();
  const lowOverheadMode = isNonMobileDevice();
  const { hasFeature, loading: planLoading } = usePlanGate();
  useKeepAwake();
  const params = useLocalSearchParams<{
    mode?: string;
    title?: string;
    url?: string;
    contentId?: string;
    seriesId?: string;
    posterUrl?: string;
    image?: string;
    startPositionMs?: string;
    durationMs?: string;
    playlistKey?: string;
    playlistIndex?: string;
    autoCast?: string;
    castPrep?: string;
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
  const liveRecoveryRef = useRef<{ lastAttemptAt: number; attempts: number; source: string }>({
    lastAttemptAt: 0,
    attempts: 0,
    source: '',
  });
  const movieUrlRetryCountRef = useRef(0);
  const hasShownGestureTutorialRef = useRef(false);
  const keepPlaybackOnExitRef = useRef(false);
  const lastSavedSecondRef = useRef(-1);
  const persistTickInFlightRef = useRef(false);
  const prefetchedEpisodeUrlRef = useRef<Record<number, string>>({});
  const sourceStallTimerRef = useRef<any>(null);
  const volumeSyncTimerRef = useRef<any>(null);
  const lastSystemVolumeRef = useRef(1);
  const lastVolumeWriteRef = useRef(0);
  const precastModePreviousVolumeRef = useRef(1);
  const lastCastVolumePushRef = useRef(-1);
  const blockedFlowHandledRef = useRef(false);
  const lastWatchingReportRef = useRef('');
  const liveLastProgressAtRef = useRef(0);
  const liveLastPositionMsRef = useRef(0);
  const autoCastHandledRef = useRef(false);
  const castConnectedToastTimerRef = useRef<any>(null);
  const wasCastConnectedRef = useRef(false);

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
  const [castVolume, setCastVolume] = useState(1);
  const [showCastConnectedToast, setShowCastConnectedToast] = useState(false);
  const [showGestureTutorial, setShowGestureTutorial] = useState(false);
  const [gestureTutorialEnabled, setGestureTutorialEnabled] = useState(true);
  const [networkStats, setNetworkStats] = useState<{ kbps: number; mbps: number; mbTotal: number; active: boolean; qualityLabel: string } | null>(null);
  const [availableQualityOptions, setAvailableQualityOptions] = useState<Quality[]>(DEFAULT_QUALITY_OPTIONS);

  const mode = String(params.mode || 'movie');
  const contentId = String(params.contentId || '');
  const seriesId = String(params.seriesId || '');
  const isAppActive = appState !== 'background';
  const castState = useCastState();
  const remoteMediaClient = useRemoteMediaClient();
  const castSession = useCastSession();
  const castMediaStatus = useMediaStatus();
  const isCastConnected = castState === CastState.CONNECTED;
  const castDeviceName = castSession?.device?.friendlyName || castSession?.device?.modelName || 'TV';
  const castIsPlaying = String(castMediaStatus?.playerState || '').toLowerCase() === 'playing';
  const canUsePip = !lowOverheadMode && !planLoading && hasFeature('pip');
  const canUseCastMirror = !lowOverheadMode && !planLoading && hasFeature('cast_mirror');
  const wantsCastPrepMode = String(params.castPrep || params.autoCast || '') === '1';
  const isPreCastMode = wantsCastPrepMode && !isCastConnected;
  const canUseProxy = !planLoading && hasFeature('network_proxy');
  const [proxyEnabled, setProxyEnabledState] = React.useState(false);
  const { sourceUrl, setSourceUrl, isReady: playbackContextReady } = usePlayback();
  const sourceUrlRef = useRef(sourceUrl);
  const playbackPlayerRef = useRef<any>(null);
  const isPlaybackRequestedRef = useRef(true);
  const isAppActiveRef = useRef(true);
  useEffect(() => { sourceUrlRef.current = sourceUrl; }, [sourceUrl]);
  const localScreenPlayer = useVideoPlayer(sourceUrl ? { uri: sourceUrl } : null, (instance) => {
    instance.timeUpdateEventInterval = 0.5;
    instance.loop = false;
    instance.volume = 1;
    instance.muted = false;
    instance.allowsExternalPlayback = true;
  });
  const canAttachMainVideoView = !!(playbackContextReady && localScreenPlayer && sourceUrl);
  const playbackPlayer = canAttachMainVideoView ? localScreenPlayer : PLAYER_FALLBACK;
  useEffect(() => { playbackPlayerRef.current = playbackPlayer; }, [playbackPlayer]);
  useEffect(() => { isPlaybackRequestedRef.current = isPlaybackRequested; }, [isPlaybackRequested]);
  useEffect(() => { isAppActiveRef.current = isAppActive; }, [isAppActive]);

  // Carrega preferência de proxy ao montar
  React.useEffect(() => {
    isProxyEnabled().then((v) => setProxyEnabledState(v)).catch(() => {});
  }, []);

  // Inicia/para heartbeat quando proxy ativo
  React.useEffect(() => {
    if (lowOverheadMode) {
      stopProxyHeartbeat();
      return;
    }

    if (proxyEnabled && sourceUrl) {
      startProxyHeartbeat(sourceUrl);
    } else {
      stopProxyHeartbeat();
    }
    return () => { stopProxyHeartbeat(); };
  }, [lowOverheadMode, proxyEnabled, sourceUrl]);

  React.useEffect(() => {
    if (sourceUrl) {
      console.log('[Player] URL ativa:', sourceUrl, '| mode:', mode);
    }
  }, [sourceUrl]);

  // Bloqueia orientação para PORTRAIT quando Cast está conectado
  React.useEffect(() => {
    if (isCastConnected || isPreCastMode) {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT)
        .catch(() => {});
    } else {
      // Volta para o estado anterior quando desconecta
      ScreenOrientation.unlockAsync().catch(() => {});
    }
    return () => {
      ScreenOrientation.unlockAsync().catch(() => {});
    };
  }, [isCastConnected, isPreCastMode]);

  React.useEffect(() => {
    if (isCastConnected && !wasCastConnectedRef.current) {
      setShowCastConnectedToast(true);
      if (castConnectedToastTimerRef.current) {
        clearTimeout(castConnectedToastTimerRef.current);
      }
      castConnectedToastTimerRef.current = setTimeout(() => {
        setShowCastConnectedToast(false);
      }, 1800);
    }

    if (!isCastConnected) {
      setShowCastConnectedToast(false);
      if (castConnectedToastTimerRef.current) {
        clearTimeout(castConnectedToastTimerRef.current);
        castConnectedToastTimerRef.current = null;
      }
    }

    wasCastConnectedRef.current = isCastConnected;
  }, [isCastConnected]);

  React.useEffect(() => {
    return () => {
      if (castConnectedToastTimerRef.current) {
        clearTimeout(castConnectedToastTimerRef.current);
      }
    };
  }, []);

  // No modo pre-cast, inicia localmente em autoplay mudo para o usuario ver preview
  // antes de conectar na TV.
  React.useEffect(() => {
    if (!isPreCastMode) {
      // Sai do pre-cast: restaura volume anterior
      try {
        const prevVolume = precastModePreviousVolumeRef.current;
        playbackPlayer.muted = false;
        playbackPlayer.volume = prevVolume;
        setVolume(prevVolume);
      } catch {
        // ignora
      }
      return;
    }
    
    // Entra no pre-cast: salva volume atual e silencia
    try {
      precastModePreviousVolumeRef.current = volume;
      playbackPlayer.muted = true;
      playbackPlayer.volume = 0;
      setIsPlaybackRequested(true);
    } catch {
      // ignora
    }
  }, [isPreCastMode]);

  const sendRealtimeWatchingUpdate = (override?: { positionMs?: number; durationMs?: number }) => {
    if (lowOverheadMode) return;

    const title = String(params.title || '');
    const cid = contentId || seriesId;
    if (!cid || !title) return;

    const type = mode === 'live' ? 'live' : mode === 'series' ? 'series' : 'movie';
    const previewUrl = String(sourceUrl || params.url || '').trim();
    const posterUrl = String(params.posterUrl || params.image || '').trim();
    const positionMs = Math.max(
      0,
      Number(
        override && typeof override.positionMs === 'number'
          ? override.positionMs
          : latestPositionRef.current
      )
    );
    const durationMs = Math.max(
      0,
      Number(
        override && typeof override.durationMs === 'number'
          ? override.durationMs
          : latestDurationRef.current
      )
    );

    reportWatching(cid, title, type, {
      previewUrl,
      posterUrl,
      positionMs,
      durationMs,
    });
  };

  // Erros não-fatais do player no Android: foco de áudio, Activity destruída ou keep-awake indisponível.
  const isNonFatalPlayerError = (error: unknown) => {
    const message = String((error as any)?.message || error || '');
    return (
      message.includes('AudioFocusNotAcquiredException') ||
      message.includes('activity is no longer available') ||
      message.includes('Unable to activate keep awake') ||
      message.includes('VideoPlayer.constructor') ||
      message.includes('Cannot use shared object that was already released') ||
      message.includes('cannot be cast to type expo.modules.video.player.VideoPlayer') ||
      message.includes('received class java.lang.Integer')
    );
  };

  const logPlayerErrorDebug = (origin: string, errorLike: unknown, extra?: Record<string, unknown>) => {
    const message = String((errorLike as any)?.message || errorLike || 'erro desconhecido');
    const stack = String((errorLike as any)?.stack || '');
    const payload = {
      origin,
      message,
      stack,
      mode,
      sourceUrl,
      contentId,
      seriesId,
      isAppActive,
      playbackContextReady,
      canAttachMainVideoView,
      statusSnapshot: {
        isLoaded: !!status.isLoaded,
        isPlaying: !!status.isPlaying,
        isBuffering: !!status.isBuffering,
        durationMillis: Number(status.durationMillis || 0),
        positionMillis: Number(status.positionMillis || 0),
      },
      extra: extra || null,
      ts: new Date().toISOString(),
    };
    console.error('[Player][ErroDebug]', payload);
  };

  const getAlternateLiveUrl = (currentUrl: string) => {
    if (/\.ts(\?|$)/i.test(currentUrl)) {
      return currentUrl.replace(/\.ts(\?|$)/i, '.m3u8$1');
    }

    if (/\.m3u8(\?|$)/i.test(currentUrl)) {
      return currentUrl.replace(/\.m3u8(\?|$)/i, '.ts$1');
    }

    if (/output=ts/i.test(currentUrl)) {
      return currentUrl.replace(/output=ts/ig, 'output=m3u8');
    }

    if (/output=m3u8/i.test(currentUrl)) {
      return currentUrl.replace(/output=m3u8/ig, 'output=ts');
    }

    if (/\/live\//i.test(currentUrl) && !/[?&]output=/i.test(currentUrl)) {
      const sep = currentUrl.includes('?') ? '&' : '?';
      return `${currentUrl}${sep}output=m3u8`;
    }

    return '';
  };

  const getLiveRefreshUrl = (currentUrl: string) => {
    const safe = String(currentUrl || '').trim();
    if (!safe) return '';
    const sep = safe.includes('?') ? '&' : '?';
    return `${safe}${sep}_rtRetry=${Date.now()}`;
  };

  const maybeWrapUrlWithProxy = async (url: string) => {
    const safe = String(url || '').trim();
    if (!safe || !/^https?:\/\//i.test(safe)) return safe;

    if (isProxyUrl(safe)) return safe;

    const persistedProxyEnabled = await isProxyEnabled().catch(() => false);
    const shouldUseProxy = canUseProxy && (proxyEnabled || persistedProxyEnabled);
    if (!shouldUseProxy) return safe;

    return wrapUrlWithProxy(safe).catch(() => safe);
  };

  const getAlternateMovieUrl = (currentUrl: string) => {
    const match = currentUrl.match(/\.([a-zA-Z0-9]{2,5})(\?.*)?$/);
    if (!match) {
      return '';
    }

    const currentExt = String(match[1] || '').toLowerCase();
    const movieExtCandidates = ['mp4', 'mkv', 'ts', 'm3u8'];
    const currentIndex = movieExtCandidates.indexOf(currentExt);
    const nextIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    if (nextIndex >= movieExtCandidates.length) {
      return '';
    }

    const nextExt = movieExtCandidates[nextIndex];
    return currentUrl.replace(/\.([a-zA-Z0-9]{2,5})(\?.*)?$/i, `.${nextExt}$2`);
  };

  const isProxyUrl = (url: string) => /\/api\/proxy\?/i.test(String(url || ''));

  const unwrapDirectProxyTargetUrl = (url: string) => {
    const safe = String(url || '').trim();
    if (!safe || !isProxyUrl(safe)) return safe;

    try {
      const wrapped = new URL(safe);
      const inner = wrapped.searchParams.get('url');
      if (!inner) return safe;
      const decoded = decodeURIComponent(inner);
      if (/^https?:\/\//i.test(decoded)) {
        return decoded;
      }
      return safe;
    } catch {
      return safe;
    }
  };

  const tryLiveFallbackSource = (reasonLabel: string, forceReload = false) => {
    if (mode !== 'live' || !sourceUrl) {
      return false;
    }

    const now = Date.now();
    if (liveRecoveryRef.current.source !== sourceUrl) {
      liveRecoveryRef.current = {
        source: sourceUrl,
        attempts: 0,
        lastAttemptAt: 0,
      };
    }

    if (liveRecoveryRef.current.attempts >= 8) {
      return false;
    }

    if (now - liveRecoveryRef.current.lastAttemptAt < 6000) {
      return false;
    }

    const fallbackUrl = getAlternateLiveUrl(sourceUrl) || (forceReload ? getLiveRefreshUrl(sourceUrl) : '');
    if (!fallbackUrl || fallbackUrl === sourceUrl) {
      return false;
    }

    liveRecoveryRef.current.attempts += 1;
    liveRecoveryRef.current.lastAttemptAt = now;
    playRetryCountRef.current = 0;
    setGestureHint(reasonLabel);
    setTimeout(() => setGestureHint(null), 1100);
    setIsLoading(true);
    setHasFirstFrame(false);
    setIsPlaybackRequested(true);
    // Usa proxy somente quando ativado, senão mantém URL direta do provedor
    maybeWrapUrlWithProxy(fallbackUrl)
      .then((finalUrl) => setSourceUrl(finalUrl))
      .catch(() => setSourceUrl(fallbackUrl));
    return true;
  };

  const tryMovieFallbackSource = (reasonLabel: string) => {
    if (mode !== 'movie' || !sourceUrl) {
      return false;
    }

    if (!/\/movie\//i.test(sourceUrl) || movieUrlRetryCountRef.current >= 3) {
      return false;
    }

    const fallbackUrl = getAlternateMovieUrl(sourceUrl);
    if (!fallbackUrl || fallbackUrl === sourceUrl) {
      return false;
    }

    movieUrlRetryCountRef.current += 1;
    playRetryCountRef.current = 0;
    setGestureHint(reasonLabel);
    setTimeout(() => setGestureHint(null), 1100);
    setIsLoading(true);
    setHasFirstFrame(false);
    setIsPlaybackRequested(true);
    maybeWrapUrlWithProxy(fallbackUrl)
      .then((finalUrl) => setSourceUrl(finalUrl))
      .catch(() => setSourceUrl(fallbackUrl));
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

  const handleBlockedPlayback = (message = 'Este conteúdo foi bloqueado pelos responsáveis.') => {
    if (blockedFlowHandledRef.current) return;
    blockedFlowHandledRef.current = true;

    try {
      playbackPlayer.pause();
    } catch {
      // Ignora falha ao pausar durante bloqueio.
    }

    reportStoppedWatching();
    setIsPlaybackRequested(false);

    Alert.alert(
      'Conteúdo bloqueado',
      message,
      [{ text: 'Voltar', onPress: () => router.back() }],
      { cancelable: false }
    );
  };

  const requestPlayNow = async () => {
    setIsPlaybackRequested(true);
    try {
      await safeRunPlayback(async () => {
        playbackPlayer.play();
      });
    } catch (error) {
      if (!isNonFatalPlayerError(error)) {
        logPlayerErrorDebug('requestPlayNow', error);
      }
    }
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

  const exitCastKeepPlaying = async () => {
    await persistExactProgress();
    clearMiniPlayerState();
    router.back();
  };

  const stopCast = async () => {
    try {
      if (remoteMediaClient) {
        await remoteMediaClient.stop();
      }
      if (GoogleCast?.endCurrentSession) {
        GoogleCast.endCurrentSession(false);
      }
    } catch (err) {
      console.log('[Cast] Erro ao parar:', err);
    }
  };

  const castValueToSeconds = (value: unknown) => {
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    // Alguns status retornam ms, outros segundos.
    return n > 10_000 ? n / 1000 : n;
  };

  const castSeekTo = (targetSec: number) => {
    if (!remoteMediaClient) return;
    remoteMediaClient.seek({ position: Math.max(0, Number(targetSec || 0)) }).catch(() => {});
  };

  const castSeek = (deltaSec: number) => {
    if (!remoteMediaClient) return;
    const posSec = castValueToSeconds(castMediaStatus?.streamPosition);
    castSeekTo(posSec + deltaSec);
  };

  const toggleCastPlayPause = () => {
    if (!remoteMediaClient) return;
    if (castIsPlaying) { remoteMediaClient.pause().catch(() => {}); }
    else { remoteMediaClient.play().catch(() => {}); }
  };

  const applyPendingStartPosition = () => {
    if (mode === 'live' || pendingStartPositionMsRef.current <= 0) {
      return false;
    }

    const targetPositionSec = pendingStartPositionMsRef.current / 1000;
    const currentPlayer = playbackPlayerRef.current;
    if (!currentPlayer || currentPlayer === PLAYER_FALLBACK) {
      // Tenta novamente em 200ms se o player ainda não está pronto
      setTimeout(() => {
        applyPendingStartPosition();
      }, 200);
      return false;
    }

    try {
      currentPlayer.currentTime = targetPositionSec;
      pendingStartPositionMsRef.current = 0;
      return true;
    } catch {
      return false;
    }
  };

  // Formata duração em MM:SS
  const formatCastProgress = (rawValue: number | undefined) => {
    const safeSeconds = castValueToSeconds(rawValue);
    if (!safeSeconds || safeSeconds < 0) return '0:00';
    const totalSeconds = Math.floor(safeSeconds);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };

  const closePlayerAndExit = async () => {
    // Mantém playback em background se Cast está conectado
    // (PiP é gerenciado automaticamente pelo sistema)
    keepPlaybackOnExitRef.current = isCastConnected;
    
    await persistExactProgress();
    setIsPlaybackRequested(false);
    
    if (!isCastConnected) {
      clearMiniPlayerState();
    }

    try {
      if (!isCastConnected) {
        playbackPlayer.pause();
      }
    } catch {
      // Ignora falhas de pause quando o player estiver entre estados.
    }
    router.back();
  };

  useEffect(() => {
    if (!isAppActive || !isPlaybackRequested || !sourceUrl) return;

    const timer = setTimeout(() => {
      void requestPlayNow();
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
      void requestPlayNow();
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
    getDbValue<string | boolean>(GESTURE_TUTORIAL_PREF_KEY)
      .then((raw) => {
        const enabled = raw === '0' || raw === false ? false : true;
        setGestureTutorialEnabled(enabled);
        if (!enabled) {
          hasShownGestureTutorialRef.current = true;
        }
      })
      .catch(() => {
        setGestureTutorialEnabled(true);
      });
  }, []);

  useEffect(() => {
    if (!VolumeManager?.getVolume || !VolumeManager?.addVolumeListener) {
      return;
    }

    VolumeManager.getVolume()
      .then((result: { volume: number }) => {
        const sysVol = result.volume ?? 1;
        setVolume(sysVol);
        volumeRef.current = sysVol;
        lastSystemVolumeRef.current = sysVol;
      })
      .catch(() => {});

    const volSub = VolumeManager.addVolumeListener((result: { volume: number }) => {
      const nextValue = Math.max(0, Math.min(1, Number(result.volume ?? 1)));
      setVolume(nextValue);
      volumeRef.current = nextValue;
      lastSystemVolumeRef.current = nextValue;
    });
    return () => volSub?.remove?.();
  }, []);

  useEffect(() => {
    return () => {
      if (volumeSyncTimerRef.current) {
        clearTimeout(volumeSyncTimerRef.current);
        volumeSyncTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    brightnessRef.current = brightness;
  }, [brightness]);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  useEffect(() => {
    if (!isCastConnected || !remoteMediaClient) return;
    const next = Math.max(0, Math.min(1, Number(volume || 0)));
    if (Math.abs(next - lastCastVolumePushRef.current) < 0.02) {
      return;
    }
    lastCastVolumePushRef.current = next;
    remoteMediaClient.setStreamVolume(next).catch(() => {});
  }, [volume, isCastConnected, remoteMediaClient]);

  useEffect(() => {
    const bootstrap = async () => {
      const persistedProxyEnabled = await isProxyEnabled().catch(() => false);
      setProxyEnabledState(persistedProxyEnabled);

      let resolvedUrl = String(params.url || '');
      const cid = contentId || seriesId;

      if (cid) {
        const blocked = await isContentBlocked(cid).catch(() => false);
        if (blocked) {
          handleBlockedPlayback('Este conteúdo está bloqueado. Libere no controle parental para assistir novamente.');
          return;
        }
      }

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

      resolvedUrl = await maybeWrapUrlWithProxy(resolvedUrl).catch(() => resolvedUrl);

      const isSameSource = resolvedUrl === sourceUrl && sourceUrl.length > 0;
      playRetryCountRef.current = 0;

      if (!isSameSource) {
        setSourceUrl(resolvedUrl);
        liveRecoveryRef.current = {
          source: resolvedUrl,
          attempts: 0,
          lastAttemptAt: 0,
        };
        movieUrlRetryCountRef.current = 0;
        setIsLoading(true);
        setIsPlaybackRequested(true);
        setHasFirstFrame(false);
      } else {
        setIsLoading(false);
        setIsPlaybackRequested(true);
        setHasFirstFrame(true);
      }

      const startPosition = Number(params.startPositionMs || 0);
      const shouldApplyStartPosition =
        startPosition > 0 &&
        mode !== 'live' &&
        (!isSameSource || Math.abs(startPosition - latestPositionRef.current) > 2500);
      pendingStartPositionMsRef.current = shouldApplyStartPosition ? startPosition : 0;

      if (pendingStartPositionMsRef.current > 0) {
        // Aguarda mais tempo para garantir que o player e fonte estejam prontos
        setTimeout(async () => {
          applyPendingStartPosition();
        }, 500);
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
        stopProxyHeartbeat();
        closeProxySession().catch(() => {});
      } else {
        // Fecha o teclado ao voltar do background
        Keyboard.dismiss();
      }
      setAppState(nextState);
    });

    return () => {
      persistExactProgress();
      stopProxyHeartbeat();
      closeProxySession().catch(() => {});
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
        playbackPlayerRef.current?.pause?.();
      } catch {
        // Ignora falhas ao pausar durante desmontagem da tela.
      }
    };
  }, []);

  useEffect(() => {
    const lockOrientation = async () => {
      try {
        if (wantsCastPrepMode) {
          // Inicia em portrait quando aberto pelo fluxo "Espelhar na TV"
          await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
        } else {
          await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
        }
      } catch {
        // Ignora quando o dispositivo nao permite lock de orientacao.
      }
    };

    lockOrientation();

    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {
        // Ignora falha ao restaurar retrato ao sair do player.
      });
    };
  }, [wantsCastPrepMode]);

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
    if (lowOverheadMode) return;
    if (!gestureTutorialEnabled || !hasFirstFrame || hasShownGestureTutorialRef.current) return;
    hasShownGestureTutorialRef.current = true;
    setShowGestureTutorial(true);
  }, [hasFirstFrame, gestureTutorialEnabled, lowOverheadMode]);

  // ── Presença real-time: reportar conteúdo que está assistindo ──
  useEffect(() => {
    if (lowOverheadMode) return;
    if (!hasFirstFrame) return;

    const title = String(params.title || '');
    const cid = contentId || seriesId;
    if (!cid || !title) return;

    const type = mode === 'live' ? 'live' : mode === 'series' ? 'series' : 'movie';
    const previewUrl = String(sourceUrl || params.url || '').trim();
    const posterUrl = String(params.posterUrl || params.image || '').trim();
    const reportSignature = `${cid}|${type}|${title}|${previewUrl}|${posterUrl}`;

    if (reportSignature === lastWatchingReportRef.current) return;

    // Verifica se o conteúdo está bloqueado pelos pais
    isContentBlocked(cid).then((blocked) => {
      if (blocked) {
        handleBlockedPlayback('Este conteúdo foi bloqueado pelos responsáveis.');
        return;
      }
      lastWatchingReportRef.current = reportSignature;
      sendRealtimeWatchingUpdate();
    });
  }, [
    hasFirstFrame,
    contentId,
    seriesId,
    mode,
    sourceUrl,
    params.url,
    params.posterUrl,
    params.image,
    params.title,
    lowOverheadMode,
  ]);

  useEffect(() => {
    return () => {
      reportStoppedWatching();
    };
  }, []);

  // ── Controle parental via REST: polling para bloqueio em tempo real ──
  useEffect(() => {
    if (lowOverheadMode) return;
    const cid = contentId || seriesId;
    if (!cid || !hasFirstFrame) return;

    let stopped = false;
    const timer = setInterval(() => {
      isContentBlocked(cid).then((blocked) => {
        if (stopped || !blocked) return;
        handleBlockedPlayback('Um responsável bloqueou este conteúdo em tempo real.');
      });
    }, 8_000);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [contentId, seriesId, hasFirstFrame, router, lowOverheadMode]);

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
    const timer = setTimeout(() => setShowControls(false), 4000);
    return () => clearTimeout(timer);
  }, [showControls, isLocked]);

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

  const duration = toSafeNonNegativeNumber(status.durationMillis, 0);
  const position = toSafeNonNegativeNumber(status.positionMillis, 0);
  const progress = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;

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

  const fallbackDurationMillis = useMemo(() => {
    if (mode === 'live') return 0;
    if (mode === 'movie') {
      return coerceDurationMs({ milliseconds: params.durationMs });
    }
    const currentEpisode = playlist[playlistIndex];
    return coerceDurationMs({ milliseconds: currentEpisode?.durationMs });
  }, [mode, params.durationMs, playlist, playlistIndex]);

  useEffect(() => {
    if (!fallbackDurationMillis) return;
    setStatus((prev) => ({
      ...prev,
      durationMillis: Math.max(0, Number(prev.durationMillis || 0), fallbackDurationMillis),
    }));
  }, [fallbackDurationMillis]);

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
      try { playbackPlayer.pause(); } catch {}
      return;
    }
    setIsPlaybackRequested(true);
    try { playbackPlayer.play(); } catch {}
  };

  const seekTo = async (value: number) => {
    if (isLocked || mode === 'live') return;
    const currentDuration = latestDurationRef.current;
    if (!currentDuration) return;
    const currentPosition = Math.max(0, Number(latestPositionRef.current || 0));
    const nextPosition = Math.max(0, Math.min(currentDuration, value * currentDuration));

    setIsSeeking(true);
    setShowControls(true);
    try {
      playbackPlayer.currentTime = nextPosition / 1000;
      const deltaMs = Math.abs(nextPosition - currentPosition);
      if (deltaMs > 2000) {
        setHasFirstFrame(false);
      }
      setTimeout(() => {
        try { playbackPlayer.play(); } catch {}
      }, 200);
      if (deltaMs >= MANUAL_RT_SYNC_MIN_DELTA_MS) {
        sendRealtimeWatchingUpdate({ positionMs: nextPosition, durationMs: currentDuration });
      }
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
      sendRealtimeWatchingUpdate({ positionMs: nextPos, durationMs: currentDuration });
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

  const setPlayerVolume = (value: number, source: 'gesture' | 'manual' = 'manual') => {
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
        const now = Date.now();
        const shouldWriteSystemVolume =
          source === 'manual' ||
          Math.abs(nextValue - lastSystemVolumeRef.current) >= 0.02 ||
          now - lastVolumeWriteRef.current >= 120;

        if (shouldWriteSystemVolume) {
          lastVolumeWriteRef.current = now;
          lastSystemVolumeRef.current = nextValue;

          if (source === 'gesture') {
            if (volumeSyncTimerRef.current) {
              clearTimeout(volumeSyncTimerRef.current);
            }
            volumeSyncTimerRef.current = setTimeout(() => {
              VolumeManager?.setVolume?.(nextValue, { showUI: false, type: 'music' }).catch(() => {});
              volumeSyncTimerRef.current = null;
            }, 40);
          } else {
            VolumeManager.setVolume(nextValue, { showUI: true, type: 'music' }).catch(() => {});
          }
        }
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
      setZoomLevel('100%');
      return;
    }

    setScreenMode('Preencher');
    if (zoomLevel === '100%') {
      setZoomLevel('115%');
    }
  };

  const toggleGestureTutorialSetting = async () => {
    const nextEnabled = !gestureTutorialEnabled;
    setGestureTutorialEnabled(nextEnabled);
    await setDbValue(GESTURE_TUTORIAL_PREF_KEY, nextEnabled ? '1' : '0');

    if (!nextEnabled) {
      setShowGestureTutorial(false);
      hasShownGestureTutorialRef.current = true;
      setGestureHint('Tutorial de gestos desativado');
      setTimeout(() => setGestureHint(null), 900);
      return;
    }

    hasShownGestureTutorialRef.current = false;
    setShowGestureTutorial(true);
    setGestureHint('Tutorial de gestos ativado');
    setTimeout(() => setGestureHint(null), 900);
  };

  const disableGestureTutorialPermanently = async () => {
    setGestureTutorialEnabled(false);
    hasShownGestureTutorialRef.current = true;
    setShowGestureTutorial(false);
    await setDbValue(GESTURE_TUTORIAL_PREF_KEY, '0');
    setGestureHint('Nao mostrar novamente');
    setTimeout(() => setGestureHint(null), 900);
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
    // Se já estiver transmitindo, recarrega automaticamente no dispositivo.
    if (isCastConnected) {
      setPendingCastLoad(true);
    }
  };

  const cancelAutoplay = () => setNextCountdown(null);

  const skipIntro = async () => {
    if (mode !== 'series' || isLocked) return;
    const target = Math.min(duration > 0 ? duration - 1000 : 90_000, 90_000);
    playbackPlayer.currentTime = target / 1000;
    sendRealtimeWatchingUpdate({ positionMs: target, durationMs: duration });
    setSkippedIntroByEpisode((prev) => ({ ...prev, [playlistIndex]: true }));
    setGestureHint('Abertura pulada');
    setTimeout(() => setGestureHint(null), 800);
  };

  const inferContentType = (url: string) => {
    const safeUrl = String(url || '').toLowerCase();
    let urlToInspect = safeUrl;

    // Quando estiver encapsulado no proxy (?url=<upstream>), infere tipo pelo upstream real.
    try {
      const wrapped = new URL(String(url || ''));
      const inner = wrapped.searchParams.get('url');
      if (inner) {
        urlToInspect = decodeURIComponent(inner).toLowerCase();
      }
    } catch {
      // Mantem URL original quando nao for URL valida.
    }

    const cleanUrl = urlToInspect.split('?')[0];

    if (
      cleanUrl.endsWith('.m3u8') ||
      /\/m3u8(\?|$)/i.test(cleanUrl) ||
      /[?&]output=m3u8/i.test(urlToInspect) ||
      (/\/live\//i.test(cleanUrl) && !cleanUrl.endsWith('.ts'))
    ) {
      return 'application/x-mpegURL';
    }

    if (cleanUrl.endsWith('.ts') || /[?&]output=ts/i.test(urlToInspect)) return 'video/mp2t';
    if (cleanUrl.endsWith('.mpd')) return 'application/dash+xml';
    if (cleanUrl.endsWith('.mov')) return 'video/quicktime';
    if (cleanUrl.endsWith('.webm')) return 'video/webm';
    if (cleanUrl.endsWith('.mkv')) return 'video/x-matroska';
    return 'video/mp4';
  };

  const buildCastLiveCandidates = (url: string) => {
    const primary = String(url || '').trim();
    if (!primary) return [] as string[];

    const candidates = [primary];

    const tryAddOutputParam = (rawUrl: string, output: 'm3u8' | 'ts') => {
      const safe = String(rawUrl || '').trim();
      if (!safe) return;
      if (/[?&]output=/i.test(safe)) {
        candidates.push(safe.replace(/([?&]output=)([^&]+)/i, `$1${output}`));
        return;
      }
      const sep = safe.includes('?') ? '&' : '?';
      candidates.push(`${safe}${sep}output=${output}`);
    };

    const addLiveAlternatives = (rawUrl: string) => {
      const safe = String(rawUrl || '').trim();
      if (!safe) return;

      if (/\/live\//i.test(safe)) {
        tryAddOutputParam(safe, 'm3u8');
        tryAddOutputParam(safe, 'ts');
      }

      if (/output=ts/i.test(safe)) {
        candidates.push(safe.replace(/output=ts/ig, 'output=m3u8'));
      }

      if (/\/ts(\?|$)/i.test(safe)) {
        candidates.push(safe.replace(/\/ts(\?|$)/i, '/m3u8$1'));
        candidates.push(safe.replace(/\/ts(\?|$)/i, '/index.m3u8$1'));
      }

      if (/\.ts(\?|$)/i.test(safe)) {
        candidates.push(safe.replace(/\.ts(\?|$)/i, '.m3u8$1'));
      }

      const alt = getAlternateLiveUrl(safe);
      if (alt) candidates.push(alt);
    };

    addLiveAlternatives(primary);

    // Quando a URL está encapsulada no proxy (?url=<encoded>), cria variações do upstream.
    try {
      const wrapped = new URL(primary);
      const inner = wrapped.searchParams.get('url');
      if (inner) {
        const decodedInner = decodeURIComponent(inner);
        const innerCandidates: string[] = [decodedInner];

        if (/\/ts(\?|$)/i.test(decodedInner)) {
          innerCandidates.push(decodedInner.replace(/\/ts(\?|$)/i, '/m3u8$1'));
          innerCandidates.push(decodedInner.replace(/\/ts(\?|$)/i, '/index.m3u8$1'));
        }
        if (/\.ts(\?|$)/i.test(decodedInner)) {
          innerCandidates.push(decodedInner.replace(/\.ts(\?|$)/i, '.m3u8$1'));
        }
        if (/\/live\//i.test(decodedInner) && !/[?&]output=/i.test(decodedInner)) {
          const sep = decodedInner.includes('?') ? '&' : '?';
          innerCandidates.push(`${decodedInner}${sep}output=m3u8`);
          innerCandidates.push(`${decodedInner}${sep}output=ts`);
        }
        if (/output=ts/i.test(decodedInner)) {
          innerCandidates.push(decodedInner.replace(/output=ts/ig, 'output=m3u8'));
        }

        for (const candidate of innerCandidates) {
          const proxied = new URL(primary);
          proxied.searchParams.set('url', candidate);
          candidates.push(proxied.toString());
          addLiveAlternatives(candidate);
        }
      }
    } catch {
      // URL inválida; segue apenas com os candidatos básicos.
    }

    return Array.from(new Set(candidates.filter(Boolean)));
  };

  const buildCastVodCandidates = (url: string) => {
    const primary = String(url || '').trim();
    if (!primary) return [] as string[];

    const candidates = [primary];

    const addMovieAlternatives = (rawUrl: string) => {
      const safe = String(rawUrl || '').trim();
      if (!safe) return;

      const directAlt = getAlternateMovieUrl(safe);
      if (directAlt) candidates.push(directAlt);

      const cycleExt = ['mp4', 'mkv', 'ts', 'm3u8'];
      const match = safe.match(/\.([a-zA-Z0-9]{2,5})(\?.*)?$/);
      if (match) {
        const current = String(match[1] || '').toLowerCase();
        const suffix = String(match[2] || '');
        for (const ext of cycleExt) {
          if (ext === current) continue;
          candidates.push(safe.replace(/\.([a-zA-Z0-9]{2,5})(\?.*)?$/i, `.${ext}${suffix}`));
        }
      }
    };

    addMovieAlternatives(primary);

    // Se estiver proxiado (?url=<upstream>), também cria alternativas no URL interno.
    try {
      const wrapped = new URL(primary);
      const inner = wrapped.searchParams.get('url');
      if (inner) {
        const decodedInner = decodeURIComponent(inner);
        const innerCandidates = [decodedInner];

        const directInnerAlt = getAlternateMovieUrl(decodedInner);
        if (directInnerAlt) innerCandidates.push(directInnerAlt);

        const match = decodedInner.match(/\.([a-zA-Z0-9]{2,5})(\?.*)?$/);
        if (match) {
          const current = String(match[1] || '').toLowerCase();
          const suffix = String(match[2] || '');
          for (const ext of ['mp4', 'mkv', 'ts', 'm3u8']) {
            if (ext === current) continue;
            innerCandidates.push(decodedInner.replace(/\.([a-zA-Z0-9]{2,5})(\?.*)?$/i, `.${ext}${suffix}`));
          }
        }

        for (const candidate of innerCandidates) {
          const proxied = new URL(primary);
          proxied.searchParams.set('url', candidate);
          candidates.push(proxied.toString());
          addMovieAlternatives(candidate);
        }
      }
    } catch {
      // Ignora parsing quando URL nao for valida.
    }

    return Array.from(new Set(candidates.filter(Boolean)));
  };

  const buildCastSourceUrl = async (url: string) => {
    const safe = String(url || '').trim();
    if (!safe || !/^https?:\/\//i.test(safe)) {
      return safe;
    }
    return maybeWrapUrlWithProxy(safe);
  };

  React.useEffect(() => {
    if (!sourceUrl) {
      return;
    }

    if (!canUseProxy || !proxyEnabled || isProxyUrl(sourceUrl)) {
      return;
    }

    maybeWrapUrlWithProxy(sourceUrl)
      .then((nextUrl) => {
        if (nextUrl && nextUrl !== sourceUrl) {
          setSourceUrl(nextUrl);
        }
      })
      .catch(() => {});
  }, [proxyEnabled, canUseProxy, sourceUrl]);

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

    // Reaproveita cliente somente quando ja existe sessao ativa.
    if (remoteMediaClient && castState === CastState.CONNECTED) {
      autoCastHandledRef.current = true;
      return;
    }

    const shown = await GoogleCast.showCastDialog();
    if (!shown) {
      setPendingCastLoad(false);
      Alert.alert('Sem dispositivos', 'Nenhum dispositivo compativel foi encontrado para espelhamento/cast.');
    }
  };

  // Fluxo novo: modo pre-cast não conecta automaticamente.
  // O usuário conecta manualmente após o vídeo carregar.

  useEffect(() => {
    if (!pendingCastLoad || !remoteMediaClient || !sourceUrl) return;

    const loadOnCast = async () => {
      try {
        // Aguarda a sessao estabilizar antes de carregar a midia.
        await new Promise((r) => setTimeout(r, 350));

        const rawUrlsToTry =
          mode === 'live' ? buildCastLiveCandidates(sourceUrl) : buildCastVodCandidates(sourceUrl);

        if (mode === 'live' && !rawUrlsToTry.length) {
          throw new Error(
            'Canal ao vivo sem HLS compatível para Cast. Use uma URL .m3u8 via proxy (não /ts direto).'
          );
        }

        const proxiedUrls = await Promise.all(rawUrlsToTry.map((item) => buildCastSourceUrl(item)));
        const urlsToTry = Array.from(new Set(proxiedUrls.filter(Boolean))) as string[];
        const streamTypesToTry =
          mode === 'live'
            ? [MediaStreamType.LIVE]
            : [MediaStreamType.BUFFERED];

        let loaded = false;
        let lastError: unknown = null;

        for (const castUrl of urlsToTry) {
          for (const streamType of streamTypesToTry) {
            try {
              await remoteMediaClient.loadMedia({
                autoplay: true,
                startTime: mode === 'live' ? 0 : Math.floor(position / 1000),
                mediaInfo: {
                  contentUrl: castUrl,
                  contentType: inferContentType(castUrl),
                  streamType,
                  metadata: {
                    type: mode === 'series' ? 'tvShow' : 'movie',
                    title: String(params.title || 'Player'),
                    subtitle: currentEpisodeLabel || undefined,
                  },
                },
              });

              // Alguns receivers iniciam pausados mesmo com autoplay=true.
              await remoteMediaClient.play().catch(() => {});

              loaded = true;
              break;
            } catch (err) {
              lastError = err;
            }
          }
          if (loaded) break;
        }

        if (!loaded && lastError) {
          throw lastError;
        }

        setGestureHint('Transmitindo para TV');
        setTimeout(() => setGestureHint(null), 900);
        setIsPlaybackRequested(false);
        playbackPlayer.pause();
      } catch (error) {
        const raw = String((error as any)?.message || error || 'Falha ao iniciar transmissao.');
        const message = /2103|APPLICATION_NOT_FOUND/i.test(raw)
          ? 'Erro 2103: receiver Cast nao encontrado. Verifique se a TV/Chromecast tem acesso a internet e tente novamente. Se persistir, reinstale o app.'
          : raw;
        Alert.alert('Falha no cast', message);
      } finally {
        setPendingCastLoad(false);
      }
    };

    loadOnCast();
  }, [pendingCastLoad, remoteMediaClient, sourceUrl, mode, position, params.title, currentEpisodeLabel, castState]);

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
    if (mode !== 'live' || !sourceUrl || !hasFirstFrame || !isPlaybackRequested || !isAppActive) {
      return;
    }

    if (liveLastProgressAtRef.current <= 0) {
      liveLastProgressAtRef.current = Date.now();
    }

    const timer = setInterval(() => {
      const stalledForMs = Date.now() - Number(liveLastProgressAtRef.current || 0);
      if (stalledForMs < 18_000) return;

      const isBuffering = !!status.isBuffering;
      const isPlaying = !!status.isPlaying;
      if (!isBuffering && isPlaying) return;

      const recovered = tryLiveFallbackSource('Reconectando TV ao vivo...', true);
      if (recovered) {
        liveLastProgressAtRef.current = Date.now();
      }
    }, 5_000);

    return () => clearInterval(timer);
  }, [mode, sourceUrl, hasFirstFrame, isPlaybackRequested, isAppActive, status.isBuffering, status.isPlaying]);

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
    if (!sourceUrl || !canAttachMainVideoView || !localScreenPlayer) return;

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

          if (message.includes('404') && tryMovieFallbackSource('Tentando outra qualidade...')) {
            return;
          }

          setIsLoading(false);
          // Erros de Activity ou keep-awake são não-fatais; não exibir alerta ao usuário.
          if (!isNonFatalPlayerError(message)) {
            logPlayerErrorDebug('statusChange', error || message, {
              playerStatus,
              message,
            });
          }
        }
      }),
      playbackPlayer.addListener('playingChange', ({ isPlaying }: any) => {
        if (isPlaying) {
          playRetryCountRef.current = 0;
          if (mode === 'live') {
            liveRecoveryRef.current.attempts = 0;
            liveLastProgressAtRef.current = Date.now();
          }
        }
        setStatus((prev) => ({ ...prev, isPlaying }));
      }),
      playbackPlayer.addListener('sourceLoad', ({ duration: loadedDuration }: any) => {
        applyPendingStartPosition();

        const loadedDurationMillis = Math.floor(toSafeNonNegativeNumber(loadedDuration, 0) * 1000);
        setStatus((prev) => ({
          ...prev,
          isLoaded: true,
          durationMillis: Math.max(
            0,
            toSafeNonNegativeNumber(prev.durationMillis, 0),
            toSafeNonNegativeNumber(fallbackDurationMillis, 0),
            toSafeNonNegativeNumber(loadedDurationMillis, 0)
          ),
        }));
        setHasFirstFrame(true);
        setIsLoading(false);
        if (mode === 'live') {
          liveLastProgressAtRef.current = Date.now();
          liveLastPositionMsRef.current = 0;
        }

        if (isPlaybackRequestedRef.current && isAppActiveRef.current) {
          void safeRunPlayback(async () => {
            playbackPlayer.play();
          });
        }
      }),
      playbackPlayer.addListener('timeUpdate', ({ currentTime, bufferedPosition }: any) => {
        const durationSeconds = toSafeNonNegativeNumber(playbackPlayer.duration, 0);
        const nextPositionMillis = Math.floor(toSafeNonNegativeNumber(currentTime, 0) * 1000);
        const nextDurationMillis = Math.floor(durationSeconds * 1000);
        const safeBufferedPosition = toSafeNonNegativeNumber(bufferedPosition, -1);

        setStatus((prev) => ({
          ...prev,
          isLoaded: true,
          durationMillis: Math.max(
            0,
            toSafeNonNegativeNumber(prev.durationMillis, 0),
            toSafeNonNegativeNumber(fallbackDurationMillis, 0),
            toSafeNonNegativeNumber(nextDurationMillis, 0)
          ),
          positionMillis: nextPositionMillis,
          isBuffering: safeBufferedPosition > -1 && safeBufferedPosition <= toSafeNonNegativeNumber(currentTime, 0),
          didJustFinish: false,
        }));

        if (nextPositionMillis > 0) {
          setHasFirstFrame(true);
          setIsLoading(false);
          if (mode === 'live') {
            if (nextPositionMillis > liveLastPositionMsRef.current + 400) {
              liveLastProgressAtRef.current = Date.now();
            }
            liveLastPositionMsRef.current = nextPositionMillis;
          }
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
  }, [sourceUrl, mode, hasNextEpisode, fallbackDurationMillis, canAttachMainVideoView, localScreenPlayer]);

  useEffect(() => {
    if (castState === CastState.CONNECTED) {
      setGestureHint(`Transmitindo para ${castDeviceName}`);
      setTimeout(() => setGestureHint(null), 1200);
    }
  }, [castState, castDeviceName]);

  useEffect(() => {
    const level = castMediaStatus?.volume?.level;
    if (typeof level === 'number') setCastVolume(level);
  }, [castMediaStatus?.volume?.level]);

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
          setPlayerVolume(next, 'gesture');
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

  // Renderiza tela fullscreen do Cast
  if (isCastConnected) {
    const castCurrentSec = castValueToSeconds(castMediaStatus?.streamPosition);
    const castDurationSec = castValueToSeconds(castMediaStatus?.duration);
    const castProgressPercent = castDurationSec > 0 ? castCurrentSec / castDurationSec : 0;
    const castCurrentTime = formatCastProgress(castMediaStatus?.streamPosition);
    const castDuration = formatCastProgress(castMediaStatus?.duration);

    return (
      <SafeAreaView style={[styles.container, styles.castFullscreenContainer]}>
        <StatusBar hidden />

        <View style={styles.castFullscreenContent}>
          {/* Logo/Identificador */}
          <View style={styles.castFullscreenHeader}>
            <MaterialIcons name="cast-connected" size={32} color={StreamingTheme.colors.accent} />
            <Text style={styles.castFullscreenDeviceLabel}>Transmitindo para</Text>
            <Text style={styles.castFullscreenDeviceName}>{castDeviceName}</Text>
          </View>

          {/* Informações do Conteúdo */}
          <View style={styles.castFullscreenInfo}>
            <Text style={styles.castFullscreenTitle} numberOfLines={2}>
              {String(params.title || 'Player')}
            </Text>
            {!!currentEpisodeLabel && (
              <Text style={styles.castFullscreenSubtitle} numberOfLines={1}>
                {currentEpisodeLabel}
              </Text>
            )}
          </View>

          {/* Controles Principais */}
          <View style={styles.castFullscreenControls}>
            <TouchableOpacity style={styles.castFsCtrlBtn} onPress={() => castSeek(-30)}>
              <MaterialIcons name="replay-30" size={36} color={StreamingTheme.colors.textPrimary} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.castFsCtrlBtnMain} onPress={toggleCastPlayPause}>
              <MaterialIcons
                name={castIsPlaying ? 'pause' : 'play-arrow'}
                size={50}
                color={StreamingTheme.colors.textPrimary}
              />
            </TouchableOpacity>
            <TouchableOpacity style={styles.castFsCtrlBtn} onPress={() => castSeek(30)}>
              <MaterialIcons name="forward-30" size={36} color={StreamingTheme.colors.textPrimary} />
            </TouchableOpacity>
          </View>

          {/* Barra de Progresso */}
          <View style={styles.castFullscreenProgressSection}>
            <Slider
              style={styles.castFullscreenProgressBar}
              value={castProgressPercent}
              onSlidingComplete={(value) => {
                if (castDurationSec > 0) {
                  castSeekTo(value * castDurationSec);
                }
              }}
              minimumValue={0}
              maximumValue={1}
              minimumTrackTintColor={StreamingTheme.colors.accent}
              maximumTrackTintColor="rgba(255,255,255,0.2)"
              thumbTintColor={StreamingTheme.colors.textPrimary}
            />
            <View style={styles.castFullscreenTimeRow}>
              <Text style={styles.castFullscreenTime}>{castCurrentTime}</Text>
              <Text style={styles.castFullscreenTime}>{castDuration}</Text>
            </View>
          </View>

          {/* Volume */}
          <View style={styles.castFullscreenVolumeSection}>
            <MaterialIcons name="volume-down" size={20} color={StreamingTheme.colors.textMuted} />
            <Slider
              style={styles.castFullscreenVolumeSlider}
              value={castVolume}
              onValueChange={(v) => {
                setCastVolume(v);
                remoteMediaClient?.setStreamVolume(v).catch(() => {});
              }}
              onSlidingComplete={(v) =>
                remoteMediaClient?.setStreamVolume(v).catch(() => {})
              }
              minimumValue={0}
              maximumValue={1}
              minimumTrackTintColor={StreamingTheme.colors.accent}
              maximumTrackTintColor="rgba(255,255,255,0.2)"
              thumbTintColor={StreamingTheme.colors.textPrimary}
            />
            <MaterialIcons name="volume-up" size={20} color={StreamingTheme.colors.textMuted} />
          </View>
        </View>

        {/* Botões de Ação */}
        <View style={styles.castFullscreenActions}>
          <TouchableOpacity
            style={[styles.castFsActionBtn, styles.castFsActionBtnSecondary]}
            onPress={exitCastKeepPlaying}>
            <MaterialIcons name="arrow-back" size={16} color={StreamingTheme.colors.textPrimary} />
            <Text style={styles.castFsActionBtnText}>Sair</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.castFsActionBtn, styles.castFsActionBtnDanger]} onPress={stopCast}>
            <MaterialIcons name="stop-circle" size={16} color="#ff5252" />
            <Text style={[styles.castFsActionBtnText, { color: '#ff5252' }]}>Parar Cast</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar hidden />
      <AppBackdrop blurIntensity={28} />

      <View style={styles.playerArea}>
        <View style={[styles.videoViewport, videoViewportStyle]}>
          {canAttachMainVideoView && localScreenPlayer ? (
            <VideoView
              key={`main-${sourceUrl || 'empty'}`}
              ref={videoViewRef}
              player={localScreenPlayer}
              style={[styles.video, isFillMode && { transform: [{ scale: zoomScale }] }]}
              nativeControls={false}
              contentFit={isFillMode ? 'cover' : 'contain'}
              allowsPictureInPicture={canUsePip}
              startsPictureInPictureAutomatically={false}
              onFirstFrameRender={() => {
                setHasFirstFrame(true);
                setIsLoading(false);
                // Força autoplay ao renderizar primeiro frame
                setIsPlaybackRequested(true);
                setTimeout(() => {
                  try { playbackPlayer.play(); } catch {}
                }, 100);
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

      {showCastConnectedToast && (
        <View style={styles.castConnectedToast}>
          <MaterialIcons name="cast-connected" size={16} color={StreamingTheme.colors.textPrimary} />
          <Text style={styles.castConnectedToastText}>Conectado com sucesso</Text>
        </View>
      )}

      {showGestureTutorial && !isLocked && !lowOverheadMode && (
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
          <View style={styles.gestureTutorialActions}>
            <TouchableOpacity
              style={[styles.gestureTutorialActionBtn, styles.gestureTutorialActionBtnMuted]}
              onPress={() => {
                setShowGestureTutorial(false);
              }}>
              <Text style={styles.gestureTutorialActionText}>Agora nao</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.gestureTutorialActionBtn, styles.gestureTutorialActionBtnDanger]}
              onPress={() => {
                void disableGestureTutorialPermanently();
              }}>
              <Text style={styles.gestureTutorialActionText}>Nao mostrar novamente</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {showSkipIntro && (
        <TouchableOpacity style={styles.skipIntroBtn} onPress={skipIntro}>
          <MaterialIcons name="fast-forward" size={18} color={StreamingTheme.colors.textPrimary} />
          <Text style={styles.skipIntroText}>Pular abertura</Text>
        </TouchableOpacity>
      )}

      {isPreCastMode && (
        <View style={styles.preCastCard}>
          <View style={styles.preCastHeader}>
            <TouchableOpacity style={styles.preCastBackBtn} onPress={closePlayerAndExit}>
              <MaterialIcons name="arrow-back" size={20} color={StreamingTheme.colors.textPrimary} />
            </TouchableOpacity>
            <MaterialIcons name="cast" size={22} color={StreamingTheme.colors.accent} />
            <Text style={styles.preCastTitle}>Modo Espelhar</Text>
            {!!GoogleCast && <CastButton style={styles.preCastNativeCastBtn} />}
          </View>
          <Text style={styles.preCastText}>Pré-visualização em reprodução automática (mudo)</Text>
          <Text style={styles.preCastTextMuted}>O vídeo precisa carregar antes de conectar na TV.</Text>

          {hasFirstFrame ? (
            <TouchableOpacity
              style={[styles.preCastConnectBtn, pendingCastLoad && { opacity: 0.65 }]}
              onPress={requestCast}
              disabled={pendingCastLoad}>
              {pendingCastLoad ? (
                <ActivityIndicator size="small" color={StreamingTheme.colors.textPrimary} />
              ) : (
                <MaterialIcons name="cast-connected" size={18} color={StreamingTheme.colors.textPrimary} />
              )}
              <Text style={styles.preCastConnectBtnText}>
                {pendingCastLoad ? 'Conectando...' : 'Espelhar na TV'}
              </Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.preCastWaitingRow}>
              <ActivityIndicator size="small" color={StreamingTheme.colors.textPrimary} />
              <Text style={styles.preCastWaitingText}>Carregando vídeo...</Text>
            </View>
          )}
        </View>
      )}

      {isLocked ? (
        <TouchableOpacity style={styles.unlockBtn} onPress={() => setIsLocked(false)}>
          <MaterialIcons name="lock-open" size={22} color={StreamingTheme.colors.textPrimary} />
        </TouchableOpacity>
      ) : (
        !isPreCastMode && showControls && (
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
              <View style={styles.actionsRow}>
                              {/* Barra de progresso sempre no final do painel */}
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
                                    style={{ marginTop: 12 }}
                                  />
                                  <View style={styles.timeRow}>
                                    <Text style={styles.timeText}>{formatMs(position)}</Text>
                                    <Text style={styles.timeText}>{formatMs(duration)}</Text>
                                  </View>
                                </>
                              )}
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
                    name={screenMode === 'Preencher' ? 'fullscreen-exit' : 'fit-screen'}
                    size={20}
                    color={StreamingTheme.colors.textPrimary}
                  />
                  <Text style={styles.actionLabel}>{screenMode === 'Preencher' ? 'Original' : 'Preencher'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={() => setShowSettings((prev) => !prev)}>
                  <MaterialIcons name="tune" size={20} color={StreamingTheme.colors.textPrimary} />
                  <Text style={styles.actionLabel}>Opcoes</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, gestureTutorialEnabled && styles.optionChipActive]}
                  onPress={() => {
                    void toggleGestureTutorialSetting();
                  }}>
                  <MaterialIcons
                    name={gestureTutorialEnabled ? 'touch-app' : 'block'}
                    size={20}
                    color={StreamingTheme.colors.textPrimary}
                  />
                  <Text style={styles.actionLabel}>{gestureTutorialEnabled ? 'Gestos ON' : 'Gestos OFF'}</Text>
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
                options={availableQualityOptions}
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
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingVertical: 10,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  actionLabel: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 13,
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
  gestureTutorialActions: {
    marginTop: 8,
    flexDirection: 'row',
    gap: 8,
  },
  gestureTutorialActionBtn: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gestureTutorialActionBtnMuted: {
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  gestureTutorialActionBtnDanger: {
    borderColor: 'rgba(255,59,48,0.55)',
    backgroundColor: 'rgba(255,59,48,0.24)',
  },
  gestureTutorialActionText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 11,
    fontWeight: '800',
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
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 18,
    gap: 10,
  },
  settingsBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  settingsModalCard: {
    width: '100%',
    maxWidth: 620,
    maxHeight: '82%',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(7,9,15,0.95)',
    overflow: 'hidden',
  },
  settingsModalHeader: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  settingsModalTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '800',
  },
  settingsTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  optionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  optionChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionChipActive: {
    borderColor: 'rgba(255,59,48,0.55)',
    backgroundColor: 'rgba(255,59,48,0.24)',
  },
  optionText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '700',
  },
  optionTextActive: {
    color: StreamingTheme.colors.textPrimary,
  },
  settingsFoot: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  upgradeQualityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  upgradeQualityText: {
    flex: 1,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  networkStatsBadge: {
    position: 'absolute',
    bottom: 6,
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(16,21,37,0.72)',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  networkStatsBadgeText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 11,
    fontWeight: '700',
  },
  networkStatsMb: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 10,
    fontWeight: '600',
  },
  networkStatsQuality: {
    color: StreamingTheme.colors.accent,
    fontSize: 10,
    fontWeight: '700',
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
  castConnectedToast: {
    position: 'absolute',
    top: 136,
    alignSelf: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.55)',
    backgroundColor: 'rgba(34,197,94,0.24)',
    paddingHorizontal: 12,
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    zIndex: 100,
  },
  castConnectedToastText: {
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
  preCastCard: {
    position: 'absolute',
    left: 12,
    right: 12,
    top: 54,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(16,21,37,0.9)',
    padding: 12,
    gap: 6,
  },
  preCastHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  preCastBackBtn: {
    padding: 2,
  },
  preCastNativeCastBtn: {
    width: 28,
    height: 28,
    marginLeft: 'auto' as any,
  },
  preCastTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  preCastText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  preCastTextMuted: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },
  preCastConnectBtn: {
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingVertical: 11,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  preCastConnectBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
  },
  preCastWaitingRow: {
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  preCastWaitingText: {
    color: StreamingTheme.colors.textMuted,
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
  castOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 32,
    paddingHorizontal: 16,
  },
  castOverlayCard: {
    width: '100%',
    backgroundColor: 'rgba(10,14,22,0.92)',
    borderRadius: 16,
    paddingVertical: 18,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  castOverlayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  castOverlayDeviceName: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  castOverlayControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
    marginBottom: 16,
  },
  castCtrlBtn: {
    padding: 8,
  },
  castCtrlBtnMain: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  castVolumeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  castVolumeSlider: {
    flex: 1,
    height: 36,
  },
  castOverlayActions: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'flex-end',
  },
  castActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  castActionBtnDanger: {
    backgroundColor: 'rgba(255,82,82,0.12)',
  },
  castActionBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '500',
  },
  castActionBtnTextDanger: {
    color: '#ff5252',
  },
  // Fullscreen Cast styles (tela cheia do Cast em orientação vertical)
  castFullscreenContainer: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  castFullscreenContent: {
    flex: 1,
    width: '100%',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  castFullscreenHeader: {
    alignItems: 'center',
    gap: 8,
    marginTop: 24,
  },
  castFullscreenDeviceLabel: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
  castFullscreenDeviceName: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '800',
  },
  castFullscreenInfo: {
    alignItems: 'center',
    width: '100%',
    gap: 4,
  },
  castFullscreenTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
  },
  castFullscreenSubtitle: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  castFullscreenControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 32,
    marginVertical: 24,
  },
  castFsCtrlBtn: {
    padding: 12,
  },
  castFsCtrlBtnMain: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  castFullscreenProgressSection: {
    width: '100%',
    gap: 8,
    marginBottom: 20,
  },
  castFullscreenProgressBar: {
    width: '100%',
    height: 40,
  },
  castFullscreenTimeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  castFullscreenTime: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  castFullscreenVolumeSection: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
  },
  castFullscreenVolumeSlider: {
    flex: 1,
    height: 40,
  },
  castFullscreenActions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingBottom: 20,
    width: '100%',
  },
  castFsActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderColor: 'rgba(255,255,255,0.12)',
  },
  castFsActionBtnSecondary: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  castFsActionBtnDanger: {
    backgroundColor: 'rgba(255,82,82,0.15)',
    borderColor: 'rgba(255,82,82,0.3)',
  },
  castFsActionBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
});




