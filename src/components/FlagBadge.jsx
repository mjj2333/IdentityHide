import { isInpaintCompositeEnabled } from '../utils/featureFlags';
import '../styles/FlagBadge.css';

/**
 * Tiny on-screen marker shown ONLY while an opt-in feature flag is on (see
 * featureFlags.js). Flags persist per browser, so without this an A/B tester
 * can't tell which mode a result came from. Normal users never see it.
 */
export default function FlagBadge() {
  if (!isInpaintCompositeEnabled()) return null;
  return <div className="flag-badge" aria-hidden="true">COMPOSITE ON</div>;
}
