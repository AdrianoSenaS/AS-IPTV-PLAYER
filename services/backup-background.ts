import { getBackupIntervalMs, loadAutomationSettings } from '@/services/automation-settings';
import { isNonMobileDevice } from '@/services/device-profile';
import {
  CloudBackupProgress,
  loadCloudSyncPrefs,
  loadUserSession,
  restoreLastCloudBackup,
  runCloudBackupNow,
} from '@/services/cloud-sync';
import { getDbValue, setDbValue } from '@/services/local-db';

export type BackupJobState = {
  operation: 'backup' | 'restore' | 'idle';
  isRunning: boolean;
  progress: number;
  message: string;
  stage: CloudBackupProgress['stage'] | 'idle' | 'error';
  activeProfileName?: string;
  syncedAt?: string;
  backupFile?: string;
  sourceCreatedAt?: string;
  error?: string;
};

export type BackupHistoryEntry = {
  id: string;
  operation: 'backup' | 'restore';
  status: 'success' | 'error';
  finishedAt: string;
  message: string;
  progress: number;
  activeProfileName?: string;
  syncedAt?: string;
  backupFile?: string;
  sourceCreatedAt?: string;
};

const BACKUP_HISTORY_KEY = 'backup.history.v1';
const AUTO_SYNC_LAST_STARTED_AT_KEY = 'backup.autoSync.lastStartedAt.v1';
const MAX_BACKUP_HISTORY_ENTRIES = 8;
const AUTO_SYNC_DEBOUNCE_MS = 45_000;
let currentState: BackupJobState = {
  operation: 'idle',
  isRunning: false,
  progress: 0,
  message: '',
  stage: 'idle',
};
let runningPromise: Promise<BackupJobState> | null = null;
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
let autoSyncPending = false;
let lastAutoSyncStartedAt = 0;
const listeners = new Set<(state: BackupJobState) => void>();

async function loadHistoryInternal(): Promise<BackupHistoryEntry[]> {
  const raw = await getDbValue<BackupHistoryEntry[]>(BACKUP_HISTORY_KEY);
  return Array.isArray(raw) ? raw : [];
}

async function appendHistoryEntry(entry: BackupHistoryEntry) {
  const history = await loadHistoryInternal();
  const next = [entry, ...history].slice(0, MAX_BACKUP_HISTORY_ENTRIES);
  await setDbValue(BACKUP_HISTORY_KEY, next);
}

export async function getBackupHistory() {
  return loadHistoryInternal();
}

function emitState(next: BackupJobState) {
  currentState = next;
  listeners.forEach((listener) => {
    try {
      listener(next);
    } catch {
      // Listener isolado nao deve interromper o job.
    }
  });
}

export function getBackupJobState() {
  return currentState;
}

export function subscribeToBackupJob(listener: (state: BackupJobState) => void) {
  listeners.add(listener);
  listener(currentState);
  return () => listeners.delete(listener);
}

async function getActiveProfileName() {
  const state = await getDbValue<any>('accountSettings.v1');
  const profiles = Array.isArray(state?.profiles) ? state.profiles : [];
  const activeProfileId = String(state?.activeProfileId || '');
  const activeProfile = profiles.find((item: any) => String(item?.id || '') === activeProfileId);
  return String(activeProfile?.name || profiles[0]?.name || 'Principal');
}

async function canRunAutoSyncNow() {
  const [session, prefs] = await Promise.all([loadUserSession(), loadCloudSyncPrefs()]);
  return !!session && !!prefs.consentEnabled && !!prefs.autoSyncEnabled;
}

