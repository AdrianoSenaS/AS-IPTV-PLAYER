import { MaterialIcons } from '@expo/vector-icons';
import { getDbValue } from '@/services/local-db';
import * as Notifications from 'expo-notifications';

import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  AppStateStatus,
  Image,
  RefreshControl,
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

import { FeatureGate } from '@/components/feature-gate';
import { PageLoader } from '@/components/page-loader';
import { AppBackdrop } from '@/components/app-backdrop';
import { StreamingTheme } from '@/constants/streaming-theme';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { getParentalMonitorAccess, loadAccountSettings } from '@/services/account-settings';
import {
  blockContent,
  checkServerHealth,
  ensureRealtimeSessionForActiveProfile,
  fetchBlockedContent,
  getRealtimeHealthDiagnostics,
  fetchParentalActivity,
  fetchParentalRules,
  fetchPresenceSnapshot,
  ParentalActivity,
  ParentalAlertEvent,
  RealtimeHealthDiagnostics,
  ParentalRules,
  ProfilePresence,
  ServerHealthState,
  saveParentalRules,
  unblockContent,
} from '@/services/realtime-presence';
import { fetchTmdbContentDetailsByTitle, fetchTmdbMetaByTitle, TmdbContentDetails, TmdbMeta } from '@/services/tmdb';
import { loadUserLists, UserListItem } from '@/services/user-lists';

function formatRelative(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 60_000) return 'agora';
  if (diff < 3_600_000) return `ha ${Math.floor(diff / 60_000)} min`;
  return `ha ${Math.floor(diff / 3_600_000)}h`;
}

function formatIso(iso: string) {
  const date = new Date(String(iso || ''));
  if (!Number.isFinite(date.getTime())) return '--';
  return date.toLocaleString('pt-BR');
}

function contentTypeLabel(type: string): string {
  if (type === 'movie') return 'Filme';
  if (type === 'series') return 'Serie';
  if (type === 'live') return 'Ao vivo';
  return type;
}

