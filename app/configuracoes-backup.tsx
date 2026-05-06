import { MaterialIcons } from '@expo/vector-icons';

import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import {
  Alert,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PageLoader } from '@/components/page-loader';
import { AppBackdrop } from '@/components/app-backdrop';
import {
  BACKUP_INTERVAL_LABELS,
  BackupSyncInterval,
  loadAutomationSettings,
  saveAutomationSettings,
  SMART_NOTIFICATION_INTERVAL_LABELS,
  SmartNotificationInterval,
} from '@/services/automation-settings';
import { StreamingTheme } from '@/constants/streaming-theme';
import { loadAccountSettings } from '@/services/account-settings';
import {
  BackupHistoryEntry,
  BackupJobState,
  getBackupHistory,
  scheduleAutoCloudBackup,
  startCloudBackupInBackground,
  startCloudRestoreInBackground,
  subscribeToBackupJob,
} from '@/services/backup-background';
import { getCatalogLastUpdate } from '@/services/catalog-data';
import {
  loadCloudSyncPrefs,
  loadUserSession,
  saveCloudSyncPrefs,
} from '@/services/cloud-sync';
import {
  CatalogRefreshPeriod,
  getNextCatalogRefreshAt,
  loadCatalogRefreshPeriod,
  REFRESH_PERIOD_LABELS,
  saveCatalogRefreshPeriod,
} from '@/services/update-schedule';
import { refreshSmartRecommendationNotifications } from '@/services/smart-notifications';

