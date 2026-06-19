import { ActivityIndicator, Animated, StyleSheet, Text, View } from 'react-native';
import { useEffect, useRef } from 'react';

import { AppBackdrop } from '@/components/app-backdrop';
import { GlassSurface } from '@/components/glass-surface';
import { StreamingTheme } from '@/constants/streaming-theme';

type PageLoaderProps = {
  visible: boolean;
  label?: string;
};

export function PageLoader({ visible, label = 'Carregando...' }: PageLoaderProps) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
      ])
    );

    loop.start();
    return () => loop.stop();
  }, [pulse, visible]);

  if (!visible) {
    return null;
  }

  return (
    <View style={styles.overlay}>
      <AppBackdrop blurIntensity={34} />
      <Animated.View
        style={[
          styles.cardWrap,
          {
            transform: [
              {
                scale: pulse.interpolate({
                  inputRange: [0, 1],
                  outputRange: [1, 1.02],
                }),
              },
            ],
          },
        ]}
      >
        <GlassSurface style={styles.card} intensity={46}>
         
          <ActivityIndicator size="large" color={StreamingTheme.colors.accentAlt} />
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.caption}>Só um momento...</Text>
        </GlassSurface>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 99,
    overflow: 'hidden',
  },
  cardWrap: {
    width: '80%',
    maxWidth: 320,
  },
  card: {
    paddingHorizontal: 20,
    paddingVertical: 18,
    alignItems: 'center',
    gap: 10,
  },
  
  label: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 14,
  },
  caption: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
  },
});
