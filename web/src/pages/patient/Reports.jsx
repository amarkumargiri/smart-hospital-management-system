import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Async, Badge, Card, Table, fmtDateTime, useApi } from '../../components/ui.jsx';

export default function PatientReports() {
  const { user } = useAuth();
  const patientId = user?.patient?.id;
  const query = useApi(() => api.get(`/patients/${patientId}/reports`), [patientId], { skip: !patientId });

  return (
    <div className="stack">
      <div className="row between">
        <h1>Lab reports</h1>
        <button className="ghost" onClick={() => window.print()}>Print / save as PDF</button>
      </div>

      <Async query={query} empty="No reports available yet.">
        {(orders) => (
          <div className="stack">
            {orders.map((o) => (
              <Card
                key={o.id}
                title={o.items.map((i) => i.labTest.name).join(', ')}
                action={<span className="row"><span className="small muted">{fmtDateTime(o.orderedAt)}</span><Badge value={o.status} /></span>}
              >
                <div className="small muted" style={{ marginBottom: '.5rem' }}>
                  {o.hospital.name}{o.sampleId ? ` · Sample ${o.sampleId}` : ''}
                </div>
                <Table
                  rows={o.items}
                  columns={[
                    { key: 'test', header: 'Test', render: (i) => i.labTest.name },
                    { key: 'resultValue', header: 'Result', num: true },
                    { key: 'unit', header: 'Unit' },
                    { key: 'referenceRange', header: 'Reference range' },
                    { key: 'flag', header: 'Flag', render: (i) => i.flag ? <Badge value={i.flag} tone={i.flag === 'NORMAL' ? 'ok' : i.flag === 'CRITICAL' ? 'danger' : 'warn'} /> : '—' },
                  ]}
                />
                {o.report?.summary && <p className="small muted" style={{ marginTop: '.6rem' }}>{o.report.summary}</p>}
                {o.report?.status !== 'VERIFIED' && (
                  <div className="alert warn" style={{ marginTop: '.6rem' }}>
                    This report is awaiting verification by the laboratory supervisor.
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </Async>
    </div>
  );
}
