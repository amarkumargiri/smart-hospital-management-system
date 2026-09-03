import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { Async, Badge, Card, ErrorNote, Modal, Table, fmtDateTime, money, useApi } from '../../components/ui.jsx';

const isoDate = (d) => d.toISOString().slice(0, 10);

export default function ReceptionAppointments() {
  const [filters, setFilters] = useState({
    status: '', q: '', doctorId: '',
    from: isoDate(new Date()), to: isoDate(new Date(Date.now() + 7 * 86_400_000)),
  });
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState(null);

  const doctors = useApi(() => api.get('/doctors', { pageSize: 100 }), []);
  const query = useApi(
    () => api.get('/appointments', {
      ...filters,
      from: `${filters.from}T00:00:00.000Z`,
      to: `${filters.to}T23:59:59.000Z`,
      pageSize: 200,
    }),
    [filters],
  );

  const set = (key) => (e) => setFilters({ ...filters, [key]: e.target.value });

  async function move(id, status) {
    setError(null);
    try {
      await api.post(`/appointments/${id}/status`, { status });
      query.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="stack">
      <div className="row between">
        <h1>Appointments</h1>
        <button onClick={() => setBooking(true)}>Book for a patient</button>
      </div>

      <Card>
        <div className="grid cols-4">
          <div className="field"><label>From</label><input type="date" value={filters.from} onChange={set('from')} /></div>
          <div className="field"><label>To</label><input type="date" value={filters.to} onChange={set('to')} /></div>
          <div className="field">
            <label>Doctor</label>
            <select value={filters.doctorId} onChange={set('doctorId')}>
              <option value="">All doctors</option>
              {(doctors.data?.items || []).map((d) => <option key={d.id} value={d.id}>{d.user.fullName}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select value={filters.status} onChange={set('status')}>
              <option value="">All</option>
              <option value="REQUESTED">Requested</option>
              <option value="CONFIRMED">Confirmed</option>
              <option value="CHECKED_IN,IN_CONSULTATION">In clinic</option>
              <option value="COMPLETED">Completed</option>
              <option value="CANCELLED,REJECTED,NO_SHOW">Cancelled / missed</option>
            </select>
          </div>
          <div className="field"><label>Patient name</label><input value={filters.q} onChange={set('q')} placeholder="Search" /></div>
        </div>
      </Card>

      <Card title="Schedule">
        <ErrorNote error={error} />
        <Async query={query} empty="No appointments in this range.">
          {(d) => (
            <Table
              rows={d.items}
              columns={[
                { key: 'when', header: 'When', render: (a) => fmtDateTime(a.scheduledAt) },
                { key: 'token', header: 'Token', render: (a) => a.tokenNumber || '—' },
                { key: 'patient', header: 'Patient', render: (a) => <Link to={`/reception/patients/${a.patientId}`}>{a.patient.user.fullName}</Link> },
                { key: 'mobile', header: 'Contact', render: (a) => a.patient.user.mobile },
                { key: 'doctor', header: 'Doctor', render: (a) => a.doctor.user.fullName },
                { key: 'department', header: 'Department', render: (a) => a.department?.name || '—' },
                { key: 'fee', header: 'Fee', num: true, render: (a) => money(a.fee) },
                { key: 'status', header: 'Status', render: (a) => <Badge value={a.status} /> },
                {
                  key: 'actions',
                  header: '',
                  render: (a) => (
                    <span className="row">
                      {a.status === 'REQUESTED' && <button className="small" onClick={() => move(a.id, 'CONFIRMED')}>Confirm</button>}
                      {a.status === 'CONFIRMED' && <button className="small" onClick={() => move(a.id, 'CHECKED_IN')}>Check in</button>}
                      {['REQUESTED', 'CONFIRMED'].includes(a.status) && (
                        <button className="small ghost" onClick={() => move(a.id, 'CANCELLED')}>Cancel</button>
                      )}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Async>
      </Card>

      {booking && (
        <BookDialog
          doctors={doctors.data?.items || []}
          onClose={() => setBooking(false)}
          onDone={() => { setBooking(false); query.reload(); }}
        />
      )}
    </div>
  );
}

// Reception booking: pick the patient, the doctor, then a free slot the API
// itself computed — no chance of offering a time the doctor does not work.
function BookDialog({ doctors, onClose, onDone }) {
  const [search, setSearch] = useState('');
  const [patientId, setPatientId] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [date, setDate] = useState(isoDate(new Date()));
  const [slot, setSlot] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const patients = useApi(() => api.get('/patients', { q: search, pageSize: 20 }), [search]);
  const slots = useApi(() => api.get(`/doctors/${doctorId}/slots`, { date }), [doctorId, date], { skip: !doctorId });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/appointments', { patientId, doctorId, scheduledAt: slot, reason, type: 'OPD' });
      onDone();
    } catch (err) {
      setError(err);
      slots.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Book an appointment"
      onClose={onClose}
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={submit} disabled={busy || !patientId || !slot}>{busy ? 'Booking…' : 'Confirm booking'}</button>
        </>
      )}
    >
      <div className="field">
        <label>Search patient</label>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, mobile or email" />
      </div>
      <div className="field">
        <label>Patient</label>
        <select value={patientId} onChange={(e) => setPatientId(e.target.value)}>
          <option value="">Select a patient</option>
          {(patients.data?.items || []).map((p) => (
            <option key={p.id} value={p.id}>{p.user.fullName} — {p.user.mobile}</option>
          ))}
        </select>
      </div>
      <div className="grid cols-2">
        <div className="field">
          <label>Doctor</label>
          <select value={doctorId} onChange={(e) => { setDoctorId(e.target.value); setSlot(''); }}>
            <option value="">Select a doctor</option>
            {doctors.map((d) => <option key={d.id} value={d.id}>{d.user.fullName} — {d.specialization}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Date</label>
          <input type="date" min={isoDate(new Date())} value={date} onChange={(e) => { setDate(e.target.value); setSlot(''); }} />
        </div>
      </div>
      {doctorId && (
        <div className="field">
          <label>Available slots</label>
          {slots.loading && <span className="small muted">Checking…</span>}
          {slots.data?.slots.length === 0 && <div className="small muted">No free slots on this date.</div>}
          <div className="row">
            {(slots.data?.slots || []).map((s) => (
              <button
                key={s.startsAt}
                className={slot === s.startsAt ? 'small' : 'small ghost'}
                onClick={() => setSlot(s.startsAt)}
              >
                {new Date(s.startsAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="field">
        <label>Reason for visit</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <ErrorNote error={error} />
    </Modal>
  );
}
