import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef } from 'react';
import { AppState, AppStateStatus, PermissionsAndroid, Platform } from 'react-native';
import 'react-native-reanimated';

import { MiniPlayerHost } from '@/components/mini-player-host';
import { PlaybackProvider } from '@/components/playback-provider';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { hasLocalCatalogDataQuick } from '../services/catalog-data';
import { getDbValue, setDbValue } from '@/services/local-db';
import { cleanupOldContentDetailsCache } from '@/services/content-details-cache';
import { hasInternetConnection } from '@/services/network';
import { refreshSmartRecommendationNotifications } from '@/services/smart-notifications';
import { connectSocket } from '@/services/realtime-presence';
import { refreshPlanStateAtLaunch } from '@/services/subscription';

const DETAILS_CACHE_CLEANUP_KEY = 'maintenance.details_cache_cleanup.last_at.v1';
const DETAILS_CACHE_CLEANUP_INTERVAL_MS = 1000 * 60 * 60 * 24;
let hasCompletedStartupRouting = false;

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

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const lastNotificationRefreshRef = useRef(0);
  const lastConnectivityCheckRef = useRef(0);

  useEffect(() => {
    // Solicita permissoes e inicializa servicos apenas no boot.
    requestAppPermissions();
    refreshSmartRecommendationNotifications()
      .then(() => {
        lastNotificationRefreshRef.current = Date.now();
      })
      .catch(() => {
        // Continua a inicializacao mesmo se notificacao falhar.
      });

    let mounted = true;

    const enforceOfflineDownloads = async () => {
      // Evita chamadas de rede repetidas em curto intervalo.
      if (Date.now() - lastConnectivityCheckRef.current < 5_000) {
        return;
      }
      lastConnectivityCheckRef.current = Date.now();

      const online = await hasInternetConnection();
      if (!mounted) return;

      if (!online) {
        router.replace('/offline');
      }
    };

    const runLaunchChecks = async () => {
      if (hasCompletedStartupRouting) {
        return;
      }

      hasCompletedStartupRouting = true;

      try {
        await refreshPlanStateAtLaunch();

        const [username, hasLocalCatalog] = await Promise.all([
          getDbValue<string>('username'),
          hasLocalCatalogDataQuick(),
        ]);

        if (!username) {
          return;
        }

        // Evita abrir a tela de loading em todo boot.
        // Se já existe catálogo local, a atualização pode acontecer depois sem bloquear entrada.
        if (!hasLocalCatalog) {
          router.replace('/loading');
          return;
        }
      } catch {
        // Falhas de validacao local nao devem bloquear o app.
      }
    };

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

    enforceOfflineDownloads();
    runLaunchChecks();
    runMaintenance();

    const onStateChange = async (state: AppStateStatus) => {
      if (state === 'active') {
        await enforceOfflineDownloads();

        if (Date.now() - lastNotificationRefreshRef.current > 15 * 60 * 1000) {
          refreshSmartRecommendationNotifications()
            .then(() => {
              lastNotificationRefreshRef.current = Date.now();
            })
            .catch(() => {
              // Ignora falhas de notificacoes para nao interromper o fluxo principal.
            });
        }

        connectSocket().catch(() => {
          // Reconecta silenciosamente ao voltar ao app.
        });
      }
    };

    const subscription = AppState.addEventListener('change', onStateChange);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [router]);

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
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="loading" options={{ headerShown: false }} />
          <Stack.Screen name="perfil-acesso" options={{ headerShown: false }} />
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
        </Stack>
        <MiniPlayerHost />
      </PlaybackProvider>
      <StatusBar style="light" />
    </ThemeProvider>
  );
}