function formatDurationFromMinutes(totalMinutes: number): string {
  const safe = Math.max(0, Math.round(Number(totalMinutes || 0)));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

type SelectedProfileRealtimeDetails = {
  loading: boolean;
  fetchedAt: string;
  meta: TmdbMeta | null;
  details: TmdbContentDetails | null;
};

const AGGRESSIVE_PRESETS = {
  leve: {
    label: 'Leve',
    forbiddenSearchKeywords: ['adult', '18+'],
    maxMinutesPerHour: 120,
    maxContinuousMinutes: 160,
    progressivePenaltyEnabled: true,
    penaltyWindowMinutes: 240,
    step2BlockMinutes: 10,
    step3BlockMinutes: 45,
  },
  normal: {
    label: 'Normal',
    forbiddenSearchKeywords: ['adult', '18+', 'porn', 'xxx', 'sexo'],
    maxMinutesPerHour: 90,
    maxContinuousMinutes: 120,
    progressivePenaltyEnabled: true,
    penaltyWindowMinutes: 180,
    step2BlockMinutes: 20,
    step3BlockMinutes: 120,
  },
  extremo: {
    label: 'Extremo',
    forbiddenSearchKeywords: ['adult', '18+', 'porn', 'xxx', 'sexo', 'aposta', 'drogas', 'violencia'],
    maxMinutesPerHour: 45,
    maxContinuousMinutes: 60,
    progressivePenaltyEnabled: true,
    penaltyWindowMinutes: 120,
    step2BlockMinutes: 30,
    step3BlockMinutes: 240,
  },
} as const;

type AggressivePresetKey = keyof typeof AGGRESSIVE_PRESETS;

export default function MonitorParentalScreen() {
  const router = useRouter();
  const { hasFeature, loading: planLoading } = usePlanGate();

  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [serverState, setServerState] = useState<ServerHealthState>('offline');
  const [healthDiagnostics, setHealthDiagnostics] = useState<RealtimeHealthDiagnostics | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [accessDeniedMessage, setAccessDeniedMessage] = useState('');
  const [isPrimaryManager, setIsPrimaryManager] = useState(false);
  const [allowedManagedProfileIds, setAllowedManagedProfileIds] = useState<string[]>([]);

  const [profiles, setProfiles] = useState<ProfilePresence[]>([]);
  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [selectedActivity, setSelectedActivity] = useState<ParentalActivity | null>(null);
  const [parentalRules, setParentalRules] = useState<ParentalRules | null>(null);
  const [alertFeed, setAlertFeed] = useState<ParentalAlertEvent[]>([]);
  const [keywordsInput, setKeywordsInput] = useState('adult, 18+, porn, xxx, sexo');
  const [rulesSaving, setRulesSaving] = useState(false);
  const [showProfileSubpage, setShowProfileSubpage] = useState(false);
  const [clockTick, setClockTick] = useState(Date.now());
  const [selectedProfileRealtime, setSelectedProfileRealtime] = useState<SelectedProfileRealtimeDetails>({
    loading: false,
    fetchedAt: '',
    meta: null,
    details: null,
  });
  const [watchLaterItems, setWatchLaterItems] = useState<UserListItem[]>([]);

  const appStateRef = useRef(AppState.currentState);
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const parentalRulesRef = useRef<ParentalRules | null>(null);
  const monitorLocked = !planLoading && !hasFeature('realtime_monitor');

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.profileId === selectedProfileId) || null,
    [profiles, selectedProfileId]
  );

  const selectedWatchingElapsedMinutes = useMemo(() => {
    if (!selectedProfile?.watching?.since) return 0;
    return Math.max(0, Math.round((clockTick - Number(selectedProfile.watching.since || clockTick)) / 60_000));
  }, [selectedProfile?.watching?.since, clockTick]);

  const selectedSessionElapsedMinutes = useMemo(() => {
    if (!selectedProfile?.connectedAt) return 0;
    return Math.max(0, Math.round((clockTick - Number(selectedProfile.connectedAt || clockTick)) / 60_000));
  }, [selectedProfile?.connectedAt, clockTick]);

  const selectedEstimatedProgressPercent = useMemo(() => {
    const runtime = Number(selectedProfileRealtime.details?.runtimeMinutes || 0);
    if (!runtime || runtime <= 0) return null;
    const pct = Math.round((selectedWatchingElapsedMinutes / runtime) * 100);
    return Math.max(0, Math.min(100, pct));
  }, [selectedProfileRealtime.details?.runtimeMinutes, selectedWatchingElapsedMinutes]);

  const onlineCount = useMemo(() => profiles.filter((profile) => profile.online).length, [profiles]);
  const allowedManagedSet = useMemo(() => new Set(allowedManagedProfileIds), [allowedManagedProfileIds]);

  const canMonitorProfile = useCallback(
    (profileId: string) => {
      if (!profileId) return false;
      if (isPrimaryManager) return true;
      return allowedManagedSet.has(profileId);
    },
    [isPrimaryManager, allowedManagedSet]
  );

  const filterAllowedProfiles = useCallback(
    (list: ProfilePresence[]) => {
      if (isPrimaryManager) return list;
      return list.filter((item) => allowedManagedSet.has(item.profileId));
    },
    [isPrimaryManager, allowedManagedSet]
  );

  const refreshMonitorAccess = useCallback(async () => {
    const settings = await loadAccountSettings();
    const access = getParentalMonitorAccess(settings);
    setIsPrimaryManager(access.isPrimaryManager);
    setAllowedManagedProfileIds(access.allowedProfileIds);
    setAccessDeniedMessage(access.canAccess ? '' : access.deniedReason || 'Acesso ao monitor parental bloqueado.');
    return access;
  }, []);

  const serverBadge = useMemo(() => {
    if (serverState === 'online') {
      return { color: '#22C55E', icon: 'wifi', text: `${onlineCount} online` };
    }
    if (serverState === 'overloaded') {
      return { color: '#F59E0B', icon: 'warning-amber', text: 'Servidor sobrecarregado' };
    }
    return { color: '#EF4444', icon: 'wifi-off', text: 'Servidor offline' };
  }, [serverState, onlineCount]);

  const loadSelectedActivity = useCallback(async (profileId: string) => {
    if (!profileId || !canMonitorProfile(profileId)) {
      setSelectedActivity(null);
      return;
    }

    const activity = await fetchParentalActivity(profileId);
    setSelectedActivity(activity);
  }, [canMonitorProfile]);

  const pollMonitorData = useCallback(async (options?: { includeRules?: boolean }) => {
    const [snapResult, healthResult, blockedResult, rulesResult] = await Promise.allSettled([
      fetchPresenceSnapshot(),
      checkServerHealth(),
      fetchBlockedContent(),
      options?.includeRules ? fetchParentalRules() : Promise.resolve(null),
    ]);

    const snap = snapResult.status === 'fulfilled' ? snapResult.value : [];
    const health = healthResult.status === 'fulfilled' ? healthResult.value : 'offline';
    const blocked = blockedResult.status === 'fulfilled' ? blockedResult.value : [];
    const rulesMaybe = rulesResult.status === 'fulfilled' ? rulesResult.value : null;

    const allowedProfiles = filterAllowedProfiles(snap);
    setProfiles(allowedProfiles);
    setServerState(health);
    setHealthDiagnostics(getRealtimeHealthDiagnostics());
    setBlockedIds(blocked);

    if (rulesMaybe) {
      setParentalRules(rulesMaybe);
      if (rulesMaybe.forbiddenSearchKeywords?.length) {
        setKeywordsInput(rulesMaybe.forbiddenSearchKeywords.join(', '));
      }
    }

    const targetProfileId =
      selectedProfileId && allowedProfiles.some((item) => item.profileId === selectedProfileId)
        ? selectedProfileId
        : allowedProfiles[0]?.profileId || '';

    if (targetProfileId !== selectedProfileId) {
      setSelectedProfileId(targetProfileId);
    }

    if (targetProfileId) {
      const activity = await fetchParentalActivity(targetProfileId);
      setSelectedActivity(activity);
    } else {
      setSelectedActivity(null);
    }
  }, [filterAllowedProfiles, selectedProfileId]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const access = await refreshMonitorAccess();
      if (!access.canAccess) {
        setProfiles([]);
        setSelectedProfileId('');
        setSelectedActivity(null);
        return;
      }

      await ensureRealtimeSessionForActiveProfile();
      await pollMonitorData({ includeRules: true });
    } finally {
      setRefreshing(false);
    }
  }, [refreshMonitorAccess, pollMonitorData]);

  const handleBlockNow = useCallback(async (profile: ProfilePresence) => {
    if (!profile.watching) {
      Alert.alert('Sem reproducao', 'Este perfil nao esta assistindo nada agora.');
      return;
    }

    Alert.alert(
      'Bloquear em tempo real',
      `Bloquear "${profile.watching.contentTitle}" agora para ${profile.profileName}?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Bloquear',
          style: 'destructive',
          onPress: async () => {
            const ok = await blockContent(
              profile.profileId,
              profile.watching!.contentId,
              profile.watching!.contentTitle
            );
            if (!ok) {
              Alert.alert('Erro', 'Nao foi possivel bloquear em tempo real.');
            }
          },
        },
      ]
    );
  }, []);

  const handleOpenRealtimeMirror = useCallback((profile: ProfilePresence) => {
    const watching = profile.watching;
    const previewUrl = String(watching?.previewUrl || '').trim();
    if (!watching || !previewUrl) {
      Alert.alert('Preview indisponivel', 'Este perfil ainda nao enviou uma URL de preview em tempo real.');
      return;
    }

    router.push({
      pathname: '/player',
      params: {
        mode: watching.contentType === 'series' ? 'series' : watching.contentType === 'live' ? 'live' : 'movie',
        contentId: String(watching.contentId || ''),
        title: String(watching.contentTitle || `Preview ${profile.profileName}`),
        url: previewUrl,
        posterUrl: String(watching.posterUrl || ''),
      },
    } as any);
  }, [router]);

  const requestNotifications = useCallback(async () => {
    const { status } = await Notifications.requestPermissionsAsync();
    setNotifEnabled(status === 'granted');
    if (status !== 'granted') {
      Alert.alert('Permissao negada', 'Ative notificacoes no dispositivo para receber alertas parentais.');
    }
  }, []);

  const saveAggressiveRules = useCallback(async (overrideRules?: ParentalRules, overrideKeywordsInput?: string) => {
    const rulesSnapshot = overrideRules || parentalRulesRef.current;
    if (!rulesSnapshot) return false;

    const keywords = String(overrideKeywordsInput ?? keywordsInput)
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    setRulesSaving(true);
    try {
      const saved = await saveParentalRules({
        ...rulesSnapshot,
        forbiddenSearchKeywords: keywords,
      });

      if (!saved) {
        Alert.alert('Erro', 'Nao foi possivel salvar regras agressivas.');
        return false;
      }

      setParentalRules(saved);
      return true;
    } finally {
      setRulesSaving(false);
    }
  }, [keywordsInput]);

  const updateRulesAndPersist = useCallback((patch: Partial<ParentalRules>) => {
    setParentalRules((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      void saveAggressiveRules(next);
      return next;
    });
  }, [saveAggressiveRules]);

  const applyAggressivePreset = useCallback((presetKey: AggressivePresetKey) => {
    const preset = AGGRESSIVE_PRESETS[presetKey];
    const nextKeywordsInput = preset.forbiddenSearchKeywords.join(', ');
    setKeywordsInput(nextKeywordsInput);
    setParentalRules((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        aggressiveMode: true,
        autoBlockOnForbiddenSearch: true,
        criticalAlertsEnabled: true,
        progressivePenaltyEnabled: preset.progressivePenaltyEnabled,
        penaltyWindowMinutes: preset.penaltyWindowMinutes,
        step2BlockMinutes: preset.step2BlockMinutes,
        step3BlockMinutes: preset.step3BlockMinutes,
        forbiddenSearchKeywords: [...preset.forbiddenSearchKeywords],
        maxMinutesPerHour: preset.maxMinutesPerHour,
        maxContinuousMinutes: preset.maxContinuousMinutes,
      };
      void saveAggressiveRules(next, nextKeywordsInput);
      return next;
    });
  }, [saveAggressiveRules]);

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const username = await getDbValue<string>('username');
        if (!username) {
          setIsLoggedIn(false);
          setIsLoading(false);
          return;
        }

        setIsLoggedIn(true);
        const { status } = await Notifications.getPermissionsAsync();
        setNotifEnabled(status === 'granted');

        const access = await refreshMonitorAccess();
        if (!access.canAccess) {
          setProfiles([]);
          setSelectedProfileId('');
          setSelectedActivity(null);
          setIsLoading(false);
          return;
        }

        await ensureRealtimeSessionForActiveProfile();
        await pollMonitorData({ includeRules: true });
      } finally {
        setIsLoading(false);
      }
    };

    if (monitorLocked) {
      setIsLoading(false);
      return;
    }

    void bootstrap();
  }, [monitorLocked, refreshMonitorAccess, pollMonitorData]);

  useEffect(() => {
    if (!selectedProfileId) return;
    if (!canMonitorProfile(selectedProfileId)) {
      setSelectedProfileId('');
      setSelectedActivity(null);
      return;
    }
    void loadSelectedActivity(selectedProfileId);
    setShowProfileSubpage(false);
  }, [selectedProfileId, loadSelectedActivity, canMonitorProfile]);

  useEffect(() => {
    parentalRulesRef.current = parentalRules;
  }, [parentalRules]);

  useEffect(() => {
    const timer = setInterval(() => {
      setClockTick(Date.now());
    }, 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const loadWatchingDetails = async () => {
      if (!selectedProfile?.watching?.contentTitle) {
        setSelectedProfileRealtime({ loading: false, fetchedAt: '', meta: null, details: null });
        return;
      }

      const kind = selectedProfile.watching.contentType === 'series' ? 'tv' : 'movie';
      const title = String(selectedProfile.watching.contentTitle || '').trim();

      setSelectedProfileRealtime((prev) => ({ ...prev, loading: true }));
      try {
        const [meta, details] = await Promise.all([
          fetchTmdbMetaByTitle(kind, title),
          fetchTmdbContentDetailsByTitle(kind, title),
        ]);
        setSelectedProfileRealtime({
          loading: false,
          fetchedAt: new Date().toISOString(),
          meta,
          details,
        });
      } catch {
        setSelectedProfileRealtime({ loading: false, fetchedAt: '', meta: null, details: null });
      }
    };

    void loadWatchingDetails();
  }, [selectedProfile?.watching?.contentTitle, selectedProfile?.watching?.contentType]);

  useEffect(() => {
    const loadWatchLater = async () => {
      if (!showProfileSubpage) return;
      try {
        const lists = await loadUserLists();
        const watchLater =
          lists.find((list) => /assistir\s*mais\s*tarde|watch\s*later/i.test(String(list.name || ''))) ||
          lists[0] ||
          null;
        setWatchLaterItems((watchLater?.items || []).slice(0, 8));
      } catch {
        setWatchLaterItems([]);
      }
    };
    void loadWatchLater();
  }, [showProfileSubpage, selectedProfileId]);

  useEffect(() => {
    if (monitorLocked) return;

    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }

    pollingTimerRef.current = setInterval(() => {
      void pollMonitorData();
    }, 10_000);

    return () => {
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    };
  }, [monitorLocked, pollMonitorData]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextState: AppStateStatus) => {
      if (nextState === 'active' && appStateRef.current !== 'active') {
        const access = await refreshMonitorAccess();
        if (!access.canAccess) {
          setProfiles([]);
          setSelectedProfileId('');
          setSelectedActivity(null);
          appStateRef.current = nextState;
          return;
        }

        await ensureRealtimeSessionForActiveProfile();
        await pollMonitorData();
      }
      appStateRef.current = nextState;
    });

    return () => subscription.remove();
  }, [refreshMonitorAccess, pollMonitorData]);

  const minutesByHourRows = useMemo(() => {
    const map = selectedActivity?.minutesByHour || {};
    const rows = Object.keys(map)
      .map((hour) => ({ hour, minutes: Number(map[hour] || 0) }))
      .filter((row) => row.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 8);

    const max = rows.length ? Math.max(...rows.map((row) => row.minutes)) : 1;

    return rows.map((row) => ({
      ...row,
      widthPct: `${Math.max(8, Math.round((row.minutes / max) * 100))}%`,
    }));
  }, [selectedActivity]);

  if (!isLoading && !isLoggedIn) {
    return (
      <FeatureGate feature="realtime_monitor" locked={monitorLocked}>
        <SafeAreaView style={styles.container}>
          <StatusBar barStyle="light-content" />
          <AppBackdrop blurIntensity={28} />
          <View style={styles.emptyBox}>
            <MaterialIcons name="lock" size={48} color={StreamingTheme.colors.textMuted} />
            <Text style={styles.emptyTitle}>Conta obrigatoria</Text>
            <Text style={styles.emptyDesc}>Faca login para habilitar monitoramento parental completo.</Text>
            <TouchableOpacity style={styles.loginBtn} onPress={() => router.replace('/login')}>
              <Text style={styles.loginBtnText}>Fazer login</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </FeatureGate>
    );
  }

  if (isLoading) {
    return (
      <FeatureGate feature="realtime_monitor" locked={monitorLocked}>
        <SafeAreaView style={styles.container}>
          <AppBackdrop blurIntensity={28} />
          <PageLoader visible label="Carregando monitor parental" />
        </SafeAreaView>
      </FeatureGate>
    );
  }

  if (!isLoading && isLoggedIn && accessDeniedMessage) {
    return (
      <FeatureGate feature="realtime_monitor" locked={monitorLocked}>
        <SafeAreaView style={styles.container}>
          <StatusBar barStyle="light-content" />
          <AppBackdrop blurIntensity={28} />
          <View style={styles.emptyBox}>
            <MaterialIcons name="lock-outline" size={48} color={StreamingTheme.colors.textMuted} />
            <Text style={styles.emptyTitle}>Acesso bloqueado</Text>
            <Text style={styles.emptyDesc}>{accessDeniedMessage}</Text>
            <TouchableOpacity style={styles.loginBtn} onPress={() => router.push('/configuracoes-perfis' as any)}>
              <Text style={styles.loginBtnText}>Gerenciar permissoes</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </FeatureGate>
    );
  }

  return (
    <FeatureGate feature="realtime_monitor" locked={monitorLocked}>
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <AppBackdrop blurIntensity={28} />

        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>Controle Parental Agressivo</Text>
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, { backgroundColor: serverBadge.color, marginRight: 5 }]} />
              <Text style={styles.headerSub}>{serverBadge.text}</Text>
            </View>
          </View>
          <TouchableOpacity onPress={handleRefresh} style={styles.backBtn}>
            <MaterialIcons name="refresh" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={StreamingTheme.colors.accent} />}
        >
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>SERVIDOR</Text>
            <View style={styles.urlRow}>
              <MaterialIcons name={serverBadge.icon as any} size={18} color={serverBadge.color} />
              <Text style={styles.urlText}>{serverBadge.text}</Text>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>DIAGNOSTICO REST</Text>
            <View style={styles.listCard}>
              <Text style={styles.diagRowText}>Estado: {healthDiagnostics?.state || 'offline'}</Text>
              <Text style={styles.diagRowText}>URL ativa: {healthDiagnostics?.activeUrl || '--'}</Text>
              <Text style={styles.diagRowText}>Token de sessao: {healthDiagnostics?.tokenPresent ? 'presente' : 'ausente'}</Text>
              <Text style={styles.diagRowText}>Ultima verificacao: {healthDiagnostics?.checkedAt ? formatIso(healthDiagnostics.checkedAt) : '--'}</Text>
              <Text style={styles.diagRowText}>Ultimo erro: {healthDiagnostics?.lastError || '--'}</Text>

              {(healthDiagnostics?.attempts || []).slice(0, 8).map((attempt, index) => (
                <View key={`${attempt.url}-${attempt.endpoint}-${index}`} style={styles.diagAttemptRow}>
                  <Text style={styles.diagAttemptMain} numberOfLines={1}>
                    {attempt.endpoint} • {attempt.url}
                  </Text>
                  <Text style={styles.diagAttemptMeta}>
                    {attempt.ok ? `HTTP ${attempt.httpStatus}` : (attempt.error || 'falha')} • {attempt.durationMs}ms • {attempt.resolvedState}
                  </Text>
                </View>
              ))}

              {!(healthDiagnostics?.attempts || []).length ? (
                <Text style={styles.emptyListText}>Sem tentativas de health registradas ainda.</Text>
              ) : null}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>ALERTAS</Text>
            <TouchableOpacity style={styles.notifRow} onPress={notifEnabled ? undefined : requestNotifications}>
              <MaterialIcons
                name={notifEnabled ? 'notifications-active' : 'notifications-off'}
                size={18}
                color={notifEnabled ? StreamingTheme.colors.accent : StreamingTheme.colors.textMuted}
              />
              <Text style={[styles.notifText, !notifEnabled && { color: StreamingTheme.colors.textMuted }]}>
                {notifEnabled
                  ? 'Alertas em tempo real ativos para entrada, busca e reproducao da crianca.'
                  : 'Toque para ativar alertas parentais em tempo real.'}
              </Text>
            </TouchableOpacity>
          </View>

          {parentalRules ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>MODO AGRESSIVO</Text>
              <View style={styles.listCard}>
                <View style={styles.ruleRow}>
                  <Text style={styles.ruleLabel}>Ativar modo agressivo</Text>
                  <Switch
                    value={!!parentalRules.aggressiveMode}
                    onValueChange={(value) => updateRulesAndPersist({ aggressiveMode: value })}
                    thumbColor={StreamingTheme.colors.textPrimary}
                    trackColor={{ false: 'rgba(255,255,255,0.2)', true: 'rgba(255,59,48,0.55)' }}
                  />
                </View>

                <View style={styles.ruleRow}>
                  <Text style={styles.ruleLabel}>Bloqueio automatico por busca proibida</Text>
                  <Switch
                    value={!!parentalRules.autoBlockOnForbiddenSearch}
                    onValueChange={(value) => updateRulesAndPersist({ autoBlockOnForbiddenSearch: value })}
                    thumbColor={StreamingTheme.colors.textPrimary}
                    trackColor={{ false: 'rgba(255,255,255,0.2)', true: 'rgba(255,59,48,0.55)' }}
                  />
                </View>

                <View style={styles.ruleRow}>
                  <Text style={styles.ruleLabel}>Alerta critico de limite</Text>
                  <Switch
                    value={!!parentalRules.criticalAlertsEnabled}
                    onValueChange={(value) => updateRulesAndPersist({ criticalAlertsEnabled: value })}
                    thumbColor={StreamingTheme.colors.textPrimary}
                    trackColor={{ false: 'rgba(255,255,255,0.2)', true: 'rgba(255,59,48,0.55)' }}
                  />
                </View>

                <View style={styles.ruleRow}>
                  <Text style={styles.ruleLabel}>Punicao progressiva (1 alerta, 2 bloqueio, 3 bloqueio severo)</Text>
                  <Switch
                    value={!!parentalRules.progressivePenaltyEnabled}
                    onValueChange={(value) => updateRulesAndPersist({ progressivePenaltyEnabled: value })}
                    thumbColor={StreamingTheme.colors.textPrimary}
                    trackColor={{ false: 'rgba(255,255,255,0.2)', true: 'rgba(255,59,48,0.55)' }}
                  />
                </View>

                <Text style={styles.ruleFieldLabel}>Presets de severidade</Text>
                <View style={styles.presetRow}>
                  {(Object.keys(AGGRESSIVE_PRESETS) as AggressivePresetKey[]).map((presetKey) => (
                    <TouchableOpacity
                      key={presetKey}
                      style={styles.presetBtn}
                      onPress={() => applyAggressivePreset(presetKey)}
                    >
                      <Text style={styles.presetBtnText}>{AGGRESSIVE_PRESETS[presetKey].label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.ruleFieldLabel}>Janela de violacoes (minutos)</Text>
                <TextInput
                  style={styles.urlInput}
                  value={String(parentalRules.penaltyWindowMinutes ?? 180)}
                  onChangeText={(value) => {
                    const parsed = Number(value.replace(/[^0-9]/g, ''));
                    setParentalRules((prev) =>
                      prev
                        ? {
                            ...prev,
                            penaltyWindowMinutes: Number.isFinite(parsed) && parsed > 0 ? parsed : prev.penaltyWindowMinutes,
                          }
                        : prev
                    );
                  }}
                  keyboardType="numeric"
                  placeholderTextColor={StreamingTheme.colors.textMuted}
                />

                <Text style={styles.ruleFieldLabel}>Duracao do bloqueio nivel 2 (minutos)</Text>
                <TextInput
                  style={styles.urlInput}
                  value={String(parentalRules.step2BlockMinutes ?? 20)}
                  onChangeText={(value) => {
                    const parsed = Number(value.replace(/[^0-9]/g, ''));
                    setParentalRules((prev) =>
                      prev
                        ? {
                            ...prev,
                            step2BlockMinutes: Number.isFinite(parsed) && parsed > 0 ? parsed : prev.step2BlockMinutes,
                          }
                        : prev
                    );
                  }}
                  keyboardType="numeric"
                  placeholderTextColor={StreamingTheme.colors.textMuted}
                />

                <Text style={styles.ruleFieldLabel}>Duracao do bloqueio nivel 3 (minutos)</Text>
                <TextInput
                  style={styles.urlInput}
                  value={String(parentalRules.step3BlockMinutes ?? 120)}
                  onChangeText={(value) => {
                    const parsed = Number(value.replace(/[^0-9]/g, ''));
                    setParentalRules((prev) =>
                      prev
                        ? {
                            ...prev,
                            step3BlockMinutes: Number.isFinite(parsed) && parsed > 0 ? parsed : prev.step3BlockMinutes,
                          }
                        : prev
                    );
                  }}
                  keyboardType="numeric"
                  placeholderTextColor={StreamingTheme.colors.textMuted}
                />

                <Text style={styles.ruleFieldLabel}>Palavras proibidas (separadas por virgula)</Text>
                <TextInput
                  style={styles.urlInput}
                  value={keywordsInput}
                  onChangeText={setKeywordsInput}
                  placeholder="adult, 18+, porn, xxx"
                  placeholderTextColor={StreamingTheme.colors.textMuted}
                />

                <Text style={styles.ruleFieldLabel}>Maximo de minutos por hora</Text>
                <TextInput
                  style={styles.urlInput}
                  value={String(parentalRules.maxMinutesPerHour)}
                  onChangeText={(value) => {
                    const parsed = Number(value.replace(/[^0-9]/g, ''));
                    setParentalRules((prev) => (prev ? { ...prev, maxMinutesPerHour: Number.isFinite(parsed) ? parsed : prev.maxMinutesPerHour } : prev));
                  }}
                  keyboardType="numeric"
                  placeholderTextColor={StreamingTheme.colors.textMuted}
                />

                <Text style={styles.ruleFieldLabel}>Maximo de minutos continuos</Text>
                <TextInput
                  style={styles.urlInput}
                  value={String(parentalRules.maxContinuousMinutes)}
                  onChangeText={(value) => {
                    const parsed = Number(value.replace(/[^0-9]/g, ''));
                    setParentalRules((prev) => (prev ? { ...prev, maxContinuousMinutes: Number.isFinite(parsed) ? parsed : prev.maxContinuousMinutes } : prev));
                  }}
                  keyboardType="numeric"
                  placeholderTextColor={StreamingTheme.colors.textMuted}
                />

                <TouchableOpacity style={styles.urlSaveBtn} onPress={async () => {
                  const ok = await saveAggressiveRules();
                  if (ok) {
                    Alert.alert('Controle agressivo', 'Regras parentais salvas com sucesso.');
                  }
                }}>
                  <Text style={styles.urlSaveBtnText}>{rulesSaving ? 'Salvando...' : 'Salvar regras agressivas'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>ALERTAS CRITICOS RECENTES</Text>
            <View style={styles.listCard}>
              {alertFeed.map((alert, index) => (
                <View key={`${alert.at}-${index}`} style={styles.listRow}>
                  <MaterialIcons name="warning" size={14} color="#EF4444" />
                  <Text style={styles.listText} numberOfLines={1}>
                    {alert.profileName}: {alert.message || alert.type}
                  </Text>
                  <Text style={styles.listMeta}>{formatIso(alert.at)}</Text>
                </View>
              ))}
              {!alertFeed.length ? (
                <Text style={styles.emptyListText}>Sem alertas criticos nesta sessao.</Text>
              ) : null}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>SELECIONE O PERFIL PARA MONITORAR</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.profileTabs}>
              {profiles.map((profile) => {
                const active = profile.profileId === selectedProfileId;
                return (
                  <TouchableOpacity
                    key={profile.profileId}
                    style={[styles.profileTab, active && styles.profileTabActive]}
                    onPress={() => setSelectedProfileId(profile.profileId)}
                  >
                    <MaterialIcons
                      name={profile.kidsMode ? 'child-care' : 'person'}
                      size={14}
                      color={StreamingTheme.colors.textPrimary}
                    />
                    <Text style={styles.profileTabText}>{profile.profileName}</Text>
                    <View style={[styles.profileOnlineDot, { backgroundColor: profile.online ? '#22C55E' : '#6B7280' }]} />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          {selectedProfile ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>PAINEL AO VIVO</Text>
              <View style={styles.dashboardCard}>
                <Text style={styles.dashboardTitle}>{selectedProfile.profileName}</Text>
                <Text style={styles.dashboardMeta}>
                  {selectedProfile.kidsMode ? 'Perfil infantil' : 'Perfil adulto'} • {selectedProfile.online ? 'Online' : `Offline ${formatRelative(selectedProfile.lastSeen)}`}
                </Text>

                {selectedProfile.watching ? (
                  <View style={styles.nowWatchingBox}>
                    <Text style={styles.nowWatchingTitle}>Assistindo agora</Text>
                    <Text style={styles.nowWatchingText}>
                      {contentTypeLabel(selectedProfile.watching.contentType)}: {selectedProfile.watching.contentTitle}
                    </Text>
                    <Text style={styles.nowWatchingSub}>
                      desde {formatRelative(selectedProfile.watching.since)}
                    </Text>
                    <View style={styles.actionRow}>
                      <TouchableOpacity style={styles.mirrorPrimaryBtn} onPress={() => handleOpenRealtimeMirror(selectedProfile)}>
                        <MaterialIcons name="smart-display" size={15} color={StreamingTheme.colors.textPrimary} />
                        <Text style={styles.mirrorPrimaryBtnText}>Abrir player espelho</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.blockPrimaryBtn} onPress={() => handleBlockNow(selectedProfile)}>
                        <MaterialIcons name="block" size={15} color={StreamingTheme.colors.textPrimary} />
                        <Text style={styles.blockPrimaryBtnText}>Bloquear em tempo real</Text>
                      </TouchableOpacity>
                      {blockedIds.includes(selectedProfile.watching.contentId) ? (
                        <TouchableOpacity
                          style={styles.unblockPrimaryBtn}
                          onPress={async () => {
                            await unblockContent(selectedProfile.watching!.contentId);
                          }}
                        >
                          <Text style={styles.unblockPrimaryBtnText}>Desbloquear</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  </View>
                ) : (
                  <View style={styles.idleBox}>
                    <MaterialIcons name="access-time" size={14} color={StreamingTheme.colors.textMuted} />
                    <Text style={styles.idleText}>Sem reproducao ativa neste momento.</Text>
                  </View>
                )}

                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={styles.unblockPrimaryBtn}
                    onPress={() => setShowProfileSubpage((prev) => !prev)}
                  >
                    <Text style={styles.unblockPrimaryBtnText}>
                      {showProfileSubpage ? 'Fechar subpagina' : 'Abrir subpagina completa'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          ) : null}

          {selectedProfile && showProfileSubpage ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>SUBPAGINA DO PERFIL</Text>
              <View style={styles.listCard}>
                <Text style={styles.dashboardTitle}>{selectedProfile.profileName}</Text>
                <Text style={styles.dashboardMeta}>
                  Login: {selectedProfile.connectedAt ? formatIso(new Date(selectedProfile.connectedAt).toISOString()) : '--'} • Sessao {formatDurationFromMinutes(selectedSessionElapsedMinutes)}
                </Text>

                <View style={styles.detailTopRow}>
                  <View style={styles.posterBox}>
                    {selectedProfileRealtime.meta?.posterUrl || selectedProfile.watching?.posterUrl ? (
                      <Image source={{ uri: selectedProfileRealtime.meta?.posterUrl || selectedProfile.watching?.posterUrl || '' }} style={styles.posterImage} />
                    ) : (
                      <Text style={styles.posterEmpty}>Sem capa</Text>
                    )}
                  </View>

                  <View style={styles.detailMainCol}>
                    <Text style={styles.detailTitle} numberOfLines={2}>
                      {selectedProfile.watching?.contentTitle || 'Nenhum conteudo em reproducao'}
                    </Text>
                    <Text style={styles.detailMeta}>
                      {selectedProfile.watching ? contentTypeLabel(selectedProfile.watching.contentType) : '--'} • tempo atual {formatDurationFromMinutes(selectedWatchingElapsedMinutes)}
                    </Text>
                    <Text style={styles.detailMeta}>
                      Progresso estimado: {selectedEstimatedProgressPercent ?? 0}%
                      {selectedProfileRealtime.details?.runtimeMinutes ? ` de ${selectedProfileRealtime.details.runtimeMinutes} min` : ''}
                    </Text>
                    <View style={styles.hourBarTrack}>
                      <View style={[styles.hourBarFill, { width: `${selectedEstimatedProgressPercent ?? 0}%` }]} />
                    </View>
                    <Text style={styles.detailMeta} numberOfLines={2}>
                      Elenco: {selectedProfileRealtime.details?.cast?.length
                        ? selectedProfileRealtime.details.cast.slice(0, 8).map((item) => item.name).join(', ')
                        : 'sem dados de elenco'}
                    </Text>
                    <Text style={styles.detailMeta} numberOfLines={3}>
                      {selectedProfileRealtime.details?.overview || 'Sem sinopse disponivel.'}
                    </Text>
                    <Text style={styles.detailMeta} numberOfLines={1}>
                      Preview URL: {selectedProfile.watching?.previewUrl ? 'disponivel' : 'indisponivel'}
                    </Text>
                    {selectedProfileRealtime.loading ? <Text style={styles.detailMeta}>Carregando detalhes...</Text> : null}
                    <View style={styles.actionRow}>
                      <TouchableOpacity style={styles.mirrorPrimaryBtn} onPress={() => handleOpenRealtimeMirror(selectedProfile)}>
                        <MaterialIcons name="smart-display" size={15} color={StreamingTheme.colors.textPrimary} />
                        <Text style={styles.mirrorPrimaryBtnText}>Abrir no player agora</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>

                <View style={styles.sectionDivider} />
                <Text style={styles.sectionLabel}>BUSCAS RECENTES</Text>
                {(selectedActivity?.searches || []).slice(0, 8).map((entry, index) => (
                  <View key={`${entry.at}-${index}`} style={styles.listRow}>
                    <MaterialIcons name="search" size={14} color={StreamingTheme.colors.accentAlt} />
                    <Text style={styles.listText} numberOfLines={1}>{entry.query}</Text>
                    <Text style={styles.listMeta}>{formatIso(entry.at)}</Text>
                  </View>
                ))}
                {!(selectedActivity?.searches || []).length ? (
                  <Text style={styles.emptyListText}>Sem buscas registradas.</Text>
                ) : null}

                <View style={styles.sectionDivider} />
                <Text style={styles.sectionLabel}>ASSISTIDOS RECENTES</Text>
                {(selectedActivity?.watchHistory || []).slice(0, 8).map((entry, index) => (
                  <View key={`${entry.contentId}-${entry.startedAt}-${index}`} style={styles.watchRow}>
                    <View style={styles.watchTopRow}>
                      <Text style={styles.watchTitle} numberOfLines={1}>{entry.contentTitle}</Text>
                      <Text style={styles.watchMin}>{entry.durationMin} min</Text>
                    </View>
                    <Text style={styles.watchMeta}>
                      {contentTypeLabel(entry.contentType)} • inicio {formatIso(entry.startedAt)}
                    </Text>
                  </View>
                ))}
                {!(selectedActivity?.watchHistory || []).length ? (
                  <Text style={styles.emptyListText}>Sem historico de assistidos.</Text>
                ) : null}

                <View style={styles.sectionDivider} />
                <Text style={styles.sectionLabel}>ASSISTIR MAIS TARDE (DISPOSITIVO ATUAL)</Text>
                {watchLaterItems.map((item, index) => (
                  <View key={`${item.id}-${index}`} style={styles.listRow}>
                    <MaterialIcons name="bookmark" size={14} color={StreamingTheme.colors.accentAlt} />
                    <Text style={styles.listText} numberOfLines={1}>{item.title}</Text>
                    <Text style={styles.listMeta}>{contentTypeLabel(item.type)}</Text>
                  </View>
                ))}
                {!watchLaterItems.length ? (
                  <Text style={styles.emptyListText}>Sem itens em assistir mais tarde no perfil ativo deste dispositivo.</Text>
                ) : null}

                <View style={styles.sectionDivider} />
                <Text style={styles.sectionLabel}>HORARIOS DE USO</Text>
                <Text style={styles.totalMinutesText}>Total monitorado: {Math.round(selectedActivity?.totalMinutes || 0)} min</Text>
                {minutesByHourRows.map((row) => (
                  <View key={`detail-${row.hour}`} style={styles.hourRow}>
                    <Text style={styles.hourLabel}>{String(row.hour).padStart(2, '0')}h</Text>
                    <View style={styles.hourBarTrack}>
                      <View style={[styles.hourBarFill, { width: row.widthPct }]} />
                    </View>
                    <Text style={styles.hourValue}>{row.minutes} min</Text>
                  </View>
                ))}

                {!minutesByHourRows.length ? (
                  <Text style={styles.emptyListText}>Sem dados de horario de uso.</Text>
                ) : null}
              </View>
            </View>
          ) : null}

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>BUSCAS RECENTES DO PERFIL</Text>
            <View style={styles.listCard}>
              {(selectedActivity?.searches || []).slice(0, 12).map((entry, index) => (
                <View key={`${entry.at}-${index}`} style={styles.listRow}>
                  <MaterialIcons name="search" size={14} color={StreamingTheme.colors.accentAlt} />
                  <Text style={styles.listText} numberOfLines={1}>{entry.query}</Text>
                  <Text style={styles.listMeta}>{formatIso(entry.at)}</Text>
                </View>
              ))}
              {!(selectedActivity?.searches || []).length ? (
                <Text style={styles.emptyListText}>Sem buscas registradas para este perfil.</Text>
              ) : null}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>HISTORICO DE ASSISTIDOS</Text>
            <View style={styles.listCard}>
              {(selectedActivity?.watchHistory || []).slice(0, 12).map((entry, index) => (
                <View key={`${entry.contentId}-${entry.startedAt}-${index}`} style={styles.watchRow}>
                  <View style={styles.watchTopRow}>
                    <Text style={styles.watchTitle} numberOfLines={1}>{entry.contentTitle}</Text>
                    <Text style={styles.watchMin}>{entry.durationMin} min</Text>
                  </View>
                  <Text style={styles.watchMeta}>
                    {contentTypeLabel(entry.contentType)} • hora {String(entry.hour).padStart(2, '0')} • {formatIso(entry.startedAt)}
                  </Text>
                </View>
              ))}
              {!(selectedActivity?.watchHistory || []).length ? (
                <Text style={styles.emptyListText}>Sem historico de assistidos para este perfil.</Text>
              ) : null}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>MINUTOS POR HORA</Text>
            <View style={styles.listCard}>
              <Text style={styles.totalMinutesText}>Total monitorado: {Math.round(selectedActivity?.totalMinutes || 0)} min</Text>
              {minutesByHourRows.map((row) => (
                <View key={row.hour} style={styles.hourRow}>
                  <Text style={styles.hourLabel}>{String(row.hour).padStart(2, '0')}h</Text>
                  <View style={styles.hourBarTrack}>
                    <View style={[styles.hourBarFill, { width: row.widthPct }]} />
                  </View>
                  <Text style={styles.hourValue}>{row.minutes} min</Text>
                </View>
              ))}
              {!minutesByHourRows.length ? (
                <Text style={styles.emptyListText}>Sem dados de minutos por hora ainda.</Text>
              ) : null}
            </View>
          </View>

          {blockedIds.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>CONTEUDOS BLOQUEADOS ({blockedIds.length})</Text>
              {blockedIds.map((id) => (
                <View key={id} style={styles.blockedRow}>
                  <MaterialIcons name="block" size={14} color="#EF4444" />
                  <Text style={styles.blockedId} numberOfLines={1}>{id}</Text>
                  <TouchableOpacity onPress={() => unblockContent(id)} style={styles.unblockBtn}>
                    <Text style={styles.unblockBtnText}>Desbloquear</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          ) : null}

          <View style={{ height: 40 }} />
        </ScrollView>
      </SafeAreaView>
    </FeatureGate>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  backBtn: { padding: 6 },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { color: StreamingTheme.colors.textPrimary, fontSize: 16, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  headerSub: { color: StreamingTheme.colors.textMuted, fontSize: 12 },
  statusDot: { width: 9, height: 9, borderRadius: 5 },
  content: { paddingHorizontal: 16, paddingTop: 4 },
  section: { marginBottom: 20 },
  sectionLabel: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 8,
  },
  urlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: StreamingTheme.colors.surface,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  urlText: { flex: 1, color: StreamingTheme.colors.textPrimary, fontSize: 13 },
  urlInput: {
    backgroundColor: StreamingTheme.colors.surface,
    borderRadius: 8,
    padding: 10,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.accent,
  },
  urlSaveBtn: {
    backgroundColor: StreamingTheme.colors.accent,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  urlSaveBtnText: { color: StreamingTheme.colors.textPrimary, fontWeight: '700', fontSize: 13 },
  notifRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: StreamingTheme.colors.surface,
    borderRadius: 10,
    padding: 12,
  },
  notifText: { flex: 1, color: StreamingTheme.colors.textPrimary, fontSize: 12, lineHeight: 17 },
  ruleRow: {
    minHeight: 42,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.02)',
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  ruleLabel: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    flex: 1,
  },
  ruleFieldLabel: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    marginTop: 4,
  },
  presetRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 2,
  },
  presetBtn: {
    flex: 1,
    minHeight: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,59,48,0.35)',
    backgroundColor: 'rgba(255,59,48,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  presetBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },
  profileTabs: {
    gap: 8,
    paddingRight: 12,
  },
  profileTab: {
    minHeight: 36,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  profileTabActive: {
    borderColor: 'rgba(255,59,48,0.5)',
    backgroundColor: 'rgba(255,59,48,0.2)',
  },
  profileTabText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  profileOnlineDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  dashboardCard: {
    backgroundColor: StreamingTheme.colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    padding: 12,
    gap: 8,
  },
  dashboardTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '900',
  },
  dashboardMeta: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
  },
  nowWatchingBox: {
    marginTop: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.35)',
    backgroundColor: 'rgba(245,158,11,0.08)',
    padding: 10,
    gap: 4,
  },
  nowWatchingTitle: {
    color: '#F59E0B',
    fontWeight: '800',
    fontSize: 12,
  },
  nowWatchingText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  nowWatchingSub: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  actionRow: {
    marginTop: 6,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  blockPrimaryBtn: {
    minHeight: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#EF4444',
    backgroundColor: 'rgba(239,68,68,0.2)',
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  mirrorPrimaryBtn: {
    minHeight: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(14,165,233,0.7)',
    backgroundColor: 'rgba(14,165,233,0.2)',
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  mirrorPrimaryBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },
  blockPrimaryBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },
  unblockPrimaryBtn: {
    minHeight: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.35)',
    backgroundColor: 'rgba(239,68,68,0.08)',
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unblockPrimaryBtnText: {
    color: '#EF4444',
    fontSize: 12,
    fontWeight: '800',
  },
  idleBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  idleText: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
  },
  listCard: {
    backgroundColor: StreamingTheme.colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    padding: 10,
    gap: 8,
  },
  listRow: {
    minHeight: 30,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.03)',
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  listText: {
    flex: 1,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  listMeta: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 10,
  },
  diagRowText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 11,
  },
  diagAttemptRow: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.02)',
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 2,
  },
  diagAttemptMain: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 11,
    fontWeight: '700',
  },
  diagAttemptMeta: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 10,
  },
  sectionDivider: {
    height: 1,
    backgroundColor: StreamingTheme.colors.border,
    marginVertical: 4,
  },
  detailTopRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
  posterBox: {
    width: 92,
    height: 138,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.03)',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  posterImage: {
    width: '100%',
    height: '100%',
  },
  posterEmpty: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 10,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  detailMainCol: {
    flex: 1,
    gap: 4,
  },
  detailTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  detailMeta: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
  watchRow: {
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.03)',
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 2,
  },
  watchTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  watchTitle: {
    flex: 1,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },
  watchMin: {
    color: StreamingTheme.colors.accentAlt,
    fontSize: 11,
    fontWeight: '800',
  },
  watchMeta: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 10,
  },
  totalMinutesText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },
  hourRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  hourLabel: {
    width: 28,
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  hourBarTrack: {
    flex: 1,
    height: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  hourBarFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: StreamingTheme.colors.accent,
  },
  hourValue: {
    width: 46,
    textAlign: 'right',
    color: StreamingTheme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  emptyListText: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
  },
  emptyBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '800',
    marginTop: 16,
  },
  emptyDesc: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
  loginBtn: {
    marginTop: 24,
    backgroundColor: StreamingTheme.colors.accent,
    borderRadius: 10,
    paddingHorizontal: 28,
    paddingVertical: 12,
  },
  loginBtnText: { color: StreamingTheme.colors.textPrimary, fontWeight: '800', fontSize: 15 },
  blockedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: StreamingTheme.colors.surface,
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
  },
  blockedId: { flex: 1, color: '#EF4444', fontSize: 12 },
  unblockBtn: {
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.3)',
  },
  unblockBtnText: { color: '#EF4444', fontSize: 11, fontWeight: '700' },
});
