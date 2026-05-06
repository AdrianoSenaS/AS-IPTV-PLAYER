import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

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
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackdrop } from '@/components/app-backdrop';
import { PageLoader } from '@/components/page-loader';
import { StreamingTheme } from '@/constants/streaming-theme';
import { loadAccountSettings, Profile, setActiveProfile as persistActiveProfile, upsertProfile } from '@/services/account-settings';
import { markProfileUnlocked } from '@/services/access-control';
import {
  clearAllLocalUserData,
  loadUserSession,
  uploadCurrentUserAvatarFromDevice,
  updateCurrentUserProfile,
  UserSession,
} from '@/services/cloud-sync';

type ProfileSummary = {
  activeServerName: string;
  activeProfileName: string;
  activeProfileAvatar: string;
  serverCount: number;
  profileCount: number;
};

const emptySummary: ProfileSummary = {
  activeServerName: 'Sem servidor',
  activeProfileName: 'Principal',
  activeProfileAvatar: '',
  serverCount: 0,
  profileCount: 0,
};

const AVATAR_MAX_SIZE = 720;

async function pickAccountAvatarFromLibrary(): Promise<string> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  const hasPermission = permission.granted || (permission as any).accessPrivileges === 'limited';
  if (!hasPermission) {
    throw new Error('PERMISSION_DENIED');
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.82,
  });

  if (result.canceled || !result.assets?.[0]?.uri) {
    throw new Error('PICKER_CANCELLED');
  }

  const sourceUri = String(result.assets[0].uri || '').trim();
  if (!sourceUri) {
    throw new Error('EMPTY_AVATAR_URI');
  }

  const normalized = await manipulateAsync(sourceUri, [], {
    compress: 1,
    format: SaveFormat.JPEG,
    base64: false,
  });

  const sourceWidth = Math.max(1, Number(normalized?.width || 0));
  const sourceHeight = Math.max(1, Number(normalized?.height || 0));
  const cropSide = Math.max(1, Math.min(sourceWidth, sourceHeight));
  const originX = Math.max(0, Math.floor((sourceWidth - cropSide) / 2));
  const originY = Math.max(0, Math.floor((sourceHeight - cropSide) / 2));

  const optimized = await manipulateAsync(
    normalized?.uri || sourceUri,
    [
      { crop: { originX, originY, width: cropSide, height: cropSide } },
      { resize: { width: AVATAR_MAX_SIZE, height: AVATAR_MAX_SIZE } },
    ],
    {
      compress: 0.78,
      format: SaveFormat.JPEG,
      base64: false,
    }
  );

  return String(optimized?.uri || sourceUri).trim();
}

const formatMemberSince = (value: string) => {
  if (!value) return 'Agora';

  try {
    return new Date(value).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return 'Agora';
  }
};

