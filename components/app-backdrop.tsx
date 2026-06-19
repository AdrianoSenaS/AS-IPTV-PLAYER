import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { StreamingTheme } from '@/constants/streaming-theme';

type AppBackdropProps = {
  blurIntensity?: number;
};

export function AppBackdrop({ blurIntensity = 28 }: AppBackdropProps) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient colors={StreamingTheme.gradients.hero} style={StyleSheet.absoluteFill} />
      <BlurView intensity={blurIntensity} tint="dark" style={styles.topMist} />
      <BlurView intensity={Math.max(18, blurIntensity - 8)} tint="dark" style={styles.bottomMist} />
      <LinearGradient colors={['rgba(255,255,255,0.08)', 'rgba(255,255,255,0)']} style={styles.edgeGlow} />
    </View>
  );
}

const styles = StyleSheet.create({
 
  
  topMist: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 180,
  },
  bottomMist: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 220,
  },
  edgeGlow: {
    position: 'absolute',
    top: 0,
    left: 20,
    right: 20,
    height: 1,
    borderRadius: 999,
  },
});
