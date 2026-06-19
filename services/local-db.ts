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

  try {
    const db = await getDb();
    
    // Create table
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);

    initialized = true;
  } catch (err) {
    console.error('[LocalDB] Erro ao inicializar banco:', err);
    initialized = true;
  }
}

export async function getLocalDb() {
  await ensureReady();
  return getDb();
}

export async function setDbValue<T>(key: string, value: T) {
  try {
    if (!key) return;
    await ensureReady();
    const db = await getDb();
    await db.runAsync('INSERT OR REPLACE INTO kv_store (key, value, updatedAt) VALUES (?, ?, ?)', key, JSON.stringify(value), new Date().toISOString());
  } catch (err) {
    console.error('[LocalDB] Erro ao salvar valor:', err);
  }
}

export async function getDbValue<T>(key: string): Promise<T | null> {
  try {
    if (!key) return null;
    await ensureReady();
    const db = await getDb();

    const result = await db.getFirstAsync<{ value: string }>('SELECT value FROM kv_store WHERE key = ?', key);
    
    if (!result?.value) {
      return null;
    }

    try {
      return JSON.parse(result.value) as T;
    } catch {
      return null;
    }
  } catch (err) {
    console.error('[LocalDB] Erro ao obter valor:', err);
    return null;
  }
}

export async function removeDbValue(key: string) {
  try {
    if (!key) return;
    await ensureReady();
    const db = await getDb();
    await db.runAsync('DELETE FROM kv_store WHERE key = ?', key);
  } catch (err) {
    console.error('[LocalDB] Erro ao remover valor:', err);
  }
}

export async function pruneDbValuesByPrefixOlderThan(prefix: string, maxAgeMs: number) {
  if (!prefix || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return 0;
  }

  try {
    await ensureReady();
    const db = await getDb();
    const cutoffIso = new Date(Date.now() - maxAgeMs).toISOString();
    const likePattern = `${prefix}%`;

    // Count rows
    const countRow = await db.getFirstAsync<{ total: number }>('SELECT COUNT(1) as total FROM kv_store WHERE key LIKE ? AND updatedAt < ?', likePattern, cutoffIso);

    const total = Number(countRow?.total || 0);
    if (!total) {
      return 0;
    }

    // Delete rows
    await db.runAsync('DELETE FROM kv_store WHERE key LIKE ? AND updatedAt < ?', likePattern, cutoffIso);
    
    return total;
  } catch (err) {
    console.error('[LocalDB] Erro ao limpar dados antigos:', err);
    return 0;
  }
}

export async function getDbValuesByPrefix(prefix: string, limit?: number) {
  try {
    if (!prefix) return [];
    await ensureReady();
    const db = await getDb();
    const likePattern = `${prefix}%`;
    const query = `SELECT key, value, updatedAt FROM kv_store WHERE key LIKE ? ORDER BY updatedAt DESC${limit ? ' LIMIT ' + Number(limit) : ''}`;
    const rows = await db.getAllAsync<{ key: string; value: string; updatedAt: string }>(query, likePattern);
    return (rows || []).map((r) => {
      try {
        return { key: r.key, value: JSON.parse(r.value), updatedAt: r.updatedAt };
      } catch {
        return { key: r.key, value: null, updatedAt: r.updatedAt };
      }
    });
  } catch (err) {
    console.error('[LocalDB] Erro ao listar valores por prefixo:', err);
    return [];
  }
}
