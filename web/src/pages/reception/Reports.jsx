import { useState } from 'react';
import { api } from '../../api.js';
import { Card, ErrorNote, Loading, Table, downloadBlob } from '../../components/ui.jsx';

const isoDate = (d) => d.toISOString().slice(0, 10);

const REPORTS = [
  { type: 'opd', label: 'OPD report', hint: 'Every appointment with doctor, department, status and fee.' },
  { type: 'admissions', label: 'Admission & discharge report', hint: 'Inpatient movements with bed and dates.' },
  { type: 'occupancy', label: 'Bed & ICU occupancy report', hint: 'Daily occupancy, OT cases, oxygen and blood use.' },
  { type: 'revenue', label: 'Revenue report', hint: 'Bills raised, collected and outstanding.' },
  { type: 'lab', label: 'Laboratory report', hint: 'Tests ordered with results and flags.' },
  { type: 'pharmacy', label: 'Pharmacy inventory report', hint: 'Stock on hand, reorder levels and expiry.' },
  { type: 'forecast', label: 'Forecast report', hint: 'Every forecast run with model and accuracy.' },
];

export default function Reports() {
  const [from, setFrom] = useState(isoDate(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(isoDate(new Date()));
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(null);
  const [error, setError] = useState(null);

  const range = { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.000Z` };

  async function show(type) {
    setLoading(type);
    setError(null);
    try {
      const result = await api.get(`/analytics/reports/${type}`, range);
      setPreview({ type, rows: result.rows });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(null);
    }
  }

  async function download(type) {
    setError(null);
    try {
      // The API renders the CSV; the browser just saves what it is handed.
      const blob = await api.blob(`/analytics/reports/${type}`, { ...range, format: 'csv' });
      downloadBlob(blob, `${type}-report-${from}-to-${to}.csv`);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="stack">
      <div className="row between">
        <h1>Reports</h1>
        <div className="row">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 160 }} />
          <span className="muted">to</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 160 }} />
        </div>
      </div>

      <ErrorNote error={error} />

      <div className="grid cols-3">
        {REPORTS.map((r) => (
          <Card key={r.type} title={r.label}>
            <p className="small muted">{r.hint}</p>
            <div className="row">
              <button className="small ghost" onClick={() => show(r.type)} disabled={loading === r.type}>
                {loading === r.type ? 'Loading…' : 'Preview'}
              </button>
              <button className="small" onClick={() => download(r.type)}>Download CSV</button>
            </div>
          </Card>
        ))}
      </div>

      {loading && <Loading />}
      {preview && (
        <Card
          title={`${REPORTS.find((r) => r.type === preview.type)?.label} — ${preview.rows.length} row(s)`}
          action={<button className="small ghost" onClick={() => setPreview(null)}>Close</button>}
        >
          <Table
            empty="No rows in this range."
            rows={preview.rows.slice(0, 200)}
            rowKey={(_, i) => i}
            columns={Object.keys(preview.rows[0] || {}).map((key) => ({
              key,
              header: key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
              num: typeof preview.rows[0][key] === 'number',
            }))}
          />
          {preview.rows.length > 200 && (
            <p className="small muted" style={{ marginTop: '.5rem' }}>
              Showing the first 200 rows. Download the CSV for the full report.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
