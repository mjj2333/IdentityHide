import ScreenShell from './ScreenShell';

/**
 * Privacy Policy page.
 *
 * Plain-language overview of how IdentityHide handles user data.
 * Should be reviewed by a qualified attorney before treating as a
 * binding legal document.
 */
export default function PrivacyScreen({ onBack }) {
  return (
    <ScreenShell backAction={onBack} backLabel="Back">
      <div className="terms-container">
        <h1 className="terms-title">Privacy Policy</h1>
        <p className="terms-updated">Last updated: April 9, 2026</p>

        <div className="terms-notice" role="note">
          This document is a draft. Please have a qualified attorney review it
          before relying on it as a binding privacy policy.
        </div>

        <section className="terms-section">
          <h2>1. Overview</h2>
          <p>
            IdentityHide is a privacy tool that helps you blur faces, remove
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
            When you use this feature, the relevant portion of your image is sent
            to our processing server. <strong>Your image is processed in memory
            and is never written to disk or stored on the server.</strong> Once
            the result is returned to your browser, no copy remains on our
            infrastructure.
          </p>
          <p>
            We do not retain, log, cache, or use your images for any purpose
            beyond delivering the immediate processing result back to you.
          </p>
        </section>

        <section className="terms-section">
          <h2>4. Local Storage</h2>
          <p>
            To let you resume interrupted work, IdentityHide stores a temporary
            copy of your in-progress session in your browser&apos;s local storage
            (IndexedDB). This data:
          </p>
          <ul>
            <li>Never leaves your device</li>
            <li>Is automatically discarded after 24 hours</li>
            <li>Can be cleared at any time by clearing your browser storage</li>
          </ul>
        </section>

        <section className="terms-section">
          <h2>5. Analytics</h2>
          <p>
            We collect anonymous usage metrics to understand how the app is used
            and improve it. This includes events like feature clicks, session
            counts, and general device information (mobile vs. desktop, screen
            size). This data:
          </p>
          <ul>
            <li>Is not linked to your identity</li>
            <li>Does not include your images or any image content</li>
            <li>Does not include IP addresses or precise location</li>
            <li>Is not shared with or sold to third parties</li>
          </ul>
        </section>

        <section className="terms-section">
          <h2>6. Cookies and Tracking</h2>
          <p>
            IdentityHide does not use cookies. We do not use third-party
            trackers, advertising pixels, or fingerprinting techniques. The only
            data stored in your browser is your app preferences (such as theme
            and resolution settings) and the temporary session data described
            above.
          </p>
        </section>

        <section className="terms-section">
          <h2>7. Third-Party Services</h2>
          <p>
            IdentityHide uses the following third-party services:
          </p>
          <ul>
            <li>
              <strong>Netlify</strong> &mdash; hosts the web application and
              serverless functions. Subject to{' '}
              <a href="https://www.netlify.com/privacy/" target="_blank" rel="noopener noreferrer">
                Netlify&apos;s Privacy Policy
              </a>.
            </li>
            <li>
              <strong>Cloudflare</strong> &mdash; provides the secure tunnel for
              server-side processing. Subject to{' '}
              <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener noreferrer">
                Cloudflare&apos;s Privacy Policy
              </a>.
            </li>
          </ul>
          <p>
            No other third-party services receive your data.
          </p>
        </section>

        <section className="terms-section">
          <h2>8. Children&apos;s Privacy</h2>
          <p>
            IdentityHide is not directed at children under the age of 18. We do
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
              <strong>Images:</strong> Never stored on our servers. Processed in
              memory only and discarded immediately.
            </li>
            <li>
              <strong>Session data:</strong> Stored locally on your device for up
              to 24 hours, then automatically discarded.
            </li>
            <li>
              <strong>Analytics:</strong> Aggregated, anonymous metrics retained
              for product improvement.
            </li>
            <li>
              <strong>Feedback:</strong> Messages you voluntarily submit through
              the feedback form are retained to help us improve the service.
            </li>
          </ul>
        </section>

        <section className="terms-section">
          <h2>10. Your Rights</h2>
          <p>
            Because we don&apos;t collect personal information or store your
            images, there is generally no personal data for us to provide,
            correct, or delete. If you have submitted feedback and would like it
            removed, contact us through the{' '}
            <a href="/feedback">in-app feedback page</a>.
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
            Questions about this Privacy Policy? Contact us through the{' '}
            <a href="/feedback">in-app feedback page</a>.
          </p>
        </section>
      </div>
    </ScreenShell>
  );
}
