import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Async, Badge, Card, Stat, fmtDate, fmtDateTime, money, useApi } from '../../components/ui.jsx';

export default function PatientDashboard() {
  const { user } = useAuth();
  const patientId = user?.patient?.id;
  const query = useApi(() => api.get(`/patients/${patientId}/dashboard`), [patientId], { skip: !patientId });

  return (
    <div className="stack">
      <div className="row between">
        <h1>Welcome, {user?.fullName?.split(' ')[0]}</h1>
        <div className="row">
          <Link to="/app/hospitals"><button className="ghost">Find a hospital</button></Link>
          <Link to="/app/doctors"><button>Book an appointment</button></Link>
        </div>
      </div>

      <Async query={query} empty="Nothing to show yet.">
        {(d) => (
          <>
            <div className="grid cols-4">
              <Stat label="Upcoming appointments" value={d.upcomingAppointments.length} />
              <Stat label="Active prescriptions" value={d.activePrescriptions.length} />
              <Stat label="Reports ready" value={d.recentReports.length} />
              <Stat
                label="Pending payment"
                value={money(d.pendingAmount)}
                tone={d.pendingAmount > 0 ? 'warn' : undefined}
                hint={`${d.pendingBills.length} open bill(s)`}
              />
            </div>

            <div className="grid cols-2">
              <Card title="Upcoming appointments" action={<Link className="small" to="/app/appointments">View all</Link>}>
                {d.upcomingAppointments.length === 0 && <div className="empty">No upcoming appointments.</div>}
                <div className="list">
                  {d.upcomingAppointments.map((a) => (
                    <div key={a.id} className="list-item">
                      <div className="row between">
                        <strong>{a.doctor.user.fullName}</strong>
                        <Badge value={a.status} />
                      </div>
                      <div className="small muted">{a.hospital.name} · {a.type.replace('_', ' ')}</div>
                      <div className="small">{fmtDateTime(a.scheduledAt)}</div>
                      {a.tokenNumber && <div className="small">Token <strong>{a.tokenNumber}</strong></div>}
                    </div>
                  ))}
                </div>
              </Card>

              <Card title="Recent reports" action={<Link className="small" to="/app/reports">View all</Link>}>
                {d.recentReports.length === 0 && <div className="empty">No reports yet.</div>}
                <div className="list">
                  {d.recentReports.map((r) => (
                    <div key={r.id} className="list-item row between">
                      <div>
                        <div>{r.items.map((i) => i.labTest.name).join(', ')}</div>
                        <div className="small muted">{fmtDate(r.orderedAt)}</div>
                      </div>
                      <Badge value={r.status} />
                    </div>
                  ))}
                </div>
              </Card>

              <Card title="Current medication" action={<Link className="small" to="/app/prescriptions">View all</Link>}>
                {d.activePrescriptions.length === 0 && <div className="empty">No active prescriptions.</div>}
                <div className="list">
                  {d.activePrescriptions.map((p) => (
                    <div key={p.id} className="list-item">
                      <div className="small muted">{fmtDate(p.issuedAt)}</div>
                      {p.items.map((i) => (
                        <div key={i.id} className="small">
                          <strong>{i.medicineName}</strong> {i.dosage} · {i.frequency} · {i.durationDays} days
                          {i.instruction ? ` · ${i.instruction}` : ''}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </Card>

              <Card title="Follow-ups and bills">
                {d.followUps.length === 0 && d.pendingBills.length === 0 && <div className="empty">Nothing pending.</div>}
                <div className="list">
                  {d.followUps.map((f) => (
                    <div key={f.id} className="list-item row between">
                      <span>Follow-up with {f.doctor.user.fullName}</span>
                      <span className="small">{fmtDate(f.followUpDate)}</span>
                    </div>
                  ))}
                  {d.pendingBills.map((b) => (
                    <div key={b.id} className="list-item row between">
                      <span>{b.hospital.name} · <span className="mono">{b.billNumber}</span></span>
                      <span className="row">
                        <strong>{money(Number(b.total) - Number(b.paidAmount))}</strong>
                        <Link to="/app/bills"><button className="small ghost">Pay</button></Link>
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </>
        )}
      </Async>
    </div>
  );
}
