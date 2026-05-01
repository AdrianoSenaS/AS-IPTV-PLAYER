import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { buildMovieUrl, buildSeriesEpisodeUrl } from '@/services/stream-url';
import { StreamItem } from '@/services/catalog-data';

export type DownloadedItemType = 'movie' | 'series-episode';
export type DownloadStatus = 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type DownloadedItem = {
  id: string;
  type: DownloadedItemType;
  contentId: string;
  title: string;
  subtitle?: string;
  image?: string;
  localUri: string;
  originalUrl: string;
  downloadedAt: string;
  sizeBytes?: number;
  seriesId?: string;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
};

export type DownloadJob = {
  id: string;
  type: DownloadedItemType;
  contentId: string;
  title: string;
  subtitle?: string;
  image?: string;
  status: DownloadStatus;
  progressPercent: number;
  transferredBytes: number;
  totalBytes: number;
  errorMessage?: string;
  localUri: string;
  originalUrl: string;
  seriesId?: string;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
};

type DownloadMovieInput = {
  contentId: string;
  title: string;
  image?: string;
  sourceUrl?: string;
  movie?: StreamItem;
};

type DownloadSeriesEpisodeInput = {
  seriesId: string;
  seriesTitle: string;
  image?: string;
  episodeId: string;
  episodeTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  extension?: string;
};

const STORAGE_KEY = 'downloaded_library_v1';
const BASE_DIR = `${FileSystem.documentDirectory}downloads`;
const MOVIES_DIR = `${BASE_DIR}/movies`;
const SERIES_DIR = `${BASE_DIR}/series`;

const activeResumables = new Map<string, FileSystem.DownloadResumable>();
const activeJobs = new Map<string, DownloadJob>();
const listeners = new Set<(jobs: DownloadJob[]) => void>();

const safeName = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'video';

const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function emitJobs() {
  const snapshot = Array.from(activeJobs.values()).sort((a, b) => a.title.localeCompare(b.title));
  listeners.forEach((listener) => listener(snapshot));
}

function setJob(job: DownloadJob) {
  activeJobs.set(job.id, job);
  emitJobs();
}

function updateJob(jobId: string, updates: Partial<DownloadJob>) {
  const current = activeJobs.get(jobId);
  if (!current) return;
  activeJobs.set(jobId, { ...current, ...updates });
  emitJobs();
}

function removeJob(jobId: string) {
  activeJobs.delete(jobId);
  activeResumables.delete(jobId);
  emitJobs();
}

async function ensureDir(path: string) {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
}

async function ensureBaseDirs() {
  await ensureDir(BASE_DIR);
  await ensureDir(MOVIES_DIR);
  await ensureDir(SERIES_DIR);
}

async function persist(items: DownloadedItem[]) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

export async function loadDownloadedItems() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [] as DownloadedItem[];

    const checks = await Promise.all(
      parsed.map(async (item) => {
        const localUri = String(item?.localUri || '');
        if (!localUri) return null;
        const fileInfo = await FileSystem.getInfoAsync(localUri);
        if (!fileInfo.exists) return null;
        return {
          id: String(item.id || uid()),
          type: item.type === 'series-episode' ? 'series-episode' : 'movie',
          contentId: String(item.contentId || ''),
          title: String(item.title || 'Sem titulo'),
          subtitle: item.subtitle ? String(item.subtitle) : undefined,
          image: item.image ? String(item.image) : undefined,
          localUri,
          originalUrl: String(item.originalUrl || ''),
          downloadedAt: String(item.downloadedAt || new Date().toISOString()),
          sizeBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : fileInfo.size,
          seriesId: item.seriesId ? String(item.seriesId) : undefined,
          seriesTitle: item.seriesTitle ? String(item.seriesTitle) : undefined,
          seasonNumber: typeof item.seasonNumber === 'number' ? item.seasonNumber : undefined,
          episodeNumber: typeof item.episodeNumber === 'number' ? item.episodeNumber : undefined,
        } satisfies DownloadedItem;
      })
    );

    const filtered = checks.filter(Boolean) as DownloadedItem[];
    await persist(filtered);
    return filtered.sort((a, b) => (a.downloadedAt > b.downloadedAt ? -1 : 1));
  } catch {
    return [] as DownloadedItem[];
  }
}

