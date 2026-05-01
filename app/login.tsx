import { Feather, MaterialIcons } from '@expo/vector-icons';
import { getDbValue } from '@/services/local-db';
import { LinearGradient } from 'expo-linear-gradient';
import { Link, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { PageLoader } from '@/components/page-loader';
import { StreamingTheme } from '@/constants/streaming-theme';
import { hasLocalCatalogDataQuick } from '@/services/catalog-data';
import { enableDemoMode } from '@/services/demo-mode';
import { useLogin } from '../hooks/UseLogin';
import { LoginUserStream } from '../services/login';

export default function LoginScreen() {
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isDemoLoading, setIsDemoLoading] = useState(false);
  const {
    _Name,
    SetName,
    _Usuario,
    SetUsuario,
    _Senha,
    SetSenha,
    _Url,
    SetUrl,
    _Loanding,
    SetLoading,
  } = useLogin();

  const router = useRouter();

  useEffect(() => {
    const bootstrap = async () => {
      const userDb = await getDbValue<string>('username');
      if (userDb) {
        const hasLocalCatalog = await hasLocalCatalogDataQuick();
        router.replace(hasLocalCatalog ? '/(tabs)' : '/loading');
        return;
      }
      setIsLoading(false);
    };

    bootstrap();
  }, [router]);

  const handleLogin = async () => {
    if (!_Name || !_Usuario || !_Senha || !_Url) {
      Alert.alert('Atencao', 'Preencha todos os campos para continuar.');
      return;
    }

    SetLoading(true);
    const result = await LoginUserStream(_Name, _Usuario, _Senha, _Url);

    if (result !== 'Ok') {
      Alert.alert('Erro', 'Nao foi possivel conectar ao servidor com estes dados.');
      SetLoading(false);
      return;
    }

    router.replace('/loading');
  };

  const handleDemoMode = async () => {
    try {
      setIsDemoLoading(true);
      await enableDemoMode();
      router.replace('/loading');
    } catch {
      Alert.alert('Erro', 'Nao foi possivel iniciar o modo demo.');
      setIsDemoLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <AppBackdrop blurIntensity={34} />
      <PageLoader visible={isLoading} label="Verificando acesso" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.hero}>
            <View style={styles.logoCircle}>
              <MaterialIcons name="live-tv" size={34} color={StreamingTheme.colors.textPrimary} />
            </View>
            <Text style={styles.brand}>AS IPTV PLAYER</Text>
            <Text style={styles.subtitle}>Uma interface de cinema, feita para maratonar.</Text>
          </View>

          <GlassSurface style={styles.panel} intensity={40}>
            <Text style={styles.panelTitle}>Entrar na sua conta</Text>

            <Field
              icon="badge"
              label="Nome da conta"
              placeholder="Ex: MinhaCasa"
              value={_Name}
              onChangeText={SetName}
            />

            <Field
              icon="person"
              label="Usuario"
              placeholder="Seu usuario"
              value={_Usuario}
              onChangeText={SetUsuario}
            />

            <Text style={styles.label}>Senha</Text>
            <View style={styles.inputRow}>
              <Feather name="lock" size={18} color={StreamingTheme.colors.textMuted} />
              <TextInput
                placeholder="Sua senha"
                placeholderTextColor={StreamingTheme.colors.textMuted}
                secureTextEntry={!showPassword}
                style={styles.input}
                value={_Senha}
                onChangeText={SetSenha}
              />
              <TouchableOpacity onPress={() => setShowPassword((prev) => !prev)}>
                <Feather
                  name={showPassword ? 'eye-off' : 'eye'}
                  size={18}
                  color={StreamingTheme.colors.textSecondary}
                />
              </TouchableOpacity>
            </View>

            <Field
              icon="link"
              label="URL do servidor"
              placeholder="http://seuservidor.com"
              value={_Url}
              onChangeText={SetUrl}
              keyboardType="url"
            />

            <TouchableOpacity style={styles.loginBtn} onPress={handleLogin} disabled={_Loanding}>
              <LinearGradient colors={StreamingTheme.gradients.accent} style={styles.loginGradient}>
                {_Loanding ? (
                  <ActivityIndicator color={StreamingTheme.colors.textPrimary} />
                ) : (
                  <>
                    <Text style={styles.loginText}>Conectar agora</Text>
                    <MaterialIcons name="arrow-forward" size={20} color={StreamingTheme.colors.textPrimary} />
                  </>
                )}
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity style={styles.demoBtn} onPress={handleDemoMode} disabled={isDemoLoading || _Loanding}>
              {isDemoLoading ? (
                <ActivityIndicator color={StreamingTheme.colors.textPrimary} />
              ) : (
                <>
                  <MaterialIcons name="smart-display" size={18} color={StreamingTheme.colors.textPrimary} />
                  <Text style={styles.demoBtnText}>Entrar no modo demo (sem Xtream)</Text>
                </>
              )}
            </TouchableOpacity>

            <Text style={styles.demoHint}>
              Ideal para revisao de loja: carrega catalogo local de teste sem credenciais.
            </Text>
          </GlassSurface>

          <View style={styles.featureRow}>
            <Feature icon="4k" title="Imagem" desc="Qualidade premium" />
            <Feature icon="speed" title="Rapido" desc="Player otimizado" />
            <Feature icon="download" title="Offline" desc="Baixe e assista" />
          </View>

          <View style={styles.footerRow}>
            <Link href="/ajuda" style={styles.helpLink}>
              Precisa de ajuda?
            </Link>
            <Text style={styles.version}>v1.0.0  </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

type FieldProps = {
  icon: keyof typeof MaterialIcons.glyphMap;
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  keyboardType?: 'default' | 'url';
};

function Field({ icon, label, placeholder, value, onChangeText, keyboardType = 'default' }: FieldProps) {
  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.inputRow}>
        <MaterialIcons name={icon} size={18} color={StreamingTheme.colors.textMuted} />
        <TextInput
          placeholder={placeholder}
          placeholderTextColor={StreamingTheme.colors.textMuted}
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          autoCapitalize="none"
          keyboardType={keyboardType}
        />
      </View>
    </>
  );
}

