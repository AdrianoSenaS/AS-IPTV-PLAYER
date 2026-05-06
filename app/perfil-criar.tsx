import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
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

import { AppBackdrop } from '@/components/app-backdrop';
import { PageLoader } from '@/components/page-loader';
import { StreamingTheme } from '@/constants/streaming-theme';
import { hasLocalCatalogDataQuick } from '@/services/catalog-data';
import { triggerImmediateSync, uploadProfileAvatarFromDevice } from '@/services/cloud-sync';
import { markAlgorithmOnboardingPendingForActiveProfile, shouldShowAlgorithmOnboarding } from '@/services/behavior-intelligence';
import { getDbValue } from '@/services/local-db';
import { Profile, upsertProfile } from '@/services/account-settings';
import { startSession } from '@/services/realtime-presence';
import { unlockProfileAccess } from '@/services/access-control';
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

export default function PerfilCriarScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ next?: string }>();
  const isLargeDevice = isNonMobileDevice();
  const homeRoute = getHomeRouteForDevice();
  const rawNextFlow = String(params?.next || '').trim();
  const nextFlow =
    rawNextFlow === 'loading' ? 'loading' : rawNextFlow === 'tv-home' ? 'tv-home' : 'home';

  const [isSaving, setIsSaving] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfilePinEnabled, setNewProfilePinEnabled] = useState(false);
  const [newProfilePin, setNewProfilePin] = useState('');
  const [newProfileAvatarUri, setNewProfileAvatarUri] = useState('');

  const openAppWithProfile = async (profile: Profile, profilePin: string) => {
    const result = await unlockProfileAccess(profile.id, profilePin);
    if (!result.ok) {
      Alert.alert('Acesso negado', result.message || 'Nao foi possivel liberar o perfil.');
      return;
    }

    const username = await getDbValue<string>('username');
    const serverUrl = await getDbValue<string>('url');
    if (username && !isLargeDevice) {
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

    const shouldOpenIaSetup = !isLargeDevice && (await shouldShowAlgorithmOnboarding());
    if (shouldOpenIaSetup) {
      router.replace({ pathname: '/algoritmo-preferencias', params: { next: 'perfil-acesso', entry: nextFlow } });
      return;
    }

    if (nextFlow === 'loading') {
      router.replace({ pathname: '/loading', params: { from: 'profile' } });
      return;
    }

    const hasLocalData = await hasLocalCatalogDataQuick();
    if (hasLocalData || nextFlow === 'home' || nextFlow === 'tv-home') {
      router.replace(homeRoute as any);
    } else {
      router.replace({ pathname: '/loading', params: { from: 'profile' } });
    }
  };

  const onCreateProfile = async () => {
    const safeName = newProfileName.trim();
    if (!safeName) {
      Alert.alert('Perfil', 'Digite um nome para o novo perfil.');
      return;
    }

    if (newProfilePinEnabled && newProfilePin.trim().length < 4) {
      Alert.alert('PIN', 'O PIN deve ter pelo menos 4 digitos.');
      return;
    }

    setIsSaving(true);
    try {
      const shouldUploadAvatar = !!newProfileAvatarUri && !/^https?:\/\//i.test(newProfileAvatarUri);
      const avatarUriForSave = shouldUploadAvatar
        ? await uploadProfileAvatarFromDevice(newProfileAvatarUri)
        : newProfileAvatarUri;

      const next = await upsertProfile({
        name: safeName,
        avatarUri: avatarUriForSave,
        pinEnabled: newProfilePinEnabled,
        pin: newProfilePin,
        kidsMode: false,
      });
      const created = next.profiles.find((item) => item.id === next.activeProfileId);

      if (!created) {
        throw new Error('Nao foi possivel criar o perfil.');
      }

      if (!isLargeDevice) {
        await markAlgorithmOnboardingPendingForActiveProfile();
        triggerImmediateSync().catch(() => null);
      }

      await openAppWithProfile(created, newProfilePinEnabled ? newProfilePin : '');
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel criar o perfil.'));
    } finally {
      setIsSaving(false);
    }
  };

  const onPickNewProfileAvatar = async () => {
    try {
      const result = await pickSingleImageFromLibrary();
      if (result.canceled || !result.assets?.[0]?.uri) {
        return;
      }

      const optimizedUri = await optimizeAvatarImage(result.assets[0].uri);
      setNewProfileAvatarUri(optimizedUri);
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
      console.error('[perfil-criar][avatar-upload] falha ao selecionar foto para novo perfil', {
        code: code || null,
        message,
        stack: error?.stack || null,
      });
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel selecionar a foto.'));
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isSaving} label="Criando perfil" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={18} color={StreamingTheme.colors.textPrimary} />
          <Text style={styles.backBtnText}>Voltar</Text>
        </TouchableOpacity>

        <Text style={styles.kicker}>Novo perfil</Text>
        <Text style={styles.title}>Criar perfil</Text>
        <Text style={styles.subtitle}>Preencha os dados para criar um novo perfil.</Text>

        <View style={styles.createBox}>
          <View style={styles.createAvatarRow}>
            <View style={styles.createAvatarWrap}>
              {newProfileAvatarUri ? (
                <Image source={{ uri: newProfileAvatarUri }} style={styles.createAvatarImage} cachePolicy="disk" />
              ) : (
                <View style={styles.createAvatarFallback}>
                  <MaterialIcons name="person" size={32} color={StreamingTheme.colors.textMuted} />
                </View>
              )}
            </View>
            <View style={styles.createAvatarActions}>
              <TouchableOpacity style={styles.miniActionBtn} onPress={onPickNewProfileAvatar}>
                <MaterialIcons name="photo-library" size={16} color={StreamingTheme.colors.textPrimary} />
                <Text style={styles.miniActionText}>Escolher foto</Text>
              </TouchableOpacity>
              {newProfileAvatarUri ? (
                <TouchableOpacity style={[styles.miniActionBtn, styles.miniActionBtnMuted]} onPress={() => setNewProfileAvatarUri('')}>
                  <MaterialIcons name="delete" size={16} color={StreamingTheme.colors.textPrimary} />
                  <Text style={styles.miniActionText}>Remover foto</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>

          <Text style={styles.fieldLabel}>Nome do perfil</Text>
          <TextInput
            style={styles.fieldInput}
            value={newProfileName}
            onChangeText={setNewProfileName}
            placeholder="Ex.: Joao"
            placeholderTextColor={StreamingTheme.colors.textMuted}
          />

          <View style={styles.toggleRow}>
            <Text style={styles.toggleText}>Ativar PIN neste perfil</Text>
            <Switch
              value={newProfilePinEnabled}
              onValueChange={setNewProfilePinEnabled}
              thumbColor={StreamingTheme.colors.textPrimary}
              trackColor={{ false: 'rgba(255,255,255,0.2)', true: 'rgba(255,59,48,0.55)' }}
            />
          </View>

          {newProfilePinEnabled ? (
            <>
              <Text style={styles.fieldLabel}>PIN do novo perfil</Text>
              <TextInput
                style={styles.fieldInput}
                value={newProfilePin}
                onChangeText={(value) => setNewProfilePin(value.replace(/[^0-9]/g, ''))}
                secureTextEntry
                keyboardType="numeric"
                placeholder="Minimo 4 digitos"
                placeholderTextColor={StreamingTheme.colors.textMuted}
                maxLength={8}
              />
            </>
          ) : null}

          <TouchableOpacity style={styles.createBtn} onPress={onCreateProfile}>
            <MaterialIcons name="person-add" size={17} color={StreamingTheme.colors.textPrimary} />
            <Text style={styles.createBtnText}>Criar e entrar</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },
  content: { padding: 18, paddingBottom: 60 },
  backBtn: {
    alignSelf: 'flex-start',
    minHeight: 34,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 10,
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  backBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  kicker: {
    color: StreamingTheme.colors.accentAlt,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 14,
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
  createBox: {
    marginTop: 14,
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
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  miniActionBtnMuted: {
    opacity: 0.85,
  },
  miniActionText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  fieldLabel: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  fieldInput: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    color: StreamingTheme.colors.textPrimary,
    paddingHorizontal: 12,
  },
  toggleRow: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  toggleText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  createBtn: {
    marginTop: 6,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,122,24,0.7)',
    backgroundColor: 'rgba(255,122,24,0.22)',
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
});
