import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef } from 'react';
import { AppState, AppStateStatus, InteractionManager, PermissionsAndroid, Platform } from 'react-native';
import 'react-native-reanimated';

import { MiniPlayerHost } from '@/components/mini-player-host';
import { PlaybackProvider } from '@/components/playback-provider';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { recordSessionEvent } from '@/services/behavior-intelligence';
import { updateAiSettings } from '@/services/ai-settings';
import { getDbValue, setDbValue } from '@/services/local-db';
import { cleanupOldContentDetailsCache } from '@/services/content-details-cache';
import { registerPlanPushToken, syncPlanStateFromServer } from '@/services/plan-push-notifications';
import { refreshSmartRecommendationNotifications } from '@/services/smart-notifications';
import { ensureRealtimeSessionForActiveProfile } from '@/services/realtime-presence';
import { isNonMobileDevice } from '@/services/device-profile';

const DETAILS_CACHE_CLEANUP_KEY = 'maintenance.details_cache_cleanup.last_at.v1';
const DETAILS_CACHE_CLEANUP_INTERVAL_MS = 1000 * 60 * 60 * 24;

async function requestAppPermissions() {
  if (Platform.OS !== 'android') return;

  const toRequest: string[] = [];

  // Notificações (Android 13+)
  if (parseInt(String(Platform.Version), 10) >= 33) {
    toRequest.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    toRequest.push(PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES);
    toRequest.push(PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO);
    toRequest.push(PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO);
  } else {
    toRequest.push(PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE);
    toRequest.push(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
  }

  try {
    await PermissionsAndroid.requestMultiple(toRequest as any);
  } catch {
    // silencia falhas — usuário pode negar
  }
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const nonMobileDevice = isNonMobileDevice();
  const lastNotificationRefreshRef = useRef(0);
  const isNotificationRefreshRunningRef = useRef(false);
  const activeSinceRef = useRef(Date.now());

  useEffect(() => {
    if (nonMobileDevice) {
      // Em telas grandes, reduz custo de inicializacao e desativa IA/recomendacoes.
      updateAiSettings({
        enabled: false,
        tmdbEnrichmentEnabled: false,
        recommendationChipsEnabled: false,
        recomputeOnHomeFocus: false,
      }).catch(() => {
        // Falha de persistencia nao deve bloquear abertura.
      });
      return;
    }

    const runSmartNotificationsRefresh = () => {
      if (isNotificationRefreshRunningRef.current) {
        return;
      }

      isNotificationRefreshRunningRef.current = true;
      refreshSmartRecommendationNotifications()
        .then(() => {
          lastNotificationRefreshRef.current = Date.now();
        })
        .catch(() => {
          // Continua a inicializacao mesmo se notificacao falhar.
        })
        .finally(() => {
          isNotificationRefreshRunningRef.current = false;
        });
    };

    // Mantem o boot enxuto para evitar congelamento na splash.
    requestAppPermissions().catch(() => {
      // Nao interrompe a inicializacao se permissao falhar.
    });

    InteractionManager.runAfterInteractions(() => {
      runSmartNotificationsRefresh();
    });

    syncPlanStateFromServer().catch(() => {
      // Se o servidor nao responder agora, o plano local continua valendo.
    });

    ensureRealtimeSessionForActiveProfile().catch(() => {
      // Realtime nao pode bloquear inicializacao.
    });

    registerPlanPushToken().catch(() => {
      // Push e opcional. O app continua funcionando sem bloquear o boot.
    });

    const runMaintenance = async () => {
      try {
        const lastCleanupIso = await getDbValue<string>(DETAILS_CACHE_CLEANUP_KEY);
        const lastCleanupTs = lastCleanupIso ? new Date(lastCleanupIso).getTime() : 0;

        if (Date.now() - lastCleanupTs < DETAILS_CACHE_CLEANUP_INTERVAL_MS) {
          return;
        }

        await cleanupOldContentDetailsCache();
        await setDbValue(DETAILS_CACHE_CLEANUP_KEY, new Date().toISOString());
      } catch {
        // Manutencao falhou. Continua o fluxo principal.
      }
    };

    runMaintenance();

    const onStateChange = async (state: AppStateStatus) => {
      if (state !== 'active') {
        const elapsedMs = Date.now() - activeSinceRef.current;
        if (elapsedMs > 15_000) {
          void recordSessionEvent('app', elapsedMs);
        }
      }

      if (state === 'active') {
        activeSinceRef.current = Date.now();
        syncPlanStateFromServer().catch(() => {
          // Revalida plano silenciosamente ao voltar para o app.
        });

        registerPlanPushToken().catch(() => {
          // Reenvia token se necessario ao voltar ao app.
        });

        if (Date.now() - lastNotificationRefreshRef.current > 15 * 60 * 1000) {
          InteractionManager.runAfterInteractions(() => {
            runSmartNotificationsRefresh();
          });
        }

        ensureRealtimeSessionForActiveProfile().catch(() => {
          // Realtime nao pode bloquear retorno ao app.
        });
      }
    };

    const subscription = AppState.addEventListener('change', onStateChange);
    return () => {
      subscription.remove();
    };
  }, [nonMobileDevice]);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <PlaybackProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            animation: 'fade_from_bottom',
            contentStyle: { backgroundColor: 'transparent' },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="cadastrar" options={{ headerShown: false }} />
          <Stack.Screen name="xtream-login" options={{ headerShown: false }} />
          <Stack.Screen name="selecionar-servidor" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="loading" options={{ headerShown: false }} />
          <Stack.Screen name="perfil-acesso" options={{ headerShown: false }} />
          <Stack.Screen name="perfil-criar" options={{ headerShown: false }} />
          <Stack.Screen name="algoritmo-preferencias" options={{ headerShown: false, presentation: 'card' }} />
          <Stack.Screen name="ajuda" options={{ headerShown: false }} />
          <Stack.Screen name="categoria" options={{ headerShown: false }} />
          <Stack.Screen name="filmes" options={{ headerShown: false }} />
          <Stack.Screen name="series" options={{ headerShown: false }} />
          <Stack.Screen name="ao-vivo" options={{ headerShown: false }} />
          <Stack.Screen name="downloads" options={{ headerShown: false }} />
          <Stack.Screen name="conta" options={{ headerShown: false }} />
          <Stack.Screen name="configuracoes" options={{ headerShown: false }} />
          <Stack.Screen name="configuracoes-conta" options={{ headerShown: false }} />
          <Stack.Screen name="configuracoes-backup" options={{ headerShown: false }} />
          <Stack.Screen name="configuracoes-servidores" options={{ headerShown: false }} />
          <Stack.Screen name="configuracoes-perfis" options={{ headerShown: false }} />
          <Stack.Screen name="configuracoes-ia" options={{ headerShown: false }} />
          <Stack.Screen name="configuracoes-parental" options={{ headerShown: false }} />
          <Stack.Screen name="configuracoes-parental-filtros" options={{ headerShown: false }} />
          <Stack.Screen name="categorias" options={{ headerShown: false }} />
          <Stack.Screen name="serie-detalhe" options={{ headerShown: false }} />
          <Stack.Screen name="filme-detalhe" options={{ headerShown: false }} />
          <Stack.Screen name="minhas-listas" options={{ headerShown: false }} />
          <Stack.Screen name="minha-lista-detalhe" options={{ headerShown: false }} />
          <Stack.Screen name="destaques" options={{ headerShown: false }} />
          <Stack.Screen name="continuar-assistindo" options={{ headerShown: false }} />
          <Stack.Screen name="player" options={{ headerShown: false }} />
          <Stack.Screen name="monitor-parental" options={{ headerShown: false }} />
           <Stack.Screen name="assinar" options={{ headerShown: false }} />
           <Stack.Screen name="tv/home" options={{ headerShown: false }} />
           <Stack.Screen name="tv/lista" options={{ headerShown: false }} />
           <Stack.Screen name="tv/detalhe" options={{ headerShown: false }} />
           <Stack.Screen name="tv/player" options={{ headerShown: false }} />
        </Stack>
        <MiniPlayerHost />
      </PlaybackProvider>
      <StatusBar style="light" />
    </ThemeProvider>
  );
}
