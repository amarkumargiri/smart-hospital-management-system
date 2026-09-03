import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { Async, Card, ErrorNote, Loading, fmtDate, fmtTime, money, useApi } from '../../components/ui.jsx';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const isoDate = (d) => d.toISOString().slice(0, 10);

export default function DoctorDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [date, setDate] = useState(isoDate(new Date(Date.now() + 86_400_000)));
  const [selected, setSelected] = useState(null);
  const [type, setType] = useState('OPD');
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const doctor = useApi(() => api.get(`/doctors/${id}`), [id]);
  const slots = useApi(() => api.get(`/doctors/${id}/slots`, { date }), [id, date]);

  async function book(e) {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/appointments', { doctorId: id, scheduledAt: selected, type, reason });
      navigate('/app/appointments');
    } catch (err) {
      setError(err);
      setSelected(null);
      slots.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Async query={doctor}>
      {(d) => (
        <div className="stack">
          <div className="row between">
            <div>
              <h1 style={{ marginBottom: '.2rem' }}>{d.user.fullName}</h1>
              <div className="muted">{d.specialization} · {d.hospital.name}, {d.hospital.city}</div>
            </div>
            <span className="badge info">★ {d.rating} ({d.ratingCount} ratings)</span>
          </div>

          <div className="grid cols-2">
            <Card title="Profile">
              <table>
                <tbody>
                  <tr><td className="muted">Qualification</td><td>{d.qualification}</td></tr>
                  <tr><td className="muted">Experience</td><td>{d.experienceYears} years</td></tr>
                  <tr><td className="muted">Department</td><td>{d.department?.name || '—'}</td></tr>
                  <tr><td className="muted">Consultation fee</td><td>{money(d.consultationFee)}</td></tr>
                  <tr><td className="muted">Languages</td><td>{d.languages}</td></tr>
                  <tr><td className="muted">Registration</td><td className="mono">{d.registrationNumber}</td></tr>
                  <tr><td className="muted">Slot length</td><td>{d.slotMinutes} minutes</td></tr>
                </tbody>
              </table>
              {d.bio && <p className="small muted" style={{ marginTop: '.7rem' }}>{d.bio}</p>}
            </Card>

            <Card title="Weekly availability">
              {d.availability.length === 0 && <div className="empty">No published clinic hours.</div>}
              <div className="list">
                {DAY_NAMES.map((name, day) => {
                  const windows = d.availability.filter((a) => a.dayOfWeek === day);
                  if (!windows.length) return null;
                  return (
                    <div key={day} className="list-item row between">
                      <span>{name}</span>
                      <span className="small">{windows.map((w) => `${w.startTime}–${w.endTime}`).join(', ')}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>

          <Card title="Book an appointment">
            <form onSubmit={book}>
              <div className="grid cols-3">
                <div className="field">
                  <label htmlFor="date">Date</label>
                  <input id="date" type="date" min={isoDate(new Date())} value={date}
                    onChange={(e) => { setDate(e.target.value); setSelected(null); }} />
                </div>
                <div className="field">
                  <label htmlFor="type">Appointment type</label>
                  <select id="type" value={type} onChange={(e) => setType(e.target.value)}>
                    <option value="OPD">OPD consultation</option>
                    <option value="FOLLOW_UP">Follow-up</option>
                    <option value="SPECIALIST">Specialist consultation</option>
                    <option value="TELECONSULT">Teleconsultation</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="reason">Reason for visit</label>
                  <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Fever for 3 days" />
                </div>
              </div>

              <label>Available slots on {fmtDate(date)}</label>
              {slots.loading && <Loading label="Checking availability…" />}
              {slots.error && <ErrorNote error={slots.error} />}
              {slots.data && slots.data.slots.length === 0 && (
                <div className="empty">No free slots on this date. Try another day.</div>
              )}
              <div className="row" style={{ marginBottom: '1rem' }}>
                {slots.data?.slots.map((s) => (
                  <button
                    type="button"
                    key={s.startsAt}
                    className={selected === s.startsAt ? '' : 'ghost'}
                    onClick={() => setSelected(s.startsAt)}
                  >
                    {fmtTime(s.startsAt)}
                  </button>
                ))}
              </div>

              <ErrorNote error={error} />
              <button disabled={!selected || busy}>
                {busy ? 'Booking…' : selected ? `Confirm ${fmtTime(selected)} · ${money(d.consultationFee)}` : 'Select a slot'}
              </button>
            </form>
          </Card>
        </div>
      )}
    </Async>
  );
}
