/**
 * Gerencia sessão global de Cast para permitir navegação enquanto transmite
 * Mantém estado do Cast ativo mesmo quando usuário navega pelas telas
 */

let globalCastState = {
  isActive: false,
  url: '',
  title: '',
  subtitle: '',
  mode: 'movie' as 'movie' | 'series' | 'live',
  contentId: '',
  startPositionMs: 0,
};

let globalCastListeners: ((state: typeof globalCastState) => void)[] = [];

export function setGlobalCastState(newState: Partial<typeof globalCastState>) {
  globalCastState = { ...globalCastState, ...newState };
  notifyListeners();
}

export function getGlobalCastState() {
  return { ...globalCastState };
}

export function subscribeToGlobalCastState(listener: (state: typeof globalCastState) => void) {
  globalCastListeners.push(listener);
  return () => {
    globalCastListeners = globalCastListeners.filter((l) => l !== listener);
  };
}

function notifyListeners() {
  globalCastListeners.forEach((l) => l(globalCastState));
}

export function clearGlobalCastState() {
  setGlobalCastState({
    isActive: false,
    url: '',
    title: '',
    subtitle: '',
    contentId: '',
    startPositionMs: 0,
  });
}
