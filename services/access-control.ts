import { getDbValue, removeDbValue, setDbValue } from '@/services/local-db';

import {
  AccountSettingsState,
  isContentRestricted,
  loadAccountSettings,
  setActiveProfile,
  verifyMasterPin,
  verifyProfilePin,
} from '@/services/account-settings';

const SESSION_PROFILE_UNLOCKED_KEY = 'session.profile.unlocked';
const SESSION_AUTH_PROFILE_ID_KEY = 'session.profile.authProfileId';
const SESSION_PARENTAL_UNLOCKED_KEY = 'session.parental.unlocked';
const REMEMBERED_PROFILE_ID_KEY = 'session.profile.remembered.v1';
const TRUSTED_PROFILE_IDS_KEY = 'session.profile.trusted.v1';

export type AccessSnapshot = {
  settings: AccountSettingsState;
  profileUnlocked: boolean;
  parentalUnlocked: boolean;
  requiresParentalUnlock: boolean;
};

export async function resetAccessSessionForLaunch() {
  let settings = await loadAccountSettings();
  const rememberedProfileId = await getRememberedProfileId();
  const trustedIds = (await loadTrustedProfileIds()).filter((profileId) =>
    settings.profiles.some((item) => item.id === profileId)
  );
  const rememberedProfile = settings.profiles.find((item) => item.id === rememberedProfileId && item.enabled !== false);
  const enabledProfiles = settings.profiles.filter((item) => item.enabled !== false);
  const shouldRequireSelection = enabledProfiles.length > 1;
  let profileUnlocked = shouldRequireSelection ? '0' : '1';
  let authProfileId = shouldRequireSelection ? '' : String(settings.activeProfileId || enabledProfiles[0]?.id || settings.profiles[0]?.id || '');

  if (rememberedProfile) {
    if (settings.activeProfileId !== rememberedProfile.id) {
      settings = await setActiveProfile(rememberedProfile.id);
    }

    if (!rememberedProfile.pinEnabled || trustedIds.includes(rememberedProfile.id)) {
      profileUnlocked = '1';
      authProfileId = rememberedProfile.id;
    }
  }

  await Promise.all([
    setDbValue(SESSION_PROFILE_UNLOCKED_KEY, profileUnlocked),
    setDbValue(SESSION_AUTH_PROFILE_ID_KEY, authProfileId),
    setDbValue(SESSION_PARENTAL_UNLOCKED_KEY, '0'),
    setDbValue(TRUSTED_PROFILE_IDS_KEY, trustedIds),
    rememberedProfile ? Promise.resolve() : removeDbValue(REMEMBERED_PROFILE_ID_KEY),
  ]);
}

export async function shouldRequireProfileSelection() {
  const settings = await loadAccountSettings();
  return settings.profiles.filter((item) => item.enabled !== false).length > 1;
}

export async function lockProfileAccessIfMultipleProfiles() {
  const settings = await loadAccountSettings();
  const enabledProfiles = settings.profiles.filter((item) => item.enabled !== false);
  if (enabledProfiles.length <= 1) {
    const activeProfileId = String(settings.activeProfileId || enabledProfiles[0]?.id || settings.profiles[0]?.id || '');
    await Promise.all([
      setDbValue(SESSION_PROFILE_UNLOCKED_KEY, '1'),
      setDbValue(SESSION_AUTH_PROFILE_ID_KEY, activeProfileId),
      setDbValue(SESSION_PARENTAL_UNLOCKED_KEY, '0'),
    ]);
    return;
  }

  const activeProfile = settings.profiles.find((item) => item.id === settings.activeProfileId);
  const [rememberedProfileId, trustedIds] = await Promise.all([
    getRememberedProfileId(),
    loadTrustedProfileIds(),
  ]);

  const keepUnlocked =
    !!activeProfile &&
    rememberedProfileId === activeProfile.id &&
    (!activeProfile.pinEnabled || trustedIds.includes(activeProfile.id));

  if (keepUnlocked) {
    await Promise.all([
      setDbValue(SESSION_PROFILE_UNLOCKED_KEY, '1'),
      setDbValue(SESSION_AUTH_PROFILE_ID_KEY, activeProfile.id),
      setDbValue(SESSION_PARENTAL_UNLOCKED_KEY, '0'),
    ]);
    return;
  }

  await Promise.all([
    setDbValue(SESSION_PROFILE_UNLOCKED_KEY, '0'),
    setDbValue(SESSION_AUTH_PROFILE_ID_KEY, ''),
    setDbValue(SESSION_PARENTAL_UNLOCKED_KEY, '0'),
  ]);
}

