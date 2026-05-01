import { getDbValue, removeDbValue, setDbValue } from '@/services/local-db';

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
  pinEnabled: boolean;
  pin: string;
  kidsMode: boolean;
  createdAt: string;
  updatedAt: string;
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

export type AccountSettingsState = {
  servers: XtreamServer[];
  activeServerId: string;
  profiles: Profile[];
  activeProfileId: string;
  parental: ParentalSettings;
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
  pinEnabled?: boolean;
  pin?: string;
  kidsMode?: boolean;
};

const nowIso = () => new Date().toISOString();

const normalizeUrl = (value: string) => value.trim().replace(/\/+$/, '');

const makeId = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

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
      pinEnabled: false,
      pin: '',
      kidsMode: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
  ],
  activeProfileId: '',
  parental: defaultParental,
});

const ensureValidState = (state: Partial<AccountSettingsState>): AccountSettingsState => {
  const safe = createDefaultState();

  const servers = Array.isArray(state.servers)
    ? state.servers.filter((item) => item && item.id && item.url && item.username)
    : [];

  const profiles = Array.isArray(state.profiles)
    ? state.profiles.filter((item) => item && item.id && item.name).map((item) => ({
        ...item,
        avatarUri: typeof item.avatarUri === 'string' ? item.avatarUri : '',
      }))
    : safe.profiles;

  const activeServerId =
    typeof state.activeServerId === 'string' && servers.some((item) => item.id === state.activeServerId)
      ? state.activeServerId
      : servers[0]?.id || '';

  const activeProfileId =
    typeof state.activeProfileId === 'string' && profiles.some((item) => item.id === state.activeProfileId)
      ? state.activeProfileId
      : profiles[0]?.id || '';

  return {
    servers,
    profiles,
    activeServerId,
    activeProfileId,
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
    url: normalizeUrl(url),
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

export async function saveAccountSettings(next: AccountSettingsState): Promise<void> {
  const safe = ensureValidState(next);
  await setDbValue(ACCOUNT_SETTINGS_KEY, safe);
  settingsCache = safe;
}

export async function upsertServer(input: ServerInput, targetId?: string): Promise<AccountSettingsState> {
  const state = await loadAccountSettings();
  const payload: ServerInput = {
    name: input.name.trim() || 'Servidor',
    url: normalizeUrl(input.url),
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
      pinEnabled: !!payload.pinEnabled,
      pin: payload.pinEnabled ? payload.pin || '' : '',
      kidsMode: !!payload.kidsMode,
      updatedAt: now,
    };
    activeProfileId = profiles[index].id;
  } else {
    const nextProfile: Profile = {
      id: makeId('profile'),
      name: payload.name,
      avatarUri: payload.avatarUri || '',
      pinEnabled: !!payload.pinEnabled,
      pin: payload.pinEnabled ? payload.pin || '' : '',
      kidsMode: !!payload.kidsMode,
      createdAt: now,
      updatedAt: now,
    };
    profiles = [nextProfile, ...profiles];
    activeProfileId = nextProfile.id;
  }

  const nextState: AccountSettingsState = {
    ...state,
    profiles,
    activeProfileId,
  };

  await saveAccountSettings(nextState);
  return nextState;
}

export async function setActiveProfile(profileId: string): Promise<AccountSettingsState> {
  const state = await loadAccountSettings();
  if (!state.profiles.some((item) => item.id === profileId)) {
    throw new Error('Perfil nao encontrado.');
  }

  const nextState: AccountSettingsState = {
    ...state,
    activeProfileId: profileId,
  };

  await saveAccountSettings(nextState);
  return nextState;
}

export async function removeProfile(profileId: string): Promise<AccountSettingsState> {
  const state = await loadAccountSettings();
  const profiles = state.profiles.filter((item) => item.id !== profileId);
  if (!profiles.length) {
    throw new Error('Mantenha pelo menos um perfil.');
  }

  const activeProfileId = profiles.some((item) => item.id === state.activeProfileId)
    ? state.activeProfileId
    : profiles[0].id;

  const nextState: AccountSettingsState = {
    ...state,
    profiles,
    activeProfileId,
  };

  await saveAccountSettings(nextState);
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
  const normalizedUrl = normalizeUrl(input.url);
  const state = await loadAccountSettings();
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

export const verifyProfilePin = (profile: Profile, pin: string) => {
  if (!profile.pinEnabled) return true;
  return profile.pin === pin.trim();
};

export const verifyMasterPin = (state: AccountSettingsState, pin: string) => state.parental.masterPin === pin.trim();

export const isContentRestricted = (
  state: AccountSettingsState,
  text: string,
  options?: {
    title?: string;
    categoryId?: string;
    categoryName?: string;
  }
) => {
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
