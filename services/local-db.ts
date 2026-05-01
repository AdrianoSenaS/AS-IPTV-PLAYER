import * as SQLite from 'expo-sqlite';

const DB_NAME = 'as_xstream_local.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let initialized = false;

async function getDb() {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DB_NAME);
  }
  return dbPromise;
}

async function ensureReady() {
  if (initialized) {
    return;
  }

  const db = await getDb();
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);

  initialized = true;
}

export async function getLocalDb() {
  await ensureReady();
  return getDb();
}

export async function setDbValue<T>(key: string, value: T) {
  await ensureReady();
  const db = await getDb();
  await db.runAsync(
    'INSERT OR REPLACE INTO kv_store (key, value, updatedAt) VALUES (?, ?, ?)',
    key,
    JSON.stringify(value),
    new Date().toISOString()
  );
}

export async function getDbValue<T>(key: string): Promise<T | null> {
  await ensureReady();
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM kv_store WHERE key = ?', key);

  if (!row?.value) {
    return null;
  }

  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function removeDbValue(key: string) {
  await ensureReady();
  const db = await getDb();
  await db.runAsync('DELETE FROM kv_store WHERE key = ?', key);
}

export async function pruneDbValuesByPrefixOlderThan(prefix: string, maxAgeMs: number) {
  if (!prefix || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return 0;
  }

  await ensureReady();
  const db = await getDb();
  const cutoffIso = new Date(Date.now() - maxAgeMs).toISOString();
  const likePattern = `${prefix}%`;

  const countRow = await db.getFirstAsync<{ total: number }>(
    'SELECT COUNT(1) as total FROM kv_store WHERE key LIKE ? AND updatedAt < ?',
    likePattern,
    cutoffIso
  );

  const total = Number(countRow?.total || 0);
  if (!total) {
    return 0;
  }

  await db.runAsync('DELETE FROM kv_store WHERE key LIKE ? AND updatedAt < ?', likePattern, cutoffIso);
  return total;
}
