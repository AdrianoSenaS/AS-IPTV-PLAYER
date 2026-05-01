import AsyncStorage from '@react-native-async-storage/async-storage';

const PERF_SAMPLES_KEY = 'perf.benchmark.samples.v1';
const MAX_SAMPLES = 120;

export type PerfSample = {
  screen: string;
  durationMs: number;
  at: string;
};

function toSafeNumber(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export async function recordScreenOpenTime(screen: string, durationMs: number) {
  try {
    const raw = await AsyncStorage.getItem(PERF_SAMPLES_KEY);
    const parsed = raw ? (JSON.parse(raw) as PerfSample[]) : [];
    const safeList = Array.isArray(parsed) ? parsed : [];

    safeList.push({
      screen: String(screen || 'unknown'),
      durationMs: Math.max(0, Math.round(toSafeNumber(durationMs) * 10) / 10),
      at: new Date().toISOString(),
    });

    const trimmed = safeList.slice(-MAX_SAMPLES);
    await AsyncStorage.setItem(PERF_SAMPLES_KEY, JSON.stringify(trimmed));
  } catch {
    // Benchmark nao pode impactar o fluxo principal do app.
  }
}

export async function loadPerfSamples(): Promise<PerfSample[]> {
  try {
    const raw = await AsyncStorage.getItem(PERF_SAMPLES_KEY);
    const parsed = raw ? (JSON.parse(raw) as PerfSample[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function clearPerfSamples() {
  await AsyncStorage.removeItem(PERF_SAMPLES_KEY);
}
