import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { StreamingTheme } from '@/constants/streaming-theme';
import {
  addItemToList,
  createUserList,
  ListContentType,
  loadUserLists,
  UserList,
} from '@/services/user-lists';

type AddToListItem = {
  type: ListContentType;
  contentId: string;
  title: string;
  subtitle?: string;
  image?: string;
  playUrl?: string;
};

export function AddToListModal({
  visible,
  onClose,
  item,
  onAdded,
}: {
  visible: boolean;
  onClose: () => void;
  item: AddToListItem;
  onAdded?: () => void;
}) {
  const [lists, setLists] = useState<UserList[]>([]);
  const [newListName, setNewListName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const refreshLists = async () => {
    setLists(await loadUserLists());
  };

  useEffect(() => {
    if (!visible) return;
    refreshLists();
  }, [visible]);

  const saveIntoList = async (listId: string) => {
    try {
      setIsSaving(true);
      await addItemToList(listId, item);
      onAdded?.();
      Alert.alert('Lista atualizada', 'Conteudo adicionado na sua lista.');
      onClose();
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel salvar na lista.'));
    } finally {
      setIsSaving(false);
    }
  };

  const createAndSave = async () => {
    try {
      setIsSaving(true);
      const created = await createUserList(newListName);
      setNewListName('');
      await addItemToList(created.created.id, item);
      onAdded?.();
      Alert.alert('Lista criada', 'Nova lista criada e conteudo adicionado.');
      onClose();
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel criar a lista.'));
    } finally {
      setIsSaving(false);
      refreshLists();
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.card} activeOpacity={1} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>Adicionar a lista</Text>
            <TouchableOpacity style={styles.iconBtn} onPress={onClose}>
              <MaterialIcons name="close" size={18} color={StreamingTheme.colors.textPrimary} />
            </TouchableOpacity>
          </View>

          <Text style={styles.itemTitle} numberOfLines={1}>{item.title}</Text>

          <View style={styles.createRow}>
            <TextInput
              style={styles.input}
              value={newListName}
              onChangeText={setNewListName}
              placeholder="Criar nova lista"
              placeholderTextColor={StreamingTheme.colors.textMuted}
            />
            <TouchableOpacity
              style={[styles.createBtn, (isSaving || !newListName.trim()) && styles.createBtnDisabled]}
              disabled={isSaving || !newListName.trim()}
              onPress={createAndSave}>
              <MaterialIcons name="playlist-add" size={18} color={StreamingTheme.colors.textPrimary} />
              <Text style={styles.createBtnText}>Criar</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.sectionLabel}>Minhas listas</Text>
          <ScrollView style={styles.listWrap} showsVerticalScrollIndicator={false}>
            {lists.length === 0 ? (
              <Text style={styles.emptyText}>Voce ainda nao criou listas.</Text>
            ) : (
              lists.map((list) => (
                <TouchableOpacity
                  key={list.id}
                  style={styles.listItem}
                  disabled={isSaving}
                  onPress={() => saveIntoList(list.id)}>
                  <View style={styles.listItemMain}>
                    <Text style={styles.listName}>{list.name}</Text>
                    <Text style={styles.listMeta}>{list.items.length} itens</Text>
                  </View>
                  <MaterialIcons name="add-circle-outline" size={20} color={StreamingTheme.colors.accentAlt} />
                </TouchableOpacity>
              ))
            )}
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.52)',
    padding: 20,
    justifyContent: 'center',
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    padding: 14,
    maxHeight: '82%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '800',
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
  },
  itemTitle: {
    marginTop: 8,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '700',
  },
  createRow: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 8,
  },
  input: {
    flex: 1,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    paddingHorizontal: 12,
    color: StreamingTheme.colors.textPrimary,
  },
  createBtn: {
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: StreamingTheme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  createBtnDisabled: {
    opacity: 0.6,
  },
  createBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 12,
  },
  sectionLabel: {
    marginTop: 14,
    marginBottom: 8,
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
  },
  listWrap: {
    maxHeight: 280,
  },
  listItem: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 10,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  listItemMain: {
    flex: 1,
  },
  listName: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 13,
  },
  listMeta: {
    marginTop: 2,
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
  },
  emptyText: {
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
  },
});
