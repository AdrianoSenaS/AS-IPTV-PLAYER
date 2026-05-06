import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackdrop } from '@/components/app-backdrop';
import { FeatureGate } from '@/components/feature-gate';
import { PageLoader } from '@/components/page-loader';
import { StreamingTheme } from '@/constants/streaming-theme';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { getAppServerUrl } from '@/services/app-server';
import { getProxyAdvancedOptions, isProxyEnabled, setProxyAdvancedOptions, setProxyEnabled, wrapUrlWithProxy } from '@/services/proxy-settings';

type HealthState = 'idle' | 'ok' | 'error';

export default function ConfiguracoesProxyScreen() {
  const router = useRouter();
  const { hasFeature, loading: planLoading } = usePlanGate();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [health, setHealth] = useState<HealthState>('idle');
  const [statusText, setStatusText] = useState('Proxy desativado.');
  const [upstreamProxyUrl, setUpstreamProxyUrl] = useState('');
  const [dnsResolver, setDnsResolver] = useState('');

  const proxyLocked = !planLoading && !hasFeature('network_proxy');

  const checkProxyHealth = useCallback(async (active: boolean) => {
    if (!active) {
      setHealth('idle');
      setStatusText('Proxy desativado. O player usa URL direta do provedor.');
      return;
    }

    setIsChecking(true);
    try {
      const base = await getAppServerUrl();
      const probeWrapped = await wrapUrlWithProxy('https://example.com/video/test.m3u8');
      const isWrapped = /\/api\/proxy\?/i.test(probeWrapped);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${base}/health`, { signal: controller.signal });
      clearTimeout(timeout);

      if (isWrapped && response.ok) {
        setHealth('ok');
        setStatusText('Proxy ativo e servidor respondeu com sucesso.');
      } else {
        setHealth('error');
        setStatusText('Proxy ativo, mas nao foi possivel validar o servidor agora.');
      }
    } catch {
      setHealth('error');
      setStatusText('Proxy ativo, mas sem resposta do servidor no teste.');
    } finally {
      setIsChecking(false);
    }
  }, []);

  const hydrate = useCallback(async () => {
    setIsLoading(true);
    try {
      const [active, advanced] = await Promise.all([
        isProxyEnabled().catch(() => false),
        getProxyAdvancedOptions().catch(() => ({ upstreamProxyUrl: '', dnsResolver: '' })),
      ]);
      setEnabled(active);
      setUpstreamProxyUrl(String(advanced.upstreamProxyUrl || ''));
      setDnsResolver(String(advanced.dnsResolver || ''));
      await checkProxyHealth(active);
    } finally {
      setIsLoading(false);
    }
  }, [checkProxyHealth]);

  useFocusEffect(
    useCallback(() => {
      void hydrate();
      return () => {};
    }, [hydrate])
  );

  const onToggle = async (next: boolean) => {
    if (proxyLocked) {
      router.push({ pathname: '/assinar', params: { feature: 'network_proxy' } } as any);
      return;
    }

    try {
      setIsSaving(true);
      await setProxyEnabled(next);
      setEnabled(next);
      await checkProxyHealth(next);
      Alert.alert('Proxy de rede', next ? 'Proxy ativado com sucesso.' : 'Proxy desativado com sucesso.');
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel alterar o proxy.'));
    } finally {
      setIsSaving(false);
    }
  };

  const onSaveAdvanced = async () => {
    if (proxyLocked) {
      router.push({ pathname: '/assinar', params: { feature: 'network_proxy' } } as any);
      return;
    }

    try {
      setIsSaving(true);
      await setProxyAdvancedOptions({ upstreamProxyUrl, dnsResolver });
      await checkProxyHealth(enabled);
      Alert.alert('Proxy de rede', 'Configuracao de proxy secundario e DNS salva com sucesso.');
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel salvar as configuracoes de proxy.'));
    } finally {
      setIsSaving(false);
    }
  };

  const badge = useMemo(() => {
    if (!enabled) return { color: StreamingTheme.colors.textMuted, text: 'OFF' };
    if (health === 'ok') return { color: '#2CD07F', text: 'ONLINE' };
    if (health === 'error') return { color: '#FF8F3A', text: 'ATENCAO' };
    return { color: StreamingTheme.colors.accentAlt, text: 'TESTANDO' };
  }, [enabled, health]);

  return (
    <FeatureGate feature="network_proxy" locked={proxyLocked}>
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <AppBackdrop blurIntensity={28} />
        <PageLoader visible={isLoading || isSaving || isChecking} label={isLoading ? 'Carregando proxy' : 'Aplicando configuracao'} />

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.headerRow}>
            <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
              <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
            </TouchableOpacity>
            <View style={styles.headerTextWrap}>
              <Text style={styles.kicker}>REDE AVANCADA</Text>
              <Text style={styles.title}>Proxy de rede</Text>
            </View>
            <View style={styles.iconBtn} />
          </View>

          <View style={styles.card}>
            <View style={styles.toggleRow}>
              <View style={styles.toggleTextWrap}>
                <Text style={styles.toggleLabel}>Ativar proxy de rede</Text>
                <Text style={styles.toggleCaption}>
                  Quando ligado, filmes, series e TV ao vivo sao roteados via servidor para contornar bloqueios de rede/VPN.
                </Text>
              </View>
              <Switch
                value={enabled}
                onValueChange={onToggle}
                thumbColor={StreamingTheme.colors.textPrimary}
                trackColor={{ false: 'rgba(255,255,255,0.2)', true: 'rgba(255,59,48,0.55)' }}
              />
            </View>

            <View style={styles.statusBox}>
              <View style={[styles.badge, { borderColor: badge.color }]}> 
                <Text style={[styles.badgeText, { color: badge.color }]}>{badge.text}</Text>
              </View>
              <Text style={styles.statusText}>{statusText}</Text>
            </View>

            <TouchableOpacity style={styles.actionBtn} onPress={() => checkProxyHealth(enabled)}>
              <MaterialIcons name="network-check" size={18} color={StreamingTheme.colors.textPrimary} />
              <Text style={styles.actionText}>Verificar funcionamento agora</Text>
            </TouchableOpacity>

            <View style={styles.advancedBox}>
              <Text style={styles.sectionTitle}>Proxy secundario e DNS</Text>
              <Text style={styles.sectionCaption}>
                Opcional: informe outro proxy de saida e DNS customizado para depuracao e roteamento avancado.
              </Text>

              <Text style={styles.inputLabel}>Outro proxy (URL)</Text>
              <TextInput
                value={upstreamProxyUrl}
                onChangeText={setUpstreamProxyUrl}
                placeholder="http://usuario:senha@host:porta"
                placeholderTextColor={StreamingTheme.colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />

              <Text style={styles.inputLabel}>DNS</Text>
              <TextInput
                value={dnsResolver}
                onChangeText={setDnsResolver}
                placeholder="1.1.1.1 ou dns.exemplo.com"
                placeholderTextColor={StreamingTheme.colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />

              <TouchableOpacity style={styles.saveBtn} onPress={onSaveAdvanced}>
                <MaterialIcons name="save" size={18} color={StreamingTheme.colors.textPrimary} />
                <Text style={styles.actionText}>Salvar proxy secundario e DNS</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </FeatureGate>
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
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(18,24,40,0.9)',
    padding: 12,
    gap: 10,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  toggleTextWrap: {
    flex: 1,
    gap: 4,
  },
  toggleLabel: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '900',
  },
  toggleCaption: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  statusBox: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: 10,
    gap: 8,
  },
  badge: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  statusText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  actionBtn: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  actionText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 13,
  },
  advancedBox: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: 10,
    gap: 8,
  },
  sectionTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '900',
    fontSize: 14,
  },
  sectionCaption: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  inputLabel: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(6,10,18,0.8)',
    color: StreamingTheme.colors.textPrimary,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 13,
  },
  saveBtn: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
});
