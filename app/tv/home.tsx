import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { AppBackdrop } from '@/components/app-backdrop';
import { StreamingTheme } from '@/constants/streaming-theme';

type HomeAction = {
  id: string;
  title: string;
  subtitle: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  to: string;
};

const ACTIONS: HomeAction[] = [
  {
    id: 'tv',
    title: 'TV',
    subtitle: 'Canais ao vivo e categorias',
    icon: 'live-tv',
    to: '/tv/lista?kind=live&title=TV',
  },
  {
    id: 'filmes',
    title: 'Filmes',
    subtitle: 'Catalogo local sem TMDB',
    icon: 'movie',
    to: '/tv/lista?kind=vod&title=Filmes',
  },
  {
    id: 'series',
    title: 'Series',
    subtitle: 'Temporadas e episodios',
    icon: 'smart-display',
    to: '/tv/lista?kind=series&title=Series',
  },
  {
    id: 'continuar',
    title: 'Continuar',
    subtitle: 'Retomar de onde parou',
    icon: 'play-circle-filled',
    to: '/tv/lista?kind=continue&title=Continuar',
  },
];

export default function TvHomeScreen() {
  const router = useRouter();
  const [focusedId, setFocusedId] = useState('tv');
  const { width } = useWindowDimensions();

  // Responsividade para TVs pequenas e Chromebooks
  let cardMinWidth = 140;
  let cardMaxWidth = 320;
  let cardPadding = 22;
  let cardTitleSize = 28;
  let cardSubtitleSize = 15;
  let cardIconSize = 48;
  let cardHeight = 220;
  let gridGap = 18;
  if (width <= 1280) {
    cardMinWidth = 90;
    cardMaxWidth = 180;
    cardPadding = 12;
    cardTitleSize = 18;
    cardSubtitleSize = 12;
    cardIconSize = 32;
    cardHeight = 120;
    gridGap = 10;
  }

  const cards = useMemo(() => ACTIONS, []);

  const useTVEventHandlerCompat = (require('react-native') as any).useTVEventHandler as
    | ((handler: (event: any) => void) => void)
    | undefined;

  useTVEventHandlerCompat?.((event: any) => {
    const type = String(event?.eventType || '').toLowerCase();
    if (type === 'playpause') {
      const selected = cards.find((card) => card.id === focusedId) || cards[0];
      router.push(selected.to as any);
    }
  });

  return (
    <SafeAreaView style={styles.container}>
      <AppBackdrop blurIntensity={24} />

      <View style={styles.header}>
        <Text style={styles.kicker}>Modo TV</Text>
        <Text style={styles.title}>AS Iptv Player</Text>
        <Text style={styles.subtitle}>Navegue com setas e OK do controle remoto.</Text>
      </View>

      <View style={[styles.grid, { gap: gridGap }]}> 
        {cards.map((card, index) => {
          const focused = focusedId === card.id;
          return (
            <Pressable
              key={card.id}
              onPress={() => router.push(card.to as any)}
              onFocus={() => setFocusedId(card.id)}
              style={({ pressed }) => [
                styles.card,
                {
                  minWidth: cardMinWidth,
                  maxWidth: cardMaxWidth,
                  height: cardHeight,
                },
                focused && styles.cardFocused,
                pressed && styles.cardPressed,
              ]}
              hasTVPreferredFocus={index === 0}
            >
              <LinearGradient colors={StreamingTheme.gradients.card} style={[styles.cardGradient, { paddingHorizontal: cardPadding, paddingVertical: cardPadding, minHeight: cardHeight }]}> 
                <View style={styles.iconWrap}>
                  <MaterialIcons name={card.icon} size={cardIconSize} color={StreamingTheme.colors.textPrimary} />
                </View>
                <Text style={[styles.cardTitle, { fontSize: cardTitleSize }]}>{card.title}</Text>
                <Text style={[styles.cardSubtitle, { fontSize: cardSubtitleSize }]}>{card.subtitle}</Text>
              </LinearGradient>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: StreamingTheme.colors.background,
    paddingHorizontal: 36,
    paddingTop: 20,
    paddingBottom: 28,
  },
  header: {
    marginBottom: 26,
  },
  kicker: {
    color: StreamingTheme.colors.accentAlt,
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  title: {
    marginTop: 6,
    color: StreamingTheme.colors.textPrimary,
    fontSize: 42,
    fontWeight: '900',
  },
  subtitle: {
    marginTop: 8,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 17,
  },
  grid: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 18,
    alignContent: 'flex-start',
  },
  card: {
    width: '48.5%',
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  cardFocused: {
    borderWidth: 5,
    borderColor: StreamingTheme.colors.accentAlt,
    transform: [{ scale: 1.02 }],
  },
  cardPressed: {
    opacity: 0.92,
  },
  cardGradient: {
    minHeight: 220,
    paddingVertical: 24,
    paddingHorizontal: 22,
    justifyContent: 'center',
  },
  iconWrap: {
    marginBottom: 14,
  },
  cardTitle: {
    color: StreamingTheme.colors.textPrimary,
    fontSize: 28,
    fontWeight: '900',
  },
  cardSubtitle: {
    marginTop: 8,
    color: StreamingTheme.colors.textSecondary,
    fontSize: 15,
    lineHeight: 22,
  },
});
