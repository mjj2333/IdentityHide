import ScreenShell from './ScreenShell';

/**
 * Terms and Conditions page.
 *
 * This is a starting-point draft. Placeholders marked with [brackets] should
 * be reviewed and replaced by a qualified attorney before relying on this
 * document as a binding legal agreement.
 */
export default function TermsScreen({ onBack }) {
  return (
    <ScreenShell backAction={onBack} backLabel="Back">
      <div className="terms-container">
        <h1 className="terms-title">Terms and Conditions</h1>
        <p className="terms-updated">Last updated: April 8, 2026</p>

        <div className="terms-notice" role="note">
          This document is a draft. Before relying on it, please have a
          qualified attorney review it and confirm CSAM reporting obligations
          and biometric data laws in your operating region.
        </div>

        <section className="terms-section">
          <h2>1. Acceptance</h2>
          <p>
            By using IdentityHide (&ldquo;the Service&rdquo;), you agree to
            these Terms. If you don&apos;t agree, please don&apos;t use the
            Service.
          </p>
        </section>

        <section className="terms-section">
          <h2>2. What the Service Does</h2>
          <p>
            IdentityHide is a privacy tool that helps you blur faces and remove
            tattoos from images you upload. Face detection and initial
            processing run in your browser. Tattoo removal is processed on our
            servers and the image is deleted immediately after processing
            completes.
          </p>
        </section>

        <section className="terms-section">
          <h2>3. Eligibility</h2>
          <p>
            You must be at least 18 years old to use the Service. By using it,
            you confirm you meet this age requirement and have the legal
            capacity to accept these Terms.
          </p>
        </section>

        <section className="terms-section">
          <h2>4. Acceptable Use</h2>
          <p>You agree <strong>not</strong> to upload, process, or distribute via the Service:</p>
          <ul>
            <li>
              Child sexual abuse material (CSAM). This is strictly prohibited
              and will be reported to the National Center for Missing &amp;
              Exploited Children (NCMEC) and law enforcement as required by
              law.
            </li>
            <li>Images of minors in any sexualized, exploitative, or harmful context.</li>
            <li>Images of any person used to harass, stalk, defame, threaten, or intimidate them.</li>
            <li>
              Non-consensual intimate imagery (&ldquo;revenge porn&rdquo;) or
              any image shared without the depicted person&apos;s consent where
              consent is required by law.
            </li>
            <li>Images you do not own or lack the legal right to modify.</li>
            <li>Content intended to impersonate another person, commit fraud, or forge identification documents.</li>
            <li>Content used to evade legitimate law enforcement investigations or court orders.</li>
            <li>Any content that violates applicable local, national, or international law.</li>
          </ul>
          <p>
            You are solely responsible for the images you upload and how you
            use the output.
          </p>
        </section>

        <section className="terms-section">
          <h2>5. Your Content</h2>
          <p>
            You retain all rights to the images you upload. By using the
            Service, you grant us a limited, temporary license to process your
            images solely to deliver the requested output. We do not claim
            ownership of your content, and we do not use, share, sell, or
            train models on your images.
          </p>
        </section>

        <section className="terms-section">
          <h2>6. How Your Images Are Handled</h2>
          <ul>
            <li>
              <strong>In-browser processing:</strong> Face detection, metadata
              stripping, and mask editing run entirely in your browser. Those
              steps never send your image to our servers.
            </li>
            <li>
              <strong>Server processing:</strong> Tattoo removal sends the
              relevant image data to our processing server. The image is
              discarded from the server immediately after the result is
              returned.
            </li>
            <li>
              <strong>Local session storage:</strong> A temporary copy of your
              in-progress work is stored in your browser so you can resume if
              interrupted. This data stays on your device. Clearing your
              browser storage removes it.
            </li>
            <li>
              <strong>Analytics:</strong> We collect anonymous usage metrics
              (feature clicks, session counts) to improve the Service. This
              data is not linked to your identity or your images.
            </li>
          </ul>
        </section>

        <section className="terms-section">
          <h2>7. No Guarantee of Anonymity</h2>
          <p>
            IdentityHide is a privacy <strong>tool</strong>, not a guarantee.
            We do not warrant that processed images cannot be re-identified
            through other means, including but not limited to reverse image
            search, forensic analysis, distinctive body markings, background
            details, surrounding context, or metadata embedded elsewhere in
            the image. You are responsible for evaluating whether the Service
            meets your specific privacy needs before sharing or publishing any
            processed image.
          </p>
        </section>

        <section className="terms-section">
          <h2>8. No Warranty</h2>
          <p>
            The Service is provided <strong>&ldquo;AS IS&rdquo; and &ldquo;AS
            AVAILABLE&rdquo;</strong> without warranty of any kind, express or
            implied, including but not limited to warranties of
            merchantability, fitness for a particular purpose,
            non-infringement, or accuracy. We do not warrant that the Service
            will be uninterrupted, error-free, or produce any particular
            result.
          </p>
        </section>

        <section className="terms-section">
          <h2>9. Limitation of Liability</h2>
          <p>
            To the maximum extent permitted by law, IdentityHide and its
            affiliates shall not be liable for any indirect, incidental,
            consequential, special, exemplary, or punitive damages arising out
            of or related to your use of the Service. This includes, without
            limitation, damages for loss of privacy, loss of data,
            re-identification of subjects in processed images, or reputational
            harm. Our total liability shall not exceed the amount you paid to
            use the Service in the 12 months preceding the claim, or USD $50,
            whichever is greater.
          </p>
        </section>

        <section className="terms-section">
          <h2>10. Indemnification</h2>
          <p>
            You agree to indemnify and hold harmless IdentityHide from any
            claims, damages, losses, or expenses (including reasonable legal
            fees) arising out of your use of the Service, your violation of
            these Terms, or your violation of any rights of a third party.
          </p>
        </section>

        <section className="terms-section">
          <h2>11. Intellectual Property</h2>
          <p>
            The Service, including its software, user interface, design, and
            branding, is owned by IdentityHide and protected by applicable
            intellectual property laws. You may not copy, modify,
            reverse-engineer, decompile, or redistribute any part of the
            Service without our prior written permission.
          </p>
        </section>

        <section className="terms-section">
          <h2>12. Termination</h2>
          <p>
            We reserve the right to suspend or terminate your access to the
            Service at any time, with or without notice, for any reason,
            including but not limited to a violation of these Terms. Sections
            that by their nature should survive termination (including 4, 5,
            7, 8, 9, 10, and 13) will survive.
          </p>
        </section>

        <section className="terms-section">
          <h2>13. Changes to the Terms</h2>
          <p>
            We may update these Terms from time to time. When we do, we will
            update the &ldquo;Last updated&rdquo; date above. Material changes
            will be communicated through an in-app notice. Your continued use
            of the Service after changes take effect constitutes acceptance of
            the revised Terms.
          </p>
        </section>

        <section className="terms-section">
          <h2>14. Contact</h2>
          <p>
            Questions about these Terms? Contact us through the{' '}
            <a href="/feedback">in-app feedback page</a>.
          </p>
        </section>
      </div>
    </ScreenShell>
  );
}
