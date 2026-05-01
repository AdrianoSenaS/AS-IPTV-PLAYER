import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
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

import { PageLoader } from '@/components/page-loader';
import { AppBackdrop } from '@/components/app-backdrop';
import { PlanGateBlur } from '@/components/plan-gate-blur';
import { StreamingTheme } from '@/constants/streaming-theme';
import { usePlanGate } from '@/hooks/use-plan-gate';
import {
  AccountSettingsState,
  loadAccountSettings,
  removeProfile,
  setActiveProfile,
  upsertProfile,
} from '@/services/account-settings';

const emptyProfileForm = {
  id: '',
  name: '',
  avatarUri: '',
  pinEnabled: false,
  pin: '',
  kidsMode: false,
};

export default function ConfiguracoesPerfisScreen() {
  const router = useRouter();
  const { hasFeature, loading: planLoading } = usePlanGate();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [state, setState] = useState<AccountSettingsState | null>(null);
  const [profileForm, setProfileForm] = useState(emptyProfileForm);

  // Locked: pode ver/gerenciar perfil existente, mas precisa de plano para adicionar mais.
  const profileLocked = !planLoading && !hasFeature('multi_user') && !profileForm.id;

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

  const onSave = async () => {
    const next = await runAction(() =>
      upsertProfile(
        {
          name: profileForm.name,
          avatarUri: profileForm.avatarUri,
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

  const onEdit = (profileId: string) => {
    if (!state) return;
    const target = state.profiles.find((item) => item.id === profileId);
    if (!target) return;

    setProfileForm({
      id: target.id,
      name: target.name,
      avatarUri: target.avatarUri || '',
      pinEnabled: target.pinEnabled,
      pin: target.pin,
      kidsMode: target.kidsMode,
    });
  };

  const onPickAvatar = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permissao necessaria', 'Permita acesso a galeria para enviar foto do perfil.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      quality: 0.8,
      aspect: [1, 1],
    });

    if (result.canceled || !result.assets?.[0]?.uri) {
      return;
    }

    setProfileForm((prev) => ({ ...prev, avatarUri: result.assets[0].uri }));
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
                <ActionButton text="Upload da foto" icon="photo-library" onPress={onPickAvatar} />
                {!!profileForm.avatarUri && (
                  <ActionButton text="Remover foto" icon="delete" tone="muted" onPress={() => setProfileForm((prev) => ({ ...prev, avatarUri: '' }))} />
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

            <View style={styles.row}>
              <ActionButton text={profileForm.id ? 'Atualizar' : 'Adicionar'} icon="person-add" onPress={onSave} />
              {!!profileForm.id && <ActionButton text="Limpar" icon="close" onPress={() => setProfileForm(emptyProfileForm)} tone="muted" />}
            </View>
          </View>
        </PlanGateBlur>

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
                  <Text style={styles.rowTitle}>{item.name}</Text>
                  <Text style={styles.rowSub}>PIN: {item.pinEnabled ? 'Ativo' : 'Desligado'}</Text>
                  <Text style={styles.rowSub}>Infantil: {item.kidsMode ? 'Sim' : 'Nao'}</Text>
                  </View>
                </View>
                <View style={styles.actions}>
                  {!active && <TinyAction text="Ativar" onPress={() => runAction(() => setActiveProfile(item.id))} />}
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
  rowCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    padding: 10,
    gap: 8,
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
