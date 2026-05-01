import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  Animated,
  Dimensions,
  Linking,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { StreamingTheme } from '@/constants/streaming-theme';
import {
  Feature,
  FEATURE_LABELS,
  Plan,
  PLANS,
  getActivePlanId,
  minPlanForFeature,
  PlanId,
} from '@/services/subscription';

const { width: W } = Dimensions.get('window');

// URL do seu site/página de assinatura
const SUBSCRIPTION_URL = 'https://asiptv.com.br/assinar';

// ─── Feature bloqueada que motivou a abertura (opcional) ─────────────────────
type Params = { feature?: Feature; from?: string };

// ─── Dados de marketing ───────────────────────────────────────────────────────
const TRIGGERS = [
  { icon: 'bolt' as const,           text: 'Use seu próprio conteúdo com desempenho e organização' },
  { icon: 'hd' as const,             text: 'Recursos avançados de reprodução (incluindo 4K)' },
  { icon: 'download' as const,       text: 'Baixe para assistir offline quando quiser' },
  { icon: 'auto-awesome' as const,   text: 'Recomendações inteligentes com seu histórico' },
  { icon: 'cast' as const,           text: 'Espelhamento e transmissão para TV' },
  { icon: 'shield' as const,         text: 'Controle parental e monitoramento em tempo real' },
  { icon: 'picture-in-picture-alt' as const, text: 'PiP para continuar assistindo em miniatura' },
  { icon: 'group' as const,          text: 'Perfis e servidores extras para toda a família' },
];

// ─── Tabela de features por plano ────────────────────────────────────────────
const PLAN_FEATURES: { feature: Feature; plans: PlanId[] }[] = [
  { feature: 'explore',                  plans: ['plus', 'pro', 'ultra', 'lifetime'] },
  { feature: 'downloads',                plans: ['plus', 'pro', 'ultra', 'lifetime'] },
  { feature: 'lists',                    plans: ['plus', 'pro', 'ultra', 'lifetime'] },
  { feature: 'cast_mirror',              plans: ['plus', 'pro', 'ultra', 'lifetime'] },
  { feature: 'pip',                      plans: ['plus', 'pro', 'ultra', 'lifetime'] },
  { feature: 'airplay',                  plans: ['pro', 'ultra', 'lifetime'] },
  { feature: 'recommendation_algorithm', plans: ['pro', 'ultra', 'lifetime'] },
  { feature: 'tmdb_details',             plans: ['pro', 'ultra', 'lifetime'] },
  { feature: 'multi_user',               plans: ['pro', 'ultra', 'lifetime'] },
  { feature: 'multi_server',             plans: ['pro', 'ultra', 'lifetime'] },
  { feature: 'parental_controls',        plans: ['ultra', 'lifetime'] },
  { feature: 'realtime_monitor',         plans: ['ultra', 'lifetime'] },
  { feature: 'content_4k',               plans: ['ultra', 'lifetime'] },
];

// ─── Subcomponentes ───────────────────────────────────────────────────────────
function TriggerBadge({ icon, text }: { icon: keyof typeof MaterialIcons.glyphMap; text: string }) {
  return (
    <View style={styles.trigger}>
      <MaterialIcons name={icon} size={18} color={StreamingTheme.colors.accentAlt} />
      <Text style={styles.triggerText}>{text}</Text>
    </View>
  );
}

type PlanCardProps = {
  plan: Plan;
  isCurrent: boolean;
  isRecommended: boolean;
  onPress: () => void;
};

