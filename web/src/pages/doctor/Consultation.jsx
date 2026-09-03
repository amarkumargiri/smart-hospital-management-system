import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { Badge, Card, ErrorNote, Loading, Table, fmtDate, fmtDateTime, money, useApi } from '../../components/ui.jsx';

const EMPTY_MEDICINE = { medicineName: '', dosage: '', frequency: '', durationDays: 5, route: 'ORAL', instruction: '' };

export default function Consultation() {
  const { appointmentId } = useParams();
  const navigate = useNavigate();

  const [consultation, setConsultation] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const [notes, setNotes] = useState({ symptoms: '', clinicalNotes: '', treatmentPlan: '', followUpDate: '' });
  const [vitals, setVitals] = useState({});
  const [diagnosis, setDiagnosis] = useState({ code: '', description: '', severity: 'MODERATE', isPrimary: true });
  const [medicines, setMedicines] = useState([{ ...EMPTY_MEDICINE }]);
  const [selectedTests, setSelectedTests] = useState([]);

  const tests = useApi(() => api.get('/lab/tests'), []);
  const history = useApi(
    () => api.get(`/patients/${consultation.patientId}/history`),
    [consultation?.patientId],
    { skip: !consultation },
  );

  // Opening this page is what starts (or resumes) the consultation.
  useEffect(() => {
    let cancelled = false;
    api.post('/consultations', { appointmentId })
      .then((c) => {
        if (cancelled) return;
        setConsultation(c);
        setNotes({
          symptoms: c.symptoms || c.appointment?.reason || '',
          clinicalNotes: c.clinicalNotes || '',
          treatmentPlan: c.treatmentPlan || '',
          followUpDate: c.followUpDate ? new Date(c.followUpDate).toISOString().slice(0, 10) : '',
        });
        setVitals(c.vitals || {});
      })
      .catch((err) => !cancelled && setError(err));
    return () => { cancelled = true; };
  }, [appointmentId]);

  if (error && !consultation) return <ErrorNote error={error} />;
  if (!consultation) return <Loading label="Opening consultation…" />;

  const done = consultation.status === 'COMPLETED';

  const refresh = async () => setConsultation(await api.get(`/consultations/${consultation.id}`));
  const guard = async (fn, message) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (message) setNotice(message);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const saveNotes = () => guard(async () => {
    await api.put(`/consultations/${consultation.id}`, {
      ...notes,
      followUpDate: notes.followUpDate ? new Date(notes.followUpDate).toISOString() : null,
    });
    await refresh();
  }, 'Notes saved.');

  const saveVitals = () => guard(async () => {
    const numeric = Object.fromEntries(
      Object.entries(vitals)
        .filter(([k, v]) => v !== '' && v !== null && !['id', 'consultationId', 'recordedAt'].includes(k))
        .map(([k, v]) => [k, Number(v)]),
    );
    await api.put(`/consultations/${consultation.id}/vitals`, numeric);
    await refresh();
  }, 'Vitals recorded.');

  const addDiagnosis = () => guard(async () => {
    await api.post(`/consultations/${consultation.id}/diagnoses`, diagnosis);
    setDiagnosis({ code: '', description: '', severity: 'MODERATE', isPrimary: false });
    await refresh();
  }, 'Diagnosis added.');

  const prescribe = () => guard(async () => {
    await api.post('/prescriptions', {
      patientId: consultation.patientId,
      consultationId: consultation.id,
      items: medicines
        .filter((m) => m.medicineName && m.dosage && m.frequency)
        .map((m) => ({ ...m, durationDays: Number(m.durationDays) })),
    });
    setMedicines([{ ...EMPTY_MEDICINE }]);
    await refresh();
  }, 'Prescription issued.');

  const orderTests = () => guard(async () => {
    await api.post('/lab/orders', {
      patientId: consultation.patientId,
      consultationId: consultation.id,
      testIds: selectedTests,
    });
    setSelectedTests([]);
    await refresh();
  }, 'Lab tests ordered.');

  const complete = () => guard(async () => {
    await api.post(`/consultations/${consultation.id}/complete`);
    navigate('/doctor');
  });

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <h1 style={{ marginBottom: '.2rem' }}>{consultation.patient.user.fullName}</h1>
          <div className="muted small">
            {consultation.patient.user.mobile} · appointment {fmtDateTime(consultation.appointment.scheduledAt)}
          </div>
        </div>
        <div className="row">
          <Badge value={consultation.status} />
          {!done && <button onClick={complete} disabled={busy}>Complete consultation</button>}
        </div>
      </div>

      {notice && <div className="alert ok">{notice}</div>}
      <ErrorNote error={error} />
      {done && <div className="alert info">This consultation is complete and can no longer be edited.</div>}

      <div className="grid cols-2">
        <Card title="Consultation notes">
          <div className="field">
            <label>Symptoms</label>
            <textarea value={notes.symptoms} onChange={(e) => setNotes({ ...notes, symptoms: e.target.value })} disabled={done} />
          </div>
          <div className="field">
            <label>Clinical notes</label>
            <textarea value={notes.clinicalNotes} onChange={(e) => setNotes({ ...notes, clinicalNotes: e.target.value })} disabled={done} />
          </div>
          <div className="field">
            <label>Treatment plan</label>
            <textarea value={notes.treatmentPlan} onChange={(e) => setNotes({ ...notes, treatmentPlan: e.target.value })} disabled={done} />
          </div>
          <div className="field">
            <label>Follow-up date</label>
            <input type="date" value={notes.followUpDate} onChange={(e) => setNotes({ ...notes, followUpDate: e.target.value })} disabled={done} />
          </div>
          <button onClick={saveNotes} disabled={busy || done}>Save notes</button>
        </Card>

        <Card title="Vitals">
          <div className="grid cols-2">
            {[
              ['temperatureC', 'Temperature (°C)'],
              ['systolic', 'Systolic BP'],
              ['diastolic', 'Diastolic BP'],
              ['heartRate', 'Heart rate (bpm)'],
              ['respiratoryRate', 'Respiratory rate'],
              ['spo2', 'SpO₂ (%)'],
              ['weightKg', 'Weight (kg)'],
              ['heightCm', 'Height (cm)'],
            ].map(([key, label]) => (
              <div className="field" key={key}>
                <label>{label}</label>
                <input
                  type="number" step="0.1"
                  value={vitals[key] ?? ''}
                  onChange={(e) => setVitals({ ...vitals, [key]: e.target.value })}
                  disabled={done}
                />
              </div>
            ))}
          </div>
          <button onClick={saveVitals} disabled={busy || done}>Record vitals</button>
        </Card>
      </div>

      <Card title="Diagnosis">
        <Table
          empty="No diagnosis recorded yet — at least one is required to complete the consultation."
          rows={consultation.diagnoses}
          columns={[
            { key: 'code', header: 'ICD code' },
            { key: 'description', header: 'Diagnosis', wrap: true },
            { key: 'severity', header: 'Severity', render: (d) => <Badge value={d.severity} /> },
            { key: 'isPrimary', header: 'Primary', render: (d) => (d.isPrimary ? 'Yes' : 'No') },
            {
              key: 'actions',
              header: '',
              render: (d) => !done && (
                <button
                  className="small ghost"
                  onClick={() => guard(async () => {
                    await api.del(`/consultations/${consultation.id}/diagnoses/${d.id}`);
                    await refresh();
                  })}
                >
                  Remove
                </button>
              ),
            },
          ]}
        />
        {!done && (
          <div className="grid cols-4" style={{ marginTop: '.8rem' }}>
            <div className="field"><label>ICD-10 code</label><input value={diagnosis.code} onChange={(e) => setDiagnosis({ ...diagnosis, code: e.target.value })} placeholder="J06.9" /></div>
            <div className="field"><label>Description</label><input value={diagnosis.description} onChange={(e) => setDiagnosis({ ...diagnosis, description: e.target.value })} placeholder="Acute upper respiratory infection" /></div>
            <div className="field">
              <label>Severity</label>
              <select value={diagnosis.severity} onChange={(e) => setDiagnosis({ ...diagnosis, severity: e.target.value })}>
                <option value="MILD">Mild</option><option value="MODERATE">Moderate</option><option value="SEVERE">Severe</option>
              </select>
            </div>
            <div className="field" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              <label className="row small">
                <input type="checkbox" style={{ width: 'auto' }} checked={diagnosis.isPrimary} onChange={(e) => setDiagnosis({ ...diagnosis, isPrimary: e.target.checked })} />
                Primary
              </label>
              <button className="small" onClick={addDiagnosis} disabled={busy || !diagnosis.description}>Add diagnosis</button>
            </div>
          </div>
        )}
      </Card>

      <div className="grid cols-2">
        <Card title="Prescription">
          {consultation.prescriptions.map((p) => (
            <div key={p.id} className="list-item" style={{ marginBottom: '.5rem' }}>
              <div className="small muted">Issued {fmtDateTime(p.issuedAt)}</div>
              {p.items.map((i) => (
                <div key={i.id} className="small">{i.medicineName} {i.dosage} · {i.frequency} · {i.durationDays} days</div>
              ))}
            </div>
          ))}
          {!done && (
            <>
              {medicines.map((m, idx) => (
                <div key={idx} className="grid cols-3" style={{ borderTop: idx ? '1px solid var(--border)' : 'none', paddingTop: idx ? '.6rem' : 0 }}>
                  <div className="field"><label>Medicine</label><input value={m.medicineName} onChange={(e) => updateMedicine(idx, 'medicineName', e.target.value)} placeholder="Paracetamol" /></div>
                  <div className="field"><label>Dose</label><input value={m.dosage} onChange={(e) => updateMedicine(idx, 'dosage', e.target.value)} placeholder="500 mg" /></div>
                  <div className="field"><label>Frequency</label><input value={m.frequency} onChange={(e) => updateMedicine(idx, 'frequency', e.target.value)} placeholder="2 times/day" /></div>
                  <div className="field"><label>Duration (days)</label><input type="number" min="1" value={m.durationDays} onChange={(e) => updateMedicine(idx, 'durationDays', e.target.value)} /></div>
                  <div className="field">
                    <label>Route</label>
                    <select value={m.route} onChange={(e) => updateMedicine(idx, 'route', e.target.value)}>
                      {['ORAL', 'IV', 'IM', 'TOPICAL', 'INHALED'].map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div className="field"><label>Instruction</label><input value={m.instruction} onChange={(e) => updateMedicine(idx, 'instruction', e.target.value)} placeholder="After food" /></div>
                </div>
              ))}
              <div className="row">
                <button className="ghost small" onClick={() => setMedicines([...medicines, { ...EMPTY_MEDICINE }])}>Add another medicine</button>
                <button className="small" onClick={prescribe} disabled={busy || !medicines[0].medicineName}>Issue prescription</button>
              </div>
            </>
          )}
        </Card>

        <Card title="Laboratory orders">
          {consultation.labOrders.map((o) => (
            <div key={o.id} className="list-item" style={{ marginBottom: '.5rem' }}>
              <div className="row between">
                <span className="small">{o.items.map((i) => i.labTest.name).join(', ')}</span>
                <Badge value={o.status} />
              </div>
              {o.items.filter((i) => i.resultValue).map((i) => (
                <div key={i.id} className="small muted">{i.labTest.name}: {i.resultValue} {i.unit} ({i.flag})</div>
              ))}
            </div>
          ))}
          {!done && tests.data && (
            <>
              <label>Select tests to order</label>
              <div className="row" style={{ marginBottom: '.7rem' }}>
                {tests.data.map((t) => (
                  <button
                    key={t.id}
                    className={selectedTests.includes(t.id) ? 'small' : 'small ghost'}
                    onClick={() => setSelectedTests(
                      selectedTests.includes(t.id) ? selectedTests.filter((x) => x !== t.id) : [...selectedTests, t.id],
                    )}
                  >
                    {t.name} · {money(t.price)}
                  </button>
                ))}
              </div>
              <button onClick={orderTests} disabled={busy || !selectedTests.length}>
                Order {selectedTests.length || ''} test{selectedTests.length === 1 ? '' : 's'}
              </button>
            </>
          )}
        </Card>
      </div>

      <Card title="Patient history">
        {history.loading && <Loading />}
        {history.data && (
          <>
            <div className="row small" style={{ marginBottom: '.7rem' }}>
              <span className="badge">Blood group {history.data.patient.bloodGroup || 'unknown'}</span>
              {history.data.patient.allergies && <Badge value={`Allergy: ${history.data.patient.allergies}`} tone="danger" />}
              {history.data.patient.chronicConditions && <span className="badge warn">{history.data.patient.chronicConditions}</span>}
            </div>
            <Table
              empty="No previous consultations."
              rows={history.data.consultations.filter((c) => c.id !== consultation.id).slice(0, 10)}
              columns={[
                { key: 'date', header: 'Date', render: (c) => fmtDate(c.startedAt) },
                { key: 'doctor', header: 'Doctor', render: (c) => c.doctor.user.fullName },
                { key: 'diagnosis', header: 'Diagnosis', wrap: true, render: (c) => c.diagnoses.map((d) => d.description).join(', ') || '—' },
                { key: 'notes', header: 'Notes', wrap: true, render: (c) => c.clinicalNotes || '—' },
              ]}
            />
          </>
        )}
      </Card>
    </div>
  );

  function updateMedicine(index, key, value) {
    setMedicines(medicines.map((m, i) => (i === index ? { ...m, [key]: value } : m)));
  }
}
