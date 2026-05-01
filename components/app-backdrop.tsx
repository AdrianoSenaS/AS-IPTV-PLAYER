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
      <View style={styles.orbPrimary} />
      <View style={styles.orbSecondary} />
      <View style={styles.orbTertiary} />
      <BlurView intensity={blurIntensity} tint="dark" style={styles.topMist} />
      <BlurView intensity={Math.max(18, blurIntensity - 8)} tint="dark" style={styles.bottomMist} />
      <LinearGradient colors={['rgba(255,255,255,0.08)', 'rgba(255,255,255,0)']} style={styles.edgeGlow} />
    </View>
  );
}

const styles = StyleSheet.create({
  orbPrimary: {
    position: 'absolute',
    top: 56,
    right: -64,
    width: 220,
    height: 220,
    borderRadius: 999,
    backgroundColor: 'rgba(255,59,48,0.16)',
  },
  orbSecondary: {
    position: 'absolute',
    top: 220,
    left: -58,
    width: 180,
    height: 180,
    borderRadius: 999,
    backgroundColor: 'rgba(255,143,58,0.12)',
  },
  orbTertiary: {
    position: 'absolute',
    bottom: 110,
    right: 24,
    width: 150,
    height: 150,
    borderRadius: 999,
    backgroundColor: 'rgba(93,169,255,0.08)',
  },
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
