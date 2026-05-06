import { Redirect } from 'expo-router';
import React, { useEffect, useState } from 'react';

import { PageLoader } from '@/components/page-loader';
import { loadAccountSettings } from '@/services/account-settings';
import { apiRequest } from '@/services/app-server';
import { hasLocalCatalogDataQuick } from '@/services/catalog-data';
import { clearUserSession, loadUserSession, restoreLastCloudBackup } from '@/services/cloud-sync';
import { getDbValue, removeDbValue, setDbValue } from '@/services/local-db';
import { resolvePostAuthTarget } from '@/services/post-auth-routing';
import { resetAccessSessionForLaunch, shouldRequireProfileSelection, isProfileUnlocked } from '@/services/access-control';
import { getHomeRouteForDevice, getProfileEntryForDevice } from '@/services/device-profile';

type StartupRoute = string;
const CLOUD_AUTO_RESTORE_LAST_AT_KEY = 'cloudSync.autoRestore.lastAt.v1';
const CLOUD_AUTO_RESTORE_INTERVAL_MS = 1000 * 60 * 60 * 6;
const ACCESS_BLOCK_MESSAGE_KEY = 'session.access.blocked.message.v1';

async function clearServerCredentials() {
  await Promise.all([
    removeDbValue('name'),
    removeDbValue('url'),
    removeDbValue('username'),
    removeDbValue('password'),
  ]);
}

async function blockAccessToLogin(message: string) {
  await Promise.all([
    setDbValue(ACCESS_BLOCK_MESSAGE_KEY, message),
    clearServerCredentials(),
    clearUserSession().catch(() => null),
  ]);
}

async function isActiveProfileAllowed() {
  const settings = await loadAccountSettings();
  const activeProfile = settings.profiles.find((item) => item.id === settings.activeProfileId) || settings.profiles[0] || null;
  return !!activeProfile && activeProfile.enabled !== false;
}

export default function IndexRoute() {
  const [target, setTarget] = useState<StartupRoute | null>(null);
  const homeRoute = getHomeRouteForDevice();
  const profileEntry = getProfileEntryForDevice();

  const scheduleCloudRestoreInBackground = async () => {
    try {
      const lastRestoreIso = await getDbValue<string>(CLOUD_AUTO_RESTORE_LAST_AT_KEY);
      const lastRestoreTs = lastRestoreIso ? new Date(lastRestoreIso).getTime() : 0;

      if (Date.now() - lastRestoreTs < CLOUD_AUTO_RESTORE_INTERVAL_MS) {
        return;
      }

      // Marca antes para evitar corridas em remount raro da rota inicial.
      await setDbValue(CLOUD_AUTO_RESTORE_LAST_AT_KEY, new Date().toISOString());
      await restoreLastCloudBackup().catch(() => null);
    } catch {
      // Nao interrompe o fluxo principal caso falhe.
    }
  };

  useEffect(() => {
    let mounted = true;

    const resolveTarget = async () => {
      try {
        const [username, password, url] = await Promise.all([
          getDbValue<string>('username'),
          getDbValue<string>('password'),
          getDbValue<string>('url'),
        ]);

        // Prioriza retomada do Xtream sem obrigar conta do app.
        if (username && password && url) {
          const profileAllowed = await isActiveProfileAllowed();
          if (!profileAllowed) {
            await blockAccessToLogin('Seu perfil esta desativado. Entre novamente para continuar.');
            if (mounted) {
              setTarget('/login');
            }
            return;
          }

          await resetAccessSessionForLaunch();
          const hasLocalCatalog = await hasLocalCatalogDataQuick();
          const requireSelection =
            (await shouldRequireProfileSelection()) && !(await isProfileUnlocked());

          if (mounted) {
            if (requireSelection) {
              setTarget(`/perfil-acesso?next=${hasLocalCatalog ? profileEntry : 'loading'}`);
            } else {
              setTarget(hasLocalCatalog ? homeRoute : '/loading');
            }
          }
          return;
        }

        const session = await loadUserSession();
        if (session?.token) {
          try {
            await apiRequest('/api/auth/me', { token: session.token, timeoutMs: 20000 });
          } catch (error: any) {
            const message = String(error?.message || '');
            if (/inativo/i.test(message)) {
              await blockAccessToLogin(message || 'Usuario inativo. Contate o administrador.');
              if (mounted) {
                setTarget('/login');
              }
              return;
            }
          }

          const profileAllowed = await isActiveProfileAllowed();
          if (!profileAllowed) {
            await blockAccessToLogin('Seu perfil esta desativado. Entre novamente para continuar.');
            if (mounted) {
              setTarget('/login');
            }
            return;
          }

          const [postAuthTarget, hasLocalCatalog] = await Promise.all([
            resolvePostAuthTarget(),
            hasLocalCatalogDataQuick(),
          ]);
          
          // Restaura backup antes de renderizar home para garantir progress/listas atualizados.
          await scheduleCloudRestoreInBackground();

          if (mounted) {
            if (postAuthTarget === '/loading') {
              await resetAccessSessionForLaunch();
              const requireSelection =
                (await shouldRequireProfileSelection()) && !(await isProfileUnlocked());

              if (requireSelection) {
                setTarget(`/perfil-acesso?next=${hasLocalCatalog ? profileEntry : 'loading'}`);
              } else {
                setTarget(hasLocalCatalog ? homeRoute : '/loading');
              }
            } else {
              setTarget(postAuthTarget);
            }
          }

          return;
        }

        if (mounted) {
          setTarget('/login');
        }
      } catch {
        if (mounted) {
          setTarget('/login');
        }
      }
    };

    resolveTarget();
    return () => {
      mounted = false;
    };
  }, [homeRoute, profileEntry]);

  if (!target) {
    return <PageLoader visible label="Restaurando sessao" />;
  }

  return <Redirect href={target} />;
}