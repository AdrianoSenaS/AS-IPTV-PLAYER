import { loadProfileScopedValue, saveProfileScopedValue } from '@/services/profile-scoped-storage';
import { isNonMobileDevice } from '@/services/device-profile';

export type AiLearningWindow = '1d' | '2d' | '7d';
export type AiLearningIntensity = 'leve' | 'normal' | 'agressivo';
export type AiDeviceProfile = 'economico' | 'balanceado' | 'potente';

export type AiRuntimeTuning = {
  profile: AiDeviceProfile;
  homeProfileSampleLimit: number;
  homeVodPoolLimit: number;
  homeSeriesPoolLimit: number;
  homeLivePoolLimit: number;
  homeBootVodLimit: number;
  homeBootSeriesLimit: number;
  homeBootLiveLimit: number;
  homeQueryTimeoutMs: number;
  homeEnrichTimeoutMs: number;
  homeFocusRefreshThrottleMs: number;
  enableTmdbEnrichment: boolean;
  enableRecommendationChips: boolean;
  recomputeOnHomeFocus: boolean;
};

export type AiSettings = {
  enabled: boolean;
  learningWindow: AiLearningWindow;
  learningIntensity: AiLearningIntensity;
  deviceProfile: AiDeviceProfile;
  tmdbEnrichmentEnabled: boolean;
  recommendationChipsEnabled: boolean;
  recomputeOnHomeFocus: boolean;
};

const AI_SETTINGS_KEY = 'ai.settings.v1';

const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: true,
  learningWindow: '2d',
  learningIntensity: 'normal',
  deviceProfile: 'balanceado',
  tmdbEnrichmentEnabled: true,
  recommendationChipsEnabled: true,
  recomputeOnHomeFocus: false,
};

const AI_RUNTIME_PRESETS: Record<
  AiDeviceProfile,
  Omit<AiRuntimeTuning, 'profile' | 'enableTmdbEnrichment' | 'enableRecommendationChips' | 'recomputeOnHomeFocus'>
> = {
  economico: {
    homeProfileSampleLimit: 80,
    homeVodPoolLimit: 120,
    homeSeriesPoolLimit: 120,
    homeLivePoolLimit: 70,
    homeBootVodLimit: 70,
    homeBootSeriesLimit: 70,
    homeBootLiveLimit: 45,
    homeQueryTimeoutMs: 6000,
    homeEnrichTimeoutMs: 1400,
    homeFocusRefreshThrottleMs: 120000,
  },
  balanceado: {
    homeProfileSampleLimit: 120,
    homeVodPoolLimit: 180,
    homeSeriesPoolLimit: 180,
    homeLivePoolLimit: 100,
    homeBootVodLimit: 120,
    homeBootSeriesLimit: 120,
    homeBootLiveLimit: 80,
    homeQueryTimeoutMs: 7000,
    homeEnrichTimeoutMs: 2200,
    homeFocusRefreshThrottleMs: 45000,
  },
  potente: {
    homeProfileSampleLimit: 240,
    homeVodPoolLimit: 320,
    homeSeriesPoolLimit: 320,
    homeLivePoolLimit: 180,
    homeBootVodLimit: 180,
    homeBootSeriesLimit: 180,
    homeBootLiveLimit: 120,
    homeQueryTimeoutMs: 9000,
    homeEnrichTimeoutMs: 3200,
    homeFocusRefreshThrottleMs: 20000,
  },
};

function normalizeSettings(raw: Partial<AiSettings> | null | undefined): AiSettings {
  const learningWindow = raw?.learningWindow;
  const learningIntensity = raw?.learningIntensity;
  const deviceProfile = raw?.deviceProfile;
  return {
    enabled: raw?.enabled !== false,
    learningWindow:
      learningWindow === '1d' || learningWindow === '2d' || learningWindow === '7d'
        ? learningWindow
        : DEFAULT_AI_SETTINGS.learningWindow,
    learningIntensity:
      learningIntensity === 'leve' || learningIntensity === 'normal' || learningIntensity === 'agressivo'
        ? learningIntensity
        : DEFAULT_AI_SETTINGS.learningIntensity,
    deviceProfile:
      deviceProfile === 'economico' || deviceProfile === 'balanceado' || deviceProfile === 'potente'
        ? deviceProfile
        : DEFAULT_AI_SETTINGS.deviceProfile,
    tmdbEnrichmentEnabled:
      typeof raw?.tmdbEnrichmentEnabled === 'boolean'
        ? raw.tmdbEnrichmentEnabled
        : DEFAULT_AI_SETTINGS.tmdbEnrichmentEnabled,
    recommendationChipsEnabled:
      typeof raw?.recommendationChipsEnabled === 'boolean'
        ? raw.recommendationChipsEnabled
        : DEFAULT_AI_SETTINGS.recommendationChipsEnabled,
    recomputeOnHomeFocus:
      typeof raw?.recomputeOnHomeFocus === 'boolean'
        ? raw.recomputeOnHomeFocus
        : DEFAULT_AI_SETTINGS.recomputeOnHomeFocus,
  };
}

function buildRuntimeTuning(settings: AiSettings): AiRuntimeTuning {
  const preset = AI_RUNTIME_PRESETS[settings.deviceProfile] || AI_RUNTIME_PRESETS.balanceado;
  return {
    profile: settings.deviceProfile,
    ...preset,
    enableTmdbEnrichment: settings.tmdbEnrichmentEnabled,
    enableRecommendationChips: settings.recommendationChipsEnabled,
    recomputeOnHomeFocus: settings.recomputeOnHomeFocus,
  };
}

export const DEFAULT_AI_RUNTIME_TUNING: AiRuntimeTuning = buildRuntimeTuning(DEFAULT_AI_SETTINGS);

export async function loadAiSettings(): Promise<AiSettings> {
  const raw = await loadProfileScopedValue<Partial<AiSettings> | null>(AI_SETTINGS_KEY, null);
  return normalizeSettings(raw);
}

export async function updateAiSettings(input: Partial<AiSettings>): Promise<AiSettings> {
  const current = await loadAiSettings();
  const next = normalizeSettings({
    ...current,
    ...input,
  });
  await saveProfileScopedValue(AI_SETTINGS_KEY, next);
  return next;
}

export async function isAiEnabled(): Promise<boolean> {
  if (isNonMobileDevice()) {
    return false;
  }
  const settings = await loadAiSettings();
  return settings.enabled;
}

export async function loadAiRuntimeTuning(input?: AiSettings): Promise<AiRuntimeTuning> {
  const settings = input || (await loadAiSettings());
  const runtime = buildRuntimeTuning(settings);

  if (isNonMobileDevice()) {
    return {
      ...runtime,
      enableTmdbEnrichment: false,
      enableRecommendationChips: false,
      recomputeOnHomeFocus: false,
    };
  }

  return runtime;
}

export async function getAiLearningWindowMs(): Promise<number> {
  const settings = await loadAiSettings();
  if (settings.learningWindow === '1d') return 1000 * 60 * 60 * 24;
  if (settings.learningWindow === '7d') return 1000 * 60 * 60 * 24 * 7;
  return 1000 * 60 * 60 * 24 * 2;
}

export async function getAiSignalLimit(): Promise<number> {
  const settings = await loadAiSettings();
  if (settings.learningIntensity === 'leve') return 560;
  if (settings.learningIntensity === 'agressivo') return 1400;
  return 900;
}

export async function getAiSignalStoreLimit(): Promise<number> {
  const settings = await loadAiSettings();
  if (settings.learningIntensity === 'leve') return 900;
  if (settings.learningIntensity === 'agressivo') return 2200;
  return 1400;
}
