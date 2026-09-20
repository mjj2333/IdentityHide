import { isInpaintCompositeEnabled, isGrainMatchEnabled, isColourFitEnabled, isCleanFillEnabled, isMaskGrowEnabled } from '../utils/featureFlags';
import '../styles/FlagBadge.css';

/**
 * Tiny on-screen marker shown ONLY while this browser departs from the defaults
 * (see featureFlags.js): an experiment switched on, or a default switched off.
 * Flags persist per browser, so without this an A/B tester can't tell which
 * mode a result came from. Normal users never see it.
 */
export default function FlagBadge() {
  const changed = [
    !isCleanFillEnabled() && 'CLEANFILL OFF',
    isMaskGrowEnabled() && 'MASKGROW',
    !isColourFitEnabled() && 'COLORFIT OFF',
    isInpaintCompositeEnabled() && 'COMPOSITE',
    isGrainMatchEnabled() && 'GRAIN',
  ].filter(Boolean);
  if (changed.length === 0) return null;
  const loneExperiment = changed.length === 1 && !changed[0].endsWith(' OFF');
  return (
    <div className="flag-badge" aria-hidden="true">
      {loneExperiment ? `${changed[0]} ON` : changed.join(' + ')}
    </div>
  );
}
