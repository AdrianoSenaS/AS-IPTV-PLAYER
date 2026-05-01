import { MaterialIcons } from '@expo/vector-icons';
import { getDbValue } from '@/services/local-db';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  AppStateStatus,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
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
import {
  blockContent,
  checkServerHealth,
  connectSocket,
  fetchPresenceSnapshot,
  getRtServerUrl,
  onBlocksUpdated,
  onChildEntered,
  onChildOffline,
  onChildWatching,
  onPresenceUpdate,
  ProfilePresence,
  setRtServerUrl,
  unblockContent,
} from '@/services/realtime-presence';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatRelative(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 60_000) return 'agora mesmo';
  if (diff < 3_600_000) return `há ${Math.floor(diff / 60_000)} min`;
  return `há ${Math.floor(diff / 3_600_000)}h`;
}

function contentTypeLabel(type: string): string {
  if (type === 'movie') return 'Filme';
  if (type === 'series') return 'Série';
  if (type === 'live') return 'Ao Vivo';
  return type;
}

// ─── Componente: Card de presença ─────────────────────────────────────────────
type PresenceCardProps = {
  profile: ProfilePresence;
  blockedIds: string[];
  onBlock: (profile: ProfilePresence) => void;
  onUnblock: (contentId: string) => void;
};

