/**
 * subscription.ts
 *
 * Gerencia planos de assinatura, feature flags e verificações de acesso.
 * O plano ativo é salvo localmente. Em produção, validar via backend.
 */

import { getDbValue, setDbValue } from '@/services/local-db';
import { apiRequest } from '@/services/app-server';
import { loadUserSession } from '@/services/cloud-sync';

const PLAN_KEY = 'subscription.plan.v1';
const PLAN_STATE_DB_KEY = 'subscription.plan.state.v1';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type PlanId = 'free' | 'plus' | 'pro' | 'ultra' | 'lifetime';

export type Feature =
  | 'explore'           // aba Explorar
  | 'downloads'         // downloads offline
  | 'lists'             // minhas listas
  | 'cast_mirror'       // Google Cast / espelhar na TV
  | 'pip'               // Picture-in-Picture
  | 'airplay'           // AirPlay / VideoAirPlayButton
  | 'recommendation_algorithm'  // chips de recomendação + algoritmo de gosto
  | 'tmdb_details'      // detalhes TMDB (elenco, nota, sinopse)
  | 'parental_controls' // controle dos pais
  | 'realtime_monitor'  // monitor parental em tempo real
  | 'multi_server'      // múltiplos servidores
  | 'multi_user'        // múltiplos perfis
  | 'content_4k';       // conteúdo 4K

export type Plan = {
  id: PlanId;
  name: string;
  tagline: string;
  price: string;          // ex: "R$ 19,90/mês"
  priceNote: string;      // ex: "Cobrado mensalmente"
  color: string;
  features: Feature[];
  maxProfiles: number;    // -1 = ilimitado
  maxServers: number;     // -1 = ilimitado
  highlighted?: boolean;
};

export type PlanStatus = 'active' | 'expired' | 'grace' | 'unknown';

export type LocalPlanState = {
  planId: PlanId;
  status: PlanStatus;
  paymentDueAt?: string;
  paymentHour?: string;
  paymentAmount?: string;
  enabled?: boolean;
  updatedAt: string;
  checkedAt: string;
};

// ─── Definição dos planos ─────────────────────────────────────────────────────

