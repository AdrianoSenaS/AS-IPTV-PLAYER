import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  AppStateStatus,
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
import {
  clearMiniPlayerState,
  MiniPlayerState,
  subscribeMiniPlayer,
} from '@/services/mini-player';

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
  const positionRef = useRef(0);

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

  const getBounds = () => {
    const minX = CARD_MARGIN;
    const maxX = Math.max(CARD_MARGIN, width - CARD_WIDTH - CARD_MARGIN);
    const minY = CARD_MARGIN;
    const maxY = Math.max(CARD_MARGIN, height - CARD_HEIGHT - BOTTOM_GAP);
    return { minX, maxX, minY, maxY };
  };

  const applyCardPosition = (x: number, y: number) => {
    cardPosition.setValue({ x, y });
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

            const clampedY = clamp(value.y, minY, maxY);
            const middleX = (minX + maxX) / 2;
            const snapX = value.x <= middleX ? minX : maxX;

            Animated.spring(cardPosition, {
              toValue: { x: snapX, y: clampedY },
              useNativeDriver: false,
              bounciness: 4,
            }).start();
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
    if (!miniPlayerState?.url) return;

    setHasMiniFrame(false);
    setIsMiniLoading(true);
    playbackPlayer.play();
    setIsPlaying(true);
  }, [miniPlayerState?.url, playbackPlayer]);

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
        positionRef.current = Math.max(0, Math.floor(currentTime * 1000));
        if (currentTime > 0 && !hasMiniFrame) {
          setHasMiniFrame(true);
          setIsMiniLoading(false);
        }
      }),
    ];

    return () => {
      subscriptions.forEach((sub) => sub.remove());
    };
  }, [miniPlayerState?.url, playbackPlayer, hasMiniFrame]);

  useEffect(() => {
    if (!miniPlayerState?.url) {
      hasInitialCardPositionRef.current = false;
      return;
    }

    const { minX, maxX, minY, maxY } = getBounds();

    if (!hasInitialCardPositionRef.current) {
      applyCardPosition(maxX, maxY);
      hasInitialCardPositionRef.current = true;
      return;
    }

    cardPosition.stopAnimation((value: any) => {
      applyCardPosition(clamp(value.x, minX, maxX), clamp(value.y, minY, maxY));
    });
  }, [miniPlayerState?.url, width, height]);

  useEffect(() => {
    if (Platform.OS !== 'android' || !miniPlayerState?.url) return;

    const onStateChange = async (nextState: AppStateStatus) => {
      if ((nextState !== 'inactive' && nextState !== 'background') || isStartingPipRef.current) return;

      await startSystemPip(false);
    };

    const subscription = AppState.addEventListener('change', onStateChange);
    return () => {
      subscription.remove();
    };
  }, [miniPlayerState?.url]);

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
    clearMiniPlayerState();

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
