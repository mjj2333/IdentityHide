import { useState } from 'react';
import ScreenShell from './ScreenShell';

const CATEGORIES = [
  { value: 'bug', label: 'Bug / Error', icon: 'M12 9v2m0 4h.01M5.07 19H19a2 2 0 0 0 1.75-2.96l-7-12a2 2 0 0 0-3.5 0l-7 12A2 2 0 0 0 5.07 19z' },
  { value: 'ux', label: 'UI / UX Issue', icon: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z' },
  { value: 'feature', label: 'Feature Request', icon: 'M12 2v4m0 12v4m-7-7H1m22 0h-4m-2.64-6.36l-2.83 2.83m9.9 9.9l-2.83-2.83M6.34 6.34L3.51 3.51m9.9 9.9l-2.83 2.83' },
  { value: 'general', label: 'General Feedback', icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
];

const SEVERITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const DETAIL_PROMPTS = {
  bug: 'What happened? What did you expect to happen instead?',
  ux: 'What felt confusing, awkward, or hard to find? Where in the app?',
  feature: 'Describe the feature and how it would improve your workflow.',
  general: 'Share any thoughts, impressions, or suggestions.',
};

const STEPS_PLACEHOLDER = '1. Opened the app\n2. Uploaded an image\n3. Tapped on...\n4. The error appeared';

function getDeviceInfo() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const touch = 'ontouchstart' in window;
  const mobile = /Mobi|Android/i.test(navigator.userAgent);
  return `${w}x${h}, ${touch ? 'touch' : 'pointer'}, ${mobile ? 'mobile' : 'desktop'}`;
}

export default function FeedbackScreen({ onBack }) {
  const [category, setCategory] = useState('');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [steps, setSteps] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [contact, setContact] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const showSeverity = category === 'bug' || category === 'ux';
  const showSteps = category === 'bug';

  const handleSubmit = async () => {
    if (!category) {
      setError('Please select a feedback category.');
      return;
    }
    if (summary.trim().length < 3) {
      setError('Please write a short summary.');
      return;
    }
    if (details.trim().length < 10) {
      setError('Please provide more detail (at least a couple sentences).');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch('/.netlify/functions/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          summary: summary.trim(),
          details: details.trim(),
          steps: showSteps ? steps.trim() || null : null,
          severity: showSeverity ? severity : null,
          contact: contact.trim() || null,
          device_info: getDeviceInfo(),
        }),
      });
      if (!res.ok) throw new Error('Submit failed');
      setSubmitted(true);
    } catch {
      setError('Failed to submit. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <ScreenShell backAction={onBack} backLabel="Back">
        <div className="feedback-container">
          <div className="feedback-success">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <h2>Thank you!</h2>
            <p>Your feedback is invaluable and will directly help us improve IdentityHide.</p>
            <div className="feedback-success-actions">
              <button className="btn btn-primary" onClick={() => {
                setSubmitted(false);
                setCategory('');
                setSummary('');
                setDetails('');
                setSteps('');
                setSeverity('medium');
                setContact('');
              }}>Submit More Feedback</button>
              <button className="btn btn-ghost" onClick={onBack}>Back to App</button>
            </div>
          </div>
        </div>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell backAction={onBack} backLabel="Back">
      <div className="feedback-container">
        <h2 className="feedback-title">Beta Feedback</h2>
        <p className="feedback-subtitle">Help us improve IdentityHide. All feedback is reviewed by the team.</p>

        <div className="feedback-section">
          <div id="feedback-category-label" className="feedback-label">What type of feedback?</div>
          <div className="feedback-categories" role="group" aria-labelledby="feedback-category-label">
            {CATEGORIES.map(cat => (
              <button
                key={cat.value}
                className={`feedback-cat-btn${category === cat.value ? ' active' : ''}`}
                onClick={() => setCategory(cat.value)}
                aria-pressed={category === cat.value}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d={cat.icon} />
                </svg>
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {category && (
          <>
            <div className="feedback-section">
              <label className="feedback-label" htmlFor="feedback-summary">Summary</label>
              <input
                id="feedback-summary"
                className="feedback-input"
                type="text"
                placeholder={category === 'bug' ? 'e.g. App crashes when uploading large PNG' : category === 'ux' ? 'e.g. Hard to find the blur strength slider' : category === 'feature' ? 'e.g. Batch processing for multiple images' : 'Short description'}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                maxLength={200}
              />
            </div>

            <div className="feedback-section">
              <label className="feedback-label" htmlFor="feedback-details">Details</label>
              <textarea
                id="feedback-details"
                className="feedback-textarea"
                placeholder={DETAIL_PROMPTS[category]}
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                maxLength={3000}
                rows={5}
              />
            </div>

            {showSteps && (
              <div className="feedback-section">
                <label className="feedback-label" htmlFor="feedback-steps">Steps to Reproduce <span className="feedback-optional">(optional)</span></label>
                <textarea
                  id="feedback-steps"
                  className="feedback-textarea"
                  placeholder={STEPS_PLACEHOLDER}
                  value={steps}
                  onChange={(e) => setSteps(e.target.value)}
                  maxLength={2000}
                  rows={4}
                />
              </div>
            )}

            {showSeverity && (
              <div className="feedback-section">
                <div id="feedback-severity-label" className="feedback-label">Severity</div>
                <div className="feedback-severity" role="group" aria-labelledby="feedback-severity-label">
                  {SEVERITIES.map(s => (
                    <button
                      key={s.value}
                      className={`feedback-sev-btn${severity === s.value ? ' active' : ''} sev-${s.value}`}
                      onClick={() => setSeverity(s.value)}
                      aria-pressed={severity === s.value}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="feedback-section">
              <label className="feedback-label" htmlFor="feedback-contact">Contact <span className="feedback-optional">(optional, for follow-up)</span></label>
              <input
                id="feedback-contact"
                className="feedback-input"
                type="text"
                placeholder="Email, name, or username"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                maxLength={200}
              />
            </div>

            {error && <p className="feedback-error">{error}</p>}

            <button
              className="btn btn-primary feedback-submit"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? 'Submitting...' : 'Submit Feedback'}
            </button>
          </>
        )}
      </div>
    </ScreenShell>
  );
}
