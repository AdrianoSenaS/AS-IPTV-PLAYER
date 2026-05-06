import {
  Feather,
  MaterialCommunityIcons,
  MaterialIcons,
} from '@expo/vector-icons';

import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Linking,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PageLoader } from '@/components/page-loader';
import { AppBackdrop } from '@/components/app-backdrop';
import { StreamingTheme } from '@/constants/streaming-theme';

const faqData = [
  {
    id: '1',
    question: 'Como resolver travamentos?',
    answer: 'Reduza a qualidade para HD, troque para Wi-Fi 5G e limpe cache do app.',
  },
  {
    id: '2',
    question: 'Minha lista não carregou. O que fazer?',
    answer: 'Abra a tela de loading novamente para sincronizar e valide usuário e senha.',
  },
  {
    id: '3',
    question: 'Posso usar em mais de um dispositivo?',
    answer: 'Depende do plano do provedor. Consulte a quantidade de conexões simultâneas.',
  },
  {
    id: '4',
    question: 'Não encontro um canal específico',
    answer: 'Use busca por categoria e atualize os catálogos na tela de carregamento.',
  },
];

const contacts = [
  { id: 'w', label: 'WhatsApp', value: '+55 (67) 93500-4294', icon: 'whatsapp', color: '#29D163' },
  { id: 'e', label: 'Email', value: 'adryanosenasilva@gmail.com', icon: 'email-outline', color: '#FF6C6C' },
  { id: 'i', label: 'Instagram', value: '@adriano.sena.silva', icon: 'instagram', color: '#ff00dd' },
];

export default function AjudaScreen() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => setIsLoading(false), 260);
    return () => clearTimeout(timeout);
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return faqData;
    return faqData.filter((item) => {
      const query = search.toLowerCase();
      return item.question.toLowerCase().includes(query) || item.answer.toLowerCase().includes(query);
    });
  }, [search]);

  const onContact = (label: string, value: string) => {
    const url =
      label === 'WhatsApp'
        ? `https://wa.me/${value.replace(/\D/g, '')}`
        : label === 'Email'
          ? `mailto:${value}`
          : `https://instagram.com/${value.replace('@', '')}`;

    Linking.openURL(url).catch(() => Alert.alert('Erro', 'Não foi possível abrir o contato.'));
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AppBackdrop blurIntensity={28} />
      <PageLoader visible={isLoading} label="Carregando ajuda" />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
          </TouchableOpacity>
          <View>
            <Text style={styles.kicker}>Suporte</Text>
            <Text style={styles.title}>Central de ajuda</Text>
          </View>
        </View>

        <View style={styles.searchBox}>
          <Feather name="search" size={18} color={StreamingTheme.colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Buscar dúvida"
            placeholderTextColor={StreamingTheme.colors.textMuted}
            style={styles.searchInput}
          />
          {!!search && (
            <TouchableOpacity onPress={() => setSearch('')}>
              <MaterialIcons name="close" size={20} color={StreamingTheme.colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Perguntas frequentes</Text>
          {filtered.map((item) => {
            const opened = openId === item.id;
            return (
              <TouchableOpacity
                key={item.id}
                style={styles.faqCard}
                onPress={() => setOpenId(opened ? null : item.id)}
              >
                <View style={styles.faqHeader}>
                  <Text style={styles.faqQuestion}>{item.question}</Text>
                  <MaterialIcons
                    name={opened ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
                    size={22}
                    color={StreamingTheme.colors.textSecondary}
                  />
                </View>
                {opened && <Text style={styles.faqAnswer}>{item.answer}</Text>}
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Fale com o suporte</Text>
          {contacts.map((item) => (
            <TouchableOpacity
              key={item.id}
              style={styles.contactCard}
              onPress={() => onContact(item.label, item.value)}
            >
              <View style={[styles.contactIcon, { backgroundColor: item.color }]}>
                <MaterialCommunityIcons name={item.icon as any} size={18} color="#fff" />
              </View>
              <View style={styles.contactInfo}>
                <Text style={styles.contactLabel}>{item.label}</Text>
                <Text style={styles.contactValue}>{item.value}</Text>
              </View>
              <MaterialIcons name="chevron-right" size={22} color={StreamingTheme.colors.textMuted} />
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.tipCard}>
          <Text style={styles.tipTitle}>Dica rapida</Text>
          <Text style={styles.tipText}>
            Atualize os dados pelo loading sempre que trocar credenciais para evitar lista vazia.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: StreamingTheme.colors.background },
  content: { padding: 16, paddingBottom: 120 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  backBtn: {
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
  },
  title: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '900',
    fontSize: 24,
  },
  searchBox: {
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: StreamingTheme.colors.surface,
    borderRadius: 14,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchInput: {
    flex: 1,
    height: 48,
    color: StreamingTheme.colors.textPrimary,
  },
  section: {
    marginTop: 16,
    gap: 10,
  },
  sectionTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    fontSize: 18,
  },
  faqCard: {
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    borderRadius: 14,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 12,
  },
  faqHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  faqQuestion: {
    flex: 1,
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
  },
  faqAnswer: {
    color: StreamingTheme.colors.textSecondary,
    marginTop: 8,
    lineHeight: 20,
  },
  contactCard: {
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    borderRadius: 14,
    backgroundColor: StreamingTheme.colors.surface,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  contactIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactInfo: {
    flex: 1,
  },
  contactLabel: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '700',
  },
  contactValue: {
    color: StreamingTheme.colors.textSecondary,
    marginTop: 2,
    fontSize: 12,
  },
  tipCard: {
    marginTop: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: StreamingTheme.colors.border,
    backgroundColor: 'rgba(255,59,48,0.15)',
    padding: 14,
  },
  tipTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontWeight: '800',
    marginBottom: 6,
  },
  tipText: {
    color: StreamingTheme.colors.textSecondary,
    lineHeight: 20,
  },
});
