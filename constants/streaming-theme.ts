export const StreamingTheme = {
  colors: {
    background: '#07090F',
    backgroundSoft: '#101525',
    surface: '#161B2E',
    surfaceAlt: '#1C2340',
    border: 'rgba(255,255,255,0.12)',
    textPrimary: '#F7F9FF',
    textSecondary: '#A8B2D1',
    textMuted: '#7F89A8',
    accent: '#FF3B30',
    accentAlt: '#FF8F3A',
    success: '#2CD07F',
    warning: '#FFC857',
    info: '#5DA9FF',
  },
  gradients: {
    hero: ['#1E0E2F', '#0D1A38', '#07090F'] as const,
    accent: ['#FF3B30', '#FF8F3A'] as const,
    card: ['rgba(255,255,255,0.16)', 'rgba(255,255,255,0.06)'] as const,
  },
  radius: {
    sm: 10,
    md: 16,
    lg: 24,
    xl: 30,
  },
  spacing: {
    xs: 6,
    sm: 10,
    md: 16,
    lg: 22,
    xl: 30,
  },
};

export const glassCard = {
  backgroundColor: 'rgba(255,255,255,0.07)',
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.12)',
};
