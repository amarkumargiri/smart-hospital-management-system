import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Async, Badge, Card, Table, fmtDate, useApi } from '../../components/ui.jsx';

export default function PatientPrescriptions() {
  const { user } = useAuth();
  const patientId = user?.patient?.id;
  const query = useApi(() => api.get(`/patients/${patientId}/prescriptions`), [patientId], { skip: !patientId });

  // Printing the browser page is the whole "download as PDF" feature: the print
  // dialog already offers Save as PDF on every platform.
  const print = () => window.print();

  return (
    <div className="stack">
      <div className="row between">
        <h1>Prescriptions</h1>
        <button className="ghost" onClick={print}>Print / save as PDF</button>
      </div>

      <Async query={query} empty="No prescriptions yet.">
        {(list) => (
          <div className="stack">
            {list.map((p) => (
              <Card
                key={p.id}
                title={`Prescribed by ${p.doctor.user.fullName}`}
                action={<span className="row"><span className="small muted">{fmtDate(p.issuedAt)}</span><Badge value={p.status} /></span>}
              >
                <Table
                  rows={p.items}
                  columns={[
                    { key: 'medicineName', header: 'Medicine' },
                    { key: 'dosage', header: 'Dose' },
                    { key: 'frequency', header: 'Frequency' },
                    { key: 'durationDays', header: 'Duration', render: (i) => `${i.durationDays} days` },
                    { key: 'route', header: 'Route' },
                    { key: 'instruction', header: 'Instruction', wrap: true },
                    { key: 'dispensedQty', header: 'Dispensed', num: true },
                  ]}
                />
                {p.notes && <p className="small muted" style={{ marginTop: '.6rem' }}>{p.notes}</p>}
              </Card>
            ))}
          </div>
        )}
      </Async>
    </div>
  );
}
