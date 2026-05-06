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
import { StreamingTheme } from '@/constants/streaming-theme';
import { hasLocalCatalogDataQuick } from '@/services/catalog-data';
import { isNonMobileDevice } from '@/services/device-profile';
import { formatXtreamUrlInput, loadAccountSettings } from '@/services/account-settings';
import { enableDemoMode } from '@/services/demo-mode';
import { LoginUserStream } from '@/services/login';

export default function XtreamLoginScreen() {
  const router = useRouter();
  const isLargeDevice = isNonMobileDevice();
  const [allowHttps, setAllowHttps] = useState(false);
  const [isXtreamLoading, setIsXtreamLoading] = useState(false);
  const [isDemoLoading, setIsDemoLoading] = useState(false);
  const [focusedField, setFocusedField] = useState<'serverName' | 'serverUser' | 'serverPassword' | 'serverUrl' | ''>('');
  const [focusedAction, setFocusedAction] = useState('');
  const userInputRef = useRef<TextInput>(null);
  const passwordInputRef = useRef<TextInput>(null);
  const urlInputRef = useRef<TextInput>(null);
  const backBtnRef = useRef<TouchableOpacity>(null);
  const loginBtnRef = useRef<TouchableOpacity>(null);
  const protocolBtnRef = useRef<TouchableOpacity>(null);
  const demoBtnRef = useRef<TouchableOpacity>(null);

  const [serverName, setServerName] = useState('');
  const [serverUser, setServerUser] = useState('');
  const [serverPassword, setServerPassword] = useState('');
  const [serverUrl, setServerUrl] = useState('');

  useEffect(() => {
    loadAccountSettings().then((settings) => {
      setAllowHttps(settings.serverConnection.allowHttps);
    });
  }, []);

  const onXtreamLogin = async () => {
    const normalizedUrl = formatXtreamUrlInput(serverUrl, allowHttps);
    if (!serverUser.trim() || !serverPassword.trim() || !normalizedUrl) {
      Alert.alert('Atencao', 'Preencha URL, usuario e senha do servidor Xtream.');
      return;
    }

    setServerUrl(normalizedUrl);

    try {
      setIsXtreamLoading(true);
      const result = await LoginUserStream(
        serverName.trim() || 'Servidor principal',
        serverUser.trim(),
        serverPassword,
        normalizedUrl
      );

      if (result !== 'Ok') {
        Alert.alert('Erro', 'Nao foi possivel conectar ao servidor com estes dados.');
        return;
      }

      const hasLocalCatalog = await hasLocalCatalogDataQuick();
      router.replace(hasLocalCatalog ? '/loading' : '/loading');
    } finally {
      setIsXtreamLoading(false);
    }
  };

  const onDemoMode = async () => {
    try {
      setIsDemoLoading(true);
      await enableDemoMode();
      router.replace('/loading');
    } catch {
      Alert.alert('Erro', 'Nao foi possivel iniciar o modo demo.');
    } finally {
      setIsDemoLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <AppBackdrop blurIntensity={34} />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.flex}>
        <ScrollView
          contentContainerStyle={[styles.scrollContent, isLargeDevice && stylesTv.scrollContent]}
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity
            ref={backBtnRef}
            style={[
              styles.backBtn,
              isLargeDevice && stylesTv.focusableBtn,
              isLargeDevice && focusedAction === 'back' && stylesTv.focusedBtn,
            ]}
            onPress={() => router.replace('/login')}
            onFocus={() => setFocusedAction('back')}
            onBlur={() => setFocusedAction('')}
            nextFocusDown={isLargeDevice ? (findNodeHandle(loginBtnRef.current) ?? undefined) : undefined}
          >
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>

          <View style={[styles.hero, isLargeDevice && stylesTv.hero]}>
            <View style={styles.logoCircle}>
              <MaterialIcons name="live-tv" size={34} color={StreamingTheme.colors.textPrimary} />
            </View>
            <Text style={[styles.brand, isLargeDevice && stylesTv.brand]}>XTREAM CODE</Text>
            <Text style={[styles.subtitle, isLargeDevice && stylesTv.subtitle]}>Conecte seu servidor para carregar canais, filmes e series.</Text>
          </View>

          <GlassSurface style={[styles.panel, isLargeDevice && stylesTv.panel]} intensity={40}>
            <View style={styles.typeBadge}>
              <MaterialIcons name="live-tv" size={14} color={StreamingTheme.colors.textPrimary} />
              <Text style={styles.typeBadgeText}>LOGIN XTREAM CODE</Text>
            </View>
            <Text style={styles.panelTitle}>Entrar com Xtream Code</Text>
            <Text style={styles.helperText}>
              Esta tela e separada do login da conta do app. Aqui voce conecta somente os dados do servidor Xtream.
            </Text>

            <Field
              icon="badge"
              label="Nome do servidor"
              placeholder="Ex: Casa"
              value={serverName}
              onChangeText={setServerName}
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => userInputRef.current?.focus()}
              focused={focusedField === 'serverName'}
              onFocus={() => setFocusedField('serverName')}
              onBlur={() => setFocusedField('')}
              isLargeDevice={isLargeDevice}
            />
            <Field
              inputRef={userInputRef}
              icon="person-outline"
              label="Usuario Xtream"
              placeholder="Seu usuario"
              value={serverUser}
              onChangeText={setServerUser}
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => passwordInputRef.current?.focus()}
              focused={focusedField === 'serverUser'}
              onFocus={() => setFocusedField('serverUser')}
              onBlur={() => setFocusedField('')}
              isLargeDevice={isLargeDevice}
            />
            <Field
              inputRef={passwordInputRef}
              icon="lock-outline"
              label="Senha"
              placeholder="Sua senha"
              value={serverPassword}
              onChangeText={setServerPassword}
              secureTextEntry
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => urlInputRef.current?.focus()}
              focused={focusedField === 'serverPassword'}
              onFocus={() => setFocusedField('serverPassword')}
              onBlur={() => setFocusedField('')}
              isLargeDevice={isLargeDevice}
            />
            <Field
              inputRef={urlInputRef}
              icon="link"
              label="URL do servidor"
              placeholder="http://servidor.com"
              value={serverUrl}
              onChangeText={(value) =>
                setServerUrl(allowHttps ? value : value.replace(/^https:\/\//i, 'http://'))
              }
              onBlur={() => {
                setFocusedField('');
                setServerUrl((current) => formatXtreamUrlInput(current, allowHttps));
              }}
              onFocus={() => setFocusedField('serverUrl')}
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={onXtreamLogin}
              focused={focusedField === 'serverUrl'}
              isLargeDevice={isLargeDevice}
            />

            <TouchableOpacity
              ref={loginBtnRef}
              style={[
                styles.loginBtn,
                isLargeDevice && stylesTv.focusableBtn,
                isLargeDevice && focusedAction === 'login' && stylesTv.focusedBtn,
              ]}
              onPress={onXtreamLogin}
              disabled={isXtreamLoading}
              onFocus={() => setFocusedAction('login')}
              onBlur={() => setFocusedAction('')}
              hasTVPreferredFocus={isLargeDevice}
              nextFocusUp={isLargeDevice ? (findNodeHandle(backBtnRef.current) ?? undefined) : undefined}
              nextFocusDown={isLargeDevice ? (findNodeHandle(protocolBtnRef.current) ?? undefined) : undefined}
            >
              <LinearGradient colors={StreamingTheme.gradients.accent} style={styles.loginGradient}>
                {isXtreamLoading ? (
                  <ActivityIndicator color={StreamingTheme.colors.textPrimary} />
                ) : (
                  <>
                    <Text style={styles.loginText}>Entrar com Xtream</Text>
                    <MaterialIcons name="arrow-forward" size={20} color={StreamingTheme.colors.textPrimary} />
                  </>
                )}
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity
              ref={protocolBtnRef}
              style={[
                styles.secondaryBtn,
                isLargeDevice && stylesTv.focusableBtn,
                isLargeDevice && focusedAction === 'protocol' && stylesTv.focusedBtn,
              ]}
              onPress={() => router.push('/configuracoes-servidores')}
              onFocus={() => setFocusedAction('protocol')}
              onBlur={() => setFocusedAction('')}
              nextFocusUp={isLargeDevice ? (findNodeHandle(loginBtnRef.current) ?? undefined) : undefined}
              nextFocusDown={isLargeDevice ? (findNodeHandle(demoBtnRef.current) ?? undefined) : undefined}
            >
              <MaterialIcons name="settings-ethernet" size={18} color={StreamingTheme.colors.textPrimary} />
              <Text style={styles.secondaryBtnText}>Ajustar protocolo HTTP e HTTPS</Text>
            </TouchableOpacity>

            <TouchableOpacity
              ref={demoBtnRef}
              style={[
                styles.demoBtn,
                isLargeDevice && stylesTv.focusableBtn,
                isLargeDevice && focusedAction === 'demo' && stylesTv.focusedBtn,
              ]}
              onPress={onDemoMode}
              disabled={isDemoLoading || isXtreamLoading}
              onFocus={() => setFocusedAction('demo')}
              onBlur={() => setFocusedAction('')}
              nextFocusUp={isLargeDevice ? (findNodeHandle(protocolBtnRef.current) ?? undefined) : undefined}
            >
              {isDemoLoading ? (
                <ActivityIndicator color={StreamingTheme.colors.textPrimary} />
              ) : (
                <>
                  <MaterialIcons name="smart-display" size={18} color={StreamingTheme.colors.textPrimary} />
                  <Text style={styles.demoBtnText}>Entrar no modo demo</Text>
                </>
              )}
            </TouchableOpacity>
          </GlassSurface>
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
  onBlur,
  onFocus,
  inputRef,
  returnKeyType = 'done',
  blurOnSubmit = true,
  onSubmitEditing,
  focused = false,
  isLargeDevice = false,
}: {
  icon: keyof typeof MaterialIcons.glyphMap;
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'url';
  onBlur?: () => void;
  onFocus?: () => void;
  inputRef?: React.RefObject<TextInput | null>;
  returnKeyType?: 'next' | 'done';
  blurOnSubmit?: boolean;
  onSubmitEditing?: () => void;
  focused?: boolean;
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
          isLargeDevice && focused && stylesTv.focusedBtn,
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
          onBlur={onBlur}
          onFocus={onFocus}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },
  flex: { flex: 1 },
  scrollContent: { paddingHorizontal: 18, paddingBottom: 34, gap: 14 },
  backBtn: {
    marginTop: 8,
    width: 42,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  demoBtn: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  demoBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    fontSize: 14,
  },
});

const stylesTv = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 44,
    paddingBottom: 48,
  },
  hero: {
    marginTop: 22,
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
  focusableBtn: {
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  focusedBtn: {
    borderWidth: 5,
    borderColor: StreamingTheme.colors.accentAlt,
  },
});