/**
 * watch-sync.ts
 * Sync leve de "continuar assistindo" entre TV e mobile via servidor.
 * Push envia o progresso local; pull traz do servidor para mesclar.
 */

import { apiRequest } from '@/services/app-server';
import { loadUserSession } from '@/services/cloud-sync';
import { loadMovieProgressMap } from '@/services/movie-progress';
import { loadSeriesProgressMap } from '@/services/series-progress';

export type WatchSyncItem = {
  id: string;
  kind: 'vod' | 'series' | 'live';
  positionMs: number;
  durationMs: number;
  updatedAt: string;
};

let pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Envia o progresso local para o servidor (debounced 3s). */
export function schedulePushWatchProgress(): void {
  if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
  pushDebounceTimer = setTimeout(() => {
    void pushWatchProgress();
  }, 3000);
}

/** Envia o progresso local para o servidor imediatamente. */
export async function pushWatchProgress(): Promise<void> {
  try {
    const session = await loadUserSession();
    if (!session?.token) return;

    const [movieMap, seriesMap] = await Promise.all([
      loadMovieProgressMap(),
      loadSeriesProgressMap(),
    ]);

    const items: WatchSyncItem[] = [];

    for (const [id, prog] of Object.entries(movieMap)) {
      // só envia itens em progresso (entre 2% e 95%)
      if (prog.progressPercent > 2 && prog.progressPercent < 95) {
        items.push({
          id,
          kind: 'vod',
          positionMs: prog.positionMs,
          durationMs: prog.durationMs,
          updatedAt: prog.updatedAt,
        });
      }
    }

    for (const [seriesId, seriesProg] of Object.entries(seriesMap)) {
      const eps = Object.entries(seriesProg.episodes || {});
      if (!eps.length) continue;
      // pega o episódio atualizado mais recente
      eps.sort((a, b) => (a[1].updatedAt > b[1].updatedAt ? -1 : 1));
      const [, epProg] = eps[0];
      if (epProg.progress > 2 && epProg.progress < 95) {
        items.push({
          id: seriesId,
          kind: 'series',
          positionMs: epProg.positionMs,
          durationMs: epProg.durationMs,
          updatedAt: epProg.updatedAt,
        });
      }
    }

    items.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));

    await apiRequest('/api/continue-watch/push', {
      method: 'POST',
      token: session.token,
      body: { profileId: 'default', items: items.slice(0, 100) },
      timeoutMs: 8000,
    });
  } catch {
    // sync é best-effort
  }
}

/** Busca o progresso do servidor para o perfil padrão. */
export async function pullWatchProgress(): Promise<WatchSyncItem[]> {
  try {
    const session = await loadUserSession();
    if (!session?.token) return [];

    const result = await apiRequest<{ items: WatchSyncItem[] }>(
      '/api/continue-watch/pull?profileId=default',
      { token: session.token, timeoutMs: 8000 }
    );

    return Array.isArray(result?.items) ? result.items : [];
  } catch {
    return [];
  }
}
