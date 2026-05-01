import { Tabs, useRouter } from 'expo-router';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, AppStateStatus, InteractionManager, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';

import {
  isProfileUnlocked,
  lockProfileAccessIfMultipleProfiles,
  shouldRequireProfileSelection,
} from '@/services/access-control';
import { Feature, getActivePlan } from '@/services/subscription';
import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { StreamingTheme } from '@/constants/streaming-theme';

function FloatingTabBackground() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <BlurView intensity={42} tint="dark" style={StyleSheet.absoluteFill} />
      <LinearGradient
        colors={['rgba(255,255,255,0.10)', 'rgba(12,16,27,0.70)', 'rgba(7,9,20,0.92)']}
        style={StyleSheet.absoluteFill}
      />
      <View style={floatStyles.glowPrimary} />
      <View style={floatStyles.glowSecondary} />
      <View style={floatStyles.topBorder} />
    </View>
  );
}

const floatStyles = StyleSheet.create({
  topBorder: {
    position: 'absolute',
    top: 0,
    left: 22,
    right: 22,
    height: 1,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.20)',
  },
  glowPrimary: {
    position: 'absolute',
    top: -28,
    left: 42,
    width: 112,
    height: 112,
    borderRadius: 999,
    backgroundColor: 'rgba(255,143,58,0.12)',
  },
  glowSecondary: {
    position: 'absolute',
    bottom: -26,
    right: 44,
    width: 96,
    height: 96,
    borderRadius: 999,
    backgroundColor: 'rgba(255,59,48,0.12)',
  },
});

export default function TabLayout() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [planFeatures, setPlanFeatures] = useState<Set<Feature> | null>(null);

  const loadPlanFeatures = useCallback(async () => {
    const activePlan = await getActivePlan();
    setPlanFeatures(new Set(activePlan.features));
  }, []);

  useEffect(() => {
    // Prefetch leve para reduzir o atraso do primeiro toque nas tabs.
    const task = InteractionManager.runAfterInteractions(() => {
      void Promise.allSettled([
        router.prefetch('/(tabs)/explore' as any),
        router.prefetch('/(tabs)/offline' as any),
        router.prefetch('/(tabs)/listas' as any),
        router.prefetch('/(tabs)/configuracoes' as any),
      ]);
    });

    return () => {
      task.cancel();
    };
  }, [router]);

  useEffect(() => {
    loadPlanFeatures().catch(() => {
      setPlanFeatures(null);
    });
  }, [loadPlanFeatures]);

  const gateTabPressSync = useCallback((feature: Feature) => (e: any) => {
    // Caminho síncrono: sem await para não introduzir delay no toque.
    if (planFeatures && !planFeatures.has(feature)) {
      e.preventDefault();
      router.push({ pathname: '/assinar', params: { feature } });
    }
  }, [planFeatures, router]);

  useEffect(() => {
    const guard = async () => {
      const requireSelection = await shouldRequireProfileSelection();
      if (requireSelection && !(await isProfileUnlocked())) {
        router.replace('/perfil-acesso');
      }
    };

    guard();
  }, [router]);

  useEffect(() => {
    const onStateChange = async (nextState: AppStateStatus) => {
      if (nextState === 'inactive' || nextState === 'background') {
        await lockProfileAccessIfMultipleProfiles();
        return;
      }

      if (nextState === 'active') {
        await loadPlanFeatures().catch(() => {
          setPlanFeatures(null);
        });

        const requireSelection = await shouldRequireProfileSelection();
        if (requireSelection && !(await isProfileUnlocked())) {
          router.replace('/perfil-acesso');
        }
      }
    };

    const subscription = AppState.addEventListener('change', onStateChange);
    return () => {
      subscription.remove();
    };
  }, [loadPlanFeatures, router]);

  const exploreListener = useMemo(
    () => ({ tabPress: gateTabPressSync('explore') }),
    [gateTabPressSync]
  );

  const offlineListener = useMemo(
    () => ({ tabPress: gateTabPressSync('downloads') }),
    [gateTabPressSync]
  );

  const listsListener = useMemo(
    () => ({ tabPress: gateTabPressSync('lists') }),
    [gateTabPressSync]
  );

  return (
    <Tabs
      detachInactiveScreens={false}
      screenOptions={{
        lazy: false,
        freezeOnBlur: false,
        animation: 'fade',
        sceneStyle: {
          backgroundColor: 'transparent',
        },
        tabBarActiveTintColor: '#FFFFFF',
        tabBarInactiveTintColor: 'rgba(168,178,209,0.55)',
        tabBarShowLabel: false,
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarActiveBackgroundColor: 'rgba(255,255,255,0.08)',
        tabBarBackground: () => <FloatingTabBackground />,
        tabBarStyle: {
          position: 'absolute',
          bottom: insets.bottom + 10,
          left: 16,
          right: 16,
          height: 78,
          borderRadius: 30,
          backgroundColor: 'transparent',
          borderTopWidth: 0,
          elevation: 26,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 10 },
          shadowOpacity: 0.48,
          shadowRadius: 22,
          overflow: 'hidden',
        },
        tabBarItemStyle: {
          marginVertical: 8,
          marginHorizontal: 4,
          borderRadius: 22,
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        },
        tabBarIconStyle: {
          marginBottom: 0,
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => <IconSymbol size={30} name="house.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Explore',
          tabBarIcon: ({ color }) => <IconSymbol size={30} name="paperplane.fill" color={color} />,
        }}
        listeners={exploreListener}
      />
      <Tabs.Screen
        name="offline"
        options={{
          title: 'Downloads',
          tabBarIcon: ({ color }) => <MaterialIcons size={30} name="download" color={color} />,
        }}
        listeners={offlineListener}
      />
      <Tabs.Screen
        name="listas"
        options={{
          title: 'Listas',
          tabBarIcon: ({ color }) => <MaterialIcons size={30} name="library-music" color={color} />,
        }}
        listeners={listsListener}
      />
      <Tabs.Screen
        name="configuracoes"
        options={{
          title: 'Conta',
          tabBarIcon: ({ color }) => <MaterialIcons size={30} name="settings" color={color} />,
        }}
      />
    </Tabs>
  );
}
