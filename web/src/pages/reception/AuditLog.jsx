import { useState } from 'react';
import { api } from '../../api.js';
import { Async, Card, Table, fmtDateTime, useApi } from '../../components/ui.jsx';

const ACTIONS = [
  'LOGIN', 'LOGOUT', 'VIEW_MEDICAL_RECORD', 'MODIFY_MEDICAL_RECORD', 'CREATE_PRESCRIPTION',
  'UPLOAD_REPORT', 'VERIFY_REPORT', 'GENERATE_BILL', 'RECORD_PAYMENT',
  'VERIFY_DOCTOR', 'ADMIT_PATIENT', 'DISCHARGE_PATIENT', 'RUN_FORECAST',
];

const isoDate = (d) => d.toISOString().slice(0, 10);

export default function AuditLog() {
  const [filters, setFilters] = useState({
    action: '', entityType: '',
    from: isoDate(new Date(Date.now() - 7 * 86_400_000)),
    to: isoDate(new Date()),
  });
  const [page, setPage] = useState(1);

  const query = useApi(
    () => api.get('/analytics/audit-logs', {
      ...filters,
      from: `${filters.from}T00:00:00.000Z`,
      to: `${filters.to}T23:59:59.000Z`,
      page,
      pageSize: 50,
    }),
    [filters, page],
  );

  const set = (key) => (e) => { setFilters({ ...filters, [key]: e.target.value }); setPage(1); };

  return (
    <div className="stack">
      <h1>Audit log</h1>

      <Card>
        <div className="grid cols-4">
          <div className="field"><label>From</label><input type="date" value={filters.from} onChange={set('from')} /></div>
          <div className="field"><label>To</label><input type="date" value={filters.to} onChange={set('to')} /></div>
          <div className="field">
            <label>Action</label>
            <select value={filters.action} onChange={set('action')}>
              <option value="">All actions</option>
              {ACTIONS.map((a) => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div className="field"><label>Entity type</label><input value={filters.entityType} onChange={set('entityType')} placeholder="Patient, Bill, LabOrder" /></div>
        </div>
      </Card>

      <Card title="Recorded activity">
        <Async query={query} empty="No audit entries in this range.">
          {(d) => (
            <>
              <Table
                rows={d.items}
                columns={[
                  { key: 'createdAt', header: 'When', render: (l) => fmtDateTime(l.createdAt) },
                  { key: 'user', header: 'User', render: (l) => (l.user ? `${l.user.fullName} (${l.user.role.replace(/_/g, ' ')})` : 'System') },
                  { key: 'action', header: 'Action', render: (l) => l.action.replace(/_/g, ' ') },
                  { key: 'entityType', header: 'Entity' },
                  { key: 'entityId', header: 'Entity ID', render: (l) => <span className="mono">{l.entityId?.slice(-8) || '—'}</span> },
                  { key: 'detail', header: 'Detail', wrap: true },
                  { key: 'ipAddress', header: 'IP address' },
                ]}
              />
              <div className="row between" style={{ marginTop: '.8rem' }}>
                <span className="small muted">{d.total} entries · page {d.page}</span>
                <span className="row">
                  <button className="small ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
                  <button className="small ghost" disabled={page * d.pageSize >= d.total} onClick={() => setPage(page + 1)}>Next</button>
                </span>
              </div>
            </>
          )}
        </Async>
      </Card>
    </div>
  );
}
