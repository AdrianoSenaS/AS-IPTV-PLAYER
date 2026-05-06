import { Dimensions, Platform } from 'react-native';

export type DeviceUiProfile = 'phone' | 'tablet' | 'tv';

const TABLET_SMALLEST_DP = 700;
const TV_SMALLEST_DP = 960;

function getSmallestDp() {
  const { width, height } = Dimensions.get('window');
  return Math.min(width, height);
}

export function getDeviceUiProfile(): DeviceUiProfile {
  if (Platform.isTV) {
    return 'tv';
  }

  const smallestDp = getSmallestDp();
  if (smallestDp >= TV_SMALLEST_DP) {
    return 'tv';
  }

  if (smallestDp >= TABLET_SMALLEST_DP) {
    return 'tablet';
  }

  return 'phone';
}

export function isNonMobileDevice() {
  return getDeviceUiProfile() !== 'phone';
}

export function getHomeRouteForDevice() {
  return isNonMobileDevice() ? '/tv/home' : '/(tabs)';
}

export function getProfileEntryForDevice() {
  return isNonMobileDevice() ? 'tv-home' : 'home';
}
