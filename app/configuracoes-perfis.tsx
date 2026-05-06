import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  Alert,
  Platform,
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

import { PageLoader } from '@/components/page-loader';
import { AppBackdrop } from '@/components/app-backdrop';
import { PlanGateBlur } from '@/components/plan-gate-blur';
import { StreamingTheme } from '@/constants/streaming-theme';
import { usePlanGate } from '@/hooks/use-plan-gate';
import {
  AccountSettingsState,
  Profile,
  getParentalMonitorAccess,
  loadAccountSettings,
  removeProfile,
  setParentalManagerPermission,
  setActiveProfile,
  upsertProfile,
  verifyProfilePin,
} from '@/services/account-settings';
import { unlockProfileAccess } from '@/services/access-control';
import { restoreLastCloudBackup, triggerImmediateSync, uploadProfileAvatarFromDevice } from '@/services/cloud-sync';
import { ensureRealtimeSessionForActiveProfile } from '@/services/realtime-presence';

const emptyProfileForm = {
  id: '',
  name: '',
  avatarUri: '',
  enabled: true,
  pinEnabled: false,
  pin: '',
  kidsMode: false,
  isPrimary: false,
};

const AVATAR_MAX_SIZE = 640;
const AVATAR_COMPRESS = 0.7;
let preferNativeCrop = true;
let imagePickerInFlight = false;

async function pickSingleImageFromLibrary() {
  if (imagePickerInFlight) {
    throw new Error('PICKER_IN_PROGRESS');
  }

  imagePickerInFlight = true;
  try {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    const hasPermission =
      permission.granted || (permission as any).accessPrivileges === 'limited';

    if (!hasPermission) {
      throw new Error('PERMISSION_DENIED');
    }

    if (Platform.OS === 'android') {
      const pending = await ImagePicker.getPendingResultAsync();
      if (Array.isArray(pending) && pending.length > 0) {
        const first = pending[0] as any;
        if (first && first.canceled !== undefined) {
          return first;
        }
      }
    }

    // Tenta crop nativo (iOS/Android). Se falhar, faz fallback para crop automático no processamento.
    const useNativeCrop = preferNativeCrop;

    return await ImagePicker.launchImageLibraryAsync({
      allowsEditing: useNativeCrop,
      quality: 0.35,
      ...(useNativeCrop ? { aspect: [1, 1] as [number, number] } : {}),
    });
  } catch (error: any) {
    // Nao relanca o picker na mesma tentativa: evita loop de reabertura no Android.
    if (Platform.OS === 'ios' && preferNativeCrop) {
      preferNativeCrop = false;
      throw new Error('CROP_UNAVAILABLE_RETRY');
    }
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || '').toLowerCase();
    // CodedError do expo-modules-core: só cancela quando for realmente cancelamento/sem imagem.
    if (code) {
      if (code === 'E_MISSING_PERMISSIONS' || code === 'E_NO_PERMISSIONS') {
        throw new Error('PERMISSION_DENIED');
      }
      if (code.includes('CANCEL') || code.includes('NO_IMAGE') || code.includes('NO_DATA')) {
        return { canceled: true, assets: [] } as any;
      }
      throw error;
    }
    if (message.includes('cancel') || message.includes('no image') || message.includes('no data')) {
      return { canceled: true, assets: [] } as any;
    }
    throw error;
  } finally {
    imagePickerInFlight = false;
  }
}

