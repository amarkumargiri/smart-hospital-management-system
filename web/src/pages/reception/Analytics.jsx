import { useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api } from '../../api.js';
import { Async, Card, Stat, Table, Tabs, money, useApi } from '../../components/ui.jsx';

const isoDate = (d) => d.toISOString().slice(0, 10);
const PALETTE = ['#0d7ea8', '#12805c', '#b45309', '#7c3aed', '#be185d', '#0891b2', '#65a30d', '#c2410c'];
const chartTooltip = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 };

export default function Analytics() {
  const [from, setFrom] = useState(isoDate(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(isoDate(new Date()));
  const [tab, setTab] = useState('patients');
  const range = { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.000Z` };

  const patients = useApi(() => api.get('/analytics/patients', range), [from, to]);
  const doctors = useApi(() => api.get('/analytics/doctors', range), [from, to]);
  const financial = useApi(() => api.get('/analytics/financial', range), [from, to]);

  return (
    <div className="stack">
      <div className="row between">
        <h1>Analytics</h1>
        <div className="row">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 160 }} />
          <span className="muted">to</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 160 }} />
        </div>
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { value: 'patients', label: 'Patients' },
          { value: 'doctors', label: 'Doctors' },
          { value: 'financial', label: 'Financial' },
        ]}
      />

      {tab === 'patients' && (
        <Async query={patients}>
          {(d) => (
            <div className="stack">
              <div className="grid cols-4">
                <Stat label="Total visits" value={d.totalVisits} />
                <Stat label="Unique patients" value={d.uniquePatients} />
                <Stat label="New patients" value={d.newPatients} />
                <Stat label="Returning patients" value={d.returningPatients} />
              </div>

              <Card title="Daily patient volume">
                <div className="chart">
                  <ResponsiveContainer>
                    <LineChart data={d.daily}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--muted)" minTickGap={24} />
                      <YAxis tick={{ fontSize: 11 }} stroke="var(--muted)" />
                      <Tooltip contentStyle={chartTooltip} />
                      <Line type="monotone" dataKey="value" name="Visits" stroke="var(--brand)" dot={false} strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </Card>

              <div className="grid cols-3">
                <Card title="By department">
                  <SimplePie data={d.byDepartment} />
                </Card>
                <Card title="By gender">
                  <SimplePie data={d.byGender} />
                </Card>
                <Card title="By age group">
                  <div className="chart" style={{ height: 240 }}>
                    <ResponsiveContainer>
                      <BarChart data={d.byAgeGroup}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--muted)" />
                        <YAxis tick={{ fontSize: 11 }} stroke="var(--muted)" />
                        <Tooltip contentStyle={chartTooltip} />
                        <Bar dataKey="value" name="Patients" fill="var(--brand)" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
              </div>
            </div>
          )}
        </Async>
      )}

      {tab === 'doctors' && (
        <Async query={doctors}>
          {(d) => (
            <Card title="Doctor performance">
              <Table
                rows={d.items}
                rowKey={(r) => r.doctorId}
                columns={[
                  { key: 'name', header: 'Doctor' },
                  { key: 'specialization', header: 'Specialization' },
                  { key: 'department', header: 'Department' },
                  { key: 'total', header: 'Appointments', num: true },
                  { key: 'completed', header: 'Completed', num: true },
                  { key: 'followUp', header: 'Follow-ups', num: true },
                  { key: 'noShow', header: 'No-shows', num: true },
                  { key: 'cancelled', header: 'Cancelled', num: true },
                  { key: 'completionRatePct', header: 'Completion %', num: true, render: (r) => `${r.completionRatePct}%` },
                  { key: 'noShowRatePct', header: 'No-show %', num: true, render: (r) => `${r.noShowRatePct}%` },
                ]}
              />
            </Card>
          )}
        </Async>
      )}

      {tab === 'financial' && (
        <Async query={financial}>
          {(d) => (
            <div className="stack">
              <div className="grid cols-2">
                <Stat label="Collected in range" value={money(d.totalCollected)} />
                <Stat label="Outstanding across all bills" value={money(d.outstanding)} tone={d.outstanding > 0 ? 'warn' : undefined} />
              </div>

              <Card title="Daily collection">
                <div className="chart">
                  <ResponsiveContainer>
                    <BarChart data={d.daily}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--muted)" minTickGap={24} />
                      <YAxis tick={{ fontSize: 11 }} stroke="var(--muted)" />
                      <Tooltip contentStyle={chartTooltip} formatter={(v) => money(v)} />
                      <Bar dataKey="value" name="Collected" fill="var(--ok)" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>

              <div className="grid cols-2">
                <Card title="Revenue by service">
                  <Table
                    rows={d.byCategory}
                    rowKey={(r) => r.label}
                    columns={[
                      { key: 'label', header: 'Category' },
                      { key: 'value', header: 'Amount', num: true, render: (r) => money(r.value) },
                    ]}
                  />
                </Card>
                <Card title="Collection by payment method">
                  <SimplePie data={d.byPaymentMethod} formatter={money} />
                </Card>
              </div>
            </div>
          )}
        </Async>
      )}
    </div>
  );
}

function SimplePie({ data, formatter }) {
  if (!data?.length) return <div className="empty">No data in this range.</div>;
  return (
    <div className="chart" style={{ height: 240 }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="label" innerRadius={44} outerRadius={80} paddingAngle={2}>
            {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
          </Pie>
          <Tooltip contentStyle={chartTooltip} formatter={formatter} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
