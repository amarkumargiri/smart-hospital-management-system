import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { Async, Badge, Card, ErrorNote, Modal, Table, fmtDate, useApi } from '../../components/ui.jsx';

export default function DoctorAdmissions() {
  const [status, setStatus] = useState('REQUESTED,APPROVED,ADMITTED');
  const [discharging, setDischarging] = useState(null);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState(null);
  const query = useApi(() => api.get('/admissions', { status, pageSize: 100 }), [status]);

  return (
    <div className="stack">
      <div className="row between">
        <h1>Inpatients</h1>
        <button onClick={() => setRequesting(true)}>Request admission</button>
      </div>

      <Card
        action={(
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 220 }}>
            <option value="REQUESTED,APPROVED,ADMITTED">Open</option>
            <option value="ADMITTED">Currently admitted</option>
            <option value="DISCHARGED">Discharged</option>
            <option value="">All</option>
          </select>
        )}
      >
        <ErrorNote error={error} />
        <Async query={query} empty="No admissions.">
          {(d) => (
            <Table
              rows={d.items}
              columns={[
                { key: 'patient', header: 'Patient', render: (a) => <Link to={`/doctor/patients/${a.patientId}`}>{a.patient.user.fullName}</Link> },
                { key: 'reason', header: 'Reason', wrap: true },
                { key: 'diagnosis', header: 'Diagnosis', wrap: true },
                { key: 'bed', header: 'Bed', render: (a) => (a.bed ? `${a.bed.bedNumber} (${a.bed.ward})` : '—') },
                { key: 'admittedAt', header: 'Admitted', render: (a) => fmtDate(a.admittedAt) },
                { key: 'status', header: 'Status', render: (a) => <Badge value={a.status} /> },
                {
                  key: 'actions',
                  header: '',
                  render: (a) => a.status === 'ADMITTED' && (
                    <button className="small ghost" onClick={() => setDischarging(a)}>Discharge</button>
                  ),
                },
              ]}
            />
          )}
        </Async>
      </Card>

      {requesting && (
        <RequestDialog
          onClose={() => setRequesting(false)}
          onDone={() => { setRequesting(false); query.reload(); }}
          onError={setError}
        />
      )}
      {discharging && (
        <DischargeDialog
          admission={discharging}
          onClose={() => setDischarging(null)}
          onDone={() => { setDischarging(null); query.reload(); }}
        />
      )}
    </div>
  );
}

function RequestDialog({ onClose, onDone, onError }) {
  const [patientId, setPatientId] = useState('');
  const [reason, setReason] = useState('');
  const [diagnosis, setDiagnosis] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The doctor can only admit someone they have already seen, so the picker is
  // built from their own appointment list.
  const appointments = useApi(() => api.get('/appointments', { pageSize: 200 }), []);

  const patients = [...new Map((appointments.data?.items || [])
    .map((a) => [a.patientId, a.patient.user.fullName])).entries()];

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/admissions', { patientId, reason, diagnosis: diagnosis || undefined });
      onDone();
    } catch (err) {
      setError(err);
      onError?.(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Request admission"
      onClose={onClose}
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={submit} disabled={busy || !patientId || reason.length < 3}>Submit request</button>
        </>
      )}
    >
      <div className="field">
        <label>Patient</label>
        <select value={patientId} onChange={(e) => setPatientId(e.target.value)}>
          <option value="">Select a patient</option>
          {patients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Reason for admission</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Requires intravenous antibiotics" />
      </div>
      <div className="field">
        <label>Working diagnosis</label>
        <input value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} />
      </div>
      <ErrorNote error={error} />
      <p className="small muted">The ward will approve the request and allocate a bed.</p>
    </Modal>
  );
}

export function DischargeDialog({ admission, onClose, onDone }) {
  const [form, setForm] = useState({
    diagnosis: admission.diagnosis || '', procedures: '', medications: '', testSummary: '',
    instructions: '', followUpDate: '', dischargeType: 'ROUTINE',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/admissions/${admission.id}/discharge`, {
        ...form,
        followUpDate: form.followUpDate ? new Date(form.followUpDate).toISOString() : undefined,
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Discharge ${admission.patient.user.fullName}`}
      onClose={onClose}
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={submit} disabled={busy}>{busy ? 'Discharging…' : 'Discharge and generate bill'}</button>
        </>
      )}
    >
      <div className="field"><label>Final diagnosis</label><input value={form.diagnosis} onChange={set('diagnosis')} /></div>
      <div className="field"><label>Procedures performed</label><textarea value={form.procedures} onChange={set('procedures')} /></div>
      <div className="field"><label>Medications on discharge</label><textarea value={form.medications} onChange={set('medications')} /></div>
      <div className="field"><label>Investigation summary</label><textarea value={form.testSummary} onChange={set('testSummary')} /></div>
      <div className="field"><label>Instructions for the patient</label><textarea value={form.instructions} onChange={set('instructions')} /></div>
      <div className="grid cols-2">
        <div className="field"><label>Follow-up date</label><input type="date" value={form.followUpDate} onChange={set('followUpDate')} /></div>
        <div className="field">
          <label>Discharge type</label>
          <select value={form.dischargeType} onChange={set('dischargeType')}>
            <option value="ROUTINE">Routine</option>
            <option value="LAMA">Left against medical advice</option>
            <option value="REFERRED">Referred</option>
            <option value="DEATH">Death</option>
          </select>
        </div>
      </div>
      <ErrorNote error={error} />
    </Modal>
  );
}
