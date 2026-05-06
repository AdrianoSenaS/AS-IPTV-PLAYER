import { getLocalDb, getDbValue, setDbValue } from '@/services/local-db';

export type StreamItem = {
  stream_id?: string | number;
  series_id?: string | number;
  category_id?: string | number;
  category_ids?: number[];
  stream_icon?: string;
  cover?: string;
  rating?: string | number;
  rating_5based?: string | number;
  title?: string;
  name?: string;
  plot?: string;
  release_date?: string;
  duration?: string;
  genre?: string;
  quality?: string;
  num?: string | number;
  category_name?: string;
};

export type CatalogKind = 'vod' | 'series' | 'live';

type CatalogSnapshot = {
  vod: StreamItem[];
  liveCategories: StreamItem[];
  liveStreams: StreamItem[];
  series: StreamItem[];
  vodCategories: StreamItem[];
  seriesCategories: StreamItem[];
};

type CatalogQueryOptions = {
  kind: CatalogKind;
  categoryId?: string;
  search?: string;
  offset?: number;
  limit?: number;
};

const CATALOG_DB_KEY = 'catalog.snapshot.v3';
const CATALOG_LAST_UPDATE_KEY = 'catalog.lastUpdate.v1';
const CATALOG_READY_KEY = 'catalog.ready.v1';
const RT_BLOCKED_CONTENT_CACHE_KEY = 'realtimeServer.blockedContent.v1';
const BLOCKED_CACHE_TTL_MS = 30000;

let catalogCache: CatalogSnapshot | null = null;
let catalogHashCache = '';
let catalogInitialized = false;
let blockedSetCache = new Set<string>();
let blockedSetCacheAt = 0;

async function getBlockedContentSet(): Promise<Set<string>> {
  const now = Date.now();
  if (now - blockedSetCacheAt <= BLOCKED_CACHE_TTL_MS) {
    return blockedSetCache;
  }

  const blockedIds = await getDbValue<string[]>(RT_BLOCKED_CONTENT_CACHE_KEY);
  blockedSetCache = new Set(
    Array.isArray(blockedIds)
      ? blockedIds.map((item) => String(item || '').trim()).filter(Boolean)
      : []
  );
  blockedSetCacheAt = now;
  return blockedSetCache;
}

function ensureArray(value: unknown): StreamItem[] {
  return Array.isArray(value) ? (value as StreamItem[]) : [];
}

function toSnapshot(input: Partial<CatalogSnapshot> | null | undefined): CatalogSnapshot {
  return {
    vod: ensureArray(input?.vod),
    liveCategories: ensureArray(input?.liveCategories),
    liveStreams: ensureArray(input?.liveStreams),
    series: ensureArray(input?.series),
    vodCategories: ensureArray(input?.vodCategories),
    seriesCategories: ensureArray(input?.seriesCategories),
  };
}

function buildFastHash(snapshot: CatalogSnapshot) {
  const counts = [
    snapshot.vod.length,
    snapshot.liveCategories.length,
    snapshot.liveStreams.length,
    snapshot.series.length,
    snapshot.vodCategories.length,
    snapshot.seriesCategories.length,
  ].join('|');

  const probes = [
    toText(snapshot.vod[0]?.stream_id),
    toText(snapshot.vod[snapshot.vod.length - 1]?.stream_id),
    toText(snapshot.series[0]?.series_id),
    toText(snapshot.series[snapshot.series.length - 1]?.series_id),
    toText(snapshot.liveStreams[0]?.stream_id),
    toText(snapshot.liveStreams[snapshot.liveStreams.length - 1]?.stream_id),
  ].join('|');

  return `${counts}::${probes}`;
}

