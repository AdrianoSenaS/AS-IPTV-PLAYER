import { getDbValue, setDbValue } from '@/services/local-db';

export type PlaylistItem = {
  title: string;
  episodeId: string;
  extension: string;
  seasonNumber: number;
  episodeNumber: number;
  durationMs?: number;
};

export async function saveSeriesPlaylist(key: string, items: PlaylistItem[]) {
  await setDbValue(key, items);
}

export async function loadSeriesPlaylist(key: string): Promise<PlaylistItem[]> {
  try {
    const parsed = await getDbValue<PlaylistItem[]>(key);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
