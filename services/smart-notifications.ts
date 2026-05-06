import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { filterBlockedContent, loadAccessSnapshot } from '@/services/access-control';
import {
  getSmartNotificationIntervalSeconds,
  loadAutomationSettings,
} from '@/services/automation-settings';
import { isAiEnabled } from '@/services/ai-settings';
import { loadCatalogData, StreamItem, toText } from '@/services/catalog-data';
import { getBehaviorInsights } from '@/services/behavior-intelligence';
import {
  buildUserTasteProfile,
  getRecommendationReasons,
  getHabitHours,
  rankContentByTaste,
  scoreItemByTaste,
} from '@/services/taste-recommender';

const SMART_NOTIFICATION_TAG = 'smart-rec';
const SMART_PROFILE_TIMEOUT_MS = 1700;
const SMART_SAMPLE_MOVIES = 260;
const SMART_SAMPLE_SERIES = 260;
const SMART_SAMPLE_LIVE = 140;
const SMART_NOTIFICATION_CHANNEL_ID = 'smart-recommendations-ai';

let notificationHandlerInitialized = false;
let smartRefreshPromise: Promise<void> | null = null;

function setNotificationHandlerOnce() {
  if (notificationHandlerInitialized) return;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  notificationHandlerInitialized = true;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ensureNotificationPermission() {
  const permissions = await Notifications.getPermissionsAsync();
  if (permissions.granted || permissions.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
    return true;
  }

  const asked = await Notifications.requestPermissionsAsync();
  return !!asked.granted;
}

function topTitles(items: StreamItem[], fallback: string) {
  const titles = items
    .slice(0, 3)
    .map((item) => toText(item.title || item.name).trim())
    .filter(Boolean);

  if (!titles.length) return fallback;
  return titles.join(' • ');
}

function getItemTitle(item: StreamItem | undefined | null) {
  return toText(item?.title || item?.name).trim();
}

function getItemDescription(item: StreamItem | undefined | null) {
  const plot = toText(item?.plot).trim();
  if (!plot) return '';
  if (plot.length <= 180) return plot;
  return `${plot.slice(0, 177)}...`;
}

function getItemPosterUrl(item: StreamItem | undefined | null) {
  const cover = toText(item?.cover).trim();
  if (cover) return cover;
  return toText(item?.stream_icon).trim();
}

const OPENERS = [
  'Bom horario',
  'Perfeito para agora',
  'Olha isso',
  'Sua lista ideal chegou',
  'Recomendacao fresquinha',
  'Top para este momento',
  'Que tal esse agora',
  'Tem cara de acerto',
  'Vai dar play hoje',
  'Essa combinou com voce',
];

const CONTINUE_LINES = [
  'vamos terminar de assistir?',
  'bora continuar de onde voce parou?',
  'faltou pouco para fechar esse titulo.',
  'seu progresso esta te esperando.',
  'que tal retomar agora?',
];

const MOOD_LINES = [
  'escolhemos com base no seu ritmo recente.',
  'ranqueado por horario, genero e historico.',
  'priorizado pelo seu padrao de uso.',
  'com match alto para o seu perfil.',
  'montado com seus sinais de preferencia.',
];

const CTA_LINES = [
  'Toque para abrir agora.',
  'Entrar e assistir em 1 toque.',
  'Abre o app e da o play.',
  'Sua proxima sessao ja esta pronta.',
  'Vale testar essa selecao.',
];

const AI_WORDS = [
  'hiperpersonalizado',
  'match fino',
  'curadoria viva',
  'sinal quente',
  'ranking dinamico',
  'pulso do seu perfil',
  'recomendacao adaptativa',
  'combinacao inteligente',
  'acerto por contexto',
  'aprendizado em tempo real',
];

const CHANNEL_THEMES = [
  { id: 'smart-recommendations-sunset', name: 'Recomendacoes Sunset', lightColor: '#FF8F3A' },
  { id: 'smart-recommendations-cyan', name: 'Recomendacoes Cyan', lightColor: '#34D3C4' },
  { id: 'smart-recommendations-ocean', name: 'Recomendacoes Ocean', lightColor: '#4E8DFF' },
  { id: 'smart-recommendations-berry', name: 'Recomendacoes Berry', lightColor: '#FF5D8F' },
];

function pickByHash(list: string[], seed: string) {
  if (!list.length) return '';
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return list[hash % list.length];
}

function buildDynamicBody(input: {
  seed: string;
  hour: number;
  topMovie: string;
  topSeries: string;
  topLive: string;
  hasContinue: boolean;
  topReason: string;
  topCategory: string;
  topKeyword: string;
  confidence: number;
}) {
  const bucket = input.hour >= 18 ? 'night' : input.hour >= 12 ? 'afternoon' : 'morning';
  const seed = `${input.seed}-${bucket}`;
  const opener = pickByHash(OPENERS, `${seed}-o`);
  const mood = pickByHash(MOOD_LINES, `${seed}-m`);
  const cta = pickByHash(CTA_LINES, `${seed}-c`);
  const aiWord = pickByHash(AI_WORDS, `${seed}-ai`);

  const show = [input.topMovie, input.topSeries, input.topLive].filter(Boolean).slice(0, 2).join(' • ');
  const contextBits = [
    input.topCategory ? `Categoria forte: ${input.topCategory}.` : '',
    input.topKeyword ? `Palavra em alta: ${input.topKeyword}.` : '',
    input.topReason ? `Motivo IA: ${input.topReason}.` : '',
    `Confianca de match: ${input.confidence}% (${aiWord}).`,
  ]
    .filter(Boolean)
    .join(' ');

  if (input.hasContinue) {
    const cont = pickByHash(CONTINUE_LINES, `${seed}-x`);
    return `${opener}: ${cont} ${mood} ${contextBits} ${show ? `Sugestoes: ${show}.` : ''} ${cta}`;
  }

  return `${opener}: ${mood} ${contextBits} ${show ? `Sugestoes: ${show}.` : ''} ${cta}`;
}

export async function refreshSmartRecommendationNotifications() {
  if (smartRefreshPromise) {
    return smartRefreshPromise;
  }

  smartRefreshPromise = (async () => {
  if (!(await isAiEnabled())) {
    return;
  }

  const automation = await loadAutomationSettings();
  if (!automation.smartNotificationsEnabled) {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const ours = scheduled.filter((item) => item.content.data?.tag === SMART_NOTIFICATION_TAG);
    await Promise.all(ours.map((item) => Notifications.cancelScheduledNotificationAsync(item.identifier)));
    return;
  }

  setNotificationHandlerOnce();

  const hasPermission = await ensureNotificationPermission();
  if (!hasPermission) return;

  const [catalog, access, behavior] = await Promise.all([
    loadCatalogData(),
    loadAccessSnapshot(),
    getBehaviorInsights(),
  ]);

  const sampledCatalog = {
    vod: catalog.vod.slice(0, SMART_SAMPLE_MOVIES),
    series: catalog.series.slice(0, SMART_SAMPLE_SERIES),
    liveStreams: catalog.liveStreams.slice(0, SMART_SAMPLE_LIVE),
  };

  const profile = await withTimeout(
    buildUserTasteProfile({
      settings: access.settings,
      catalog: sampledCatalog,
    }),
    SMART_PROFILE_TIMEOUT_MS,
    null
  );

  if (!profile) {
    return;
  }

  const rankedMovies = rankContentByTaste(
    filterBlockedContent(
      access,
      sampledCatalog.vod,
      (item) => `${toText(item.title || item.name)} ${toText((item as any).category_name)} ${toText((item as any).genre)} ${toText((item as any).plot)}`
    ),
    'movie',
    profile,
    6
  );

  const rankedSeries = rankContentByTaste(
    filterBlockedContent(
      access,
      sampledCatalog.series,
      (item) => `${toText(item.title || item.name)} ${toText((item as any).category_name)} ${toText((item as any).genre)} ${toText((item as any).plot)}`
    ),
    'series',
    profile,
    6
  );

  const rankedLive = rankContentByTaste(
    filterBlockedContent(
      access,
      sampledCatalog.liveStreams,
      (item) => `${toText(item.name || item.title)} ${toText((item as any).category_name)}`
    ),
    'live',
    profile,
    6
  );

  const topMovie = topTitles(rankedMovies, 'Filmes');
  const topSeries = topTitles(rankedSeries, 'Series');
  const topLive = topTitles(rankedLive, 'TV');
  const hasContinueHint = Object.values(behavior.sessionMinutesByHour).some((minutes) => minutes >= 25);

  const topMovieItem = rankedMovies[0];
  const topSeriesItem = rankedSeries[0];
  const topLiveItem = rankedLive[0];
  const featuredMovieOrSeries = topMovieItem || topSeriesItem || null;
  const featuredTitle = getItemTitle(featuredMovieOrSeries) || 'Sugestao personalizada';
  const featuredDescription = getItemDescription(featuredMovieOrSeries);
  const featuredPoster = getItemPosterUrl(featuredMovieOrSeries);

  const allTopItems = [
    { item: topMovieItem, type: 'movie' as const },
    { item: topSeriesItem, type: 'series' as const },
    { item: topLiveItem, type: 'live' as const },
  ].filter((entry) => !!entry.item);

  const bestReason = allTopItems
    .map((entry) => getRecommendationReasons(entry.item!, entry.type, profile)[0] || '')
    .find(Boolean) || '';

  const topKeyword = Object.entries(behavior.searchTokenScores)
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token)
    .find(Boolean) || '';

  const topCategory = Object.entries(behavior.categoryScores)
    .sort((a, b) => b[1] - a[1])
    .map(([category]) => category)
    .find(Boolean) || '';

  const confidence = (() => {
    const scores = allTopItems.map((entry) => scoreItemByTaste(entry.item!, entry.type, profile));
    if (!scores.length) return 74;
    const best = Math.max(...scores);
    return Math.round(Math.max(60, Math.min(99, 62 + best * 2.8)));
  })();

  const hours = getHabitHours(profile);

  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const ours = scheduled.filter((item) => item.content.data?.tag === SMART_NOTIFICATION_TAG);
  await Promise.all(ours.map((item) => Notifications.cancelScheduledNotificationAsync(item.identifier)));

  await Notifications.setNotificationChannelAsync(SMART_NOTIFICATION_CHANNEL_ID, {
    name: 'Recomendacoes IA',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 140, 100, 140],
    lightColor: '#4E8DFF',
  });

  for (const theme of CHANNEL_THEMES) {
    await Notifications.setNotificationChannelAsync(theme.id, {
      name: theme.name,
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 140, 100, 140],
      lightColor: theme.lightColor,
    });
  }

  const intervalSeconds = getSmartNotificationIntervalSeconds(automation.smartNotificationInterval);

  for (let i = 0; i < 1; i += 1) {
    const hour = hours[i];
    const seed = `${profile.generatedAt}-${hour}-${i}`;
    const channel = CHANNEL_THEMES[i % CHANNEL_THEMES.length];
    const message = buildDynamicBody({
      seed,
      hour,
      topMovie,
      topSeries,
      topLive,
      hasContinue: hasContinueHint,
      topReason: bestReason,
      topCategory,
      topKeyword,
      confidence,
    });

    const recommendationBody = featuredDescription
      ? `${featuredTitle}: ${featuredDescription}`
      : `${featuredTitle}. ${message}`;

    const baseContent: Notifications.NotificationContentInput = {
      title: pickByHash(['Sugestoes feitas para voce', 'Seu horario de assistir chegou', 'Recomendacao inteligente'], seed),
      body: recommendationBody,
      data: {
        tag: SMART_NOTIFICATION_TAG,
        smartKey: `smart-${i}`,
        hour,
        confidence,
        topCategory,
        topKeyword,
        featuredTitle,
        featuredDescription,
        featuredPoster,
      },
      ...(Platform.OS === 'android' ? { channelId: SMART_NOTIFICATION_CHANNEL_ID } : {}),
    };

    if (Platform.OS === 'ios' && featuredPoster) {
      (baseContent as any).attachments = [
        {
          identifier: `poster-${i}`,
          url: featuredPoster,
        },
      ];
    }

    try {
      await Notifications.scheduleNotificationAsync({
        content: baseContent,
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: intervalSeconds * (i + 1),
          repeats: true,
        },
      });
    } catch {
      await Notifications.scheduleNotificationAsync({
        content: {
          ...baseContent,
          body: `${recommendationBody}${featuredPoster ? `\nImagem: ${featuredPoster}` : ''}`,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: intervalSeconds * (i + 1),
          repeats: true,
        },
      });
    }
  }
  })().finally(() => {
    smartRefreshPromise = null;
  });

  return smartRefreshPromise;
}
