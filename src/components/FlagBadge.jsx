import { isInpaintCompositeEnabled, isGrainMatchEnabled, isColourFitEnabled } from '../utils/featureFlags';
import '../styles/FlagBadge.css';

/**
 * Tiny on-screen marker shown ONLY while an opt-in feature flag is on (see
 * featureFlags.js). Flags persist per browser, so without this an A/B tester
 * can't tell which mode a result came from. Normal users never see it.
 */
export default function FlagBadge() {
  const active = [
    isColourFitEnabled() && 'COLORFIT',
    isInpaintCompositeEnabled() && 'COMPOSITE',
    isGrainMatchEnabled() && 'GRAIN',
  ].filter(Boolean);
  if (active.length === 0) return null;
  return (
    <div className="flag-badge" aria-hidden="true">
      {active.length === 1 ? `${active[0]} ON` : active.join(' + ')}
    </div>
  );
}
