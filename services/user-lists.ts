import { getDbValue, setDbValue } from '@/services/local-db';

export type ListContentType = 'movie' | 'series' | 'live';

export type UserListItem = {
  id: string;
  type: ListContentType;
  contentId: string;
  title: string;
  subtitle?: string;
  image?: string;
  playUrl?: string;
  addedAt: string;
};

export type UserList = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  items: UserListItem[];
};

const STORAGE_KEY = 'user_lists_v1';
const LISTS_DB_KEY = 'user_lists_v2';

const normalizeName = (value: string) => value.trim().replace(/\s{2,}/g, ' ');

const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

async function persist(lists: UserList[]) {
  await setDbValue(LISTS_DB_KEY, lists);
}

export async function loadUserLists(): Promise<UserList[]> {
  try {
    const fromDb = await getDbValue<UserList[]>(LISTS_DB_KEY);
    const parsed = Array.isArray(fromDb) ? fromDb : [];
    if (!Array.isArray(parsed)) return [] as UserList[];

    const normalized = parsed
      .filter((item: any) => item && typeof item === 'object')
      .map((item: any) => ({
        id: String(item.id || uid()),
        name: normalizeName(String(item.name || 'Minha lista')) || 'Minha lista',
        createdAt: String(item.createdAt || new Date().toISOString()),
        updatedAt: String(item.updatedAt || new Date().toISOString()),
        items: Array.isArray(item.items)
          ? item.items
              .filter((entry: any) => entry && typeof entry === 'object')
              .map((entry: any) => ({
                id: String(entry.id || uid()),
                type: (entry.type === 'series' || entry.type === 'live' ? entry.type : 'movie') as ListContentType,
                contentId: String(entry.contentId || ''),
                title: String(entry.title || 'Sem titulo'),
                subtitle: entry.subtitle ? String(entry.subtitle) : undefined,
                image: entry.image ? String(entry.image) : undefined,
                playUrl: entry.playUrl ? String(entry.playUrl) : undefined,
                addedAt: String(entry.addedAt || new Date().toISOString()),
              }))
              .filter((entry: UserListItem) => !!entry.contentId)
          : [],
      }))
      .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));

    if (normalized.length > 0) {
      await setDbValue(LISTS_DB_KEY, normalized);
    }

    return normalized;
  } catch {
    return [] as UserList[];
  }
}

export async function createUserList(name: string) {
  const safeName = normalizeName(name);
  if (!safeName) {
    throw new Error('Informe um nome para a lista.');
  }

  const lists = await loadUserLists();
  const now = new Date().toISOString();
  const next: UserList = {
    id: uid(),
    name: safeName,
    createdAt: now,
    updatedAt: now,
    items: [],
  };

  const updated = [next, ...lists];
  await persist(updated);
  return { created: next, lists: updated };
}

export async function renameUserList(listId: string, nextName: string) {
  const safeName = normalizeName(nextName);
  if (!safeName) {
    throw new Error('Informe um nome valido para renomear.');
  }

  const lists = await loadUserLists();
  const updated = lists.map((list) =>
    list.id === listId
      ? { ...list, name: safeName, updatedAt: new Date().toISOString() }
      : list
  );

  await persist(updated);
  return updated;
}

export async function deleteUserList(listId: string) {
  const lists = await loadUserLists();
  const updated = lists.filter((list) => list.id !== listId);
  await persist(updated);
  return updated;
}

export async function addItemToList(
  listId: string,
  item: Omit<UserListItem, 'id' | 'addedAt'>
) {
  const lists = await loadUserLists();
  const now = new Date().toISOString();

  const updated = lists.map((list) => {
    if (list.id !== listId) return list;

    const exists = list.items.some(
      (entry: UserListItem) => entry.type === item.type && entry.contentId === item.contentId
    );

    if (exists) {
      return { ...list, updatedAt: now };
    }

    const nextItem: UserListItem = {
      id: uid(),
      type: item.type,
      contentId: item.contentId,
      title: item.title,
      subtitle: item.subtitle,
      image: item.image,
      playUrl: item.playUrl,
      addedAt: now,
    };

    return {
      ...list,
      updatedAt: now,
      items: [nextItem, ...list.items],
    };
  });

  await persist(updated);
  return updated;
}

export async function removeItemFromList(listId: string, itemId: string) {
  const lists = await loadUserLists();
  const updated = lists.map((list) =>
    list.id === listId
      ? {
          ...list,
          updatedAt: new Date().toISOString(),
          items: list.items.filter((item: UserListItem) => item.id !== itemId),
        }
      : list
  );

  await persist(updated);
  return updated;
}
