import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { Async, Badge, Card, Stat, Table, fmtDate, fmtTime, useApi } from '../../components/ui.jsx';

export default function DoctorDashboard() {
  const navigate = useNavigate();
  const query = useApi(() => api.get('/doctors/me/dashboard'), []);

  async function setStatus(id, status) {
    await api.post(`/appointments/${id}/status`, { status });
    query.reload();
  }

  return (
    <div className="stack">
      <h1>Today's clinic</h1>

      <Async query={query}>
        {(d) => (
          <>
            <div className="grid cols-4">
              <Stat label="Appointments today" value={d.todayAppointments.length} />
              <Stat label="Pending requests" value={d.pendingRequests} tone={d.pendingRequests ? 'warn' : undefined} />
              <Stat label="Inpatients" value={d.admittedPatients.length} />
              <Stat label="Critical results" value={d.criticalResults} tone={d.criticalResults ? 'danger' : undefined} />
            </div>

            <Card title="Today's appointments" action={<Link className="small" to="/doctor/appointments">All appointments</Link>}>
              <Table
                empty="No appointments scheduled today."
                rows={d.todayAppointments}
                columns={[
                  { key: 'time', header: 'Time', render: (a) => fmtTime(a.scheduledAt) },
                  { key: 'token', header: 'Token', render: (a) => a.tokenNumber || '—' },
                  { key: 'patient', header: 'Patient', render: (a) => a.patient.user.fullName },
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
                            <button className="small" onClick={() => setStatus(a.id, 'CONFIRMED')}>Accept</button>
                            <button className="small ghost" onClick={() => setStatus(a.id, 'REJECTED')}>Decline</button>
                          </>
                        )}
                        {a.status === 'CONFIRMED' && (
                          <>
                            <button className="small ghost" onClick={() => setStatus(a.id, 'CHECKED_IN')}>Check in</button>
                            <button className="small ghost" onClick={() => setStatus(a.id, 'NO_SHOW')}>No-show</button>
                          </>
                        )}
                        {['CHECKED_IN', 'IN_CONSULTATION'].includes(a.status) && (
                          <button className="small" onClick={() => navigate(`/doctor/consultation/${a.id}`)}>
                            {a.status === 'CHECKED_IN' ? 'Start consultation' : 'Resume'}
                          </button>
                        )}
                        {a.status === 'COMPLETED' && (
                          <Link to={`/doctor/patients/${a.patientId}`}><button className="small ghost">Record</button></Link>
                        )}
                      </span>
                    ),
                  },
                ]}
              />
            </Card>

            <div className="grid cols-2">
              <Card title="Lab results to review" action={<Link className="small" to="/doctor/lab">All results</Link>}>
                <div className="list">
                  {d.labResults.length === 0 && <div className="empty">No new results.</div>}
                  {d.labResults.map((o) => (
                    <div key={o.id} className="list-item">
                      <div className="row between">
                        <strong>{o.patient.user.fullName}</strong>
                        {o.items.some((i) => i.flag === 'CRITICAL')
                          ? <Badge value="CRITICAL" tone="danger" />
                          : <Badge value="VERIFIED" />}
                      </div>
                      <div className="small muted">{o.items.map((i) => i.labTest.name).join(', ')}</div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card title="Follow-ups due">
                <div className="list">
                  {d.followUps.length === 0 && <div className="empty">No follow-ups scheduled.</div>}
                  {d.followUps.map((f) => (
                    <div key={f.id} className="list-item row between">
                      <span>{f.patient.user.fullName}</span>
                      <span className="small muted">{fmtDate(f.followUpDate)}</span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            <Card title="My inpatients" action={<Link className="small" to="/doctor/admissions">Manage</Link>}>
              <Table
                empty="No admitted patients."
                rows={d.admittedPatients}
                columns={[
                  { key: 'patient', header: 'Patient', render: (a) => a.patient.user.fullName },
                  { key: 'bed', header: 'Bed', render: (a) => a.bed ? `${a.bed.bedNumber} (${a.bed.ward})` : '—' },
                  { key: 'reason', header: 'Reason', wrap: true },
                  { key: 'admittedAt', header: 'Admitted', render: (a) => fmtDate(a.admittedAt) },
                ]}
              />
            </Card>
          </>
        )}
      </Async>
    </div>
  );
}
