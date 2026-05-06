import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  findNodeHandle,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackdrop } from '@/components/app-backdrop';
import { GlassSurface } from '@/components/glass-surface';
import { loadAccountSettings } from '@/services/account-settings';
import { apiRequest } from '@/services/app-server';
import { hasLocalCatalogDataQuick } from '@/services/catalog-data';
import { clearUserSession, loadUserSession, restoreLastCloudBackup, signInWithEmail } from '@/services/cloud-sync';
import { prepareAlgorithmOnboardingForFirstLogin } from '@/services/behavior-intelligence';
import { getDbValue, removeDbValue, setDbValue } from '@/services/local-db';
import { registerPlanPushToken } from '@/services/plan-push-notifications';
import { StreamingTheme } from '@/constants/streaming-theme';
import { resolvePostAuthTarget } from '@/services/post-auth-routing';
import { resetAccessSessionForLaunch, shouldRequireProfileSelection, isProfileUnlocked } from '@/services/access-control';
import { getHomeRouteForDevice, getProfileEntryForDevice, isNonMobileDevice } from '@/services/device-profile';

const ACCESS_BLOCK_MESSAGE_KEY = 'session.access.blocked.message.v1';

async function clearServerCredentials() {
  await Promise.all([
    removeDbValue('name'),
    removeDbValue('url'),
    removeDbValue('username'),
    removeDbValue('password'),
  ]);
}

async function blockAccessToLogin(message: string) {
  await Promise.all([
    setDbValue(ACCESS_BLOCK_MESSAGE_KEY, message),
    clearServerCredentials(),
    clearUserSession().catch(() => null),
  ]);
}

async function isActiveProfileAllowed() {
  const settings = await loadAccountSettings();
  const activeProfile = settings.profiles.find((item) => item.id === settings.activeProfileId) || settings.profiles[0] || null;
  return !!activeProfile && activeProfile.enabled !== false;
}

function isNoBackupError(error: unknown) {
  const message = String((error as any)?.message || error || '').toLowerCase();
  return (
    message.includes('nenhum backup encontrado') ||
    message.includes('backup invalido ou vazio') ||
    message.includes('nenhum backup de perfil encontrado')
  );
}

