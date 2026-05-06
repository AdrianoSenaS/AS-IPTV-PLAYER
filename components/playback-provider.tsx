import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import { useVideoPlayer } from 'expo-video';

type SharedPlayer = ReturnType<typeof useVideoPlayer>;

type PlaybackContextValue = {
  player: SharedPlayer | null;
  sourceUrl: string;
  setSourceUrl: (url: string) => void;
  isReady: boolean;
};

const PlaybackContext = createContext<PlaybackContextValue | null>(null);

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [sourceUrl, setSourceUrl] = useState('');
  const [isReady, setIsReady] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevAppStateRef = useRef<AppStateStatus>(AppState.currentState);
  const backgroundSinceRef = useRef(0);
  // Em alguns aparelhos Android, desmontar/remontar o player ao voltar de background
  // causa referencias nativas invalidadas (shared object released). Mantemos o mesmo
  // player vivo para estabilidade.
  const PLAYER_RESET_AFTER_BG_MS = Number.POSITIVE_INFINITY;

  const scheduleReady = (delay = 350) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setIsReady(true), delay);
  };

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    scheduleReady();

    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      const prev = prevAppStateRef.current;
      prevAppStateRef.current = state;

      if (state === 'background') {
        backgroundSinceRef.current = Date.now();
        return;
      }

      if (state === 'inactive') {
        // Estado transitorio (PiP, notificacoes, crop nativo): nao registra background.
        return;
      }

      // Mantemos o player vivo ao voltar para active; recriar player tem causado
      // PlaybackException em alguns dispositivos.
      if (state === 'active' && prev === 'background') {
        const bgDuration =
          backgroundSinceRef.current > 0 ? Date.now() - backgroundSinceRef.current : 0;
        backgroundSinceRef.current = 0;

        if (bgDuration < PLAYER_RESET_AFTER_BG_MS) {
          return;
        }
      }
    });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      sub.remove();
    };
  }, []);

  const value = useMemo(
    () => ({
      player: null,
      sourceUrl,
      setSourceUrl,
      isReady,
    }),
    [sourceUrl, isReady]
  );

  if (!isReady) {
    return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>;
  }

  return <PlaybackProviderInner sourceUrl={sourceUrl} setSourceUrl={setSourceUrl}>{children}</PlaybackProviderInner>;
}

function PlaybackProviderInner({
  children,
  sourceUrl,
  setSourceUrl,
}: {
  children: ReactNode;
  sourceUrl: string;
  setSourceUrl: (url: string) => void;
}) {
  const player = useVideoPlayer(sourceUrl ? { uri: sourceUrl } : null, (instance) => {
    instance.timeUpdateEventInterval = 0.5;
    instance.loop = false;
    instance.volume = 1;
    instance.muted = false;
    instance.allowsExternalPlayback = true;
  });

  const value = useMemo(
    () => ({
      player,
      sourceUrl,
      setSourceUrl,
      isReady: true,
    }),
    [player, sourceUrl]
  );

  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>;
}

export function usePlayback() {
  const context = useContext(PlaybackContext);
  if (!context) {
    throw new Error('usePlayback deve ser usado dentro de PlaybackProvider.');
  }

  return context;
}
