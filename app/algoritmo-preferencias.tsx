import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppBackdrop } from '@/components/app-backdrop';
import { StreamingTheme } from '@/constants/streaming-theme';
import { completeAlgorithmOnboarding } from '@/services/behavior-intelligence';
import { hasLocalCatalogDataQuick } from '@/services/catalog-data';
import { getHomeRouteForDevice } from '@/services/device-profile';

const GENRE_OPTIONS = [
  'acao',
  'drama',
  'comedia',
  'suspense',
  'terror',
  'romance',
  'ficcao',
  'anime',
  'documentario',
  'aventura',
];

const CATEGORY_OPTIONS = [
  'lancamentos',
  'em alta',
  'classicos',
  'familia',
  'series curtas',
  'maratona',
  'premiados',
  'acao',
  'comedia',
  'suspense',
];

const MOOD_OPTIONS = ['leve', 'intenso', 'emocionante', 'engracado', 'misterioso', 'relax'];

const AGE_OPTIONS: Array<{ id: 'kids' | 'teen' | 'adult' | 'mixed'; label: string }> = [
  { id: 'kids', label: 'Infantil' },
  { id: 'teen', label: 'Teen' },
  { id: 'adult', label: 'Adulto' },
  { id: 'mixed', label: 'Misto' },
];

const TYPE_OPTIONS: Array<{ id: 'movie' | 'series' | 'live'; label: string }> = [
  { id: 'movie', label: 'Filmes' },
  { id: 'series', label: 'Series' },
  { id: 'live', label: 'Ao vivo' },
];

