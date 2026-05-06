import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { getDbValue } from '@/services/local-db';
import { hasLocalCatalogDataQuick } from '@/services/catalog-data';

import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  findNodeHandle,
  KeyboardAvoidingView,
  Platform,
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
import { StreamingTheme } from '@/constants/streaming-theme';
import { loadAccountSettings, Profile, setActiveProfile, upsertProfile } from '@/services/account-settings';
import { shouldShowAlgorithmOnboarding } from '@/services/behavior-intelligence';
import { loadUserSession, restoreLastCloudBackup, uploadProfileAvatarFromDevice } from '@/services/cloud-sync';
import { isDemoModeEnabled } from '@/services/demo-mode';
import {
  getRememberedProfileId,
  isProfileTrusted,
  markProfileUnlocked,
  saveProfileAccessPreferences,
  unlockProfileAccess,
} from '@/services/access-control';
import { startSession } from '@/services/realtime-presence';
import { getHomeRouteForDevice, isNonMobileDevice } from '@/services/device-profile';

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
    // Evita relancar o seletor na mesma tentativa (loop de volta para galeria).
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

export default function PerfilAcessoScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ next?: string }>();
  const isLargeDevice = isNonMobileDevice();
  const homeRoute = getHomeRouteForDevice();
  const [isLoading, setIsLoading] = useState(true);
  const [isEntering, setIsEntering] = useState(false);
  const [loaderLabel, setLoaderLabel] = useState('Sincronizando servidor e perfil');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [pin, setPin] = useState('');
  const [rememberProfile, setRememberProfile] = useState(false);
  const [trustPin, setTrustPin] = useState(false);
  const [focusedItem, setFocusedItem] = useState('');
  const [pinFocused, setPinFocused] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const pinInputRef = useRef<TextInput>(null);
  const profileTapRefs = useRef<Array<React.ElementRef<typeof TouchableOpacity> | null>>([]);
  const createProfileRef = useRef<React.ElementRef<typeof TouchableOpacity>>(null);
  const enterProfileBtnRef = useRef<React.ElementRef<typeof TouchableOpacity>>(null);
  const trustPinRef = useRef<React.ElementRef<typeof TouchableOpacity>>(null);
  const rememberProfileRef = useRef<React.ElementRef<typeof TouchableOpacity>>(null);
  const xtreamBtnRef = useRef<React.ElementRef<typeof TouchableOpacity>>(null);
  const tvGridColumns = 4;

  const selectedProfile = useMemo(
    () => profiles.find((item) => item.id === selectedProfileId),
    [profiles, selectedProfileId]
  );
  const rawNextFlow = String(params?.next || '').trim();
  const nextFlow =
    rawNextFlow === 'loading' ? 'loading' : rawNextFlow === 'tv-home' ? 'tv-home' : 'home';
  const selectedGridIndex = useMemo(
    () => profiles.findIndex((item) => item.id === selectedProfileId),
    [profiles, selectedProfileId]
  );
  const getHandle = useCallback((node: unknown) => findNodeHandle(node as any) ?? undefined, []);
  const getGridItemHandle = useCallback(
    (index: number) => {
      if (index === profiles.length) {
        return getHandle(createProfileRef.current);
      }
      return getHandle(profileTapRefs.current[index]);
    },
    [getHandle, profiles.length]
  );
  const firstActionHandle = selectedProfile?.pinEnabled
    ? getHandle(pinInputRef.current)
    : getHandle(rememberProfileRef.current);

  useEffect(() => {
    const hydrateSelectionPrefs = async () => {
      if (!selectedProfileId) {
        setRememberProfile(false);
        setTrustPin(false);
        return;
      }

      const [rememberedId, trusted] = await Promise.all([
        getRememberedProfileId(),
        isProfileTrusted(selectedProfileId),
      ]);

      setRememberProfile(rememberedId === selectedProfileId);
      setTrustPin(trusted);
    };

    void hydrateSelectionPrefs();
  }, [selectedProfileId]);

  const refreshProfilesList = useCallback(() => {
    const loadProfiles = async () => {
      try {
        const settings = await loadAccountSettings();
        const availableProfiles = settings.profiles || [];
        const enabledProfiles = availableProfiles.filter((item) => item.enabled !== false);
        setProfiles(enabledProfiles);
      } catch (error) {
        console.error('[perfil-acesso][refresh] falha ao carregar perfis', error);
      }
    };
    loadProfiles();
  }, []);

  useFocusEffect(
    useCallback(() => {
      // Recarrega lista de perfis quando a tela volta ao foco
      // Isso garante que fotos atualizadas apareçam
      refreshProfilesList();
    }, [refreshProfilesList])
  );

  useEffect(() => {
    // Otimização: carrega perfis, sessão e demo em paralelo, restore em background
    const bootstrap = async () => {
      setIsLoading(true);
      try {
        const [username, session, isDemo] = await Promise.all([
          getDbValue<string>('username'),
          loadUserSession(),
          isDemoModeEnabled(),
        ]);
        let settings = await loadAccountSettings();
        // Restore backup em background, não trava UI
        if (session?.token) {
          restoreLastCloudBackup().catch(() => null);
          // settings atualizado só depois do restore, mas não bloqueia seleção inicial
        }
        if (!username && !isDemo) {
          router.replace('/login');
          return;
        }
        const availableProfiles = settings.profiles || [];
        const enabledProfiles = availableProfiles.filter((item) => item.enabled !== false);
        if (!enabledProfiles.length) {
          Alert.alert('Acesso bloqueado', 'Todos os perfis estao desativados. Faca login novamente.');
          router.replace('/login');
          return;
        }
        setProfiles(enabledProfiles);
        const preferredId = enabledProfiles.some((item) => item.id === settings.activeProfileId)
          ? settings.activeProfileId
          : enabledProfiles[0]?.id || '';
        setSelectedProfileId(preferredId);
      } finally {
        setIsLoading(false);
      }
    };
    bootstrap();
  }, [router]);

  const openApp = async (profileId: string, profilePin: string) => {
    if (!profileId) {
      Alert.alert('Perfil', 'Selecione um perfil para continuar.');
      return;
    }

    setLoaderLabel('Sincronizando servidor e perfil');
    setIsEntering(true);
    try {
      const result = await unlockProfileAccess(profileId, profilePin);
      if (!result.ok) {
        Alert.alert('Acesso negado', result.message || 'Nao foi possivel liberar o perfil.');
        return;
      }

      setLoaderLabel('Atualizando dados do perfil');
      await restoreLastCloudBackup().catch(() => null);

      // Reafirma o perfil selecionado apos restore remoto para evitar divergencia
      // entre activeProfileId e session.profile.authProfileId (causa loop de volta
      // para a tela de selecao em alguns dispositivos).
      const refreshedState = await loadAccountSettings();
      const refreshedTarget = refreshedState.profiles.find((p) => p.id === profileId && p.enabled !== false);
      if (refreshedTarget && refreshedState.activeProfileId !== profileId) {
        await setActiveProfile(profileId).catch(() => null);
      }
      await markProfileUnlocked(profileId).catch(() => null);

      const latestState = await loadAccountSettings();
      const profile = latestState.profiles.find((p) => p.id === profileId);
      if (profile && !isLargeDevice) {
        const username = await getDbValue<string>('username');
        const serverUrl = await getDbValue<string>('url');
        if (username) {
          const rt = await startSession({
            username,
            serverUrl: serverUrl || '',
            profileId: profile.id,
            profileName: profile.name,
            kidsMode: !!profile.kidsMode,
          });
          if (!rt.ok && rt.locked) {
            Alert.alert('Perfil em uso', rt.message);
            return;
          }
        }
      }

      await saveProfileAccessPreferences({
        profileId,
        rememberProfile,
        trustPin: !!profile?.pinEnabled && (trustPin || (await isProfileTrusted(profileId))),
      });

      const shouldOpenIaSetup = !isLargeDevice && (await shouldShowAlgorithmOnboarding());
      if (shouldOpenIaSetup) {
        router.replace({ pathname: '/algoritmo-preferencias', params: { next: 'perfil-acesso', entry: nextFlow } });
        return;
      }

      if (nextFlow === 'loading') {
        router.replace({ pathname: '/loading', params: { from: 'profile' } });
        return;
      }

      // Fluxo de inicio: so cai no loading se ainda nao houver catalogo local.
      const hasLocalData = await hasLocalCatalogDataQuick();
      if (hasLocalData || nextFlow === 'home' || nextFlow === 'tv-home') {
        router.replace(homeRoute as any);
      } else {
        router.replace({ pathname: '/loading', params: { from: 'profile' } });
      }
    } finally {
      setIsEntering(false);
    }
  };

  const onSelectProfile = async (profile: Profile) => {
    if (profile.enabled === false) {
      Alert.alert('Perfil desativado', 'Este perfil esta desativado no momento.');
      return;
    }

    setSelectedProfileId(profile.id);
    setPin('');

    // Auto-entrar sem PIN apenas se:
    // 1. O perfil nao tem PIN habilitado, OU
    // 2. O perfil e confiavel E e o perfil lembrado neste aparelho.
    //    (Confiavel sem ser lembrado = outro usuario pode entrar sem PIN —
    //     exige PIN para garantir que quem selecionou conhece a senha.)
    const [trusted, rememberedId] = await Promise.all([
      isProfileTrusted(profile.id),
      getRememberedProfileId(),
    ]);
    const autoEnter = !profile.pinEnabled || (trusted && rememberedId === profile.id);
    if (autoEnter) {
      await openApp(profile.id, '');
      return;
    }

    if (profile.pinEnabled) {
      setTimeout(() => {
        scrollRef.current?.scrollToEnd({ animated: true });
        pinInputRef.current?.focus();
      }, 180);
    }
  };

  const persistProfileAvatar = async (profile: Profile, nextAvatarUri: string) => {
    setLoaderLabel('Atualizando foto do perfil');
    setIsEntering(true);
    try {
      const shouldUploadAvatar = !!nextAvatarUri && !/^https?:\/\//i.test(nextAvatarUri);
      const avatarUriForSave = shouldUploadAvatar
        ? await uploadProfileAvatarFromDevice(nextAvatarUri)
        : nextAvatarUri;

      const next = await upsertProfile(
        {
          name: profile.name,
          avatarUri: avatarUriForSave,
          pinEnabled: profile.pinEnabled,
          pin: profile.pin,
          kidsMode: profile.kidsMode,
        },
        profile.id
      );
      setProfiles(next.profiles);
      setSelectedProfileId(next.activeProfileId || profile.id);
    } catch (error: any) {
      console.error('[perfil-acesso][avatar-upload] falha ao persistir foto do perfil', {
        profileId: profile.id,
        profileName: profile.name,
        nextAvatarUri,
        message: String(error?.message || error || ''),
        stack: error?.stack || null,
      });
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel atualizar a foto deste perfil.'));
    } finally {
      setIsEntering(false);
    }
  };

  const onPickExistingProfileAvatar = async (profile: Profile) => {
    try {
      const result = await pickSingleImageFromLibrary();

      if (result.canceled || !result.assets?.[0]?.uri) {
        return;
      }

      const nextAvatarUri = await optimizeAvatarImage(result.assets[0].uri);
      await persistProfileAvatar(profile, nextAvatarUri);
    } catch (error: any) {
      const code = String(error?.code || '').toUpperCase();
      const message = String(error?.message || error || '');
      const lowerMessage = message.toLowerCase();
      if (code.includes('CANCEL') || code.includes('NO_IMAGE') || code.includes('NO_DATA')) {
        return;
      }
      if (lowerMessage.includes('cancel') || lowerMessage.includes('no image') || lowerMessage.includes('no data')) {
        return;
      }
      if (String(error?.message || '').includes('PICKER_IN_PROGRESS')) {
        return;
      }
      if (String(error?.message || '').includes('CROP_UNAVAILABLE_RETRY')) {
        Alert.alert('Foto do perfil', 'Seu aparelho falhou no recorte nativo. Toque novamente para selecionar a imagem sem crop.');
        return;
      }
      if (String(error?.message || '').includes('PERMISSION_DENIED')) {
        Alert.alert('Permissao necessaria', 'Permita acesso a galeria para escolher a foto do perfil.');
        return;
      }
      console.error('[perfil-acesso][avatar-upload] falha ao selecionar foto para perfil existente', {
        profileId: profile.id,
        profileName: profile.name,
        code: code || null,
        message,
        stack: error?.stack || null,
      });
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel selecionar a foto.'));
    }
  };

  const onEditExistingProfileAvatar = (profile: Profile) => {
    if (!profile.avatarUri) {
      void onPickExistingProfileAvatar(profile);
      return;
    }

    Alert.alert('Foto do perfil', `Alterar foto de ${profile.name}?`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Trocar foto',
        onPress: () => {
          void onPickExistingProfileAvatar(profile);
        },
      },
      {
        text: 'Remover foto',
        style: 'destructive',
        onPress: () => {
          void persistProfileAvatar(profile, '');
        },
      },
    ]);
  };

  if (isLoading) {
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
      <PageLoader visible={isEntering} label={loaderLabel} />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 14 : 0}
        style={styles.keyboardWrap}
      >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[styles.content, isLargeDevice && stylesTv.content]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.kicker}>Quem vai assistir?</Text>
        <Text style={[styles.title, isLargeDevice && stylesTv.title]}>Escolha o perfil</Text>
        <Text style={[styles.subtitle, isLargeDevice && stylesTv.subtitle]}>Toque no perfil para entrar. Perfis com PIN pedem senha. Perfis sem PIN entram direto.</Text>

        <View style={[styles.grid, isLargeDevice && stylesTv.grid]}>
          {profiles.map((profile, index) => {
            const active = profile.id === selectedProfileId;
            const profileFocusKey = `profile-${profile.id}`;
            const gridItemsCount = profiles.length + 1;
            const leftIndex = index % tvGridColumns === 0 ? index : index - 1;
            const rightIndex =
              index % tvGridColumns === tvGridColumns - 1 || index + 1 >= gridItemsCount
                ? index
                : index + 1;
            const upIndex = index - tvGridColumns;
            const downIndex = index + tvGridColumns;
            return (
              <View key={profile.id} style={[styles.profileItem, isLargeDevice && stylesTv.profileItem]}>
                <TouchableOpacity
                  ref={(el) => {
                    profileTapRefs.current[index] = el;
                  }}
                  style={[
                    styles.profileTapArea,
                    isLargeDevice && focusedItem === profileFocusKey && stylesTv.profileTapFocused,
                  ]}
                  onPress={() => {
                    void onSelectProfile(profile);
                  }}
                  onFocus={() => setFocusedItem(profileFocusKey)}
                  onBlur={() => setFocusedItem('')}
                  hasTVPreferredFocus={isLargeDevice && index === 0}
                  nextFocusLeft={isLargeDevice ? getGridItemHandle(leftIndex) : undefined}
                  nextFocusRight={isLargeDevice ? getGridItemHandle(rightIndex) : undefined}
                  nextFocusUp={isLargeDevice && upIndex >= 0 ? getGridItemHandle(upIndex) : undefined}
                  nextFocusDown={
                    isLargeDevice
                      ? downIndex < gridItemsCount
                        ? getGridItemHandle(downIndex)
                        : firstActionHandle
                      : undefined
                  }
                >
                  <View style={[styles.profileAvatar, isLargeDevice && stylesTv.profileAvatar, active && styles.profileAvatarActive, isLargeDevice && focusedItem === profileFocusKey && stylesTv.profileAvatarFocused]}>
                    {profile.avatarUri ? (
                      <Image source={{ uri: profile.avatarUri }} style={styles.profileAvatarImage} cachePolicy="disk" />
                    ) : (
                      <MaterialIcons
                        name={profile.kidsMode ? 'child-care' : 'person'}
                        size={isLargeDevice ? 44 : 30}
                        color={StreamingTheme.colors.textPrimary}
                      />
                    )}
                    {profile.pinEnabled ? (
                      <View style={styles.lockBadge}>
                        <MaterialIcons name="lock" size={12} color={StreamingTheme.colors.textPrimary} />
                      </View>
                    ) : null}
                  </View>
                  <Text style={[styles.profileName, isLargeDevice && stylesTv.profileName]}>{profile.name}</Text>
                  <Text style={[styles.profileMeta, isLargeDevice && stylesTv.profileMeta]}>{profile.pinEnabled ? 'PIN ativo' : 'Entrada direta'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  focusable={!isLargeDevice}
                  style={[
                    styles.avatarEditBtn,
                    isLargeDevice && stylesTv.focusable,
                    isLargeDevice && focusedItem === `avatar-${profile.id}` && stylesTv.focusedBtn,
                  ]}
                  onPress={() => onEditExistingProfileAvatar(profile)}
                  onFocus={() => setFocusedItem(`avatar-${profile.id}`)}
                  onBlur={() => setFocusedItem('')}
                >
                  <MaterialIcons name="photo-camera" size={14} color={StreamingTheme.colors.textPrimary} />
                  <Text style={styles.avatarEditBtnText}>Foto</Text>
                </TouchableOpacity>
              </View>
            );
          })}

          <TouchableOpacity
            ref={createProfileRef}
            style={[styles.profileItem, isLargeDevice && stylesTv.profileItem]}
            onPress={() => router.push({ pathname: '/perfil-criar', params: { next: nextFlow } })}
            onFocus={() => setFocusedItem('create-profile')}
            onBlur={() => setFocusedItem('')}
            nextFocusLeft={isLargeDevice ? getGridItemHandle(Math.max(0, profiles.length - 1)) : undefined}
            nextFocusRight={isLargeDevice ? getGridItemHandle(profiles.length) : undefined}
            nextFocusUp={
              isLargeDevice && profiles.length >= tvGridColumns
                ? getGridItemHandle(profiles.length - tvGridColumns)
                : undefined
            }
            nextFocusDown={isLargeDevice ? firstActionHandle : undefined}
          >
            <View
              style={[
                styles.profileAvatar,
                isLargeDevice && stylesTv.profileAvatar,
                styles.profileAvatarCreate,
                isLargeDevice && focusedItem === 'create-profile' && stylesTv.profileAvatarFocused,
              ]}
            >
              <MaterialIcons name="add" size={isLargeDevice ? 46 : 34} color={StreamingTheme.colors.textPrimary} />
            </View>
            <Text style={[styles.profileName, isLargeDevice && stylesTv.profileName]}>Criar perfil</Text>
            <Text style={[styles.profileMeta, isLargeDevice && stylesTv.profileMeta]}>Novo perfil agora</Text>
          </TouchableOpacity>
        </View>

        {selectedProfile?.pinEnabled && (
          <View style={styles.pinBox}>
            <>
              <Text style={styles.pinLabel}>PIN do perfil</Text>
              <TextInput
                ref={pinInputRef}
                style={[
                  styles.pinInput,
                  isLargeDevice && stylesTv.pinInput,
                  pinFocused && styles.pinInputFocused,
                  isLargeDevice && pinFocused && stylesTv.focusedBtn,
                ]}
                value={pin}
                onChangeText={(value) => setPin(value.replace(/[^0-9]/g, ''))}
                secureTextEntry
                keyboardType="numeric"
                placeholder="Digite o PIN"
                placeholderTextColor={StreamingTheme.colors.textMuted}
                maxLength={8}
                returnKeyType="done"
                onSubmitEditing={() => {
                  if (selectedProfile?.id) {
                    void openApp(selectedProfile.id, pin);
                  }
                }}
                onFocus={() => {
                  setPinFocused(true);
                  setTimeout(() => {
                    scrollRef.current?.scrollToEnd({ animated: true });
                  }, 80);
                }}
                onBlur={() => setPinFocused(false)}
                hasTVPreferredFocus={isLargeDevice}
                {...(isLargeDevice ? {
                  nextFocusUp: getGridItemHandle(selectedGridIndex >= 0 ? selectedGridIndex : 0),
                  nextFocusDown: getHandle(enterProfileBtnRef.current),
                } as any : {})}
              />
            </>
            <TouchableOpacity
              ref={enterProfileBtnRef}
              style={[
                styles.enterBtn,
                isLargeDevice && stylesTv.focusable,
                isLargeDevice && focusedItem === 'enter-profile' && stylesTv.focusedBtn,
              ]}
              onPress={() => openApp(selectedProfile.id, pin)}
              onFocus={() => setFocusedItem('enter-profile')}
              onBlur={() => setFocusedItem('')}
              hasTVPreferredFocus={isLargeDevice}
              nextFocusUp={isLargeDevice ? getHandle(pinInputRef.current) : undefined}
              nextFocusDown={
                isLargeDevice
                  ? selectedProfile?.pinEnabled
                    ? getHandle(trustPinRef.current) ?? getHandle(rememberProfileRef.current)
                    : getHandle(rememberProfileRef.current)
                  : undefined
              }
            >
              <MaterialIcons name="lock-open" size={18} color={StreamingTheme.colors.textPrimary} />
              <Text style={styles.enterText}>Entrar neste perfil</Text>
            </TouchableOpacity>
          </View>
        )}

        {selectedProfile?.pinEnabled && trustPin ? (
          <View style={styles.trustedInfoBox}>
            <MaterialIcons name="verified-user" size={18} color={StreamingTheme.colors.accentAlt} />
            <Text style={styles.trustedInfoText}>Este perfil sera marcado como confiavel para os proximos acessos neste aparelho.</Text>
          </View>
        ) : null}

        {selectedProfile?.pinEnabled ? (
          <TouchableOpacity
            ref={trustPinRef}
            style={[
              styles.prefRow,
              isLargeDevice && stylesTv.focusable,
              isLargeDevice && focusedItem === 'trust-pin' && stylesTv.focusedBtn,
            ]}
            onPress={() => setTrustPin((prev) => !prev)}
            onFocus={() => setFocusedItem('trust-pin')}
            onBlur={() => setFocusedItem('')}
            nextFocusUp={isLargeDevice ? getHandle(enterProfileBtnRef.current) : undefined}
            nextFocusDown={isLargeDevice ? getHandle(rememberProfileRef.current) : undefined}
          >
            <MaterialIcons
              name={trustPin ? 'check-box' : 'check-box-outline-blank'}
              size={20}
              color={trustPin ? StreamingTheme.colors.accentAlt : StreamingTheme.colors.textMuted}
            />
            <Text style={styles.prefText}>Nao solicitar PIN futuramente neste aparelho</Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          ref={rememberProfileRef}
          style={[
            styles.prefRow,
            isLargeDevice && stylesTv.focusable,
            isLargeDevice && focusedItem === 'remember-profile' && stylesTv.focusedBtn,
          ]}
          onPress={() => setRememberProfile((prev) => !prev)}
          onFocus={() => setFocusedItem('remember-profile')}
          onBlur={() => setFocusedItem('')}
          nextFocusUp={
            isLargeDevice
              ? selectedProfile?.pinEnabled
                ? getHandle(trustPinRef.current)
                : getGridItemHandle(selectedGridIndex >= 0 ? selectedGridIndex : 0)
              : undefined
          }
          nextFocusDown={isLargeDevice ? getHandle(xtreamBtnRef.current) : undefined}
        >
          <MaterialIcons
            name={rememberProfile ? 'check-box' : 'check-box-outline-blank'}
            size={20}
            color={rememberProfile ? StreamingTheme.colors.accentAlt : StreamingTheme.colors.textMuted}
          />
          <Text style={styles.prefText}>Entrar automaticamente com este perfil</Text>
        </TouchableOpacity>

        <TouchableOpacity
          ref={xtreamBtnRef}
          style={[
            styles.enterBtn,
            isLargeDevice && stylesTv.focusable,
            isLargeDevice && focusedItem === 'xtream' && stylesTv.focusedBtn,
          ]}
          onPress={() => router.push('/xtream-login')}
          onFocus={() => setFocusedItem('xtream')}
          onBlur={() => setFocusedItem('')}
          nextFocusUp={isLargeDevice ? getHandle(rememberProfileRef.current) : undefined}
        >
          <MaterialIcons name="tv" size={18} color={StreamingTheme.colors.textPrimary} />
          <Text style={styles.enterText}>Adicionar servidor Xtream</Text>
        </TouchableOpacity>

      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },
  keyboardWrap: { flex: 1 },
  content: { padding: 18, paddingBottom: 60 },
  kicker: {
    color: StreamingTheme.colors.accentAlt,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 8,
  },
  title: {
    marginTop: 2,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 30,
    fontWeight: '900',
  },
  subtitle: {
    marginTop: 8,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 20,
  },
  grid: {
    marginTop: 14,
    gap: 14,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  profileItem: {
    width: '30.5%',
    minWidth: 98,
    alignItems: 'center',
    gap: 6,
  },
  profileTapArea: {
    alignItems: 'center',
    gap: 6,
  },
  profileAvatar: {
    width: 94,
    height: 94,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    overflow: 'hidden',
  },
  profileAvatarImage: {
    width: '100%',
    height: '100%',
  },
  profileAvatarActive: {
    borderColor: 'rgba(255,59,48,0.55)',
    backgroundColor: 'rgba(255,59,48,0.17)',
  },
  profileAvatarCreate: {
    borderStyle: 'dashed',
    borderColor: 'rgba(255,122,24,0.55)',
    backgroundColor: 'rgba(255,122,24,0.18)',
  },
  lockBadge: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    width: 22,
    height: 22,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(7,9,20,0.86)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileName: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
  },
  profileMeta: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 11,
    textAlign: 'center',
  },
  avatarEditBtn: {
    minHeight: 28,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.07)',
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  avatarEditBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 11,
    fontWeight: '700',
  },
  createBox: {
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 12,
    gap: 10,
  },
  createAvatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  createAvatarWrap: {
    width: 72,
    height: 72,
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
  },
  createAvatarImage: {
    width: '100%',
    height: '100%',
  },
  createAvatarFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: StreamingTheme.colors.surface,
  },
  createAvatarActions: {
    flex: 1,
    gap: 8,
  },
  miniActionBtn: {
    minHeight: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,122,24,0.18)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10,
  },
  miniActionBtnMuted: {
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  miniActionText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  pinBox: {
    marginTop: 14,
    gap: 6,
  },
  pinLabel: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  pinInput: {
    height: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    paddingHorizontal: 12,
    color: StreamingTheme.colors.textPrimary,
  },
  pinInputFocused: {
    borderColor: StreamingTheme.colors.accentAlt,
    borderWidth: 3,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  toggleText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    flex: 1,
  },
  prefRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  prefText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    flex: 1,
  },
  trustedInfoBox: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,122,24,0.35)',
    backgroundColor: 'rgba(255,122,24,0.12)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  trustedInfoText: {
    flex: 1,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
  },
  createBtn: {
    marginTop: 4,
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,122,24,0.5)',
    backgroundColor: 'rgba(255,122,24,0.24)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  createBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
  },
  enterBtn: {
    marginTop: 16,
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,59,48,0.5)',
    backgroundColor: 'rgba(255,59,48,0.25)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  enterText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
});

