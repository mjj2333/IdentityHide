import ScreenShell from './ScreenShell';
import { useDocumentMeta } from '../hooks/useDocumentMeta';

/**
 * Privacy Policy page.
 *
 * Plain-language overview of how Redact.ID handles user data.
 * Should be reviewed by a qualified attorney before treating as a
 * binding legal document.
 */
export default function PrivacyScreen({ onBack }) {
  useDocumentMeta({
    title: 'Privacy Policy — Redact.ID',
    description: 'Privacy policy for Redact.ID. Face blur and metadata stripping run in your browser. Only AI tattoo removal sends your image to our server, used solely to return your result, never shared or used to train AI.',
    canonical: 'https://redactid.app/privacy',
    // Swap to /og/privacy.png once a per-route image is designed.
    ogImage: 'https://redactid.app/og-image.png',
  });
  return (
    <ScreenShell backAction={onBack} backLabel="Back">
      <div className="terms-container">
        <h1 className="terms-title">Privacy Policy</h1>
        <p className="terms-updated">Last updated: May 8, 2026</p>

        <section className="terms-section">
          <h2>1. Overview</h2>
          <p>
            Redact.ID is a privacy tool that helps you blur faces, remove
            tattoos, and strip metadata from photos. We designed it to handle
            your images with as little data exposure as possible. This policy
            explains exactly what happens to your data at each step.
          </p>
        </section>

        <section className="terms-section">
          <h2>2. In-Browser Processing</h2>
          <p>
            The following operations run entirely in your browser and{' '}
            <strong>never send your image to any server</strong>:
          </p>
          <ul>
            <li>Face detection and blurring</li>
            <li>Metadata extraction and stripping (EXIF, GPS, timestamps)</li>
            <li>Mask editing and adjustments</li>
            <li>Image export and format conversion</li>
          </ul>
          <p>
            These features use on-device machine learning models that run
            locally in your browser. Your original image stays on your device
            throughout.
          </p>
        </section>

        <section className="terms-section">
          <h2>3. Server Processing</h2>
          <p>
            Tattoo removal requires AI processing that cannot yet run in-browser.
            When you use this feature, your image and the mask you draw are sent
            to our processing server, where an AI model fills in the area you
            marked and returns the edited image to your browser.
          </p>
          <p>
            We use these images solely to generate and return your result. We do
            not sell them, share them with third parties, or use them to train
            AI models.
          </p>
        </section>

        <section className="terms-section">
          <h2>4. Local Storage</h2>
          <p>
            To let you resume interrupted work, Redact.ID stores a temporary
            copy of your in-progress session &mdash; your image, any mask edits
            and blur settings, and the face-detection coordinates used to draw
            those edits &mdash; in your browser&apos;s local storage
            (IndexedDB). This data:
          </p>
          <ul>
            <li>Never leaves your device</li>
            <li>Is automatically discarded after 4 hours</li>
            <li>Can be cleared at any time by clearing your browser storage</li>
          </ul>
        </section>

        <section className="terms-section">
          <h2>5. Analytics</h2>
          <p>
            We collect pseudonymous usage events to understand how the app is
            used and improve it. Each browser session is assigned a random
            session identifier; events are tied to that identifier and not to
            you personally. We do not set advertising cookies or build
            cross-site profiles. Collected data includes:
          </p>
          <ul>
            <li>Event names (e.g., image_uploaded, apply_clicked)</li>
            <li>Device class (mobile vs. desktop), screen size, browser</li>
            <li>The page you came from (HTTP Referer)</li>
            <li>Your IP address &mdash; transient, used only for rate-limiting and abuse prevention; not stored alongside long-term analytics</li>
          </ul>
          <p>
            Analytics never include your images, image content, EXIF data, or
            anything you draw or paint. We don&apos;t share or sell this data.
          </p>
        </section>

        <section className="terms-section">
          <h2>6. Cookies and Tracking</h2>
          <p>
            Redact.ID itself does not set tracking cookies on{' '}
            <code>redactid.app</code>. State on your device is stored in
            localStorage (theme, resolution preferences, your promo code if
            redeemed) and IndexedDB (the temporary in-progress session). No
            advertising pixels run on the main app.
          </p>
          <p>
            Some embedded third-party services may use their own cookies or
            storage on their own domains: the AppLixir rewarded-video ad
            player when you watch an ad, and Stripe Checkout if/when paid
            subscriptions launch. We don&apos;t control these and they&apos;re
            governed by their own privacy policies (see Section 7).
          </p>
        </section>

        <section className="terms-section">
          <h2>7. Third-Party Services</h2>
          <p>
            Redact.ID uses the following third-party services:
          </p>
          <ul>
            <li>
              <strong>Netlify</strong> &mdash; hosts the web application and
              serverless functions; access logs include IP addresses.{' '}
              <a href="https://www.netlify.com/privacy/" target="_blank" rel="noopener noreferrer">
                Netlify&apos;s Privacy Policy
              </a>.
            </li>
            <li>
              <strong>Cloudflare</strong> &mdash; provides the secure tunnel
              between your browser and our tattoo-removal processing server.{' '}
              <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener noreferrer">
                Cloudflare&apos;s Privacy Policy
              </a>.
            </li>
            <li>
              <strong>Supabase</strong> &mdash; database that stores
              pseudonymous analytics events, promo-code redemption counts,
              email-based subscription state, and feedback you submit.{' '}
              <a href="https://supabase.com/privacy" target="_blank" rel="noopener noreferrer">
                Supabase&apos;s Privacy Policy
              </a>.
            </li>
            <li>
              <strong>Sentry</strong> &mdash; crash and error reporting. Crash
              events include browser metadata and stack traces but are not tied
              to your identity unless you submit feedback that includes
              personal info.{' '}
              <a href="https://sentry.io/privacy/" target="_blank" rel="noopener noreferrer">
                Sentry&apos;s Privacy Policy
              </a>.
            </li>
            <li>
              <strong>AppLixir</strong> &mdash; rewarded-video ad provider.
              When you watch a rewarded ad to earn an extra tattoo-removal
              credit, AppLixir loads in an embedded player and may collect
              device and ad-interaction data.{' '}
              <a href="https://applixir.com/privacy-policy/" target="_blank" rel="noopener noreferrer">
                AppLixir&apos;s Privacy Policy
              </a>.
            </li>
            <li>
              <strong>Stripe</strong> &mdash; payment processor for
              subscriptions. Currently dormant; activates only if
              you start a checkout. When active, Stripe collects payment and
              billing details directly &mdash; we never see your card number.{' '}
              <a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer">
                Stripe&apos;s Privacy Policy
              </a>.
            </li>
          </ul>
        </section>

        <section className="terms-section">
          <h2>8. Children&apos;s Privacy</h2>
          <p>
            Redact.ID is not directed at children under the age of 18. We do
            not knowingly collect personal information from children. If you
            believe a child has provided us with personal information, please
            contact us through the{' '}
            <a href="/feedback">in-app feedback page</a> and we will take steps
            to remove it.
          </p>
        </section>

        <section className="terms-section">
          <h2>9. Data Retention</h2>
          <p>
            We retain as little data as possible:
          </p>
          <ul>
            <li>
              <strong>Images:</strong> Never stored on our servers. Processed
              in memory only and discarded immediately after the result is
              returned.
            </li>
            <li>
              <strong>Session data on your device:</strong> Stored in
              IndexedDB for up to 4 hours, then automatically discarded.
            </li>
            <li>
              <strong>Email and subscription state:</strong> Retained while
              your account is active. Deleted when you delete your account
              (see Section 10).
            </li>
            <li>
              <strong>Promo codes:</strong> Stored on your device in
              localStorage until you sign out. The code itself is shared and
              can be redeemed elsewhere; we keep a redemption counter on the
              server to know how widely it&apos;s been used.
            </li>
            <li>
              <strong>Analytics events:</strong> Pseudonymous events keyed by
              session ID, retained indefinitely for product improvement. Not
              tied to you personally.
            </li>
            <li>
              <strong>Feedback:</strong> Messages you submit are retained for
              product improvement. If you included contact info that matched
              your account email, that contact field is anonymized when you
              delete your account (the message body stays).
            </li>
            <li>
              <strong>Crash reports:</strong> Sentry retains crash events
              according to its own retention policy (typically 30&ndash;90
              days).
            </li>
          </ul>
        </section>

        <section className="terms-section">
          <h2>10. Your Rights and Account Deletion</h2>
          <p>
            You can delete your account and the data we hold about you at any
            time. The data deleted includes:
          </p>
          <ul>
            <li>Your email and subscription record (if any)</li>
            <li>Any active Stripe subscription, which we cancel via the Stripe API</li>
            <li>Promo-redemption rows associated with your email</li>
            <li>The contact field on any feedback you submitted (the message body is retained anonymously for product improvement)</li>
            <li>Local credentials on your current device (email, promo code, credits)</li>
          </ul>
          <p>
            <strong>To delete from inside the app:</strong> open Redact.ID, go
            to <em>Account</em>, and tap <em>Delete account</em>. Confirmation is
            required; the deletion is immediate and cannot be undone.
          </p>
          <p>
            <strong>To delete by email</strong> (e.g., if you have already
            uninstalled the app): write to{' '}
            <a href="mailto:drice233@gmail.com">drice233@gmail.com</a> from the
            email address associated with your account. We&apos;ll process the
            request within 30 days.
          </p>
          <p>
            You can also request a copy of the data we hold about you, or ask
            us to correct inaccurate data, by emailing the same address.
          </p>
          <p>
            Pseudonymous analytics events that aren&apos;t tied to your
            identity are not deleted (they cannot be linked back to you, so
            there&apos;s nothing to delete). Anonymized feedback message
            content remains in our improvement records.
          </p>
        </section>

        <section className="terms-section">
          <h2>11. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. When we do, we
            will update the &ldquo;Last updated&rdquo; date above. Material
            changes will be communicated through an in-app notice.
          </p>
        </section>

        <section className="terms-section">
          <h2>12. Contact</h2>
          <p>
            Questions about this Privacy Policy, or requests under Section 10:{' '}
            <a href="mailto:drice233@gmail.com">drice233@gmail.com</a>.
          </p>
        </section>
      </div>
    </ScreenShell>
  );
}
