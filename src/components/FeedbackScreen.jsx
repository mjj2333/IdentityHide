import { useState } from 'react';
import ScreenShell from './ScreenShell';
import { apiUrl } from '../utils/api';

const CATEGORIES = [
  { value: 'bug', label: 'Bug / Error', icon: 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.008v.008H12v-.008Z' },
  { value: 'ux', label: 'UI / UX Issue', icon: 'M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917-3.286-.672Zm-7.518-.267A8.25 8.25 0 1 1 20.25 10.5M8.288 14.212A5.25 5.25 0 1 1 17.25 10.5' },
  { value: 'feature', label: 'Feature Request', icon: 'M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18' },
  { value: 'general', label: 'General Feedback', icon: 'M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z' },
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
      const res = await fetch(apiUrl('/.netlify/functions/feedback'), {
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
            <p>Your feedback is invaluable and will directly help us improve Redact.ID.</p>
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
        <h2 className="feedback-title">Feedback</h2>
        <p className="feedback-subtitle">Help us improve Redact.ID. All feedback is reviewed by the team.</p>

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
