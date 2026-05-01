import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
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
import { ParentalUnlockModal } from '@/components/parental-unlock-modal';
import { StreamingTheme } from '@/constants/streaming-theme';
import { usePlanGate } from '@/hooks/use-plan-gate';
import {
  AccountSettingsState,
  loadAccountSettings,
  removeProfile,
  removeServer,
  setActiveProfile,
  setActiveServer,
  updateParentalSettings,
  upsertProfile,
  upsertServer,
  verifyMasterPin,
} from '@/services/account-settings';
import { canAddProfile, canAddServer, Feature } from '@/services/subscription';

const emptyServerForm = {
  id: '',
  name: '',
  url: '',
  username: '',
  password: '',
};

const emptyProfileForm = {
  id: '',
  name: '',
  pinEnabled: false,
  pin: '',
  kidsMode: false,
};

export default function ContaScreen() {
  const router = useRouter();
  const { hasFeature, loading: planLoading, plan } = usePlanGate();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [state, setState] = useState<AccountSettingsState | null>(null);
  const [showSettingsPinModal, setShowSettingsPinModal] = useState(false);

  const [serverForm, setServerForm] = useState(emptyServerForm);
  const [profileForm, setProfileForm] = useState(emptyProfileForm);

  const [parentalEnabled, setParentalEnabled] = useState(false);
  const [masterPin, setMasterPin] = useState('');
  const [settingsPinRequired, setSettingsPinRequired] = useState(true);
  const [adultPinRequired, setAdultPinRequired] = useState(true);
  const [lockedKeywords, setLockedKeywords] = useState('');

  const activeServer = useMemo(
    () => state?.servers.find((item) => item.id === state.activeServerId),
    [state]
  );

  const activeProfile = useMemo(
    () => state?.profiles.find((item) => item.id === state.activeProfileId),
    [state]
  );
  const canUseParentalControls = !planLoading && hasFeature('parental_controls');
  const canUseRealtimeMonitor = !planLoading && hasFeature('realtime_monitor');
  const hasMultiServerPlan = !planLoading && hasFeature('multi_server');
  const hasMultiUserPlan = !planLoading && hasFeature('multi_user');

  const hydrate = async () => {
    const next = await loadAccountSettings();
    setState(next);
    setParentalEnabled(next.parental.enabled);
    setMasterPin(next.parental.masterPin);
    setSettingsPinRequired(next.parental.requirePinForSettings);
    setAdultPinRequired(next.parental.requirePinForAdultContent);
    setLockedKeywords(next.parental.lockedKeywords.join(', '));
    const mustAskSettingsPin = next.parental.enabled && next.parental.requirePinForSettings;
    setShowSettingsPinModal(mustAskSettingsPin);
    setIsLoading(false);
  };

  useEffect(() => {
    hydrate();
  }, []);

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
    if (!state) return;

    if (!serverForm.id && !(await canAddServer(state.servers.length))) {
      router.push('/assinar?feature=multi_server');
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

  const onActivateServer = async (serverId: string) => {
    const next = await runAction(() => setActiveServer(serverId));
    if (!next) return;
    router.replace('/loading');
  };

  const onEditServer = (serverId: string) => {
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

  const onDeleteServer = (serverId: string) => {
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

  const onSaveProfile = async () => {
    if (!state) return;

    if (!profileForm.id && !(await canAddProfile(state.profiles.length))) {
      router.push('/assinar?feature=multi_user');
      return;
    }

    const next = await runAction(() =>
      upsertProfile(
        {
          name: profileForm.name,
          pinEnabled: profileForm.pinEnabled,
          pin: profileForm.pin,
          kidsMode: profileForm.kidsMode,
        },
        profileForm.id || undefined
      )
    );

    if (!next) return;
    setProfileForm(emptyProfileForm);
    Alert.alert('Perfil salvo', 'Perfil atualizado com sucesso.');
  };

  const onEditProfile = (profileId: string) => {
    if (!state) return;
    const target = state.profiles.find((item) => item.id === profileId);
    if (!target) return;

    setProfileForm({
      id: target.id,
      name: target.name,
      pinEnabled: target.pinEnabled,
      pin: target.pin,
      kidsMode: target.kidsMode,
    });
  };

  const onDeleteProfile = (profileId: string) => {
    Alert.alert('Remover perfil', 'Deseja remover este perfil?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Remover',
        style: 'destructive',
        onPress: async () => {
          await runAction(() => removeProfile(profileId));
        },
      },
    ]);
  };

  const onSaveParental = async () => {
    if (!canUseParentalControls) {
      router.push('/assinar?feature=parental_controls');
      return;
    }

    const keywords = lockedKeywords
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    const next = await runAction(() =>
      updateParentalSettings({
        enabled: parentalEnabled,
        masterPin,
        requirePinForSettings: settingsPinRequired,
        requirePinForAdultContent: adultPinRequired,
        lockedKeywords: keywords,
      })
    );

    if (!next) return;
    Alert.alert('Controle dos pais', 'Configuracoes de controle salvas.');
  };

  if (isLoading || !state) {
    return (
      <SafeAreaView style={styles.container}>
        <AppBackdrop blurIntensity={28} />
        <PageLoader visible label="Carregando conta" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isSaving} label="Salvando configuracoes" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.kicker}>Conta e seguranca</Text>
            <Text style={styles.title}>Conta e configuracoes</Text>
          </View>
          <View style={styles.iconBtn} />
        </View>

        <View style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>Sessao ativa</Text>
          <Text style={styles.summaryLine}>Servidor: {activeServer?.name || 'Nao definido'}</Text>
          <Text style={styles.summaryLine}>Usuario: {activeServer?.username || '-'}</Text>
          <Text style={styles.summaryLine}>Perfil: {activeProfile?.name || '-'}</Text>
        </View>

        <Section title="Servidores Xtream" subtitle="Cadastre varios servidores e troque quando quiser.">
          <Field
            label="Nome do servidor"
            placeholder="Ex: Casa, Viagem, Backup"
            value={serverForm.name}
            onChangeText={(value) => setServerForm((prev) => ({ ...prev, name: value }))}
          />
          <Field
            label="URL"
            placeholder="http://seu-servidor.com"
            value={serverForm.url}
            onChangeText={(value) => setServerForm((prev) => ({ ...prev, url: value }))}
            keyboardType="url"
          />
          <Field
            label="Usuario"
            placeholder="Seu usuario"
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

          <View style={styles.rowActions}>
            <Button
              text={serverForm.id ? 'Atualizar servidor' : 'Adicionar servidor'}
              icon="save"
              onPress={onSaveServer}
            />
            {!!serverForm.id && (
              <Button
                text="Limpar"
                icon="close"
                tone="muted"
                onPress={() => setServerForm(emptyServerForm)}
              />
            )}
          </View>

          {!hasMultiServerPlan && (
            <UpgradeHintCard
              feature="multi_server"
              title="Mais de 1 servidor exige upgrade"
              description={`Seu plano atual${plan ? ` (${plan.name})` : ''} permite 1 servidor. Desbloqueie alternancia entre servidores e histórico unificado.`}
            />
          )}

          {state.servers.map((item) => {
            const active = item.id === state.activeServerId;
            return (
              <View key={item.id} style={[styles.itemRow, active && styles.itemRowActive]}>
                <View style={styles.itemMain}>
                  <Text style={styles.itemTitle}>{item.name}</Text>
                  <Text style={styles.itemSub}>{item.url}</Text>
                  <Text style={styles.itemSub}>Usuario: {item.username}</Text>
                </View>
                <View style={styles.itemActions}>
                  {!active && (
                    <TinyAction text="Ativar" onPress={() => onActivateServer(item.id)} />
                  )}
                  <TinyAction text="Editar" onPress={() => onEditServer(item.id)} />
                  <TinyAction text="Excluir" danger onPress={() => onDeleteServer(item.id)} />
                </View>
              </View>
            );
          })}
        </Section>

        <Section title="Perfis de usuario" subtitle="Crie perfis com PIN individual e modo infantil.">
          <Field
            label="Nome do perfil"
            placeholder="Ex: Adulto, Filho, Visita"
            value={profileForm.name}
            onChangeText={(value) => setProfileForm((prev) => ({ ...prev, name: value }))}
          />

          <ToggleRow
            label="PIN por perfil"
            value={profileForm.pinEnabled}
            onValueChange={(value) => setProfileForm((prev) => ({ ...prev, pinEnabled: value }))}
          />

          {profileForm.pinEnabled && (
            <Field
              label="PIN do perfil"
              placeholder="Minimo 4 digitos"
              value={profileForm.pin}
              onChangeText={(value) => setProfileForm((prev) => ({ ...prev, pin: value.replace(/[^0-9]/g, '') }))}
              keyboardType="numeric"
              secureTextEntry
            />
          )}

          <ToggleRow
            label="Modo infantil"
            value={profileForm.kidsMode}
            onValueChange={(value) => setProfileForm((prev) => ({ ...prev, kidsMode: value }))}
          />

          <View style={styles.rowActions}>
            <Button text={profileForm.id ? 'Atualizar perfil' : 'Adicionar perfil'} icon="person-add" onPress={onSaveProfile} />
            {!!profileForm.id && (
              <Button
                text="Limpar"
                icon="close"
                tone="muted"
                onPress={() => setProfileForm(emptyProfileForm)}
              />
            )}
          </View>

          {!hasMultiUserPlan && (
            <UpgradeHintCard
              feature="multi_user"
              title="Perfis extras fazem parte dos planos superiores"
              description={`Seu plano atual${plan ? ` (${plan.name})` : ''} permite 1 perfil. Libere perfis separados para familia e criancas.`}
            />
          )}

          {state.profiles.map((item) => {
            const active = item.id === state.activeProfileId;
            return (
              <View key={item.id} style={[styles.itemRow, active && styles.itemRowActive]}>
                <View style={styles.itemMain}>
                  <Text style={styles.itemTitle}>{item.name}</Text>
                  <Text style={styles.itemSub}>PIN: {item.pinEnabled ? 'Ativo' : 'Desligado'}</Text>
                  <Text style={styles.itemSub}>Infantil: {item.kidsMode ? 'Sim' : 'Nao'}</Text>
                </View>
                <View style={styles.itemActions}>
                  {!active && (
                    <TinyAction text="Ativar" onPress={() => runAction(() => setActiveProfile(item.id))} />
                  )}
                  <TinyAction text="Editar" onPress={() => onEditProfile(item.id)} />
                  <TinyAction text="Excluir" danger onPress={() => onDeleteProfile(item.id)} />
                </View>
              </View>
            );
          })}
        </Section>

        <Section
          title="Controle dos pais"
          subtitle="Proteja configuracoes e conteudos sensiveis com PIN mestre e bloqueio por palavra-chave.">
          {canUseParentalControls ? (
            <>
              <ToggleRow label="Ativar controle dos pais" value={parentalEnabled} onValueChange={setParentalEnabled} />

              <Field
                label="PIN mestre"
                placeholder="Minimo 4 digitos"
                value={masterPin}
                onChangeText={(value) => setMasterPin(value.replace(/[^0-9]/g, ''))}
                keyboardType="numeric"
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

              <Button text="Salvar controle dos pais" icon="shield" onPress={onSaveParental} />

              {canUseRealtimeMonitor ? (
                <Button
                  text="Monitor em tempo real"
                  icon="monitor"
                  onPress={() => router.push('/monitor-parental')}
                />
              ) : (
                <UpgradeHintCard
                  feature="realtime_monitor"
                  title="Monitor em tempo real indisponivel"
                  description="Acompanhe o que cada perfil assiste em tempo real com o plano Premium ou Vitalicio."
                />
              )}
            </>
          ) : (
            <UpgradeHintCard
              feature="parental_controls"
              title="Controle dos pais e um recurso Premium"
              description="Proteja configuracoes, bloqueie palavras-chave e crie uma experiencia segura para criancas com upgrade." 
            />
          )}
        </Section>
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

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <View style={styles.sectionCard}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionSub}>{subtitle}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function UpgradeHintCard({
  feature,
  title,
  description,
}: {
  feature: Feature;
  title: string;
  description: string;
}) {
  const router = useRouter();

  return (
    <View style={styles.upgradeCard}>
      <View style={styles.upgradeHeader}>
        <MaterialIcons name="lock" size={16} color="#FFB066" />
        <Text style={styles.upgradeTitle}>{title}</Text>
      </View>
      <Text style={styles.upgradeDescription}>{description}</Text>
      <TouchableOpacity style={styles.upgradeButton} onPress={() => router.push(`/assinar?feature=${feature}` as any)}>
        <Text style={styles.upgradeButtonText}>Ver planos</Text>
      </TouchableOpacity>
    </View>
  );
}

function Field({
  label,
  placeholder,
  value,
  onChangeText,
  keyboardType = 'default',
  secureTextEntry = false,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  keyboardType?: 'default' | 'numeric' | 'url';
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
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        autoCapitalize="none"
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

function Button({
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
      <MaterialIcons
        name={icon}
        size={16}
        color={isPrimary ? StreamingTheme.colors.textPrimary : StreamingTheme.colors.textSecondary}
      />
      <Text style={[styles.buttonText, !isPrimary && styles.buttonTextMuted]}>{text}</Text>
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
    marginBottom: 4,
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
  headerTextWrap: {
    flex: 1,
  },
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
    marginTop: 2,
  },
  summaryCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(16,21,37,0.8)',
    padding: 12,
    gap: 3,
  },
  summaryTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 14,
  },
  summaryLine: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
  },
  upgradeCard: {
    marginTop: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,176,102,0.35)',
    backgroundColor: 'rgba(255,143,58,0.1)',
    padding: 12,
    gap: 8,
  },
  upgradeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  upgradeTitle: {
    flex: 1,
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 14,
  },
  upgradeDescription: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  upgradeButton: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    backgroundColor: '#FF8F3A',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  upgradeButtonText: {
    color: '#1A1110',
    fontWeight: '900',
    fontSize: 12,
  },
  sectionCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(16,21,37,0.82)',
    padding: 12,
  },
  sectionTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '900',
    fontSize: 16,
  },
  sectionSub: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
    marginTop: 4,
  },
  sectionBody: {
    marginTop: 10,
    gap: 8,
  },
  label: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    marginBottom: 5,
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
  rowActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
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
  buttonTextMuted: {
    color: StreamingTheme.colors.textSecondary,
  },
  itemRow: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    padding: 10,
    marginTop: 2,
    gap: 8,
  },
  itemRowActive: {
    borderColor: 'rgba(255,59,48,0.55)',
    backgroundColor: 'rgba(255,59,48,0.16)',
  },
  itemMain: {
    gap: 3,
  },
  itemTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 14,
  },
  itemSub: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  itemActions: {
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
});
