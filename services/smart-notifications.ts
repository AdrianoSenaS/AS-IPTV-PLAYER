import * as Notifications from 'expo-notifications';

import { filterBlockedContent, loadAccessSnapshot } from '@/services/access-control';
import { loadCatalogData, StreamItem, toText } from '@/services/catalog-data';
import {
  buildUserTasteProfile,
  getHabitHours,
  rankContentByTaste,
} from '@/services/taste-recommender';

const SMART_NOTIFICATION_TAG = 'smart-rec';

let notificationHandlerInitialized = false;

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

export async function refreshSmartRecommendationNotifications() {
  setNotificationHandlerOnce();

  const hasPermission = await ensureNotificationPermission();
  if (!hasPermission) return;

  const [catalog, access] = await Promise.all([loadCatalogData(), loadAccessSnapshot()]);

  const profile = await buildUserTasteProfile({
    settings: access.settings,
    catalog: {
      vod: catalog.vod,
      series: catalog.series,
      liveStreams: catalog.liveStreams,
    },
  });

  const rankedMovies = rankContentByTaste(
    filterBlockedContent(
      access,
      catalog.vod,
      (item) => `${toText(item.title || item.name)} ${toText((item as any).category_name)} ${toText((item as any).genre)} ${toText((item as any).plot)}`
    ),
    'movie',
    profile,
    6
  );

  const rankedSeries = rankContentByTaste(
    filterBlockedContent(
      access,
      catalog.series,
      (item) => `${toText(item.title || item.name)} ${toText((item as any).category_name)} ${toText((item as any).genre)} ${toText((item as any).plot)}`
    ),
    'series',
    profile,
    6
  );

  const rankedLive = rankContentByTaste(
    filterBlockedContent(
      access,
      catalog.liveStreams,
      (item) => `${toText(item.name || item.title)} ${toText((item as any).category_name)}`
    ),
    'live',
    profile,
    6
  );

  const message = `Sugestoes para voce: ${topTitles(rankedMovies, 'Filmes')}. Series: ${topTitles(rankedSeries, 'Series')}. Ao vivo: ${topTitles(rankedLive, 'TV')}.`;

  const hours = getHabitHours(profile);

  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const ours = scheduled.filter((item) => item.content.data?.tag === SMART_NOTIFICATION_TAG);
  await Promise.all(ours.map((item) => Notifications.cancelScheduledNotificationAsync(item.identifier)));

  await Notifications.setNotificationChannelAsync('smart-recommendations', {
    name: 'Recomendacoes Inteligentes',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 150, 120, 150],
    lightColor: '#FF3B30',
  });

  for (let i = 0; i < hours.length; i += 1) {
    const hour = hours[i];
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Sugestoes feitas para voce',
        body: message,
        data: { tag: SMART_NOTIFICATION_TAG, hour },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour,
        minute: i % 2 === 0 ? 5 : 35,
      },
    });
  }
}