export const PLANS: Plan[] = [
   {
    id: 'free',
    name: 'Start',
    tagline: 'Comece gratuitamente',
    price: 'R$ 0',
    priceNote: 'Grátis para sempre',
    color: '#7F89A8',
    maxProfiles: 1,
    maxServers: 1,
    features: [],
  },
  {
    id: 'plus',
    name: 'Plus',
    tagline: 'Mais liberdade no uso diário',
    price: 'R$ 9,90/mês',
    priceNote: 'Cobrado mensalmente',
    color: '#5DA9FF',
    maxProfiles: 1,
    maxServers: 1,
    features: [
      'explore',
      'downloads',
      'lists',
      'cast_mirror',
      'pip'
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'Mais controle e melhor experiência',
    price: 'R$ 19,90/mês',
    priceNote: 'Mais escolhido',
    color: '#FF8F3A',
    highlighted: true,
    maxProfiles: 2,
    maxServers: 2,
    features: [
      'explore',
      'downloads',
      'lists',
      'cast_mirror',
      'pip',
      'airplay',
      'recommendation_algorithm',
      'tmdb_details',
      'multi_server',
      'multi_user',
    ],
  },
  {
    id: 'ultra',
    name: 'Ultra',
    tagline: 'Experiência completa sem limites',
    price: 'R$ 29,90/mês',
    priceNote: 'Cobrado mensalmente',
    color: '#FF3B30',
    maxProfiles: 6,
    maxServers: -1,
    features: [
      'explore',
      'downloads',
      'lists',
      'cast_mirror',
      'pip',
      'airplay',
      'recommendation_algorithm',
      'tmdb_details',
      'parental_controls',
      'realtime_monitor',
      'multi_server',
      'multi_user',
      'content_4k',
    ],
  },
  {
    id: 'lifetime',
    name: 'Lifetime',
    tagline: 'Pague uma vez e desbloqueie tudo',
    price: 'R$ 199,90',
    priceNote: 'Pagamento único',
    color: '#2CD07F',
    maxProfiles: -1,
    maxServers: -1,
    features: [
      'explore',
      'downloads',
      'lists',
      'cast_mirror',
      'pip',
      'airplay',
      'recommendation_algorithm',
      'tmdb_details',
      'parental_controls',
      'realtime_monitor',
      'multi_server',
      'multi_user',
      'content_4k',
    ],
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getPlan(id: PlanId): Plan {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}

let _cached: PlanId | null = null;

function normalizePlanId(value: unknown): PlanId {
  return PLANS.some((plan) => plan.id === value) ? (value as PlanId) : 'free';
}

function normalizeStatus(value: unknown): PlanStatus {
  if (value === 'active' || value === 'expired' || value === 'grace') {
    return value;
  }
  return 'unknown';
}

function isPlanExpired(planId: PlanId, dueAt?: string) {
  if (!dueAt || planId === 'free' || planId === 'lifetime') {
    return false;
  }

  const dueTs = new Date(dueAt).getTime();
  if (!Number.isFinite(dueTs)) {
    return false;
  }

  return Date.now() > dueTs;
}

function buildLocalPlanState(
  planId: PlanId,
  partial?: Partial<Omit<LocalPlanState, 'planId' | 'updatedAt' | 'checkedAt'>>
): LocalPlanState {
  const now = new Date().toISOString();
  return {
    planId,
    status: normalizeStatus(partial?.status) || 'active',
    paymentDueAt: partial?.paymentDueAt,
    paymentHour: partial?.paymentHour,
    paymentAmount: partial?.paymentAmount,
    enabled: partial?.enabled !== false,
    updatedAt: now,
    checkedAt: now,
  };
}

function normalizePlanState(raw: Partial<LocalPlanState> | null | undefined): LocalPlanState | null {
  if (!raw) return null;

  const normalized: LocalPlanState = {
    planId: normalizePlanId(raw.planId),
    status: normalizeStatus(raw.status),
    paymentDueAt: raw.paymentDueAt,
    paymentHour: raw.paymentHour,
    paymentAmount: raw.paymentAmount,
    enabled: raw.enabled !== false,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : new Date().toISOString(),
  };

  if (normalized.enabled === false) {
    return {
      ...normalized,
      planId: 'free',
      status: 'expired',
      checkedAt: new Date().toISOString(),
    };
  }

  return normalized;
}

async function readRemotePlanState(): Promise<LocalPlanState | null> {
  const session = await loadUserSession();
  if (!session?.token) return null;

  try {
    const body = await apiRequest<{ planState: LocalPlanState }>('/api/subscription/me', {
      token: session.token,
      timeoutMs: 6000,
    });

    const normalized = normalizePlanState(body?.planState);
    if (normalized) {
      await setDbValue(PLAN_STATE_DB_KEY, normalized);
      _cached = normalized.planId;
    }
    return normalized;
  } catch {
    return null;
  }
}

async function writeRemotePlanState(state: LocalPlanState): Promise<void> {
  const session = await loadUserSession();
  if (!session?.token) return;

  try {
    await apiRequest('/api/subscription/me', {
      method: 'PUT',
      token: session.token,
      body: {
        planId: state.planId,
        status: state.status,
        paymentDueAt: state.paymentDueAt || '',
        paymentHour: state.paymentHour || '',
        paymentAmount: state.paymentAmount || '',
        enabled: state.enabled !== false,
      },
      timeoutMs: 6000,
    });
  } catch {
    // fallback local permanece valido
  }
}

export async function getLocalPlanState(): Promise<LocalPlanState | null> {
  const raw = await getDbValue<Partial<LocalPlanState>>(PLAN_STATE_DB_KEY);
  return normalizePlanState(raw);
}

export async function setLocalPlanState(
  planId: PlanId,
  partial?: Partial<Omit<LocalPlanState, 'planId' | 'updatedAt' | 'checkedAt'>>
) {
  const next = buildLocalPlanState(planId, partial);
  await setDbValue(PLAN_STATE_DB_KEY, next);
  _cached = planId;
  await writeRemotePlanState(next);
  return next;
}

export async function refreshPlanStateAtLaunch(): Promise<LocalPlanState | null> {
  const remote = await readRemotePlanState();
  if (remote) {
    return remote;
  }

  const current = await getLocalPlanState();
  if (!current) {
    return null;
  }

  const expired = isPlanExpired(current.planId, current.paymentDueAt);
  const nextPlanId: PlanId = expired ? 'free' : current.planId;
  const nextStatus: PlanStatus = expired ? 'expired' : current.status === 'unknown' ? 'active' : current.status;

  const updated: LocalPlanState = {
    ...current,
    planId: nextPlanId,
    status: nextStatus,
    updatedAt: expired ? new Date().toISOString() : current.updatedAt,
    checkedAt: new Date().toISOString(),
  };

  await setDbValue(PLAN_STATE_DB_KEY, updated);
  _cached = updated.planId;
  return updated;
}

export async function getActivePlan(): Promise<Plan> {
  const remote = await readRemotePlanState();
  if (remote) {
    return getPlan(remote.planId);
  }

  if (_cached) return getPlan(_cached);

  const localState = await getLocalPlanState();
  if (localState) {
    const nextId = isPlanExpired(localState.planId, localState.paymentDueAt) ? 'free' : localState.planId;
    _cached = nextId;
    return getPlan(nextId);
  }

  const stored = await getDbValue<string>(PLAN_KEY);
  const id = normalizePlanId(stored);
  _cached = id;
  return getPlan(id);
}

export async function getActivePlanId(): Promise<PlanId> {
  const plan = await getActivePlan();
  return plan.id;
}

/** Apenas para uso interno/dev — em produção o plano vem do backend. */
export async function setActivePlan(
  id: PlanId,
  metadata?: Partial<Omit<LocalPlanState, 'planId' | 'updatedAt' | 'checkedAt'>>
): Promise<void> {
  await setLocalPlanState(id, {
    status: metadata?.status || (id === 'free' ? 'unknown' : 'active'),
    paymentDueAt: metadata?.paymentDueAt,
    paymentHour: metadata?.paymentHour,
    paymentAmount: metadata?.paymentAmount,
    enabled: metadata?.enabled,
  });
}

/** Verifica se o plano ativo tem acesso a uma feature. */
export async function hasFeature(feature: Feature): Promise<boolean> {
  const plan = await getActivePlan();
  return plan.features.includes(feature);
}

/** Verifica se o plano ativo permite o número de perfis. */
export async function canAddProfile(currentCount: number): Promise<boolean> {
  const plan = await getActivePlan();
  if (plan.maxProfiles === -1) return true;
  return currentCount < plan.maxProfiles;
}

/** Verifica se o plano ativo permite o número de servidores. */
export async function canAddServer(currentCount: number): Promise<boolean> {
  const plan = await getActivePlan();
  if (plan.maxServers === -1) return true;
  return currentCount < plan.maxServers;
}

/** Qual o menor plano que inclui uma feature. */
export function minPlanForFeature(feature: Feature): Plan | null {
  return PLANS.find((p) => p.features.includes(feature)) ?? null;
}

// ─── Labels descritivos de features (para exibir na tela de assinatura) ───────

export const FEATURE_LABELS: Record<Feature, { label: string; icon: string; desc: string }> = {
  explore:                  { label: 'Explorar',            icon: 'explore',               desc: 'Navegação inteligente para encontrar rápido o conteúdo que você já possui' },
  downloads:                { label: 'Downloads offline',   icon: 'download',              desc: 'Baixe conteúdo para assistir sem internet' },
  lists:                    { label: 'Minhas listas',        icon: 'playlist-add',          desc: 'Crie e organize listas personalizadas do seu jeito' },
  cast_mirror:              { label: 'Espelhar na TV',       icon: 'cast',                  desc: 'Envie a reprodução para TV com Google Cast ou AirPlay' },
  pip:                      { label: 'Picture-in-Picture',   icon: 'picture-in-picture-alt',desc: 'Continue assistindo enquanto usa outros apps' },
  airplay:                  { label: 'AirPlay',              icon: 'airplay',               desc: 'Streaming direto para Apple TV e dispositivos AirPlay' },
  recommendation_algorithm: { label: 'Recomendações IA',    icon: 'auto-awesome',          desc: 'Algoritmo aprende seu gosto e sugere o que você vai amar' },
  tmdb_details:             { label: 'Elenco & detalhes',    icon: 'stars',                 desc: 'Elenco, nota, sinopse e informações completas via TMDB' },
  parental_controls:        { label: 'Controle dos pais',    icon: 'shield',                desc: 'Bloqueio por categoria, PIN por perfil e modo infantil' },
  realtime_monitor:         { label: 'Monitor em tempo real',icon: 'monitor',               desc: 'Veja em tempo real o que seus filhos estão assistindo' },
  multi_server:             { label: 'Multi-servidor',       icon: 'dns',                   desc: 'Cadastre vários servidores e alterne sem perder histórico' },
  multi_user:               { label: 'Multi-perfis',         icon: 'group',                 desc: 'Perfis separados com histórico e preferências próprias' },
  content_4k:               { label: 'Reprodução 4K',        icon: 'hd',                    desc: 'Recursos de reprodução e interface otimizados para conteúdo 4K' },
};