export default function ConfiguracoesContaScreen() {
  const router = useRouter();
  const hydratedOnceRef = useRef(false);

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loaderLabel, setLoaderLabel] = useState('Salvando perfil');
  const [session, setSession] = useState<UserSession | null>(null);
  const [summary, setSummary] = useState<ProfileSummary>(emptySummary);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [avatarUri, setAvatarUri] = useState('');
  const [avatarTimestamp, setAvatarTimestamp] = useState(0);
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileName, setProfileName] = useState('');
  const [profilePinEnabled, setProfilePinEnabled] = useState(false);
  const [profilePin, setProfilePin] = useState('');
  const isPrimaryProfile = activeProfile?.isPrimary === true;

  const hydrate = useCallback(async () => {
    if (!hydratedOnceRef.current) {
      setIsLoading(true);
    }

    try {
      const [nextSession, settings] = await Promise.all([loadUserSession(), loadAccountSettings()]);
      const activeServer = settings.servers.find((item) => item.id === settings.activeServerId);
      const activeProfile = settings.profiles.find((item) => item.id === settings.activeProfileId);

      setActiveProfile(activeProfile || null);
      setProfiles(settings.profiles || []);
      setProfileName(activeProfile?.name || '');
      setProfilePinEnabled(!!activeProfile?.pinEnabled);
      setProfilePin(activeProfile?.pin || '');
      setSession(nextSession);
      setName(nextSession?.user.name || '');
      setEmail(nextSession?.user.email || '');
      setAvatarUri(nextSession?.user.avatarUri || '');
      setSummary({
        activeServerName: activeServer?.name || 'Sem servidor',
        activeProfileName: activeProfile?.name || 'Principal',
        activeProfileAvatar: activeProfile?.avatarUri || '',
        serverCount: settings.servers.length,
        profileCount: settings.profiles.length,
      });
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
      const message = String(error?.message || error || '');
      if (message.includes('PICKER_CANCELLED')) {
        return;
      }
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel concluir a acao.'));
    } finally {
      setIsSaving(false);
    }
  };

  const syncActiveProfileAvatar = async (nextAvatarUri: string) => {
    if (!activeProfile?.id) {
      return nextAvatarUri;
    }

    const avatarForProfile = String(nextAvatarUri || '').trim();
    const nextSettings = await upsertProfile(
      {
        name: activeProfile.name,
        avatarUri: avatarForProfile,
        enabled: activeProfile.enabled !== false,
        pinEnabled: !!activeProfile.pinEnabled,
        pin: activeProfile.pin || '',
        kidsMode: !!activeProfile.kidsMode,
        isPrimary: activeProfile.isPrimary === true,
      },
      activeProfile.id
    );
    const refreshedActiveProfile =
      nextSettings.profiles.find((item) => item.id === nextSettings.activeProfileId) ||
      nextSettings.profiles.find((item) => item.id === activeProfile.id) ||
      null;

    setActiveProfile(refreshedActiveProfile);
    setProfiles(nextSettings.profiles || []);
    setSummary((prev) => ({
      ...prev,
      activeProfileName: refreshedActiveProfile?.name || prev.activeProfileName,
      activeProfileAvatar: refreshedActiveProfile?.avatarUri || avatarForProfile,
      profileCount: nextSettings.profiles.length,
    }));

    return refreshedActiveProfile?.avatarUri || avatarForProfile;
  };

  const onSaveProfile = async () => {
    if (!session) {
      router.push('/login');
      return;
    }

    if (!isPrimaryProfile) {
      Alert.alert('Conta vinculada', 'Apenas o perfil principal pode editar os dados da conta.');
      return;
    }

    await runAction(async () => {
      setLoaderLabel('Salvando perfil');
      const next = await updateCurrentUserProfile({
        name,
        email,
        avatarUri,
        avatarRemoteUri: session.user.avatarRemoteUri,
      });
      const syncedAvatarUri = await syncActiveProfileAvatar(
        next.user.avatarRemoteUri || next.user.avatarUri || avatarUri
      );
      setSession(next);
      setName(next.user.name);
      setEmail(next.user.email);
      setAvatarUri(next.user.avatarUri || '');
      setAvatarTimestamp(Date.now());
      setSummary((prev) => ({
        ...prev,
        activeProfileAvatar: syncedAvatarUri,
      }));
      Alert.alert('Perfil atualizado', 'As informacoes da sua conta foram salvas.');
    });
  };

  const onUploadAccountAvatar = async () => {
    if (!session) {
      router.push('/login');
      return;
    }

    if (!isPrimaryProfile) {
      Alert.alert('Conta vinculada', 'Apenas o perfil principal pode alterar a foto da conta.');
      return;
    }

    await runAction(async () => {
      setLoaderLabel('Enviando foto da conta');
      const localAvatar = await pickAccountAvatarFromLibrary();
      const nextSession = await uploadCurrentUserAvatarFromDevice(localAvatar);
      const syncedAvatarUri = await syncActiveProfileAvatar(
        nextSession.user.avatarRemoteUri || nextSession.user.avatarUri || localAvatar
      );
      setSession(nextSession);
      setAvatarUri(nextSession.user.avatarUri || localAvatar);
      setAvatarTimestamp(Date.now());
      setSummary((prev) => ({
        ...prev,
        activeProfileAvatar: syncedAvatarUri,
      }));
    });
  };

  const onSwitchProfile = async (profile: Profile) => {
    if (!profile?.id || profile.enabled === false) return;
    if (activeProfile?.id === profile.id) return;

    if (profile.pinEnabled) {
      Alert.alert(
        'Perfil protegido por PIN',
        'Para trocar para este perfil, use a tela de selecao de perfil e informe o PIN.',
        [
          { text: 'Cancelar', style: 'cancel' },
          { text: 'Abrir selecao', onPress: () => router.push('/perfil-acesso') },
        ]
      );
      return;
    }

    await runAction(async () => {
      setLoaderLabel('Trocando perfil ativo');
      await persistActiveProfile(profile.id);
      await markProfileUnlocked(profile.id);
      await hydrate();
    });
  };

  const onSaveActiveProfileSettings = async () => {
    if (!activeProfile?.id) {
      Alert.alert('Perfil', 'Perfil ativo nao encontrado.');
      return;
    }

    const safeName = String(profileName || '').trim();
    if (!safeName) {
      Alert.alert('Perfil', 'Digite um nome para o perfil.');
      return;
    }

    if (profilePinEnabled && String(profilePin || '').trim().length < 4) {
      Alert.alert('PIN', 'O PIN deve ter pelo menos 4 digitos.');
      return;
    }

    await runAction(async () => {
      setLoaderLabel('Salvando perfil atual');
      await upsertProfile(
        {
          name: safeName,
          avatarUri: activeProfile.avatarUri || '',
          enabled: activeProfile.enabled !== false,
          pinEnabled: profilePinEnabled,
          pin: profilePinEnabled ? String(profilePin || '').trim() : '',
          kidsMode: !!activeProfile.kidsMode,
          isPrimary: activeProfile.isPrimary === true,
        },
        activeProfile.id
      );
      await hydrate();
      Alert.alert('Perfil atualizado', 'Nome e configuracao de PIN salvos com sucesso.');
    });
  };

  const onLogout = async () => {
    await runAction(async () => {
      setLoaderLabel('Saindo da conta');
      await clearAllLocalUserData();
      setSession(null);
      setName('');
      setEmail('');
      setAvatarUri('');
      router.replace('/login');
    });
  };

  const renderAvatar = (size: number) => {
    // Prioridade: summary (sincronizado com perfil) → avatarUri (estado local)
    let source = summary.activeProfileAvatar || avatarUri;
    
    if (!source) {
      // Sem imagem: renderizar fallback
      return (
        <View
          style={[styles.avatar, styles.avatarFallback, { width: size, height: size, borderRadius: size / 2 }]}
        >
          <MaterialIcons name="person" size={size * 0.42} color={StreamingTheme.colors.textMuted} />
        </View>
      );
    }
    
    // Cache busting: adiciona timestamp para URLs remotas
    if (/^https?:\/\//i.test(source)) {
      const separator = source.includes('?') ? '&' : '?';
      // Usa avatarTimestamp se disponível, senão usa Date.now() para cache sempre recente
      const cacheTimestamp = avatarTimestamp > 0 ? avatarTimestamp : Date.now();
      source = `${source}${separator}t=${cacheTimestamp}`;
    }
    
    return (
      <Image
        source={{ uri: source }}
        style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}
        cachePolicy="none"
      />
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isLoading || isSaving} label={isLoading ? 'Carregando perfil' : loaderLabel} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.kicker}>MINHA CONTA</Text>
            <Text style={styles.title}>Conta e Usuario</Text>
          </View>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.push('/configuracoes')}>
            <MaterialIcons name="settings" size={20} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
        </View>

        <View style={styles.heroCard}>
          <LinearGradient
            colors={['#FF7A18', '#D81B60', '#151A2F']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.heroBanner}
          />
          <View style={styles.heroContent}>
            <TouchableOpacity
              activeOpacity={0.88}
              onPress={() => {
                if (session && isPrimaryProfile) {
                  void onUploadAccountAvatar();
                  return;
                }
                router.push('/perfil-acesso');
              }}
              style={styles.avatarWrap}>
              {renderAvatar(92)}
              <View style={styles.avatarAction}>
                <MaterialIcons
                  name={session ? (isPrimaryProfile ? 'photo-camera' : 'manage-accounts') : 'login'}
                  size={16}
                  color={StreamingTheme.colors.textPrimary}
                />
              </View>
            </TouchableOpacity>

            <View style={styles.heroTextWrap}>
              <Text style={styles.heroName}>{summary.activeProfileName || 'Seu perfil no app'}</Text>
              <Text style={styles.heroEmail}>
                {session?.user.email || 'Entre para salvar foto, perfil e backup da conta.'}
              </Text>
              <Text style={styles.heroMeta}>
                {session
                  ? `Perfil ativo vinculado a ${session.user.email}`
                  : 'Sem login ativo'}
              </Text>
              {session && (
                <Text style={styles.heroMetaMuted}>
                  {isPrimaryProfile
                    ? 'Perfil principal: pode editar conta e gerenciar perfis.'
                    : 'Perfil secundario: pode apenas visualizar dados da conta vinculada.'}
                </Text>
              )}
            </View>
          </View>

          <View style={styles.statRow}>
            <StatPill label="Servidores" value={String(summary.serverCount)} />
            <StatPill label="Perfis" value={String(summary.profileCount)} />
            <StatPill label="Perfil ativo" value={summary.activeProfileName} compact />
          </View>
        </View>

        {!session ? (
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Entre ou cadastre-se</Text>
            <Text style={styles.panelText}>
              Esta area agora mostra apenas o acesso da conta. O login Xtream fica separado, evitando misturar conta do app com dados do servidor.
            </Text>

            <TouchableOpacity style={styles.primaryButton} onPress={() => router.push('/login')}>
              <MaterialIcons name="login" size={18} color={StreamingTheme.colors.textPrimary} />
              <Text style={styles.primaryButtonText}>Entrar</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.secondaryButton} onPress={() => router.push('/xtream-login')}>
              <MaterialIcons name="tv" size={18} color={StreamingTheme.colors.textPrimary} />
              <Text style={styles.secondaryButtonText}>Entrar com Xtream Code</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.secondaryButton} onPress={() => router.push('/cadastrar')}>
              <MaterialIcons name="person-add" size={18} color={StreamingTheme.colors.textPrimary} />
              <Text style={styles.secondaryButtonText}>Cadastrar</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.panel}>
              <Text style={styles.panelTitle}>Perfil atual</Text>
              <Text style={styles.panelText}>
                Ajuste rapidamente o nome e a protecao por PIN do perfil que esta logado.
              </Text>

              <ProfileField
                label="Nome do perfil"
                placeholder="Nome de exibicao"
                value={profileName}
                onChangeText={setProfileName}
              />

              <View style={styles.pinToggleRow}>
                <View style={styles.pinToggleTextWrap}>
                  <Text style={styles.pinToggleTitle}>PIN do perfil</Text>
                  <Text style={styles.pinToggleDescription}>
                    {profilePinEnabled ? 'Protecao ativa para entrar neste perfil.' : 'Sem PIN para entrar neste perfil.'}
                  </Text>
                </View>
                <Switch
                  value={profilePinEnabled}
                  onValueChange={setProfilePinEnabled}
                  thumbColor={StreamingTheme.colors.textPrimary}
                  trackColor={{ false: 'rgba(255,255,255,0.22)', true: 'rgba(255,122,24,0.56)' }}
                />
              </View>

              {profilePinEnabled ? (
                <ProfileField
                  label="PIN do perfil"
                  placeholder="Minimo 4 digitos"
                  value={profilePin}
                  onChangeText={(value) => setProfilePin(value.replace(/[^0-9]/g, ''))}
                />
              ) : null}

              <TouchableOpacity style={styles.primaryButton} onPress={() => void onSaveActiveProfileSettings()}>
                <MaterialIcons name="save" size={18} color={StreamingTheme.colors.textPrimary} />
                <Text style={styles.primaryButtonText}>Salvar perfil atual</Text>
              </TouchableOpacity>
            </View>

            {isPrimaryProfile ? (
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Perfis do app</Text>
                <Text style={styles.panelText}>
                  Troque rapidamente o perfil ativo e abra o gerenciamento completo de perfis.
                </Text>
                <View style={styles.profileSwitchGrid}>
                  {profiles.map((profile) => {
                    const isActive = profile.id === activeProfile?.id;
                    const disabled = profile.enabled === false;
                    return (
                      <TouchableOpacity
                        key={profile.id}
                        style={[
                          styles.profileSwitchBtn,
                          isActive && styles.profileSwitchBtnActive,
                          disabled && styles.profileSwitchBtnDisabled,
                        ]}
                        disabled={disabled}
                        onPress={() => {
                          void onSwitchProfile(profile);
                        }}>
                        <Text style={[styles.profileSwitchName, isActive && styles.profileSwitchNameActive]} numberOfLines={1}>
                          {profile.name}
                        </Text>
                        <Text style={styles.profileSwitchMeta}>
                          {disabled
                            ? 'Inativo'
                            : profile.pinEnabled
                              ? 'PIN'
                              : isActive
                                ? 'Ativo'
                                : 'Toque para usar'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <TouchableOpacity style={styles.primaryButton} onPress={() => router.push('/configuracoes-perfis')}>
                  <MaterialIcons name="manage-accounts" size={18} color={StreamingTheme.colors.textPrimary} />
                  <Text style={styles.primaryButtonText}>Gerenciar perfis</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Conta vinculada</Text>
                <View style={styles.lockedHintCard}>
                  <MaterialIcons name="lock" size={16} color={StreamingTheme.colors.textMuted} />
                  <Text style={styles.lockedHintText}>
                    Este perfil apenas visualiza as informações da conta vinculada. Alterações e gestão de perfis são permitidas somente ao perfil principal.
                  </Text>
                </View>
              </View>
            )}

            <View style={styles.panel}>
              <Text style={styles.panelTitle}>Conta vinculada ao perfil</Text>
              {isPrimaryProfile ? (
                <>
                  <ProfileField label="Nome" placeholder="Seu nome" value={name} onChangeText={setName} />
                  <ProfileField
                    label="E-mail"
                    placeholder="voce@email.com"
                    value={email}
                    onChangeText={setEmail}
                    keyboardType="email-address"
                  />
                  <TouchableOpacity style={styles.secondaryButton} onPress={() => void onUploadAccountAvatar()}>
                    <MaterialIcons name="photo-camera" size={18} color={StreamingTheme.colors.textPrimary} />
                    <Text style={styles.secondaryButtonText}>Upload da foto da conta</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <InfoChip icon="person" label={`Nome vinculado: ${name || '-'}`} />
                  <InfoChip icon="email" label={`E-mail vinculado: ${email || '-'}`} />
                </>
              )}

              <View style={styles.inlineInfoRow}>
                <InfoChip icon="dns" label={`Servidor ativo: ${summary.activeServerName}`} />
                <InfoChip icon="groups" label={`Perfil ativo: ${summary.activeProfileName}`} />
                {activeProfile?.kidsMode ? <InfoChip icon="child-care" label="Modo infantil ativo" /> : null}
              </View>

              <View style={styles.actionRow}>
                {isPrimaryProfile ? (
                  <TouchableOpacity style={styles.primaryButtonCompact} onPress={onSaveProfile}>
                    <MaterialIcons name="save" size={18} color={StreamingTheme.colors.textPrimary} />
                    <Text style={styles.primaryButtonText}>Salvar conta</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity style={styles.secondaryButtonCompact} onPress={onLogout}>
                  <MaterialIcons name="logout" size={18} color={StreamingTheme.colors.textPrimary} />
                  <Text style={styles.secondaryButtonText}>Sair</Text>
                </TouchableOpacity>
              </View>
            </View>

            {isPrimaryProfile ? (
            <View style={styles.shortcutGrid}>
              <ShortcutCard
                icon="dns"
                title="Servidores Xtream"
                subtitle="Gerencie URL, usuario e protocolo"
                onPress={() => router.push('/configuracoes-servidores')}
              />
              <ShortcutCard
                icon="backup"
                title="Backup"
                subtitle="Sincronize listas e progresso"
                onPress={() => router.push('/configuracoes-backup')}
              />
              <ShortcutCard
                icon="shield"
                title="Controle dos pais"
                subtitle="PIN, filtros e protecao"
                onPress={() => router.push('/configuracoes-parental')}
              />
              <ShortcutCard
                icon="settings"
                title="Mais ajustes"
                subtitle="Abra o hub completo de configuracoes"
                onPress={() => router.push('/configuracoes')}
              />
            </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function StatPill({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <View style={[styles.statPill, compact && styles.statPillCompact]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.statValue}>
        {value}
      </Text>
    </View>
  );
}

function InfoChip({ icon, label }: { icon: keyof typeof MaterialIcons.glyphMap; label: string }) {
  return (
    <View style={styles.infoChip}>
      <MaterialIcons name={icon} size={16} color={StreamingTheme.colors.accentAlt} />
      <Text style={styles.infoChipText}>{label}</Text>
    </View>
  );
}

function ShortcutCard({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: keyof typeof MaterialIcons.glyphMap;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.shortcutCard} activeOpacity={0.88} onPress={onPress}>
      <View style={styles.shortcutIcon}>
        <MaterialIcons name={icon} size={22} color={StreamingTheme.colors.textPrimary} />
      </View>
      <Text style={styles.shortcutTitle}>{title}</Text>
      <Text style={styles.shortcutSubtitle}>{subtitle}</Text>
    </TouchableOpacity>
  );
}

function ProfileField({
  label,
  placeholder,
  value,
  onChangeText,
  keyboardType = 'default',
}: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  keyboardType?: 'default' | 'email-address';
}) {
  return (
    <View>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        placeholder={placeholder}
        placeholderTextColor={StreamingTheme.colors.textMuted}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        keyboardType={keyboardType}
      />
    </View>
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
    gap: 14,
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
  },
  heroCard: {
    overflow: 'hidden',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(16,22,40,0.94)',
  },
  heroBanner: {
    height: 118,
  },
  heroContent: {
    marginTop: -42,
    paddingHorizontal: 16,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 14,
  },
  avatarWrap: {
    position: 'relative',
  },
  avatar: {
    borderWidth: 3,
    borderColor: 'rgba(12,16,28,0.95)',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarAction: {
    position: 'absolute',
    right: 2,
    bottom: 4,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#FF7A18',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(12,16,28,0.95)',
  },
  heroTextWrap: {
    flex: 1,
    gap: 3,
    paddingBottom: 4,
  },
  heroName: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 24,
    fontWeight: '900',
  },
  heroEmail: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
  },
  heroMeta: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  heroMetaMuted: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 11,
    marginTop: 1,
  },
  statRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  statPill: {
    flex: 1,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 2,
  },
  statPillCompact: {
    flex: 1.2,
  },
  statLabel: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  statValue: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  panel: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(18,24,40,0.9)',
    padding: 16,
    gap: 12,
  },
  panelTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '900',
  },
  panelText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  primaryButton: {
    minHeight: 52,
    borderRadius: 16,
    backgroundColor: '#FF7A18',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  primaryButtonCompact: {
    flex: 1,
    minHeight: 50,
    borderRadius: 14,
    backgroundColor: '#FF7A18',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  primaryButtonText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  secondaryButton: {
    minHeight: 52,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  secondaryButtonCompact: {
    flex: 1,
    minHeight: 50,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  secondaryButtonText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  fieldLabel: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
  },
  fieldInput: {
    minHeight: 50,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    color: StreamingTheme.colors.textPrimary,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  inlineInfoRow: {
    gap: 10,
  },
  profileSwitchGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  profileSwitchBtn: {
    minWidth: '47%',
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 2,
  },
  profileSwitchBtnActive: {
    borderColor: 'rgba(255,122,24,0.62)',
    backgroundColor: 'rgba(255,122,24,0.18)',
  },
  profileSwitchBtnDisabled: {
    opacity: 0.5,
  },
  profileSwitchName: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 13,
  },
  profileSwitchNameActive: {
    color: '#FFD8C2',
  },
  profileSwitchMeta: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  pinToggleRow: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  pinToggleTextWrap: {
    flex: 1,
    gap: 2,
  },
  pinToggleTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
  },
  pinToggleDescription: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
  },
  lockedHintCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  lockedHintText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    flex: 1,
  },
  infoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  infoChipText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
    flex: 1,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  shortcutGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  shortcutCard: {
    width: '48%',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(18,24,40,0.9)',
    padding: 14,
    gap: 10,
  },
  shortcutIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: 'rgba(255,122,24,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shortcutTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  shortcutSubtitle: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
});