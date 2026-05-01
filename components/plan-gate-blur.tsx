/**
 * PlanGateBlur
 *
 * Envolve uma seção da tela e exibe um overlay "Assine agora" quando
 * o usuário não possui a feature requerida.
 *
 * Uso:
 *   <PlanGateBlur feature="tmdb_details" locked={!hasFeature('tmdb_details')}>
 *     <CastSection />
 *   </PlanGateBlur>
 */

import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { StreamingTheme } from '@/constants/streaming-theme';
import { Feature, FEATURE_LABELS, minPlanForFeature } from '@/services/subscription';

type Props = {
  feature: Feature;
  locked: boolean;
  children: React.ReactNode;
  /** Estilo opcional para o container externo */
  style?: object;
};

export function PlanGateBlur({ feature, locked, children, style }: Props) {
  const router = useRouter();

  if (!locked) return <>{children}</>;

  const minPlan = minPlanForFeature(feature);
  const info = FEATURE_LABELS[feature];
  const accentColor = minPlan?.color ?? StreamingTheme.colors.accent;

  return (
    <View style={[styles.wrapper, style]}>
      {/* Conteúdo desfocado (baixa opacidade) */}
      <View style={styles.blurredContent} pointerEvents="none">
        {children}
      </View>

      {/* Overlay */}
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <LinearGradient
          colors={['rgba(7,9,15,0.55)', 'rgba(7,9,15,0.82)', 'rgba(7,9,15,0.97)']}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.overlay}>
          <View style={[styles.lockBadge, { backgroundColor: accentColor + '22', borderColor: accentColor + '55' }]}>
            <MaterialIcons name="lock" size={20} color={accentColor} />
          </View>
          <Text style={styles.featureLabel}>{info.label}</Text>
          {minPlan && (
            <Text style={styles.planHint}>
              Disponível no plano{' '}
              <Text style={{ color: minPlan.color, fontWeight: '800' }}>{minPlan.name}</Text>{' '}
              ou superior
            </Text>
          )}
          <TouchableOpacity
            style={[styles.btn, { borderColor: accentColor }]}
            activeOpacity={0.8}
            onPress={() => router.push({ pathname: '/assinar', params: { feature } })}
          >
            <MaterialIcons name="workspace-premium" size={18} color={accentColor} />
            <Text style={[styles.btnText, { color: accentColor }]}>Assinar Premium</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    overflow: 'hidden',
    borderRadius: 14,
  },
  blurredContent: {
    opacity: 0.08,
  },
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 28,
    paddingHorizontal: 24,
    gap: 10,
  },
  lockBadge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  featureLabel: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '900',
    textAlign: 'center',
  },
  planHint: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 21,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: 1.5,
    borderRadius: 13,
    paddingHorizontal: 24,
    paddingVertical: 12,
    marginTop: 6,
  },
  btnText: {
    fontSize: 16,
    fontWeight: '800',
  },
});
