import { useState, useEffect, useCallback, useRef } from 'react';
import ConfirmModal from './ConfirmModal';

const EVENT_LABELS = {
  app_loaded: 'App Loaded',
  image_uploaded: 'Image Uploaded',
  mask_editor_entered: 'Mask Editor',
  apply_clicked: 'Apply Clicked',
  skip_clicked: 'Skip Clicked',
  review_entered: 'Review Screen',
  export_completed: 'Export Completed',
  tattoo_mask_painted: 'Tattoo Mask Painted',
  face_blur_configured: 'Face Blur Configured',
  blur_mode_changed: 'Blur Mode Changed',
  comfyui_completed: 'ComfyUI Completed',
  comfyui_failed: 'ComfyUI Failed',
  edit_masks_revisited: 'Edit Masks Revisited',
  start_over: 'Process Another Image',
};

const FUNNEL_ORDER = [
  'app_loaded', 'image_uploaded', 'mask_editor_entered',
  'apply_clicked', 'review_entered', 'export_completed',
];

function formatEvent(key) {
  return EVENT_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Single writer for the admin session token. sessionStorage is the canonical
// store; React state mirrors it for re-render purposes only. Always go through
// these helpers so the two can't drift.
const SESSION_KEY = 'admin_token';

export default function AdminDashboard({ onBack }) {
  const [password, setPassword] = useState('');
  const [sessionToken, setSessionTokenState] = useState(() => sessionStorage.getItem(SESSION_KEY) || '');
  const setSessionToken = useCallback((token) => {
    if (token) {
      sessionStorage.setItem(SESSION_KEY, token);
    } else {
      sessionStorage.removeItem(SESSION_KEY);
    }
    setSessionTokenState(token || '');
  }, []);
  // `authed` is derived from token presence — no separate setter, no drift.
  const authed = !!sessionToken;
  const [data, setData] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [chartMode, setChartMode] = useState('events');
  const [pendingDeleteId, setPendingDeleteId] = useState(null);

  const deleteFeedback = useCallback(async (id) => {
    try {
      const res = await fetch('/.netlify/functions/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
        body: JSON.stringify({ action: 'delete', id }),
      });
      if (res.ok) {
        setFeedback(prev => prev ? prev.filter(fb => fb.id !== id) : prev);
      } else {
        setError('Failed to delete feedback');
      }
    } catch (err) {
      setError('Failed to delete feedback: ' + err.message);
    } finally {
      setPendingDeleteId(null);
    }
  }, [sessionToken]);

  const fetchStats = useCallback(async (pw) => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, fbRes] = await Promise.all([
        fetch('/.netlify/functions/admin-stats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pw}` },
        }),
        fetch('/.netlify/functions/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pw}` },
          body: JSON.stringify({ action: 'list' }),
        }),
      ]);
      if (statsRes.status === 401) {
        setSessionToken('');
        setError('Invalid password');
        return;
      }
      if (!statsRes.ok) throw new Error(`Server error ${statsRes.status}`);
      const json = await statsRes.json();
      setData(json);
      if (fbRes.ok) {
        setFeedback(await fbRes.json());
      }
      setSessionToken(pw);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authed && sessionToken) fetchStats(sessionToken);
  }, []);

  const handleLogin = (e) => {
    e.preventDefault();
    fetchStats(password);
  };

  if (authed && !data && loading) {
    return (
      <div className="admin-dashboard">
        <div className="admin-login">
          <h2>Loading...</h2>
        </div>
      </div>
    );
  }

  if (!authed || !data) {
    return (
      <div className="admin-dashboard">
        <div className="admin-login">
          <h2>Admin Dashboard</h2>
          <form onSubmit={handleLogin}>
            <input
              type="password"
              placeholder="Password"
              aria-label="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              autoFocus
            />
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Loading...' : 'Login'}
            </button>
          </form>
          {error && <p className="admin-error">{error}</p>}
        </div>
      </div>
    );
  }

  const { periods, funnel, daily, features, prev_periods } = data;
  const maxDaily = Math.max(...daily.map(d => chartMode === 'sessions' ? d.sessions : d.events), 1);
  const funnelMax = Math.max(...Object.values(funnel), 1);

  function trendIndicator(current, previous, label) {
    if (!previous || previous === 0) return null;
    const pct = Math.round(((current - previous) / previous) * 100);
    if (pct === 0) return null;
    const up = pct > 0;
    const direction = up ? 'up' : 'down';
    return (
      <span
        className={`admin-summary-trend ${up ? 'trend-up' : 'trend-down'}`}
        aria-label={`${direction} ${Math.abs(pct)} percent${label ? ` ${label}` : ''}`}
      >
        <span aria-hidden="true">{up ? '\u2191' : '\u2193'}</span> {Math.abs(pct)}%{label && <span className="trend-label"> {label}</span>}
      </span>
    );
  }

  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <h2>Analytics</h2>
        <div className="admin-header-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => { onBack ? onBack() : window.location.href = '/'; }}>
            Back to App
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => fetchStats(sessionToken)} disabled={loading}>
            {loading ? '...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Compact summary row */}
      <div className="admin-summary-row">
        {['24h', '7d', '30d'].map((period) => (
          <div key={period} className="admin-summary-item">
            <span className="admin-summary-period">{period}</span>
            <span className="admin-summary-value">{periods[period].total_events}</span>
            <span className="admin-summary-sub">events</span>
            <span className="admin-summary-value">{periods[period].unique_sessions}</span>
            <span className="admin-summary-sub">sessions</span>
            {prev_periods && prev_periods[period] && (
              <span className="admin-summary-trends">
                {trendIndicator(periods[period].total_events, prev_periods[period].total_events, 'evt')}
                {trendIndicator(periods[period].unique_sessions, prev_periods[period].unique_sessions, 'sess')}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Funnel */}
      <div className="admin-panel">
        <h3>Funnel (30d)</h3>
        <div className="admin-funnel">
          {FUNNEL_ORDER.map((step, i) => {
            const count = funnel[step] || 0;
            const pct = funnelMax > 0 ? (count / funnelMax) * 100 : 0;
            const prevStep = i > 0 ? (funnel[FUNNEL_ORDER[i - 1]] || 0) : 0;
            const convPct = i > 0 && prevStep > 0 ? Math.round((count / prevStep) * 100) : null;
            return (
              <div key={step} className="funnel-row">
                <span className="funnel-label">{formatEvent(step)}</span>
                <div className="funnel-bar-wrap">
                  <div className="funnel-bar" style={{ '--funnel-bar-width': `${Math.max(pct, 2)}%` }} />
                </div>
                <span className="funnel-count">
                  {count}
                  {convPct !== null && <span className="funnel-pct">{convPct}%</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Feature Usage */}
      {features && (
        <div className="admin-panel">
          <h3>Feature Usage (30d)</h3>
          <div className="admin-feature-row">
            <span className="admin-feature-label">Device</span>
            <div className="admin-feature-detail">
              {(features.device.mobile + features.device.desktop) > 0 ? (
                <>
                  <div className="admin-dist-bar">
                    <div className="admin-dist-seg admin-dist-mobile" style={{ '--seg-flex': features.device.mobile || 0 }} title={`Mobile: ${features.device.mobile}`} />
                    <div className="admin-dist-seg admin-dist-desktop" style={{ '--seg-flex': features.device.desktop || 0 }} title={`Desktop: ${features.device.desktop}`} />
                  </div>
                  <span className="admin-dist-labels">
                    <span>Mobile {features.device.mobile}</span>
                    <span>Desktop {features.device.desktop}</span>
                  </span>
                </>
              ) : '---'}
            </div>
          </div>
          <div className="admin-feature-row">
            <span className="admin-feature-label">Export</span>
            <div className="admin-feature-detail">
              {Object.keys(features.export_format).length > 0
                ? Object.entries(features.export_format).map(([fmt, n]) => (
                    <span key={fmt} className="admin-badge">{fmt.toUpperCase()} {n}</span>
                  ))
                : '---'}
            </div>
          </div>
          <div className="admin-feature-row">
            <span className="admin-feature-label">Action</span>
            <div className="admin-feature-detail">
              {Object.keys(features.export_action).length > 0
                ? Object.entries(features.export_action).map(([action, n]) => (
                    <span key={action} className="admin-badge">{action} {n}</span>
                  ))
                : '---'}
            </div>
          </div>
          <div className="admin-feature-row">
            <span className="admin-feature-label">Blur Mode</span>
            <div className="admin-feature-detail">
              {Object.keys(features.blur_mode).length > 0
                ? Object.entries(features.blur_mode).map(([mode, n]) => (
                    <span key={mode} className="admin-badge">{mode} {n}</span>
                  ))
                : '---'}
            </div>
          </div>
          <div className="admin-feature-row">
            <span className="admin-feature-label">ComfyUI</span>
            <div className="admin-feature-detail">
              {(features.comfyui.completed + features.comfyui.failed) > 0 ? (
                <>
                  <span
                    className="admin-badge admin-badge-success"
                    aria-label={`Succeeded ${features.comfyui.completed}`}
                  >
                    <span aria-hidden="true">✓ </span>OK {features.comfyui.completed}
                  </span>
                  <span
                    className="admin-badge admin-badge-danger"
                    aria-label={`Failed ${features.comfyui.failed}`}
                  >
                    <span aria-hidden="true">✗ </span>Fail {features.comfyui.failed}
                  </span>
                  <span className="admin-comfyui-rate">
                    ({Math.round((features.comfyui.completed / (features.comfyui.completed + features.comfyui.failed)) * 100)}% success)
                  </span>
                  {Object.keys(features.comfyui.errors).length > 0 && (
                    <div className="admin-error-list">
                      {Object.entries(features.comfyui.errors)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 3)
                        .map(([msg, n]) => (
                          <div key={msg} className="admin-error-item">{msg} <strong>x{n}</strong></div>
                        ))}
                    </div>
                  )}
                </>
              ) : '---'}
            </div>
          </div>
        </div>
      )}

      {/* Daily activity */}
      <div className="admin-panel">
        <div className="admin-panel-header">
          <h3>Daily Activity (30d)</h3>
          <div className="admin-toggle">
            <button className={`admin-toggle-btn${chartMode === 'events' ? ' active' : ''}`} onClick={() => setChartMode('events')} aria-pressed={chartMode === 'events'}>Events</button>
            <button className={`admin-toggle-btn${chartMode === 'sessions' ? ' active' : ''}`} onClick={() => setChartMode('sessions')} aria-pressed={chartMode === 'sessions'}>Sessions</button>
          </div>
        </div>
        <div className="admin-chart">
          {daily.map((d, i) => {
            const val = chartMode === 'sessions' ? d.sessions : d.events;
            const day = d.date.slice(8);
            const isFirst = i === 0 || d.date.slice(5, 7) !== daily[i - 1].date.slice(5, 7);
            const monthLabel = isFirst ? new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short' }) : null;
            // Labeling every day puts 30 two-digit strings across a narrow
            // panel, which crowds the layout. Anchor labels to the latest day
            // and show every 5th one back, so the rightmost (most recent)
            // column always has a label and the density stays readable.
            const showDayLabel = (daily.length - 1 - i) % 5 === 0;
            return (
              <div key={d.date} className="chart-col" title={`${d.date}: ${d.events} events, ${d.sessions} sessions`}>
                <div className="chart-bar" style={{ '--bar-height': `${(val / maxDaily) * 100}%` }} />
                <span className="chart-label">{showDayLabel ? day : ''}</span>
                {monthLabel && <span className="chart-month">{monthLabel}</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Event breakdown */}
      <div className="admin-panel">
        <h3>Events by Type</h3>
        <div className="admin-event-list">
          {Object.keys(periods['30d'].events || {})
            .sort((a, b) => (periods['30d'].events[b] || 0) - (periods['30d'].events[a] || 0))
            .map((evt) => (
              <div key={evt} className="admin-event-row">
                <span className="admin-event-name">{formatEvent(evt)}</span>
                <div className="admin-event-counts">
                  <span className="admin-event-count">{periods['24h'].events[evt] || 0}<small>24h</small></span>
                  <span className="admin-event-count">{periods['7d'].events[evt] || 0}<small>7d</small></span>
                  <span className="admin-event-count">{periods['30d'].events[evt] || 0}<small>30d</small></span>
                </div>
              </div>
            ))}
        </div>
      </div>

      {/* User Feedback — collapsible */}
      <div className="admin-panel">
        <button className="admin-accordion-toggle" onClick={() => setFeedbackOpen(v => !v)}>
          <h3>Beta Feedback ({feedback ? feedback.length : 0})</h3>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: feedbackOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {feedbackOpen && (
          feedback && feedback.length > 0 ? (
            <div className="admin-feedback-list">
              {feedback.map((fb, i) => (
                <div key={fb.id || i} className={`admin-feedback-item cat-${fb.category || 'general'}`}>
                  <div className="admin-feedback-header">
                    <div className="admin-feedback-tags">
                      <span className={`admin-feedback-cat cat-${fb.category}`}>
                        {{ bug: 'Bug', ux: 'UI/UX', feature: 'Feature', general: 'General' }[fb.category] || fb.category}
                      </span>
                      {fb.severity && (
                        <span className={`admin-feedback-sev sev-${fb.severity}`}>
                          {fb.severity}
                        </span>
                      )}
                    </div>
                    <div className="admin-feedback-actions">
                      <span className="admin-feedback-date">
                        {new Date(fb.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <button className="admin-feedback-delete" onClick={() => setPendingDeleteId(fb.id)} title="Delete feedback" aria-label="Delete feedback">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6M14 11v6" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <h4 className="admin-feedback-summary">{fb.summary}</h4>
                  <p className="admin-feedback-message">{fb.details}</p>
                  {fb.steps && (
                    <div className="admin-feedback-steps">
                      <strong>Steps to reproduce:</strong>
                      <pre>{fb.steps}</pre>
                    </div>
                  )}
                  <div className="admin-feedback-meta">
                    {fb.contact && <span className="admin-feedback-contact">{fb.contact}</span>}
                    {fb.device_info && <span className="admin-feedback-device" title={fb.device_info}>{fb.device_info.split(',')[0]}</span>}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="admin-empty-state">No feedback submitted yet.</p>
          )
        )}
      </div>

      {pendingDeleteId && (
        <ConfirmModal
          message="Delete this feedback?"
          confirmLabel="Delete"
          onConfirm={() => deleteFeedback(pendingDeleteId)}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}
    </div>
  );
}