async function ensureCatalogTables() {
  if (catalogInitialized) {
    return;
  }

  const db = await getLocalDb();
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS catalog_items (
      kind TEXT NOT NULL,
      item_id TEXT NOT NULL,
      category_id TEXT,
      title TEXT,
      search_text TEXT,
      sort_num INTEGER,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, item_id)
    );

    CREATE TABLE IF NOT EXISTS catalog_categories (
      kind TEXT NOT NULL,
      category_id TEXT NOT NULL,
      category_name TEXT,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, category_id)
    );

    CREATE TABLE IF NOT EXISTS catalog_items_staging (
      kind TEXT NOT NULL,
      item_id TEXT NOT NULL,
      category_id TEXT,
      title TEXT,
      search_text TEXT,
      sort_num INTEGER,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, item_id)
    );

    CREATE TABLE IF NOT EXISTS catalog_categories_staging (
      kind TEXT NOT NULL,
      category_id TEXT NOT NULL,
      category_name TEXT,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, category_id)
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_items_kind_category
      ON catalog_items (kind, category_id);

    CREATE INDEX IF NOT EXISTS idx_catalog_items_kind_search
      ON catalog_items (kind, search_text);

    CREATE INDEX IF NOT EXISTS idx_catalog_items_kind_sort
      ON catalog_items (kind, sort_num, item_id);

    CREATE INDEX IF NOT EXISTS idx_catalog_items_staging_kind_category
      ON catalog_items_staging (kind, category_id);

    CREATE INDEX IF NOT EXISTS idx_catalog_items_staging_kind_search
      ON catalog_items_staging (kind, search_text);

    CREATE INDEX IF NOT EXISTS idx_catalog_items_staging_kind_sort
      ON catalog_items_staging (kind, sort_num, item_id);
  `);

  catalogInitialized = true;
}

function getItemIdByKind(kind: CatalogKind, item: StreamItem): string {
  if (kind === 'series') {
    return toText(item.series_id);
  }
  return toText(item.stream_id);
}

function getTitle(item: StreamItem) {
  return sanitizeLabelText(item.title || item.name, '').trim();
}

function getSearchText(item: StreamItem) {
  return [
    toText(item.title || item.name),
    toText(item.category_name),
    toText(item.genre),
    toText(item.plot),
  ]
    .join(' ')
    .toLowerCase();
}

// Otimização: processamento chunked para evitar OOM
async function replaceItemsInTable(tableName: 'catalog_items' | 'catalog_items_staging', kind: CatalogKind, items: StreamItem[]) {
  const db = await getLocalDb();
  const now = new Date().toISOString();
  type Row = [string, string, string, string, string, number, string, string];
  const BATCH = 120;
  const CHUNK = 500; // processa 500 itens por vez para liberar memória

  await db.execAsync('BEGIN IMMEDIATE TRANSACTION;');
  try {
    await db.runAsync(`DELETE FROM ${tableName} WHERE kind = ?`, [kind]);

    for (let chunkStart = 0; chunkStart < items.length; chunkStart += CHUNK) {
      const chunkItems = items.slice(chunkStart, chunkStart + CHUNK);
      const rows: Row[] = [];
      for (let i = 0; i < chunkItems.length; i++) {
        const item = chunkItems[i];
        const itemId = getItemIdByKind(kind, item);
        if (!itemId) continue;
        rows.push([
          kind,
          itemId,
          toText(item.category_id),
          getTitle(item),
          getSearchText(item),
          Number(item.num ?? (chunkStart + i)),
          JSON.stringify(item),
          now,
        ]);
      }
      for (let start = 0; start < rows.length; start += BATCH) {
        const batch = rows.slice(start, start + BATCH);
        const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?)').join(',');
        await db.runAsync(
          `INSERT OR REPLACE INTO ${tableName}
            (kind,item_id,category_id,title,search_text,sort_num,payload,updated_at)
           VALUES ${placeholders}`,
          batch.flat()
        );
      }
      // Libera memória do chunk
      rows.length = 0;
      // @ts-ignore
      globalThis.gc?.();
    }

    await db.execAsync('COMMIT;');
  } catch (error) {
    await db.execAsync('ROLLBACK;');
    throw error;
  }
}

async function replaceItems(kind: CatalogKind, items: StreamItem[]) {
  await replaceItemsInTable('catalog_items', kind, items);
}

// Otimização: processamento chunked para evitar OOM
async function replaceCategoriesInTable(
  tableName: 'catalog_categories' | 'catalog_categories_staging',
  kind: CatalogKind,
  categories: StreamItem[]
) {
  const db = await getLocalDb();
  const now = new Date().toISOString();
  type Row = [string, string, string, string, string];
  const BATCH = 190;
  const CHUNK = 800; // categorias são menores, pode ser maior

  await db.execAsync('BEGIN IMMEDIATE TRANSACTION;');
  try {
    await db.runAsync(`DELETE FROM ${tableName} WHERE kind = ?`, [kind]);

    for (let chunkStart = 0; chunkStart < categories.length; chunkStart += CHUNK) {
      const chunkCats = categories.slice(chunkStart, chunkStart + CHUNK);
      const rows: Row[] = [];
      for (let i = 0; i < chunkCats.length; i++) {
        const category = chunkCats[i];
        const categoryId = toText(category.category_id);
        if (!categoryId) continue;
        rows.push([
          kind,
          categoryId,
          sanitizeLabelText(category.category_name, 'Categoria'),
          JSON.stringify(category),
          now,
        ]);
      }
      for (let start = 0; start < rows.length; start += BATCH) {
        const batch = rows.slice(start, start + BATCH);
        const placeholders = batch.map(() => '(?,?,?,?,?)').join(',');
        await db.runAsync(
          `INSERT OR REPLACE INTO ${tableName}
            (kind,category_id,category_name,payload,updated_at)
           VALUES ${placeholders}`,
          batch.flat()
        );
      }
      rows.length = 0;
      // @ts-ignore
      globalThis.gc?.();
    }

    await db.execAsync('COMMIT;');
  } catch (error) {
    await db.execAsync('ROLLBACK;');
    throw error;
  }
}

async function replaceCategories(kind: CatalogKind, categories: StreamItem[]) {
  await replaceCategoriesInTable('catalog_categories', kind, categories);
}

// Funções públicas para salvar por tipo individualmente (usadas na tela de loading)
export async function saveCatalogItems(kind: CatalogKind, items: StreamItem[]) {
  await ensureCatalogTables();
  await replaceItems(kind, items);
}

export async function saveCatalogCategories(kind: CatalogKind, categories: StreamItem[]) {
  await ensureCatalogTables();
  await replaceCategories(kind, categories);
}

export async function clearCatalogStaging() {
  await ensureCatalogTables();
  const db = await getLocalDb();
  await db.execAsync(`
    DELETE FROM catalog_items_staging;
    DELETE FROM catalog_categories_staging;
  `);
}

export async function stageCatalogItems(kind: CatalogKind, items: StreamItem[]) {
  await ensureCatalogTables();
  await replaceItemsInTable('catalog_items_staging', kind, items);
}

export async function stageCatalogCategories(kind: CatalogKind, categories: StreamItem[]) {
  await ensureCatalogTables();
  await replaceCategoriesInTable('catalog_categories_staging', kind, categories);
}

export async function commitCatalogStaging() {
  await ensureCatalogTables();
  const db = await getLocalDb();

  await db.execAsync('BEGIN IMMEDIATE TRANSACTION;');
  try {
    await db.execAsync(`
      DELETE FROM catalog_items;
      INSERT OR REPLACE INTO catalog_items
        (kind, item_id, category_id, title, search_text, sort_num, payload, updated_at)
      SELECT kind, item_id, category_id, title, search_text, sort_num, payload, updated_at
      FROM catalog_items_staging;

      DELETE FROM catalog_categories;
      INSERT OR REPLACE INTO catalog_categories
        (kind, category_id, category_name, payload, updated_at)
      SELECT kind, category_id, category_name, payload, updated_at
      FROM catalog_categories_staging;
    `);

    await db.execAsync('COMMIT;');
  } catch (error) {
    await db.execAsync('ROLLBACK;');
    throw error;
  }

  const itemCounts = await db.getAllAsync<{ kind: string; total: number }>(
    'SELECT kind, COUNT(1) as total FROM catalog_items GROUP BY kind'
  );

  const counts = {
    vod: 0,
    series: 0,
    live: 0,
  };

  for (const row of itemCounts) {
    if (row.kind === 'vod' || row.kind === 'series' || row.kind === 'live') {
      counts[row.kind] = Number(row.total || 0);
    }
  }

  await setDbValue(CATALOG_DB_KEY, {
    counts,
    updatedAt: new Date().toISOString(),
  });
  await setDbValue(CATALOG_READY_KEY, true);
}

export async function setCatalogLastUpdate(isoDate: string) {
  await setDbValue(CATALOG_LAST_UPDATE_KEY, isoDate);
}

export async function getCatalogLastUpdate(): Promise<string | null> {
  return getDbValue<string>(CATALOG_LAST_UPDATE_KEY);
}

export async function hasLocalCatalogDataQuick(): Promise<boolean> {
  await ensureCatalogTables();
  const [ready, db] = await Promise.all([
    getDbValue<boolean>(CATALOG_READY_KEY),
    getLocalDb(),
  ]);

  if (ready) {
    return true;
  }

  const itemRows = await db.getAllAsync<{ kind: string; total: number }>(
    'SELECT kind, COUNT(1) as total FROM catalog_items GROUP BY kind'
  );
  const categoryRows = await db.getAllAsync<{ kind: string; total: number }>(
    'SELECT kind, COUNT(1) as total FROM catalog_categories GROUP BY kind'
  );

  const itemKinds = new Set(itemRows.filter((row) => Number(row.total || 0) > 0).map((row) => row.kind));
  const categoryKinds = new Set(categoryRows.filter((row) => Number(row.total || 0) > 0).map((row) => row.kind));

  return (
    itemKinds.has('vod') &&
    itemKinds.has('series') &&
    itemKinds.has('live') &&
    categoryKinds.has('vod') &&
    categoryKinds.has('series') &&
    categoryKinds.has('live')
  );
}

// Otimização: snapshot processado em lotes menores para evitar OOM
export async function saveCatalogSnapshot(snapshot: CatalogSnapshot, _writeFiles = false) {
  const safe = toSnapshot(snapshot);
  const nextHash = buildFastHash(safe);

  await ensureCatalogTables();

  // Processa cada tipo em lotes menores
  await replaceItems('vod', safe.vod);
  await replaceItems('series', safe.series);
  await replaceItems('live', safe.liveStreams);
  await replaceCategories('vod', safe.vodCategories);
  await replaceCategories('series', safe.seriesCategories);
  await replaceCategories('live', safe.liveCategories);

  if (catalogHashCache !== nextHash) {
    await setDbValue(CATALOG_DB_KEY, {
      counts: {
        vod: safe.vod.length,
        series: safe.series.length,
        live: safe.liveStreams.length,
      },
      updatedAt: new Date().toISOString(),
    });
    catalogHashCache = nextHash;
  }

  await setDbValue(CATALOG_READY_KEY, true);

  catalogCache = safe;
}

async function readItems(kind: CatalogKind): Promise<StreamItem[]> {
  await ensureCatalogTables();
  const db = await getLocalDb();
  const rows = await db.getAllAsync<{ payload: string }>(
    `SELECT payload FROM catalog_items
      WHERE kind = ?
      ORDER BY sort_num ASC, item_id ASC`,
    [kind]
  );

  const blockedSet = await getBlockedContentSet();

  return rows
    .map((row) => {
      try {
        return JSON.parse(row.payload) as StreamItem;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((item) => {
      const itemId = kind === 'series' ? toText(item?.series_id) : toText(item?.stream_id);
      if (!itemId) return true;
      return !blockedSet.has(itemId);
    }) as StreamItem[];
}

async function readCategories(kind: CatalogKind): Promise<StreamItem[]> {
  await ensureCatalogTables();
  const db = await getLocalDb();
  const rows = await db.getAllAsync<{ payload: string }>(
    `SELECT payload FROM catalog_categories
      WHERE kind = ?
      ORDER BY category_name COLLATE NOCASE ASC`,
    [kind]
  );

  return rows
    .map((row) => {
      try {
        return JSON.parse(row.payload) as StreamItem;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as StreamItem[];
}

export async function loadCatalogData(forceRefresh = false) {
  if (catalogCache && !forceRefresh) {
    return catalogCache;
  }

  const [vod, liveCategories, liveStreams, series, vodCategories, seriesCategories] = await Promise.all([
    readItems('vod'),
    readCategories('live'),
    readItems('live'),
    readItems('series'),
    readCategories('vod'),
    readCategories('series'),
  ]);

  const snapshot = toSnapshot({
    vod,
    liveCategories,
    liveStreams,
    series,
    vodCategories,
    seriesCategories,
  });

  catalogHashCache = buildFastHash(snapshot);
  catalogCache = snapshot;
  return catalogCache;
}

export async function queryCatalogPage({
  kind,
  categoryId = 'all',
  search = '',
  offset = 0,
  limit = 90,
}: CatalogQueryOptions): Promise<StreamItem[]> {
  await ensureCatalogTables();
  const db = await getLocalDb();

  const where: string[] = ['kind = ?'];
  const args: Array<string | number> = [kind];

  if (categoryId && categoryId !== 'all') {
    where.push('category_id = ?');
    args.push(categoryId);
  }

  const normalizedSearch = search.trim().toLowerCase();
  if (normalizedSearch) {
    where.push('search_text LIKE ?');
    args.push(`%${normalizedSearch}%`);
  }

  args.push(Math.max(1, limit));
  args.push(Math.max(0, offset));

  const rows = await db.getAllAsync<{ payload: string }>(
    `SELECT payload FROM catalog_items
      WHERE ${where.join(' AND ')}
      ORDER BY sort_num ASC, item_id ASC
      LIMIT ? OFFSET ?`,
    args
  );

  const blockedIds = await getDbValue<string[]>(RT_BLOCKED_CONTENT_CACHE_KEY);
  const blockedSet = new Set(
    Array.isArray(blockedIds)
      ? blockedIds.map((item) => String(item || '').trim()).filter(Boolean)
      : []
  );

  return rows
    .map((row) => {
      try {
        return JSON.parse(row.payload) as StreamItem;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((item) => {
      const itemId = kind === 'series' ? toText(item?.series_id) : toText(item?.stream_id);
      if (!itemId) return true;
      return !blockedSet.has(itemId);
    }) as StreamItem[];
}

export async function queryCatalogCount({
  kind,
  categoryId = 'all',
  search = '',
}: Omit<CatalogQueryOptions, 'offset' | 'limit'>): Promise<number> {
  await ensureCatalogTables();
  const db = await getLocalDb();

  const where: string[] = ['kind = ?'];
  const args: Array<string | number> = [kind];

  if (categoryId && categoryId !== 'all') {
    where.push('category_id = ?');
    args.push(categoryId);
  }

  const normalizedSearch = search.trim().toLowerCase();
  if (normalizedSearch) {
    where.push('search_text LIKE ?');
    args.push(`%${normalizedSearch}%`);
  }

  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COUNT(1) as total FROM catalog_items WHERE ${where.join(' AND ')}`,
    args
  );

  return Number(row?.total || 0);
}