function PlanCard({ plan, isCurrent, isRecommended, onPress }: PlanCardProps) {
  const scale = React.useRef(new Animated.Value(1)).current;

  const onPressIn = () => Animated.spring(scale, { toValue: 0.97, useNativeDriver: true }).start();
  const onPressOut = () => Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start();

  const paidPlans = PLANS.filter((p) => p.id !== 'free');
  const planIndex = paidPlans.findIndex((p) => p.id === plan.id);
  const prevPlan = planIndex > 0 ? paidPlans[planIndex - 1] : null;

  const exclusiveFeatures = PLAN_FEATURES.filter((pf) => {
    const minPlan = pf.plans[0];
    return minPlan === plan.id;
  });

  return (
    <Animated.View style={[styles.planCard, isRecommended && styles.planCardHighlighted, { transform: [{ scale }] }]}>
      {isRecommended && (
        <View style={[styles.recommendedBadge, { backgroundColor: plan.color }]}>
          <Text style={styles.recommendedBadgeText}>MAIS POPULAR</Text>
        </View>
      )}

      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
      >
        {/* Header do card */}
        <View style={styles.planHeader}>
          <View style={[styles.planDot, { backgroundColor: plan.color }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.planName}>{plan.name}</Text>
            <Text style={styles.planTagline}>{plan.tagline}</Text>
          </View>
          <View style={styles.planPriceBox}>
            <Text style={[styles.planPrice, { color: plan.color }]}>{plan.price}</Text>
            <Text style={styles.planPriceNote}>{plan.priceNote}</Text>
          </View>
        </View>

        {/* Limites */}
        {plan.id !== 'free' && (
          <View style={styles.limitsRow}>
            <View style={styles.limitBadge}>
              <MaterialIcons name="person" size={12} color={plan.color} />
              <Text style={[styles.limitText, { color: plan.color }]}>
                {plan.maxProfiles === -1 ? 'Perfis ilimitados' : `${plan.maxProfiles} perfil${plan.maxProfiles > 1 ? 'is' : ''}`}
              </Text>
            </View>
            <View style={styles.limitBadge}>
              <MaterialIcons name="dns" size={12} color={plan.color} />
              <Text style={[styles.limitText, { color: plan.color }]}>
                {plan.maxServers === -1 ? 'Servidores ilimitados' : `${plan.maxServers} servidor${plan.maxServers > 1 ? 'es' : ''}`}
              </Text>
            </View>
          </View>
        )}

        {/* Features incluídas/adicionadas */}
        <View style={styles.planFeatureList}>
          {plan.id === 'free' ? (
            <View style={styles.planFeatureRow}>
              <MaterialIcons name="check" size={14} color={plan.color} />
              <Text style={styles.planFeatureText}>Use todo o seu conteúdo; recursos avançados ficam nos planos pagos</Text>
            </View>
          ) : (
            <>
              {prevPlan && (
                <View style={styles.planFeatureRow}>
                  <MaterialIcons name="check-circle" size={14} color={plan.color} />
                  <Text style={styles.planFeatureText}>Tudo do plano {prevPlan.name} +</Text>
                </View>
              )}
              {exclusiveFeatures.map((ef) => (
                <View key={ef.feature} style={styles.planFeatureRow}>
                  <MaterialIcons name={FEATURE_LABELS[ef.feature].icon as any} size={14} color={plan.color} />
                  <Text style={styles.planFeatureText}>{FEATURE_LABELS[ef.feature].label}</Text>
                </View>
              ))}
            </>
          )}
        </View>

        {/* Botão */}
        {!isCurrent && plan.id !== 'free' && (
          <View style={[styles.planBtn, { borderColor: plan.color }]}>
            <Text style={[styles.planBtnText, { color: plan.color }]}>
              {plan.id === 'lifetime' ? 'Adquirir acesso vitalicio' : `Assinar ${plan.name}`}
            </Text>
          </View>
        )}
        {isCurrent && (
          <View style={[styles.planBtn, { borderColor: StreamingTheme.colors.textMuted, opacity: 0.5 }]}>
            <Text style={[styles.planBtnText, { color: StreamingTheme.colors.textMuted }]}>Plano atual</Text>
          </View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Tela principal ───────────────────────────────────────────────────────────
export default function AssinarScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const [currentPlanId, setCurrentPlanId] = useState<PlanId>('free');
  const heroOpacity = React.useRef(new Animated.Value(0)).current;
  const heroY = React.useRef(new Animated.Value(24)).current;

  const lockedFeature = params.feature as Feature | undefined;
  const minPlan = lockedFeature ? minPlanForFeature(lockedFeature) : null;

  useEffect(() => {
    getActivePlanId().then(setCurrentPlanId);
    Animated.parallel([
      Animated.timing(heroOpacity, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.timing(heroY, { toValue: 0, duration: 500, useNativeDriver: true }),
    ]).start();
  }, []);

  const openSubscription = (plan: Plan) => {
    if (plan.id === 'free') return;
    Linking.openURL(`${SUBSCRIPTION_URL}?plano=${plan.id}`).catch(() => {
      Linking.openURL(SUBSCRIPTION_URL);
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <LinearGradient
        colors={['#1A0A2E', '#0D1A38', '#07090F']}
        style={StyleSheet.absoluteFill}
      />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Planos & Assinatura</Text>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

        {/* Hero */}
        <Animated.View style={[styles.hero, { opacity: heroOpacity, transform: [{ translateY: heroY }] }]}>
          {lockedFeature ? (
            <>
              <View style={[styles.lockBadge, { backgroundColor: (minPlan?.color ?? StreamingTheme.colors.accent) + '22' }]}>
                <MaterialIcons
                  name={FEATURE_LABELS[lockedFeature].icon as any}
                  size={32}
                  color={minPlan?.color ?? StreamingTheme.colors.accent}
                />
              </View>
              <Text style={styles.heroKicker}>RECURSO PREMIUM</Text>
              <Text style={styles.heroTitle}>{FEATURE_LABELS[lockedFeature].label}</Text>
              <Text style={styles.heroDesc}>{FEATURE_LABELS[lockedFeature].desc}</Text>
              {minPlan && (
                <Text style={styles.heroPlanHint}>
                  Disponível a partir do plano{' '}
                  <Text style={{ color: minPlan.color, fontWeight: '800' }}>{minPlan.name}</Text>
                </Text>
              )}
            </>
          ) : (
            <>
              <View style={styles.lockBadge}>
                <MaterialIcons name="workspace-premium" size={36} color={StreamingTheme.colors.accentAlt} />
              </View>
              <Text style={styles.heroKicker}>DESBLOQUEIE TODO O POTENCIAL</Text>
              <Text style={styles.heroTitle}>Escolha o plano ideal</Text>
              <Text style={styles.heroDesc}>
                O app nao fornece conteúdo. Ele gerencia e reproduz o conteúdo que você já possui; os planos pagos liberam recursos premium do app.
              </Text>
            </>
          )}
        </Animated.View>

        {/* Gatilhos de valor */}
        <View style={styles.triggersGrid}>
          {TRIGGERS.map((t) => (
            <TriggerBadge key={t.text} icon={t.icon} text={t.text} />
          ))}
        </View>

        {/* Planos */}
        <Text style={styles.sectionLabel}>COMPARE OS PLANOS</Text>
        {PLANS.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            isCurrent={plan.id === currentPlanId}
            isRecommended={!!plan.highlighted}
            onPress={() => openSubscription(plan)}
          />
        ))}

        {/* Comparativo de features */}
        <Text style={[styles.sectionLabel, { marginTop: 28 }]}>COMPARATIVO DE RECURSOS</Text>
        <View style={styles.compareTable}>
          {/* Cabeçalho */}
          <View style={styles.compareHeader}>
            <Text style={[styles.compareColLabel, { flex: 2 }]}>Recurso</Text>
            {['Plus', 'Pro', 'Ultra', 'Life'].map((n) => (
              <Text key={n} style={styles.compareColLabel}>{n}</Text>
            ))}
          </View>
          {/* Linhas */}
          {PLAN_FEATURES.map(({ feature, plans }, i) => (
            <View key={feature} style={[styles.compareRow, i % 2 === 1 && styles.compareRowAlt]}>
              <View style={[{ flex: 2 }, styles.compareFeatureCell]}>
                <MaterialIcons
                  name={FEATURE_LABELS[feature].icon as any}
                  size={13}
                  color={StreamingTheme.colors.textMuted}
                />
                <Text style={styles.compareFeatureText}>{FEATURE_LABELS[feature].label}</Text>
              </View>
              {(['plus', 'pro', 'ultra', 'lifetime'] as PlanId[]).map((pid) => (
                <View key={pid} style={styles.compareCheckCell}>
                  <MaterialIcons
                    name={plans.includes(pid) ? 'check' : 'close'}
                    size={16}
                    color={
                      plans.includes(pid)
                        ? (PLANS.find((p) => p.id === pid)?.color ?? '#2CD07F')
                        : 'rgba(127,137,168,0.3)'
                    }
                  />
                </View>
              ))}
            </View>
          ))}
        </View>

        {/* CTA final */}
        <View style={styles.ctaBox}>
          <Text style={styles.ctaTitle}>Pronto para desbloquear tudo?</Text>
          <Text style={styles.ctaDesc}>
            Acesse nosso site para escolher seu plano e ativar em segundos. O plano altera apenas os recursos do app, sem interferir no seu conteúdo.
          </Text>
          <TouchableOpacity
            style={styles.ctaBtn}
            onPress={() => Linking.openURL(SUBSCRIPTION_URL)}
            activeOpacity={0.85}
          >
            <LinearGradient
              colors={['#FF8F3A', '#FF3B30']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.ctaBtnGradient}
            >
              <MaterialIcons name="open-in-new" size={18} color="#fff" />
              <Text style={styles.ctaBtnText}>Ver planos no site →</Text>
            </LinearGradient>
          </TouchableOpacity>

          <Text style={styles.ctaFine}>
            Após assinar, abra o app e seu plano será ativado automaticamente.
          </Text>
        </View>

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
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  backBtn: { padding: 6 },
  headerTitle: { color: StreamingTheme.colors.textPrimary, fontSize: 15, fontWeight: '700' },
  scroll: { paddingHorizontal: 16, paddingTop: 4 },

  // Hero
  hero: { alignItems: 'center', paddingVertical: 24 },
  lockBadge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,143,58,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  heroKicker: {
    color: StreamingTheme.colors.accentAlt,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginBottom: 8,
  },
  heroTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 26,
    fontWeight: '900',
    textAlign: 'center',
    lineHeight: 32,
    marginBottom: 10,
  },
  heroDesc: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 21,
    maxWidth: W * 0.85,
  },
  heroPlanHint: {
    marginTop: 14,
    color: StreamingTheme.colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
  },

  // Gatilhos
  triggersGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 24,
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,143,58,0.08)',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,143,58,0.18)',
  },
  triggerText: { color: StreamingTheme.colors.textSecondary, fontSize: 12 },

  // Section label
  sectionLabel: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 12,
  },

  // Plan cards
  planCard: {
    backgroundColor: StreamingTheme.colors.surface,
    borderRadius: 18,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  planCardHighlighted: {
    borderColor: '#FF8F3A',
    borderWidth: 1.5,
    backgroundColor: 'rgba(255,143,58,0.06)',
  },
  recommendedBadge: {
    alignSelf: 'flex-start',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 10,
  },
  recommendedBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
  },
  planHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 10,
  },
  planDot: { width: 10, height: 10, borderRadius: 5, marginTop: 5 },
  planName: { color: StreamingTheme.colors.textPrimary, fontSize: 16, fontWeight: '800' },
  planTagline: { color: StreamingTheme.colors.textMuted, fontSize: 12, marginTop: 2 },
  planPriceBox: { alignItems: 'flex-end' },
  planPrice: { fontSize: 16, fontWeight: '900' },
  planPriceNote: { color: StreamingTheme.colors.textMuted, fontSize: 10, marginTop: 2 },
  limitsRow: { flexDirection: 'row', gap: 8, marginBottom: 10, flexWrap: 'wrap' },
  limitBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  limitText: { fontSize: 11, fontWeight: '600' },
  planFeatureList: { gap: 6, marginBottom: 14 },
  planFeatureRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  planFeatureText: { color: StreamingTheme.colors.textSecondary, fontSize: 13 },
  planBtn: {
    borderRadius: 10,
    borderWidth: 1.5,
    paddingVertical: 10,
    alignItems: 'center',
  },
  planBtnText: { fontSize: 14, fontWeight: '800' },

  // Comparativo
  compareTable: {
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    marginBottom: 8,
  },
  compareHeader: {
    flexDirection: 'row',
    backgroundColor: StreamingTheme.colors.surface,
    padding: 10,
    gap: 4,
  },
  compareColLabel: {
    flex: 1,
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  compareRow: {
    flexDirection: 'row',
    paddingVertical: 9,
    paddingHorizontal: 10,
    alignItems: 'center',
    gap: 4,
  },
  compareRowAlt: { backgroundColor: 'rgba(255,255,255,0.03)' },
  compareFeatureCell: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  compareFeatureText: { color: StreamingTheme.colors.textSecondary, fontSize: 12 },
  compareCheckCell: { flex: 1, alignItems: 'center' },

  // CTA
  ctaBox: {
    alignItems: 'center',
    paddingVertical: 28,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.07)',
    marginTop: 12,
  },
  ctaTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 10,
  },
  ctaDesc: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: W * 0.85,
    marginBottom: 20,
  },
  ctaBtn: { width: '100%', borderRadius: 14, overflow: 'hidden', marginBottom: 12 },
  ctaBtnGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
  },
  ctaBtnText: { color: '#fff', fontSize: 16, fontWeight: '900' },
  ctaFine: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 16,
  },
});
