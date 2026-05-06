import { MaterialIcons } from '@expo/vector-icons';

import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ScrollView, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackdrop } from '@/components/app-backdrop';
import { PageLoader } from '@/components/page-loader';
import { StreamingTheme } from '@/constants/streaming-theme';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { loadAccountSettings } from '@/services/account-settings';
import { loadUserSession } from '@/services/cloud-sync';

type HubState = {
	activeServerName: string;
	activeProfileName: string;
	accountName: string;
	accountEmail: string;
};

const emptyHub: HubState = {
	activeServerName: 'Não definido',
	activeProfileName: '-',
	accountName: 'Visitante',
	accountEmail: 'Sem login',
};

export default function ConfiguracoesHubScreen() {
	const router = useRouter();
	const { hasFeature, loading: planLoading } = usePlanGate();
	const [isLoading, setIsLoading] = useState(true);
	const [hub, setHub] = useState<HubState>(emptyHub);
	const hydratedOnceRef = useRef(false);

	const loadData = useCallback(async () => {
		if (!hydratedOnceRef.current) {
			setIsLoading(true);
		}
		try {
			const [settings, session] = await Promise.all([loadAccountSettings(), loadUserSession()]);
			const activeServer = settings.servers.find((item) => item.id === settings.activeServerId);
			const activeProfile = settings.profiles.find((item) => item.id === settings.activeProfileId);
			setHub({
				activeServerName: activeServer?.name || 'Não definido',
				activeProfileName: activeProfile?.name || '-',
				accountName: session?.user?.name || 'Visitante',
				accountEmail: session?.user?.email || 'Sem login',
			});
		} finally {
			hydratedOnceRef.current = true;
			setIsLoading(false);
		}
	}, []);

	useFocusEffect(
		useCallback(() => {
			loadData();
		}, [loadData])
	);

	const cards = useMemo(
		() => [
			{
				title: 'Conta do usuário',
				subtitle: 'Cadastro local, login e foto do perfil principal.',
				icon: 'person',
				route: '/configuracoes-conta',
				feature: null as string | null,
			},
			{
				title: 'Backup e sincronizacao',
				subtitle: 'Sincronize em nuvem local do app: filmes, séries, listas e servidores.',
				icon: 'backup',
				route: '/configuracoes-backup',
				feature: null as string | null,
			},
			{
				title: 'Servidores Xtream',
				subtitle: 'Gerencie varios servidores e troque com 1 toque.',
				icon: 'dns',
				route: '/configuracoes-servidores',
				feature: 'multi_server' as string | null,
			},
			{
				title: 'Perfis de usuario',
				subtitle: 'Crie perfis com PIN e modo infantil.',
				icon: 'groups',
				route: '/configuracoes-perfis',
				feature: 'multi_user' as string | null,
			},
			{
				title: 'Controle dos pais',
				subtitle: 'PIN mestre, bloqueio e proteção de configurações.',
				icon: 'shield',
				route: '/configuracoes-parental',
				feature: 'parental_controls' as string | null,
			},
			{
				title: 'IA e aprendizado',
				subtitle: 'Ative/desative o algoritmo e ajuste o filtro de aprendizado.',
				icon: 'auto-awesome',
				route: '/configuracoes-ia',
				feature: 'recommendation_algorithm' as string | null,
			},
			{
				title: 'Proxy de rede',
				subtitle: 'Gerencie ativação do proxy e confira se o roteamento está funcionando.',
				icon: 'vpn-lock',
				route: '/configuracoes-proxy',
				feature: 'network_proxy' as string | null,
			},
		],
		[]
	);

	return (
		<SafeAreaView style={styles.container}>
			<StatusBar barStyle="light-content" />
			<AppBackdrop blurIntensity={28} />
			<PageLoader visible={isLoading} label="Carregando configurações" />

			<ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
				<View style={styles.headerRow}>
					<TouchableOpacity style={styles.iconBtn} onPress={() => router.back()}>
						<MaterialIcons name="arrow-back" size={22} color={StreamingTheme.colors.textPrimary} />
					</TouchableOpacity>
					<View style={styles.headerTextWrap}>
						<Text style={styles.kicker}>PAINEL PREMIUM</Text>
						<Text style={styles.title}>Configurações</Text>
					</View>
					<View style={styles.iconBtn} />
				</View>

				<View style={styles.heroCard}>
					<Text style={styles.heroTitle}>{hub.accountName}</Text>
					<Text style={styles.heroSub}>{hub.accountEmail}</Text>
					<View style={styles.heroGrid}>
						<View style={styles.heroItem}>
							<Text style={styles.heroLabel}>Servidor ativo</Text>
							<Text style={styles.heroValue}>{hub.activeServerName}</Text>
						</View>
						<View style={styles.heroItem}>
							<Text style={styles.heroLabel}>Perfil ativo</Text>
							<Text style={styles.heroValue}>{hub.activeProfileName}</Text>
						</View>
					</View>
				</View>

				{cards.map((card) => {
					const cardLocked = !planLoading && !!card.feature && !hasFeature(card.feature as any);
					return (
						<TouchableOpacity
							key={card.title}
							style={[styles.card, cardLocked && styles.cardLocked]}
							onPress={() => {
								if (!planLoading && cardLocked && card.feature) {
									router.push({ pathname: '/assinar', params: { feature: card.feature } } as any);
									return;
								}
								router.push(card.route as any);
							}}>
							<View style={[styles.cardIcon, cardLocked && styles.cardIconLocked]}>
								<MaterialIcons name={card.icon as any} size={22} color={cardLocked ? StreamingTheme.colors.textMuted : StreamingTheme.colors.textPrimary} />
							</View>
							<View style={styles.cardTextWrap}>
								<Text style={[styles.cardTitle, cardLocked && styles.cardTitleLocked]}>{card.title}</Text>
								<Text style={styles.cardSub}>
									{cardLocked ? 'Disponível com plano superior — toque para ver detalhes' : card.subtitle}
								</Text>
							</View>
							{cardLocked
								? <MaterialIcons name="lock" size={20} color={StreamingTheme.colors.textMuted} />
								: <MaterialIcons name="chevron-right" size={24} color={StreamingTheme.colors.textMuted} />
							}
						</TouchableOpacity>
					);
				})}
			</ScrollView>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: StreamingTheme.colors.background,
	},
	content: {
		padding: 16,
		paddingBottom: 120,
		gap: 12,
	},
	headerRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 10,
	},
	iconBtn: {
		width: 42,
		height: 42,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: StreamingTheme.colors.border,
		backgroundColor: StreamingTheme.colors.surface,
		alignItems: 'center',
		justifyContent: 'center',
	},
	headerTextWrap: {
		flex: 1,
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
		marginTop: 2,
	},
	heroCard: {
		borderRadius: 18,
		borderWidth: 1,
		borderColor: 'rgba(255,255,255,0.18)',
		backgroundColor: 'rgba(15,20,36,0.88)',
		padding: 14,
		gap: 6,
	},
	heroTitle: {
		color: StreamingTheme.colors.textPrimary,
		fontWeight: '900',
		fontSize: 20,
	},
	heroSub: {
		color: StreamingTheme.colors.textSecondary,
		fontSize: 13,
	},
	heroGrid: {
		marginTop: 6,
		flexDirection: 'row',
		gap: 8,
	},
	heroItem: {
		flex: 1,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: StreamingTheme.colors.border,
		backgroundColor: 'rgba(255,255,255,0.04)',
		padding: 10,
		gap: 3,
	},
	heroLabel: {
		color: StreamingTheme.colors.textMuted,
		fontSize: 11,
		fontWeight: '700',
	},
	heroValue: {
		color: StreamingTheme.colors.textPrimary,
		fontSize: 13,
		fontWeight: '800',
	},
	card: {
		borderRadius: 16,
		borderWidth: 1,
		borderColor: StreamingTheme.colors.border,
		backgroundColor: 'rgba(18,24,40,0.9)',
		padding: 12,
		flexDirection: 'row',
		alignItems: 'center',
		gap: 10,
	},
	cardIcon: {
		width: 44,
		height: 44,
		borderRadius: 13,
		borderWidth: 1,
		borderColor: 'rgba(255,59,48,0.42)',
		backgroundColor: 'rgba(255,59,48,0.2)',
		alignItems: 'center',
		justifyContent: 'center',
	},
	cardTextWrap: {
		flex: 1,
		gap: 2,
	},
	cardTitle: {
		color: StreamingTheme.colors.textPrimary,
		fontSize: 15,
		fontWeight: '900',
	},
	cardTitleLocked: {
		color: StreamingTheme.colors.textMuted,
	},
	cardLocked: {
		opacity: 0.65,
		borderColor: 'rgba(255,255,255,0.07)',
	},
	cardIconLocked: {
		borderColor: 'rgba(168,178,209,0.2)',
		backgroundColor: 'rgba(168,178,209,0.06)',
	},
	cardSub: {
		color: StreamingTheme.colors.textMuted,
		fontSize: 12,
	},
});
