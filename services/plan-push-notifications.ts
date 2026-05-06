import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

import { apiRequest } from '@/services/app-server';
import { loadUserSession } from '@/services/cloud-sync';
import { getDbValue, setDbValue } from '@/services/local-db';
import {
  applyRemotePlanState,
  getLocalPlanState,
  getPlan,
  LocalPlanState,
  refreshPlanStateAtLaunch,
} from '@/services/subscription';

const EXPO_PUSH_TOKEN_KEY = 'notifications.expoPushToken.v1';
const LAST_PLAN_NOTIFICATION_SIGNATURE_KEY = 'notifications.plan.lastSignature.v1';
let listenersInitialized = false;

type NotificationData = {
  type?: string;
  planState?: Partial<LocalPlanState>;
};

function getProjectId() {
  return (
    Constants?.expoConfig?.extra?.eas?.projectId ||
    Constants?.easConfig?.projectId ||
    undefined
  );
}

function normalizeNotificationData(data: unknown): NotificationData {
  return data && typeof data === 'object' ? (data as NotificationData) : {};
}

function buildPlanSignature(state: Partial<LocalPlanState> | null | undefined) {
  if (!state) return '';
  return [
    String(state.planId || ''),
    String(state.status || ''),
    state.enabled === false ? '0' : '1',
    String(state.updatedAt || ''),
  ].join('|');
}

async function markPlanNotificationSignature(state: Partial<LocalPlanState> | null | undefined) {
  const signature = buildPlanSignature(state);
  if (!signature) return;
  await setDbValue(LAST_PLAN_NOTIFICATION_SIGNATURE_KEY, signature);
}

async function shouldNotifyPlanLocally(state: Partial<LocalPlanState> | null | undefined) {
  const signature = buildPlanSignature(state);
  if (!signature) return false;
  const lastSignature = await getDbValue<string>(LAST_PLAN_NOTIFICATION_SIGNATURE_KEY);
  return lastSignature !== signature;
}

async function scheduleLocalPlanNotification(state: LocalPlanState) {
  const allowed = await ensureNotificationPermission();
  if (!allowed) {
    return false;
  }

  const plan = getPlan(state.planId);
  const enabled = state.enabled !== false && state.status !== 'expired';
  const title = enabled ? 'Plano ativado' : 'Plano atualizado';
  const body = enabled
    ? `Parabens! Seu plano ${plan.name} esta ativo e os novos recursos ja foram liberados.`
    : `Seu plano agora e ${plan.name}. Abra o app para revisar os recursos disponiveis.`;

  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data: {
        type: 'plan_changed',
        planState: state,
      },
    },
    trigger: null,
  });

  await markPlanNotificationSignature(state);
  return true;
}

async function ensureNotificationPermission() {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted || current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
    return true;
  }

  const requested = await Notifications.requestPermissionsAsync();
  return !!requested.granted;
}

async function handlePlanNotificationData(data: unknown) {
  const payload = normalizeNotificationData(data);
  if (payload.type !== 'plan_changed' || !payload.planState) {
    return;
  }

  await applyRemotePlanState(payload.planState);
  await markPlanNotificationSignature(payload.planState);
}

export function initializePlanPushListeners() {
  if (listenersInitialized) {
    return;
  }

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

  Notifications.addNotificationReceivedListener((event) => {
    void handlePlanNotificationData(event.request.content.data);
  });

  Notifications.addNotificationResponseReceivedListener((response) => {
    void handlePlanNotificationData(response.notification.request.content.data);
  });

  listenersInitialized = true;
}

export async function registerPlanPushToken() {
  initializePlanPushListeners();

  const session = await loadUserSession();
  if (!session?.token) {
    console.log('[plan-push] Sessao da conta ausente. Token Expo nao sera registrado.');
    return null;
  }

  const allowed = await ensureNotificationPermission();
  if (!allowed) {
    console.log('[plan-push] Permissao de notificacao negada.');
    return null;
  }

  try {
    await Notifications.setNotificationChannelAsync('plan-updates', {
      name: 'Atualizacoes de plano',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 180, 120, 240],
      lightColor: '#2CD07F',
    });
  } catch {
    // Continua mesmo se o canal falhar em plataformas sem suporte.
  }

  const projectId = getProjectId();
  if (!projectId) {
    console.log('[plan-push] ProjectId do Expo/EAS nao encontrado. Tentando token mesmo assim.');
  }

  const tokenResponse = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  const expoPushToken = String(tokenResponse?.data || '').trim();
  if (!expoPushToken) {
    console.log('[plan-push] Expo push token vazio.');
    return null;
  }

  console.log('[plan-push] Expo push token gerado:', `${expoPushToken.slice(0, 24)}...`);

  const lastSaved = await getDbValue<string>(EXPO_PUSH_TOKEN_KEY);
  if (lastSaved === expoPushToken) {
    console.log('[plan-push] Token Expo ja registrado no app.');
    return expoPushToken;
  }

  await apiRequest('/api/notifications/expo-token', {
    method: 'POST',
    token: session.token,
    body: { token: expoPushToken },
    timeoutMs: 8000,
  });

  await setDbValue(EXPO_PUSH_TOKEN_KEY, expoPushToken);
  console.log('[plan-push] Token Expo enviado ao servidor com sucesso.');
  return expoPushToken;
}

export async function syncPlanStateFromServer() {
  initializePlanPushListeners();
  const before = await getLocalPlanState();
  const next = await refreshPlanStateAtLaunch();

  const changed = buildPlanSignature(before) !== buildPlanSignature(next);
  if (changed && next && (await shouldNotifyPlanLocally(next))) {
    const shown = await scheduleLocalPlanNotification(next).catch(() => false);
    console.log('[plan-push] Mudanca de plano detectada via sync. Notificacao local exibida:', shown);
  }

  return next;
}