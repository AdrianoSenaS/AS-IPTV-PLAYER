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

import { AppBackdrop } from '@/components/app-backdrop';
import { PageLoader } from '@/components/page-loader';
import { PlanGateBlur } from '@/components/plan-gate-blur';
import { StreamingTheme } from '@/constants/streaming-theme';
import { usePlanGate } from '@/hooks/use-plan-gate';
import {
  AccountSettingsState,
  formatXtreamUrlInput,
  loadAccountSettings,
  removeServer,
  setActiveServer,
  updateServerConnectionSettings,
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
  const { plan, loading: planLoading } = usePlanGate();

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [state, setState] = useState<AccountSettingsState | null>(null);
  const [serverForm, setServerForm] = useState(emptyServerForm);
  const [allowHttps, setAllowHttps] = useState(false);

  const serverLimitReached =
    !planLoading &&
    !!state &&
    plan?.maxServers !== -1 &&
    state.servers.length >= Number(plan?.maxServers || 1);

  // Bloqueia somente novo cadastro ao atingir limite do plano.
  const serverLocked = !!serverLimitReached && !serverForm.id;

  const hydrate = useCallback(async () => {
    if (!state) {
      setIsLoading(true);
    }

    try {
      const next = await loadAccountSettings();
      setState(next);
      setAllowHttps(next.serverConnection.allowHttps);
    } finally {
      setIsLoading(false);
    }
  }, [state]);

  useFocusEffect(
    useCallback(() => {
      hydrate();
    }, [hydrate])
  );

  const runAction = async (callback: () => Promise<AccountSettingsState>) => {
    try {
      setIsSaving(true);
      const nextState = await callback();
      setState(nextState);
      setAllowHttps(nextState.serverConnection.allowHttps);
      return nextState;
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Não foi possível salvar.'));
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  const onToggleHttps = async (value: boolean) => {
    setAllowHttps(value);
    setServerForm((prev) => ({ ...prev, url: formatXtreamUrlInput(prev.url, value) }));

    const next = await runAction(() => updateServerConnectionSettings({ allowHttps: value }));
    if (!next) {
      setAllowHttps((prev) => !prev);
      return;
    }

    Alert.alert(
      'Protocolo atualizado',
      value
        ? 'HTTPS liberado para os servidores Xtream.'
        : 'HTTP voltou a ser o padrão e URLs HTTPS foram convertidas quando necessário.'
    );
  };

  const onSaveServer = async () => {
    if (!serverForm.id && serverLocked) {
      Alert.alert(
        'Limite do plano atingido',
        `Seu plano atual (${plan?.name || 'Atual'}) permite até ${plan?.maxServers === -1 ? 'ilimitado' : plan?.maxServers || 1} servidor(es). Para adicionar outro, faça upgrade.`
      );
      router.push({ pathname: '/assinar', params: { feature: 'multi_server', from: 'configuracoes-servidores' } });
      return;
    }

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
    router.replace('/loading');
  };

  const onActivate = async (serverId: string) => {
    const next = await runAction(() => setActiveServer(serverId));
    if (!next) return;
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

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Protocolo padrão</Text>
          <Text style={styles.sectionText}>
            O app usa http:// por padrão. Se HTTPS estiver desligado e você digitar https://, a URL é trocada para http:// automaticamente.
          </Text>
          <View style={styles.toggleRow}>
            <View style={styles.toggleTextWrap}>
              <Text style={styles.toggleLabel}>Permitir HTTPS</Text>
              <Text style={styles.toggleHelper}>
                Ative apenas quando seu servidor Xtream realmente responder em https://.
              </Text>
            </View>
            <Switch
              value={allowHttps}
              onValueChange={onToggleHttps}
              thumbColor={StreamingTheme.colors.textPrimary}
              trackColor={{ false: 'rgba(255,255,255,0.2)', true: 'rgba(255,122,24,0.55)' }}
            />
          </View>
        </View>

        <PlanGateBlur feature="multi_server" locked={serverLocked} style={styles.card}>
          <Text style={styles.sectionTitle}>{serverForm.id ? 'Editar servidor' : 'Novo servidor'}</Text>
          <Text style={styles.sectionText}>
            A URL sem protocolo sera salva com http://. Use HTTPS somente quando esta configuracao estiver ativa.
          </Text>

          <Field
            label="Nome"
            placeholder="Casa, Viagem, Backup"
            value={serverForm.name}
            onChangeText={(value) => setServerForm((prev) => ({ ...prev, name: value }))}
          />
          <Field
            label="URL"
            placeholder="http://servidor.com"
            value={serverForm.url}
            onChangeText={(value) =>
              setServerForm((prev) => ({
                ...prev,
                url: allowHttps ? value : value.replace(/^https:\/\//i, 'http://'),
              }))
            }
            onBlur={() =>
              setServerForm((prev) => ({
                ...prev,
                url: formatXtreamUrlInput(prev.url, allowHttps),
              }))
            }
          />
          <Field
            label="Usuário"
                    placeholder="Seu usuário"
            value={serverForm.username}
            onChangeText={(value) => setServerForm((prev) => ({ ...prev, username: value }))}
          />
          <Field
            label="Senha"
            placeholder="Sua senha"
            value={serverForm.password}
            onChangeText={(value) => setServerForm((prev) => ({ ...prev, password: value }))}
            secureTextEntry
          />

          <View style={styles.row}>
            <ActionButton text={serverForm.id ? 'Atualizar' : 'Adicionar'} icon="save" onPress={onSaveServer} />
            {!!serverForm.id && (
              <ActionButton text="Limpar" icon="close" tone="muted" onPress={() => setServerForm(emptyServerForm)} />
            )}
          </View>
        </PlanGateBlur>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Servidores cadastrados</Text>
          {state.servers.length ? (
            state.servers.map((item) => {
              const active = item.id === state.activeServerId;
              return (
                <View key={item.id} style={[styles.serverRow, active && styles.serverRowActive]}>
                  <View style={styles.serverMain}>
                    <Text style={styles.serverTitle}>{item.name}</Text>
                    <Text style={styles.serverSub}>{item.url}</Text>
                    <Text style={styles.serverSub}>Usuário: {item.username}</Text>
                  </View>
                  <View style={styles.actions}>
                    {!active && <TinyAction text="Ativar" onPress={() => onActivate(item.id)} />}
                    <TinyAction text="Editar" onPress={() => onEdit(item.id)} />
                    <TinyAction text="Excluir" danger onPress={() => onDelete(item.id)} />
                  </View>
                </View>
              );
            })
          ) : (
            <Text style={styles.emptyText}>Nenhum servidor salvo ainda.</Text>
          )}
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
  onBlur,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  secureTextEntry?: boolean;
  onBlur?: () => void;
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
        onBlur={onBlur}
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
    borderRadius: 18,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(16,21,37,0.86)',
    padding: 14,
    gap: 10,
  },
  sectionTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '900',
    fontSize: 17,
  },
  sectionText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  toggleRow: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  toggleTextWrap: {
    flex: 1,
    gap: 4,
  },
  toggleLabel: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  toggleHelper: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  label: {
    color: StreamingTheme.colors.textSecondary,
    marginBottom: 8,
    fontSize: 13,
    fontWeight: '700',
  },
  input: {
    minHeight: 50,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    color: StreamingTheme.colors.textPrimary,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  button: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: '#FF7A18',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  buttonMuted: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
  },
  buttonText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 15,
  },
  serverRow: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: 12,
    gap: 12,
  },
  serverRowActive: {
    borderColor: 'rgba(255,122,24,0.45)',
    backgroundColor: 'rgba(255,122,24,0.10)',
  },
  serverMain: {
    gap: 4,
  },
  serverTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 15,
  },
  serverSub: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tinyBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  tinyBtnDanger: {
    borderColor: 'rgba(255,107,107,0.35)',
    backgroundColor: 'rgba(255,107,107,0.08)',
  },
  tinyBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 12,
  },
  tinyBtnTextDanger: {
    color: '#FF9B9B',
  },
  emptyText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
  },
});