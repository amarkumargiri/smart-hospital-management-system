import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { Async, Badge, Card, ErrorNote, Table, fmtDateTime, useApi } from '../../components/ui.jsx';

const isoDate = (d) => d.toISOString().slice(0, 10);

export default function DoctorAppointments() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState(isoDate(new Date(Date.now() - 7 * 86_400_000)));
  const [to, setTo] = useState(isoDate(new Date(Date.now() + 14 * 86_400_000)));
  const [error, setError] = useState(null);

  const query = useApi(
    () => api.get('/appointments', { status, from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.000Z`, pageSize: 200 }),
    [status, from, to],
  );

  async function move(id, next) {
    setError(null);
    try {
      await api.post(`/appointments/${id}/status`, { status: next });
      query.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="stack">
      <h1>Appointments</h1>

      <Card>
        <div className="grid cols-4">
          <div className="field"><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field"><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="REQUESTED">Awaiting my approval</option>
              <option value="CONFIRMED">Confirmed</option>
              <option value="CHECKED_IN,IN_CONSULTATION">In clinic</option>
              <option value="COMPLETED">Completed</option>
              <option value="CANCELLED,REJECTED,NO_SHOW">Cancelled / missed</option>
            </select>
          </div>
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
                { key: 'patient', header: 'Patient', render: (a) => <Link to={`/doctor/patients/${a.patientId}`}>{a.patient.user.fullName}</Link> },
                { key: 'mobile', header: 'Contact', render: (a) => a.patient.user.mobile },
                { key: 'type', header: 'Type', render: (a) => a.type.replace('_', ' ') },
                { key: 'reason', header: 'Reason', wrap: true },
                { key: 'status', header: 'Status', render: (a) => <Badge value={a.status} /> },
                {
                  key: 'actions',
                  header: '',
                  render: (a) => (
                    <span className="row">
                      {a.status === 'REQUESTED' && (
                        <>
                          <button className="small" onClick={() => move(a.id, 'CONFIRMED')}>Accept</button>
                          <button className="small ghost" onClick={() => move(a.id, 'REJECTED')}>Decline</button>
                        </>
                      )}
                      {a.status === 'CONFIRMED' && (
                        <>
                          <button className="small ghost" onClick={() => move(a.id, 'CHECKED_IN')}>Check in</button>
                          <button className="small ghost" onClick={() => move(a.id, 'NO_SHOW')}>No-show</button>
                        </>
                      )}
                      {['CHECKED_IN', 'IN_CONSULTATION'].includes(a.status) && (
                        <button className="small" onClick={() => navigate(`/doctor/consultation/${a.id}`)}>Consult</button>
                      )}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Async>
      </Card>
    </div>
  );
}
