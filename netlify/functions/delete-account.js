// User-initiated account deletion. Required by Google Play and Apple App
// Store policy (5.1.1.v on Apple's side): apps that allow account creation
// must also offer in-app account deletion. The user calls this from
// AccountScreen with their email and/or beta code; the function:
//
//   1. If email present: cancels EVERY subscription Stripe is still running
//      for that email (across all its Stripe customers — a repeat checkout
//      makes a new one each time, and the row only ever knew the latest),
//      deletes the `subscriptions` row, deletes any `beta_redemptions` row
//      keyed by that email (admin-granted access).
//
//   2. If only a beta code is present: nothing to delete server-side. Beta
//      codes are shared credentials (the same code can be used on multiple
//      devices) — the code itself stays in `beta_codes`. The client wipes
//      localStorage on success, ending this device's premium access without
//      revoking the code for anyone else.
//
// Each step is independent and best-effort: failing one shouldn't strand
// the rest. We always return 200 to the client when input is well-formed,
// because a partially-deleted user is still better than a stranded one.
// Real errors land in Sentry for forensics.
import { getStripe, getSupabase } from './_clients.js';
import { cancelAllSubscriptions } from './_subscriptionSync.js';
import { rateLimit, checkOrigin } from './rateLimit.js';
import { withSentry, captureException } from './_sentry.js';
import { withCors } from './_cors.js';

async function deleteAccountHandler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const og = checkOrigin(event);
  if (og.rejected) return og.response;

  // Aggressive rate limit — destructive endpoint, should never be high-volume
  // from a single IP. 5/min/IP also slows any abuse where someone discovers
  // a target email and hammers this endpoint.
  const rl = await rateLimit(event, 5);
  if (rl.limited) return rl.response;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();

  if (!email && !code) {
    return { statusCode: 400, body: 'Missing email or code' };
  }

  const sb = getSupabase();
  let cancelled = [];
  let failed = [];

  // Email path: full server-side cleanup.
  if (email) {
    // 1. Cancel, immediately, everything Stripe is still running for this
    // email. Asks Stripe rather than trusting the row: the row can be
    // missing or point at one of several subscriptions.
    if (process.env.STRIPE_SECRET_KEY) {
      try {
        ({ cancelled, failed } = await cancelAllSubscriptions(getStripe(), email));
        for (const f of failed) {
          console.warn('[delete-account] Stripe cancel failed:', f.id, f.error);
          captureException(new Error(f.error), { scope: 'delete_account.stripe_cancel', subscription: f.id });
        }
      } catch (err) {
        // Couldn't even list — report it and carry on with the rest.
        captureException(err, { scope: 'delete_account.stripe_list' });
      }
    }

    // 2. Delete subscriptions row.
    try {
      await sb.from('subscriptions').delete().eq('email', email);
    } catch (err) {
      captureException(err, { scope: 'delete_account.subscriptions_delete' });
    }

    // 3. Delete beta_redemptions rows keyed by this email (admin-granted
    // access).
    try {
      await sb.from('beta_redemptions').delete().eq('email', email);
    } catch (err) {
      captureException(err, { scope: 'delete_account.beta_redemptions_delete' });
    }

    // 4. Anonymize any feedback the user submitted with this email in the
    // contact field. We keep the feedback content (it's useful for product
    // decisions) but null out the PII so the row can no longer be linked
    // back to the user. Anything in `contact` other than this exact email
    // is left untouched (could be twitter handles, phone numbers, etc.).
    try {
      await sb.from('feedback').update({ contact: null }).eq('contact', email);
    } catch (err) {
      captureException(err, { scope: 'delete_account.feedback_anonymize' });
    }
  }

  // Code-only path is a no-op server-side. The client clears the code
  // from localStorage; the underlying beta_codes row stays usable for
  // anyone else who has the code.

  // `failed` lets the client tell the user their subscription is NOT gone
  // rather than promising it is.
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, cancelled, failed: failed.map((f) => f.id) }),
  };
}

export const handler = withCors(withSentry(deleteAccountHandler));
