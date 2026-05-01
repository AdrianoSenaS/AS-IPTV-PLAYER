import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackdrop } from '@/components/app-backdrop';
import { FeatureGate } from '@/components/feature-gate';
import { StreamingTheme } from '@/constants/streaming-theme';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { createUserList, deleteUserList, loadUserLists, renameUserList, UserList } from '@/services/user-lists';

export default function MinhasListasScreen() {
  const router = useRouter();
  const { hasFeature, loading: planLoading } = usePlanGate();
  const [lists, setLists] = useState<UserList[]>([]);
  const [search, setSearch] = useState('');
  const [newListName, setNewListName] = useState('');
  const [renamingId, setRenamingId] = useState('');
  const [renameValue, setRenameValue] = useState('');

  const refresh = async () => {
    setLists(await loadUserLists());
  };

  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) return lists;
    return lists.filter((item) => item.name.toLowerCase().includes(normalized));
  }, [lists, search]);

  const onCreateList = async () => {
    try {
      await createUserList(newListName);
      setNewListName('');
      await refresh();
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel criar a lista.'));
    }
  };

  const onDeleteList = (listId: string) => {
    Alert.alert('Excluir lista', 'Deseja remover esta lista?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Excluir',
        style: 'destructive',
        onPress: async () => {
          await deleteUserList(listId);
          await refresh();
        },
      },
    ]);
  };

  const onConfirmRename = async () => {
    try {
      await renameUserList(renamingId, renameValue);
      setRenamingId('');
      setRenameValue('');
      await refresh();
    } catch (error: any) {
      Alert.alert('Erro', String(error?.message || error || 'Nao foi possivel renomear.'));
    }
  };

  return (
    <FeatureGate feature="lists" locked={!planLoading && !hasFeature('lists')}>
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <AppBackdrop blurIntensity={28} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
        </TouchableOpacity>
        <View>
          <Text style={styles.kicker}>Colecao pessoal</Text>
          <Text style={styles.title}>Minhas listas</Text>
        </View>
        <View style={styles.iconBtn}>
          <MaterialIcons name="library-music" size={18} color={StreamingTheme.colors.textPrimary} />
        </View>
      </View>

      <View style={styles.createCard}>
        <Text style={styles.cardTitle}>Criar playlist</Text>
        <View style={styles.createRow}>
          <TextInput
            style={styles.input}
            value={newListName}
            onChangeText={setNewListName}
            placeholder="Ex: Maratonar no fim de semana"
            placeholderTextColor={StreamingTheme.colors.textMuted}
          />
          <TouchableOpacity
            style={[styles.createBtn, !newListName.trim() && styles.createBtnDisabled]}
            disabled={!newListName.trim()}
            onPress={onCreateList}>
            <MaterialIcons name="playlist-add" size={18} color={StreamingTheme.colors.textPrimary} />
            <Text style={styles.createBtnText}>Criar</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.searchWrap}>
        <MaterialIcons name="search" size={18} color={StreamingTheme.colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Buscar lista"
          placeholderTextColor={StreamingTheme.colors.textMuted}
        />
      </View>

      <Text style={styles.count}>{filtered.length} listas</Text>

        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          numColumns={2}
          contentContainerStyle={styles.listContent}
          columnWrapperStyle={styles.columnWrap}
          renderItem={({ item }) => {
          const isRenaming = renamingId === item.id;
          const previewTitle = item.items[0]?.title || 'Sua playlist ainda esta vazia';
          const previewSubtitle = item.items[1]?.title || 'Toque para abrir e adicionar filmes, series e TV';
          return (
            <TouchableOpacity
              style={styles.card}
              onPress={() => router.push(`/minha-lista-detalhe?listId=${encodeURIComponent(item.id)}` as any)}>
              <View style={styles.cardArt}>
                <MaterialIcons name="queue-music" size={26} color={StreamingTheme.colors.textPrimary} />
              </View>
              {isRenaming ? (
                <View style={styles.renameWrap}>
                  <TextInput
                    style={styles.renameInput}
                    value={renameValue}
                    onChangeText={setRenameValue}
                    placeholder="Novo nome"
                    placeholderTextColor={StreamingTheme.colors.textMuted}
                  />
                  <View style={styles.renameActions}>
                    <TouchableOpacity style={styles.renameAction} onPress={onConfirmRename}>
                      <MaterialIcons name="check" size={16} color={StreamingTheme.colors.textPrimary} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.renameAction}
                      onPress={() => {
                        setRenamingId('');
                        setRenameValue('');
                      }}>
                      <MaterialIcons name="close" size={16} color={StreamingTheme.colors.textPrimary} />
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <>
                  <Text style={styles.cardTitleMain} numberOfLines={2}>{item.name}</Text>
                  <Text style={styles.cardMeta}>{item.items.length} itens</Text>
                  <Text style={styles.previewTitle} numberOfLines={1}>{previewTitle}</Text>
                  <Text style={styles.previewSub} numberOfLines={2}>{previewSubtitle}</Text>
                  <View style={styles.cardActions}>
                    <TouchableOpacity
                      style={styles.miniBtn}
                      onPress={() => {
                        setRenamingId(item.id);
                        setRenameValue(item.name);
                      }}>
                      <MaterialIcons name="edit" size={16} color={StreamingTheme.colors.textPrimary} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.miniBtn} onPress={() => onDeleteList(item.id)}>
                      <MaterialIcons name="delete-outline" size={16} color={StreamingTheme.colors.textPrimary} />
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </TouchableOpacity>
          );
        }}
          ListEmptyComponent={
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>Nenhuma lista encontrada</Text>
              <Text style={styles.emptyText}>Crie sua primeira playlist para organizar conteudos como no Spotify.</Text>
            </View>
          }
        />
      </SafeAreaView>
    </FeatureGate>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kicker: {
    color: StreamingTheme.colors.accentAlt,
    fontWeight: '700',
    letterSpacing: 1,
    fontSize: 12,
    textAlign: 'center',
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
  },
  createCard: {
    marginTop: 14,
    marginHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 12,
  },
  cardTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  createRow: {
    marginTop: 8,
    flexDirection: 'row',
    gap: 8,
  },
  input: {
    flex: 1,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
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
  createBtnDisabled: { opacity: 0.6 },
  createBtnText: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 12,
  },
  searchWrap: {
    marginTop: 14,
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    borderRadius: 14,
    backgroundColor: StreamingTheme.colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
  },
  searchInput: { flex: 1, height: 48, color: StreamingTheme.colors.textPrimary },
  count: {
    paddingHorizontal: 16,
    marginTop: 12,
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
  },
  listContent: {
    padding: 16,
    paddingBottom: 120,
  },
  columnWrap: {
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  card: {
    width: '48%',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 12,
    minHeight: 208,
  },
  cardArt: {
    height: 86,
    borderRadius: 14,
    backgroundColor: 'rgba(255,59,48,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  cardTitleMain: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  cardMeta: {
    marginTop: 4,
    color: StreamingTheme.colors.accentAlt,
    fontSize: 11,
    fontWeight: '700',
  },
  previewTitle: {
    marginTop: 10,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  previewSub: {
    marginTop: 3,
    color: StreamingTheme.colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
  cardActions: {
    marginTop: 'auto',
    flexDirection: 'row',
    gap: 8,
  },
  miniBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  renameWrap: {
    flex: 1,
    justifyContent: 'center',
  },
  renameInput: {
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    paddingHorizontal: 10,
    color: StreamingTheme.colors.textPrimary,
  },
  renameActions: {
    marginTop: 8,
    flexDirection: 'row',
    gap: 8,
  },
  renameAction: {
    width: 34,
    height: 34,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCard: {
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 14,
  },
  emptyTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 14,
  },
  emptyText: {
    marginTop: 6,
    color: StreamingTheme.colors.textMuted,
    fontSize: 12,
  },
});
