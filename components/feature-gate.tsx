import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { StreamingTheme } from '@/constants/streaming-theme';
import { Feature, FEATURE_LABELS, minPlanForFeature } from '@/services/subscription';

type Props = {
  feature: Feature;
  children: React.ReactNode;
  locked: boolean;
};

/**
 * Envolve conteúdo e exibe um banner de bloqueio quando `locked=true`.
 * O banner leva o usuário para a tela de assinatura.
 */
export function FeatureGate({ feature, children, locked }: Props) {
  const router = useRouter();
  const minPlan = minPlanForFeature(feature);
  const info = FEATURE_LABELS[feature];
  const ctaLabel =
    feature === 'lists'
      ? 'Assinar Premium • Listas'
      : feature === 'downloads'
        ? 'Assinar Premium • Download'
        : 'Ver planos e assinar';

  if (!locked) return <>{children}</>;

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={['#1A0A2E', '#0D1A38', '#07090F']}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.iconBox, { backgroundColor: (minPlan?.color ?? StreamingTheme.colors.accent) + '18' }]}>
        <MaterialIcons
          name={info.icon as any}
          size={42}
          color={minPlan?.color ?? StreamingTheme.colors.accent}
        />
      </View>

      <View style={styles.lockIconBadge}>
        <MaterialIcons name="lock" size={14} color={StreamingTheme.colors.textMuted} />
      </View>

      <Text style={styles.title}>{info.label}</Text>
      <Text style={styles.desc}>{info.desc}</Text>

      {minPlan && (
        <Text style={styles.planHint}>
          Disponível no plano{' '}
          <Text style={{ color: minPlan.color, fontWeight: '800' }}>{minPlan.name}</Text> ou superior
        </Text>
      )}

      <TouchableOpacity
        style={[styles.btn, { borderColor: minPlan?.color ?? StreamingTheme.colors.accent }]}
        onPress={() => router.push({ pathname: '/assinar', params: { feature } })}
        activeOpacity={0.8}
      >
        <MaterialIcons name="workspace-premium" size={16} color={minPlan?.color ?? StreamingTheme.colors.accent} />
        <Text style={[styles.btnText, { color: minPlan?.color ?? StreamingTheme.colors.accent }]}>
          {ctaLabel}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: StreamingTheme.colors.background,
  },
  iconBox: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  lockIconBadge: {
    position: 'absolute',
    top: '30%',
    right: '28%',
    backgroundColor: StreamingTheme.colors.surface,
    borderRadius: 12,
    padding: 4,
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 10,
  },
  desc: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: 14,
  },
  planHint: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 24,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1.5,
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 13,
  },
  btnText: { fontSize: 15, fontWeight: '800' },
});