export default function ConfiguracoesBackupScreen() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const [consentEnabled, setConsentEnabled] = useState(false);
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false);
  const [refreshPeriod, setRefreshPeriod] = useState<CatalogRefreshPeriod>('2d');
  const [backupSyncInterval, setBackupSyncInterval] = useState<BackupSyncInterval>('3h');
  const [smartNotificationsEnabled, setSmartNotificationsEnabled] = useState(true);
  const [smartNotificationInterval, setSmartNotificationInterval] = useState<SmartNotificationInterval>('12h');
  const [lastCatalogSyncAt, setLastCatalogSyncAt] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState('');
  const [sessionEmail, setSessionEmail] = useState('');
  const [activeProfileName, setActiveProfileName] = useState('Principal');
  const [backupJob, setBackupJob] = useState<BackupJobState>({
    operation: 'idle',
    isRunning: false,
    progress: 0,
    message: '',
    stage: 'idle',
  });
  const [history, setHistory] = useState<BackupHistoryEntry[]>([]);
  const hydratedOnceRef = useRef(false);

  const hydrate = useCallback(async () => {
    if (!hydratedOnceRef.current) {
      setIsLoading(true);
    }
    try {
      const [prefs, session, selectedPeriod, localCatalogLastUpdate, historyEntries, settings, automation] = await Promise.all([
        loadCloudSyncPrefs(),
        loadUserSession(),
        loadCatalogRefreshPeriod(),
        getCatalogLastUpdate(),
        getBackupHistory(),
        loadAccountSettings(),
        loadAutomationSettings(),
      ]);
      const activeProfile = settings.profiles.find((item) => item.id === settings.activeProfileId);
      setConsentEnabled(prefs.consentEnabled);
      setAutoSyncEnabled(prefs.autoSyncEnabled);
      setLastSyncAt(prefs.lastSyncAt);
      setRefreshPeriod(selectedPeriod);
      setBackupSyncInterval(automation.backupSyncInterval);
      setSmartNotificationsEnabled(automation.smartNotificationsEnabled);
      setSmartNotificationInterval(automation.smartNotificationInterval);
      setLastCatalogSyncAt(localCatalogLastUpdate);
      setSessionEmail(session?.user.email || 'Sem login');
      setActiveProfileName(activeProfile?.name || 'Principal');
      setHistory(historyEntries);
    } finally {
      hydratedOnceRef.current = true;
      setIsLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      hydrate();
    }, [hydrate])
  );

  React.useEffect(() => {
    return subscribeToBackupJob((state) => {
      setBackupJob(state);
      if (state.syncedAt) {
        setLastSyncAt(state.syncedAt);
      }
      if (!state.isRunning && state.stage !== 'idle') {
        void getBackupHistory().then(setHistory).catch(() => null);
      }
    });
  }, []);

  const autoClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if (backupJob.stage === 'done') {
      autoClearTimerRef.current = setTimeout(() => {
        setBackupJob((prev) =>
          prev.stage === 'done' ? { ...prev, stage: 'idle', isRunning: false } : prev
        );
      }, 4000);
    }
    return () => {
      if (autoClearTimerRef.current) clearTimeout(autoClearTimerRef.current);
    };
  }, [backupJob.stage]);

  const actionButtonsDisabled = backupJob.isRunning || isSaving;

  const runAction = async (action: () => Promise<void>) => {
    try {
      setIsSaving(true);
      await action();
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Não foi possível executar a operação.'));
    } finally {
      setIsSaving(false);
    }
  };

  const onToggleConsent = async (value: boolean) => {
    setConsentEnabled(value);
    await runAction(async () => {
      const next = await saveCloudSyncPrefs({ consentEnabled: value });
      setConsentEnabled(next.consentEnabled);
    });
  };

  const onToggleAutoSync = async (value: boolean) => {
    setAutoSyncEnabled(value);
    await runAction(async () => {
      const next = await saveCloudSyncPrefs({ autoSyncEnabled: value });
      setAutoSyncEnabled(next.autoSyncEnabled);
    });
  };

  const onBackupNow = async () => {
    if (backupJob.isRunning) {
      Alert.alert('Processo em andamento', 'Já existe uma sincronização rodando em segundo plano.');
      return;
    }

    startCloudBackupInBackground()
      .then(async (result) => {
        setLastSyncAt(result.syncedAt || '');
        setLastCatalogSyncAt(await getCatalogLastUpdate());
      })
      .catch((error: any) => {
        Alert.alert('Erro', String(error?.message || error || 'Não foi possível concluir o backup.'));
      });

    Alert.alert(
      'Backup iniciado',
          'O backup está rodando em segundo plano. Você pode continuar usando o app enquanto acompanha o progresso pelas notificações.'
    );
  };

  const onRestore = async () => {
    Alert.alert('Restaurar backup', 'Esta acao substitui dados locais atuais. Deseja continuar?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Restaurar',
        style: 'destructive',
        onPress: async () => {
          if (backupJob.isRunning) {
            Alert.alert('Processo em andamento', 'Já existe uma sincronização rodando em segundo plano.');
            return;
          }

          startCloudRestoreInBackground()
            .then(async (result) => {
              setLastSyncAt(result.syncedAt || '');
              setLastCatalogSyncAt(await getCatalogLastUpdate());
            })
            .catch((error: any) => {
              Alert.alert('Erro', String(error?.message || error || 'Não foi possível concluir a restauração.'));
            });

          Alert.alert(
            'Restauração iniciada',
            'A restauração está rodando em segundo plano. Acompanhe o andamento pelas notificações.'
          );
        },
      },
    ]);
  };

  const onSyncNow = async () => {
    await onBackupNow();
  };

  const onChangeRefreshPeriod = async (nextPeriod: CatalogRefreshPeriod) => {
    setRefreshPeriod(nextPeriod);
    await runAction(async () => {
      const saved = await saveCatalogRefreshPeriod(nextPeriod);
      setRefreshPeriod(saved);
    });
  };

  const onChangeBackupInterval = async (nextInterval: BackupSyncInterval) => {
    setBackupSyncInterval(nextInterval);
    await runAction(async () => {
      const saved = await saveAutomationSettings({ backupSyncInterval: nextInterval });
      setBackupSyncInterval(saved.backupSyncInterval);
      scheduleAutoCloudBackup();
    });
  };

  const onToggleSmartNotifications = async (value: boolean) => {
    setSmartNotificationsEnabled(value);
    await runAction(async () => {
      const saved = await saveAutomationSettings({ smartNotificationsEnabled: value });
      setSmartNotificationsEnabled(saved.smartNotificationsEnabled);
      await refreshSmartRecommendationNotifications();
    });
  };

  const onChangeSmartNotificationInterval = async (nextInterval: SmartNotificationInterval) => {
    setSmartNotificationInterval(nextInterval);
    await runAction(async () => {
      const saved = await saveAutomationSettings({ smartNotificationInterval: nextInterval });
      setSmartNotificationInterval(saved.smartNotificationInterval);
      await refreshSmartRecommendationNotifications();
    });
  };

  const nextRefreshAt = getNextCatalogRefreshAt(lastCatalogSyncAt, refreshPeriod);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isLoading || isSaving} label={isLoading ? 'Carregando backup' : 'Sincronizando'} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.kicker}>NUVEM LOCAL</Text>
            <Text style={styles.title}>Backup e sincronização</Text>
          </View>
          <View style={styles.iconBtn} />
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Conta conectada</Text>
          <Text style={styles.infoText}>{sessionEmail}</Text>
          <Text style={styles.infoText}>Perfil ativo agora: {activeProfileName}</Text>
          <Text style={styles.infoText}>
            Última sincronização: {lastSyncAt ? new Date(lastSyncAt).toLocaleString('pt-BR') : 'Nunca'}
          </Text>
          {backupJob.stage !== 'idle' ? (
            <View style={styles.progressCard}>
              <View style={styles.progressHeader}>
                <Text style={styles.progressTitle}>
                  {backupJob.operation === 'restore' ? 'Restauração em segundo plano' : 'Backup em segundo plano'}
                </Text>
                <Text style={styles.progressPercent}>{backupJob.progress}%</Text>
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.max(6, Math.min(100, backupJob.progress))}%` }]} />
              </View>
              <Text style={styles.progressInfoText}>{backupJob.message}</Text>
              {backupJob.activeProfileName ? (
                <Text style={styles.caption}>Perfil afetado: {backupJob.activeProfileName}</Text>
              ) : null}
              {!backupJob.isRunning && backupJob.operation === 'restore' && backupJob.sourceCreatedAt ? (
                <Text style={styles.caption}>
                  Origem restaurada: {new Date(backupJob.sourceCreatedAt).toLocaleString('pt-BR')}
                </Text>
              ) : null}
              {!backupJob.isRunning && backupJob.stage === 'error' && backupJob.error ? (
                <Text style={styles.progressErrorText}>{backupJob.error}</Text>
              ) : null}
            </View>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Permissoes de sincronizacao</Text>
          <ToggleRow
            label="Permitir sincronizacao em nuvem local do app"
            value={consentEnabled}
            onValueChange={onToggleConsent}
          />
          <ToggleRow
            label="Sincronizacao automatica"
            value={autoSyncEnabled}
            onValueChange={onToggleAutoSync}
          />
          <Text style={styles.caption}>
            Dados incluidos: filmes/series assistidos, listas, recomendacoes, perfis, PINs, fotos e configuracoes parentais.
          </Text>

          <Text style={[styles.sectionTitle, { marginTop: 14 }]}>Intervalo do backup automatico</Text>
          <Text style={styles.caption}>Escolha de quanto em quanto tempo a sincronizacao automatica pode rodar.</Text>
          <View style={styles.periodGrid}>
            {(Object.keys(BACKUP_INTERVAL_LABELS) as BackupSyncInterval[]).map((intervalKey) => {
              const active = backupSyncInterval === intervalKey;
              return (
                <TouchableOpacity
                  key={intervalKey}
                  style={[styles.periodChip, active && styles.periodChipActive]}
                  onPress={() => onChangeBackupInterval(intervalKey)}
                >
                  <Text style={[styles.periodChipText, active && styles.periodChipTextActive]}>
                    {BACKUP_INTERVAL_LABELS[intervalKey]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Notificacoes inteligentes</Text>
          <ToggleRow
            label="Receber sugestoes de filmes e series"
            value={smartNotificationsEnabled}
            onValueChange={onToggleSmartNotifications}
          />
          <Text style={styles.caption}>As recomendacoes usam o algoritmo para sugerir conteudos com descricao personalizada.</Text>
          <Text style={[styles.sectionTitle, { marginTop: 12 }]}>Intervalo das notificacoes</Text>
          <View style={styles.periodGrid}>
            {(Object.keys(SMART_NOTIFICATION_INTERVAL_LABELS) as SmartNotificationInterval[]).map((intervalKey) => {
              const active = smartNotificationInterval === intervalKey;
              return (
                <TouchableOpacity
                  key={intervalKey}
                  style={[styles.periodChip, active && styles.periodChipActive]}
                  onPress={() => onChangeSmartNotificationInterval(intervalKey)}
                  disabled={!smartNotificationsEnabled}
                >
                  <Text style={[styles.periodChipText, active && styles.periodChipTextActive]}>
                    {SMART_NOTIFICATION_INTERVAL_LABELS[intervalKey]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Acoes</Text>
          <ActionButton text="Sincronizar agora" icon="sync" onPress={onSyncNow} disabled={actionButtonsDisabled} />
          <ActionButton text="Criar backup agora" icon="backup" onPress={onBackupNow} tone="muted" disabled={actionButtonsDisabled} />
          <ActionButton text="Restaurar ultimo backup" icon="restore" onPress={onRestore} tone="muted" disabled={actionButtonsDisabled} />
          {backupJob.isRunning ? <Text style={styles.caption}>As acoes ficam bloqueadas ate o processo atual terminar.</Text> : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Historico recente</Text>
          {history.length ? (
            history.map((entry) => {
              const success = entry.status === 'success';
              const label = entry.operation === 'restore' ? 'Restauracao' : 'Backup';
              const originLine =
                entry.operation === 'restore' && entry.sourceCreatedAt
                  ? `Origem: backup de ${new Date(entry.sourceCreatedAt).toLocaleString('pt-BR')}`
                  : entry.operation === 'backup' && entry.backupFile
                  ? `Arquivo: ${entry.backupFile.split('/').pop()}`
                  : null;
              return (
                <View key={entry.id} style={styles.historyRow}>
                  <View style={[styles.historyDot, success ? styles.historyDotSuccess : styles.historyDotError]} />
                  <View style={styles.historyContent}>
                    <Text style={styles.historyTitle}>
                      {label} {success ? 'concluido' : 'com falha'}
                    </Text>
                    <Text style={styles.infoText}>{new Date(entry.finishedAt).toLocaleString('pt-BR')}</Text>
                    {entry.activeProfileName ? <Text style={styles.caption}>Perfil: {entry.activeProfileName}</Text> : null}
                    <Text style={styles.caption}>{entry.message}</Text>
                    {originLine ? <Text style={styles.caption}>{originLine}</Text> : null}
                  </View>
                </View>
              );
            })
          ) : (
            <Text style={styles.caption}>Nenhuma execucao registrada ainda.</Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Atualizacao do servidor</Text>
          <Text style={styles.caption}>Defina quando o app deve buscar novidades no servidor.</Text>
          <Text style={styles.infoText}>
            Ultima atualizacao local: {lastCatalogSyncAt ? new Date(lastCatalogSyncAt).toLocaleString('pt-BR') : 'Ainda nao sincronizado'}
          </Text>
          <Text style={styles.infoText}>
            Proxima atualizacao prevista: {nextRefreshAt ? new Date(nextRefreshAt).toLocaleString('pt-BR') : 'Na proxima abertura com internet'}
          </Text>
          <View style={styles.periodGrid}>
            {(
              Object.keys(REFRESH_PERIOD_LABELS) as CatalogRefreshPeriod[]
            ).map((periodKey) => {
              const active = refreshPeriod === periodKey;
              return (
                <TouchableOpacity
                  key={periodKey}
                  style={[styles.periodChip, active && styles.periodChipActive]}
                  onPress={() => onChangeRefreshPeriod(periodKey)}
                >
                  <Text style={[styles.periodChipText, active && styles.periodChipTextActive]}>
                    {REFRESH_PERIOD_LABELS[periodKey]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function ToggleRow({
  label,
  value,
  onValueChange,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onValueChange}
        thumbColor={StreamingTheme.colors.textPrimary}
        trackColor={{ false: 'rgba(255,255,255,0.2)', true: 'rgba(255,59,48,0.55)' }}
      />
    </View>
  );
}

function ActionButton({
  text,
  icon,
  onPress,
  tone = 'primary',
  disabled = false,
}: {
  text: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  onPress: () => void;
  tone?: 'primary' | 'muted';
  disabled?: boolean;
}) {
  const isPrimary = tone === 'primary';
  return (
    <TouchableOpacity
      style={[styles.button, !isPrimary && styles.buttonMuted, disabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      <MaterialIcons name={icon} size={18} color={StreamingTheme.colors.textPrimary} />
      <Text style={styles.buttonText}>{text}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: StreamingTheme.colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 120,
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTextWrap: { flex: 1 },
  kicker: {
    color: StreamingTheme.colors.accentAlt,
    fontWeight: '700',
    letterSpacing: 1,
    fontSize: 12,
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '900',
    fontSize: 24,
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(16,21,37,0.86)',
    padding: 12,
    gap: 8,
  },
  sectionTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '900',
    fontSize: 16,
  },
  infoText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
  },
  progressInfoText: {
    color: StreamingTheme.colors.accentAlt,
    fontSize: 13,
    fontWeight: '700',
  },
  progressCard: {
    marginTop: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(93,169,255,0.32)',
    backgroundColor: 'rgba(93,169,255,0.08)',
    padding: 10,
    gap: 8,
  },
  progressHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  progressTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
    flex: 1,
  },
  progressPercent: {
    color: StreamingTheme.colors.accentAlt,
    fontSize: 12,
    fontWeight: '900',
  },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: StreamingTheme.colors.accentAlt,
  },
  progressErrorText: {
    color: '#FF8A80',
    fontSize: 12,
    fontWeight: '700',
  },
  caption: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  toggleRow: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleLabel: {
    color: StreamingTheme.colors.textSecondary,
    fontWeight: '700',
    fontSize: 12,
    flex: 1,
    paddingRight: 8,
  },
  button: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,59,48,0.5)',
    backgroundColor: 'rgba(255,59,48,0.2)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10,
  },
  buttonMuted: {
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 12,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: 10,
  },
  historyDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    marginTop: 4,
  },
  historyDotSuccess: {
    backgroundColor: '#59D98E',
  },
  historyDotError: {
    backgroundColor: '#FF8A80',
  },
  historyContent: {
    flex: 1,
    gap: 2,
  },
  historyTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
  },
  periodGrid: {
    marginTop: 6,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  periodChip: {
    minHeight: 38,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  periodChipActive: {
    borderColor: 'rgba(255,59,48,0.6)',
    backgroundColor: 'rgba(255,59,48,0.2)',
  },
  periodChipText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  periodChipTextActive: {
    color: StreamingTheme.colors.textPrimary,
  },
});
