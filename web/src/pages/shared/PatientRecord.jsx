import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Async, Badge, Card, ErrorNote, Table, Tabs, fmtDate, fmtDateTime, money, useApi } from '../../components/ui.jsx';

// The complete clinical picture for one patient. Used by doctors and by hospital
// staff — the API decides what each role is allowed to see, so one page serves
// both instead of two near-identical ones.
export default function PatientRecord() {
  const { patientId } = useParams();
  const { user } = useAuth();
  const [tab, setTab] = useState('consultations');
  const [error, setError] = useState(null);
  const query = useApi(() => api.get(`/patients/${patientId}/history`), [patientId]);
  const bills = useApi(() => api.get(`/patients/${patientId}/bills`), [patientId]);

  const isClinician = ['DOCTOR', 'RECEPTIONIST'].includes(user?.role);

  async function saveClinical(patch) {
    setError(null);
    try {
      await api.put(`/patients/${patientId}/clinical`, patch);
      query.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Async query={query}>
      {(d) => (
        <div className="stack">
          <div className="row between">
            <div>
              <h1 style={{ marginBottom: '.2rem' }}>{d.patient.user.fullName}</h1>
              <div className="muted small">
                {d.patient.user.mobile} · {d.patient.gender || 'Gender not recorded'} ·
                {' '}{d.patient.dateOfBirth ? `${age(d.patient.dateOfBirth)} years` : 'age unknown'} ·
                {' '}Blood group {d.patient.bloodGroup || 'unknown'}
              </div>
            </div>
            <div className="row">
              {d.patient.allergies && <Badge value={`Allergy: ${d.patient.allergies}`} tone="danger" />}
              {d.patient.chronicConditions && <span className="badge warn">{d.patient.chronicConditions}</span>}
            </div>
          </div>

          <ErrorNote error={error} />

          {isClinician && (
            <Card title="Clinical flags">
              <ClinicalFlags patient={d.patient} onSave={saveClinical} />
            </Card>
          )}

          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { value: 'consultations', label: `Consultations (${d.consultations.length})` },
              { value: 'prescriptions', label: `Prescriptions (${d.prescriptions.length})` },
              { value: 'labs', label: `Lab orders (${d.labOrders.length})` },
              { value: 'admissions', label: `Admissions (${d.admissions.length})` },
              { value: 'bills', label: 'Bills' },
            ]}
          />

          {tab === 'consultations' && (
            <Card>
              <div className="list">
                {d.consultations.length === 0 && <div className="empty">No consultations recorded.</div>}
                {d.consultations.map((c) => (
                  <div key={c.id} className="list-item">
                    <div className="row between">
                      <strong>{c.diagnoses.map((x) => x.description).join(', ') || 'Consultation'}</strong>
                      <span className="small muted">{fmtDateTime(c.startedAt)}</span>
                    </div>
                    <div className="small muted">{c.doctor.user.fullName} · {c.doctor.hospital.name}</div>
                    {c.symptoms && <div className="small">Symptoms: {c.symptoms}</div>}
                    {c.clinicalNotes && <div className="small">Notes: {c.clinicalNotes}</div>}
                    {c.treatmentPlan && <div className="small">Plan: {c.treatmentPlan}</div>}
                    {c.vitals && (
                      <div className="small muted">
                        BP {c.vitals.systolic}/{c.vitals.diastolic} · Pulse {c.vitals.heartRate} ·
                        Temp {c.vitals.temperatureC}°C · SpO₂ {c.vitals.spo2}% · {c.vitals.weightKg} kg
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {tab === 'prescriptions' && (
            <Card>
              <div className="stack">
                {d.prescriptions.length === 0 && <div className="empty">No prescriptions.</div>}
                {d.prescriptions.map((p) => (
                  <div key={p.id}>
                    <div className="row between" style={{ marginBottom: '.3rem' }}>
                      <strong className="small">{p.doctor.user.fullName}</strong>
                      <span className="small muted">{fmtDate(p.issuedAt)} · <Badge value={p.status} /></span>
                    </div>
                    <Table
                      rows={p.items}
                      columns={[
                        { key: 'medicineName', header: 'Medicine' },
                        { key: 'dosage', header: 'Dose' },
                        { key: 'frequency', header: 'Frequency' },
                        { key: 'durationDays', header: 'Days', num: true },
                        { key: 'instruction', header: 'Instruction', wrap: true },
                      ]}
                    />
                  </div>
                ))}
              </div>
            </Card>
          )}

          {tab === 'labs' && (
            <Card>
              <div className="stack">
                {d.labOrders.length === 0 && <div className="empty">No lab orders.</div>}
                {d.labOrders.map((o) => (
                  <div key={o.id}>
                    <div className="row between" style={{ marginBottom: '.3rem' }}>
                      <strong className="small">{fmtDate(o.orderedAt)}</strong>
                      <Badge value={o.status} />
                    </div>
                    <Table
                      rows={o.items}
                      columns={[
                        { key: 'test', header: 'Test', render: (i) => i.labTest.name },
                        { key: 'resultValue', header: 'Result', num: true },
                        { key: 'unit', header: 'Unit' },
                        { key: 'referenceRange', header: 'Reference' },
                        { key: 'flag', header: 'Flag', render: (i) => (i.flag ? <Badge value={i.flag} tone={i.flag === 'NORMAL' ? 'ok' : i.flag === 'CRITICAL' ? 'danger' : 'warn'} /> : '—') },
                      ]}
                    />
                  </div>
                ))}
              </div>
            </Card>
          )}

          {tab === 'admissions' && (
            <Card>
              <Table
                empty="No admissions."
                rows={d.admissions}
                columns={[
                  { key: 'hospital', header: 'Hospital', render: (a) => a.hospital.name },
                  { key: 'reason', header: 'Reason', wrap: true },
                  { key: 'bed', header: 'Bed', render: (a) => (a.bed ? `${a.bed.bedNumber} (${a.bed.ward})` : '—') },
                  { key: 'admittedAt', header: 'Admitted', render: (a) => fmtDate(a.admittedAt) },
                  { key: 'dischargedAt', header: 'Discharged', render: (a) => fmtDate(a.dischargedAt) },
                  { key: 'status', header: 'Status', render: (a) => <Badge value={a.status} /> },
                ]}
              />
            </Card>
          )}

          {tab === 'bills' && (
            <Card>
              <Async query={bills} empty="No bills.">
                {(list) => (
                  <Table
                    rows={list}
                    columns={[
                      { key: 'billNumber', header: 'Bill' },
                      { key: 'hospital', header: 'Hospital', render: (b) => b.hospital.name },
                      { key: 'createdAt', header: 'Date', render: (b) => fmtDate(b.createdAt) },
                      { key: 'total', header: 'Total', num: true, render: (b) => money(b.total) },
                      { key: 'paidAmount', header: 'Paid', num: true, render: (b) => money(b.paidAmount) },
                      { key: 'status', header: 'Status', render: (b) => <Badge value={b.status} /> },
                    ]}
                  />
                )}
              </Async>
            </Card>
          )}
        </div>
      )}
    </Async>
  );
}

function ClinicalFlags({ patient, onSave }) {
  const [allergies, setAllergies] = useState(patient.allergies || '');
  const [conditions, setConditions] = useState(patient.chronicConditions || '');
  return (
    <div className="grid cols-2">
      <div className="field">
        <label>Allergies</label>
        <input value={allergies} onChange={(e) => setAllergies(e.target.value)} placeholder="Penicillin, sulpha drugs" />
      </div>
      <div className="field">
        <label>Chronic conditions</label>
        <input value={conditions} onChange={(e) => setConditions(e.target.value)} placeholder="Hypertension, type 2 diabetes" />
      </div>
      <div>
        <button className="small" onClick={() => onSave({ allergies, chronicConditions: conditions })}>Save clinical flags</button>
      </div>
    </div>
  );
}

const age = (dob) => Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 86_400_000));
