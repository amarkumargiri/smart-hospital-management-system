import { useState } from 'react';
import { api } from '../../api.js';
import { Async, Badge, Card, ErrorNote, Modal, Table, fmtDateTime, useApi } from '../../components/ui.jsx';

const TRIAGE = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export default function Emergency() {
  const [registering, setRegistering] = useState(false);
  const [allocating, setAllocating] = useState(null);
  const [error, setError] = useState(null);
  const query = useApi(() => api.get('/emergency'), []);
  const doctors = useApi(() => api.get('/doctors', { pageSize: 100 }), []);

  async function update(id, patch) {
    setError(null);
    try {
      await api.put(`/emergency/${id}`, patch);
      query.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="stack">
      <div className="row between">
        <h1>Emergency department</h1>
        <button onClick={() => setRegistering(true)}>Register emergency patient</button>
      </div>

      <Card title="Active cases, highest priority first">
        <ErrorNote error={error} />
        <Async query={query} empty="No active emergency cases.">
          {(cases) => (
            <Table
              rows={cases}
              columns={[
                { key: 'triage', header: 'Triage', render: (c) => <Badge value={c.triage} tone={c.triage === 'CRITICAL' ? 'danger' : c.triage === 'HIGH' ? 'warn' : undefined} /> },
                { key: 'patient', header: 'Patient', render: (c) => c.patient?.user.fullName || c.walkInName },
                { key: 'contact', header: 'Contact', render: (c) => c.patient?.user.mobile || c.walkInPhone || '—' },
                { key: 'complaint', header: 'Presenting complaint', wrap: true },
                { key: 'arrivedAt', header: 'Arrived', render: (c) => fmtDateTime(c.arrivedAt) },
                { key: 'status', header: 'Status', render: (c) => <Badge value={c.status} /> },
                {
                  key: 'actions',
                  header: '',
                  render: (c) => (
                    <span className="row">
                      <select
                        value={c.triage}
                        onChange={(e) => update(c.id, { triage: e.target.value })}
                        style={{ width: 110 }}
                      >
                        {TRIAGE.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <select
                        value={c.assignedDoctorId || ''}
                        onChange={(e) => update(c.id, { assignedDoctorId: e.target.value })}
                        style={{ width: 160 }}
                      >
                        <option value="">Assign doctor</option>
                        {(doctors.data?.items || []).map((d) => <option key={d.id} value={d.id}>{d.user.fullName}</option>)}
                      </select>
                      <button className="small ghost" onClick={() => setAllocating(c)}>Bed</button>
                      <button className="small ghost" onClick={() => update(c.id, { status: 'DISCHARGED' })}>Close</button>
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Async>
      </Card>

      {registering && (
        <RegisterDialog
          doctors={doctors.data?.items || []}
          onClose={() => setRegistering(false)}
          onDone={() => { setRegistering(false); query.reload(); }}
        />
      )}

      {allocating && (
        <BedDialog
          emergencyCase={allocating}
          onClose={() => setAllocating(null)}
          onDone={() => { setAllocating(null); query.reload(); }}
        />
      )}
    </div>
  );
}

function RegisterDialog({ doctors, onClose, onDone }) {
  const [mode, setMode] = useState('walkIn');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ patientId: '', walkInName: '', walkInPhone: '', triage: 'MEDIUM', complaint: '', assignedDoctorId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const patients = useApi(() => api.get('/patients', { q: search, pageSize: 20 }), [search], { skip: mode !== 'registered' });

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/emergency', {
        triage: form.triage,
        complaint: form.complaint,
        assignedDoctorId: form.assignedDoctorId || undefined,
        ...(mode === 'registered'
          ? { patientId: form.patientId }
          : { walkInName: form.walkInName, walkInPhone: form.walkInPhone || undefined }),
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const ready = form.complaint.length >= 3 && (mode === 'registered' ? form.patientId : form.walkInName);

  return (
    <Modal
      title="Register emergency patient"
      onClose={onClose}
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={submit} disabled={busy || !ready}>{busy ? 'Registering…' : 'Register'}</button>
        </>
      )}
    >
      <div className="row" style={{ marginBottom: '.8rem' }}>
        <button className={mode === 'walkIn' ? 'small' : 'small ghost'} onClick={() => setMode('walkIn')}>Walk-in / unknown</button>
        <button className={mode === 'registered' ? 'small' : 'small ghost'} onClick={() => setMode('registered')}>Registered patient</button>
      </div>

      {mode === 'walkIn' ? (
        <div className="grid cols-2">
          <div className="field"><label>Name (as given)</label><input value={form.walkInName} onChange={set('walkInName')} /></div>
          <div className="field"><label>Phone</label><input value={form.walkInPhone} onChange={set('walkInPhone')} /></div>
        </div>
      ) : (
        <>
          <div className="field"><label>Search patient</label><input value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <div className="field">
            <label>Patient</label>
            <select value={form.patientId} onChange={set('patientId')}>
              <option value="">Select</option>
              {(patients.data?.items || []).map((p) => <option key={p.id} value={p.id}>{p.user.fullName} — {p.user.mobile}</option>)}
            </select>
          </div>
        </>
      )}

      <div className="grid cols-2">
        <div className="field">
          <label>Triage priority</label>
          <select value={form.triage} onChange={set('triage')}>
            {TRIAGE.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Assign doctor</label>
          <select value={form.assignedDoctorId} onChange={set('assignedDoctorId')}>
            <option value="">Unassigned</option>
            {doctors.map((d) => <option key={d.id} value={d.id}>{d.user.fullName}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Presenting complaint</label>
        <textarea value={form.complaint} onChange={set('complaint')} placeholder="Road traffic accident — multiple injuries" />
      </div>
      <ErrorNote error={error} />
    </Modal>
  );
}

function BedDialog({ emergencyCase, onClose, onDone }) {
  const [error, setError] = useState(null);
  const beds = useApi(() => api.get('/beds', { status: 'AVAILABLE' }), []);

  async function pick(bedId) {
    setError(null);
    try {
      await api.post(`/emergency/${emergencyCase.id}/allocate-bed`, { bedId });
      onDone();
    } catch (err) {
      setError(err);
      beds.reload();
    }
  }

  return (
    <Modal title="Allocate a bed" onClose={onClose}>
      <ErrorNote error={error} />
      <Async query={beds} empty="No free beds available.">
        {(list) => (
          <div className="bed-grid">
            {list.map((b) => (
              <div key={b.id} className="bed AVAILABLE" onClick={() => pick(b.id)} title={`${b.ward} · ${b.type}`}>
                <div><strong>{b.bedNumber}</strong></div>
                <div style={{ fontSize: '.62rem' }}>{b.type.toLowerCase()}</div>
              </div>
            ))}
          </div>
        )}
      </Async>
    </Modal>
  );
}
