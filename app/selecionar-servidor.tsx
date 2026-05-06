import { MaterialIcons } from '@expo/vector-icons';

import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  Alert,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackdrop } from '@/components/app-backdrop';
import { PageLoader } from '@/components/page-loader';
import { StreamingTheme } from '@/constants/streaming-theme';
import { AccountSettingsState, loadAccountSettings, setActiveServer } from '@/services/account-settings';
import {
  setRememberActiveServerOnLogin,
  shouldRememberActiveServerOnLogin,
} from '@/services/post-auth-routing';

export default function SelecionarServidorScreen() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [state, setState] = useState<AccountSettingsState | null>(null);
  const [rememberServer, setRememberServer] = useState(false);

  const hydrate = useCallback(async () => {
    setIsLoading(true);
    try {
      const [next, remember] = await Promise.all([
        loadAccountSettings(),
        shouldRememberActiveServerOnLogin(),
      ]);
      setState(next);
      setRememberServer(remember);

      if (!next.servers.length) {
        router.replace('/xtream-login');
        return;
      }

      if (next.servers.length === 1) {
        await setActiveServer(next.servers[0].id);
        router.replace('/loading');
      }
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel carregar os servidores.'));
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useFocusEffect(
    useCallback(() => {
      hydrate();
    }, [hydrate])
  );

  const onSelectServer = async (serverId: string) => {
    try {
      setIsSaving(true);
      await Promise.all([
        setActiveServer(serverId),
        setRememberActiveServerOnLogin(rememberServer),
      ]);
      router.replace('/loading');
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel ativar o servidor.'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isLoading || isSaving} label={isLoading ? 'Carregando servidores' : 'Ativando servidor'} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.kicker}>PRIMEIRO ACESSO</Text>
          <Text style={styles.title}>Escolha o servidor padrao</Text>
          <Text style={styles.subtitle}>
            Encontramos mais de um servidor salvo nesta conta. Selecione qual deve ser usado agora.
          </Text>
        </View>

        <TouchableOpacity
          style={styles.rememberRow}
          onPress={() => setRememberServer((prev) => !prev)}
          activeOpacity={0.85}
        >
          <MaterialIcons
            name={rememberServer ? 'check-box' : 'check-box-outline-blank'}
            size={20}
            color={rememberServer ? '#FF7A18' : StreamingTheme.colors.textMuted}
          />
          <Text style={styles.rememberText}>Usar sempre este servidor ao entrar</Text>
        </TouchableOpacity>

        {(state?.servers || []).map((server) => {
          const active = server.id === state?.activeServerId;
          return (
            <TouchableOpacity
              key={server.id}
              style={[styles.serverCard, active && styles.serverCardActive]}
              onPress={() => onSelectServer(server.id)}
              activeOpacity={0.88}
            >
              <View style={styles.serverMain}>
                <Text style={styles.serverTitle}>{server.name}</Text>
                <Text style={styles.serverSub}>{server.url}</Text>
                <Text style={styles.serverSub}>Usuario: {server.username}</Text>
              </View>
              <MaterialIcons
                name={active ? 'radio-button-checked' : 'radio-button-unchecked'}
                size={22}
                color={active ? '#FF7A18' : StreamingTheme.colors.textMuted}
              />
            </TouchableOpacity>
          );
        })}

        <TouchableOpacity style={styles.otherBtn} onPress={() => router.replace('/xtream-login')}>
          <MaterialIcons name="add-circle-outline" size={18} color={StreamingTheme.colors.textPrimary} />
          <Text style={styles.otherBtnText}>Entrar com outro Xtream Code</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: StreamingTheme.colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 100,
    gap: 12,
  },
  header: {
    gap: 6,
  },
  kicker: {
    color: StreamingTheme.colors.accentAlt,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 26,
    fontWeight: '900',
  },
  subtitle: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 20,
  },
  rememberRow: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.03)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
  },
  rememberText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  serverCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(18,24,40,0.9)',
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  serverCardActive: {
    borderColor: 'rgba(255,122,24,0.45)',
    backgroundColor: 'rgba(255,122,24,0.10)',
  },
  serverMain: {
    flex: 1,
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
  otherBtn: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 4,
  },
  otherBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 14,
  },
});