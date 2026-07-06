import { useState, useEffect, useCallback } from 'react';
import ConfirmModal from './ConfirmModal';
import { apiUrl } from '../utils/api';

function formatDate(iso) {
  if (!iso) return 'Never';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function toDateInput(value) {
  if (!value) return '';
  try {
    const d = new Date(value);
    // HTML date input wants YYYY-MM-DD in local time.
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return '';
  }
}

/**
 * Admin panel for generating / listing / revoking beta codes. Lives inside
 * AdminDashboard and uses the same Bearer-token auth the rest of the admin
 * endpoints use.
 *
 * The plaintext code is shown to the admin ONCE after generation — the
 * server only keeps a SHA-256 hash, so there's no way to recover it later.
 * The admin has to copy + save it before dismissing the "new code" banner.
 */
export default function BetaCodesPanel({ sessionToken, refreshKey = 0 }) {
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [newCode, setNewCode] = useState(null);
  const [copied, setCopied] = useState(false);
  // Tracks which row's "copy" button was just clicked so we can flash a
  // per-row "Copied ✓" label. Cleared ~2s after the click.
  const [copiedRowId, setCopiedRowId] = useState(null);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [form, setForm] = useState({ label: '', expiresAt: '', customCode: '' });
  const [grantForm, setGrantForm] = useState({ email: '', expiresAt: '' });
  const [granting, setGranting] = useState(false);
  const [grantSuccess, setGrantSuccess] = useState(null);

  const callApi = useCallback(async (payload) => {
    const res = await fetch(apiUrl('/.netlify/functions/admin-beta-codes'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(msg || `Request failed (${res.status})`);
    }
    return res.json();
  }, [sessionToken]);

  const loadCodes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { codes: list } = await callApi({ action: 'list' });
      setCodes(list || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [callApi]);

  // Re-fetch on mount AND whenever the parent bumps refreshKey (clicked
  // the AdminDashboard's Refresh button). loadCodes is memoized on
  // sessionToken, so without refreshKey the effect would only fire once.
  useEffect(() => { loadCodes(); }, [loadCodes, refreshKey]);

  const handleGenerate = async (e) => {
    e.preventDefault();
    if (generating) return;
    setGenerating(true);
    setError(null);
    try {
      // The date input gives YYYY-MM-DD. Convert to end-of-day ISO so the
      // code works through the picked day in the admin's local timezone.
      let expiresAt = null;
      if (form.expiresAt) {
        const d = new Date(`${form.expiresAt}T23:59:59`);
        if (!Number.isNaN(d.getTime())) expiresAt = d.toISOString();
      }
      const result = await callApi({
        action: 'create',
        label: form.label,
        expiresAt,
        // Send only if populated — omitting lets the server auto-generate.
        code: form.customCode.trim() || undefined,
      });
      setNewCode(result);
      setCopied(false);
      setForm({ label: '', expiresAt: '', customCode: '' });
      await loadCodes();
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    if (!newCode?.code) return;
    try {
      await navigator.clipboard.writeText(newCode.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError('Could not copy — select the code and copy manually.');
    }
  };

  const handleCopyRow = async (id, code) => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopiedRowId(id);
      setTimeout(() => setCopiedRowId(prev => (prev === id ? null : prev)), 2000);
    } catch {
      setError('Could not copy — select the code and copy manually.');
    }
  };

  const handleDelete = async (id) => {
    setPendingDeleteId(null);
    setError(null);
    try {
      await callApi({ action: 'delete', id });
      await loadCodes();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleManualGrant = async (e) => {
    e.preventDefault();
    if (granting) return;
    setGranting(true);
    setError(null);
    setGrantSuccess(null);
    try {
      // Date-picker gives YYYY-MM-DD. Convert to end-of-day ISO so access
      // works through the full day in the admin's local timezone.
      let expiresAt = null;
      if (grantForm.expiresAt) {
        const d = new Date(`${grantForm.expiresAt}T23:59:59`);
        if (!Number.isNaN(d.getTime())) expiresAt = d.toISOString();
      }
      const result = await callApi({
        action: 'manual-grant',
        email: grantForm.email,
        expiresAt,
      });
      setGrantSuccess(result);
      setGrantForm({ email: '', expiresAt: '' });
    } catch (err) {
      setError(err.message);
    } finally {
      setGranting(false);
    }
  };

  return (
    <div className="admin-panel">
      <h3>Promo codes</h3>

      {newCode && (
        <div className="beta-newcode-banner" role="status">
          <div className="beta-newcode-head">
            <strong>Code generated — copy it now</strong>
            <button className="beta-newcode-dismiss" onClick={() => setNewCode(null)} aria-label="Dismiss">&times;</button>
          </div>
          <div className="beta-newcode-code">
            <code>{newCode.code}</code>
            <button className="btn btn-secondary btn-sm" onClick={handleCopy}>
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
          <div className="beta-newcode-meta">
            {newCode.label && <span>{newCode.label}</span>}
            {newCode.expiresAt && <span> · expires {formatDate(newCode.expiresAt)}</span>}
            <span> · the plaintext is only shown once — we keep a hash, not the code</span>
          </div>
        </div>
      )}

      <form className="beta-generate-form" onSubmit={handleGenerate}>
        <div className="beta-generate-field">
          <label htmlFor="beta-label">Label (for your reference)</label>
          <input
            id="beta-label"
            type="text"
            placeholder="e.g. Alpha testers — cohort 1"
            value={form.label}
            onChange={(e) => setForm(f => ({ ...f, label: e.target.value }))}
            disabled={generating}
            maxLength={120}
          />
        </div>
        <div className="beta-generate-field">
          <label htmlFor="beta-expires">Expires (optional)</label>
          <input
            id="beta-expires"
            type="date"
            value={form.expiresAt}
            onChange={(e) => setForm(f => ({ ...f, expiresAt: e.target.value }))}
            disabled={generating}
          />
        </div>
        <div className="beta-generate-field">
          <label htmlFor="beta-custom">Custom code (optional)</label>
          <input
            id="beta-custom"
            type="text"
            placeholder="e.g. promo2026 — leave blank to auto-generate"
            value={form.customCode}
            onChange={(e) => setForm(f => ({ ...f, customCode: e.target.value }))}
            disabled={generating}
            maxLength={32}
            pattern="[A-Za-z0-9_-]{4,32}"
            title="4–32 characters, letters/digits/dashes/underscores only"
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={generating}>
          {generating ? 'Generating…' : (form.customCode.trim() ? 'Create code' : 'Generate code')}
        </button>
      </form>

      <div className="beta-grant-divider" aria-hidden="true">or grant access directly by email</div>

      {grantSuccess && (
        <div className="beta-newcode-banner" role="status">
          <div className="beta-newcode-head">
            <strong>Access granted to {grantSuccess.email}</strong>
            <button className="beta-newcode-dismiss" onClick={() => setGrantSuccess(null)} aria-label="Dismiss">&times;</button>
          </div>
          <div className="beta-newcode-meta">
            {grantSuccess.expiresAt
              ? <>Expires {formatDate(grantSuccess.expiresAt)} · no code needed — they just sign in with this email.</>
              : <>Never expires · no code needed — they just sign in with this email.</>
            }
          </div>
        </div>
      )}

      <form className="beta-generate-form" onSubmit={handleManualGrant}>
        <div className="beta-generate-field">
          <label htmlFor="beta-grant-email">Email</label>
          <input
            id="beta-grant-email"
            type="email"
            placeholder="user@example.com"
            value={grantForm.email}
            onChange={(e) => setGrantForm(f => ({ ...f, email: e.target.value }))}
            disabled={granting}
            required
          />
        </div>
        <div className="beta-generate-field">
          <label htmlFor="beta-grant-expires">Expires (optional)</label>
          <input
            id="beta-grant-expires"
            type="date"
            value={grantForm.expiresAt}
            onChange={(e) => setGrantForm(f => ({ ...f, expiresAt: e.target.value }))}
            disabled={granting}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={granting || !grantForm.email}>
          {granting ? 'Granting…' : 'Grant access'}
        </button>
      </form>

      {error && <p className="admin-error">{error}</p>}

      <div className="beta-codes-list">
        {loading && codes.length === 0 ? (
          <p className="admin-empty-state">Loading codes…</p>
        ) : codes.length === 0 ? (
          <p className="admin-empty-state">No codes yet. Generate one above.</p>
        ) : (
          <table className="beta-codes-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Label</th>
                <th>Created</th>
                <th>Expires</th>
                <th>Redemptions</th>
                <th>Status</th>
                <th className="beta-codes-actions-head">Actions</th>
              </tr>
            </thead>
            <tbody>
              {codes.map(c => {
                const expired = c.expiresAt && new Date(c.expiresAt).getTime() < Date.now();
                const stateLabel = c.revoked ? 'Revoked' : expired ? 'Expired' : 'Active';
                const stateClass = c.revoked || expired ? 'is-inactive' : 'is-active';
                const isCopied = copiedRowId === c.id;
                return (
                  <tr key={c.id} className={c.revoked ? 'is-revoked' : ''}>
                    <td>
                      {c.code ? (
                        <div className="beta-codes-code-cell">
                          <code className="beta-codes-code-value">{c.code}</code>
                          <button
                            className={`beta-codes-copy-btn${isCopied ? ' is-copied' : ''}`}
                            onClick={() => handleCopyRow(c.id, c.code)}
                            title="Copy code"
                            aria-label={`Copy code ${c.code}`}
                          >
                            {isCopied ? (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            ) : (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="9" y="9" width="13" height="13" rx="2" />
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                              </svg>
                            )}
                          </button>
                        </div>
                      ) : (
                        <span className="beta-codes-dim" title="Legacy code — plaintext wasn't stored">—</span>
                      )}
                    </td>
                    <td>{c.label || <em className="beta-codes-dim">unlabelled</em>}</td>
                    <td>{formatDate(c.createdAt)}</td>
                    <td>{formatDate(c.expiresAt)}</td>
                    <td>{c.redemptions}</td>
                    <td><span className={`beta-codes-state ${stateClass}`}>{stateLabel}</span></td>
                    <td className="beta-codes-actions-cell">
                      <button
                        className="beta-codes-delete-btn"
                        onClick={() => setPendingDeleteId(c.id)}
                        title="Delete this code — existing redemptions keep their access"
                        aria-label="Delete code"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12.56.566c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {pendingDeleteId && (
        <ConfirmModal
          message="Delete this code? Users who have already redeemed it keep their access; only new redemptions are blocked."
          confirmLabel="Delete"
          onConfirm={() => handleDelete(pendingDeleteId)}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}
    </div>
  );
}
