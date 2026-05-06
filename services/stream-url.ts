import { getDbValue } from '@/services/local-db';

import { StreamItem, toText } from '@/services/catalog-data';

type Credentials = {
  url: string;
  username: string;
  password: string;
};

const normalizeBaseUrl = (value: string) => String(value || '').trim().replace(/\/+$/, '');
const encodePathPart = (value: string) => encodeURIComponent(String(value || '').trim());

async function loadCredentials(): Promise<Credentials | null> {
  const [url, username, password] = await Promise.all([
    getDbValue<string>('url'),
    getDbValue<string>('username'),
    getDbValue<string>('password'),
  ]);

  if (!url || !username || !password) {
    return null;
  }

  return {
    url: normalizeBaseUrl(url),
    username,
    password,
  };
}

export async function buildMovieUrl(item: StreamItem): Promise<string | null> {
  const direct = toText((item as any).direct_source);
  if (direct.startsWith('http://') || direct.startsWith('https://')) {
    return direct;
  }

  const creds = await loadCredentials();
  const streamId = toText(item.stream_id);
  if (!creds || !streamId) {
    return null;
  }

  const preferredExt = toText((item as any).container_extension, '').toLowerCase();
  const extCandidates = [preferredExt, 'mp4', 'mkv', 'ts', 'm3u8'].filter(Boolean);
  const ext = extCandidates[0] || 'mp4';

  return `${creds.url}/movie/${encodePathPart(creds.username)}/${encodePathPart(creds.password)}/${encodePathPart(streamId)}.${ext}`;
}

export async function buildLiveUrl(item: StreamItem): Promise<string | null> {
  const direct = toText((item as any).direct_source);
  if (direct.startsWith('http://') || direct.startsWith('https://')) {
    return direct;
  }

  const creds = await loadCredentials();
  const streamId = toText(item.stream_id);
  if (!creds || !streamId) {
    return null;
  }

  // Muitos paineis Xtream expõem live em .m3u8; caimos para .ts por fallback no player.
  const ext = toText((item as any).container_extension, 'm3u8');
  return `${creds.url}/live/${encodePathPart(creds.username)}/${encodePathPart(creds.password)}/${encodePathPart(streamId)}.${ext}`;
}

export async function buildSeriesEpisodeUrl(episodeId: string, ext = 'mp4'): Promise<string | null> {
  if (episodeId.startsWith('http://') || episodeId.startsWith('https://')) {
    return episodeId;
  }

  const creds = await loadCredentials();
  if (!creds || !episodeId) {
    return null;
  }

  return `${creds.url}/series/${encodePathPart(creds.username)}/${encodePathPart(creds.password)}/${encodePathPart(episodeId)}.${ext}`;
}
