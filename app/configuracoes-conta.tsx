import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';

import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
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
import {
  clearUserSession,
  createUserWithEmail,
  loadUserSession,
  signInWithEmail,
  updateCurrentUserProfile,
  UserSession,
} from '@/services/cloud-sync';
import {
  DEFAULT_APP_SERVER_URL,
  getAppServerUrl,
  setAppServerUrl,
} from '@/services/app-server';

export default function ConfiguracoesContaScreen() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [session, setSession] = useState<UserSession | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [avatarUri, setAvatarUri] = useState('');
  const hydratedOnceRef = useRef(false);
  const [serverUrl, setServerUrl] = useState('');
  const [serverTestResult, setServerTestResult] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const hydrate = useCallback(async () => {
    if (!hydratedOnceRef.current) {
      setIsLoading(true);
    }
    try {
      const nextSession = await loadUserSession();
      setSession(nextSession);
      setName(nextSession?.user.name || '');
      setEmail(nextSession?.user.email || '');
      setAvatarUri(nextSession?.user.avatarUri || '');
      setPassword('');
    } finally {
      hydratedOnceRef.current = true;
      setIsLoading(false);
    }
  }, []);
  const hydrateServerUrl = useCallback(async () => {
    const url = await getAppServerUrl();
    setServerUrl(url);
  }, []);

  useFocusEffect(
    useCallback(() => {
      hydrate();
    }, [hydrate])
  );
  useFocusEffect(
    useCallback(() => {
      hydrateServerUrl();
    }, [hydrateServerUrl])
  );

  const runAction = async (action: () => Promise<void>) => {
    try {
      setIsSaving(true);
      await action();
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Falha ao salvar.'));
    } finally {
      setIsSaving(false);
    }
  };

  const onPickAvatar = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permissao necessaria', 'Permita acesso a galeria para enviar foto de perfil.');
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

    setAvatarUri(result.assets[0].uri);
  };

  const onRegister = async () => {
    await runAction(async () => {
      const next = await createUserWithEmail({ name, email, password });
      setSession(next);
      setAvatarUri(next.user.avatarUri || avatarUri);
      Alert.alert('Conta criada', 'Cadastro realizado com sucesso.');
    });
  };

  const onLogin = async () => {
    await runAction(async () => {
      const next = await signInWithEmail({ email, password });
      setSession(next);
      setName(next.user.name);
      setEmail(next.user.email);
      setAvatarUri(next.user.avatarUri || '');
      Alert.alert('Login realizado', 'Sessao iniciada com sucesso.');
    });
  };

  const onSaveProfile = async () => {
    await runAction(async () => {
      const next = await updateCurrentUserProfile({ name, email, avatarUri });
      setSession(next);
      Alert.alert('Perfil atualizado', 'Dados do usuario salvos.');
    });
  };

  const onLogout = async () => {
    await runAction(async () => {
      await clearUserSession();
      setSession(null);
      setPassword('');
      Alert.alert('Sessao encerrada', 'Voce saiu da conta.');

      const onSaveServerUrl = async () => {
        await runAction(async () => {
          const trimmed = serverUrl.trim();
          if (!trimmed) {
            await setAppServerUrl(DEFAULT_APP_SERVER_URL);
            setServerUrl(DEFAULT_APP_SERVER_URL);
          } else {
            await setAppServerUrl(trimmed);
          }
          setServerTestResult(null);
          Alert.alert('Servidor salvo', 'URL do servidor atualizada.');
        });
      };

      const onTestServer = async () => {
        setIsTesting(true);
        setServerTestResult(null);
        try {
          const url = (serverUrl.trim() || DEFAULT_APP_SERVER_URL).replace(/\/$/, '');
          const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const json = await res.json().catch(() => ({}));
            setServerTestResult(`Conectado! ts: ${json.ts || '—'}`);
          } else {
            setServerTestResult(`Erro HTTP ${res.status}`);
          }
        } catch (e: any) {
          setServerTestResult(`Falha: ${e?.message || 'sem resposta'}`);
        } finally {
          setIsTesting(false);
        }
      };
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isLoading || isSaving} label={isLoading ? 'Carregando conta' : 'Salvando'} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.kicker}>CONTA DO USUARIO</Text>
            <Text style={styles.title}>Perfil e login</Text>
          </View>
          <View style={styles.iconBtn} />
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Foto do perfil</Text>
          <View style={styles.avatarRow}>
            {avatarUri ? (
              <Image source={{ uri: avatarUri }} style={styles.avatar} cachePolicy="disk" />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback]}>
                <MaterialIcons name="person" size={44} color={StreamingTheme.colors.textMuted} />
              </View>
            )}
            <View style={{ flex: 1, gap: 8 }}>
              <ActionButton text="Fazer upload da foto" icon="photo-library" onPress={onPickAvatar} />
              {!!avatarUri && <ActionButton text="Remover foto" icon="delete" tone="muted" onPress={() => setAvatarUri('')} />}
            </View>
          </View>
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Dados da conta</Text>
          <Text style={styles.helperLine}>Status: {session ? `Logado como ${session.user.email}` : 'Nao autenticado'}</Text>

          <Field label="Nome" placeholder="Seu nome" value={name} onChangeText={setName} />
          <Field label="E-mail" placeholder="voce@email.com" value={email} onChangeText={setEmail} />
          <Field
            label="Senha"
            placeholder="Minimo 6 caracteres"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />

          <View style={styles.row}>
            <ActionButton text="Criar conta" icon="person-add" onPress={onRegister} />
            <ActionButton text="Entrar" icon="login" onPress={onLogin} tone="muted" />
          </View>

          <View style={styles.row}>
            <ActionButton text="Salvar perfil" icon="save" onPress={onSaveProfile} />
            <ActionButton text="Sair" icon="logout" onPress={onLogout} tone="muted" />
          </View>
        </View>

        {/* ---- Servidor AS-IPTV ----------------------------------------- */}
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Servidor AS-IPTV</Text>
          <Text style={styles.helperLine}>
            URL usada para login, sincronização e planos. Padrão: {DEFAULT_APP_SERVER_URL}
          </Text>

          <Field
            label="URL do servidor"
            placeholder={DEFAULT_APP_SERVER_URL}
            value={serverUrl}
            onChangeText={(v) => { setServerUrl(v); setServerTestResult(null); }}
          />

          {!!serverTestResult && (
            <Text style={[styles.helperLine, { color: serverTestResult.startsWith('Conectado') ? '#4CAF50' : StreamingTheme.colors.accent }]}>
              {serverTestResult}
            </Text>
          )}

          <View style={styles.row}>
            <ActionButton text={isTesting ? 'Testando…' : 'Testar conexão'} icon="wifi" onPress={onTestServer} tone="muted" />
            <ActionButton text="Salvar URL" icon="save" onPress={onSaveServerUrl} />
          </View>
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
      <MaterialIcons name={icon} size={18} color={StreamingTheme.colors.textPrimary} />
      <Text style={styles.buttonText}>{text}</Text>
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
  panel: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(16,21,37,0.86)',
    padding: 12,
    gap: 8,
  },
  panelTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '900',
  },
  helperLine: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
  },
  avatarRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
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
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,59,48,0.5)',
    backgroundColor: 'rgba(255,59,48,0.2)',
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
});
