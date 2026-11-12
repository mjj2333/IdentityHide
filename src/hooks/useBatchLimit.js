import { useEffect, useState } from 'react';
import { useEntitlement } from '../context/EntitlementContext';
import { isAdFreeBuild } from '../utils/buildChannel';

// Photos per batch. Free users get 3. Premium, and testers on a TestFlight
// build (which can't buy Premium in the app yet), get 20, the most an iPhone
// handles comfortably in one batch.
export const FREE_BATCH_LIMIT = 3;
export const FULL_BATCH_LIMIT = 20;

export function useBatchLimit() {
  const { premium } = useEntitlement();
  const [testerBuild, setTesterBuild] = useState(false);

  useEffect(() => {
    let live = true;
    isAdFreeBuild().then((v) => { if (live) setTesterBuild(v); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const full = premium || testerBuild;
  return { limit: full ? FULL_BATCH_LIMIT : FREE_BATCH_LIMIT, full };
}
