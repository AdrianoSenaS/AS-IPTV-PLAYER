export type MiniPlayerState = {
  mode: string;
  title: string;
  url: string;
  contentId?: string;
  seriesId?: string;
  playlistKey?: string;
  playlistIndex?: number;
  positionMs?: number;
};

type MiniPlayerListener = (state: MiniPlayerState | null) => void;

let currentMiniPlayerState: MiniPlayerState | null = null;
const listeners = new Set<MiniPlayerListener>();

const notify = () => {
  listeners.forEach((listener) => listener(currentMiniPlayerState));
};

export const getMiniPlayerState = () => currentMiniPlayerState;

export const setMiniPlayerState = (
  nextState:
    | MiniPlayerState
    | null
    | ((prevState: MiniPlayerState | null) => MiniPlayerState | null)
) => {
  currentMiniPlayerState =
    typeof nextState === 'function'
      ? (nextState as (prevState: MiniPlayerState | null) => MiniPlayerState | null)(currentMiniPlayerState)
      : nextState;
  notify();
};

export const clearMiniPlayerState = () => {
  currentMiniPlayerState = null;
  notify();
};

export const subscribeMiniPlayer = (listener: MiniPlayerListener) => {
  listeners.add(listener);
  listener(currentMiniPlayerState);
  return () => {
    listeners.delete(listener);
  };
};
