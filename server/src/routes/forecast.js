import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AUDIT_ACTIONS, FORECAST_HORIZONS, FORECAST_METRICS, ROLES } from '../constants.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound, parse, serialize, wrap } from '../lib/http.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { METRIC_DEFS, loadHistory, runForecasts } from '../forecast/engine.js';
import { captureDailySnapshot } from '../forecast/snapshot.js';

const router = Router();
router.use(authenticate);

const FORECAST_ROLES = [ROLES.RECEPTIONIST];

// Which hospital's forecast is being asked for — always the caller's own.
function targetHospital(req) {
  const requested = req.query.hospitalId || req.body?.hospitalId;
  if (requested && requested !== req.user.hospitalId) throw forbidden('That hospital is not yours.');
  if (!req.user.hospitalId) throw forbidden('This account is not linked to a hospital.');
  return req.user.hospitalId;
}

// The latest forecast per metric per horizon, which is what the dashboard in
// PRD section 40 renders.
router.get('/dashboard', requireRole(...FORECAST_ROLES), wrap(async (req, res) => {
  const hospitalId = targetHospital(req);

  const forecasts = await prisma.forecast.findMany({
    where: { hospitalId, subKey: null },
    orderBy: { generatedAt: 'desc' },
    include: { points: { orderBy: { date: 'asc' } } },
    take: 200,
  });

  // findMany gives newest first, so the first hit for a key is the current one.
  const latest = new Map();
  for (const f of forecasts) {
    const key = `${f.metric}:${f.horizonDays}`;
    if (!latest.has(key)) latest.set(key, f);
  }

  const metrics = FORECAST_METRICS.map((metric) => {
    const horizons = {};
    for (const h of FORECAST_HORIZONS) {
      const f = latest.get(`${metric}:${h}`);
      if (f) horizons[h] = { forecastMean: f.forecastMean, model: f.model, mape: f.mape, points: f.points };
    }
    const any = latest.get(`${metric}:${FORECAST_HORIZONS[0]}`);
    return {
      metric,
      label: METRIC_DEFS[metric].label,
      unit: METRIC_DEFS[metric].unit,
      currentValue: any?.currentValue ?? null,
      generatedAt: any?.generatedAt ?? null,
      horizons,
    };
  });

  const [alerts, bloodForecasts] = await Promise.all([
    prisma.forecastAlert.findMany({
      where: { hospitalId, acknowledgedAt: null },
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
      take: 20,
    }),
    prisma.forecast.findMany({
      where: { hospitalId, metric: 'BLOOD', subKey: { not: null }, horizonDays: 7 },
      orderBy: { generatedAt: 'desc' },
      take: 8,
    }),
  ]);

  res.json(serialize({ hospitalId, metrics, alerts, bloodByGroup: bloodForecasts }));
}));

// Per-metric endpoints: /api/forecast/opd, /icu, /beds, ...
router.get('/:metric', requireRole(...FORECAST_ROLES), wrap(async (req, res) => {
  const metric = req.params.metric.toUpperCase();
  if (!FORECAST_METRICS.includes(metric)) {
    throw notFound(`Unknown metric. Available: ${FORECAST_METRICS.join(', ').toLowerCase()}.`);
  }
  const hospitalId = targetHospital(req);
  const { horizon, subKey } = parse(z.object({
    horizon: z.coerce.number().int().optional(),
    subKey: z.string().optional(),
  }), req.query);

  const forecast = await prisma.forecast.findFirst({
    where: { hospitalId, metric, subKey: subKey ?? null, ...(horizon ? { horizonDays: horizon } : {}) },
    orderBy: { generatedAt: 'desc' },
    include: { points: { orderBy: { date: 'asc' } }, alerts: true },
  });
  if (!forecast) throw notFound('No forecast has been generated for this metric yet. Run a forecast first.');

  // Recent actuals so the chart can show history next to the prediction.
  const history = await prisma.hospitalResourceDaily.findMany({
    where: { hospitalId },
    orderBy: { date: 'desc' },
    take: 60,
  });
  const def = METRIC_DEFS[metric];
  const actuals = history.reverse().map((r) => ({
    date: r.date,
    value: Math.round(Number(def.read(r, subKey ?? null) ?? 0) * 100) / 100,
  }));

  res.json(serialize({ ...forecast, label: def.label, unit: def.unit, actuals }));
}));

// Runs every model for every metric and horizon. Synchronous because a full run
// over a few years of daily data is well under a second; if that stops being
// true it moves to a job queue.
router.post('/run', requireRole(...FORECAST_ROLES), wrap(async (req, res) => {
  const hospitalId = targetHospital(req);
  const { horizons } = parse(
    z.object({ horizons: z.array(z.number().int().min(1).max(90)).optional() }),
    req.body || {},
  );
  const started = Date.now();
  const result = await runForecasts(hospitalId, { horizons: horizons?.length ? horizons : FORECAST_HORIZONS });
  await audit(req, AUDIT_ACTIONS.RUN_FORECAST, { entityType: 'Hospital', entityId: hospitalId });
  res.json({ ...result, durationMs: Date.now() - started });
}));

