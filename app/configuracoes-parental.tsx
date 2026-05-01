import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  Alert,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeatureGate } from '@/components/feature-gate';
import { PageLoader } from '@/components/page-loader';
import { AppBackdrop } from '@/components/app-backdrop';
import { ParentalUnlockModal } from '@/components/parental-unlock-modal';
import { StreamingTheme } from '@/constants/streaming-theme';
import { usePlanGate } from '@/hooks/use-plan-gate';
import {
  AccountSettingsState,
  loadAccountSettings,
  updateParentalSettings,
  verifyMasterPin,
} from '@/services/account-settings';

export default function ConfiguracoesParentalScreen() {
  const router = useRouter();
  const { hasFeature, loading: planLoading } = usePlanGate();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [state, setState] = useState<AccountSettingsState | null>(null);
  const [showSettingsPinModal, setShowSettingsPinModal] = useState(false);

  const [parentalEnabled, setParentalEnabled] = useState(false);
  const [masterPin, setMasterPin] = useState('');
  const [settingsPinRequired, setSettingsPinRequired] = useState(true);
  const [adultPinRequired, setAdultPinRequired] = useState(true);
  const [lockedKeywords, setLockedKeywords] = useState('');
  const parentalLocked = !planLoading && !hasFeature('parental_controls');

  if (parentalLocked) {
    return <FeatureGate feature="parental_controls" locked>{null}</FeatureGate>;
  }

  const hydrate = useCallback(async () => {
    if (!state) {
      setIsLoading(true);
    }
    try {
      const next = await loadAccountSettings();
      setState(next);
      setParentalEnabled(next.parental.enabled);
      setMasterPin(next.parental.masterPin);
      setSettingsPinRequired(next.parental.requirePinForSettings);
      setAdultPinRequired(next.parental.requirePinForAdultContent);
      setLockedKeywords(next.parental.lockedKeywords.join(', '));
      const mustAskSettingsPin = next.parental.enabled && next.parental.requirePinForSettings;
      setShowSettingsPinModal(mustAskSettingsPin);
    } finally {
      setIsLoading(false);
    }
  }, [state]);

  useFocusEffect(
    useCallback(() => {
      hydrate();
    }, [hydrate])
  );

  const onSave = async () => {
    const keywords = lockedKeywords
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    try {
      setIsSaving(true);
      const next = await updateParentalSettings({
        enabled: parentalEnabled,
        masterPin,
        requirePinForSettings: settingsPinRequired,
        requirePinForAdultContent: adultPinRequired,
        lockedKeywords: keywords,
      });
      setState(next);
      Alert.alert('Controle dos pais', 'Configuracoes de controle salvas.');
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel salvar.'));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading || !state) {
    return (
      <SafeAreaView style={styles.container}>
        <AppBackdrop blurIntensity={28} />
        <PageLoader visible label="Carregando controle dos pais" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isSaving} label="Salvando controle parental" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.kicker}>PROTECAO</Text>
            <Text style={styles.title}>Controle dos pais</Text>
          </View>
          <View style={styles.iconBtn} />
        </View>

        <View style={styles.card}>
          <ToggleRow label="Ativar controle dos pais" value={parentalEnabled} onValueChange={setParentalEnabled} />

          <Field
            label="PIN mestre"
            placeholder="Minimo 4 digitos"
            value={masterPin}
            onChangeText={(value) => setMasterPin(value.replace(/[^0-9]/g, ''))}
            secureTextEntry
          />

          <ToggleRow
            label="Exigir PIN para configuracoes"
            value={settingsPinRequired}
            onValueChange={setSettingsPinRequired}
          />

          <ToggleRow
            label="Exigir PIN para conteudo adulto"
            value={adultPinRequired}
            onValueChange={setAdultPinRequired}
          />

          <Field
            label="Palavras bloqueadas"
            placeholder="adult, 18+, xxx"
            value={lockedKeywords}
            onChangeText={setLockedKeywords}
          />

          <ActionButton text="Salvar controle dos pais" icon="shield" onPress={onSave} />
          <ActionButton text="Filtros avancados de categoria e conteudo" icon="filter-alt" onPress={() => router.push('/configuracoes-parental-filtros' as any)} tone="muted" />
          <ActionButton text="Gerenciar perfis" icon="groups" onPress={() => router.push('/configuracoes-perfis' as any)} tone="muted" />
        </View>
      </ScrollView>

      <ParentalUnlockModal
        visible={showSettingsPinModal}
        onClose={() => router.back()}
        onConfirm={async (pin) => {
          if (!state || !verifyMasterPin(state, pin)) {
            Alert.alert('PIN incorreto', 'Nao foi possivel abrir as configuracoes.');
            return;
          }

          setShowSettingsPinModal(false);
        }}
        title="Configuracoes protegidas"
        subtitle="Digite o PIN mestre para acessar esta area."
        confirmLabel="Entrar"
        pinPlaceholder="PIN mestre"
      />
    </SafeAreaView>
  );
}

function Field({
  label,
  placeholder,
  value,
  onChangeText,
  secureTextEntry = false,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  secureTextEntry?: boolean;
}) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        placeholder={placeholder}
        placeholderTextColor={StreamingTheme.colors.textMuted}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secureTextEntry}
      />
    </View>
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
      <MaterialIcons name={icon} size={16} color={StreamingTheme.colors.textPrimary} />
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
  label: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    marginBottom: 4,
    fontWeight: '700',
  },
  input: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    height: 46,
    paddingHorizontal: 12,
    color: StreamingTheme.colors.textPrimary,
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
    paddingRight: 10,
    flexShrink: 1,
  },
  button: {
    minHeight: 42,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,59,48,0.5)',
    backgroundColor: 'rgba(255,59,48,0.24)',
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
});
