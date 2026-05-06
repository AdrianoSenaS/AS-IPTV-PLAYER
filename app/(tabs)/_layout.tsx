import { Tabs, useRouter } from 'expo-router';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, AppStateStatus, InteractionManager, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';

import {
  isProfileUnlocked,
  lockProfileAccessIfMultipleProfiles,
  shouldRequireProfileSelection,
} from '@/services/access-control';
import { shouldShowAlgorithmOnboarding } from '@/services/behavior-intelligence';
import { Feature, getActivePlan } from '@/services/subscription';
import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { MiniCastBar } from '@/components/mini-cast-bar';
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
  // Timestamp em que o app entrou em background. 0 = nao esta em background.
  const backgroundSinceRef = useRef(0);
  // Tempo minimo em background para acionar bloqueio de perfil e redirecionar.
  // Abaixo desse limite (PiP, crop de foto, notificacoes, espelhamento),
  // o app retorna ao mesmo estado sem nenhuma interrupcao.
  const RELOCK_AFTER_BG_MS = 30_000;

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

  // Garante que o guard do onboarding de IA so dispare uma vez por montagem.
  // Re-runs causariam loop: tabs → algoritmo-preferencias → loading → tabs → repeat.
  const algorithmGuardRanRef = useRef(false);

  useEffect(() => {
    if (algorithmGuardRanRef.current) return;
    algorithmGuardRanRef.current = true;

    const guard = async () => {
      const requireSelection = await shouldRequireProfileSelection();
      if (requireSelection && !(await isProfileUnlocked())) {
        router.replace('/perfil-acesso');
        return;
      }

      const shouldOpenAlgorithmSetup = await shouldShowAlgorithmOnboarding();
      if (shouldOpenAlgorithmSetup) {
        // Usa replace (nao push) para que o botao voltar nao retorne para /(tabs)
        // com a IA ainda pendente. Se o usuario pressionasse voltar na tela de IA,
        // o componente remontaria com algorithmGuardRanRef=false e a IA apareceria
        // novamente (bug de IA dupla reportado pelo usuario).
        router.replace('/algoritmo-preferencias');
      }
    };

    guard();
  }, [router]);

  useEffect(() => {
    const onStateChange = async (nextState: AppStateStatus) => {
      // 'inactive' e sempre transitorio (PiP, notifications, crop nativo, espelhamento).
      // Ignoramos completamente para nao interromper o estado do app.
      if (nextState === 'inactive') {
        return;
      }

      if (nextState === 'background') {
        // Apenas registra o momento em que foi para background.
        // O bloqueio so ocorre se o usuario demorar a voltar.
        backgroundSinceRef.current = Date.now();
        return;
      }

      if (nextState === 'active') {
        const bgDuration =
          backgroundSinceRef.current > 0 ? Date.now() - backgroundSinceRef.current : 0;
        backgroundSinceRef.current = 0;

        // Sempre recarrega features do plano (operacao leve).
        await loadPlanFeatures().catch(() => {
          setPlanFeatures(null);
        });

        // Background curto (PiP, crop, troca rapida): nao bloqueia nem redireciona.
        if (bgDuration < RELOCK_AFTER_BG_MS) {
          return;
        }

        // Background longo: bloqueia e verifica se precisa selecionar perfil.
        await lockProfileAccessIfMultipleProfiles();
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
  }, [loadPlanFeatures, router, RELOCK_AFTER_BG_MS]);

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
    <View style={{ flex: 1 }}>
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
          tabBarShowLabel: true,
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: '700',
            marginTop: 4,
            marginBottom: 2,
          },
          headerShown: false,
          tabBarButton: HapticTab,
          tabBarActiveBackgroundColor: 'transparent',
          tabBarBackground: () => <FloatingTabBackground />,
          tabBarStyle: {
            position: 'absolute',
            bottom: insets.bottom + 10,
            left: 16,
            right: 16,
            height: 84,
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
            tabBarIcon: ({ color }) => <IconSymbol size={33} name="house.fill" color={color} />,
          }}
        />
        <Tabs.Screen
          name="explore"
          options={{
            title: 'Explore',
            tabBarIcon: ({ color }) => <IconSymbol size={33} name="paperplane.fill" color={color} />,
          }}
          listeners={exploreListener}
        />
        <Tabs.Screen
          name="offline"
          options={{
            title: 'Downloads',
            tabBarIcon: ({ color }) => <MaterialIcons size={33} name="download" color={color} />,
          }}
          listeners={offlineListener}
        />
        <Tabs.Screen
          name="listas"
          options={{
            title: 'Listas',
            tabBarIcon: ({ color }) => <MaterialIcons size={33} name="library-music" color={color} />,
          }}
          listeners={listsListener}
        />
        <Tabs.Screen
          name="configuracoes"
          options={{
            title: 'Conta',
            tabBarIcon: ({ color }) => <MaterialIcons size={33} name="settings" color={color} />,
          }}
        />
      </Tabs>
      <MiniCastBar bottomOffset={insets.bottom + 96} />
    </View>
  );
}