export async function hasDownloadedContent() {
  const items = await loadDownloadedItems();
  return items.length > 0;
}

export function subscribeDownloadJobs(listener: (jobs: DownloadJob[]) => void) {
  listeners.add(listener);
  listener(Array.from(activeJobs.values()));
  return () => {
    listeners.delete(listener);
  };
}

export async function deleteDownloadedItem(itemId: string) {
  const items = await loadDownloadedItems();
  const target = items.find((item) => item.id === itemId);
  if (target) {
    try {
      await FileSystem.deleteAsync(target.localUri, { idempotent: true });
    } catch {
      // Ignora falhas ao apagar arquivo ausente.
    }
  }
  const updated = items.filter((item) => item.id !== itemId);
  await persist(updated);
  return updated;
}

export async function pauseDownload(jobId: string) {
  const resumable = activeResumables.get(jobId);
  if (!resumable) return;
  await resumable.pauseAsync();
  updateJob(jobId, { status: 'paused' });
}

export async function resumeDownload(jobId: string) {
  const resumable = activeResumables.get(jobId);
  if (!resumable) return;
  updateJob(jobId, { status: 'downloading' });
  await resumable.resumeAsync();
}

export async function cancelDownload(jobId: string) {
  const resumable = activeResumables.get(jobId);
  const job = activeJobs.get(jobId);
  if (!resumable || !job) {
    removeJob(jobId);
    return;
  }

  try {
    await resumable.pauseAsync();
  } catch {
    // Ignora se ja finalizou/foi interrompido.
  }

  try {
    await FileSystem.deleteAsync(job.localUri, { idempotent: true });
  } catch {
    // Ignora falhas de limpeza.
  }

  removeJob(jobId);
}

function createProgressCallback(jobId: string) {
  return (progress: FileSystem.DownloadProgressData) => {
    const total = progress.totalBytesExpectedToWrite || 0;
    const written = progress.totalBytesWritten || 0;
    const pct = total > 0 ? Math.min(100, Math.round((written / total) * 100)) : 0;
    updateJob(jobId, {
      transferredBytes: written,
      totalBytes: total,
      progressPercent: pct,
      status: 'downloading',
    });
  };
}

async function saveCompletedItem(job: DownloadJob) {
  const items = await loadDownloadedItems();
  const exists = items.find((item) => item.type === job.type && item.contentId === job.contentId);
  if (exists) {
    return exists;
  }

  const next: DownloadedItem = {
    id: uid(),
    type: job.type,
    contentId: job.contentId,
    title: job.title,
    subtitle: job.subtitle,
    image: job.image,
    localUri: job.localUri,
    originalUrl: job.originalUrl,
    downloadedAt: new Date().toISOString(),
    sizeBytes: job.totalBytes || undefined,
    seriesId: job.seriesId,
    seriesTitle: job.seriesTitle,
    seasonNumber: job.seasonNumber,
    episodeNumber: job.episodeNumber,
  };

  const updated = [next, ...items];
  await persist(updated);
  return next;
}

async function startDownload(job: DownloadJob) {
  const resumable = FileSystem.createDownloadResumable(
    job.originalUrl,
    job.localUri,
    {},
    createProgressCallback(job.id)
  );

  activeResumables.set(job.id, resumable);
  setJob(job);

  try {
    const result = await resumable.downloadAsync();
    if (!result?.uri) {
      throw new Error('Download nao retornou arquivo local.');
    }

    const completedJob: DownloadJob = {
      ...job,
      localUri: result.uri,
      progressPercent: 100,
      status: 'completed',
    };
    setJob(completedJob);
    await saveCompletedItem(completedJob);
    removeJob(job.id);
    return completedJob;
  } catch (error: any) {
    updateJob(job.id, {
      status: 'failed',
      errorMessage: String(error?.message || error || 'Falha no download.'),
    });
    throw error;
  }
}

