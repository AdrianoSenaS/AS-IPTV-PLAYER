import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PageLoader } from '@/components/page-loader';
import { AppBackdrop } from '@/components/app-backdrop';
import { PlanGateBlur } from '@/components/plan-gate-blur';
import { StreamingTheme } from '@/constants/streaming-theme';
import { usePlanGate } from '@/hooks/use-plan-gate';
import {
  AccountSettingsState,
  loadAccountSettings,
  removeServer,
  setActiveServer,
  upsertServer,
} from '@/services/account-settings';

const emptyServerForm = {
  id: '',
  name: '',
  url: '',
  username: '',
  password: '',
};

export default function ConfiguracoesServidoresScreen() {
  const router = useRouter();
  const { hasFeature, loading: planLoading } = usePlanGate();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [state, setState] = useState<AccountSettingsState | null>(null);
  const [serverForm, setServerForm] = useState(emptyServerForm);

  // Locked: pode ver/gerenciar servidores existentes, mas precisa de plano para adicionar mais.
  const serverLocked = !planLoading && !hasFeature('multi_server') && !serverForm.id;

  const hydrate = useCallback(async () => {
    if (!state) {
      setIsLoading(true);
    }
    try {
      const next = await loadAccountSettings();
      setState(next);
    } finally {
      setIsLoading(false);
    }
  }, [state]);

  useFocusEffect(
    useCallback(() => {
      hydrate();
    }, [hydrate])
  );

  const activeServerId = useMemo(() => state?.activeServerId || '', [state]);

  const runAction = async (callback: () => Promise<AccountSettingsState>) => {
    try {
      setIsSaving(true);
      const nextState = await callback();
      setState(nextState);
      return nextState;
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel salvar.'));
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  const onSaveServer = async () => {
    const next = await runAction(() =>
      upsertServer(
        {
          name: serverForm.name,
          url: serverForm.url,
          username: serverForm.username,
          password: serverForm.password,
        },
        serverForm.id || undefined
      )
    );

    if (!next) return;
    setServerForm(emptyServerForm);
    Alert.alert('Servidor salvo', 'Servidor atualizado com sucesso.');
    router.replace('/loading');
  };

  const onActivate = async (serverId: string) => {
    const next = await runAction(() => setActiveServer(serverId));
    if (!next) return;
    Alert.alert('Servidor ativo', 'Servidor ativado.');
    router.replace('/loading');
  };

  const onEdit = (serverId: string) => {
    if (!state) return;
    const target = state.servers.find((item) => item.id === serverId);
    if (!target) return;

    setServerForm({
      id: target.id,
      name: target.name,
      url: target.url,
      username: target.username,
      password: target.password,
    });
  };

  const onDelete = (serverId: string) => {
    Alert.alert('Remover servidor', 'Deseja remover este servidor?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Remover',
        style: 'destructive',
        onPress: async () => {
          await runAction(() => removeServer(serverId));
        },
      },
    ]);
  };

  if (isLoading || !state) {
    return (
      <SafeAreaView style={styles.container}>
        <AppBackdrop blurIntensity={28} />
        <PageLoader visible label="Carregando servidores" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isSaving} label="Salvando servidor" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.kicker}>AMBIENTE</Text>
            <Text style={styles.title}>Servidores Xtream</Text>
          </View>
          <View style={styles.iconBtn} />
        </View>

        <PlanGateBlur feature="multi_server" locked={serverLocked} style={styles.card}>
          <View>
            <Text style={styles.sectionTitle}>{serverForm.id ? 'Editar servidor' : 'Novo servidor'}</Text>
            <Field label="Nome" placeholder="Casa, Viagem, Backup" value={serverForm.name} onChangeText={(value) => setServerForm((prev) => ({ ...prev, name: value }))} />
            <Field label="URL" placeholder="https://servidor.com" value={serverForm.url} onChangeText={(value) => setServerForm((prev) => ({ ...prev, url: value }))} />
            <Field label="Usuario" placeholder="Seu usuario" value={serverForm.username} onChangeText={(value) => setServerForm((prev) => ({ ...prev, username: value }))} />
            <Field label="Senha" placeholder="Sua senha" value={serverForm.password} onChangeText={(value) => setServerForm((prev) => ({ ...prev, password: value }))} secureTextEntry />

            <View style={styles.row}>
              <ActionButton text={serverForm.id ? 'Atualizar' : 'Adicionar'} icon="save" onPress={onSaveServer} />
              {!!serverForm.id && <ActionButton text="Limpar" icon="close" tone="muted" onPress={() => setServerForm(emptyServerForm)} />}
            </View>
          </View>
        </PlanGateBlur>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Servidores cadastrados</Text>
          {state.servers.map((item) => {
            const active = item.id === activeServerId;
            return (
              <View key={item.id} style={[styles.serverRow, active && styles.serverRowActive]}>
                <View style={styles.serverMain}>
                  <Text style={styles.serverTitle}>{item.name}</Text>
                  <Text style={styles.serverSub}>{item.url}</Text>
                  <Text style={styles.serverSub}>Usuario: {item.username}</Text>
                </View>
                <View style={styles.actions}>
                  {!active && <TinyAction text="Ativar" onPress={() => onActivate(item.id)} />}
                  <TinyAction text="Editar" onPress={() => onEdit(item.id)} />
                  <TinyAction text="Excluir" danger onPress={() => onDelete(item.id)} />
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>
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
        autoCapitalize="none"
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

function TinyAction({
  text,
  onPress,
  danger = false,
}: {
  text: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <TouchableOpacity style={[styles.tinyBtn, danger && styles.tinyBtnDanger]} onPress={onPress}>
      <Text style={[styles.tinyBtnText, danger && styles.tinyBtnTextDanger]}>{text}</Text>
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
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  button: {
    flex: 1,
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
  serverRow: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    padding: 10,
    marginTop: 2,
    gap: 8,
  },
  serverRowActive: {
    borderColor: 'rgba(255,59,48,0.55)',
    backgroundColor: 'rgba(255,59,48,0.16)',
  },
  serverMain: { gap: 3 },
  serverTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 14,
  },
  serverSub: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  actions: {
    flexDirection: 'row',
    gap: 7,
  },
  tinyBtn: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  tinyBtnDanger: {
    borderColor: 'rgba(255,59,48,0.5)',
    backgroundColor: 'rgba(255,59,48,0.2)',
  },
  tinyBtnText: {
    color: StreamingTheme.colors.textSecondary,
    fontWeight: '700',
    fontSize: 11,
  },
  tinyBtnTextDanger: {
    color: StreamingTheme.colors.textPrimary,
  },
});
