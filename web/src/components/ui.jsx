import { useCallback, useEffect, useRef, useState } from 'react';

// --- data loading ---------------------------------------------------------

// Every page loads with the same three states, so they all use this instead of
// hand-rolling useEffect + loading + error each time.
export function useApi(loader, deps = [], { skip = false } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!skip);
  const alive = useRef(true);

  const run = useCallback(async () => {
    if (skip) { setLoading(false); return; }
    setLoading(true);
    try {
      const result = await loader();
      if (alive.current) { setData(result); setError(null); }
    } catch (err) {
      if (alive.current) setError(err);
    } finally {
      if (alive.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip, ...deps]);

  useEffect(() => {
    alive.current = true;
    run();
    return () => { alive.current = false; };
  }, [run]);

  return { data, error, loading, reload: run, setData };
}

export function Loading({ label = 'Loading…' }) {
  return <div className="empty">{label}</div>;
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <div className="alert error">
      {error.message}
      {error.details?.length ? (
        <ul style={{ margin: '.4rem 0 0 1rem', padding: 0 }}>
          {error.details.map((d, i) => <li key={i}>{d.field}: {d.message}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

// Renders the loading/error/empty states so pages only describe the happy path.
export function Async({ query, empty = 'Nothing here yet.', children }) {
  if (query.loading && !query.data) return <Loading />;
  if (query.error) return <ErrorNote error={query.error} />;
  const isEmpty = query.data == null || (Array.isArray(query.data) && query.data.length === 0);
  if (isEmpty) return <div className="empty">{empty}</div>;
  return children(query.data);
}

// --- layout primitives ----------------------------------------------------

export function Card({ title, action, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="card-head">
          <h2>{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone, percent }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
      {percent !== undefined && (
        <div className={`meter ${percent >= 90 ? 'danger' : percent >= 75 ? 'warn' : ''}`}>
          <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
        </div>
      )}
    </div>
  );
}

export function Table({ columns, rows, empty = 'No records.', rowKey = (r, i) => r.id ?? i }) {
  if (!rows?.length) return <div className="empty">{empty}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c.key} className={c.wrap ? 'wrap' : c.num ? 'num' : ''}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)}>
              {columns.map((c) => (
                <td key={c.key} className={c.wrap ? 'wrap' : c.num ? 'num' : ''}>
                  {c.render ? c.render(row, i) : row[c.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Modal({ title, onClose, children, footer }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="card-head">
          <h2>{title}</h2>
          <button className="ghost small" onClick={onClose}>Close</button>
        </div>
        {children}
        {footer && <div className="row" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>{footer}</div>}
      </div>
    </div>
  );
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <div
          key={t.value}
          className={`tab ${active === t.value ? 'active' : ''}`}
          onClick={() => onChange(t.value)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && onChange(t.value)}
        >
          {t.label}
        </div>
      ))}
    </div>
  );
}

// --- formatting -----------------------------------------------------------

export const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtTime = (v) => (v ? new Date(v).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtDateTime = (v) => (v ? `${fmtDate(v)}, ${fmtTime(v)}` : '—');
export const money = (v) => `₹${Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const TONES = {
  COMPLETED: 'ok', CONFIRMED: 'ok', ACTIVE: 'ok', PAID: 'ok', VERIFIED: 'ok', AVAILABLE: 'ok', ADMITTED: 'ok', APPROVED: 'ok',
  REQUESTED: 'info', CHECKED_IN: 'info', IN_CONSULTATION: 'info', PROCESSING: 'info', ORDERED: 'info', SCHEDULED: 'info',
  PENDING: 'warn', PARTIALLY_PAID: 'warn', PENDING_VERIFICATION: 'warn', SAMPLE_COLLECTED: 'warn', RESULT_ENTERED: 'warn',
  CLEANING: 'warn', MAINTENANCE: 'warn', RESERVED: 'warn', HIGH: 'warn', MEDIUM: 'warn', WARNING: 'warn',
  CANCELLED: 'danger', REJECTED: 'danger', NO_SHOW: 'danger', BLOCKED: 'danger', OCCUPIED: 'danger', FAILED: 'danger',
  CRITICAL: 'danger', SUSPENDED: 'danger',
};

export const Badge = ({ value, tone }) =>
  <span className={`badge ${tone || TONES[value] || ''}`}>{String(value ?? '').replace(/_/g, ' ')}</span>;

// Downloads a blob the browser has already fetched through the API client.
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