export async function markProfileUnlocked(profileId?: string) {
  await Promise.all([
    setDbValue(SESSION_PROFILE_UNLOCKED_KEY, '1'),
    setDbValue(SESSION_AUTH_PROFILE_ID_KEY, String(profileId || '').trim()),
  ]);
}

export async function markParentalUnlocked() {
  await setDbValue(SESSION_PARENTAL_UNLOCKED_KEY, '1');
}

export async function isProfileUnlocked() {
  const [flag, authProfileId, settings] = await Promise.all([
    getDbValue<string>(SESSION_PROFILE_UNLOCKED_KEY),
    getDbValue<string>(SESSION_AUTH_PROFILE_ID_KEY),
    loadAccountSettings(),
  ]);

  if (flag !== '1') {
    return false;
  }

  const activeProfileId = String(settings.activeProfileId || settings.profiles[0]?.id || '').trim();
  const authenticatedProfileId = String(authProfileId || '').trim();

  if (!activeProfileId) {
    return false;
  }

  return authenticatedProfileId === activeProfileId;
}

export async function getAuthenticatedProfileId() {
  return String((await getDbValue<string>(SESSION_AUTH_PROFILE_ID_KEY)) || '').trim();
}

export async function isParentalUnlocked() {
  return (await getDbValue<string>(SESSION_PARENTAL_UNLOCKED_KEY)) === '1';
}

async function loadTrustedProfileIds() {
  const raw = await getDbValue<string[]>(TRUSTED_PROFILE_IDS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item || '').trim()).filter(Boolean);
}

export async function isProfileTrusted(profileId: string) {
  const trustedIds = await loadTrustedProfileIds();
  return trustedIds.includes(profileId);
}

export async function getRememberedProfileId() {
  const remembered = await getDbValue<string>(REMEMBERED_PROFILE_ID_KEY);
  return String(remembered || '').trim();
}

export async function saveProfileAccessPreferences(input: {
  profileId: string;
  rememberProfile: boolean;
  trustPin: boolean;
}) {
  const profileId = String(input.profileId || '').trim();
  if (!profileId) return;

  const trustedIds = await loadTrustedProfileIds();
  const nextTrustedIds = input.trustPin
    ? Array.from(new Set([...trustedIds, profileId]))
    : trustedIds.filter((item) => item !== profileId);

  await Promise.all([
    setDbValue(TRUSTED_PROFILE_IDS_KEY, nextTrustedIds),
    input.rememberProfile
      ? setDbValue(REMEMBERED_PROFILE_ID_KEY, profileId)
      : removeDbValue(REMEMBERED_PROFILE_ID_KEY),
  ]);
}

export async function unlockProfileAccess(profileId: string, pin: string) {
  const currentState = await loadAccountSettings();
  const targetProfile = currentState.profiles.find((item) => item.id === profileId);
  if (!targetProfile) {
    return { ok: false, message: 'Perfil nao encontrado.' };
  }

  if (targetProfile.enabled === false) {
    return { ok: false, message: 'Este perfil esta desativado.' };
  }

  const state = await setActiveProfile(profileId);
  const profile = state.profiles.find((item) => item.id === profileId);
  const trustedIds = await loadTrustedProfileIds();

  if (!profile) {
    return { ok: false, message: 'Perfil nao encontrado.' };
  }

  const skipPin = profile.pinEnabled && trustedIds.includes(profile.id);

  if (!skipPin && !verifyProfilePin(profile, pin)) {
    return { ok: false, message: 'PIN do perfil incorreto.' };
  }

  await markProfileUnlocked(profile.id);
  await setDbValue(SESSION_PARENTAL_UNLOCKED_KEY, '0');
  return { ok: true, state };
}

