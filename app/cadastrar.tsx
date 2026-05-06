import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import { useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
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
import { StreamingTheme } from '@/constants/streaming-theme';
import { prepareAlgorithmOnboardingForFirstLogin } from '@/services/behavior-intelligence';
import { createUserWithEmail } from '@/services/cloud-sync';
import { registerPlanPushToken } from '@/services/plan-push-notifications';
import { resolvePostAuthTarget } from '@/services/post-auth-routing';
import { isNonMobileDevice } from '@/services/device-profile';

export default function CadastrarScreen() {
  const router = useRouter();
  const isLargeDevice = isNonMobileDevice();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [focusedField, setFocusedField] = useState<'name' | 'email' | 'password' | 'confirm' | ''>('');
  const [focusedAction, setFocusedAction] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const emailInputRef = useRef<TextInput>(null);
  const passwordInputRef = useRef<TextInput>(null);
  const confirmInputRef = useRef<TextInput>(null);
  const backBtnRef = useRef<TouchableOpacity>(null);
  const registerBtnRef = useRef<TouchableOpacity>(null);
  const xtreamBtnRef = useRef<TouchableOpacity>(null);
  const loginBtnRef = useRef<TouchableOpacity>(null);

  const onRegister = async () => {
    if (!name.trim() || !email.trim() || !password.trim() || !confirmPassword.trim()) {
      Alert.alert('Atencao', 'Preencha nome, e-mail, senha e confirmacao.');
      return;
    }

    if (password !== confirmPassword) {
      Alert.alert('Senha diferente', 'A confirmacao precisa ser igual a senha.');
      return;
    }

    try {
      setIsLoading(true);
      const session = await createUserWithEmail({ name, email, password });
      if (!isLargeDevice) {
        await prepareAlgorithmOnboardingForFirstLogin(session.user.id);
      }
      await registerPlanPushToken().catch(() => null);
      const target = await resolvePostAuthTarget();
      Alert.alert('Conta criada', 'Cadastro realizado com sucesso.');
      if (target === '/loading') {
        router.replace('/perfil-acesso?next=loading');
      } else {
        router.replace(target);
      }
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel criar a conta.'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <AppBackdrop blurIntensity={34} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.flex}>
        <ScrollView contentContainerStyle={[styles.content, isLargeDevice && stylesTv.content]} showsVerticalScrollIndicator={false}>
          <TouchableOpacity
            ref={backBtnRef}
            style={[styles.backBtn, isLargeDevice && stylesTv.focusableBtn, isLargeDevice && focusedAction === 'back' && stylesTv.focusableBtnFocused]}
            onPress={() => router.back()}
            onFocus={() => setFocusedAction('back')}
            onBlur={() => setFocusedAction('')}
            nextFocusDown={isLargeDevice ? (findNodeHandle(registerBtnRef.current) ?? undefined) : undefined}
          >
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>

          <View style={[styles.hero, isLargeDevice && stylesTv.hero]}>
            <Text style={styles.kicker}>CRIAR CONTA</Text>
            <Text style={[styles.title, isLargeDevice && stylesTv.title]}>Seu perfil no app</Text>
            <Text style={[styles.subtitle, isLargeDevice && stylesTv.subtitle]}>
              Cadastre-se para sincronizar foto, listas e configuracoes da sua conta.
            </Text>
          </View>

          <View style={[styles.panel, isLargeDevice && stylesTv.panel]}>
            <Field
              label="Nome"
              placeholder="Como voce quer aparecer"
              value={name}
              onChangeText={setName}
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => emailInputRef.current?.focus()}
              focused={focusedField === 'name'}
              onFocus={() => setFocusedField('name')}
              onBlur={() => setFocusedField('')}
              isLargeDevice={isLargeDevice}
            />
            <Field
              inputRef={emailInputRef}
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
              label="Senha"
              placeholder="Minimo 6 caracteres"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => confirmInputRef.current?.focus()}
              focused={focusedField === 'password'}
              onFocus={() => setFocusedField('password')}
              onBlur={() => setFocusedField('')}
              isLargeDevice={isLargeDevice}
            />
            <Field
              inputRef={confirmInputRef}
              label="Confirmar senha"
              placeholder="Repita sua senha"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry
              returnKeyType="done"
              onSubmitEditing={onRegister}
              focused={focusedField === 'confirm'}
              onFocus={() => setFocusedField('confirm')}
              onBlur={() => setFocusedField('')}
              isLargeDevice={isLargeDevice}
            />

            <TouchableOpacity
              ref={registerBtnRef}
              style={[styles.submitBtn, isLargeDevice && stylesTv.focusableBtn, isLargeDevice && focusedAction === 'register' && stylesTv.focusableBtnFocused]}
              onPress={onRegister}
              disabled={isLoading}
              onFocus={() => setFocusedAction('register')}
              onBlur={() => setFocusedAction('')}
              hasTVPreferredFocus={isLargeDevice}
              nextFocusUp={isLargeDevice ? (findNodeHandle(backBtnRef.current) ?? undefined) : undefined}
              nextFocusDown={isLargeDevice ? (findNodeHandle(xtreamBtnRef.current) ?? undefined) : undefined}
            >
              <LinearGradient colors={StreamingTheme.gradients.accent} style={styles.submitGradient}>
                {isLoading ? (
                  <ActivityIndicator color={StreamingTheme.colors.textPrimary} />
                ) : (
                  <>
                    <Text style={styles.submitText}>Cadastrar</Text>
                    <MaterialIcons name="arrow-forward" size={18} color={StreamingTheme.colors.textPrimary} />
                  </>
                )}
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity
              ref={xtreamBtnRef}
              style={[styles.linkBtn, isLargeDevice && stylesTv.focusableBtn, isLargeDevice && focusedAction === 'xtream' && stylesTv.focusableBtnFocused]}
              onPress={() => router.push('/xtream-login')}
              onFocus={() => setFocusedAction('xtream')}
              onBlur={() => setFocusedAction('')}
              nextFocusUp={isLargeDevice ? (findNodeHandle(registerBtnRef.current) ?? undefined) : undefined}
              nextFocusDown={isLargeDevice ? (findNodeHandle(loginBtnRef.current) ?? undefined) : undefined}
            >
              <Text style={styles.linkText}>Adicionar servidor Xtream</Text>
            </TouchableOpacity>

            <TouchableOpacity
              ref={loginBtnRef}
              style={[styles.linkBtn, isLargeDevice && stylesTv.focusableBtn, isLargeDevice && focusedAction === 'login' && stylesTv.focusableBtnFocused]}
              onPress={() => router.replace('/login')}
              onFocus={() => setFocusedAction('login')}
              onBlur={() => setFocusedAction('')}
              nextFocusUp={isLargeDevice ? (findNodeHandle(xtreamBtnRef.current) ?? undefined) : undefined}
            >
              <Text style={styles.linkText}>Ja tem conta? Entrar</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({
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
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        ref={inputRef}
        style={[
          styles.input,
          focused && styles.inputFocused,
          isLargeDevice && stylesTv.input,
          isLargeDevice && focused && stylesTv.inputFocused,
        ]}
        placeholder={placeholder}
        placeholderTextColor={StreamingTheme.colors.textMuted}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        returnKeyType={returnKeyType}
        blurOnSubmit={blurOnSubmit}
        onSubmitEditing={onSubmitEditing}
        autoCapitalize="none"
        onFocus={onFocus}
        onBlur={onBlur}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },
  flex: { flex: 1 },
  content: { paddingHorizontal: 18, paddingBottom: 34, gap: 16 },
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
  hero: { marginTop: 12, gap: 8 },
  kicker: {
    color: StreamingTheme.colors.accentAlt,
    fontWeight: '800',
    letterSpacing: 1,
    fontSize: 12,
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 30,
    fontWeight: '900',
  },
  subtitle: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
  },
  panel: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(18,24,40,0.92)',
    padding: 16,
    gap: 12,
  },
  label: {
    color: StreamingTheme.colors.textSecondary,
    marginBottom: 8,
    fontSize: 13,
    fontWeight: '700',
  },
  input: {
    minHeight: 50,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    color: StreamingTheme.colors.textPrimary,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  inputFocused: {
    borderColor: StreamingTheme.colors.accentAlt,
    borderWidth: 3,
  },
  submitBtn: {
    marginTop: 8,
    borderRadius: 16,
    overflow: 'hidden',
  },
  submitGradient: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  submitText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '800',
  },
  linkBtn: {
    minHeight: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 14,
    fontWeight: '700',
  },
});

const stylesTv = StyleSheet.create({
  content: {
    paddingHorizontal: 44,
    paddingBottom: 52,
  },
  hero: {
    marginTop: 20,
    gap: 10,
  },
  title: {
    fontSize: 42,
  },
  subtitle: {
    fontSize: 18,
    lineHeight: 28,
    maxWidth: 900,
  },
  panel: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 960,
    padding: 24,
    gap: 14,
  },
  input: {
    minHeight: 64,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  inputFocused: {
    borderWidth: 5,
    borderColor: StreamingTheme.colors.accentAlt,
  },
  focusableBtn: {
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  focusableBtnFocused: {
    borderWidth: 5,
    borderColor: StreamingTheme.colors.accentAlt,
  },
});