function PresenceCard({ profile, blockedIds, onBlock, onUnblock }: PresenceCardProps) {
  const isBlocked = profile.watching ? blockedIds.includes(profile.watching.contentId) : false;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardAvatarRow}>
          <View
            style={[
              styles.cardAvatar,
              { backgroundColor: profile.kidsMode ? '#7C3AED' : StreamingTheme.colors.accent },
            ]}
          >
            <MaterialIcons
              name={profile.kidsMode ? 'child-care' : 'person'}
              size={20}
              color={StreamingTheme.colors.textPrimary}
            />
          </View>
          <View style={styles.cardInfo}>
            <Text style={styles.cardName}>{profile.profileName}</Text>
            <Text style={styles.cardMeta}>
              {profile.kidsMode ? 'Perfil infantil' : 'Perfil adulto'} •{' '}
              {profile.online ? (
                <Text style={{ color: '#22C55E' }}>Online</Text>
              ) : (
                <Text style={{ color: StreamingTheme.colors.textMuted }}>
                  Offline • {formatRelative(profile.lastSeen)}
                </Text>
              )}
            </Text>
          </View>
        </View>

        <View
          style={[
            styles.statusDot,
            { backgroundColor: profile.online ? '#22C55E' : StreamingTheme.colors.textMuted },
          ]}
        />
      </View>

      {profile.watching ? (
        <View style={styles.watchingBox}>
          <MaterialIcons name="play-circle-filled" size={14} color="#F59E0B" />
          <Text style={styles.watchingText} numberOfLines={1}>
            {contentTypeLabel(profile.watching.contentType)}: {profile.watching.contentTitle}
          </Text>
          <Text style={styles.watchingTime}>{formatRelative(profile.watching.since)}</Text>

          {profile.kidsMode && (
            <TouchableOpacity
              style={[styles.blockBtn, isBlocked && styles.blockBtnActive]}
              onPress={() =>
                isBlocked
                  ? onUnblock(profile.watching!.contentId)
                  : onBlock(profile)
              }
            >
              <MaterialIcons
                name={isBlocked ? 'lock' : 'block'}
                size={13}
                color={isBlocked ? '#EF4444' : StreamingTheme.colors.textPrimary}
              />
              <Text
                style={[styles.blockBtnText, isBlocked && { color: '#EF4444' }]}
              >
                {isBlocked ? 'Bloqueado' : 'Bloquear'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      ) : profile.online ? (
        <View style={styles.idleBox}>
          <MaterialIcons name="access-time" size={13} color={StreamingTheme.colors.textMuted} />
          <Text style={styles.idleText}>No menu / navegando</Text>
        </View>
      ) : null}
    </View>
  );
}

// ─── Tela principal ───────────────────────────────────────────────────────────
export default function MonitorParentalScreen() {
  const router = useRouter();
  const { hasFeature, loading: planLoading } = usePlanGate();
  const [isLoading, setIsLoading] = useState(true);
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [editingUrl, setEditingUrl] = useState(false);
  const [tempUrl, setTempUrl] = useState('');
  const [profiles, setProfiles] = useState<ProfilePresence[]>([]);
  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notifEnabled, setNotifEnabled] = useState(false);
  const appStateRef = useRef(AppState.currentState);
  const monitorLocked = !planLoading && !hasFeature('realtime_monitor');

  if (monitorLocked) {
    return <FeatureGate feature="realtime_monitor" locked>{null}</FeatureGate>;
  }

  // ── Bootstrap ──
  useEffect(() => {
    const bootstrap = async () => {
      const username = await getDbValue<string>('username');
      if (!username) {
        setIsLoggedIn(false);
        setIsLoading(false);
        return;
      }
      setIsLoggedIn(true);

      const url = await getRtServerUrl();
      setServerUrl(url);
      setTempUrl(url);

      // Verifica notificações
      const { status } = await Notifications.getPermissionsAsync();
      setNotifEnabled(status === 'granted');

      // Conecta socket e carrega dados
      await connectSocket();
      const snap = await fetchPresenceSnapshot();
      setProfiles(snap);

      const health = await checkServerHealth();
      setServerOk(health);

      setIsLoading(false);
    };

    bootstrap();
  }, []);

  // ── Subscriptions ──
  useEffect(() => {
    const unsubs = [
      onPresenceUpdate(setProfiles),
      onChildEntered(async (ev) => {
        if (notifEnabled) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: '👶 Filho entrou no app',
              body: `${ev.profileName} acabou de entrar — ${new Date(ev.enteredAt).toLocaleTimeString('pt-BR')}`,
              sound: true,
            },
            trigger: null,
          });
        }
      }),
      onChildWatching(async (ev) => {
        if (notifEnabled) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: `▶️ ${ev.profileName} começou a assistir`,
              body: `${contentTypeLabel(ev.contentType)}: ${ev.contentTitle}`,
              sound: true,
            },
            trigger: null,
          });
        }
      }),
      onChildOffline(async (ev) => {
        if (notifEnabled) {
          const offlineAt = (ev as any)?.offlineAt ?? Date.now();
          await Notifications.scheduleNotificationAsync({
            content: {
              title: `📴 ${ev.profileName} ficou offline`,
              body: `Saiu do app às ${new Date(offlineAt).toLocaleTimeString('pt-BR')}`,
              sound: false,
            },
            trigger: null,
          });
        }
      }),
      onBlocksUpdated(setBlockedIds),
    ];

    return () => unsubs.forEach((fn) => fn());
  }, [notifEnabled]);

  // ── AppState: reconecta ao voltar ao foreground ──
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state: AppStateStatus) => {
      if (state === 'active' && appStateRef.current !== 'active') {
        await connectSocket();
        const snap = await fetchPresenceSnapshot();
        setProfiles(snap);
        setServerOk(await checkServerHealth());
      }
      appStateRef.current = state;
    });
    return () => sub.remove();
  }, []);

  // ── Refresh manual ──
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await connectSocket();
    const [snap, health] = await Promise.all([fetchPresenceSnapshot(), checkServerHealth()]);
    setProfiles(snap);
    setServerOk(health);
    setRefreshing(false);
  }, []);

  // ── Bloquear conteúdo ──
  const handleBlock = useCallback(async (profile: ProfilePresence) => {
    if (!profile.watching) return;
    Alert.alert(
      'Bloquear conteúdo',
      `Bloquear "${profile.watching.contentTitle}" para ${profile.profileName}?\n\nO conteúdo será interrompido imediatamente no dispositivo do filho.`,
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
            if (!ok) Alert.alert('Erro', 'Não foi possível bloquear. Verifique a conexão com o servidor.');
          },
        },
      ]
    );
  }, []);

  // ── Desbloquear ──
  const handleUnblock = useCallback(async (contentId: string) => {
    const ok = await unblockContent(contentId);
    if (!ok) Alert.alert('Erro', 'Não foi possível desbloquear.');
  }, []);

  // ── Salvar URL do servidor ──
  const saveServerUrl = useCallback(async () => {
    if (!tempUrl.startsWith('http')) {
      Alert.alert('URL inválida', 'A URL deve começar com http:// ou https://');
      return;
    }
    await setRtServerUrl(tempUrl);
    setServerUrl(tempUrl);
    setEditingUrl(false);
    setServerOk(await checkServerHealth());
  }, [tempUrl]);

  // ── Solicitar notificações ──
  const requestNotifications = useCallback(async () => {
    const { status } = await Notifications.requestPermissionsAsync();
    setNotifEnabled(status === 'granted');
    if (status !== 'granted') {
      Alert.alert('Permissão negada', 'Ative notificações nas configurações do dispositivo para receber alertas dos filhos.');
    }
  }, []);

  // ── Render: não logado ──
  if (!isLoading && !isLoggedIn) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <AppBackdrop blurIntensity={28} />
        <View style={styles.emptyBox}>
          <MaterialIcons name="lock" size={48} color={StreamingTheme.colors.textMuted} />
          <Text style={styles.emptyTitle}>Conta obrigatória</Text>
          <Text style={styles.emptyDesc}>
            O monitoramento em tempo real só está disponível para usuários com conta cadastrada no app.
          </Text>
          <TouchableOpacity style={styles.loginBtn} onPress={() => router.replace('/login')}>
            <Text style={styles.loginBtnText}>Fazer login</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <AppBackdrop blurIntensity={28} />
        <PageLoader visible label="Conectando ao servidor…" />
      </SafeAreaView>
    );
  }

  const kidsProfiles = profiles.filter((p) => p.kidsMode);
  const adultProfiles = profiles.filter((p) => !p.kidsMode);
  const onlineCount = profiles.filter((p) => p.online).length;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Monitor Parental</Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: serverOk ? '#22C55E' : '#EF4444', marginRight: 5 }]} />
            <Text style={styles.headerSub}>
              {serverOk ? `${onlineCount} online agora` : 'Servidor offline'}
            </Text>
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
        {/* Servidor */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>SERVIDOR REAL-TIME</Text>
          {editingUrl ? (
            <View style={styles.urlEditRow}>
              <TextInput
                style={styles.urlInput}
                value={tempUrl}
                onChangeText={setTempUrl}
                autoCapitalize="none"
                keyboardType="url"
                placeholderTextColor={StreamingTheme.colors.textMuted}
                placeholder="http://192.168.x.x:3001"
              />
              <TouchableOpacity style={styles.urlSaveBtn} onPress={saveServerUrl}>
                <Text style={styles.urlSaveBtnText}>Salvar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.urlSaveBtn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: StreamingTheme.colors.textMuted }]}
                onPress={() => setEditingUrl(false)}
              >
                <Text style={[styles.urlSaveBtnText, { color: StreamingTheme.colors.textMuted }]}>Cancelar</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.urlRow} onPress={() => setEditingUrl(true)}>
              <MaterialIcons name="wifi" size={16} color={serverOk ? '#22C55E' : '#EF4444'} />
              <Text style={styles.urlText} numberOfLines={1}>{serverUrl}</Text>
              <MaterialIcons name="edit" size={15} color={StreamingTheme.colors.textMuted} />
            </TouchableOpacity>
          )}
          {!serverOk && (
            <Text style={styles.serverOfflineHint}>
              Inicie o servidor com: cd server && npm install && npm start
            </Text>
          )}
        </View>

        {/* Notificações */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>ALERTAS</Text>
          <TouchableOpacity
            style={styles.notifRow}
            onPress={notifEnabled ? undefined : requestNotifications}
          >
            <MaterialIcons
              name={notifEnabled ? 'notifications-active' : 'notifications-off'}
              size={18}
              color={notifEnabled ? StreamingTheme.colors.accent : StreamingTheme.colors.textMuted}
            />
            <Text style={[styles.notifText, !notifEnabled && { color: StreamingTheme.colors.textMuted }]}>
              {notifEnabled
                ? 'Notificações ativas — você será alertado quando filhos entrarem ou assistirem conteúdo'
                : 'Toque para ativar notificações de entrada e conteúdo dos filhos'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Perfis infantis */}
        {kidsProfiles.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>PERFIS INFANTIS</Text>
            {kidsProfiles.map((p) => (
              <PresenceCard
                key={p.profileId}
                profile={p}
                blockedIds={blockedIds}
                onBlock={handleBlock}
                onUnblock={handleUnblock}
              />
            ))}
          </View>
        )}

        {/* Perfis adultos */}
        {adultProfiles.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>OUTROS PERFIS</Text>
            {adultProfiles.map((p) => (
              <PresenceCard
                key={p.profileId}
                profile={p}
                blockedIds={blockedIds}
                onBlock={handleBlock}
                onUnblock={handleUnblock}
              />
            ))}
          </View>
        )}

        {profiles.length === 0 && serverOk && (
          <View style={styles.emptyInline}>
            <MaterialIcons name="people-outline" size={36} color={StreamingTheme.colors.textMuted} />
            <Text style={styles.emptyInlineText}>
              Nenhum perfil ativo no momento.{'\n'}Aguardando conexões…
            </Text>
          </View>
        )}

        {/* Conteúdos bloqueados globais */}
        {blockedIds.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>CONTEÚDOS BLOQUEADOS ({blockedIds.length})</Text>
            {blockedIds.map((id) => (
              <View key={id} style={styles.blockedRow}>
                <MaterialIcons name="block" size={14} color="#EF4444" />
                <Text style={styles.blockedId} numberOfLines={1}>{id}</Text>
                <TouchableOpacity onPress={() => handleUnblock(id)} style={styles.unblockBtn}>
                  <Text style={styles.unblockBtnText}>Desbloquear</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Estilos ──────────────────────────────────────────────────────────────────
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
  content: { paddingHorizontal: 16, paddingTop: 4 },
  section: { marginBottom: 20 },
  sectionLabel: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 8,
  },
  // Servidor
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
  urlEditRow: { gap: 8 },
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
  serverOfflineHint: {
    marginTop: 6,
    color: '#EF4444',
    fontSize: 11,
    lineHeight: 16,
  },
  // Notificações
  notifRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: StreamingTheme.colors.surface,
    borderRadius: 10,
    padding: 12,
  },
  notifText: { flex: 1, color: StreamingTheme.colors.textPrimary, fontSize: 12, lineHeight: 17 },
  // Card de presença
  card: {
    backgroundColor: StreamingTheme.colors.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border ?? '#2a2a2a',
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardAvatarRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  cardAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardInfo: { flex: 1 },
  cardName: { color: StreamingTheme.colors.textPrimary, fontSize: 14, fontWeight: '700' },
  cardMeta: { color: StreamingTheme.colors.textMuted, fontSize: 11, marginTop: 1 },
  statusDot: { width: 9, height: 9, borderRadius: 5 },
  // Assistindo
  watchingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    backgroundColor: 'rgba(245,158,11,0.08)',
    borderRadius: 7,
    padding: 8,
    flexWrap: 'wrap',
  },
  watchingText: { flex: 1, color: '#F59E0B', fontSize: 12, fontWeight: '600' },
  watchingTime: { color: StreamingTheme.colors.textMuted, fontSize: 11 },
  blockBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.25)',
  },
  blockBtnActive: {
    backgroundColor: 'rgba(239,68,68,0.2)',
    borderColor: '#EF4444',
  },
  blockBtnText: { color: StreamingTheme.colors.textPrimary, fontSize: 11, fontWeight: '700' },
  // Idle
  idleBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 8,
  },
  idleText: { color: StreamingTheme.colors.textMuted, fontSize: 11 },
  // Vazio
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
  emptyInline: { alignItems: 'center', paddingVertical: 30, gap: 10 },
  emptyInlineText: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
  },
  // Bloqueados
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
