import { useEffect, useState } from 'react';
import '../styles/OfflineBanner.css';

/**
 * Top-of-viewport banner shown whenever the browser reports no network.
 *
 * Face blur + metadata stripping run entirely locally, so the app stays
 * usable offline. Tattoo removal (ComfyUI tunnel) and subscription /
 * entitlement lookups (Stripe + Supabase) can't complete — the banner
 * warns the user proactively instead of letting them discover the failure
 * the next time they tap Apply.
 *
 * Auto-shows on `offline` event, auto-hides on `online`. No dismiss
 * affordance: the banner represents a live condition, not a notification.
 */
export default function OfflineBanner() {
  const [online, setOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (online) return null;

  return (
    <div className="offline-banner" role="status" aria-live="polite">
      <svg className="offline-banner-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.008v.008H12v-.008Z" />
      </svg>
      <span className="offline-banner-body">
        Offline &middot; face blur still works, tattoo removal &amp; subscriptions need internet
      </span>
    </div>
  );
}