async function loadLastAutoSyncStartedAt() {
  try {
    const raw = await getDbValue<number | string>(AUTO_SYNC_LAST_STARTED_AT_KEY);
    const parsed = Number(raw || 0);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function markAutoSyncStarted(at: number) {
  lastAutoSyncStartedAt = at;
  void setDbValue(AUTO_SYNC_LAST_STARTED_AT_KEY, at).catch(() => null);
}

async function flushAutoSyncQueue() {
  if (autoSyncTimer) {
    clearTimeout(autoSyncTimer);
    autoSyncTimer = null;
  }

  if (runningPromise) {
    autoSyncPending = true;
    return;
  }

  if (!(await canRunAutoSyncNow())) {
    autoSyncPending = false;
    return;
  }

  const [automation, persistedLastStartedAt, prefs] = await Promise.all([
    loadAutomationSettings(),
    loadLastAutoSyncStartedAt(),
    loadCloudSyncPrefs(),
  ]);
  const autoSyncMinIntervalMs = getBackupIntervalMs(automation.backupSyncInterval);

  const prefsLastSyncAtTs = new Date(String(prefs?.lastSyncAt || '')).getTime();
  const safePrefsLastSyncAtTs = Number.isFinite(prefsLastSyncAtTs) ? prefsLastSyncAtTs : 0;

  const effectiveLastStartedAt = Math.max(
    lastAutoSyncStartedAt,
    persistedLastStartedAt,
    safePrefsLastSyncAtTs
  );
  lastAutoSyncStartedAt = effectiveLastStartedAt;

  const now = Date.now();
  const elapsed = now - effectiveLastStartedAt;
  if (elapsed < autoSyncMinIntervalMs) {
    autoSyncTimer = setTimeout(() => {
      void flushAutoSyncQueue();
    }, autoSyncMinIntervalMs - elapsed);
    return;
  }

  autoSyncPending = false;
  markAutoSyncStarted(now);
  startJobInBackground('backup')
    .catch(() => null)
    .finally(() => {
      if (!autoSyncPending || autoSyncTimer) return;
      autoSyncTimer = setTimeout(() => {
        void flushAutoSyncQueue();
      }, AUTO_SYNC_DEBOUNCE_MS);
    });
}

export function scheduleAutoCloudBackup() {
  if (isNonMobileDevice()) {
    return;
  }

  autoSyncPending = true;
  if (autoSyncTimer) {
    clearTimeout(autoSyncTimer);
  }

  autoSyncTimer = setTimeout(() => {
    void flushAutoSyncQueue();
  }, AUTO_SYNC_DEBOUNCE_MS);
}

function startJobInBackground(operation: 'backup' | 'restore') {
  if (runningPromise) {
    return runningPromise;
  }

  if (operation === 'backup') {
    markAutoSyncStarted(Date.now());
  }

  emitState({
    ...currentState,
    operation,
    isRunning: true,
    progress: 0,
    message:
      operation === 'backup'
        ? 'Iniciando backup em segundo plano'
        : 'Iniciando restauracao em segundo plano',
    stage: 'preparing',
  });

  void getActiveProfileName().then((activeProfileName) => {
    emitState({
      ...currentState,
      activeProfileName,
    });
  });

  const runner =
    operation === 'backup'
      ? (options: { onProgress?: (progress: CloudBackupProgress) => void }) =>
          runCloudBackupNow(options).then((result) => ({
            syncedAt: result.syncedAt,
            backupFile: result.backupFile,
            sourceCreatedAt: undefined as string | undefined,
          }))
      : (options: { onProgress?: (progress: CloudBackupProgress) => void }) =>
          restoreLastCloudBackup(options).then((result) => ({
            syncedAt: result.restoredAt,
            backupFile: undefined as string | undefined,
            sourceCreatedAt: result.sourceCreatedAt,
          }));

  runningPromise = runner({
    onProgress: (progress) => {
      emitState({
        ...currentState,
        operation,
        isRunning: progress.stage !== 'done',
        progress: progress.progress,
        message: progress.message,
        stage: progress.stage,
      });

    },
  })
    .then(async (result) => {
      const activeProfileName = await getActiveProfileName();
      const next: BackupJobState = {
        operation,
        isRunning: false,
        progress: 100,
        message:
          operation === 'backup'
            ? 'Backup concluido com sucesso'
            : 'Restauracao concluida com sucesso',
        stage: 'done',
        activeProfileName,
        syncedAt: result.syncedAt,
        backupFile: result.backupFile,
        sourceCreatedAt: result.sourceCreatedAt,
      };
      emitState(next);
      void appendHistoryEntry({
        id: `${operation}-${Date.now()}`,
        operation,
        status: 'success',
        finishedAt: new Date().toISOString(),
        message: next.message,
        progress: 100,
        activeProfileName: next.activeProfileName,
        syncedAt: next.syncedAt,
        backupFile: next.backupFile,
        sourceCreatedAt: next.sourceCreatedAt,
      });
      return next;
    })
    .catch(async (error: any) => {
      const activeProfileName = await getActiveProfileName();
      const next: BackupJobState = {
        operation,
        isRunning: false,
        progress: currentState.progress,
        message:
          operation === 'backup' ? 'Falha ao executar backup' : 'Falha ao restaurar backup',
        stage: 'error',
        activeProfileName,
        error: String(
          error?.message ||
            error ||
            (operation === 'backup'
              ? 'Nao foi possivel concluir o backup.'
              : 'Nao foi possivel concluir a restauracao.')
        ),
      };
      emitState(next);
      void appendHistoryEntry({
        id: `${operation}-${Date.now()}`,
        operation,
        status: 'error',
        finishedAt: new Date().toISOString(),
        message: next.error || next.message,
        progress: next.progress,
        activeProfileName: next.activeProfileName,
      });
      throw error;
    })
    .finally(() => {
      runningPromise = null;
    });

  return runningPromise;
}

export function startCloudBackupInBackground() {
  return startJobInBackground('backup');
}

export function startCloudRestoreInBackground() {
  return startJobInBackground('restore');
}