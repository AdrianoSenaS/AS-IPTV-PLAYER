import { useEffect, useState } from 'react';
import { Feature, getActivePlan, Plan } from '@/services/subscription';

/**
 * Hook que retorna o plano ativo e um helper para verificar features.
 * Recarrega sempre que o componente monta.
 */
export function usePlanGate() {
  const [plan, setPlan] = useState<Plan | null>(null);

  useEffect(() => {
    getActivePlan().then(setPlan);
  }, []);

  const hasFeature = (feature: Feature): boolean => {
    if (!plan) return false;
    return plan.features.includes(feature);
  };

  const isFree = plan?.id === 'free';

  return { plan, hasFeature, isFree, loading: plan === null };
}
