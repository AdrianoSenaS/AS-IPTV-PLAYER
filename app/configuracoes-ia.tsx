import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, StatusBar, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackdrop } from '@/components/app-backdrop';
import { PageLoader } from '@/components/page-loader';
import { StreamingTheme } from '@/constants/streaming-theme';
import {
  AiDeviceProfile,
  AiLearningIntensity,
  AiLearningWindow,
  loadAiRuntimeTuning,
  loadAiSettings,
  updateAiSettings,
} from '@/services/ai-settings';

const WINDOW_OPTIONS: Array<{ id: AiLearningWindow; label: string; caption: string }> = [
  { id: '1d', label: '1 dia', caption: 'Aprende e atualiza diariamente' },
  { id: '2d', label: '2 dias', caption: 'Equilibrio entre performance e aprendizado' },
  { id: '7d', label: '7 dias', caption: 'Mais leve, atualizacoes semanais' },
];

const INTENSITY_OPTIONS: Array<{ id: AiLearningIntensity; label: string; caption: string }> = [
  { id: 'leve', label: 'Leve', caption: 'Menos CPU, menor volume de sinais' },
  { id: 'normal', label: 'Normal', caption: 'Balanceado para uso geral' },
  { id: 'agressivo', label: 'Agressivo', caption: 'Mais sinais, aprendizado mais forte' },
];

const DEVICE_PROFILE_OPTIONS: Array<{ id: AiDeviceProfile; label: string; caption: string }> = [
  { id: 'economico', label: 'Economico', caption: 'Celulares de entrada. Menor consumo de CPU.' },
  { id: 'balanceado', label: 'Balanceado', caption: 'Padrao recomendado para a maioria.' },
  { id: 'potente', label: 'Potente', caption: 'Celulares fortes. Maior volume e recalcule mais rapido.' },
];

