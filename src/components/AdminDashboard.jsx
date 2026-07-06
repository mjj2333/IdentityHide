import { useState, useEffect, useCallback, useRef } from 'react';
import ConfirmModal from './ConfirmModal';
import BetaCodesPanel from './BetaCodesPanel';
import ScreenShell from './ScreenShell';
import { apiUrl } from '../utils/api';

const FUNNEL_STEPS = [
  { key: 'app_loaded', label: 'Visited', icon: '\u{1F310}' },
  { key: 'image_uploaded', label: 'Uploaded', icon: '\u{1F4F7}' },
  { key: 'apply_clicked', label: 'Applied', icon: '\u{2705}' },
  { key: 'export_completed', label: 'Exported', icon: '\u{1F4E5}' },
];

export default function AdminDashboard({ onBack }) {
  const [password, setPassword] = useState('');
  // Token lives in memory only — never persisted to storage. Page refresh /
  // tab reopen requires re-auth. Trades a small UX cost for eliminating the
  // XSS-token-exfiltration path.
  const [sessionToken, setSessionToken] = useState('');
  const authed = !!sessionToken;
  const [data, setData] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [chartMode, setChartMode] = useState('sessions');
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  // Bumped each time the Refresh button is clicked. BetaCodesPanel
  // depends on this in its loadCodes useEffect so its data syncs with
  // the rest of the dashboard instead of staying stale across redemptions
  // that happened on other devices.
  const [betaRefreshKey, setBetaRefreshKey] = useState(0);

  const deleteFeedback = useCallback(async (id) => {
    try {
      const res = await fetch(apiUrl('/.netlify/functions/feedback'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
        body: JSON.stringify({ action: 'delete', id }),
      });
      if (res.ok) setFeedback(prev => prev ? prev.filter(fb => fb.id !== id) : prev);
      else setError('Failed to delete feedback');
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
        fetch(apiUrl('/.netlify/functions/admin-stats'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pw}` },
        }),
        fetch(apiUrl('/.netlify/functions/feedback'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pw}` },
          body: JSON.stringify({ action: 'list' }),
        }),
      ]);
      if (statsRes.status === 401) { setSessionToken(''); setError('Invalid password'); return; }
      if (statsRes.status === 429) {
        setSessionToken('');
        const retryAfter = parseInt(statsRes.headers.get('Retry-After') || '0', 10);
        const mins = retryAfter > 0 ? Math.ceil(retryAfter / 60) : null;
        setError(mins ? `Too many failed attempts. Try again in ~${mins} min.` : 'Too many failed attempts. Try again later.');
        return;
      }
      if (!statsRes.ok) throw new Error(`Server error ${statsRes.status}`);
      const json = await statsRes.json();
      setData(json);
      if (fbRes.ok) setFeedback(await fbRes.json());
      setSessionToken(pw);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);



  const handleLogin = (e) => { e.preventDefault(); fetchStats(password); };

  // Same backAction is reused across all three states (loading / unauth /
  // dashboard) so the user can always leave the admin route.
  const backAction = onBack || (() => { window.location.href = '/'; });

  if (authed && !data && loading) {
    return (
      <ScreenShell backAction={backAction} backLabel="Back" stepLabel="Admin">
        <div className="admin-dashboard">
          <div className="admin-login"><h2>Loading...</h2></div>
        </div>
      </ScreenShell>
    );
  }

  if (!authed || !data) {
    return (
      <ScreenShell backAction={backAction} backLabel="Back" stepLabel="Admin">
        <div className="admin-dashboard">
          <div className="admin-login">
            <h2>Admin Dashboard</h2>
            <form onSubmit={handleLogin}>
              <input type="password" placeholder="Password" aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" autoFocus />
              <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Loading...' : 'Login'}</button>
            </form>
            {error && <p className="admin-error">{error}</p>}
          </div>
        </div>
      </ScreenShell>
    );
  }

  const { periods, funnel, daily, features, prev_periods } = data;
  const maxDaily = Math.max(...daily.map(d => chartMode === 'sessions' ? d.sessions : d.events), 1);
  const funnelMax = Math.max(...FUNNEL_STEPS.map(s => funnel[s.key] || 0), 1);

  // Derive key metrics
  const sessions7d = periods['7d'].unique_sessions;
  const sessions30d = periods['30d'].unique_sessions;
  const exports30d = funnel['export_completed'] || 0;
  const uploads30d = funnel['image_uploaded'] || 0;
  const conversionRate = uploads30d > 0 ? Math.round((exports30d / uploads30d) * 100) : 0;
  const comfyOk = features?.comfyui?.completed || 0;
  const comfyFail = features?.comfyui?.failed || 0;
  const comfyTotal = comfyOk + comfyFail;
  const comfyRate = comfyTotal > 0 ? Math.round((comfyOk / comfyTotal) * 100) : null;
  const mobileCount = features?.device?.mobile || 0;
  const desktopCount = features?.device?.desktop || 0;
  const deviceTotal = mobileCount + desktopCount;
  const mobilePct = deviceTotal > 0 ? Math.round((mobileCount / deviceTotal) * 100) : 0;

  function trend(current, previous) {
    if (!previous || previous === 0) return null;
    const pct = Math.round(((current - previous) / previous) * 100);
    if (pct === 0) return null;
    const up = pct > 0;
    return (
      <span className={`admin-kpi-trend ${up ? 'trend-up' : 'trend-down'}`}>
        {up ? '\u2191' : '\u2193'} {Math.abs(pct)}%
      </span>
    );
  }

  return (
    <ScreenShell backAction={backAction} backLabel="Back" stepLabel="Admin">
    <div className="admin-dashboard">
      <div className="admin-content-toolbar">
        <button className="btn btn-ghost btn-sm" onClick={() => { fetchStats(sessionToken); setBetaRefreshKey(k => k + 1); }} disabled={loading}>{loading ? '...' : 'Refresh'}</button>
      </div>

      {error && <p className="admin-error" style={{ marginBottom: 12 }}>{error}</p>}

      {/* KPI cards */}
      <div className="admin-kpi-row">
        <div className="admin-kpi-card">
          <span className="admin-kpi-label">Users (7d)</span>
          <span className="admin-kpi-value">{sessions7d}</span>
          {prev_periods?.['7d'] && trend(sessions7d, prev_periods['7d'].unique_sessions)}
        </div>
        <div className="admin-kpi-card">
          <span className="admin-kpi-label">Users (30d)</span>
          <span className="admin-kpi-value">{sessions30d}</span>
          {prev_periods?.['30d'] && trend(sessions30d, prev_periods['30d'].unique_sessions)}
        </div>
        <div className="admin-kpi-card">
          <span className="admin-kpi-label">Conversion</span>
          <span className="admin-kpi-value">{conversionRate}%</span>
          <span className="admin-kpi-sub">upload to export</span>
        </div>
        <div className="admin-kpi-card">
          <span className="admin-kpi-label">Device Split</span>
          <span className="admin-kpi-value">{mobilePct}%</span>
          <span className="admin-kpi-sub">mobile</span>
        </div>
      </div>

      {/* Funnel — visual step-down */}
      <div className="admin-panel">
        <h3>Funnel (30d)</h3>
        <div className="admin-funnel-visual">
          {FUNNEL_STEPS.map((step, i) => {
            const count = funnel[step.key] || 0;
            const pct = funnelMax > 0 ? (count / funnelMax) * 100 : 0;
            const prevCount = i > 0 ? (funnel[FUNNEL_STEPS[i - 1].key] || 0) : 0;
            const dropoff = i > 0 && prevCount > 0 ? Math.round((count / prevCount) * 100) : null;
            return (
              <div key={step.key} className="admin-funnel-step">
                <div className="admin-funnel-bar-area">
                  <div className="admin-funnel-bar" style={{ '--fw': `${Math.max(pct, 4)}%` }} />
                </div>
                <div className="admin-funnel-meta">
                  <span className="admin-funnel-label">{step.label}</span>
                  <span className="admin-funnel-count">{count}</span>
                  {dropoff !== null && (
                    <span className="admin-funnel-drop">{dropoff}%</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Daily activity */}
      <div className="admin-panel">
        <div className="admin-panel-header">
          <h3>Activity (30d)</h3>
          <div className="admin-toggle">
            <button className={`admin-toggle-btn${chartMode === 'sessions' ? ' active' : ''}`} onClick={() => setChartMode('sessions')}>Users</button>
            <button className={`admin-toggle-btn${chartMode === 'events' ? ' active' : ''}`} onClick={() => setChartMode('events')}>Events</button>
          </div>
        </div>
        <div className="admin-chart">
          {daily.map((d, i) => {
            const val = chartMode === 'sessions' ? d.sessions : d.events;
            const day = d.date.slice(8);
            const isFirst = i === 0 || d.date.slice(5, 7) !== daily[i - 1].date.slice(5, 7);
            const monthLabel = isFirst ? new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short' }) : null;
            const showDayLabel = (daily.length - 1 - i) % 5 === 0;
            return (
              <div key={d.date} className="chart-col" title={`${d.date}: ${d.events} events, ${d.sessions} users`}>
                <div className="chart-bar" style={{ '--bar-height': `${(val / maxDaily) * 100}%` }} />
                <span className="chart-label">{showDayLabel ? day : ''}</span>
                {monthLabel && <span className="chart-month">{monthLabel}</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Tattoo removal health */}
      {comfyTotal > 0 && (
        <div className="admin-panel admin-comfy-panel">
          <h3>Tattoo Removal</h3>
          <div className="admin-comfy-row">
            <div className="admin-comfy-ring">
              <svg viewBox="0 0 36 36" className="admin-ring-svg">
                <path className="admin-ring-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                <path className="admin-ring-fg" strokeDasharray={`${comfyRate}, 100`} d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
              </svg>
              <span className="admin-ring-label">{comfyRate}%</span>
            </div>
            <div className="admin-comfy-stats">
              <span className="admin-comfy-stat"><span className="dot dot-ok" /> {comfyOk} succeeded</span>
              <span className="admin-comfy-stat"><span className="dot dot-fail" /> {comfyFail} failed</span>
            </div>
          </div>
          {features.comfyui.errors && Object.keys(features.comfyui.errors).length > 0 && (
            <div className="admin-comfy-errors">
              {Object.entries(features.comfyui.errors).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([msg, n]) => (
                <div key={msg} className="admin-error-item">{msg} <strong>x{n}</strong></div>
              ))}
            </div>
          )}
        </div>
      )}


      {/* Detailed breakdown — collapsible */}
      <div className="admin-panel">
        <button className="admin-accordion-toggle" onClick={() => setDetailsOpen(v => !v)}>
          <h3>Detailed Breakdown</h3>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: detailsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {detailsOpen && (
          <>
            {features && (
              <div style={{ marginTop: 12 }}>
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
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <h4 style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 8px', fontWeight: 600 }}>All Events (30d)</h4>
              <div className="admin-event-list">
                {Object.keys(periods['30d'].events || {})
                  .sort((a, b) => (periods['30d'].events[b] || 0) - (periods['30d'].events[a] || 0))
                  .map((evt) => (
                    <div key={evt} className="admin-event-row">
                      <span className="admin-event-name">{evt.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</span>
                      <div className="admin-event-counts">
                        <span className="admin-event-count">{periods['24h'].events[evt] || 0}<small>24h</small></span>
                        <span className="admin-event-count">{periods['7d'].events[evt] || 0}<small>7d</small></span>
                        <span className="admin-event-count">{periods['30d'].events[evt] || 0}<small>30d</small></span>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Feedback — collapsible */}
      <div className="admin-panel">
        <button className="admin-accordion-toggle" onClick={() => setFeedbackOpen(v => !v)}>
          <h3>Feedback ({feedback ? feedback.length : 0})</h3>
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
                      {fb.severity && <span className={`admin-feedback-sev sev-${fb.severity}`}>{fb.severity}</span>}
                    </div>
                    <div className="admin-feedback-actions">
                      <span className="admin-feedback-date">
                        {new Date(fb.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <button className="admin-feedback-delete" onClick={() => setPendingDeleteId(fb.id)} title="Delete feedback" aria-label="Delete feedback">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12.56.566c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
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

      <BetaCodesPanel sessionToken={sessionToken} refreshKey={betaRefreshKey} />

      {pendingDeleteId && (
        <ConfirmModal
          message="Delete this feedback?"
          confirmLabel="Delete"
          onConfirm={() => deleteFeedback(pendingDeleteId)}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}
    </div>
    </ScreenShell>
  );
}
