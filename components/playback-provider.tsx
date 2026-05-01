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
  const [isReady, setIsReady] = useState(Platform.OS !== 'android');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevAppStateRef = useRef<AppStateStatus>(AppState.currentState);

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

      // Ao voltar de background real, a Activity pode ter sido recriada.
      // Resetamos o player para evitar referência a Activity destruída.
      if (state === 'active' && prev === 'background') {
        if (timerRef.current) clearTimeout(timerRef.current);
        setIsReady(false);
        scheduleReady(350);
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