export default function ConfiguracoesIaScreen() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [learningWindow, setLearningWindow] = useState<AiLearningWindow>('2d');
  const [learningIntensity, setLearningIntensity] = useState<AiLearningIntensity>('normal');
  const [deviceProfile, setDeviceProfile] = useState<AiDeviceProfile>('balanceado');
  const [tmdbEnrichmentEnabled, setTmdbEnrichmentEnabled] = useState(true);
  const [recommendationChipsEnabled, setRecommendationChipsEnabled] = useState(true);
  const [recomputeOnHomeFocus, setRecomputeOnHomeFocus] = useState(false);
  const [runtimeSummary, setRuntimeSummary] = useState('');

  const hydrate = useCallback(async () => {
    setIsLoading(true);
    try {
      const settings = await loadAiSettings();
      const runtime = await loadAiRuntimeTuning(settings);
      setEnabled(settings.enabled);
      setLearningWindow(settings.learningWindow);
      setLearningIntensity(settings.learningIntensity);
      setDeviceProfile(settings.deviceProfile);
      setTmdbEnrichmentEnabled(settings.tmdbEnrichmentEnabled);
      setRecommendationChipsEnabled(settings.recommendationChipsEnabled);
      setRecomputeOnHomeFocus(settings.recomputeOnHomeFocus);
      setRuntimeSummary(
        `Home: boot ${runtime.homeBootVodLimit}/${runtime.homeBootSeriesLimit}/${runtime.homeBootLiveLimit} | ` +
          `pool ${runtime.homeVodPoolLimit}/${runtime.homeSeriesPoolLimit}/${runtime.homeLivePoolLimit} | ` +
          `amostra IA ${runtime.homeProfileSampleLimit}`
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void hydrate();
    }, [hydrate])
  );

  const learningHint = useMemo(() => {
    if (learningWindow === '1d') return 'Atualizacao diaria ativada para perfil mais dinamico.';
    if (learningWindow === '7d') return 'Atualizacao semanal ativada para consumo minimo de CPU.';
    return 'Atualizacao em 2 dias, recomendado para uso geral.';
  }, [learningWindow]);

  const intensityHint = useMemo(() => {
    if (learningIntensity === 'leve') {
      return 'Modo leve: prioriza desempenho e reduz custo de processamento.';
    }
    if (learningIntensity === 'agressivo') {
      return 'Modo agressivo: aprende com mais sinais para maior personalizacao.';
    }
    return 'Modo normal: equilibrio entre performance e qualidade de recomendacao.';
  }, [learningIntensity]);

  const profileHint = useMemo(() => {
    if (deviceProfile === 'economico') {
      return 'Perfil economico: reduz consultas e volume de listas para evitar travamentos.';
    }
    if (deviceProfile === 'potente') {
      return 'Perfil potente: aumenta amostras e lotes de IA para mais personalizacao.';
    }
    return 'Perfil balanceado: bom equilibrio entre fluidez e qualidade de recomendacao.';
  }, [deviceProfile]);

  const saveAndRefresh = async (partial: Parameters<typeof updateAiSettings>[0]) => {
    const next = await updateAiSettings(partial);
    const runtime = await loadAiRuntimeTuning(next);
    setRuntimeSummary(
      `Home: boot ${runtime.homeBootVodLimit}/${runtime.homeBootSeriesLimit}/${runtime.homeBootLiveLimit} | ` +
        `pool ${runtime.homeVodPoolLimit}/${runtime.homeSeriesPoolLimit}/${runtime.homeLivePoolLimit} | ` +
        `amostra IA ${runtime.homeProfileSampleLimit}`
    );
  };

  const onToggleEnabled = async (value: boolean) => {
    setEnabled(value);
    await saveAndRefresh({ enabled: value });
  };

  const onChangeWindow = async (next: AiLearningWindow) => {
    setLearningWindow(next);
    await saveAndRefresh({ learningWindow: next });
  };

  const onChangeIntensity = async (next: AiLearningIntensity) => {
    setLearningIntensity(next);
    await saveAndRefresh({ learningIntensity: next });
  };

  const onChangeDeviceProfile = async (next: AiDeviceProfile) => {
    setDeviceProfile(next);
    await saveAndRefresh({ deviceProfile: next });
  };

  const onToggleTmdbEnrichment = async (value: boolean) => {
    setTmdbEnrichmentEnabled(value);
    await saveAndRefresh({ tmdbEnrichmentEnabled: value });
  };

  const onToggleRecommendationChips = async (value: boolean) => {
    setRecommendationChipsEnabled(value);
    await saveAndRefresh({ recommendationChipsEnabled: value });
  };

  const onToggleRecomputeOnFocus = async (value: boolean) => {
    setRecomputeOnHomeFocus(value);
    await saveAndRefresh({ recomputeOnHomeFocus: value });
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isLoading} label="Carregando IA" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.kicker}>PREFERENCIAS INTELIGENTES</Text>
            <Text style={styles.title}>IA e aprendizado</Text>
          </View>
          <View style={styles.iconBtn} />
        </View>

        <View style={styles.card}>
          <View style={styles.toggleRow}>
            <View style={styles.toggleTextWrap}>
              <Text style={styles.toggleLabel}>Ativar algoritmo de IA</Text>
              <Text style={styles.toggleCaption}>
                Quando desativado, o app mostra apenas ordenacao padrao e ignora recomendacoes inteligentes.
              </Text>
            </View>
            <Switch
              value={enabled}
              onValueChange={onToggleEnabled}
              thumbColor={StreamingTheme.colors.textPrimary}
              trackColor={{ false: 'rgba(255,255,255,0.2)', true: 'rgba(255,59,48,0.55)' }}
            />
          </View>
        </View>

        <View style={[styles.card, !enabled && styles.cardDisabled]}>
          <Text style={styles.sectionTitle}>Filtro de aprendizado</Text>
          <Text style={styles.caption}>
            Define de quanto em quanto tempo o perfil de recomendacao sera recalculado com novos sinais de uso.
          </Text>

          <View style={styles.periodGrid}>
            {WINDOW_OPTIONS.map((option) => {
              const active = learningWindow === option.id;
              return (
                <TouchableOpacity
                  key={option.id}
                  style={[styles.periodChip, active && styles.periodChipActive]}
                  onPress={() => onChangeWindow(option.id)}
                  disabled={!enabled}
                >
                  <Text style={[styles.periodChipText, active && styles.periodChipTextActive]}>{option.label}</Text>
                  <Text style={[styles.periodChipSub, active && styles.periodChipSubActive]}>{option.caption}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.tipRow}>
            <MaterialIcons name="tips-and-updates" size={16} color={StreamingTheme.colors.accentAlt} />
            <Text style={styles.tipText}>{learningHint}</Text>
          </View>
        </View>

        <View style={[styles.card, !enabled && styles.cardDisabled]}>
          <Text style={styles.sectionTitle}>Intensidade do aprendizado</Text>
          <Text style={styles.caption}>
            Controla quantos sinais a IA processa e guarda para montar seu perfil inteligente.
          </Text>

          <View style={styles.periodGrid}>
            {INTENSITY_OPTIONS.map((option) => {
              const active = learningIntensity === option.id;
              return (
                <TouchableOpacity
                  key={option.id}
                  style={[styles.periodChip, active && styles.periodChipActive]}
                  onPress={() => onChangeIntensity(option.id)}
                  disabled={!enabled}
                >
                  <Text style={[styles.periodChipText, active && styles.periodChipTextActive]}>{option.label}</Text>
                  <Text style={[styles.periodChipSub, active && styles.periodChipSubActive]}>{option.caption}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.tipRow}>
            <MaterialIcons name="psychology" size={16} color={StreamingTheme.colors.accentAlt} />
            <Text style={styles.tipText}>{intensityHint}</Text>
          </View>
        </View>

        <View style={[styles.card, !enabled && styles.cardDisabled]}>
          <Text style={styles.sectionTitle}>Perfil de desempenho do aparelho</Text>
          <Text style={styles.caption}>
            Ajusta automaticamente limites de consultas, listas e processamento da IA na Home.
          </Text>

          <View style={styles.periodGrid}>
            {DEVICE_PROFILE_OPTIONS.map((option) => {
              const active = deviceProfile === option.id;
              return (
                <TouchableOpacity
                  key={option.id}
                  style={[styles.periodChip, active && styles.periodChipActive]}
                  onPress={() => onChangeDeviceProfile(option.id)}
                  disabled={!enabled}
                >
                  <Text style={[styles.periodChipText, active && styles.periodChipTextActive]}>{option.label}</Text>
                  <Text style={[styles.periodChipSub, active && styles.periodChipSubActive]}>{option.caption}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.tipRow}>
            <MaterialIcons name="speed" size={16} color={StreamingTheme.colors.accentAlt} />
            <Text style={styles.tipText}>{profileHint}</Text>
          </View>
          <Text style={styles.runtimeSummary}>{runtimeSummary}</Text>
        </View>

        <View style={[styles.card, !enabled && styles.cardDisabled]}>
          <Text style={styles.sectionTitle}>Controles avancados de processamento</Text>
          <Text style={styles.caption}>
            Personalize recursos que impactam CPU/GPU durante carregamento e exibicao da Home.
          </Text>

          <View style={styles.settingRow}>
            <View style={styles.toggleTextWrap}>
              <Text style={styles.toggleLabel}>Enriquecimento TMDB</Text>
              <Text style={styles.toggleCaption}>Desative para reduzir custo de metadata e ranqueamento inicial.</Text>
            </View>
            <Switch
              value={tmdbEnrichmentEnabled}
              onValueChange={onToggleTmdbEnrichment}
              thumbColor={StreamingTheme.colors.textPrimary}
              trackColor={{ false: 'rgba(255,255,255,0.2)', true: 'rgba(255,59,48,0.55)' }}
              disabled={!enabled}
            />
          </View>

          <View style={styles.settingRow}>
            <View style={styles.toggleTextWrap}>
              <Text style={styles.toggleLabel}>Chips de recomendacao</Text>
              <Text style={styles.toggleCaption}>Desative para reduzir renderizacao extra nos cards.</Text>
            </View>
            <Switch
              value={recommendationChipsEnabled}
              onValueChange={onToggleRecommendationChips}
              thumbColor={StreamingTheme.colors.textPrimary}
              trackColor={{ false: 'rgba(255,255,255,0.2)', true: 'rgba(255,59,48,0.55)' }}
              disabled={!enabled}
            />
          </View>

          <View style={styles.settingRow}>
            <View style={styles.toggleTextWrap}>
              <Text style={styles.toggleLabel}>Recalcular IA ao voltar para Home</Text>
              <Text style={styles.toggleCaption}>Ative apenas em aparelhos fortes para recomendacoes mais dinamicas.</Text>
            </View>
            <Switch
              value={recomputeOnHomeFocus}
              onValueChange={onToggleRecomputeOnFocus}
              thumbColor={StreamingTheme.colors.textPrimary}
              trackColor={{ false: 'rgba(255,255,255,0.2)', true: 'rgba(255,59,48,0.55)' }}
              disabled={!enabled}
            />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: StreamingTheme.colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 120,
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTextWrap: {
    flex: 1,
  },
  kicker: {
    color: StreamingTheme.colors.accentAlt,
    fontWeight: '700',
    letterSpacing: 1,
    fontSize: 12,
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '900',
    fontSize: 24,
    marginTop: 2,
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(18,24,40,0.9)',
    padding: 12,
    gap: 10,
  },
  cardDisabled: {
    opacity: 0.6,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
    paddingTop: 10,
  },
  toggleTextWrap: {
    flex: 1,
    gap: 4,
  },
  toggleLabel: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '900',
  },
  toggleCaption: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  sectionTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '900',
  },
  caption: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  periodGrid: {
    gap: 8,
  },
  periodChip: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 2,
  },
  periodChipActive: {
    borderColor: 'rgba(255,59,48,0.42)',
    backgroundColor: 'rgba(255,59,48,0.20)',
  },
  periodChipText: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
  },
  periodChipTextActive: {
    color: StreamingTheme.colors.textPrimary,
  },
  periodChipSub: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
  periodChipSubActive: {
    color: StreamingTheme.colors.textSecondary,
  },
  tipRow: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,159,67,0.35)',
    backgroundColor: 'rgba(255,159,67,0.14)',
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tipText: {
    flex: 1,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
  },
  runtimeSummary: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
});