export async function downloadMovie(input: DownloadMovieInput) {
  const sourceUrl = input.sourceUrl || (input.movie ? await buildMovieUrl(input.movie) : null);
  if (!sourceUrl) {
    throw new Error('Nao foi possivel resolver a URL do filme para download.');
  }

  await ensureBaseDirs();
  const items = await loadDownloadedItems();
  const existing = items.find((item) => item.type === 'movie' && item.contentId === input.contentId);
  if (existing) {
    return existing;
  }

  const currentJob = Array.from(activeJobs.values()).find(
    (job) => job.type === 'movie' && job.contentId === input.contentId
  );
  if (currentJob) {
    return currentJob;
  }

  const extension = sourceUrl.split('?')[0].split('.').pop() || 'mp4';
  const fileName = `${safeName(input.title)}_${input.contentId}.${extension}`;
  const localUri = `${MOVIES_DIR}/${fileName}`;
  const job: DownloadJob = {
    id: uid(),
    type: 'movie',
    contentId: input.contentId,
    title: input.title,
    subtitle: 'Filme',
    image: input.image,
    status: 'downloading',
    progressPercent: 0,
    transferredBytes: 0,
    totalBytes: 0,
    localUri,
    originalUrl: sourceUrl,
  };

  return startDownload(job);
}

export async function downloadSeriesEpisode(input: DownloadSeriesEpisodeInput) {
  const sourceUrl = await buildSeriesEpisodeUrl(input.episodeId, input.extension || 'mp4');
  if (!sourceUrl) {
    throw new Error('Nao foi possivel resolver a URL do episodio para download.');
  }

  await ensureBaseDirs();
  const seriesFolder = `${SERIES_DIR}/${safeName(input.seriesTitle)}_${input.seriesId}`;
  await ensureDir(seriesFolder);

  const items = await loadDownloadedItems();
  const existing = items.find(
    (item) => item.type === 'series-episode' && item.contentId === input.episodeId
  );
  if (existing) {
    return existing;
  }

  const currentJob = Array.from(activeJobs.values()).find(
    (job) => job.type === 'series-episode' && job.contentId === input.episodeId
  );
  if (currentJob) {
    return currentJob;
  }

  const extension = sourceUrl.split('?')[0].split('.').pop() || input.extension || 'mp4';
  const fileName = `s${String(input.seasonNumber).padStart(2, '0')}e${String(input.episodeNumber).padStart(2, '0')}_${safeName(input.episodeTitle)}.${extension}`;
  const localUri = `${seriesFolder}/${fileName}`;
  const job: DownloadJob = {
    id: uid(),
    type: 'series-episode',
    contentId: input.episodeId,
    title: input.episodeTitle,
    subtitle: `S${input.seasonNumber} E${input.episodeNumber}`,
    image: input.image,
    status: 'downloading',
    progressPercent: 0,
    transferredBytes: 0,
    totalBytes: 0,
    localUri,
    originalUrl: sourceUrl,
    seriesId: input.seriesId,
    seriesTitle: input.seriesTitle,
    seasonNumber: input.seasonNumber,
    episodeNumber: input.episodeNumber,
  };

  return startDownload(job);
}

export async function downloadEntireSeries(
  seriesId: string,
  seriesTitle: string,
  image: string | undefined,
  episodes: Array<{
    episodeId: string;
    title: string;
    seasonNumber: number;
    episodeNumber: number;
    extension?: string;
  }>
) {
  const downloaded: Array<DownloadedItem | DownloadJob> = [];
  for (const episode of episodes) {
    const item = await downloadSeriesEpisode({
      seriesId,
      seriesTitle,
      image,
      episodeId: episode.episodeId,
      episodeTitle: episode.title,
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      extension: episode.extension,
    });
    downloaded.push(item);
  }
  return downloaded;
}
