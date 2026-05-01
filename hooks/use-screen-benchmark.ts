import { useEffect } from 'react';

import { recordScreenOpenTime } from '@/services/perf-benchmark';

const now = () => (globalThis.performance?.now?.() ?? Date.now());

export function useScreenBenchmark(screenName: string) {
  useEffect(() => {
    const start = now();

    const frame = requestAnimationFrame(() => {
      const duration = now() - start;
      console.log(`[perf] ${screenName} abriu em ${duration.toFixed(1)}ms`);
      void recordScreenOpenTime(screenName, duration);
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [screenName]);
}
