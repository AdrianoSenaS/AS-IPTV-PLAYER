import { MaterialIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  InteractionManager,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackdrop } from '@/components/app-backdrop';
import { PageLoader } from '@/components/page-loader';
import { RecommendationChip } from '@/components/recommendation-chip';
import { StreamingTheme } from '@/constants/streaming-theme';
import { FeatureGate } from '@/components/feature-gate';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { useScreenBenchmark } from '@/hooks/use-screen-benchmark';
import { queryCatalogCount, queryCatalogPage, sanitizeLabelText, StreamItem, toText } from '@/services/catalog-data';
import { buildLiveUrl } from '@/services/stream-url';
import {
  buildUserTasteProfile,
  getRecommendationReasons,
  rankContentByTaste,
  scoreItemByTaste,
  UserTasteProfile,
} from '@/services/taste-recommender';
import { buildTmdbMetadataForCatalog, TmdbMeta } from '@/services/tmdb';

const { width: SCREEN_W } = Dimensions.get('window');

// ─── Humores ─────────────────────────────────────────────────────────────────
const MOODS = [
  { label: 'Ação', icon: 'local-fire-department', keywords: ['ação', 'action', 'combate', 'guerra', 'luta'] },
  { label: 'Comédia', icon: 'sentiment-very-satisfied', keywords: ['comédia', 'comedy', 'humor', 'divertido'] },
  { label: 'Terror', icon: 'warning', keywords: ['terror', 'horror', 'medo', 'assombro', 'suspense'] },
  { label: 'Romance', icon: 'favorite', keywords: ['romance', 'amor', 'love', 'paixão'] },
  { label: 'Aventura', icon: 'explore', keywords: ['aventura', 'adventure', 'viagem', 'fantasia'] },
  { label: 'Drama', icon: 'theater-comedy', keywords: ['drama', 'emocional', 'família', 'family'] },
  { label: 'Animação', icon: 'child-care', keywords: ['animação', 'animation', 'anime', 'infantil'] },
  { label: 'Ficção', icon: 'rocket-launch', keywords: ['ficção', 'sci-fi', 'ficientifica', 'espaço', 'space'] },
] as const;

type MoodLabel = typeof MOODS[number]['label'];

const EXPLORE_VOD_LIMIT = 420;
const EXPLORE_SERIES_LIMIT = 420;
const EXPLORE_LIVE_LIMIT = 220;
const EXPLORE_MOOD_PER_QUERY = 16;
const EXPLORE_HIDDEN_GEMS_LIMIT = 6;

// ─── helpers ─────────────────────────────────────────────────────────────────
function seededRandom(seed: number) {
  const x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}

function todaySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function shuffled<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ─── component ───────────────────────────────────────────────────────────────
export default function ExploreScreen() {
  const router = useRouter();
  useScreenBenchmark('explore');

  const [isLoading, setIsLoading] = useState(true);
    const { hasFeature, loading: planLoading } = usePlanGate();
  const [movies, setMovies] = useState<StreamItem[]>([]);
  const [series, setSeries] = useState<StreamItem[]>([]);
  const [live, setLive] = useState<StreamItem[]>([]);
  const [movieMeta, setMovieMeta] = useState<Record<string, TmdbMeta>>({});
  const [seriesMeta, setSeriesMeta] = useState<Record<string, TmdbMeta>>({});
  const [activeMood, setActiveMood] = useState<MoodLabel | null>(null);
  const [shuffleKey, setShuffleKey] = useState(0);
  const [isFiltering, setIsFiltering] = useState(false);
  const [tasteProfile, setTasteProfile] = useState<UserTasteProfile | null>(null);
  const [moodResults, setMoodResults] = useState<Array<{ item: StreamItem; type: 'movie' | 'series' }>>([]);
  const [doDiaItem, setDoDiaItem] = useState<{ item: StreamItem; type: 'movie' | 'series' } | null>(null);
  const [hiddenGems, setHiddenGems] = useState<StreamItem[]>([]);
  const filteringRef = useRef(false);
  const bootstrapVersionRef = useRef(0);

  const spinAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const bootstrap = async () => {
      const version = ++bootstrapVersionRef.current;
      const [vodTotal, seriesTotal, liveTotal] = await Promise.all([
        queryCatalogCount({ kind: 'vod' }),
        queryCatalogCount({ kind: 'series' }),
        queryCatalogCount({ kind: 'live' }),
      ]);

      const randomOffset = (total: number, batch: number, salt: number) => {
        if (total <= batch) return 0;
        const maxOffset = total - batch;
        return Math.floor(seededRandom(Date.now() + salt + shuffleKey * 1009) * (maxOffset + 1));
      };

      const [vod, seriesData, liveStreams] = await Promise.all([
        queryCatalogPage({
          kind: 'vod',
          offset: randomOffset(vodTotal, EXPLORE_VOD_LIMIT, 17),
          limit: EXPLORE_VOD_LIMIT,
        }),
        queryCatalogPage({
          kind: 'series',
          offset: randomOffset(seriesTotal, EXPLORE_SERIES_LIMIT, 29),
          limit: EXPLORE_SERIES_LIMIT,
        }),
        queryCatalogPage({
          kind: 'live',
          offset: randomOffset(liveTotal, EXPLORE_LIVE_LIMIT, 43),
          limit: EXPLORE_LIVE_LIMIT,
        }),
      ]);

      if (version !== bootstrapVersionRef.current) return;

      setMovies(vod);
      setSeries(seriesData);
      setLive(liveStreams);
      setIsLoading(false);

      InteractionManager.runAfterInteractions(() => {
        void (async () => {
          const [profile, movieMap, seriesMap] = await Promise.all([
            buildUserTasteProfile({
              catalog: { vod, series: seriesData, liveStreams },
            }),
            buildTmdbMetadataForCatalog(
              vod,
              'movie',
              (item) => toText(item.stream_id),
              (item) => sanitizeLabelText(item.title || item.name, '')
            ),
            buildTmdbMetadataForCatalog(
              seriesData,
              'tv',
              (item) => toText(item.series_id),
              (item) => sanitizeLabelText(item.title || item.name, '')
            ),
          ]);

          if (version !== bootstrapVersionRef.current) return;

          setTasteProfile(profile);
          setMovieMeta(movieMap);
          setSeriesMeta(seriesMap);
        })().catch(() => {
          // Explore deve abrir rapido mesmo se enriquecimento falhar.
        });
      });
    };

    void bootstrap();
  }, [shuffleKey]);

  useEffect(() => {
    let canceled = false;

    void (async () => {
      const seed = todaySeed();
      const [movieTotal, seriesTotal] = await Promise.all([
        queryCatalogCount({ kind: 'vod' }),
        queryCatalogCount({ kind: 'series' }),
      ]);

      const preferMovie = seededRandom(seed + 11) >= 0.5;
      const type: 'movie' | 'series' =
        movieTotal <= 0 ? 'series' : seriesTotal <= 0 ? 'movie' : preferMovie ? 'movie' : 'series';

      const total = type === 'movie' ? movieTotal : seriesTotal;
      if (!total) {
        if (!canceled) setDoDiaItem(null);
        return;
      }

      const offset = Math.floor(seededRandom(seed + (type === 'movie' ? 101 : 203)) * total);
      const [item] = await queryCatalogPage({
        kind: type === 'movie' ? 'vod' : 'series',
        offset,
        limit: 1,
      });

      if (!canceled) {
        setDoDiaItem(item ? { item, type } : null);
      }
    })().catch(() => {
      if (!canceled) {
        setDoDiaItem(null);
      }
    });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    let canceled = false;

    void (async () => {
      const total = await queryCatalogCount({ kind: 'vod' });
      if (!total) {
        if (!canceled) setHiddenGems([]);
        return;
      }

      const chunk = 60;
      const maxOffset = Math.max(0, total - chunk);
      const offsets = [
        Math.floor(seededRandom(shuffleKey + 31) * (maxOffset + 1)),
        Math.floor(seededRandom(shuffleKey + 67) * (maxOffset + 1)),
      ];

      const chunks = await Promise.all(
        offsets.map((offset) => queryCatalogPage({ kind: 'vod', offset, limit: chunk }))
      );

      const dedup = new Map<string, StreamItem>();
      for (const item of chunks.flat()) {
        const id = toText(item.stream_id);
        if (!id) continue;
        dedup.set(id, item);
      }

      const withScore = Array.from(dedup.values()).map((item) => {
        const baseRating = Number(item.rating || 0);
        const fallbackRating = Number(item.rating_5based || 0) * 2;
        return { item, rating: baseRating > 0 ? baseRating : fallbackRating };
      });

      const gems = withScore
        .filter((entry) => entry.rating >= 7)
        .sort((a, b) => b.rating - a.rating)
        .map((entry) => entry.item);

      const ranked = tasteProfile
        ? rankContentByTaste(gems, 'movie', tasteProfile, EXPLORE_HIDDEN_GEMS_LIMIT)
        : gems.slice(0, EXPLORE_HIDDEN_GEMS_LIMIT);

      if (!canceled) {
        setHiddenGems(ranked);
      }
    })().catch(() => {
      if (!canceled) {
        setHiddenGems([]);
      }
    });

    return () => {
      canceled = true;
    };
  }, [shuffleKey, tasteProfile]);

  // Grade aleatória misturada
  const randomGrid = useMemo(() => {
    const mix = [
      ...movies.map((m) => ({ item: m, type: 'movie' as const })),
      ...series.map((s) => ({ item: s, type: 'series' as const })),
    ];
    const pool = shuffled(mix);
    if (!tasteProfile) return pool.slice(0, 20);
    return [...pool]
      .sort(
        (a, b) =>
          scoreItemByTaste(b.item, b.type, tasteProfile) -
          scoreItemByTaste(a.item, a.type, tasteProfile)
      )
      .slice(0, 20);
  }, [movies, series, shuffleKey, tasteProfile]);

  // Canais ao vivo aleatórios
  const randomLive = useMemo(() => {
    const pool = shuffled(live);
    if (!tasteProfile) return pool.slice(0, 8);
    return rankContentByTaste(pool, 'live', tasteProfile, 8);
  }, [live, shuffleKey, tasteProfile]);

  useEffect(() => {
    let canceled = false;

    if (!activeMood) {
      setMoodResults([]);
      return () => {
        canceled = true;
      };
    }

    const mood = MOODS.find((entry) => entry.label === activeMood);
    if (!mood) {
      setMoodResults([]);
      return () => {
        canceled = true;
      };
    }

    void (async () => {
      const movieById = new Map<string, StreamItem>();
      const seriesById = new Map<string, StreamItem>();

      for (const keyword of mood.keywords) {
        const [movieChunk, seriesChunk] = await Promise.all([
          queryCatalogPage({
            kind: 'vod',
            search: keyword,
            offset: 0,
            limit: EXPLORE_MOOD_PER_QUERY,
          }),
          queryCatalogPage({
            kind: 'series',
            search: keyword,
            offset: 0,
            limit: EXPLORE_MOOD_PER_QUERY,
          }),
        ]);

        for (const item of movieChunk) {
          movieById.set(toText(item.stream_id), item);
        }

        for (const item of seriesChunk) {
          seriesById.set(toText(item.series_id), item);
        }
      }

      if (canceled) return;

      const pool = shuffled([
        ...Array.from(movieById.values()).map((item) => ({ item, type: 'movie' as const })),
        ...Array.from(seriesById.values()).map((item) => ({ item, type: 'series' as const })),
      ]);

      const ranked = !tasteProfile
        ? pool.slice(0, 20)
        : [...pool]
            .sort(
              (a, b) =>
                scoreItemByTaste(b.item, b.type, tasteProfile) -
                scoreItemByTaste(a.item, a.type, tasteProfile)
            )
            .slice(0, 20);

      setMoodResults(ranked);
    })().catch(() => {
      if (!canceled) {
        setMoodResults([]);
      }
    });

    return () => {
      canceled = true;
    };
  }, [activeMood, tasteProfile, shuffleKey]);

  // ─── navegação ──────────────────────────────────────────────────────────
  const openMovie = useCallback(
    (item: StreamItem) => {
      const id = toText(item.stream_id);
      if (id) router.navigate(`/filme-detalhe?streamId=${encodeURIComponent(id)}` as any);
    },
    [router]
  );

  const openSeries = useCallback(
    (item: StreamItem) => {
      const id = toText(item.series_id);
      if (!id) return;
      router.navigate({
        pathname: '/serie-detalhe',
        params: {
          seriesId: id,
          title: sanitizeLabelText(item.title || item.name, 'Serie'),
          cover: toText(item.stream_icon || item.cover),
        },
      });
    },
    [router]
  );

  const openLive = useCallback(
    async (item: StreamItem) => {
      const url = await buildLiveUrl(item);
      if (!url) return;
      router.navigate({
        pathname: '/player',
        params: {
          mode: 'live',
          contentId: toText(item.stream_id || item.name || item.title),
          title: sanitizeLabelText(item.name || item.title, 'Canal'),
          url,
        },
      });
    },
    [router]
  );

  const openMixed = useCallback(
    (entry: { item: StreamItem; type: 'movie' | 'series' | 'live' }) => {
      if (entry.type === 'movie') openMovie(entry.item);
      else if (entry.type === 'series') openSeries(entry.item);
      else openLive(entry.item);
    },
    [openMovie, openSeries, openLive]
  );

  const handleSurprise = useCallback(async () => {
    Animated.sequence([
      Animated.timing(spinAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
      Animated.timing(spinAnim, { toValue: 0, duration: 0, useNativeDriver: true }),
    ]).start();

    const all = [
      ...movies.map((m) => ({ item: m, type: 'movie' as const })),
      ...series.map((s) => ({ item: s, type: 'series' as const })),
      ...live.map((l) => ({ item: l, type: 'live' as const })),
    ];
    const pick = pickRandom(all);
    if (pick) openMixed(pick);
  }, [movies, series, live, openMixed, spinAnim]);

  const handleShuffle = useCallback(() => {
    if (filteringRef.current) return;
    filteringRef.current = true;
    setIsFiltering(true);
    setTimeout(() => {
      setShuffleKey((k) => k + 1);
      setIsFiltering(false);
      filteringRef.current = false;
    }, 80);
  }, []);

  const handleMoodSelect = useCallback((label: MoodLabel) => {
    if (filteringRef.current) return;
    filteringRef.current = true;
    setIsFiltering(true);
    const next = activeMood === label ? null : label;
    setTimeout(() => {
      setActiveMood(next);
      setIsFiltering(false);
      filteringRef.current = false;
    }, 80);
  }, [activeMood]);

  const spinDeg = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  const getReason = (item: StreamItem, type: 'movie' | 'series' | 'live') => {
    if (!tasteProfile) return '';
    return getRecommendationReasons(item, type, tasteProfile)[0] || '';
  };

  // ─── render helpers ──────────────────────────────────────────────────────
  const renderDoDiaCard = () => {
    if (!doDiaItem) return null;
    const { item, type } = doDiaItem;
    const meta =
      type === 'movie'
        ? movieMeta[toText(item.stream_id)]
        : seriesMeta[toText(item.series_id)];
    const title = sanitizeLabelText(item.title || item.name, type === 'movie' ? 'Filme' : 'Serie');
    const image = meta?.backdropUrl || meta?.posterUrl || toText(item.stream_icon || item.cover);

    return (
      <TouchableOpacity style={styles.doDiaCard} activeOpacity={0.85} onPress={() => openMixed({ item, type })}>
        <Image source={{ uri: image }} style={StyleSheet.absoluteFillObject as any} cachePolicy="disk" />
        <LinearGradient colors={['transparent', 'rgba(7,9,15,0.93)']} style={StyleSheet.absoluteFill} />
        <View style={styles.doDiaContent}>
          <View style={styles.doDiaBadge}>
            <MaterialIcons name="today" size={11} color="#fff" />
            <Text style={styles.doDiaBadgeText}>SURPRESA DO DIA</Text>
          </View>
          <Text style={styles.doDiaTitle} numberOfLines={2}>{title}</Text>
          {meta?.rating ? (
            <Text style={styles.doDiaMeta}>
              ★ {meta.rating}{meta.releaseYear ? `  •  ${meta.releaseYear}` : ''}
            </Text>
          ) : null}
          {!!tasteProfile && (
            <RecommendationChip
              reason={getReason(item, type)}
              overlay
              numberOfLines={2}
              style={styles.reasonChipDoDia}
            />
          )}
          <View style={styles.doDiaBtn}>
            <MaterialIcons name="play-arrow" size={16} color="#fff" />
            <Text style={styles.doDiaBtnText}>Ver agora</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderBigCard = (
    entry: { item: StreamItem; type: 'movie' | 'series' | 'live' },
    idx: number
  ) => {
    const { item, type } = entry;
    const meta =
      type === 'movie'
        ? movieMeta[toText(item.stream_id)]
        : type === 'series'
        ? seriesMeta[toText(item.series_id)]
        : null;
    const title = sanitizeLabelText(
      item.title || item.name,
      type === 'movie' ? 'Filme' : type === 'series' ? 'Serie' : 'Canal'
    );
    const image = meta?.posterUrl || toText(item.stream_icon || item.cover);
    const typeLabel = type === 'movie' ? 'FILME' : type === 'series' ? 'SÉRIE' : 'AO VIVO';
    const typeColor =
      type === 'movie'
        ? StreamingTheme.colors.accent
        : type === 'series'
        ? StreamingTheme.colors.info
        : StreamingTheme.colors.success;

    return (
      <TouchableOpacity key={`bc-${idx}`} style={styles.bigCard} onPress={() => openMixed(entry)}>
        <Image source={{ uri: image }} style={StyleSheet.absoluteFillObject as any} cachePolicy="disk" />
        <View style={[styles.typeDot, { backgroundColor: typeColor }]} />
        <LinearGradient colors={['transparent', 'rgba(7,9,15,0.88)']} style={styles.bigCardGrad} />
        <Text style={styles.bigCardTitle} numberOfLines={2}>{title}</Text>
        {!!tasteProfile && (
          <RecommendationChip
            reason={getReason(item, type)}
            overlay
            numberOfLines={1}
            style={styles.reasonChipBigCard}
          />
        )}
        <Text style={[styles.bigCardTypeLabel, { color: typeColor }]}>{typeLabel}</Text>
        {meta?.rating ? <Text style={styles.bigCardRating}>★ {meta.rating}</Text> : null}
      </TouchableOpacity>
    );
  };

  const renderGemCard = (item: StreamItem, idx: number) => {
    const meta = movieMeta[toText(item.stream_id)];
    const title = sanitizeLabelText(item.title || item.name, 'Filme');
    const image = meta?.posterUrl || toText(item.stream_icon || item.cover);
    return (
      <TouchableOpacity key={`gem-${idx}`} style={styles.gemCard} onPress={() => openMovie(item)}>
        <Image source={{ uri: image }} style={StyleSheet.absoluteFillObject as any} cachePolicy="disk" />
        <LinearGradient colors={['transparent', 'rgba(7,9,15,0.9)']} style={StyleSheet.absoluteFill} />
        <View style={styles.gemContent}>
          <View style={styles.gemRatingBadge}>
            <MaterialIcons name="star" size={10} color={StreamingTheme.colors.warning} />
            <Text style={styles.gemRatingText}>{meta?.rating}</Text>
          </View>
          <Text style={styles.gemTitle} numberOfLines={2}>{title}</Text>
          {!!tasteProfile && (
            <RecommendationChip
              reason={getReason(item, 'movie')}
              overlay
              numberOfLines={2}
              style={styles.reasonChipGem}
            />
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const renderLiveCard = (item: StreamItem, idx: number) => {
    const title = sanitizeLabelText(item.name || item.title, 'Canal');
    const image = toText(item.stream_icon || item.cover);
    return (
      <TouchableOpacity key={`lv-${idx}`} style={styles.liveCard} onPress={() => openLive(item)}>
        <Image source={{ uri: image }} style={styles.liveCardImage} cachePolicy="disk" contentFit="contain" />
        <View style={styles.livePulse}>
          <View style={styles.liveDot} />
          <Text style={styles.liveNowText}>AO VIVO</Text>
        </View>
        <Text style={styles.liveCardTitle} numberOfLines={2}>{title}</Text>
        {!!tasteProfile && (
          <RecommendationChip reason={getReason(item, 'live')} numberOfLines={2} style={styles.reasonChipLive} />
        )}
      </TouchableOpacity>
    );
  };

  const renderMoodPosterCard = (
    entry: { item: StreamItem; type: 'movie' | 'series' },
    idx: number
  ) => {
    const { item, type } = entry;
    const meta = type === 'movie' ? movieMeta[toText(item.stream_id)] : seriesMeta[toText(item.series_id)];
    const title = sanitizeLabelText(item.title || item.name, type === 'movie' ? 'Filme' : 'Serie');
    const image = meta?.posterUrl || toText(item.stream_icon || item.cover);
    return (
      <TouchableOpacity key={`mp-${idx}`} style={styles.moodPoster} onPress={() => openMixed(entry)}>
        <Image source={{ uri: image }} style={styles.moodPosterImage} cachePolicy="disk" />
        <Text style={styles.moodPosterTitle} numberOfLines={2}>{title}</Text>
        {meta?.rating ? <Text style={styles.moodPosterRating}>★ {meta.rating}</Text> : null}
        {!!tasteProfile && (
          <RecommendationChip reason={getReason(item, type)} numberOfLines={2} style={styles.reasonChipMoodPoster} />
        )}
      </TouchableOpacity>
    );
  };

  return (
    <FeatureGate feature="explore" locked={!planLoading && !hasFeature('explore')}>
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={30} />
      <PageLoader visible={isLoading} label="Carregando..." />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.kicker}>DESCOBRIR</Text>
            <Text style={styles.heroTitle}>Que tal algo{'\n'}diferente hoje?</Text>
          </View>
          <TouchableOpacity style={styles.roundBtn} onPress={handleShuffle} disabled={isFiltering}>
            {isFiltering
              ? <ActivityIndicator size="small" color={StreamingTheme.colors.accentAlt} />
              : <MaterialIcons name="shuffle" size={22} color={StreamingTheme.colors.accentAlt} />}
          </TouchableOpacity>
        </View>

        {/* Surpreenda-me */}
        <TouchableOpacity style={styles.surpriseWrapper} onPress={handleSurprise} activeOpacity={0.8}>
          <LinearGradient
            colors={[StreamingTheme.colors.accent, StreamingTheme.colors.accentAlt]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.surpriseGrad}
          >
            <Animated.View style={{ transform: [{ rotate: spinDeg }] }}>
              <MaterialIcons name="casino" size={24} color="#fff" />
            </Animated.View>
            <Text style={styles.surpriseText}>Surpreenda-me agora</Text>
            <MaterialIcons name="arrow-forward" size={18} color="rgba(255,255,255,0.7)" />
          </LinearGradient>
        </TouchableOpacity>

        {/* Surpresa do dia */}
        {doDiaItem && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Surpresa do dia</Text>
            <Text style={styles.sectionSub}>Uma escolha diferente a cada dia</Text>
            {renderDoDiaCard()}
          </View>
        )}

        {/* Escolha seu humor */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Qual seu humor agora?</Text>
          <Text style={styles.sectionSub}>Toque um estilo e veja o que temos</Text>
          <View style={styles.moodGrid}>
            {MOODS.map((mood) => {
              const active = activeMood === mood.label;
              const pending = isFiltering && !active;
              return (
                <TouchableOpacity
                  key={mood.label}
                  style={[styles.moodChip, active && styles.moodChipActive, isFiltering && styles.moodChipDisabled]}
                  onPress={() => handleMoodSelect(mood.label)}
                  disabled={isFiltering}
                >
                  {isFiltering && active
                    ? <ActivityIndicator size="small" color="#fff" style={{ width: 15, height: 15 }} />
                    : <MaterialIcons
                        name={mood.icon as any}
                        size={15}
                        color={active ? '#fff' : pending ? StreamingTheme.colors.textMuted : StreamingTheme.colors.textSecondary}
                      />}
                  <Text style={[
                    styles.moodChipText,
                    active && styles.moodChipTextActive,
                    pending && styles.moodChipTextDisabled,
                  ]}>
                    {mood.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Resultados do humor */}
        {(activeMood || isFiltering) && (
          <View style={styles.section}>
            <View style={styles.sectionRowSpaced}>
              <Text style={styles.sectionTitle}>{activeMood ?? '...'}</Text>
              {!isFiltering && <Text style={styles.countText}>{moodResults.length} encontrados</Text>}
            </View>
            {isFiltering
              ? <View style={styles.filteringBox}>
                  <ActivityIndicator size="large" color={StreamingTheme.colors.accentAlt} />
                  <Text style={styles.filteringText}>Filtrando...</Text>
                </View>
              : moodResults.length > 0
                ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hRow}>
                    {(moodResults as any[]).map((entry: any, idx: number) =>
                      renderMoodPosterCard(entry, idx)
                    )}
                  </ScrollView>
                : <Text style={styles.emptyText}>Nenhum conteúdo encontrado para este humor.</Text>}
          </View>
        )}

        {/* Joias escondidas */}
        {hiddenGems.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionRowSpaced}>
              <View>
                <Text style={styles.sectionTitle}>Joias escondidas</Text>
                <Text style={styles.sectionSub}>Bem avaliados, pouco conhecidos</Text>
              </View>
              <TouchableOpacity onPress={handleShuffle} style={styles.roundBtn} disabled={isFiltering}>
                {isFiltering
                  ? <ActivityIndicator size="small" color={StreamingTheme.colors.accentAlt} />
                  : <MaterialIcons name="refresh" size={18} color={StreamingTheme.colors.accentAlt} />}
              </TouchableOpacity>
            </View>
            {isFiltering
              ? <View style={styles.filteringBox}>
                  <ActivityIndicator size="large" color={StreamingTheme.colors.accentAlt} />
                </View>
              : <View style={styles.gemsGrid}>
                  {hiddenGems.map((item, idx) => renderGemCard(item, idx))}
                </View>}
          </View>
        )}

        {/* Ao vivo agora */}
        {randomLive.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionRowSpaced}>
              <View>
                <Text style={styles.sectionTitle}>Ao vivo agora</Text>
                <Text style={styles.sectionSub}>Canais em exibição, seleção aleatória</Text>
              </View>
              <TouchableOpacity onPress={() => router.navigate('/ao-vivo')} style={styles.roundBtn}>
                <MaterialIcons name="live-tv" size={18} color={StreamingTheme.colors.success} />
              </TouchableOpacity>
            </View>
            {isFiltering
              ? <View style={styles.filteringBox}>
                  <ActivityIndicator size="large" color={StreamingTheme.colors.success} />
                </View>
              : <View style={styles.liveGrid}>
                  {randomLive.map((item, idx) => renderLiveCard(item, idx))}
                </View>}
          </View>
        )}

        {/* Roleta do catálogo */}
        <View style={styles.section}>
          <View style={styles.sectionRowSpaced}>
            <View>
              <Text style={styles.sectionTitle}>Roleta do catálogo</Text>
              <Text style={styles.sectionSub}>Embaralhado novo a cada toque</Text>
            </View>
            <TouchableOpacity onPress={handleShuffle} style={styles.roundBtn} disabled={isFiltering}>
              {isFiltering
                ? <ActivityIndicator size="small" color={StreamingTheme.colors.accentAlt} />
                : <MaterialIcons name="shuffle" size={18} color={StreamingTheme.colors.accentAlt} />}
            </TouchableOpacity>
          </View>
          {isFiltering
            ? <View style={styles.filteringBox}>
                <ActivityIndicator size="large" color={StreamingTheme.colors.accentAlt} />
                <Text style={styles.filteringText}>Embaralhando...</Text>
              </View>
            : <View style={styles.bigCardGrid}>
                {randomGrid.map((entry, idx) => renderBigCard(entry, idx))}
              </View>}
        </View>

      </ScrollView>
    </SafeAreaView>
    </FeatureGate>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const CARD_W = (SCREEN_W - 48) / 2;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },
  content: { paddingBottom: 120 },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 14,
  },
  kicker: {
    color: StreamingTheme.colors.accentAlt,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 2,
    marginBottom: 4,
  },
  heroTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 28,
    fontWeight: '900',
    lineHeight: 34,
  },
  roundBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: StreamingTheme.colors.surface,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },

  surpriseWrapper: { marginHorizontal: 20, marginBottom: 26, borderRadius: 18, overflow: 'hidden' },
  surpriseGrad: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 22,
    gap: 12,
  },
  surpriseText: { flex: 1, color: '#fff', fontSize: 17, fontWeight: '800' },

  section: { marginBottom: 26, paddingHorizontal: 20 },
  sectionTitle: { color: StreamingTheme.colors.textPrimary, fontSize: 18, fontWeight: '800' },
  sectionSub: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
    marginTop: 2,
    marginBottom: 12,
  },
  sectionRowSpaced: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  countText: { color: StreamingTheme.colors.textMuted, fontSize: 12 },
  hRow: { gap: 10 },

  // do dia
  doDiaCard: {
    height: 240,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: StreamingTheme.colors.surface,
  },
  doDiaContent: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 18 },
  doDiaBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,143,58,0.88)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 8,
  },
  doDiaBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  doDiaTitle: { color: '#fff', fontSize: 22, fontWeight: '900', lineHeight: 27, marginBottom: 4 },
  doDiaMeta: { color: 'rgba(255,255,255,0.7)', fontSize: 13, marginBottom: 10 },
  reasonChipDoDia: {
    marginBottom: 8,
  },
  doDiaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,59,48,0.88)',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  doDiaBtnText: { color: '#fff', fontSize: 13, fontWeight: '800' },

  // mood
  moodGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  moodChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: StreamingTheme.colors.surface,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
  },
  moodChipActive: {
    backgroundColor: StreamingTheme.colors.accent,
    borderColor: StreamingTheme.colors.accent,
  },
  moodChipDisabled: { opacity: 0.45 },
  moodChipText: { color: StreamingTheme.colors.textSecondary, fontSize: 13, fontWeight: '700' },
  moodChipTextActive: { color: '#fff' },
  moodChipTextDisabled: { color: StreamingTheme.colors.textMuted },

  filteringBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 10,
  },
  filteringText: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  emptyText: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 13,
    paddingVertical: 16,
  },

  moodPoster: { width: 120 },
  moodPosterImage: {
    width: 120,
    height: 170,
    borderRadius: 14,
    backgroundColor: StreamingTheme.colors.surface,
  },
  moodPosterTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 6,
  },
  moodPosterRating: { color: StreamingTheme.colors.textMuted, fontSize: 11, marginTop: 2 },
  reasonChipMoodPoster: {
    marginTop: 3,
  },

  // gems
  gemsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  gemCard: {
    width: CARD_W,
    height: 145,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: StreamingTheme.colors.surface,
  },
  gemContent: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 10 },
  gemRatingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
    marginBottom: 5,
  },
  gemRatingText: { color: StreamingTheme.colors.warning, fontSize: 11, fontWeight: '800' },
  gemTitle: { color: '#fff', fontSize: 13, fontWeight: '800', lineHeight: 17 },
  reasonChipGem: {
    marginTop: 4,
  },

  // live
  liveGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  liveCard: {
    width: CARD_W,
    borderRadius: 16,
    backgroundColor: StreamingTheme.colors.surface,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    padding: 10,
  },
  liveCardImage: {
    width: '100%',
    height: 70,
    borderRadius: 10,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    marginBottom: 8,
  },
  livePulse: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: StreamingTheme.colors.success },
  liveNowText: {
    color: StreamingTheme.colors.success,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
  },
  liveCardTitle: { color: StreamingTheme.colors.textPrimary, fontSize: 12, fontWeight: '700' },
  reasonChipLive: {
    marginTop: 4,
  },

  // big card grid (roleta)
  bigCardGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  bigCard: {
    width: CARD_W,
    height: 200,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: StreamingTheme.colors.surface,
  },
  typeDot: { position: 'absolute', top: 10, right: 10, width: 9, height: 9, borderRadius: 5 },
  bigCardGrad: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 100 },
  bigCardTitle: {
    position: 'absolute',
    bottom: 26,
    left: 10,
    right: 10,
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
    lineHeight: 17,
  },
  bigCardTypeLabel: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
  },
  reasonChipBigCard: {
    position: 'absolute',
    bottom: 44,
    left: 10,
    right: 10,
  },
  bigCardRating: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
});
