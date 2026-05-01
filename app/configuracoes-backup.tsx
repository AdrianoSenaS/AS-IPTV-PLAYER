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
import { StreamingTheme } from '@/constants/streaming-theme';
import {
  loadCloudSyncPrefs,
  loadUserSession,
  restoreLastCloudBackup,
  runCloudBackupNow,
  saveCloudSyncPrefs,
} from '@/services/cloud-sync';
import {
  getCatalogLastUpdate,
  CatalogRefreshPeriod,
  getNextCatalogRefreshAt,
  loadCatalogRefreshPeriod,
  REFRESH_PERIOD_LABELS,
  saveCatalogRefreshPeriod,
} from '@/services/update-schedule';

export default function ConfiguracoesBackupScreen() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const [consentEnabled, setConsentEnabled] = useState(false);
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false);
  const [refreshPeriod, setRefreshPeriod] = useState<CatalogRefreshPeriod>('2d');
  const [lastCatalogSyncAt, setLastCatalogSyncAt] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState('');
  const [sessionEmail, setSessionEmail] = useState('');
  const hydratedOnceRef = useRef(false);

  const hydrate = useCallback(async () => {
    if (!hydratedOnceRef.current) {
      setIsLoading(true);
    }
    try {
      const [prefs, session, selectedPeriod, localCatalogLastUpdate] = await Promise.all([
        loadCloudSyncPrefs(),
        loadUserSession(),
        loadCatalogRefreshPeriod(),
        getCatalogLastUpdate(),
      ]);
      setConsentEnabled(prefs.consentEnabled);
      setAutoSyncEnabled(prefs.autoSyncEnabled);
      setLastSyncAt(prefs.lastSyncAt);
      setRefreshPeriod(selectedPeriod);
      setLastCatalogSyncAt(localCatalogLastUpdate);
      setSessionEmail(session?.user.email || 'Sem login');
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

  const runAction = async (action: () => Promise<void>) => {
    try {
      setIsSaving(true);
      await action();
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel executar a operacao.'));
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
    await runAction(async () => {
      const result = await runCloudBackupNow();
      setLastSyncAt(result.syncedAt);
      setLastCatalogSyncAt(await getCatalogLastUpdate());
      Alert.alert('Backup concluido', `Backup salvo em: ${result.backupFile}`);
    });
  };

  const onRestore = async () => {
    Alert.alert('Restaurar backup', 'Esta acao substitui dados locais atuais. Deseja continuar?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Restaurar',
        style: 'destructive',
        onPress: async () => {
          await runAction(async () => {
            const result = await restoreLastCloudBackup();
            setLastSyncAt(result.restoredAt);
            Alert.alert('Restore concluido', `Backup de ${new Date(result.sourceCreatedAt).toLocaleString('pt-BR')} restaurado.`);
          });
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
            <Text style={styles.title}>Backup e sincronizacao</Text>
          </View>
          <View style={styles.iconBtn} />
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Conta conectada</Text>
          <Text style={styles.infoText}>{sessionEmail}</Text>
          <Text style={styles.infoText}>
            Ultima sincronizacao: {lastSyncAt ? new Date(lastSyncAt).toLocaleString('pt-BR') : 'Nunca'}
          </Text>
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
            Dados incluidos: filmes/series assistidos, listas, servidores Xtream, perfis e configuracoes parentais.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Acoes</Text>
          <ActionButton text="Sincronizar agora" icon="sync" onPress={onSyncNow} />
          <ActionButton text="Criar backup agora" icon="backup" onPress={onBackupNow} tone="muted" />
          <ActionButton text="Restaurar ultimo backup" icon="restore" onPress={onRestore} tone="muted" />
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
}: {
  text: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  onPress: () => void;
  tone?: 'primary' | 'muted';
}) {
  const isPrimary = tone === 'primary';
  return (
    <TouchableOpacity style={[styles.button, !isPrimary && styles.buttonMuted]} onPress={onPress}>
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
  buttonText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 12,
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
