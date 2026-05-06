import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import { StreamingTheme } from '@/constants/streaming-theme';
import {
  getGlobalCastState,
  subscribeToGlobalCastState,
  clearGlobalCastState,
} from '@/services/global-cast-session';

// Mock para tipos do Cast (em uso real vem de react-native-google-cast)
let useMediaStatus: any = () => null;
let useRemoteMediaClient: any = () => null;
let CastState: any = { CONNECTED: 'connected' };
let useCastState: any = () => null;

try {
  const castModule = require('react-native-google-cast');
  useMediaStatus = castModule?.useMediaStatus || useMediaStatus;
  useRemoteMediaClient = castModule?.useRemoteMediaClient || useRemoteMediaClient;
  CastState = castModule?.CastState || CastState;
  useCastState = castModule?.useCastState || useCastState;
} catch {
  // Cast module not available
}

type MiniCastBarProps = {
  bottomOffset?: number;
};

export function MiniCastBar({ bottomOffset = 96 }: MiniCastBarProps) {
  const [castState, setCastState] = useState(getGlobalCastState());
  const [castMediaStatus, setCastMediaStatus] = useState<any>(null);
  const [castIsPlaying, setCastIsPlaying] = useState(false);
  const [castVolume, setCastVolume] = useState(1);

  const remoteMediaClient = useRemoteMediaClient();
  const mediaStatus = useMediaStatus();
  const isCastConnected = useCastState() === CastState.CONNECTED;

  useEffect(() => {
    const unsubscribe = subscribeToGlobalCastState((newState) => {
      setCastState(newState);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    setCastMediaStatus(mediaStatus);
    setCastIsPlaying(String(mediaStatus?.playerState || '').toLowerCase() === 'playing');
  }, [mediaStatus]);

  useEffect(() => {
    const level = mediaStatus?.volume?.level;
    if (typeof level !== 'number') return;
    setCastVolume(Math.max(0, Math.min(1, level)));
  }, [mediaStatus?.volume?.level]);

  if (!castState.isActive || !isCastConnected) {
    return null;
  }

  const progressPercent =
    (() => {
      const toSec = (value: unknown) => {
        const n = Number(value || 0);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return n > 10_000 ? n / 1000 : n;
      };
      const currentSec = toSec(mediaStatus?.streamPosition);
      const durationSec = toSec(mediaStatus?.duration);
      return durationSec > 0 ? currentSec / durationSec : 0;
    })();

  const toCastSeconds = (value: unknown) => {
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 10_000 ? n / 1000 : n;
  };

  const currentTimeSec = toCastSeconds(mediaStatus?.streamPosition);
  const durationSec = toCastSeconds(mediaStatus?.duration);

  const formatTime = (secondsRaw: number | undefined) => {
    const safe = toCastSeconds(secondsRaw);
    if (!safe || safe < 0) return '0:00';
    const totalSeconds = Math.floor(safe);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };

  const togglePlayPause = () => {
    if (!remoteMediaClient) return;
    if (castIsPlaying) {
      remoteMediaClient.pause().catch(() => {});
    } else {
      remoteMediaClient.play().catch(() => {});
    }
  };

  const setReceiverVolume = (value: number) => {
    if (!remoteMediaClient) return;
    const next = Math.max(0, Math.min(1, Number(value || 0)));
    setCastVolume(next);
    remoteMediaClient.setStreamVolume(next).catch(() => {});
  };

  const adjustReceiverVolume = (delta: number) => {
    setReceiverVolume(castVolume + delta);
  };

  const wrapperStyle = useMemo(
    () => [styles.wrapper, { bottom: Math.max(8, bottomOffset) }] as const,
    [bottomOffset]
  );

  const stopCast = async () => {
    try {
      if (remoteMediaClient) {
        await remoteMediaClient.stop();
      }
      const GoogleCast = require('react-native-google-cast')?.default;
      if (GoogleCast?.endCurrentSession) {
        GoogleCast.endCurrentSession(false);
      }
    } catch (err) {
      console.log('[MiniCastBar] Erro ao parar:', err);
    }
    clearGlobalCastState();
  };

  return (
    <View style={wrapperStyle} pointerEvents="box-none">
    <View style={styles.miniCastBar}>
      <View style={styles.miniCastContent}>
        {/* Info do conteúdo */}
        <View style={styles.miniCastInfo}>
          <MaterialIcons
            name="cast-connected"
            size={14}
            color={StreamingTheme.colors.accent}
          />
          <Text style={styles.miniCastTitle} numberOfLines={1}>
            {castState.title}
          </Text>
        </View>

        {/* Controles */}
        <View style={styles.miniCastControls}>
          {/* Play/Pause */}
          <TouchableOpacity
            style={styles.miniCtrlBtn}
            onPress={togglePlayPause}>
            <MaterialIcons
              name={castIsPlaying ? 'pause' : 'play-arrow'}
              size={16}
              color={StreamingTheme.colors.textPrimary}
            />
          </TouchableOpacity>

          {/* Progresso */}
          <View style={styles.miniProgressContainer}>
            <Slider
              style={styles.miniProgressSlider}
              value={progressPercent}
              onSlidingComplete={(value) => {
                if (remoteMediaClient && durationSec > 0) {
                  const newPosSec = value * durationSec;
                  remoteMediaClient.seek({ position: newPosSec }).catch(() => {});
                }
              }}
              minimumValue={0}
              maximumValue={1}
              minimumTrackTintColor={StreamingTheme.colors.accent}
              maximumTrackTintColor="rgba(255,255,255,0.2)"
              thumbTintColor={StreamingTheme.colors.textPrimary}
            />
            <Text style={styles.miniTime}>
              {formatTime(currentTimeSec)} / {formatTime(durationSec)}
            </Text>
          </View>

          <View style={styles.volumeContainer}>
            <TouchableOpacity style={styles.miniCtrlBtn} onPress={() => adjustReceiverVolume(-0.08)}>
              <MaterialIcons name="volume-down" size={15} color={StreamingTheme.colors.textPrimary} />
            </TouchableOpacity>
            <Slider
              style={styles.miniVolumeSlider}
              value={castVolume}
              onValueChange={setCastVolume}
              onSlidingComplete={setReceiverVolume}
              minimumValue={0}
              maximumValue={1}
              minimumTrackTintColor={StreamingTheme.colors.accent}
              maximumTrackTintColor="rgba(255,255,255,0.2)"
              thumbTintColor={StreamingTheme.colors.textPrimary}
            />
            <TouchableOpacity style={styles.miniCtrlBtn} onPress={() => adjustReceiverVolume(0.08)}>
              <MaterialIcons name="volume-up" size={15} color={StreamingTheme.colors.textPrimary} />
            </TouchableOpacity>
          </View>

          {/* Parar Cast */}
          <TouchableOpacity
            style={styles.miniCtrlBtn}
            onPress={stopCast}>
            <MaterialIcons
              name="close"
              size={16}
              color="#ff5252"
            />
          </TouchableOpacity>
        </View>
      </View>
    </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 90,
    elevation: 90,
  },
  miniCastBar: {
    backgroundColor: 'rgba(16, 21, 37, 0.95)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  miniCastContent: {
    gap: 6,
  },
  miniCastInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  miniCastTitle: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
    flex: 1,
  },
  miniCastControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  miniCtrlBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniProgressContainer: {
    flex: 1,
    gap: 2,
  },
  miniProgressSlider: {
    width: '100%',
    height: 20,
  },
  miniTime: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 9,
    fontWeight: '600',
    textAlign: 'center',
  },
  volumeContainer: {
    width: 132,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  miniVolumeSlider: {
    flex: 1,
    height: 20,
  },
});
