import { MaterialIcons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  PanResponder,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { isPictureInPictureSupported, VideoView } from 'expo-video';

import { usePlayback } from '@/components/playback-provider';
import { StreamingTheme } from '@/constants/streaming-theme';
import { getDbValue, setDbValue } from '@/services/local-db';
import {
  clearMiniPlayerState,
  MiniPlayerState,
  setMiniPlayerState,
  subscribeMiniPlayer,
} from '@/services/mini-player';

const MINI_PLAYER_POSITION_KEY = 'ui.mini-player.position.v1';

type MiniPlayerCardPosition = {
  x: number;
  y: number;
};

const PLAYER_FALLBACK = {
  currentTime: 0,
  play() {},
  pause() {},
  addListener() {
    return { remove() {} };
  },
} as any;

export function MiniPlayerHost() {
  const CARD_WIDTH = 220;
  const CARD_HEIGHT = 170;
  const CARD_MARGIN = 12;
  const BOTTOM_GAP = 84;

  const router = useRouter();
  const pathname = usePathname();
  const { width, height } = useWindowDimensions();
  const videoViewRef = useRef<VideoView>(null);
  const isStartingPipRef = useRef(false);
  const hasInitialCardPositionRef = useRef(false);
  const cardPosition = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const { player } = usePlayback();
  const playbackPlayer = player ?? PLAYER_FALLBACK;
  const [miniPlayerState, setMiniPlayerStateLocal] = useState<MiniPlayerState | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isMiniLoading, setIsMiniLoading] = useState(true);
  const [hasMiniFrame, setHasMiniFrame] = useState(false);
  const hasInitializedRef = useRef(false);
  const positionRef = useRef(0);
  const savedCardPositionRef = useRef<MiniPlayerCardPosition | null>(null);

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

  const getBounds = () => {
    const minX = CARD_MARGIN;
    const maxX = Math.max(CARD_MARGIN, width - CARD_WIDTH - CARD_MARGIN);
    const minY = CARD_MARGIN;
    const maxY = Math.max(CARD_MARGIN, height - CARD_HEIGHT - BOTTOM_GAP);
    return { minX, maxX, minY, maxY };
  };

  const getDefaultCardPosition = (): MiniPlayerCardPosition => {
    const { maxX, maxY } = getBounds();
    return { x: maxX, y: maxY };
  };

  const clampCardPosition = (
    nextPosition?: Partial<MiniPlayerCardPosition> | null
  ): MiniPlayerCardPosition => {
    const { minX, maxX, minY, maxY } = getBounds();
    const fallback = getDefaultCardPosition();
    const rawX = Number(nextPosition?.x);
    const rawY = Number(nextPosition?.y);

    return {
      x: clamp(Number.isFinite(rawX) ? rawX : fallback.x, minX, maxX),
      y: clamp(Number.isFinite(rawY) ? rawY : fallback.y, minY, maxY),
    };
  };

  const applyCardPosition = (x: number, y: number) => {
    cardPosition.setValue({ x, y });
  };

  const persistCardPosition = (nextPosition: MiniPlayerCardPosition) => {
    savedCardPositionRef.current = nextPosition;
    void setDbValue(MINI_PLAYER_POSITION_KEY, nextPosition);
  };

  const startSystemPip = async (showError: boolean) => {
    if (Platform.OS !== 'android') return;
    if (isStartingPipRef.current) return;

    try {
      const supported = await isPictureInPictureSupported();
      if (!supported) {
        if (showError) {
          Alert.alert('PiP indisponivel', 'Este dispositivo nao suporta Picture in Picture para este player.');
        }
        return;
      }

      isStartingPipRef.current = true;
      await videoViewRef.current?.startPictureInPicture();
    } catch {
      if (showError) {
        Alert.alert('Falha ao iniciar PiP', 'Nao foi possivel abrir o PiP do sistema agora.');
      }
    } finally {
      setTimeout(() => {
        isStartingPipRef.current = false;
      }, 500);
    }
  };

  const stopSystemPip = async () => {
    if (Platform.OS !== 'android') return;
    try {
      await videoViewRef.current?.stopPictureInPicture?.();
    } catch {
      // ignora
    }
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: (_, gestureState) =>
          Math.abs(gestureState.dx) > 4 || Math.abs(gestureState.dy) > 4,
        onMoveShouldSetPanResponderCapture: (_, gestureState) =>
          Math.abs(gestureState.dx) > 4 || Math.abs(gestureState.dy) > 4,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          cardPosition.stopAnimation((value: any) => {
            cardPosition.setOffset({ x: value.x, y: value.y });
            cardPosition.setValue({ x: 0, y: 0 });
          });
        },
        onPanResponderMove: Animated.event([null, { dx: cardPosition.x, dy: cardPosition.y }], {
          useNativeDriver: false,
        }),
        onPanResponderRelease: (_, gestureState) => {
          cardPosition.flattenOffset();
          cardPosition.stopAnimation((value: any) => {
            const { minX, maxX, minY, maxY } = getBounds();

            const swipedOut =
              Math.abs(gestureState.dx) > 120 &&
              Math.abs(gestureState.vx) > 0.25 &&
              (value.x < minX - 20 || value.x > maxX + 20);

            if (swipedOut) {
              const targetX = value.x < minX ? -CARD_WIDTH - 40 : width + 40;
              Animated.timing(cardPosition, {
                toValue: { x: targetX, y: clamp(value.y, minY, maxY) },
                duration: 170,
                useNativeDriver: false,
              }).start(() => {
                handleClose();
              });
              return;
            }

            const clampedX = clamp(value.x, minX, maxX);
            const clampedY = clamp(value.y, minY, maxY);
            const nextPosition = { x: clampedX, y: clampedY };

            Animated.spring(cardPosition, {
              toValue: nextPosition,
              useNativeDriver: false,
              bounciness: 4,
            }).start(() => {
              persistCardPosition(nextPosition);
            });
          });
        },
      }),
    [height, width]
  );

  useEffect(() => {
    const unsubscribe = subscribeMiniPlayer((nextState) => {
      setMiniPlayerStateLocal(nextState);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!miniPlayerState?.url) {
      hasInitializedRef.current = false;
      return;
    }

    // Reset flag ao trocar de URL
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      setHasMiniFrame(false);
      setIsMiniLoading(true);
      
      // Sincroniza para o tempo armazenado do mini-player apenas na PRIMEIRA inicialização
      const startPositionSec = (miniPlayerState.positionMs || 0) / 1000;
      if (startPositionSec > 0) {
        playbackPlayer.currentTime = startPositionSec;
        positionRef.current = miniPlayerState.positionMs || 0;
      }
      
      playbackPlayer.play();
      setIsPlaying(true);
    }
  }, [miniPlayerState?.url]);

  useEffect(() => {
    if (!miniPlayerState?.url) return;

    const subscriptions = [
      playbackPlayer.addListener('statusChange', ({ status }: any) => {
        setIsMiniLoading(!hasMiniFrame && (status === 'idle' || status === 'loading'));
      }),
      playbackPlayer.addListener('playingChange', ({ isPlaying: nowPlaying }: any) => {
        setIsPlaying(nowPlaying);
      }),
      playbackPlayer.addListener('sourceLoad', () => {
        if (playbackPlayer.currentTime > 0) {
          setHasMiniFrame(true);
          setIsMiniLoading(false);
        }
        playbackPlayer.play();
      }),
      playbackPlayer.addListener('timeUpdate', ({ currentTime }: any) => {
        const positionMs = Math.max(0, Math.floor(currentTime * 1000));
        positionRef.current = positionMs;
        // Atualiza posição no estado compartilhado (importante para expandir sem perder progresso)
        setMiniPlayerState((prev) => (prev ? { ...prev, positionMs } : prev));
        if (currentTime > 0 && !hasMiniFrame) {
          setHasMiniFrame(true);
          setIsMiniLoading(false);
        }
      })
    ];

    return () => {
      subscriptions.forEach((sub) => sub.remove());
    };
  }, [miniPlayerState?.url, hasMiniFrame]);

  useEffect(() => {
    if (!miniPlayerState?.url) {
      hasInitialCardPositionRef.current = false;
      return;
    }

    let cancelled = false;

    if (!hasInitialCardPositionRef.current) {
      void getDbValue<MiniPlayerCardPosition>(MINI_PLAYER_POSITION_KEY).then((storedPosition) => {
        if (cancelled) {
          return;
        }
        const nextPosition = clampCardPosition(storedPosition || getDefaultCardPosition());
        applyCardPosition(nextPosition.x, nextPosition.y);
        savedCardPositionRef.current = nextPosition;
        hasInitialCardPositionRef.current = true;
      });

      return () => {
        cancelled = true;
      };
    }

    const nextPosition = clampCardPosition(savedCardPositionRef.current || getDefaultCardPosition());
    applyCardPosition(nextPosition.x, nextPosition.y);
    savedCardPositionRef.current = nextPosition;

    return () => {
      cancelled = true;
    };
  }, [miniPlayerState?.url, width, height]);

  // AppState listener REMOVIDO - PiP automático causava bugs
  // O PiP agora é controlado apenas manualmente pelo usuário ou pelo player.tsx

  // Nunca renderiza o mini player por cima da tela principal do player.
  // Isso evita duas VideoView tentando usar o mesmo objeto de player.
  if (String(pathname || '').startsWith('/player')) {
    return null;
  }

  if (!miniPlayerState?.url || !player) {
    return null;
  }

  const handleTogglePlay = () => {
    if (isPlaying) {
      playbackPlayer.pause();
      return;
    }

    playbackPlayer.play();
  };

  const handleClose = () => {
    try {
      playbackPlayer.pause();
    } catch {
      // Ignora falhas de pause em alguns estados do player.
    }
    clearMiniPlayerState();
  };

  const handleExpand = () => {
    const precisePositionMs = Math.max(0, Math.floor((playbackPlayer.currentTime || 0) * 1000));
    const lastPositionMs = precisePositionMs || positionRef.current || miniPlayerState.positionMs || 0;
    const snapshot = miniPlayerState;
    
    // Para o PiP nativo quando expandir
    void stopSystemPip();
    
    // Pausa o player mas NÃO limpa o estado ainda
    // Deixa o player.tsx tomar controle da reprodução
    try {
      playbackPlayer.pause();
    } catch {
      // ignora
    }

    router.push({
      pathname: '/player',
      params: {
        mode: snapshot.mode,
        title: snapshot.title,
        url: snapshot.url,
        contentId: snapshot.contentId || '',
        seriesId: snapshot.seriesId || '',
        playlistKey: snapshot.playlistKey || '',
        playlistIndex: String(snapshot.playlistIndex || 0),
        startPositionMs: String(lastPositionMs),
      },
    });
    
    // Limpa o estado após um delay para garantir que a navegação aconteça
    setTimeout(() => {
      clearMiniPlayerState();
    }, 300);
  };

  return (
    <View pointerEvents="box-none" style={styles.wrap}>
      <Animated.View style={[styles.card, cardPosition.getLayout()]} {...panResponder.panHandlers}>
        <TouchableOpacity
          style={styles.videoTapArea}
          activeOpacity={0.9}
          onPress={handleExpand}
          {...panResponder.panHandlers}>
          <VideoView
            ref={videoViewRef}
            player={player}
            style={styles.video}
            pointerEvents="none"
            contentFit="cover"
            nativeControls={false}
            allowsPictureInPicture
            startsPictureInPictureAutomatically={Platform.OS === 'android'}
            onFirstFrameRender={() => {
              setHasMiniFrame(true);
              setIsMiniLoading(false);
            }}
          />
          {isMiniLoading && (
            <View style={styles.loadingOverlay} pointerEvents="none">
              <ActivityIndicator size="small" color={StreamingTheme.colors.textPrimary} />
            </View>
          )}
        </TouchableOpacity>

        <View style={styles.infoBar}>
          <Text style={styles.title} numberOfLines={1}>
            {miniPlayerState.title || 'Player'}
          </Text>
          <View style={styles.actions}>
            {Platform.OS === 'android' && (
              <TouchableOpacity style={styles.iconBtn} onPress={() => startSystemPip(true)}>
                <MaterialIcons name="picture-in-picture-alt" size={16} color={StreamingTheme.colors.textPrimary} />
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.iconBtn} onPress={handleExpand}>
              <MaterialIcons name="open-in-full" size={16} color={StreamingTheme.colors.textPrimary} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconBtn} onPress={handleTogglePlay}>
              <MaterialIcons
                name={isPlaying ? 'pause' : 'play-arrow'}
                size={18}
                color={StreamingTheme.colors.textPrimary}
              />
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconBtn} onPress={handleClose}>
              <MaterialIcons name="close" size={18} color={StreamingTheme.colors.textPrimary} />
            </TouchableOpacity>
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 90,
  },
  card: {
    position: 'absolute',
    width: 220,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(7,9,15,0.94)',
    elevation: 8,
  },
  videoTapArea: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#000',
  },
  video: {
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.22)',
  },
  infoBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  title: {
    flex: 1,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  iconBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
});
