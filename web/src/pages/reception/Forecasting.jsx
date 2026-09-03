import { useState } from 'react';
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Async, Badge, Card, ErrorNote, Loading, Stat, Table, fmtDate, useApi } from '../../components/ui.jsx';

const HORIZONS = [7, 14, 30];
const shortDate = (v) => new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

export default function Forecasting() {
  const { user } = useAuth();
  const [metric, setMetric] = useState('OPD');
  const [horizon, setHorizon] = useState(7);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [runResult, setRunResult] = useState(null);

  const canRun = user?.role === 'RECEPTIONIST';
  const dashboard = useApi(() => api.get('/forecast/dashboard'), []);
  const detail = useApi(() => api.get(`/forecast/${metric.toLowerCase()}`, { horizon }), [metric, horizon]);
  const quality = useApi(() => api.get('/forecast/data/quality'), [], { skip: !canRun });

  async function run() {
    setRunning(true);
    setError(null);
    setRunResult(null);
    try {
      const result = await api.post('/forecast/run', {});
      setRunResult(result);
      dashboard.reload();
      detail.reload();
      quality.reload();
    } catch (err) {
      setError(err);
    } finally {
      setRunning(false);
    }
  }

  async function acknowledge(id) {
    await api.post(`/forecast/alerts/${id}/acknowledge`);
    dashboard.reload();
  }

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <h1 style={{ marginBottom: '.2rem' }}>Demand forecasting</h1>
          <div className="muted small">
            Every metric is forecast by four competing models; the one with the lowest holdout MAPE wins.
          </div>
        </div>
        {canRun && <button onClick={run} disabled={running}>{running ? 'Running models…' : 'Run forecast now'}</button>}
      </div>

      <ErrorNote error={error} />
      {runResult && (
        <div className="alert ok">
          Generated {runResult.generated} forecasts in {runResult.durationMs} ms ·
          {' '}{runResult.alerts} alert(s) raised · {runResult.qualityIssues} data quality issue(s) found.
        </div>
      )}

      <Async query={dashboard} empty="No forecast has been generated yet.">
        {(d) => (
          <>
            {d.alerts.length > 0 && (
              <div className="stack">
                {d.alerts.map((a) => (
                  <div key={a.id} className={`alert ${a.severity === 'CRITICAL' ? 'error' : 'warn'}`}>
                    <div className="row between">
                      <strong>{a.title}</strong>
                      {canRun && <button className="ghost small" onClick={() => acknowledge(a.id)}>Acknowledge</button>}
                    </div>
                    <div>{a.message}</div>
                    {a.recommendation && <div className="small" style={{ marginTop: '.25rem' }}>Recommended action: {a.recommendation}</div>}
                  </div>
                ))}
              </div>
            )}

            <div className="grid cols-4">
              {d.metrics.map((m) => {
                const h = m.horizons[horizon];
                const delta = h && m.currentValue ? ((h.forecastMean - m.currentValue) / m.currentValue) * 100 : 0;
                return (
                  <div
                    key={m.metric}
                    onClick={() => setMetric(m.metric)}
                    style={{ cursor: 'pointer', outline: metric === m.metric ? '2px solid var(--brand)' : 'none', borderRadius: 'var(--radius)' }}
                  >
                    <Stat
                      label={m.label}
                      value={h ? formatValue(h.forecastMean, m.unit) : '—'}
                      hint={h
                        ? `now ${formatValue(m.currentValue, m.unit)} · ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% · ${h.model.replace(/_/g, ' ').toLowerCase()} · MAPE ${h.mape}%`
                        : 'not enough history'}
                      percent={m.unit === '%' ? h?.forecastMean : undefined}
                      tone={m.unit === '%' && h?.forecastMean >= 90 ? 'danger' : undefined}
                    />
                  </div>
                );
              })}
            </div>

            <Card
              title={`${METRIC_LABEL[metric]} — history and forecast`}
              action={(
                <div className="row">
                  <select value={metric} onChange={(e) => setMetric(e.target.value)} style={{ width: 190 }}>
                    {d.metrics.map((m) => <option key={m.metric} value={m.metric}>{m.label}</option>)}
                  </select>
                  <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} style={{ width: 130 }}>
                    {HORIZONS.map((h) => <option key={h} value={h}>{h} days</option>)}
                  </select>
                </div>
              )}
            >
              {detail.loading && <Loading label="Loading forecast…" />}
              {detail.error && <ErrorNote error={detail.error} />}
              {detail.data && <ForecastChart forecast={detail.data} />}
            </Card>

            <div className="grid cols-2">
              <Card title="Blood requirement by group — next 7 days">
                {d.bloodByGroup.length === 0 ? <div className="empty">No blood forecast available.</div> : (
                  <div className="chart" style={{ height: 240 }}>
                    <ResponsiveContainer>
                      <BarChart data={d.bloodByGroup.map((b) => ({ group: b.subKey, current: b.currentValue, forecast: b.forecastMean }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis dataKey="group" tick={{ fontSize: 11 }} stroke="var(--muted)" />
                        <YAxis tick={{ fontSize: 11 }} stroke="var(--muted)" />
                        <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }} />
                        <Legend />
                        <Bar dataKey="current" name="Current units/day" fill="var(--muted)" />
                        <Bar dataKey="forecast" name="Forecast units/day" fill="var(--brand)" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Card>

              <Card title="Model accuracy across metrics">
                <Table
                  rows={d.metrics.flatMap((m) => HORIZONS.filter((h) => m.horizons[h]).map((h) => ({
                    id: `${m.metric}-${h}`,
                    metric: m.label,
                    horizon: `${h} days`,
                    model: m.horizons[h].model.replace(/_/g, ' ').toLowerCase(),
                    mape: `${m.horizons[h].mape}%`,
                  })))}
                  columns={[
                    { key: 'metric', header: 'Metric' },
                    { key: 'horizon', header: 'Horizon' },
                    { key: 'model', header: 'Winning model' },
                    { key: 'mape', header: 'MAPE', num: true },
                  ]}
                  empty="Run a forecast to populate this table."
                />
              </Card>
            </div>

            {canRun && (
              <Card title="Training data quality">
                <Async query={quality}>
                  {(q) => (
                    <>
                      <div className="grid cols-4">
                        <Stat label="Usable days" value={q.usableRows} />
                        <Stat label="History from" value={q.firstDate ? fmtDate(q.firstDate) : '—'} />
                        <Stat label="History to" value={q.lastDate ? fmtDate(q.lastDate) : '—'} />
                        <Stat label="Issues found" value={q.issueCount} tone={q.issueCount ? 'warn' : undefined} />
                      </div>
                      {q.byRule.length > 0 && (
                        <div className="row" style={{ marginTop: '.7rem' }}>
                          {q.byRule.map((r) => (
                            <span key={r.rule} className="badge warn">{r.rule.replace(/_/g, ' ').toLowerCase()}: {r.count}</span>
                          ))}
                        </div>
                      )}
                      <p className="small muted" style={{ marginTop: '.7rem' }}>
                        Rows that fail a validation rule are excluded from training. Outliers are flagged but kept,
                        because a genuine surge is exactly what the model needs to learn.
                      </p>
                    </>
                  )}
                </Async>
              </Card>
            )}
          </>
        )}
      </Async>
    </div>
  );
}

// History and prediction on one axis, with the 95% band drawn behind the line.
function ForecastChart({ forecast }) {
  const actuals = forecast.actuals.map((a) => ({ date: shortDate(a.date), actual: a.value }));
  const predicted = forecast.points.map((p) => ({
    date: shortDate(p.date),
    forecast: p.value,
    // Recharts stacks an area from a base, so the band is [lower, upper] pairs.
    band: [p.lowerBound, p.upperBound],
  }));

  // The last actual point is repeated as the first forecast point so the two
  // lines visually connect instead of leaving a gap.
  const bridge = actuals.length && predicted.length
    ? [{ ...actuals[actuals.length - 1], forecast: actuals[actuals.length - 1].actual }]
    : [];
  const data = [...actuals.slice(0, -1), ...bridge, ...predicted];

  return (
    <>
      <div className="row" style={{ marginBottom: '.6rem' }}>
        <Badge value={forecast.model.replace(/_/g, ' ')} tone="info" />
        <span className="badge">MAPE {forecast.mape}%</span>
        <span className="badge">MAE {forecast.mae}</span>
        <span className="badge">RMSE {forecast.rmse}</span>
        <span className="badge">{forecast.horizonDays}-day horizon</span>
        <span className="small muted">
          Current {forecast.currentValue} {forecast.unit} · forecast average {forecast.forecastMean} {forecast.unit}
        </span>
      </div>
      <div className="chart" style={{ height: 320 }}>
        <ResponsiveContainer>
          <ComposedChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--muted)" minTickGap={20} />
            <YAxis tick={{ fontSize: 11 }} stroke="var(--muted)" />
            <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }} />
            <Legend />
            <Area dataKey="band" name="95% interval" stroke="none" fill="var(--brand)" fillOpacity={0.15} />
            <Line type="monotone" dataKey="actual" name="Actual" stroke="var(--muted)" dot={false} strokeWidth={2} />
            <Line type="monotone" dataKey="forecast" name="Forecast" stroke="var(--brand)" dot={false} strokeWidth={2} strokeDasharray="5 3" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

const METRIC_LABEL = {
  OPD: 'OPD visits', IPD: 'IPD admissions', BEDS: 'Bed occupancy', ICU: 'ICU occupancy',
  OT: 'OT cases', OXYGEN: 'Oxygen consumption', BLOOD: 'Blood requirement',
};

const formatValue = (value, unit) =>
  value == null ? '—' : unit === '%' ? `${Math.round(value)}%` : Number(value).toLocaleString('en-IN');
