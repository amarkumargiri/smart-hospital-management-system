import { useState } from 'react';
import { api } from '../../api.js';
import { Async, Badge, Card, ErrorNote, Modal, Table, fmtDateTime, money, useApi } from '../../components/ui.jsx';

const isoDate = (d) => d.toISOString().slice(0, 10);

export default function OperationTheatres() {
  const [scheduling, setScheduling] = useState(false);
  const [error, setError] = useState(null);
  const rooms = useApi(() => api.get('/ot/rooms'), []);
  const surgeries = useApi(
    () => api.get('/ot/surgeries', {
      from: `${isoDate(new Date(Date.now() - 7 * 86_400_000))}T00:00:00.000Z`,
      to: `${isoDate(new Date(Date.now() + 14 * 86_400_000))}T23:59:59.000Z`,
    }),
    [],
  );

  async function move(id, status) {
    setError(null);
    try {
      await api.post(`/ot/surgeries/${id}/status`, { status });
      surgeries.reload();
      rooms.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="stack">
      <div className="row between">
        <h1>Operation theatres</h1>
        <button onClick={() => setScheduling(true)}>Schedule surgery</button>
      </div>

      <ErrorNote error={error} />

      <Async query={rooms} empty="No operation theatres configured.">
        {(list) => (
          <div className="grid cols-4">
            {list.map((r) => (
              <Card key={r.id} title={r.name}>
                <Badge value={r.status} />
                <div className="small muted" style={{ marginTop: '.5rem' }}>
                  {r.surgeries.length === 0 ? 'Nothing scheduled' : `${r.surgeries.length} upcoming`}
                </div>
                {r.surgeries.slice(0, 2).map((s) => (
                  <div key={s.id} className="small" style={{ marginTop: '.3rem' }}>
                    {fmtDateTime(s.scheduledAt)} · {s.procedure}
                  </div>
                ))}
              </Card>
            ))}
          </div>
        )}
      </Async>

      <Card title="Surgery schedule">
        <Async query={surgeries} empty="No surgeries scheduled.">
          {(list) => (
            <Table
              rows={list}
              columns={[
                { key: 'when', header: 'When', render: (s) => fmtDateTime(s.scheduledAt) },
                { key: 'room', header: 'Theatre', render: (s) => s.operatingRoom.name },
                { key: 'patient', header: 'Patient', render: (s) => s.admission?.patient.user.fullName || '—' },
                { key: 'procedure', header: 'Procedure', wrap: true },
                { key: 'surgeon', header: 'Surgeon', render: (s) => s.surgeon.user.fullName },
                { key: 'durationMinutes', header: 'Duration', num: true, render: (s) => `${s.durationMinutes} min` },
                { key: 'charge', header: 'Charge', num: true, render: (s) => money(s.charge) },
                { key: 'status', header: 'Status', render: (s) => <Badge value={s.status} /> },
                {
                  key: 'actions',
                  header: '',
                  render: (s) => (
                    <span className="row">
                      {s.status === 'SCHEDULED' && (
                        <>
                          <button className="small" onClick={() => move(s.id, 'IN_PROGRESS')}>Start</button>
                          <button className="small ghost" onClick={() => move(s.id, 'CANCELLED')}>Cancel</button>
                        </>
                      )}
                      {s.status === 'IN_PROGRESS' && <button className="small" onClick={() => move(s.id, 'COMPLETED')}>Complete</button>}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Async>
      </Card>

      {scheduling && (
        <ScheduleDialog
          rooms={rooms.data || []}
          onClose={() => setScheduling(false)}
          onDone={() => { setScheduling(false); surgeries.reload(); rooms.reload(); }}
        />
      )}
    </div>
  );
}

function ScheduleDialog({ rooms, onClose, onDone }) {
  const [form, setForm] = useState({
    operatingRoomId: rooms[0]?.id || '', surgeonId: '', admissionId: '', procedure: '',
    scheduledAt: '', durationMinutes: 90, charge: 0, notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const doctors = useApi(() => api.get('/doctors', { pageSize: 100 }), []);
  const admissions = useApi(() => api.get('/admissions', { status: 'ADMITTED', pageSize: 100 }), []);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/ot/surgeries', {
        ...form,
        admissionId: form.admissionId || undefined,
        scheduledAt: new Date(form.scheduledAt).toISOString(),
        durationMinutes: Number(form.durationMinutes),
        charge: Number(form.charge),
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
      title="Schedule a surgery"
      onClose={onClose}
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={submit} disabled={busy || !form.procedure || !form.scheduledAt || !form.surgeonId}>
            {busy ? 'Scheduling…' : 'Schedule'}
          </button>
        </>
      )}
    >
      <div className="grid cols-2">
        <div className="field">
          <label>Operation theatre</label>
          <select value={form.operatingRoomId} onChange={set('operatingRoomId')}>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Surgeon</label>
          <select value={form.surgeonId} onChange={set('surgeonId')}>
            <option value="">Select</option>
            {(doctors.data?.items || []).map((d) => <option key={d.id} value={d.id}>{d.user.fullName}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Patient (admitted)</label>
        <select value={form.admissionId} onChange={set('admissionId')}>
          <option value="">Not linked to an admission</option>
          {(admissions.data?.items || []).map((a) => (
            <option key={a.id} value={a.id}>{a.patient.user.fullName} — {a.bed?.bedNumber}</option>
          ))}
        </select>
      </div>
      <div className="field"><label>Procedure</label><input value={form.procedure} onChange={set('procedure')} placeholder="Laparoscopic cholecystectomy" /></div>
      <div className="grid cols-3">
        <div className="field"><label>Date and time</label><input type="datetime-local" value={form.scheduledAt} onChange={set('scheduledAt')} /></div>
        <div className="field"><label>Duration (minutes)</label><input type="number" min="15" step="15" value={form.durationMinutes} onChange={set('durationMinutes')} /></div>
        <div className="field"><label>Charge</label><input type="number" min="0" value={form.charge} onChange={set('charge')} /></div>
      </div>
      <ErrorNote error={error} />
      <p className="small muted">Overlapping bookings in the same theatre are rejected.</p>
    </Modal>
  );
}
