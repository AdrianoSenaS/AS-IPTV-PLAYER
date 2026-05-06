import { Platform } from 'react-native';

// Fallback seguro: sem expo-background-fetch instalado, nao registra job em segundo plano.
// O app continua funcionando e a atualizacao de recomendacoes ocorre no fluxo normal da interface.
export async function registerSmartRecommendationBackgroundTask() {
  if (Platform.OS === 'web') return false;
  return false;
}
