import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';

import { StreamingTheme } from '@/constants/streaming-theme';

type ReasonKind = 'genre' | 'category' | 'history' | 'time' | 'weekend' | 'general';

type RecommendationChipProps = {
  reason?: string;
  overlay?: boolean;
  numberOfLines?: number;
  style?: StyleProp<ViewStyle>;
  seed?: string;
};

const TOKENS: Array<{ kind: ReasonKind; test: (text: string) => boolean }> = [
  {
    kind: 'genre',
    test: (text) =>
      text.includes('ação') ||
      text.includes('acao') ||
      text.includes('comédia') ||
      text.includes('comedia') ||
      text.includes('drama') ||
      text.includes('suspense') ||
      text.includes('romance') ||
      text.includes('ficção') ||
      text.includes('história viciante') ||
      text.includes('maratonar') ||
      text.includes('rir'),
  },
  {
    kind: 'category',
    test: (text) =>
      text.includes('categoria') ||
      text.includes('consome bastante') ||
      text.includes('alta afinidade'),
  },
  {
    kind: 'history',
    test: (text) =>
      text.includes('histórico') ||
      text.includes('parecido') ||
      text.includes('seu perfil') ||
      text.includes('seu tipo') ||
      text.includes('você parou') ||
      text.includes('retome') ||
      text.includes('continue'),
  },
  {
    kind: 'time',
    test: (text) =>
      text.includes('agora') ||
      text.includes('horário') ||
      text.includes('horario') ||
      text.includes('noite') ||
      text.includes('tarde') ||
      text.includes('manhã') ||
      text.includes('manha') ||
      text.includes('momento'),
  },
  { kind: 'weekend', test: (text) => text.includes('fim de semana') || text.includes('maratona de fim de semana') },
];

const KIND_META: Record<ReasonKind, { icon: keyof typeof MaterialIcons.glyphMap; tint: string }> = {
  genre: { icon: 'local-fire-department', tint: '#FF9F43' },
  category: { icon: 'category', tint: '#46D7B7' },
  history: { icon: 'history', tint: '#5DA8FF' },
  time: { icon: 'schedule', tint: '#C48BFF' },
  weekend: { icon: 'weekend', tint: '#FFD166' },
  general: { icon: 'auto-awesome', tint: StreamingTheme.colors.accentAlt },
};

const TINT_VARIANTS = ['#FF9F43', '#46D7B7', '#5DA8FF', '#C48BFF', '#FFD166', '#FF6B6B', '#4ECDC4'];

function detectReasonKind(reason: string): ReasonKind {
  const normalized = reason.trim().toLowerCase();
  const match = TOKENS.find((token) => token.test(normalized));
  return match?.kind ?? 'general';
}

function toRgba(hex: string, alpha: number) {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return `rgba(255,255,255,${alpha})`;
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function hashSeed(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function RecommendationChip({
  reason,
  overlay = false,
  numberOfLines = 1,
  style,
  seed,
}: RecommendationChipProps) {
  if (!reason) return null;

  const kind = detectReasonKind(reason);
  const meta = KIND_META[kind];
  const tint = seed
    ? TINT_VARIANTS[hashSeed(`${seed}-${kind}`) % TINT_VARIANTS.length]
    : meta.tint;

  return (
    <View
      style={[
        styles.base,
        overlay
          ? { backgroundColor: toRgba(tint, 0.2), borderColor: toRgba(tint, 0.42) }
          : { backgroundColor: toRgba(tint, 0.14), borderColor: toRgba(tint, 0.32) },
        style,
      ]}
    >
      <MaterialIcons name={meta.icon} size={12} color={tint} />
      <Text
        style={[
          styles.text,
          overlay
            ? { color: 'rgba(255,255,255,0.95)' }
            : { color: StreamingTheme.colors.textSecondary },
        ]}
        numberOfLines={numberOfLines}
      >
        {reason}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: '100%',
  },
  text: {
    fontSize: 10,
    fontWeight: '700',
    flexShrink: 1,
  },
});