export async function queryCatalogCategories(kind: CatalogKind) {
  const categories = await readCategories(kind);
  if (categories.length) {
    return categories;
  }

  const items = await readItems(kind);
  const categoryIds = new Set<string>();
  const categoryNames = new Map<string, string>();

  for (const item of items) {
    const categoryId = toText(item.category_id).trim();
    if (!categoryId) {
      continue;
    }

    categoryIds.add(categoryId);

    if (categoryNames.has(categoryId)) {
      continue;
    }

    const serverCategoryName = sanitizeLabelText(item.category_name, '').trim();
    if (serverCategoryName) {
      categoryNames.set(categoryId, serverCategoryName);
    }
  }

  return Array.from(categoryIds)
    .map((categoryId) => ({
      category_id: categoryId,
      category_name: sanitizeLabelText(
        categoryNames.get(categoryId),
        `Categoria ${categoryId}`
      ),
    }))
    .sort((a, b) => a.category_name.localeCompare(b.category_name, 'pt-BR', { sensitivity: 'base' }));
}

export async function queryCatalogItemsByIds(
  kind: CatalogKind,
  ids: string[]
): Promise<Record<string, StreamItem>> {
  await ensureCatalogTables();
  const db = await getLocalDb();

  const normalizedIds = Array.from(
    new Set(
      ids
        .map((id) => id.trim())
        .filter(Boolean)
    )
  );

  if (!normalizedIds.length) {
    return {};
  }

  const blockedIds = await getDbValue<string[]>(RT_BLOCKED_CONTENT_CACHE_KEY);
  const blockedSet = new Set(
    Array.isArray(blockedIds)
      ? blockedIds.map((item) => String(item || '').trim()).filter(Boolean)
      : []
  );

  const byId: Record<string, StreamItem> = {};
  const CHUNK_SIZE = 300;

  for (let i = 0; i < normalizedIds.length; i += CHUNK_SIZE) {
    const chunk = normalizedIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db.getAllAsync<{ item_id: string; payload: string }>(
      `SELECT item_id, payload FROM catalog_items
        WHERE kind = ? AND item_id IN (${placeholders})`,
      [kind, ...chunk]
    );

    for (const row of rows) {
      try {
        if (blockedSet.has(String(row.item_id || '').trim())) {
          continue;
        }
        byId[row.item_id] = JSON.parse(row.payload) as StreamItem;
      } catch {
        // Ignora payload invalido para manter resiliencia.
      }
    }
  }

  return byId;
}

export function invalidateCatalogCache() {
  catalogCache = null;
}

export const toText = (value: unknown, fallback = '') => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return fallback;
};

const EMOJI_ICON_REGEX =
  /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}\u{200D}]/gu;

export const sanitizeLabelText = (value: unknown, fallback = '') => {
  const raw = toText(value, fallback);
  const cleaned = raw.replace(EMOJI_ICON_REGEX, '').replace(/\s{2,}/g, ' ').trim();
  return cleaned || fallback;
};

export const matchesCategory = (item: StreamItem, selectedCategory: string) => {
  if (selectedCategory === 'all') {
    return true;
  }

  const itemCategoryId = toText(item.category_id);
  if (itemCategoryId && itemCategoryId === selectedCategory) {
    return true;
  }

  if (Array.isArray(item.category_ids)) {
    return item.category_ids.map(String).includes(selectedCategory);
  }

  return false;
};
