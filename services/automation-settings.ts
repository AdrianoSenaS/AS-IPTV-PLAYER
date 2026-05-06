import { getDbValue, setDbValue } from '@/services/local-db';

export type BackupSyncInterval = '15m' | '30m' | '1h' | '3h' | '6h' | '12h' | '24h';
export type SmartNotificationInterval = '6h' | '12h' | '24h';

export type AutomationSettings = {
  backupSyncInterval: BackupSyncInterval;
  smartNotificationsEnabled: boolean;
  smartNotificationInterval: SmartNotificationInterval;
};

const AUTOMATION_SETTINGS_KEY = 'automation.settings.v1';

const DEFAULT_SETTINGS: AutomationSettings = {
  backupSyncInterval: '3h',
  smartNotificationsEnabled: true,
  smartNotificationInterval: '12h',
};

const BACKUP_INTERVAL_MS: Record<BackupSyncInterval, number> = {
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '3h': 3 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

const NOTIFICATION_INTERVAL_SECONDS: Record<SmartNotificationInterval, number> = {
  '6h': 6 * 60 * 60,
  '12h': 12 * 60 * 60,
  '24h': 24 * 60 * 60,
};

const VALID_BACKUP_INTERVALS: BackupSyncInterval[] = ['15m', '30m', '1h', '3h', '6h', '12h', '24h'];
const VALID_NOTIFICATION_INTERVALS: SmartNotificationInterval[] = ['6h', '12h', '24h'];

export const BACKUP_INTERVAL_LABELS: Record<BackupSyncInterval, string> = {
  '15m': 'A cada 15 minutos',
  '30m': 'A cada 30 minutos',
  '1h': 'A cada 1 hora',
  '3h': 'A cada 3 horas',
  '6h': 'A cada 6 horas',
  '12h': 'A cada 12 horas',
  '24h': 'A cada 24 horas',
};

export const SMART_NOTIFICATION_INTERVAL_LABELS: Record<SmartNotificationInterval, string> = {
  '6h': 'A cada 6 horas',
  '12h': 'A cada 12 horas',
  '24h': 'A cada 24 horas',
};

function normalizeSettings(raw: Partial<AutomationSettings> | null | undefined): AutomationSettings {
  const backupSyncInterval =
    raw?.backupSyncInterval && VALID_BACKUP_INTERVALS.includes(raw.backupSyncInterval)
      ? raw.backupSyncInterval
      : DEFAULT_SETTINGS.backupSyncInterval;
  const smartNotificationInterval =
    raw?.smartNotificationInterval && VALID_NOTIFICATION_INTERVALS.includes(raw.smartNotificationInterval)
      ? raw.smartNotificationInterval
      : DEFAULT_SETTINGS.smartNotificationInterval;

  return {
    backupSyncInterval,
    smartNotificationsEnabled: raw?.smartNotificationsEnabled !== false,
    smartNotificationInterval,
  };
}

export async function loadAutomationSettings(): Promise<AutomationSettings> {
  const parsed = await getDbValue<Partial<AutomationSettings>>(AUTOMATION_SETTINGS_KEY);
  return normalizeSettings(parsed);
}

export async function saveAutomationSettings(input: Partial<AutomationSettings>): Promise<AutomationSettings> {
  const current = await loadAutomationSettings();
  const next = normalizeSettings({ ...current, ...input });
  await setDbValue(AUTOMATION_SETTINGS_KEY, next);
  return next;
}

export function getBackupIntervalMs(interval: BackupSyncInterval): number {
  return BACKUP_INTERVAL_MS[interval] || BACKUP_INTERVAL_MS[DEFAULT_SETTINGS.backupSyncInterval];
}

export function getSmartNotificationIntervalSeconds(interval: SmartNotificationInterval): number {
  return (
    NOTIFICATION_INTERVAL_SECONDS[interval] ||
    NOTIFICATION_INTERVAL_SECONDS[DEFAULT_SETTINGS.smartNotificationInterval]
  );
}
