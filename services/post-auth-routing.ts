import { loadAccountSettings, setActiveServer } from '@/services/account-settings';
import { getDbValue, setDbValue } from '@/services/local-db';

const REMEMBER_ACTIVE_SERVER_KEY = 'serverSelection.rememberActiveServer.v1';

export type PostAuthTarget = '/xtream-login' | '/loading' | '/selecionar-servidor';

export async function shouldRememberActiveServerOnLogin(): Promise<boolean> {
  const value = await getDbValue<boolean>(REMEMBER_ACTIVE_SERVER_KEY);
  return !!value;
}

export async function setRememberActiveServerOnLogin(enabled: boolean): Promise<void> {
  await setDbValue(REMEMBER_ACTIVE_SERVER_KEY, !!enabled);
}

export async function resolvePostAuthTarget(): Promise<PostAuthTarget> {
  const settings = await loadAccountSettings();
  const serverCount = settings.servers.length;

  if (!serverCount) {
    return '/xtream-login';
  }

  if (serverCount === 1) {
    const only = settings.servers[0];
    await setActiveServer(only.id);
    return '/loading';
  }

  const active = settings.servers.find((item) => item.id === settings.activeServerId) || settings.servers[0];
  if (active) {
    await setActiveServer(active.id);
    return '/loading';
  }

  const rememberActiveServer = await shouldRememberActiveServerOnLogin();
  if (rememberActiveServer) {
    const remembered = settings.servers.find((item) => item.id === settings.activeServerId);
    if (remembered) {
      await setActiveServer(remembered.id);
      return '/loading';
    }
  }

  return '/selecionar-servidor';
}