async function optimizeAvatarImage(uri: string): Promise<string> {
  const safeUri = String(uri || '').trim();
  if (!safeUri) return '';

  try {
    // Garante recorte quadrado (centro) mesmo quando o crop nativo não estiver disponível.
    const normalized = await manipulateAsync(safeUri, [], {
      compress: 1,
      format: SaveFormat.JPEG,
      base64: false,
    });

    const sourceWidth = Math.max(1, Number(normalized?.width || 0));
    const sourceHeight = Math.max(1, Number(normalized?.height || 0));
    const cropSide = Math.max(1, Math.min(sourceWidth, sourceHeight));
    const originX = Math.max(0, Math.floor((sourceWidth - cropSide) / 2));
    const originY = Math.max(0, Math.floor((sourceHeight - cropSide) / 2));

    const result = await manipulateAsync(
      normalized?.uri || safeUri,
      [
        { crop: { originX, originY, width: cropSide, height: cropSide } },
        { resize: { width: AVATAR_MAX_SIZE, height: AVATAR_MAX_SIZE } },
      ],
      {
        compress: AVATAR_COMPRESS,
        format: SaveFormat.JPEG,
        base64: false,
      }
    );
    return result?.uri || safeUri;
  } catch {
    return safeUri;
  }
}

export default function ConfiguracoesPerfisScreen() {
  const router = useRouter();
  const { plan, loading: planLoading } = usePlanGate();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [state, setState] = useState<AccountSettingsState | null>(null);
  const [profileForm, setProfileForm] = useState(emptyProfileForm);
  const [activationTarget, setActivationTarget] = useState<Profile | null>(null);
  const [activationPin, setActivationPin] = useState('');

  const profileLimitReached =
    !planLoading &&
    !!state &&
    plan?.maxProfiles !== -1 &&
    state.profiles.length >= Number(plan?.maxProfiles || 1);

  // Bloqueia apenas a criacao quando o limite do plano foi atingido; edicao continua liberada.
  const profileLocked = !!profileLimitReached && !profileForm.id;

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
      return () => {};
    }, [hydrate])
  );

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

  const activeProfile = state?.profiles.find((item) => item.id === state.activeProfileId) || null;
  const isPrimary = activeProfile?.isPrimary === true;
  const monitorAccess = state ? getParentalMonitorAccess(state) : null;
  const canConfigureParentalManagers = isPrimary;
  const managerCandidates = (state?.profiles || []).filter((item) => !item.kidsMode && !item.isPrimary);
  const manageableProfiles = (state?.profiles || []).filter((item) => item.kidsMode);

  const readManagerPermission = (profileId: string) =>
    state?.parentalManagers.find((entry) => entry.profileId === profileId) || {
      profileId,
      enabled: false,
      managedProfileIds: [] as string[],
    };

  const onToggleManagerEnabled = async (profileId: string, enabled: boolean) => {
    const current = readManagerPermission(profileId);
    await runAction(() =>
      setParentalManagerPermission({
        profileId,
        enabled,
        managedProfileIds: current.managedProfileIds,
      })
    );
  };

  const onToggleManagedProfile = async (managerProfileId: string, targetProfileId: string, checked: boolean) => {
    const current = readManagerPermission(managerProfileId);
    const nextManaged = checked
      ? Array.from(new Set([...current.managedProfileIds, targetProfileId]))
      : current.managedProfileIds.filter((id) => id !== targetProfileId);

    await runAction(() =>
      setParentalManagerPermission({
        profileId: managerProfileId,
        enabled: current.enabled,
        managedProfileIds: nextManaged,
      })
    );
  };

  const onSave = async () => {
    if (!profileForm.id && profileLocked) {
      Alert.alert(
        'Limite do plano atingido',
        `Seu plano atual (${plan?.name || 'Atual'}) permite ate ${plan?.maxProfiles === -1 ? 'ilimitado' : plan?.maxProfiles || 1} perfil(is). Para adicionar outro, faca upgrade.`
      );
      router.push({ pathname: '/assinar', params: { feature: 'multi_user', from: 'configuracoes-perfis' } });
      return;
    }

    // Perfil nao-principal so pode editar o proprio perfil.
    if (!isPrimary && profileForm.id && profileForm.id !== state?.activeProfileId) {
      Alert.alert('Permissao negada', 'Voce so pode editar o seu proprio perfil.');
      return;
    }

    const next = await runAction(() =>
      upsertProfile(
        {
          name: profileForm.name,
          avatarUri: profileForm.avatarUri,
          enabled: profileForm.enabled,
          pinEnabled: profileForm.pinEnabled,
          pin: profileForm.pin,
          kidsMode: profileForm.kidsMode,
          isPrimary: isPrimary ? profileForm.isPrimary : undefined,
        },
        profileForm.id || undefined
      )
    );

    if (!next) return;
    setProfileForm(emptyProfileForm);
    Alert.alert('Perfil salvo', 'Perfil atualizado com sucesso.');
    // Sincroniza perfil editado com a API imediatamente.
    triggerImmediateSync().catch(() => null);
  };

  const onEdit = (profileId: string) => {
    if (!state) return;
    const target = state.profiles.find((item) => item.id === profileId);
    if (!target) return;

    setProfileForm({
      id: target.id,
      name: target.name,
      avatarUri: target.avatarUri || '',
      enabled: target.enabled !== false,
      pinEnabled: target.pinEnabled,
      pin: target.pin,
      kidsMode: target.kidsMode,
      isPrimary: target.isPrimary === true,
    });
  };

  const onPickAvatar = async () => {
    if (!profileForm.id) {
      Alert.alert('Editar perfil', 'Abra um perfil em "Editar" para alterar a foto.');
      return;
    }

    try {
      const result = await pickSingleImageFromLibrary();

      if (result.canceled || !result.assets?.[0]?.uri) {
        console.log('[configuracoes-perfis][avatar-upload] seleção cancelada ou sem URI', {
          profileId: profileForm.id,
          canceled: !!result.canceled,
          hasAssetUri: !!result.assets?.[0]?.uri,
        });
        return;
      }

      const sourceUri = result.assets[0].uri;
      const optimizedUri = await optimizeAvatarImage(sourceUri);
      const remoteAvatarUri = await uploadProfileAvatarFromDevice(optimizedUri);
      console.log('[configuracoes-perfis][avatar-upload] imagem selecionada', {
        profileId: profileForm.id,
        sourceUri,
        optimizedUri,
        remoteAvatarUri,
      });

      // Evita payload base64 grande que pode causar travamentos ao voltar do crop.
      setProfileForm((prev) => ({ ...prev, avatarUri: remoteAvatarUri || optimizedUri }));

      // Persiste avatar imediatamente para refletir na lista e sincronizar API sem
      // depender do botão "Atualizar".
      const next = await runAction(() =>
        upsertProfile(
          {
            name: profileForm.name,
            avatarUri: remoteAvatarUri || optimizedUri,
            enabled: profileForm.enabled,
            pinEnabled: profileForm.pinEnabled,
            pin: profileForm.pin,
            kidsMode: profileForm.kidsMode,
            isPrimary: isPrimary ? profileForm.isPrimary : undefined,
          },
          profileForm.id
        )
      );
      if (next) {
        const refreshed = next.profiles.find((p) => p.id === profileForm.id);
        if (refreshed) {
          setProfileForm((prev) => ({
            ...prev,
            avatarUri: refreshed.avatarUri || remoteAvatarUri || optimizedUri,
            name: refreshed.name,
            enabled: refreshed.enabled !== false,
            pinEnabled: refreshed.pinEnabled,
            pin: refreshed.pin,
            kidsMode: refreshed.kidsMode,
            isPrimary: refreshed.isPrimary === true,
          }));
        }
      }
    } catch (error: any) {
      const code = String(error?.code || '').toUpperCase();
      const message = String(error?.message || error || '');
      const lowerMessage = message.toLowerCase();
      if (code.includes('CANCEL') || code.includes('NO_IMAGE') || code.includes('NO_DATA')) {
        console.log('[configuracoes-perfis][avatar-upload] cancelado/sem imagem', {
          profileId: profileForm.id,
          code: code || null,
          message,
        });
        return;
      }
      if (lowerMessage.includes('cancel') || lowerMessage.includes('no image') || lowerMessage.includes('no data')) {
        console.log('[configuracoes-perfis][avatar-upload] cancelado/sem imagem', {
          profileId: profileForm.id,
          code: code || null,
          message,
        });
        return;
      }
      if (String(error?.message || '').includes('PICKER_IN_PROGRESS')) {
        console.log('[configuracoes-perfis][avatar-upload] picker em andamento', {
          profileId: profileForm.id,
          code: code || null,
          message,
        });
        return;
      }
      if (String(error?.message || '').includes('CROP_UNAVAILABLE_RETRY')) {
        console.log('[configuracoes-perfis][avatar-upload] crop indisponivel, tente novamente', {
          profileId: profileForm.id,
          code: code || null,
          message,
          stack: error?.stack || null,
        });
        return;
      }
      if (String(error?.message || '').includes('PERMISSION_DENIED')) {
        console.log('[configuracoes-perfis][avatar-upload] permissao negada', {
          profileId: profileForm.id,
          code: code || null,
          message,
          stack: error?.stack || null,
        });
        return;
      }
      console.log('[configuracoes-perfis][avatar-upload] falha ao selecionar foto', {
        profileId: profileForm.id,
        code: code || null,
        message,
        stack: error?.stack || null,
      });
      return;
    }
  };

  const onDelete = (profileId: string) => {
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

  const onRequestActivate = (profile: Profile) => {
    if (profile.enabled === false) {
      Alert.alert('Perfil desativado', 'Ative este perfil para permitir acesso.');
      return;
    }

    if (!profile.pinEnabled) {
      void runAction(async () => {
        const next = await setActiveProfile(profile.id);
        await restoreLastCloudBackup().catch(() => null);
        await ensureRealtimeSessionForActiveProfile({ force: true });
        return next;
      });
      return;
    }

    setActivationTarget(profile);
    setActivationPin('');
  };

  const onConfirmActivateWithPin = async () => {
    if (!activationTarget) return;

    if (!activationPin.trim()) {
      Alert.alert('PIN obrigatorio', 'Digite o PIN para ativar este perfil.');
      return;
    }

    if (!verifyProfilePin(activationTarget, activationPin)) {
      Alert.alert('PIN incorreto', 'O PIN informado nao confere com este perfil.');
      return;
    }

    const next = await runAction(async () => {
      // Usa unlockProfileAccess para manter o estado de sessao autenticada por perfil.
      const result = await unlockProfileAccess(activationTarget.id, activationPin);
      if (!result.ok || !result.state) {
        throw new Error(result.message || 'Nao foi possivel ativar o perfil.');
      }
      await restoreLastCloudBackup().catch(() => null);
      await ensureRealtimeSessionForActiveProfile({ force: true });
      return result.state;
    });

    if (!next) return;
    setActivationTarget(null);
    setActivationPin('');
  };

  if (isLoading || !state) {
    return (
      <SafeAreaView style={styles.container}>
        <AppBackdrop blurIntensity={28} />
        <PageLoader visible label="Carregando perfis" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isSaving} label="Salvando perfil" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.kicker}>USUARIOS</Text>
            <Text style={styles.title}>Perfis</Text>
          </View>
          <View style={styles.iconBtn} />
        </View>

        {/* Formulario de novo perfil visivel apenas para o perfil principal.
            Perfis secundarios so verao o formulario de edicao do proprio perfil. */}
        {(isPrimary || !!profileForm.id) && (
        <PlanGateBlur feature="multi_user" locked={profileLocked} style={styles.card}>
          <View>
            <Text style={styles.sectionTitle}>{profileForm.id ? 'Editar perfil' : 'Novo perfil'}</Text>

            <View style={styles.avatarRow}>
              {profileForm.avatarUri ? (
                <Image source={{ uri: profileForm.avatarUri }} style={styles.avatar} cachePolicy="disk" />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                  <MaterialIcons name="person" size={36} color={StreamingTheme.colors.textMuted} />
                </View>
              )}
              <View style={{ flex: 1, gap: 8 }}>
                {!!profileForm.id && <ActionButton text="Upload da foto" icon="photo-library" onPress={onPickAvatar} />}
                {!!profileForm.id && !!profileForm.avatarUri && (
                  <ActionButton text="Remover foto" icon="delete" tone="muted" onPress={() => setProfileForm((prev) => ({ ...prev, avatarUri: '' }))} />
                )}
                {!profileForm.id && (
                  <Text style={styles.helperText}>Para trocar foto, primeiro toque em Editar no perfil desejado.</Text>
                )}
              </View>
            </View>

            <Field
              label="Nome do perfil"
              placeholder="Adulto, Filho, Visita"
              value={profileForm.name}
              onChangeText={(value) => setProfileForm((prev) => ({ ...prev, name: value }))}
            />

            <ToggleRow
              label="Perfil ativo"
              value={profileForm.enabled}
              onValueChange={(value) => setProfileForm((prev) => ({ ...prev, enabled: value }))}
            />

            <ToggleRow
              label="PIN por perfil"
              value={profileForm.pinEnabled}
              onValueChange={(value) => setProfileForm((prev) => ({ ...prev, pinEnabled: value }))}
            />

            {profileForm.pinEnabled && (
              <Field
                label="PIN"
                placeholder="Minimo 4 digitos"
                value={profileForm.pin}
                onChangeText={(value) => setProfileForm((prev) => ({ ...prev, pin: value.replace(/[^0-9]/g, '') }))}
                secureTextEntry
              />
            )}

            <ToggleRow
              label="Modo infantil"
              value={profileForm.kidsMode}
              onValueChange={(value) => setProfileForm((prev) => ({ ...prev, kidsMode: value }))}
            />

            {/* Perfil principal so pode ser alterado por quem ja e principal.
                Permite promover ou rebaixar qualquer perfil, desde que fique ao menos um principal. */}
            {isPrimary && (
              <ToggleRow
                label="Perfil principal (pode gerenciar outros perfis)"
                value={profileForm.isPrimary}
                onValueChange={(value) => setProfileForm((prev) => ({ ...prev, isPrimary: value }))}
              />
            )}

            <View style={styles.row}>
              <ActionButton text={profileForm.id ? 'Atualizar' : 'Adicionar'} icon="person-add" onPress={onSave} />
              {!!profileForm.id && <ActionButton text="Limpar" icon="close" onPress={() => setProfileForm(emptyProfileForm)} tone="muted" />}
            </View>
          </View>
        </PlanGateBlur>
        )}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Perfis cadastrados</Text>
          {state.profiles.map((item) => {
            const active = item.id === state.activeProfileId;
            return (
              <View key={item.id} style={[styles.rowCard, active && styles.rowCardActive]}>
                <View style={styles.listRowTop}>
                  {item.avatarUri ? (
                    <Image source={{ uri: item.avatarUri }} style={styles.listAvatar} cachePolicy="disk" />
                  ) : (
                    <View style={[styles.listAvatar, styles.avatarFallback]}>
                      <MaterialIcons name="person" size={18} color={StreamingTheme.colors.textMuted} />
                    </View>
                  )}
                  <View style={{ gap: 3, flex: 1 }}>
                  <Text style={styles.rowTitle}>
                    {item.name}{item.isPrimary ? ' ★' : ''}
                  </Text>
                  <Text style={styles.rowSub}>PIN: {item.pinEnabled ? 'Ativo' : 'Desligado'}</Text>
                  <Text style={styles.rowSub}>Infantil: {item.kidsMode ? 'Sim' : 'Nao'}</Text>
                  <Text style={styles.rowSub}>Status: {item.enabled === false ? 'Inativo' : 'Ativo'}</Text>
                  </View>
                </View>
                <View style={styles.actions}>
                  {!active && item.enabled !== false && <TinyAction text="Ativar" onPress={() => onRequestActivate(item)} />}
                  {!active && item.enabled === false && <TinyAction text="Inativo" onPress={() => onEdit(item.id)} />}
                  {/* Edicao: principal pode editar todos; secundario so edita o proprio */}
                  {(isPrimary || item.id === state.activeProfileId) && (
                    <TinyAction text="Editar" onPress={() => onEdit(item.id)} />
                  )}
                  {/* Exclusao: somente o perfil principal pode excluir outros */}
                  {isPrimary && (
                    <TinyAction text="Excluir" danger onPress={() => onDelete(item.id)} />
                  )}
                </View>
              </View>
            );
          })}
        </View>

        {activationTarget ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Confirmar ativacao de perfil</Text>
            <Text style={styles.helperText}>
              O perfil {activationTarget.name} esta protegido por PIN. Informe o PIN para ativar.
            </Text>
            <Field
              label="PIN do perfil"
              placeholder="Digite o PIN"
              value={activationPin}
              onChangeText={(value) => setActivationPin(value.replace(/[^0-9]/g, ''))}
              secureTextEntry
            />
            <View style={styles.row}>
              <ActionButton text="Confirmar ativacao" icon="lock-open" onPress={onConfirmActivateWithPin} />
              <ActionButton
                text="Cancelar"
                icon="close"
                tone="muted"
                onPress={() => {
                  setActivationTarget(null);
                  setActivationPin('');
                }}
              />
            </View>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Permissoes do controle parental</Text>
          {canConfigureParentalManagers ? (
            <View style={{ gap: 10 }}>
              {!managerCandidates.length ? (
                <Text style={styles.helperText}>Crie ao menos um perfil adulto secundario para delegar gerenciamento.</Text>
              ) : null}

              {managerCandidates.map((manager) => {
                const permission = readManagerPermission(manager.id);
                return (
                  <View key={`mgr-${manager.id}`} style={styles.managerCard}>
                    <View style={styles.toggleRow}>
                      <Text style={styles.toggleLabel}>Permitir {manager.name} acessar monitor parental</Text>
                      <Switch
                        value={permission.enabled}
                        onValueChange={(value) => onToggleManagerEnabled(manager.id, value)}
                        thumbColor={StreamingTheme.colors.textPrimary}
                        trackColor={{ false: 'rgba(255,255,255,0.2)', true: 'rgba(34,197,94,0.5)' }}
                      />
                    </View>

                    {permission.enabled ? (
                      <View style={styles.managerTargetsWrap}>
                        <Text style={styles.label}>Perfis infantis que {manager.name} pode gerenciar</Text>
                        {!manageableProfiles.length ? (
                          <Text style={styles.helperText}>Nenhum perfil infantil encontrado.</Text>
                        ) : null}
                        {manageableProfiles.map((target) => {
                          const checked = permission.managedProfileIds.includes(target.id);
                          return (
                            <TouchableOpacity
                              key={`mgr-${manager.id}-target-${target.id}`}
                              style={styles.managerTargetRow}
                              onPress={() => onToggleManagedProfile(manager.id, target.id, !checked)}
                            >
                              <MaterialIcons
                                name={checked ? 'check-circle' : 'radio-button-unchecked'}
                                size={18}
                                color={checked ? '#22C55E' : StreamingTheme.colors.textMuted}
                              />
                              <Text style={styles.managerTargetText}>{target.name}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : (
            <Text style={styles.helperText}>
              Somente o perfil principal pode configurar permissao de acesso ao monitor parental.
              {monitorAccess?.canAccess
                ? ' Seu perfil ja possui permissao para monitorar os perfis atribuidos.'
                : ''}
            </Text>
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
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  avatar: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
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
  helperText: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
  rowCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    padding: 10,
    gap: 8,
  },
  managerCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    padding: 10,
    gap: 8,
  },
  managerTargetsWrap: {
    gap: 6,
  },
  managerTargetRow: {
    minHeight: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.03)',
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  managerTargetText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  listRowTop: {
    flexDirection: 'row',
    gap: 10,
  },
  listAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  rowCardActive: {
    borderColor: 'rgba(255,59,48,0.55)',
    backgroundColor: 'rgba(255,59,48,0.16)',
  },
  rowTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 14,
  },
  rowSub: {
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
