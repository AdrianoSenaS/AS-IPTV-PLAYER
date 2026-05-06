import { getDbValue, removeDbValue, setDbValue } from '@/services/local-db';
import { scheduleAutoCloudBackup } from '@/services/backup-background';
import { canAddProfile, canAddServer, getActivePlan } from '@/services/subscription';

import { disableDemoMode } from './demo-mode';

const ACCOUNT_SETTINGS_KEY = 'accountSettings.v1';
let settingsCache: AccountSettingsState | null = null;

export type XtreamServer = {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
  createdAt: string;
  updatedAt: string;
};

export type Profile = {
  id: string;
  name: string;
  avatarUri?: string;
  enabled: boolean;
  pinEnabled: boolean;
  pin: string;
  kidsMode: boolean;
  isPrimary?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ParentalManagerPermission = {
  profileId: string;
  enabled: boolean;
  managedProfileIds: string[];
};

export type ParentalSettings = {
  enabled: boolean;
  masterPin: string;
  requirePinForSettings: boolean;
  requirePinForAdultContent: boolean;
  lockedKeywords: string[];
  blockedCategoryIds: string[];
  blockedCategoryNames: string[];
  blockedContentTitles: string[];
};

export type ServerConnectionSettings = {
  allowHttps: boolean;
};

export type AccountSettingsState = {
  servers: XtreamServer[];
  activeServerId: string;
  profiles: Profile[];
  activeProfileId: string;
  parentalManagers: ParentalManagerPermission[];
  parental: ParentalSettings;
  serverConnection: ServerConnectionSettings;
};

export type ParentalMonitorAccess = {
  activeProfile: Profile | null;
  isPrimaryManager: boolean;
  canAccess: boolean;
  allowedProfileIds: string[];
  deniedReason: string;
};

export type ServerInput = {
  name: string;
  url: string;
  username: string;
  password: string;
};

export type ProfileInput = {
  name: string;
  avatarUri?: string;
  enabled?: boolean;
  pinEnabled?: boolean;
  pin?: string;
  kidsMode?: boolean;
  isPrimary?: boolean;
};

const nowIso = () => new Date().toISOString();

const stripUrlTrailingSlash = (value: string) => value.trim().replace(/\/+$/, '');

const normalizeXtreamUrlValue = (value: string, allowHttps: boolean) => {
  const trimmed = stripUrlTrailingSlash(value);
  if (!trimmed) return '';

  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const forcedHttp = !allowHttps ? withProtocol.replace(/^https:\/\//i, 'http://') : withProtocol;
  return stripUrlTrailingSlash(forcedHttp);
};

export const formatXtreamUrlInput = (value: string, allowHttps: boolean) =>
  normalizeXtreamUrlValue(value, allowHttps);

const makeId = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

const defaultServerConnection: ServerConnectionSettings = {
  allowHttps: false,
};

const defaultParental: ParentalSettings = {
  enabled: false,
  masterPin: '0000',
  requirePinForSettings: true,
  requirePinForAdultContent: true,
  lockedKeywords: ['adult', '18+', 'xxx', 'porn', 'erotico'],
  blockedCategoryIds: [],
  blockedCategoryNames: [],
  blockedContentTitles: [],
};

const createDefaultState = (): AccountSettingsState => ({
  servers: [],
  activeServerId: '',
  profiles: [
    {
      id: makeId('profile'),
      name: 'Principal',
      avatarUri: '',
      enabled: true,
      pinEnabled: false,
      pin: '',
      kidsMode: false,
      isPrimary: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
  ],
  activeProfileId: '',
  parentalManagers: [],
  parental: defaultParental,
  serverConnection: defaultServerConnection,
});

const ensureValidState = (state: Partial<AccountSettingsState>): AccountSettingsState => {
  const safe = createDefaultState();

  const servers = Array.isArray(state.servers)
    ? state.servers.filter((item) => item && item.id && item.url && item.username)
    : [];

  const rawProfilesFiltered = Array.isArray(state.profiles)
    ? state.profiles.filter((item) => item && item.id && item.name).map((item) => ({
        ...item,
        avatarUri: typeof item.avatarUri === 'string' ? item.avatarUri : '',
        enabled: item.enabled !== false,
        isPrimary: item.isPrimary === true,
      }))
    : [];

  // Deduplica por ID (mantém primeiro encontrado) para evitar perfis duplos após
  // restore de backup ou corridas de escrita no estado inicial.
  const seenIds = new Set<string>();
  const dedupedProfiles = rawProfilesFiltered.filter((item) => {
    if (seenIds.has(item.id)) return false;
    seenIds.add(item.id);
    return true;
  });

  // Garante que sempre exista pelo menos 1 perfil para o app funcionar.
  const rawProfiles = dedupedProfiles.length > 0 ? dedupedProfiles : safe.profiles;

  // Multiplos perfis podem ser principais.
  // Se nenhum tiver isPrimary:true, eleva o primeiro (ou o chamado 'principal') como fallback.
  const hasAnyPrimary = rawProfiles.some((item) => item.isPrimary === true);
  const fallbackPrimaryId = hasAnyPrimary
    ? null
    : rawProfiles.find((item) => String(item.name || '').trim().toLowerCase() === 'principal')?.id ||
      rawProfiles[0]?.id ||
      safe.profiles[0]?.id;

  const profiles = rawProfiles.map((item) => ({
    ...item,
    isPrimary: hasAnyPrimary ? item.isPrimary === true : item.id === fallbackPrimaryId,
  }));

  const activeServerId =
    typeof state.activeServerId === 'string' && servers.some((item) => item.id === state.activeServerId)
      ? state.activeServerId
      : servers[0]?.id || '';

  const enabledProfiles = profiles.filter((item) => item.enabled !== false);
  const canKeepActiveProfile =
    typeof state.activeProfileId === 'string' &&
    profiles.some((item) => item.id === state.activeProfileId && item.enabled !== false);

  const activeProfileId = canKeepActiveProfile
    ? String(state.activeProfileId)
    : enabledProfiles[0]?.id || profiles[0]?.id || '';

  const validProfileIds = new Set(profiles.map((item) => item.id));
  const manageableProfileIds = new Set(profiles.filter((item) => item.kidsMode).map((item) => item.id));
  const invalidManagerIds = new Set(
    profiles.filter((item) => item.kidsMode || item.isPrimary === true).map((item) => item.id)
  );

  const parentalManagers = Array.isArray((state as any).parentalManagers)
    ? (state as any).parentalManagers
        .map((entry: any) => ({
          profileId: String(entry?.profileId || '').trim(),
          enabled: entry?.enabled === true,
          managedProfileIds: Array.isArray(entry?.managedProfileIds)
            ? entry.managedProfileIds.map((item: any) => String(item || '').trim())
            : [],
        }))
        .filter((entry: ParentalManagerPermission) => validProfileIds.has(entry.profileId) && !invalidManagerIds.has(entry.profileId))
        .map((entry: ParentalManagerPermission) => ({
          ...entry,
          managedProfileIds: Array.from(
            new Set(entry.managedProfileIds.filter((id) => manageableProfileIds.has(id)))
          ),
        }))
    : [];

  return {
    servers,
    profiles,
    activeServerId,
    activeProfileId,
    parentalManagers,
    parental: {
      enabled: !!state.parental?.enabled,
      masterPin: typeof state.parental?.masterPin === 'string' ? state.parental.masterPin : defaultParental.masterPin,
      requirePinForSettings:
        typeof state.parental?.requirePinForSettings === 'boolean'
          ? state.parental.requirePinForSettings
          : defaultParental.requirePinForSettings,
      requirePinForAdultContent:
        typeof state.parental?.requirePinForAdultContent === 'boolean'
          ? state.parental.requirePinForAdultContent
          : defaultParental.requirePinForAdultContent,
      lockedKeywords: Array.isArray(state.parental?.lockedKeywords)
        ? state.parental.lockedKeywords.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
        : defaultParental.lockedKeywords,
      blockedCategoryIds: Array.isArray(state.parental?.blockedCategoryIds)
        ? state.parental.blockedCategoryIds.map((item) => String(item).trim()).filter(Boolean)
        : defaultParental.blockedCategoryIds,
      blockedCategoryNames: Array.isArray(state.parental?.blockedCategoryNames)
        ? state.parental.blockedCategoryNames.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
        : defaultParental.blockedCategoryNames,
      blockedContentTitles: Array.isArray(state.parental?.blockedContentTitles)
        ? state.parental.blockedContentTitles.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
        : defaultParental.blockedContentTitles,
    },
    serverConnection: {
      allowHttps:
        typeof state.serverConnection?.allowHttps === 'boolean'
          ? state.serverConnection.allowHttps
          : defaultServerConnection.allowHttps,
    },
  };
};

const syncLegacyCredentials = async (server?: XtreamServer) => {
  if (!server) {
    await Promise.all([
      removeDbValue('name'),
      removeDbValue('url'),
      removeDbValue('username'),
      removeDbValue('password'),
    ]);
    return;
  }

  await Promise.all([
    setDbValue('name', server.name),
    setDbValue('url', server.url),
    setDbValue('username', server.username),
    setDbValue('password', server.password),
  ]);
};

async function migrateLegacyIfNeeded(baseState: AccountSettingsState): Promise<AccountSettingsState> {
  if (baseState.servers.length > 0) {
    const active = baseState.servers.find((server) => server.id === baseState.activeServerId) || baseState.servers[0];
    await syncLegacyCredentials(active);
    return baseState;
  }

  const [name, url, username, password] = await Promise.all([
    getDbValue<string>('name'),
    getDbValue<string>('url'),
    getDbValue<string>('username'),
    getDbValue<string>('password'),
  ]);

  if (!url || !username || !password) {
    return baseState;
  }

  const migratedServer: XtreamServer = {
    id: makeId('server'),
    name: (name || 'Servidor principal').trim() || 'Servidor principal',
    url: normalizeXtreamUrlValue(url, baseState.serverConnection.allowHttps),
    username: username.trim(),
    password: password.trim(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  const migratedState: AccountSettingsState = {
    ...baseState,
    servers: [migratedServer],
    activeServerId: migratedServer.id,
    activeProfileId: baseState.activeProfileId || baseState.profiles[0]?.id || '',
  };

  await saveAccountSettings(migratedState);
  await syncLegacyCredentials(migratedServer);
  return migratedState;
}

function triggerImmediateCloudSyncInBackground() {
  import('@/services/cloud-sync')
    .then(({ triggerImmediateSync }) => triggerImmediateSync())
    .catch(() => null);
}

export async function loadAccountSettings(): Promise<AccountSettingsState> {
  if (settingsCache) {
    return settingsCache;
  }

  const raw = await getDbValue<AccountSettingsState>(ACCOUNT_SETTINGS_KEY);
  const safe = ensureValidState(raw || createDefaultState());
  const migrated = await migrateLegacyIfNeeded(safe);
  settingsCache = migrated;
  return migrated;
}

export function invalidateAccountSettingsCache() {
  settingsCache = null;
}

export async function saveAccountSettings(next: AccountSettingsState): Promise<void> {
  const safe = ensureValidState(next);
  await setDbValue(ACCOUNT_SETTINGS_KEY, safe);
  settingsCache = safe;
  scheduleAutoCloudBackup();
}

export async function upsertServer(input: ServerInput, targetId?: string): Promise<AccountSettingsState> {
  const state = await loadAccountSettings();
  const payload: ServerInput = {
    name: input.name.trim() || 'Servidor',
    url: normalizeXtreamUrlValue(input.url, state.serverConnection.allowHttps),
    username: input.username.trim(),
    password: input.password.trim(),
  };

  if (!payload.url || !payload.username || !payload.password) {
    throw new Error('Preencha URL, usuario e senha do servidor.');
  }

  const now = nowIso();
  let servers = [...state.servers];
  let activeServerId = state.activeServerId;

  if (targetId) {
    const index = servers.findIndex((item) => item.id === targetId);
    if (index < 0) {
      throw new Error('Servidor nao encontrado.');
    }

    servers[index] = {
      ...servers[index],
      ...payload,
      updatedAt: now,
    };
    activeServerId = servers[index].id;
  } else {
    const canAdd = await canAddServer(servers.length);
    if (!canAdd) {
      const plan = await getActivePlan();
      const limit = plan.maxServers;
      const limitLabel = limit === -1 ? 'ilimitado' : String(limit);
      throw new Error(`Seu plano (${plan.name}) permite ate ${limitLabel} servidor(es).`);
    }

    const newServer: XtreamServer = {
      id: makeId('server'),
      ...payload,
      createdAt: now,
      updatedAt: now,
    };
    servers = [newServer, ...servers];
    activeServerId = newServer.id;
  }

  const nextState: AccountSettingsState = {
    ...state,
    servers,
    activeServerId,
  };

  await saveAccountSettings(nextState);
  triggerImmediateCloudSyncInBackground();
  await disableDemoMode();
  const active = nextState.servers.find((item) => item.id === activeServerId);
  await syncLegacyCredentials(active);
  return nextState;
}

export async function setActiveServer(serverId: string): Promise<AccountSettingsState> {
  const state = await loadAccountSettings();
  const active = state.servers.find((item) => item.id === serverId);
  if (!active) {
    throw new Error('Servidor nao encontrado.');
  }

  const nextState: AccountSettingsState = {
    ...state,
    activeServerId: serverId,
  };

  await saveAccountSettings(nextState);
  await disableDemoMode();
  await syncLegacyCredentials(active);
  return nextState;
}

export async function removeServer(serverId: string): Promise<AccountSettingsState> {
  const state = await loadAccountSettings();
  const servers = state.servers.filter((item) => item.id !== serverId);
  const activeServerId = servers.some((item) => item.id === state.activeServerId)
    ? state.activeServerId
    : servers[0]?.id || '';

  const nextState: AccountSettingsState = {
    ...state,
    servers,
    activeServerId,
  };

  await saveAccountSettings(nextState);
  triggerImmediateCloudSyncInBackground();
  const active = nextState.servers.find((item) => item.id === nextState.activeServerId);
  await syncLegacyCredentials(active);
  return nextState;
}

export async function upsertProfile(input: ProfileInput, targetId?: string): Promise<AccountSettingsState> {
  const state = await loadAccountSettings();
  const now = nowIso();
  const payload: ProfileInput = {
    name: (input.name || '').trim() || 'Perfil',
    avatarUri: (input.avatarUri || '').trim(),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : undefined,
    pinEnabled: !!input.pinEnabled,
    pin: (input.pin || '').trim(),
    kidsMode: !!input.kidsMode,
  };

  if (payload.pinEnabled && (!payload.pin || payload.pin.length < 4)) {
    throw new Error('PIN do perfil deve ter pelo menos 4 digitos.');
  }

  let profiles = [...state.profiles];
  let activeProfileId = state.activeProfileId;

  if (targetId) {
    const index = profiles.findIndex((item) => item.id === targetId);
    if (index < 0) {
      throw new Error('Perfil nao encontrado.');
    }

    profiles[index] = {
      ...profiles[index],
      name: payload.name,
      avatarUri: payload.avatarUri || '',
      enabled: typeof payload.enabled === 'boolean' ? payload.enabled : profiles[index].enabled !== false,
      pinEnabled: !!payload.pinEnabled,
      pin: payload.pinEnabled ? payload.pin || '' : '',
      kidsMode: !!payload.kidsMode,
      // Somente perfis principals podem alterar o flag isPrimary de outros.
      // upsertProfile recebe o valor calculado pelo chamador; preserva o existente se nao fornecido.
      isPrimary: typeof input.isPrimary === 'boolean' ? input.isPrimary : profiles[index].isPrimary === true,
      updatedAt: now,
    };
    activeProfileId = profiles[index].id;
  } else {
    const canAdd = await canAddProfile(profiles.length);
    if (!canAdd) {
      const plan = await getActivePlan();
      const limit = plan.maxProfiles;
      const limitLabel = limit === -1 ? 'ilimitado' : String(limit);
      throw new Error(`Seu plano (${plan.name}) permite ate ${limitLabel} perfil(is).`);
    }

    const nextProfile: Profile = {
      id: makeId('profile'),
      name: payload.name,
      avatarUri: payload.avatarUri || '',
      enabled: payload.enabled !== false,
      pinEnabled: !!payload.pinEnabled,
      pin: payload.pinEnabled ? payload.pin || '' : '',
      kidsMode: !!payload.kidsMode,
      isPrimary: input.isPrimary === true,
      createdAt: now,
      updatedAt: now,
    };
    profiles = [nextProfile, ...profiles];
    activeProfileId = nextProfile.id;
  }

  const enabledProfiles = profiles.filter((item) => item.enabled !== false);
  if (!enabledProfiles.length) {
    throw new Error('Mantenha pelo menos um perfil ativo.');
  }

  if (!profiles.some((item) => item.id === activeProfileId && item.enabled !== false)) {
    activeProfileId = enabledProfiles[0].id;
  }

  const nextState: AccountSettingsState = {
    ...state,
    profiles,
    activeProfileId,
  };

  await saveAccountSettings(nextState);
  triggerImmediateCloudSyncInBackground();
  return nextState;
}

export async function setActiveProfile(profileId: string): Promise<AccountSettingsState> {
  const state = await loadAccountSettings();
  const profile = state.profiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new Error('Perfil nao encontrado.');
  }

  if (profile.enabled === false) {
    throw new Error('Este perfil esta desativado.');
  }

  const nextState: AccountSettingsState = {
    ...state,
    activeProfileId: profileId,
  };

  await saveAccountSettings(nextState);
  triggerImmediateCloudSyncInBackground();
  return nextState;
}

export async function removeProfile(profileId: string): Promise<AccountSettingsState> {
  const state = await loadAccountSettings();
  const target = state.profiles.find((item) => item.id === profileId);
  // Bloqueia remocao se for o ULTIMO perfil principal; com mais de um, pode remover.
  if (target?.isPrimary) {
    const primaryCount = state.profiles.filter((item) => item.isPrimary).length;
    if (primaryCount <= 1) {
      throw new Error('Deve existir ao menos um perfil principal. Promova outro perfil antes de remover este.');
    }
  }

  const profiles = state.profiles.filter((item) => item.id !== profileId);
  if (!profiles.length) {
    throw new Error('Mantenha pelo menos um perfil.');
  }

  if (!profiles.some((item) => item.enabled !== false)) {
    throw new Error('Mantenha pelo menos um perfil ativo.');
  }

  const activeProfileId = profiles.some((item) => item.id === state.activeProfileId)
    ? state.activeProfileId
    : profiles.find((item) => item.enabled !== false)?.id || profiles[0].id;

  const nextState: AccountSettingsState = {
    ...state,
    profiles,
    activeProfileId,
    parentalManagers: state.parentalManagers
      .filter((entry) => entry.profileId !== profileId)
      .map((entry) => ({
        ...entry,
        managedProfileIds: entry.managedProfileIds.filter((id) => id !== profileId),
      })),
  };

  await saveAccountSettings(nextState);
  triggerImmediateCloudSyncInBackground();
  return nextState;
}

export async function updateParentalSettings(input: Partial<ParentalSettings>): Promise<AccountSettingsState> {
  const state = await loadAccountSettings();
  const nextParental: ParentalSettings = {
    ...state.parental,
    ...input,
    masterPin: typeof input.masterPin === 'string' ? input.masterPin : state.parental.masterPin,
    lockedKeywords: Array.isArray(input.lockedKeywords)
      ? input.lockedKeywords.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
      : state.parental.lockedKeywords,
    blockedCategoryIds: Array.isArray(input.blockedCategoryIds)
      ? input.blockedCategoryIds.map((item) => String(item).trim()).filter(Boolean)
      : state.parental.blockedCategoryIds,
    blockedCategoryNames: Array.isArray(input.blockedCategoryNames)
      ? input.blockedCategoryNames.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
      : state.parental.blockedCategoryNames,
    blockedContentTitles: Array.isArray(input.blockedContentTitles)
      ? input.blockedContentTitles.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
      : state.parental.blockedContentTitles,
  };

  if ((nextParental.enabled || nextParental.requirePinForSettings || nextParental.requirePinForAdultContent) && nextParental.masterPin.length < 4) {
    throw new Error('PIN mestre deve ter pelo menos 4 digitos.');
  }

  const nextState: AccountSettingsState = {
    ...state,
    parental: nextParental,
  };

  await saveAccountSettings(nextState);
  return nextState;
}

export async function syncServerFromLogin(input: {
  displayName: string;
  url: string;
  username: string;
  password: string;
}): Promise<AccountSettingsState> {
  const state = await loadAccountSettings();
  const normalizedUrl = normalizeXtreamUrlValue(input.url, state.serverConnection.allowHttps);
  const existing = state.servers.find(
    (item) => item.url === normalizedUrl && item.username === input.username.trim()
  );

  if (existing) {
    return upsertServer(
      {
        name: input.displayName,
        url: normalizedUrl,
        username: input.username,
        password: input.password,
      },
      existing.id
    );
  }

  return upsertServer({
    name: input.displayName,
    url: normalizedUrl,
    username: input.username,
    password: input.password,
  });
}

export async function updateServerConnectionSettings(
  input: Partial<ServerConnectionSettings>
): Promise<AccountSettingsState> {
  const state = await loadAccountSettings();
  const nextAllowHttps =
    typeof input.allowHttps === 'boolean' ? input.allowHttps : state.serverConnection.allowHttps;
  const nextState: AccountSettingsState = {
    ...state,
    servers: state.servers.map((server) => ({
      ...server,
      url: normalizeXtreamUrlValue(server.url, nextAllowHttps),
    })),
    serverConnection: {
      ...state.serverConnection,
      ...input,
      allowHttps: nextAllowHttps,
    },
  };

  await saveAccountSettings(nextState);
  const active = nextState.servers.find((item) => item.id === nextState.activeServerId);
  await syncLegacyCredentials(active);
  return nextState;
}

export async function normalizeXtreamServerUrl(url: string): Promise<string> {
  const state = await loadAccountSettings();
  return normalizeXtreamUrlValue(url, state.serverConnection.allowHttps);
}

export async function setParentalManagerPermission(input: {
  profileId: string;
  enabled: boolean;
  managedProfileIds: string[];
}): Promise<AccountSettingsState> {
  const state = await loadAccountSettings();
  const profileId = String(input.profileId || '').trim();
  const manager = state.profiles.find((item) => item.id === profileId);

  if (!manager) {
    throw new Error('Perfil gerente nao encontrado.');
  }

  if (manager.isPrimary) {
    throw new Error('O perfil principal ja possui acesso total.');
  }

  if (manager.kidsMode) {
    throw new Error('Perfis infantis nao podem gerenciar controle parental.');
  }

  const allowedTargets = new Set(
    state.profiles.filter((item) => item.kidsMode).map((item) => item.id)
  );

  const nextEntry: ParentalManagerPermission = {
    profileId,
    enabled: input.enabled === true,
    managedProfileIds: Array.from(
      new Set(
        (Array.isArray(input.managedProfileIds) ? input.managedProfileIds : [])
          .map((item) => String(item || '').trim())
          .filter((id) => allowedTargets.has(id))
      )
    ),
  };

  const index = state.parentalManagers.findIndex((entry) => entry.profileId === profileId);
  const parentalManagers = [...state.parentalManagers];
  if (index >= 0) {
    parentalManagers[index] = nextEntry;
  } else {
    parentalManagers.push(nextEntry);
  }

  const nextState: AccountSettingsState = {
    ...state,
    parentalManagers,
  };

  await saveAccountSettings(nextState);
  return nextState;
}

export function getParentalMonitorAccess(state: AccountSettingsState): ParentalMonitorAccess {
  const activeProfile = state.profiles.find((item) => item.id === state.activeProfileId) || null;
  if (!activeProfile) {
    return {
      activeProfile: null,
      isPrimaryManager: false,
      canAccess: false,
      allowedProfileIds: [],
      deniedReason: 'Perfil ativo nao encontrado.',
    };
  }

  if (activeProfile.kidsMode) {
    return {
      activeProfile,
      isPrimaryManager: false,
      canAccess: false,
      allowedProfileIds: [],
      deniedReason: 'Perfis infantis nao podem acessar o controle parental.',
    };
  }

  if (activeProfile.isPrimary) {
    return {
      activeProfile,
      isPrimaryManager: true,
      canAccess: true,
      allowedProfileIds: state.profiles.map((item) => item.id),
      deniedReason: '',
    };
  }

  const manager = state.parentalManagers.find((entry) => entry.profileId === activeProfile.id);
  if (!manager || !manager.enabled) {
    return {
      activeProfile,
      isPrimaryManager: false,
      canAccess: false,
      allowedProfileIds: [],
      deniedReason: 'Somente o perfil principal ou perfis autorizados podem acessar este painel.',
    };
  }

  const validTargets = new Set(state.profiles.filter((item) => item.kidsMode).map((item) => item.id));
  const allowedProfileIds = Array.from(
    new Set((manager.managedProfileIds || []).filter((id) => validTargets.has(id)))
  );

  if (!allowedProfileIds.length) {
    return {
      activeProfile,
      isPrimaryManager: false,
      canAccess: false,
      allowedProfileIds: [],
      deniedReason: 'Seu perfil ainda nao recebeu perfis para gerenciamento parental.',
    };
  }

  return {
    activeProfile,
    isPrimaryManager: false,
    canAccess: true,
    allowedProfileIds,
    deniedReason: '',
  };
}

export const verifyProfilePin = (profile: Profile, pin: string) => {
  if (!profile.pinEnabled) return true;
  return profile.pin === pin.trim();
};

export const verifyMasterPin = (state: AccountSettingsState, pin: string) => state.parental.masterPin === pin.trim();

const isActiveKidsProfile = (state: AccountSettingsState) =>
  !!state.profiles.find((item) => item.id === state.activeProfileId)?.kidsMode;

export const isContentRestricted = (
  state: AccountSettingsState,
  text: string,
  options?: {
    title?: string;
    categoryId?: string;
    categoryName?: string;
  }
) => {
  if (!isActiveKidsProfile(state)) return false;
  if (!state.parental.enabled || !state.parental.requirePinForAdultContent) return false;

  const normalized = text.toLowerCase();
  const normalizedTitle = String(options?.title || '').toLowerCase();
  const normalizedCategoryName = String(options?.categoryName || '').toLowerCase();
  const categoryId = String(options?.categoryId || '').trim();

  if (categoryId && state.parental.blockedCategoryIds.includes(categoryId)) {
    return true;
  }

  if (normalizedCategoryName && state.parental.blockedCategoryNames.some((name) => normalizedCategoryName.includes(name))) {
    return true;
  }

  if (state.parental.blockedContentTitles.some((title) => normalizedTitle.includes(title) || normalized.includes(title))) {
    return true;
  }

  return state.parental.lockedKeywords.some((keyword) => normalized.includes(keyword));
};
