import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { Async, Badge, Card, Table, fmtDateTime, useApi } from '../../components/ui.jsx';

export default function DoctorLabResults() {
  const [status, setStatus] = useState('VERIFIED');
  const query = useApi(() => api.get('/lab/orders', { status, pageSize: 100 }), [status]);

  return (
    <div className="stack">
      <h1>Lab results</h1>

      <Card
        action={(
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 230 }}>
            <option value="VERIFIED">Verified results</option>
            <option value="ORDERED,SAMPLE_COLLECTED,PROCESSING">In progress</option>
            <option value="">All orders</option>
          </select>
        )}
      >
        <Async query={query} empty="No lab orders.">
          {(d) => (
            <div className="stack">
              {d.items.map((o) => (
                <div key={o.id}>
                  <div className="row between" style={{ marginBottom: '.35rem' }}>
                    <strong>
                      <Link to={`/doctor/patients/${o.patientId}`}>{o.patient.user.fullName}</Link>
                      <span className="muted small"> · {fmtDateTime(o.orderedAt)}</span>
                    </strong>
                    <span className="row">
                      {o.priority !== 'ROUTINE' && <Badge value={o.priority} tone="warn" />}
                      <Badge value={o.status} />
                    </span>
                  </div>
                  <Table
                    rows={o.items}
                    columns={[
                      { key: 'test', header: 'Test', render: (i) => i.labTest.name },
                      { key: 'resultValue', header: 'Result', num: true },
                      { key: 'unit', header: 'Unit' },
                      { key: 'referenceRange', header: 'Reference' },
                      {
                        key: 'flag',
                        header: 'Flag',
                        render: (i) => (i.flag ? <Badge value={i.flag} tone={i.flag === 'NORMAL' ? 'ok' : i.flag === 'CRITICAL' ? 'danger' : 'warn'} /> : '—'),
                      },
                    ]}
                  />
                  {o.report?.summary && <p className="small muted" style={{ marginTop: '.4rem' }}>{o.report.summary}</p>}
                </div>
              ))}
            </div>
          )}
        </Async>
      </Card>
    </div>
  );
}