export async function unlockParentalAccess(pin: string) {
  const state = await loadAccountSettings();
  if (!verifyMasterPin(state, pin)) {
    return false;
  }

  await markParentalUnlocked();
  return true;
}

export async function loadAccessSnapshot(): Promise<AccessSnapshot> {
  const [settings, profileUnlocked, parentalUnlocked] = await Promise.all([
    loadAccountSettings(),
    isProfileUnlocked(),
    isParentalUnlocked(),
  ]);

  const activeProfile = settings.profiles.find((item) => item.id === settings.activeProfileId);
  const isKidsProfile = !!activeProfile?.kidsMode;

  const requiresParentalUnlock =
    isKidsProfile &&
    settings.parental.enabled &&
    settings.parental.requirePinForAdultContent &&
    !parentalUnlocked;

  return {
    settings,
    profileUnlocked,
    parentalUnlocked,
    requiresParentalUnlock,
  };
}

export function isRestrictedByParental(snapshot: AccessSnapshot, contentText: string) {
  if (!snapshot.requiresParentalUnlock) {
    return false;
  }

  return isContentRestricted(snapshot.settings, contentText);
}

export function shouldHideContentImages(snapshot: AccessSnapshot) {
  return false;
}

// Palavras-chave de conteudo adulto que sao sempre bloqueadas para perfis infantis,
// independente de o controle parental estar ativado ou nao.
const KIDS_BLOCK_KEYWORDS = ['adult', '18+', 'xxx', 'porn', 'erotico', 'erotic', 'hentai', 'sexo', 'sex'];

function isBlockedForKids(text: string, title: string, categoryName: string): boolean {
  const check = (source: string) =>
    KIDS_BLOCK_KEYWORDS.some((kw) => source.includes(kw));
  return check(text) || check(title) || check(categoryName);
}

export function filterBlockedContent<T>(
  snapshot: AccessSnapshot,
  items: T[],
  getText: (item: T) => string
): T[] {
  const activeProfile = snapshot.settings.profiles.find(
    (p) => p.id === snapshot.settings.activeProfileId
  );
  const isKidsProfile = !!activeProfile?.kidsMode;

  if (!isKidsProfile && !snapshot.requiresParentalUnlock) {
    return items;
  }

  return items.filter((item) => {
    const anyItem = item as any;
    const title = String(anyItem?.title || anyItem?.name || '').toLowerCase();
    const categoryId = String(anyItem?.category_id || anyItem?.categoryId || '');
    const categoryName = String(anyItem?.category_name || anyItem?.categoryName || '').toLowerCase();
    const text = getText(item).toLowerCase();

    // Perfis infantis: bloqueia conteudo adulto independente das configuracoes parentais.
    if (isKidsProfile && isBlockedForKids(text, title, categoryName)) {
      return false;
    }

    if (!snapshot.requiresParentalUnlock) {
      return true;
    }

    return !isContentRestricted(snapshot.settings, text, {
      title,
      categoryId,
      categoryName,
    });
  });
}

export function getCardAccessPinType(snapshot: AccessSnapshot): 'profile' | 'master' | null {
  const activeProfile = snapshot.settings.profiles.find((item) => item.id === snapshot.settings.activeProfileId);
  if (activeProfile?.pinEnabled) {
    return 'profile';
  }

  if (snapshot.settings.parental.enabled && snapshot.settings.parental.requirePinForSettings) {
    return 'master';
  }

  return null;
}

export function verifyCardAccessPin(snapshot: AccessSnapshot, pin: string): boolean {
  const pinType = getCardAccessPinType(snapshot);
  if (!pinType) return true;

  if (pinType === 'profile') {
    const activeProfile = snapshot.settings.profiles.find((item) => item.id === snapshot.settings.activeProfileId);
    if (!activeProfile) return false;
    return verifyProfilePin(activeProfile, pin);
  }

  return verifyMasterPin(snapshot.settings, pin);
}