const stylesTv = StyleSheet.create({
  content: {
    paddingHorizontal: 40,
    paddingBottom: 84,
  },
  title: {
    fontSize: 42,
  },
  subtitle: {
    fontSize: 18,
    lineHeight: 26,
    maxWidth: 980,
  },
  grid: {
    justifyContent: 'center',
    gap: 18,
  },
  profileItem: {
    width: '22%',
    minWidth: 190,
  },
  profileAvatar: {
    width: 156,
    height: 156,
    borderWidth: 3,
  },
  profileName: {
    fontSize: 18,
  },
  profileMeta: {
    fontSize: 14,
  },
  pinInput: {
    height: 64,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.24)',
    fontSize: 20,
  },
  focusable: {
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.24)',
    borderRadius: 16,
    paddingHorizontal: 10,
  },
  // borda visivel nos botoes (rectangulares)
  focusedBtn: {
    borderWidth: 5,
    borderColor: StreamingTheme.colors.accentAlt,
    backgroundColor: 'rgba(255,143,58,0.18)',
  },
  // borda circular para os avatares
  profileAvatarFocused: {
    borderWidth: 6,
    borderColor: StreamingTheme.colors.accentAlt,
    transform: [{ scale: 1.08 }],
  },
  // leve destaque no tap area para agrupar nome+meta
  profileTapFocused: {
    opacity: 1,
  },
});
