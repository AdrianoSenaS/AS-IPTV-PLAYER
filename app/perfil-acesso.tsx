import { MaterialIcons } from '@expo/vector-icons';
import { getDbValue } from '@/services/local-db';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
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
import { StreamingTheme } from '@/constants/streaming-theme';
import { loadAccountSettings, Profile } from '@/services/account-settings';
import { isDemoModeEnabled } from '@/services/demo-mode';
import { unlockProfileAccess } from '@/services/access-control';
import { connectSocket, startSession } from '@/services/realtime-presence';

export default function PerfilAcessoScreen() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [pin, setPin] = useState('');

  const selectedProfile = useMemo(
    () => profiles.find((item) => item.id === selectedProfileId),
    [profiles, selectedProfileId]
  );

  useEffect(() => {
    const bootstrap = async () => {
      const [username, settings] = await Promise.all([getDbValue<string>('username'), loadAccountSettings()]);
      const isDemo = await isDemoModeEnabled();

      if (!username && !isDemo) {
        router.replace('/login');
        return;
      }

      const availableProfiles = settings.profiles || [];
      setProfiles(availableProfiles);
      setSelectedProfileId(settings.activeProfileId || availableProfiles[0]?.id || '');
      setIsLoading(false);
    };

    bootstrap();
  }, [router]);

  const openApp = async () => {
    if (!selectedProfileId) {
      Alert.alert('Perfil', 'Selecione um perfil para continuar.');
      return;
    }

    const result = await unlockProfileAccess(selectedProfileId, pin);
    if (!result.ok) {
      Alert.alert('Acesso negado', result.message || 'Nao foi possivel liberar o perfil.');
      return;
    }

    // Registra sessão real-time (session lock)
    const profile = profiles.find((p) => p.id === selectedProfileId);
    if (profile) {
      const username = await getDbValue<string>('username');
      const serverUrl = await getDbValue<string>('url');
      if (username && serverUrl) {
        const rt = await startSession({
          username,
          serverUrl,
          profileId: profile.id,
          profileName: profile.name,
          kidsMode: !!profile.kidsMode,
        });
        if (!rt.ok && rt.locked) {
          Alert.alert('Perfil em uso', rt.message);
          return;
        }
      }
      // Conecta socket após obter token
      connectSocket().catch(() => { /* servidor offline, continua normalmente */ });
    }

    router.replace('/(tabs)');
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

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.kicker}>Quem vai assistir?</Text>
        <Text style={styles.title}>Escolha o perfil</Text>
        <Text style={styles.subtitle}>Cada abertura do app exige selecionar perfil e validar PIN quando ativo.</Text>

        <View style={styles.grid}>
          {profiles.map((profile) => {
            const active = profile.id === selectedProfileId;
            return (
              <TouchableOpacity
                key={profile.id}
                style={[styles.profileCard, active && styles.profileCardActive]}
                onPress={() => setSelectedProfileId(profile.id)}
              >
                <MaterialIcons
                  name={profile.kidsMode ? 'child-care' : 'person'}
                  size={22}
                  color={StreamingTheme.colors.textPrimary}
                />
                <Text style={styles.profileName}>{profile.name}</Text>
                <Text style={styles.profileMeta}>PIN: {profile.pinEnabled ? 'Obrigatorio' : 'Livre'}</Text>
                <Text style={styles.profileMeta}>Modo infantil: {profile.kidsMode ? 'Sim' : 'Nao'}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {selectedProfile?.pinEnabled && (
          <View style={styles.pinBox}>
            <Text style={styles.pinLabel}>PIN do perfil</Text>
            <TextInput
              style={styles.pinInput}
              value={pin}
              onChangeText={(value) => setPin(value.replace(/[^0-9]/g, ''))}
              secureTextEntry
              keyboardType="numeric"
              placeholder="Digite o PIN"
              placeholderTextColor={StreamingTheme.colors.textMuted}
              maxLength={8}
            />
          </View>
        )}

        <TouchableOpacity style={styles.enterBtn} onPress={openApp}>
          <MaterialIcons name="lock-open" size={18} color={StreamingTheme.colors.textPrimary} />
          <Text style={styles.enterText}>Entrar no app</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },
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
    gap: 10,
  },
  profileCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 12,
    gap: 3,
  },
  profileCardActive: {
    borderColor: 'rgba(255,59,48,0.55)',
    backgroundColor: 'rgba(255,59,48,0.17)',
  },
  profileName: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '800',
  },
  profileMeta: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
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
