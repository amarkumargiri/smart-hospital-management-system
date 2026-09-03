import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Async, Badge, Card, Table, fmtDate, fmtDateTime, useApi } from '../../components/ui.jsx';

export default function PatientRecords() {
  const { user } = useAuth();
  const patientId = user?.patient?.id;
  const query = useApi(() => api.get(`/patients/${patientId}/history`), [patientId], { skip: !patientId });

  return (
    <div className="stack">
      <h1>Medical records</h1>
      <Async query={query}>
        {(d) => (
          <>
            <Card title="Health profile">
              <div className="grid cols-4">
                <div><div className="stat-label">Blood group</div><div>{d.patient.bloodGroup || 'Not recorded'}</div></div>
                <div><div className="stat-label">Date of birth</div><div>{fmtDate(d.patient.dateOfBirth)}</div></div>
                <div><div className="stat-label">Allergies</div><div>{d.patient.allergies || 'None recorded'}</div></div>
                <div><div className="stat-label">Chronic conditions</div><div>{d.patient.chronicConditions || 'None recorded'}</div></div>
              </div>
            </Card>

            <Card title={`Consultations (${d.consultations.length})`}>
              <div className="list">
                {d.consultations.length === 0 && <div className="empty">No consultations recorded.</div>}
                {d.consultations.map((c) => (
                  <div key={c.id} className="list-item">
                    <div className="row between">
                      <strong>{c.diagnoses.map((x) => x.description).join(', ') || 'Consultation'}</strong>
                      <span className="small muted">{fmtDateTime(c.startedAt)}</span>
                    </div>
                    <div className="small muted">
                      {c.doctor.user.fullName} · {c.doctor.hospital.name}
                    </div>
                    {c.symptoms && <div className="small">Symptoms: {c.symptoms}</div>}
                    {c.clinicalNotes && <div className="small">Notes: {c.clinicalNotes}</div>}
                    {c.vitals && (
                      <div className="small muted">
                        BP {c.vitals.systolic}/{c.vitals.diastolic} · Pulse {c.vitals.heartRate} ·
                        Temp {c.vitals.temperatureC}°C · SpO₂ {c.vitals.spo2}%
                      </div>
                    )}
                    {c.followUpDate && <div className="small">Follow-up: {fmtDate(c.followUpDate)}</div>}
                  </div>
                ))}
              </div>
            </Card>

            <Card title={`Hospital admissions (${d.admissions.length})`}>
              <Table
                empty="No admissions."
                rows={d.admissions}
                columns={[
                  { key: 'hospital', header: 'Hospital', render: (a) => a.hospital.name },
                  { key: 'reason', header: 'Reason', wrap: true },
                  { key: 'bed', header: 'Bed', render: (a) => a.bed ? `${a.bed.bedNumber} (${a.bed.ward})` : '—' },
                  { key: 'admittedAt', header: 'Admitted', render: (a) => fmtDate(a.admittedAt) },
                  { key: 'dischargedAt', header: 'Discharged', render: (a) => fmtDate(a.dischargedAt) },
                  { key: 'status', header: 'Status', render: (a) => <Badge value={a.status} /> },
                  {
                    key: 'summary',
                    header: 'Discharge summary',
                    wrap: true,
                    render: (a) => a.discharge ? (a.discharge.instructions || a.discharge.diagnosis || 'Available') : '—',
                  },
                ]}
              />
            </Card>
          </>
        )}
      </Async>
    </div>
  );
}