// --- Alerts ---------------------------------------------------------------

router.get('/alerts/list', requireRole(...FORECAST_ROLES), wrap(async (req, res) => {
  const hospitalId = targetHospital(req);
  const { includeAcknowledged } = parse(
    z.object({ includeAcknowledged: z.enum(['true', 'false']).default('false') }),
    req.query,
  );
  res.json(serialize(await prisma.forecastAlert.findMany({
    where: { hospitalId, ...(includeAcknowledged === 'true' ? {} : { acknowledgedAt: null }) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })));
}));

router.post('/alerts/:id/acknowledge', requireRole(...FORECAST_ROLES), wrap(async (req, res) => {
  const alert = await prisma.forecastAlert.findUnique({ where: { id: req.params.id } });
  if (!alert) throw notFound('Alert not found.');
  if (alert.hospitalId !== req.user.hospitalId) {
    throw forbidden('That alert belongs to another hospital.');
  }
  res.json(serialize(await prisma.forecastAlert.update({
    where: { id: alert.id }, data: { acknowledgedAt: new Date() },
  })));
}));

// --- Training data --------------------------------------------------------

router.get('/data/history', requireRole(...FORECAST_ROLES), wrap(async (req, res) => {
  const hospitalId = targetHospital(req);
  const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(1000).default(90) }), req.query);
  const rows = await prisma.hospitalResourceDaily.findMany({
    where: { hospitalId },
    orderBy: { date: 'desc' },
    take: days,
  });
  res.json(serialize(rows.reverse()));
}));

// Manual/bulk ingest for hospitals migrating historical data in.
router.post('/data/ingest', requireRole(...FORECAST_ROLES), wrap(async (req, res) => {
  const hospitalId = targetHospital(req);
  const { rows } = parse(z.object({
    rows: z.array(z.object({
      date: z.string(),
      opdVisits: z.number().int().min(0).default(0),
      ipdAdmissions: z.number().int().min(0).default(0),
      discharges: z.number().int().min(0).default(0),
      occupiedBeds: z.number().int().min(0).default(0),
      totalBeds: z.number().int().min(0).default(0),
      occupiedIcuBeds: z.number().int().min(0).default(0),
      totalIcuBeds: z.number().int().min(0).default(0),
      otCases: z.number().int().min(0).default(0),
      oxygenUnits: z.number().min(0).default(0),
      bloodUnits: z.number().int().min(0).default(0),
      bloodByGroup: z.record(z.number()).optional(),
      revenue: z.number().min(0).default(0),
    })).min(1).max(2000),
  }), req.body);

  let written = 0;
  for (const row of rows) {
    const date = new Date(row.date);
    if (Number.isNaN(date.getTime())) throw badRequest(`Invalid date: ${row.date}`);
    date.setHours(0, 0, 0, 0);
    const data = {
      ...row,
      hospitalId,
      date,
      bloodByGroup: row.bloodByGroup ? JSON.stringify(row.bloodByGroup) : null,
      source: 'OPERATIONAL',
    };
    await prisma.hospitalResourceDaily.upsert({
      where: { hospitalId_date: { hospitalId, date } },
      create: data,
      update: data,
    });
    written++;
  }
  res.json({ written });
}));

// Rolls up today's live activity into the training table on demand.
router.post('/data/snapshot', requireRole(...FORECAST_ROLES), wrap(async (req, res) => {
  const hospitalId = targetHospital(req);
  const { date } = parse(z.object({ date: z.string().optional() }), req.body || {});
  const row = await captureDailySnapshot(hospitalId, date ? new Date(date) : new Date());
  res.json(serialize(row));
}));

// --- Data quality (PRD section 44) ---------------------------------------

router.get('/data/quality', requireRole(...FORECAST_ROLES), wrap(async (req, res) => {
  const hospitalId = targetHospital(req);
  const { rows, issues } = await loadHistory(hospitalId);
  const stored = await prisma.dataQualityIssue.findMany({
    where: { hospitalId, resolvedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const byRule = new Map();
  for (const i of issues) byRule.set(i.rule, (byRule.get(i.rule) || 0) + 1);

  res.json(serialize({
    usableRows: rows.length,
    firstDate: rows[0]?.date ?? null,
    lastDate: rows.at(-1)?.date ?? null,
    issueCount: issues.length,
    byRule: [...byRule.entries()].map(([rule, count]) => ({ rule, count })),
    recentIssues: stored,
  }));
}));

export default router;