export default function LoginScreen() {
  const router = useRouter();
  const isLargeDevice = isNonMobileDevice();
  const homeRoute = getHomeRouteForDevice();
  const profileEntry = getProfileEntryForDevice();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [focusedField, setFocusedField] = useState<'email' | 'password' | ''>('');
  const [focusedAction, setFocusedAction] = useState('');
  const [isBootChecking, setIsBootChecking] = useState(true);
  const [isAccountLoading, setIsAccountLoading] = useState(false);
  const passwordInputRef = useRef<React.ElementRef<typeof TextInput>>(null);
  const loginBtnRef = useRef<React.ElementRef<typeof TouchableOpacity>>(null);
  const googleBtnRef = useRef<React.ElementRef<typeof TouchableOpacity>>(null);
  const xtreamBtnRef = useRef<React.ElementRef<typeof TouchableOpacity>>(null);
  const quickBtnRef = useRef<React.ElementRef<typeof TouchableOpacity>>(null);
  const registerBtnRef = useRef<React.ElementRef<typeof TouchableOpacity>>(null);

  useEffect(() => {
    let mounted = true;

    const showBlockedMessage = async () => {
      const blockedMessage = await getDbValue<string>(ACCESS_BLOCK_MESSAGE_KEY);
      if (!mounted || !blockedMessage) return;
      await removeDbValue(ACCESS_BLOCK_MESSAGE_KEY);
      Alert.alert('Acesso bloqueado', String(blockedMessage));
    };

    void showBlockedMessage();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      try {
        const [username, pass, url] = await Promise.all([
          getDbValue<string>('username'),
          getDbValue<string>('password'),
          getDbValue<string>('url'),
        ]);

        if (username && pass && url) {
          const profileAllowed = await isActiveProfileAllowed();
          if (!profileAllowed) {
            const message = 'Seu perfil esta desativado. Entre novamente para continuar.';
            await blockAccessToLogin(message);
            Alert.alert('Acesso bloqueado', message);
            return;
          }

          const hasLocalCatalog = await hasLocalCatalogDataQuick();
          // Reseta sessao de acesso para garantir estado de unlock correto.
          await resetAccessSessionForLaunch();

          const requireSelection =
            (await shouldRequireProfileSelection()) && !(await isProfileUnlocked());
          if (requireSelection) {
            router.replace(`/perfil-acesso?next=${hasLocalCatalog ? profileEntry : 'loading'}`);
            return;
          }

          if (!hasLocalCatalog) {
            router.replace('/loading');
            return;
          }
          router.replace(homeRoute as any);
          return;
        }

        const session = await loadUserSession();
        if (session?.token) {
          try {
            await apiRequest('/api/auth/me', { token: session.token, timeoutMs: 20000 });
          } catch (error: any) {
            const message = String(error?.message || '');
            if (/inativo/i.test(message)) {
              const blocked = message || 'Usuario inativo. Contate o administrador.';
              await blockAccessToLogin(blocked);
              Alert.alert('Acesso bloqueado', blocked);
            }
            return;
          }

          const profileAllowed = await isActiveProfileAllowed();
          if (!profileAllowed) {
            const message = 'Seu perfil esta desativado. Entre novamente para continuar.';
            await blockAccessToLogin(message);
            Alert.alert('Acesso bloqueado', message);
            return;
          }

          // Tenta restaurar servidores/perfis salvos na conta antes de resolver a rota.
          await restoreLastCloudBackup().catch(() => null);
          const target = await resolvePostAuthTarget();
          if (target === '/loading') {
            const hasLocalCatalog = await hasLocalCatalogDataQuick();
            await resetAccessSessionForLaunch();
            const requireSelection =
              (await shouldRequireProfileSelection()) && !(await isProfileUnlocked());
            if (requireSelection) {
              router.replace(`/perfil-acesso?next=${hasLocalCatalog ? profileEntry : 'loading'}`);
            } else {
              router.replace(hasLocalCatalog ? (homeRoute as any) : '/loading');
            }
          } else {
            router.replace(target);
          }
          return;
        }
      } finally {
        if (mounted) {
          setIsBootChecking(false);
        }
      }
    };

    bootstrap();
    return () => {
      mounted = false;
    };
  }, [homeRoute, profileEntry, router]);

  const onAccountLogin = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Atencao', 'Informe e-mail e senha para entrar na sua conta.');
      return;
    }

    try {
      setIsAccountLoading(true);
      const session = await signInWithEmail({ email, password });
      let restoreError: unknown = null;
      try {
        await restoreLastCloudBackup();
      } catch (error) {
        restoreError = error;
      }
      if (!isLargeDevice) {
        await prepareAlgorithmOnboardingForFirstLogin(session.user.id);
      }
      await registerPlanPushToken().catch(() => null);
      const target = await resolvePostAuthTarget();
      if (target === '/xtream-login' && restoreError && !isNoBackupError(restoreError)) {
        throw new Error(
          'Nao foi possivel restaurar os dados da sua conta agora. Verifique a conexao e tente novamente para recuperar servidores e perfis sincronizados.'
        );
      }
      //Alert.alert('Conta conectada', 'Login concluido com sucesso.');
      if (target === '/loading') {
        router.replace('/perfil-acesso?next=loading');
      } else {
        router.replace(target);
      }
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel entrar na conta.'));
    } finally {
      setIsAccountLoading(false);
    }
  };

  const onGoogleLogin = () => {
    Alert.alert(
      'Google ainda nao configurado',
      'O botao ja esta na interface, mas este build ainda nao recebeu as chaves OAuth do Google.'
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <AppBackdrop blurIntensity={34} />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.flex}>
        <ScrollView
          contentContainerStyle={[styles.scrollContent, isLargeDevice && stylesTv.scrollContent]}
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.hero, isLargeDevice && stylesTv.hero]}>
            <View style={styles.logoCircle}>
              <MaterialIcons name="verified-user" size={34} color={StreamingTheme.colors.textPrimary} />
            </View>
            <Text style={[styles.brand, isLargeDevice && stylesTv.brand]}>CONTA DO APP</Text>
            <Text style={[styles.subtitle, isLargeDevice && stylesTv.subtitle]}>Entre para gerenciar perfil, plano e recursos da sua assinatura.</Text>
          </View>

          <GlassSurface style={[styles.panel, isLargeDevice && stylesTv.panel]} intensity={40}>
            <View style={styles.typeBadge}>
              <MaterialIcons name="verified-user" size={14} color={StreamingTheme.colors.textPrimary} />
              <Text style={styles.typeBadgeText}>LOGIN DA CONTA DO APP</Text>
            </View>
            <Text style={styles.panelTitle}>Entrar com a conta</Text>
            <Text style={styles.helperText}>
              Este login e da conta do app (planos, cadastro e sincronizacao). O login Xtream e separado.
            </Text>

            <Field
              icon="mail-outline"
              label="E-mail"
              placeholder="voce@email.com"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => passwordInputRef.current?.focus()}
              focused={focusedField === 'email'}
              onFocus={() => setFocusedField('email')}
              onBlur={() => setFocusedField('')}
              isLargeDevice={isLargeDevice}
            />
            <Field
              inputRef={passwordInputRef}
              icon="lock-outline"
              label="Senha"
              placeholder="Sua senha"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              returnKeyType="done"
              onSubmitEditing={onAccountLogin}
              focused={focusedField === 'password'}
              onFocus={() => setFocusedField('password')}
              onBlur={() => setFocusedField('')}
              isLargeDevice={isLargeDevice}
            />

            <TouchableOpacity
              ref={loginBtnRef}
              style={[
                styles.loginBtn,
                isLargeDevice && stylesTv.actionBtn,
                isLargeDevice && focusedAction === 'login' && stylesTv.actionBtnFocused,
              ]}
              onPress={onAccountLogin}
              disabled={isAccountLoading}
              onFocus={() => setFocusedAction('login')}
              onBlur={() => setFocusedAction('')}
              hasTVPreferredFocus={isLargeDevice}
              nextFocusDown={isLargeDevice ? (findNodeHandle(googleBtnRef.current) ?? undefined) : undefined}
            >
              <LinearGradient colors={StreamingTheme.gradients.accent} style={styles.loginGradient}>
                {isAccountLoading ? (
                  <ActivityIndicator color={StreamingTheme.colors.textPrimary} />
                ) : (
                  <>
                    <Text style={styles.loginText}>Entrar com a conta</Text>
                    <MaterialIcons name="arrow-forward" size={20} color={StreamingTheme.colors.textPrimary} />
                  </>
                )}
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity
              ref={googleBtnRef}
              style={[
                styles.googleBtn,
                isLargeDevice && stylesTv.actionBtn,
                isLargeDevice && focusedAction === 'google' && stylesTv.actionBtnFocused,
              ]}
              onPress={onGoogleLogin}
              onFocus={() => setFocusedAction('google')}
              onBlur={() => setFocusedAction('')}
              nextFocusUp={isLargeDevice ? (findNodeHandle(loginBtnRef.current) ?? undefined) : undefined}
              nextFocusDown={isLargeDevice ? (findNodeHandle(xtreamBtnRef.current) ?? undefined) : undefined}
            >
              <MaterialIcons name="account-circle" size={18} color={StreamingTheme.colors.textPrimary} />
              <Text style={styles.googleText}>Entrar com Google</Text>
            </TouchableOpacity>

            <TouchableOpacity
              ref={xtreamBtnRef}
              style={[
                styles.secondaryBtn,
                isLargeDevice && stylesTv.actionBtn,
                isLargeDevice && focusedAction === 'xtream' && stylesTv.actionBtnFocused,
              ]}
              onPress={() => router.push('/xtream-login')}
              onFocus={() => setFocusedAction('xtream')}
              onBlur={() => setFocusedAction('')}
              nextFocusUp={isLargeDevice ? (findNodeHandle(googleBtnRef.current) ?? undefined) : undefined}
              nextFocusDown={isLargeDevice ? (findNodeHandle(quickBtnRef.current) ?? undefined) : undefined}
            >
              <MaterialIcons name="tv" size={18} color={StreamingTheme.colors.textPrimary} />
              <Text style={styles.secondaryBtnText}>Adicionar servidor Xtream</Text>
            </TouchableOpacity>

            <TouchableOpacity
              ref={quickBtnRef}
              style={[
                styles.secondaryBtn,
                isLargeDevice && stylesTv.actionBtn,
                isLargeDevice && focusedAction === 'quick' && stylesTv.actionBtnFocused,
              ]}
              onPress={() => router.replace('/xtream-login')}
              onFocus={() => setFocusedAction('quick')}
              onBlur={() => setFocusedAction('')}
              nextFocusUp={isLargeDevice ? (findNodeHandle(xtreamBtnRef.current) ?? undefined) : undefined}
              nextFocusDown={isLargeDevice ? (findNodeHandle(registerBtnRef.current) ?? undefined) : undefined}
            >
              <MaterialIcons name="bolt" size={18} color={StreamingTheme.colors.textPrimary} />
              <Text style={styles.secondaryBtnText}>Entrar rapido com Xtream</Text>
            </TouchableOpacity>

            <TouchableOpacity
              ref={registerBtnRef}
              style={[
                styles.linkBtn,
                isLargeDevice && stylesTv.actionBtn,
                isLargeDevice && focusedAction === 'register' && stylesTv.actionBtnFocused,
              ]}
              onPress={() => router.push('/cadastrar')}
              onFocus={() => setFocusedAction('register')}
              onBlur={() => setFocusedAction('')}
              nextFocusUp={isLargeDevice ? (findNodeHandle(quickBtnRef.current) ?? undefined) : undefined}
            >
              <Text style={styles.linkText}>Nao tem conta? Cadastrar</Text>
            </TouchableOpacity>
          </GlassSurface>

          {isBootChecking ? (
            <View style={styles.bootCheckWrap}>
              <ActivityIndicator color={StreamingTheme.colors.accentAlt} />
              <Text style={styles.bootCheckText}>Verificando sessao salva...</Text>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({
  icon,
  label,
  placeholder,
  value,
  onChangeText,
  secureTextEntry = false,
  keyboardType = 'default',
  inputRef,
  returnKeyType = 'done',
  blurOnSubmit = true,
  onSubmitEditing,
  focused = false,
  onFocus,
  onBlur,
  isLargeDevice = false,
}: {
  icon: keyof typeof MaterialIcons.glyphMap;
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address';
  inputRef?: React.RefObject<TextInput | null>;
  returnKeyType?: 'next' | 'done';
  blurOnSubmit?: boolean;
  onSubmitEditing?: () => void;
  focused?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  isLargeDevice?: boolean;
}) {
  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <View
        style={[
          styles.inputRow,
          focused && styles.inputRowFocused,
          isLargeDevice && stylesTv.inputRow,
          isLargeDevice && focused && stylesTv.inputRowFocused,
        ]}
      >
        <MaterialIcons name={icon} size={18} color={StreamingTheme.colors.textMuted} />
        <TextInput
          ref={inputRef}
          placeholder={placeholder}
          placeholderTextColor={StreamingTheme.colors.textMuted}
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={secureTextEntry}
          autoCapitalize="none"
          keyboardType={keyboardType}
          returnKeyType={returnKeyType}
          blurOnSubmit={blurOnSubmit}
          onSubmitEditing={onSubmitEditing}
          onFocus={onFocus}
          onBlur={onBlur}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },
  flex: { flex: 1 },
  scrollContent: { paddingHorizontal: 18, paddingBottom: 34, gap: 14 },
  hero: { alignItems: 'center', marginTop: 12, marginBottom: 4 },
  logoCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  brand: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: 1,
  },
  subtitle: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 14,
    marginTop: 6,
    textAlign: 'center',
    lineHeight: 20,
  },
  panel: {
    padding: 16,
    gap: 10,
  },
  typeBadge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,122,24,0.45)',
    backgroundColor: 'rgba(255,122,24,0.16)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  typeBadgeText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  panelTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 20,
  },
  helperText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 4,
  },
  label: {
    color: StreamingTheme.colors.textSecondary,
    marginBottom: 8,
    marginTop: 6,
    fontSize: 13,
    fontWeight: '700',
  },
  inputRow: {
    minHeight: 50,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    paddingHorizontal: 12,
    backgroundColor: StreamingTheme.colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  inputRowFocused: {
    borderColor: StreamingTheme.colors.accentAlt,
    borderWidth: 3,
  },
  input: {
    color: StreamingTheme.colors.textPrimary,
    flex: 1,
    fontSize: 15,
  },
  loginBtn: {
    marginTop: 12,
    borderRadius: 14,
    overflow: 'hidden',
  },
  loginGradient: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loginText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 16,
  },
  googleBtn: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  googleText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 15,
  },
  secondaryBtn: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  secondaryBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 14,
  },
  linkBtn: {
    minHeight: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkText: {
    color: StreamingTheme.colors.accentAlt,
    fontWeight: '700',
    fontSize: 14,
  },
  bootCheckWrap: {
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.03)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  bootCheckText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
});

const stylesTv = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 44,
    paddingBottom: 48,
  },
  hero: {
    marginTop: 22,
    marginBottom: 10,
  },
  brand: {
    fontSize: 44,
  },
  subtitle: {
    fontSize: 18,
    lineHeight: 26,
    maxWidth: 920,
  },
  panel: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 960,
    padding: 24,
    gap: 12,
  },
  inputRow: {
    minHeight: 64,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  inputRowFocused: {
    borderColor: StreamingTheme.colors.accentAlt,
    borderWidth: 5,
  },
  actionBtn: {
    minHeight: 62,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  actionBtnFocused: {
    borderColor: StreamingTheme.colors.accentAlt,
    borderWidth: 5,
  },
});