function Feature({ icon, title, desc }: { icon: keyof typeof MaterialIcons.glyphMap; title: string; desc: string }) {
  return (
    <GlassSurface style={styles.featureCard} intensity={28}>
      <MaterialIcons name={icon} size={20} color={StreamingTheme.colors.accentAlt} />
      <Text style={styles.featureTitle}>{title}</Text>
      <Text style={styles.featureDesc}>{desc}</Text>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },
  flex: { flex: 1 },
  scrollContent: { paddingHorizontal: 18, paddingBottom: 34 },
  hero: { alignItems: 'center', marginTop: 12, marginBottom: 18 },
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
  },
  panel: {
    padding: 16,
    marginBottom: 16,
  },
  panelTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 20,
    marginBottom: 12,
  },
  label: {
    color: StreamingTheme.colors.textSecondary,
    marginBottom: 8,
    marginTop: 8,
    fontSize: 13,
    fontWeight: '700',
  },
  inputRow: {
    height: 50,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    paddingHorizontal: 12,
    backgroundColor: StreamingTheme.colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  input: {
    color: StreamingTheme.colors.textPrimary,
    flex: 1,
    fontSize: 15,
  },
  loginBtn: {
    marginTop: 16,
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
  demoBtn: {
    marginTop: 10,
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.08)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
  },
  demoBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 13,
  },
  demoHint: {
    marginTop: 8,
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
  featureRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  featureCard: {
    flex: 1,
    padding: 12,
  },
  featureTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
    marginTop: 8,
    fontSize: 13,
  },
  featureDesc: {
    color: StreamingTheme.colors.textMuted,
    marginTop: 4,
    fontSize: 11,
  },
  footerRow: {
    marginTop: 18,
    alignItems: 'center',
    gap: 8,
  },
  helpLink: {
    color: StreamingTheme.colors.info,
    fontWeight: '700',
  },
  version: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
  },
});
