import { getDbValue, setDbValue } from '@/services/local-db';
import { loadAccountSettings } from '@/services/account-settings';

type ScopedContainer<T> = {
  __scopedByProfile: true;
  profiles: Record<string, T>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isScopedContainer<T>(value: unknown): value is ScopedContainer<T> {
  return isObject(value) && value.__scopedByProfile === true && isObject(value.profiles);
}

async function getActiveProfileScopeId() {
  try {
    const settings = await loadAccountSettings();
    return String(settings.activeProfileId || settings.profiles[0]?.id || 'default');
  } catch {
    return 'default';
  }
}

export async function loadProfileScopedValue<T>(key: string, fallback: T): Promise<T> {
  const [raw, profileId] = await Promise.all([
    getDbValue<unknown>(key),
    getActiveProfileScopeId(),
  ]);

  if (isScopedContainer<T>(raw)) {
    return raw.profiles[profileId] ?? fallback;
  }

  if (raw === null || raw === undefined) {
    return fallback;
  }

  // Migra formato legado (valor unico sem escopo) para o perfil ativo,
  // evitando vazamento de dados entre perfis diferentes.
  try {
    await setDbValue<ScopedContainer<T>>(key, {
      __scopedByProfile: true,
      profiles: {
        [profileId]: raw as T,
      },
    });
  } catch {
    // Se a migracao falhar, ainda retorna o valor legado para nao quebrar a tela.
  }

  return raw as T;
}

export async function saveProfileScopedValue<T>(key: string, nextValue: T): Promise<void> {
  const [raw, profileId] = await Promise.all([
    getDbValue<unknown>(key),
    getActiveProfileScopeId(),
  ]);

  const profiles = isScopedContainer<T>(raw) ? { ...raw.profiles } : {};

  if (!isScopedContainer<T>(raw) && raw !== null && raw !== undefined) {
    profiles[profileId] = raw as T;
  }

  profiles[profileId] = nextValue;

  await setDbValue<ScopedContainer<T>>(key, {
    __scopedByProfile: true,
    profiles,
  });
}