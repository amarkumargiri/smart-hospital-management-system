import { Link } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api.js';
import { Async, Badge, Card, Stat, fmtDate, money, useApi } from '../../components/ui.jsx';

export default function ReceptionDashboard() {
  const dashboard = useApi(() => api.get('/analytics/dashboard'), []);
  const operations = useApi(() => api.get('/analytics/operations'), []);
  const alerts = useApi(() => api.get('/forecast/alerts/list'), []);

  return (
    <div className="stack">
      <div className="row between">
        <h1>Hospital overview</h1>
        <div className="row">
          <Link to="/reception/forecasting"><button className="ghost">Forecasting</button></Link>
          <Link to="/reception/analytics"><button className="ghost">Analytics</button></Link>
        </div>
      </div>

      <Async query={alerts} empty="">
        {(list) => (
          <div className="stack">
            {list.slice(0, 3).map((a) => (
              <div key={a.id} className={`alert ${a.severity === 'CRITICAL' ? 'error' : 'warn'}`}>
                <strong>{a.title}</strong> — {a.message}
                {a.recommendation && <div className="small" style={{ marginTop: '.25rem' }}>Recommended: {a.recommendation}</div>}
              </div>
            ))}
          </div>
        )}
      </Async>

      <Async query={dashboard}>
        {(d) => (
          <>
            <div className="grid cols-4">
              <Stat label="OPD today" value={d.todayOpd} hint={fmtDate(d.date)} />
              <Stat label="Admissions today" value={d.todayAdmissions} />
              <Stat label="Discharges today" value={d.todayDischarges} />
              <Stat label="Emergency patients" value={d.emergencyPatients} tone={d.emergencyPatients ? 'warn' : undefined} />
              <Stat
                label="Beds available"
                value={`${d.beds.availableBeds} / ${d.beds.totalBeds}`}
                percent={d.beds.bedOccupancyPct}
                hint={`${d.beds.bedOccupancyPct}% occupied`}
              />
              <Stat
                label="ICU available"
                value={`${d.beds.availableIcu} / ${d.beds.totalIcu}`}
                percent={d.beds.icuOccupancyPct}
                hint={`${d.beds.icuOccupancyPct}% occupied`}
              />
              <Stat label="Pending lab tests" value={d.pendingTests} />
              <Stat label="Revenue today" value={money(d.todayRevenue)} />
            </div>

            <Card title="Occupancy and demand — last 30 days">
              <Async query={operations}>
                {(ops) => (
                  <div className="chart">
                    <ResponsiveContainer>
                      <LineChart data={ops.occupancy}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--muted)" />
                        <YAxis tick={{ fontSize: 11 }} stroke="var(--muted)" />
                        <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }} />
                        <Line type="monotone" dataKey="opdVisits" name="OPD visits" stroke="var(--brand)" dot={false} strokeWidth={2} />
                        <Line type="monotone" dataKey="bedOccupancyPct" name="Bed occupancy %" stroke="var(--warn)" dot={false} strokeWidth={2} />
                        <Line type="monotone" dataKey="icuOccupancyPct" name="ICU occupancy %" stroke="var(--danger)" dot={false} strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Async>
            </Card>

            <div className="grid cols-2">
              <Card title="Open capacity alerts" action={<Link className="small" to="/reception/forecasting">Forecast dashboard</Link>}>
                <Async query={alerts} empty="No open alerts. Capacity is within thresholds.">
                  {(list) => (
                    <div className="list">
                      {list.map((a) => (
                        <div key={a.id} className="list-item">
                          <div className="row between">
                            <strong className="small">{a.title}</strong>
                            <Badge value={a.severity} />
                          </div>
                          <div className="small">{a.message}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </Async>
              </Card>

              <Card title="Laboratory workload">
                <Async query={operations}>
                  {(ops) => (
                    <div className="list">
                      {ops.labOrdersByStatus.map((l) => (
                        <div key={l.status} className="list-item row between">
                          <Badge value={l.status} />
                          <strong>{l.count}</strong>
                        </div>
                      ))}
                      {ops.averageWaitMinutes != null && (
                        <div className="list-item row between">
                          <span>Average OPD waiting time</span>
                          <strong>{ops.averageWaitMinutes} min</strong>
                        </div>
                      )}
                    </div>
                  )}
                </Async>
              </Card>
            </div>
          </>
        )}
      </Async>
    </div>
  );
}
