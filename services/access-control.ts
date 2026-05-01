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
const SESSION_PARENTAL_UNLOCKED_KEY = 'session.parental.unlocked';

export type AccessSnapshot = {
  settings: AccountSettingsState;
  profileUnlocked: boolean;
  parentalUnlocked: boolean;
  requiresParentalUnlock: boolean;
};

export async function resetAccessSessionForLaunch() {
  const settings = await loadAccountSettings();
  const shouldRequireSelection = settings.profiles.length > 1;

  await Promise.all([
    setDbValue(SESSION_PROFILE_UNLOCKED_KEY, shouldRequireSelection ? '0' : '1'),
    setDbValue(SESSION_PARENTAL_UNLOCKED_KEY, '0'),
  ]);
}

export async function shouldRequireProfileSelection() {
  const settings = await loadAccountSettings();
  return settings.profiles.length > 1;
}

export async function lockProfileAccessIfMultipleProfiles() {
  if (!(await shouldRequireProfileSelection())) {
    return;
  }

  await Promise.all([
    setDbValue(SESSION_PROFILE_UNLOCKED_KEY, '0'),
    setDbValue(SESSION_PARENTAL_UNLOCKED_KEY, '0'),
  ]);
}

export async function markProfileUnlocked() {
  await setDbValue(SESSION_PROFILE_UNLOCKED_KEY, '1');
}

export async function markParentalUnlocked() {
  await setDbValue(SESSION_PARENTAL_UNLOCKED_KEY, '1');
}

export async function isProfileUnlocked() {
  return (await getDbValue<string>(SESSION_PROFILE_UNLOCKED_KEY)) === '1';
}

export async function isParentalUnlocked() {
  return (await getDbValue<string>(SESSION_PARENTAL_UNLOCKED_KEY)) === '1';
}

export async function unlockProfileAccess(profileId: string, pin: string) {
  const state = await setActiveProfile(profileId);
  const profile = state.profiles.find((item) => item.id === profileId);

  if (!profile) {
    return { ok: false, message: 'Perfil nao encontrado.' };
  }

  if (!verifyProfilePin(profile, pin)) {
    return { ok: false, message: 'PIN do perfil incorreto.' };
  }

  await markProfileUnlocked();
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

  const requiresParentalUnlock = settings.parental.enabled && settings.parental.requirePinForAdultContent && !parentalUnlocked;

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

export function filterBlockedContent<T>(
  snapshot: AccessSnapshot,
  items: T[],
  getText: (item: T) => string
): T[] {
  if (!snapshot.requiresParentalUnlock) {
    return items;
  }

  return items.filter((item) => {
    const anyItem = item as any;
    const title = String(anyItem?.title || anyItem?.name || '');
    const categoryId = String(anyItem?.category_id || anyItem?.categoryId || '');
    const categoryName = String(anyItem?.category_name || anyItem?.categoryName || '');
    const text = getText(item);

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