function ToggleGroup({
  title,
  options,
  values,
  onToggle,
}: {
  title: string;
  options: string[];
  values: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.chipsWrap}>
        {options.map((option) => {
          const active = values.includes(option);
          return (
            <TouchableOpacity
              key={option}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => onToggle(option)}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{option}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

export default function AlgoritmoPreferenciasScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ next?: string; entry?: string }>();
  const homeRoute = getHomeRouteForDevice();
  const insets = useSafeAreaInsets();
  const [favoriteGenres, setFavoriteGenres] = useState<string[]>([]);
  const [favoriteCategories, setFavoriteCategories] = useState<string[]>([]);
  const [preferredMood, setPreferredMood] = useState<string>('');
  const [preferredAge, setPreferredAge] = useState<'kids' | 'teen' | 'adult' | 'mixed'>('mixed');
  const [preferredTypes, setPreferredTypes] = useState<Array<'movie' | 'series' | 'live'>>(['movie', 'series']);
  const [saving, setSaving] = useState(false);

  const canSave = useMemo(
    () =>
      favoriteGenres.length > 0 ||
      favoriteCategories.length > 0 ||
      !!preferredMood ||
      preferredAge !== 'mixed' ||
      preferredTypes.length > 0,
    [favoriteGenres, favoriteCategories, preferredMood, preferredAge, preferredTypes]
  );

  const resolveNextRoute = async () => {
    const next = String(params?.next || '').trim();
    if (next === 'perfil-acesso') {
      const rawEntry = String(params?.entry || '').trim();
      const entry = rawEntry === 'loading' ? 'loading' : rawEntry === 'tv-home' ? 'tv-home' : 'home';
      router.replace(`/perfil-acesso?next=${entry}`);
      return;
    }

    const hasLocalData = await hasLocalCatalogDataQuick();
    if (hasLocalData) {
      router.replace(homeRoute as any);
    } else {
      router.replace({ pathname: '/loading', params: { from: 'profile' } });
    }
  };

  const toggleListValue = (current: string[], next: string, max = 5) => {
    if (current.includes(next)) {
      return current.filter((entry) => entry !== next);
    }
    return [...current, next].slice(0, max);
  };

  const handleSkip = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await completeAlgorithmOnboarding({ skipped: true });
      await resolveNextRoute();
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await completeAlgorithmOnboarding({
        preferences: {
          favoriteGenres,
          favoriteCategories,
          preferredMood,
          preferredAge,
          preferredTypes,
        },
      });
      await resolveNextRoute();
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={32} />

      <View style={styles.header}>
        <View>
          <Text style={styles.kicker}>IA personalizada</Text>
          <Text style={styles.title}>Ajuste inicial do seu gosto</Text>
          <Text style={styles.subtitle}>
            Opcional. Isso acelera as recomendacoes com dados reais do seu perfil.
          </Text>
        </View>
        <TouchableOpacity style={styles.skipBtn} onPress={handleSkip}>
          <Text style={styles.skipText}>Pular</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={[styles.scrollContent, { paddingBottom: 120 + insets.bottom }]}>
        <ToggleGroup
          title="Generos favoritos"
          options={GENRE_OPTIONS}
          values={favoriteGenres}
          onToggle={(value) => setFavoriteGenres((prev) => toggleListValue(prev, value, 6))}
        />

        <ToggleGroup
          title="Categorias que voce quer ver mais"
          options={CATEGORY_OPTIONS}
          values={favoriteCategories}
          onToggle={(value) => setFavoriteCategories((prev) => toggleListValue(prev, value, 6))}
        />

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Faixa de conteudo</Text>
          <View style={styles.rowWrap}>
            {AGE_OPTIONS.map((option) => {
              const active = preferredAge === option.id;
              return (
                <TouchableOpacity
                  key={option.id}
                  style={[styles.pill, active && styles.pillActive]}
                  onPress={() => setPreferredAge(option.id)}
                >
                  <Text style={[styles.pillText, active && styles.pillTextActive]}>{option.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Seu ritmo agora</Text>
          <View style={styles.rowWrap}>
            {MOOD_OPTIONS.map((option) => {
              const active = preferredMood === option;
              return (
                <TouchableOpacity
                  key={option}
                  style={[styles.pill, active && styles.pillActive]}
                  onPress={() => setPreferredMood(active ? '' : option)}
                >
                  <Text style={[styles.pillText, active && styles.pillTextActive]}>{option}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Tipos que voce mais usa</Text>
          <View style={styles.rowWrap}>
            {TYPE_OPTIONS.map((option) => {
              const active = preferredTypes.includes(option.id);
              return (
                <TouchableOpacity
                  key={option.id}
                  style={[styles.pill, active && styles.pillActive]}
                  onPress={() => {
                    setPreferredTypes((prev) => {
                      if (active) {
                        const next = prev.filter((item) => item !== option.id);
                        return next.length ? next : prev;
                      }
                      return [...prev, option.id].slice(0, 3);
                    });
                  }}
                >
                  <Text style={[styles.pillText, active && styles.pillTextActive]}>{option.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(12, insets.bottom) }]}>
        <TouchableOpacity
          style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={!canSave || saving}
        >
          <MaterialIcons name="auto-awesome" size={17} color={StreamingTheme.colors.textPrimary} />
          <Text style={styles.saveText}>{saving ? 'Salvando...' : 'Comecar com IA personalizada'}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: StreamingTheme.colors.background,
  },
  header: {
    paddingTop: 14,
    paddingHorizontal: 16,
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  kicker: {
    color: StreamingTheme.colors.accentAlt,
    letterSpacing: 1,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  title: {
    marginTop: 4,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 24,
    fontWeight: '900',
  },
  subtitle: {
    marginTop: 8,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    maxWidth: 300,
  },
  skipBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
  },
  skipText: {
    color: StreamingTheme.colors.textSecondary,
    fontWeight: '700',
    fontSize: 12,
  },
  scrollContent: {
    padding: 16,
    gap: 14,
    paddingBottom: 100,
  },
  section: {
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    borderRadius: 16,
    padding: 12,
    backgroundColor: StreamingTheme.colors.surface,
    gap: 10,
  },
  sectionTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  chipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  rowWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  chipActive: {
    backgroundColor: 'rgba(255,59,48,0.24)',
    borderColor: 'rgba(255,90,80,0.75)',
  },
  chipText: {
    color: StreamingTheme.colors.textSecondary,
    fontWeight: '700',
    fontSize: 12,
  },
  chipTextActive: {
    color: StreamingTheme.colors.textPrimary,
  },
  pill: {
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  pillActive: {
    borderColor: 'rgba(255,143,58,0.75)',
    backgroundColor: 'rgba(255,143,58,0.23)',
  },
  pillText: {
    color: StreamingTheme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  pillTextActive: {
    color: StreamingTheme.colors.textPrimary,
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 14,
    borderTopWidth: 1,
    borderTopColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(10,12,20,0.95)',
  },
  saveBtn: {
    height: 48,
    borderRadius: 12,
    backgroundColor: StreamingTheme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  saveBtnDisabled: {
    opacity: 0.5,
  },
  saveText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '900',
    fontSize: 13,
  },
});
