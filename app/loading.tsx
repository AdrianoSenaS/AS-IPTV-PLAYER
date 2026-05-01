import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackdrop } from '@/components/app-backdrop';
import { StreamingTheme } from '@/constants/streaming-theme';
import { resetAccessSessionForLaunch, shouldRequireProfileSelection } from '@/services/access-control';
import {
  clearCatalogStaging,
  commitCatalogStaging,
  getCatalogLastUpdate,
  hasLocalCatalogDataQuick,
  invalidateCatalogCache,
  stageCatalogCategories,
  stageCatalogItems,
  setCatalogLastUpdate,
  StreamItem,
} from '../services/catalog-data';
import { isDemoModeEnabled } from '@/services/demo-mode';
import { getDbValue } from '@/services/local-db';
import { hasInternetConnection } from '@/services/network';
import { loadCatalogRefreshPeriod, shouldRefreshCatalog } from '@/services/update-schedule';

type StepStatus = 'pending' | 'loading' | 'done' | 'error';

type Step = {
  id: number;
  action: string;
  title: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  fileName?: string;
};

const steps: Step[] = [
  { id: 0, action: 'test', title: 'Teste de conexao', icon: 'wifi-protected-setup' },
  { id: 1, action: 'get_live_categories', title: 'Categorias ao vivo', icon: 'tv' , fileName: 'iptv_liveCategories.json' },
  { id: 2, action: 'get_live_streams', title: 'Canais ao vivo', icon: 'live-tv', fileName: 'iptv_liveStreams.json' },
  { id: 3, action: 'get_vod_categories', title: 'Categorias de filmes', icon: 'category', fileName: 'iptv_vodCategories.json' },
  { id: 4, action: 'get_vod_streams', title: 'Catalogo de filmes', icon: 'movie', fileName: 'iptv_vodStreams.json' },
  { id: 5, action: 'get_series_categories', title: 'Categorias de series', icon: 'view-list', fileName: 'iptv_seriesCategories.json' },
  { id: 6, action: 'get_series', title: 'Catalogo de series', icon: 'smart-display', fileName: 'iptv_series.json' },
  { id: 7, action: 'get_epg', title: 'Guia EPG', icon: 'schedule', fileName: 'iptv_epg.json' },
];

type Credentials = {
  url: string;
  username: string;
  password: string;
};

async function api(action: string, credentials: Credentials) {
  const endpoint = `${credentials.url}/player_api.php?username=${credentials.username}&password=${credentials.password}&action=${action}`;
  return (await fetch(endpoint)).json();
}

async function saveDataStream(fileName: string, data: object) {
  const fileUri = `${FileSystem.documentDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(fileUri, JSON.stringify(data));
}

export default function LoadingScreen() {
  const router = useRouter();
  const [logs, setLogs] = useState<string[]>([]);
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [stepStates, setStepStates] = useState<Record<number, StepStatus>>({});
  const [progress, setProgress] = useState(0);
  const [loadingDone, setLoadingDone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const heroPulse = useState(() => new Animated.Value(0))[0];
  const activeStepPulse = useState(() => new Animated.Value(0))[0];
  const progressShimmer = useState(() => new Animated.Value(0))[0];

  const appendLog = (value: string) => {
    setLogs((prev) => [...prev, value].slice(-8));
  };

  const markStep = (stepId: number, status: StepStatus) => {
    setStepStates((prev) => ({ ...prev, [stepId]: status }));
  };

  const runLoad = async () => {
    try {
      setFailure(null);

      const [lastUpdate, period, hasLocalData] = await Promise.all([
        getCatalogLastUpdate(),
        loadCatalogRefreshPeriod(),
        hasLocalCatalogDataQuick(),
      ]);

      const shouldRefreshNow = shouldRefreshCatalog(lastUpdate, period) || !hasLocalData;

      if (!shouldRefreshNow) {
        appendLog('Catalogo local atualizado. Pulando sincronizacao remota.');
        setProgress(100);
        setLoadingDone(true);
        await resetAccessSessionForLaunch();
        const requireProfileSelection = await shouldRequireProfileSelection();
        setTimeout(() => {
          router.replace(requireProfileSelection ? '/perfil-acesso' : '/(tabs)');
        }, 120);
        return;
      }

      const hasInternet = await hasInternetConnection();
      if (!hasInternet) {
        if (hasLocalData) {
          appendLog('Sem internet. Usando catalogo local salvo.');
          setProgress(100);
          setLoadingDone(true);
          await resetAccessSessionForLaunch();
          const requireProfileSelection = await shouldRequireProfileSelection();
          setTimeout(() => {
            router.replace(requireProfileSelection ? '/perfil-acesso' : '/(tabs)');
          }, 120);
          return;
        }

        appendLog('Sem internet. Abrindo modo offline com downloads.');
        setProgress(100);
        setLoadingDone(true);
        setTimeout(() => {
          router.replace('/offline');
        }, 120);
        return;
      }

      if (await isDemoModeEnabled()) {
        appendLog('Modo demo ativo. Pulando sincronizacao remota...');
        setProgress(100);
        setLoadingDone(true);
        await resetAccessSessionForLaunch();
        const requireProfileSelection = await shouldRequireProfileSelection();
        setTimeout(() => {
          router.replace(requireProfileSelection ? '/perfil-acesso' : '/(tabs)');
        }, 120);
        return;
      }

      appendLog('Iniciando sincronizacao da plataforma...');

      const [url, username, password] = await Promise.all([
        getDbValue<string>('url'),
        getDbValue<string>('username'),
        getDbValue<string>('password'),
      ]);

      if (!url || !username || !password) {
        router.replace('/login');
        return;
      }

      const credentials: Credentials = { url, username, password };
      await clearCatalogStaging();

      for (const step of steps) {
        setCurrentStep(step.id);
        markStep(step.id, 'loading');

        try {
          if (step.action === 'test') {
            const testData = await api('get_live_categories', credentials);
            if (testData?.error) {
              throw new Error(`${step.title}: ${testData.error}`);
            }
            appendLog('Conexao com servidor validada.');
          } else {
            const data = await api(step.action, credentials);
            if (data?.error) {
              throw new Error(`${step.title}: ${data.error}`);
            }

            if (step.fileName) {
              // Mantemos os arquivos apenas como fallback para debug/manutenção.
              await saveDataStream(step.fileName, data);
            }

            const list: StreamItem[] = Array.isArray(data) ? (data as StreamItem[]) : [];
            appendLog(`${step.title}: ${list.length} itens`);

            if (step.action === 'get_live_categories') {
              appendLog(`Preparando ${list.length} categorias ao vivo para salvar no banco...`);
              await stageCatalogCategories('live', list);
            } else if (step.action === 'get_live_streams') {
              appendLog(`Preparando ${list.length} canais ao vivo para salvar no banco...`);
              await stageCatalogItems('live', list);
            } else if (step.action === 'get_vod_categories') {
              appendLog(`Preparando ${list.length} categorias de filmes para salvar no banco...`);
              await stageCatalogCategories('vod', list);
            } else if (step.action === 'get_vod_streams') {
              appendLog(`Preparando ${list.length} filmes para salvar no banco...`);
              await stageCatalogItems('vod', list);
            } else if (step.action === 'get_series_categories') {
              appendLog(`Preparando ${list.length} categorias de series para salvar no banco...`);
              await stageCatalogCategories('series', list);
            } else if (step.action === 'get_series') {
              appendLog(`Preparando ${list.length} series para salvar no banco...`);
              await stageCatalogItems('series', list);
            }
          }
        } catch (stepError: any) {
          if (step.action === 'get_epg') {
            appendLog('EPG nao carregado. Continuando sem guia.');
            if (step.fileName) {
              try {
                await saveDataStream(step.fileName, []);
              } catch {
                // Falha de persistencia local do EPG nao pode bloquear a entrada no app.
                appendLog('Nao foi possivel salvar fallback do EPG localmente.');
              }
            }
          } else {
            markStep(step.id, 'error');
            throw stepError;
          }
        }

        markStep(step.id, 'done');
        setProgress(Math.round(((step.id + 1) / steps.length) * 100));
      }

      appendLog('Aplicando catalogo completo no banco local...');
      await commitCatalogStaging();
      invalidateCatalogCache();

      try {
        const syncAt = new Date().toISOString();
        await setCatalogLastUpdate(syncAt);
      } catch {
        // Falha ao registrar data de sincronizacao nao deve bloquear o acesso.
        appendLog('Catalogo salvo, mas nao foi possivel registrar a data da sincronizacao.');
      }

      appendLog('Tudo pronto. Entrando na sua home...');
      setLoadingDone(true);
      await resetAccessSessionForLaunch();
      const requireProfileSelection = await shouldRequireProfileSelection();

      setTimeout(() => {
        router.replace(requireProfileSelection ? '/perfil-acesso' : '/(tabs)');
      }, 180);
    } catch (error: any) {
      await clearCatalogStaging().catch(() => {
        // Mantem o catalogo oficial intacto mesmo se a limpeza temporaria falhar.
      });
      const failureMessage = error?.message ?? 'Falha na sincronizacao';
      setFailure(failureMessage);
      appendLog(`Falha obrigatoria: ${failureMessage}`);
    }
  };

  useEffect(() => {
    runLoad();
  }, []);

  useEffect(() => {
    if (loadingDone || failure) {
      heroPulse.stopAnimation();
      activeStepPulse.stopAnimation();
      progressShimmer.stopAnimation();
      return;
    }

    const heroLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(heroPulse, {
          toValue: 1,
          duration: 1800,
          useNativeDriver: true,
        }),
        Animated.timing(heroPulse, {
          toValue: 0,
          duration: 1800,
          useNativeDriver: true,
        }),
      ])
    );

    const stepLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(activeStepPulse, {
          toValue: 1,
          duration: 950,
          useNativeDriver: true,
        }),
        Animated.timing(activeStepPulse, {
          toValue: 0,
          duration: 950,
          useNativeDriver: true,
        }),
      ])
    );

    const shimmerLoop = Animated.loop(
      Animated.timing(progressShimmer, {
        toValue: 1,
        duration: 1600,
        useNativeDriver: true,
      })
    );

    heroLoop.start();
    stepLoop.start();
    shimmerLoop.start();

    return () => {
      heroLoop.stop();
      stepLoop.stop();
      shimmerLoop.stop();
      heroPulse.setValue(0);
      activeStepPulse.setValue(0);
      progressShimmer.setValue(0);
    };
  }, [activeStepPulse, failure, heroPulse, loadingDone, progressShimmer]);

  const doneCount = useMemo(
    () => Object.values(stepStates).filter((status) => status === 'done').length,
    [stepStates]
  );

  const activeStepMeta = useMemo(
    () => steps.find((step) => step.id === currentStep) ?? steps[0],
    [currentStep]
  );

  const recentLogs = useMemo(() => [...logs].reverse(), [logs]);

  const heroAnimatedStyle = useMemo(
    () => ({
      transform: [
        {
          scale: heroPulse.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 1.015],
          }),
        },
      ],
      opacity: heroPulse.interpolate({
        inputRange: [0, 1],
        outputRange: [0.96, 1],
      }),
    }),
    [heroPulse]
  );

  const activePulseStyle = useMemo(
    () => ({
      transform: [
        {
          scale: activeStepPulse.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 1.03],
          }),
        },
      ],
      opacity: activeStepPulse.interpolate({
        inputRange: [0, 1],
        outputRange: [0.92, 1],
      }),
    }),
    [activeStepPulse]
  );

  const shimmerTranslate = useMemo(
    () =>
      progressShimmer.interpolate({
        inputRange: [0, 1],
        outputRange: [-220, 220],
      }),
    [progressShimmer]
  );

  const retry = () => {
    setFailure(null);
    setStepStates({});
    setProgress(0);
    setLoadingDone(false);
    setLogs([]);
    runLoad();
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={32} />

      <View style={styles.header}>
        <View style={styles.kickerRow}>
          <View style={styles.liveDot} />
          <Text style={styles.kicker}>Sincronizacao inteligente</Text>
        </View>
        <Text style={styles.title}>Preparando seu streaming</Text>
        <Text style={styles.subtitle}>
          Sincronizando catalogos, categorias e canais do seu servidor para uma experiencia local mais fluida.
        </Text>
      </View>

      <Animated.View style={[styles.heroCard, heroAnimatedStyle]}>
        <LinearGradient colors={StreamingTheme.gradients.card} style={styles.heroGradient}>
          <View style={styles.heroTop}>
            <View style={styles.heroIconWrap}>
              <MaterialIcons name={activeStepMeta.icon} size={22} color={StreamingTheme.colors.textPrimary} />
            </View>
            <View style={styles.heroTextWrap}>
              <Text style={styles.heroLabel}>Etapa atual</Text>
              <Text style={styles.heroTitle}>{activeStepMeta.title}</Text>
            </View>
            {!loadingDone && !failure ? (
              <ActivityIndicator size="small" color={StreamingTheme.colors.accentAlt} />
            ) : null}
          </View>

          <View style={styles.statsRow}>
            <View style={styles.statChip}>
              <Text style={styles.statValue}>{doneCount}</Text>
              <Text style={styles.statLabel}>etapas prontas</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statChip}>
              <Text style={styles.statValue}>{steps.length - doneCount}</Text>
              <Text style={styles.statLabel}>restantes</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statChip}>
              <Text style={styles.statValue}>{progress}%</Text>
              <Text style={styles.statLabel}>concluido</Text>
            </View>
          </View>
        </LinearGradient>
      </Animated.View>

      <View style={styles.noticeCard}>
        <MaterialIcons name="schedule" size={18} color={StreamingTheme.colors.warning} />
        <View style={styles.noticeContent}>
          <Text style={styles.noticeTitle}>Tempo estimado de sincronizacao</Text>
          <Text style={styles.noticeText}>
            Dependendo da velocidade do servidor e do volume do catalogo, a sincronizacao pode demorar de 30 minutos a 2 horas.
            Em servidores com mais de 100 mil conteudos, esse tempo pode variar ainda mais.
          </Text>
        </View>
      </View>

      <View style={styles.progressCard}>
        <View style={styles.progressTop}>
          <Text style={styles.progressLabel}>Progresso total</Text>
          <Text style={styles.progressValue}>{progress}%</Text>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress}%` }]} />
          <View style={[styles.progressGlow, { left: `${Math.max(0, progress - 12)}%` }]} />
          {!loadingDone && !failure ? (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.progressShimmer,
                { transform: [{ translateX: shimmerTranslate }] },
              ]}
            />
          ) : null}
        </View>
        <Text style={styles.progressFoot}>{doneCount}/{steps.length} etapas concluidas</Text>
      </View>

      <View style={styles.logCard}>
        <View style={styles.logHeader}>
          <Text style={styles.logTitle}>Atividade recente</Text>
          <Text style={styles.logCount}>{logs.length} eventos</Text>
        </View>
        {recentLogs.length ? (
          recentLogs.slice(0, 4).map((entry, index) => (
            <View key={`${entry}-${index}`} style={styles.logRow}>
              <View style={styles.logBullet} />
              <Text style={styles.logText}>{entry}</Text>
            </View>
          ))
        ) : (
          <Text style={styles.logEmpty}>Aguardando inicio da sincronizacao...</Text>
        )}
      </View>

      <ScrollView style={styles.stepsList} contentContainerStyle={styles.stepsContent}>
        {steps.map((step) => {
          const status = stepStates[step.id] ?? 'pending';
          const isActive = currentStep === step.id && status === 'loading';
          const iconName = status === 'done' ? 'check-circle' : status === 'error' ? 'error' : step.icon;
          const iconColor =
            status === 'done'
              ? StreamingTheme.colors.success
              : status === 'error'
                ? StreamingTheme.colors.accent
                : status === 'loading'
                  ? StreamingTheme.colors.accentAlt
                  : StreamingTheme.colors.textMuted;

          return (
            <Animated.View
              key={step.id}
              style={[styles.stepCard, isActive && styles.stepCardActive, isActive && activePulseStyle]}
            >
              <Animated.View style={[styles.stepIconWrap, isActive && styles.stepIconWrapActive]}>
                <MaterialIcons name={iconName as any} size={20} color={iconColor} />
              </Animated.View>
              <View style={styles.stepInfo}>
                <View style={styles.stepTitleRow}>
                  <Text style={styles.stepTitle}>{step.title}</Text>
                  {isActive ? <Text style={styles.stepBadge}>Agora</Text> : null}
                </View>
                <Text style={styles.stepState}>
                  {status === 'pending' && 'Aguardando'}
                  {status === 'loading' && 'Carregando...'}
                  {status === 'done' && 'Concluido'}
                  {status === 'error' && 'Falhou'}
                </Text>
              </View>
            </Animated.View>
          );
        })}
      </ScrollView>


      {failure && (
        <>
          <View style={styles.failureCard}>
            <Text style={styles.failureTitle}>Falha na sincronizacao obrigatoria</Text>
            <Text style={styles.failureMessage} numberOfLines={2}>{failure}</Text>
          </View>
          <TouchableOpacity style={styles.retryBtn} onPress={retry}>
            <MaterialIcons name="refresh" size={18} color={StreamingTheme.colors.textPrimary} />
            <Text style={styles.retryText}>Tentar novamente</Text>
          </TouchableOpacity>
        </>
      )}

      {loadingDone && (
        <TouchableOpacity
          style={styles.enterBtn}
          onPress={async () => {
            const requireProfileSelection = await shouldRequireProfileSelection();
            router.replace(requireProfileSelection ? '/perfil-acesso' : '/(tabs)');
          }}
        >
          <LinearGradient colors={StreamingTheme.gradients.accent} style={styles.enterGradient}>
            <Text style={styles.enterText}>Entrar agora</Text>
          </LinearGradient>
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: StreamingTheme.colors.background,
    paddingHorizontal: 18,
    paddingBottom: 24,
  },
  bgOrbPrimary: {
    position: 'absolute',
    top: 72,
    right: -54,
    width: 168,
    height: 168,
    borderRadius: 999,
    backgroundColor: 'rgba(255,59,48,0.16)',
  },
  bgOrbSecondary: {
    position: 'absolute',
    top: 210,
    left: -46,
    width: 126,
    height: 126,
    borderRadius: 999,
    backgroundColor: 'rgba(255,143,58,0.10)',
  },
  header: {
    marginTop: 8,
    marginBottom: 14,
  },
  kickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: StreamingTheme.colors.accentAlt,
  },
  kicker: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 30,
    fontWeight: '900',
  },
  subtitle: {
    color: StreamingTheme.colors.textSecondary,
    marginTop: 6,
    lineHeight: 21,
  },
  heroCard: {
    borderRadius: 22,
    overflow: 'hidden',
    marginBottom: 12,
  },
  heroGradient: {
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    padding: 16,
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  heroIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  heroTextWrap: {
    flex: 1,
    marginLeft: 12,
    marginRight: 10,
  },
  heroLabel: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
  },
  heroTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '900',
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.10)',
    paddingTop: 14,
  },
  statChip: {
    flex: 1,
  },
  statDivider: {
    width: 1,
    height: 28,
    backgroundColor: 'rgba(255,255,255,0.10)',
    marginHorizontal: 10,
  },
  statValue: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '900',
  },
  statLabel: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    marginTop: 3,
  },
  noticeCard: {
    flexDirection: 'row',
    gap: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,200,87,0.20)',
    backgroundColor: 'rgba(255,200,87,0.08)',
    borderRadius: 18,
    padding: 14,
    marginBottom: 12,
  },
  noticeContent: {
    flex: 1,
  },
  noticeTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    marginBottom: 4,
  },
  noticeText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  progressCard: {
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(16,21,37,0.88)',
    borderRadius: 18,
    padding: 14,
    marginBottom: 12,
  },
  progressTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  progressLabel: { color: StreamingTheme.colors.textSecondary, fontWeight: '700' },
  progressValue: { color: StreamingTheme.colors.textPrimary, fontWeight: '900', fontSize: 20 },
  progressTrack: {
    height: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)',
    marginTop: 10,
    overflow: 'hidden',
    position: 'relative',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: StreamingTheme.colors.accent,
  },
  progressGlow: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '18%',
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  progressShimmer: {
    position: 'absolute',
    top: -6,
    bottom: -6,
    width: 84,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  progressFoot: {
    marginTop: 8,
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
  },
  logCard: {
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(10,14,24,0.72)',
    borderRadius: 18,
    padding: 14,
    marginBottom: 12,
  },
  logHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  logTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
  },
  logCount: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  logRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 8,
  },
  logBullet: {
    width: 7,
    height: 7,
    borderRadius: 999,
    marginTop: 6,
    backgroundColor: StreamingTheme.colors.accentAlt,
  },
  logText: {
    flex: 1,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  logEmpty: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
  },
  stepsList: {
    flex: 1,
  },
  stepsContent: {
    gap: 10,
    paddingBottom: 14,
  },
  stepCard: {
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    borderRadius: 16,
    padding: 12,
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  stepCardActive: {
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    borderColor: 'rgba(255,143,58,0.42)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.22,
    shadowRadius: 16,
    elevation: 3,
  },
  stepIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  stepIconWrapActive: {
    backgroundColor: 'rgba(255,143,58,0.12)',
  },
  stepInfo: {
    flex: 1,
  },
  stepTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  stepTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
  },
  stepBadge: {
    color: StreamingTheme.colors.accentAlt,
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  stepState: {
    marginTop: 2,
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
  },
  failureCard: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,120,120,0.35)',
    borderRadius: 14,
    backgroundColor: 'rgba(120,22,22,0.26)',
    padding: 12,
  },
  failureTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    marginBottom: 4,
  },
  failureMessage: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
  },
  retryBtn: {
    marginTop: 10,
    height: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  retryText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
  },
  enterBtn: {
    marginTop: 12,
    borderRadius: 14,
    overflow: 'hidden',
  },
  enterGradient: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  enterText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 16,
  },
});
