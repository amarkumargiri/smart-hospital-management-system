import { prisma } from '../db.js';
import { candidateModels } from './models.js';
import { scoreAll, stdev } from './metrics.js';
import { validateRows, recordIssues } from './quality.js';
import { ALERT_THRESHOLDS, BLOOD_GROUPS, FORECAST_HORIZONS } from '../constants.js';
import { hospitalDeskUserIds, notifyMany } from '../lib/notify.js';

const MIN_HISTORY_DAYS = 28;
const HOLDOUT_DAYS = 14;
const Z_95 = 1.96;

// How each forecastable metric is read out of a daily resource row, plus the
// unit and clamping rules that make the number meaningful on a dashboard.
export const METRIC_DEFS = {
  OPD: { label: 'OPD Visits', unit: 'visits/day', integer: true, read: (r) => r.opdVisits },
  IPD: { label: 'IPD Admissions', unit: 'admissions/day', integer: true, read: (r) => r.ipdAdmissions },
  BEDS: {
    label: 'Bed Occupancy', unit: '%', max: 100,
    read: (r) => (r.totalBeds > 0 ? (r.occupiedBeds / r.totalBeds) * 100 : 0),
  },
  ICU: {
    label: 'ICU Occupancy', unit: '%', max: 100,
    read: (r) => (r.totalIcuBeds > 0 ? (r.occupiedIcuBeds / r.totalIcuBeds) * 100 : 0),
  },
  OT: { label: 'OT Cases', unit: 'cases/day', integer: true, read: (r) => r.otCases },
  OXYGEN: { label: 'Oxygen Consumption', unit: 'cylinders/day', read: (r) => r.oxygenUnits },
  BLOOD: {
    label: 'Blood Requirement', unit: 'units/day', integer: true,
    read: (r, subKey) => {
      if (!subKey) return r.bloodUnits;
      const byGroup = r.bloodByGroup ? JSON.parse(r.bloodByGroup) : {};
      return byGroup[subKey] ?? 0;
    },
  },
};

function clamp(value, def) {
  let v = Math.max(0, value);
  if (def.max !== undefined) v = Math.min(def.max, v);
  return def.integer ? Math.round(v) : Math.round(v * 100) / 100;
}

// Loads the validated daily history for one hospital. Quality issues found on
// the way are persisted so the data-quality screen has something to show.
export async function loadHistory(hospitalId, { recordQuality = false } = {}) {
  const rows = await prisma.hospitalResourceDaily.findMany({
    where: { hospitalId },
    orderBy: { date: 'asc' },
  });
  const { clean, issues } = validateRows(rows);
  if (recordQuality) await recordIssues(issues);
  return { rows: clean, issues };
}

function buildSeries(rows, metric, subKey) {
  const def = METRIC_DEFS[metric];
  return rows.map((r) => Number(def.read(r, subKey) ?? 0));
}

// Backtest: hide the last HOLDOUT_DAYS, let every candidate predict them, and
// keep whichever has the lowest MAPE. The winner is then refit on the full
// series before producing the real forecast.
function selectModel(series) {
  const holdout = Math.min(HOLDOUT_DAYS, Math.floor(series.length / 4));
  const train = series.slice(0, series.length - holdout);
  const actual = series.slice(series.length - holdout);

  let best = null;
  for (const model of candidateModels(train)) {
    const predicted = model.forecast(holdout).map((v) => Math.max(0, v));
    const score = scoreAll(actual, predicted);
    if (!Number.isFinite(score.mape)) continue;
    if (!best || score.mape < best.score.mape) best = { name: model.name, score };
  }
  if (!best) return null;

  const refit = candidateModels(series).find((m) => m.name === best.name);
  return refit ? { model: refit, score: best.score } : null;
}

// Residual spread of the winning model on the training window, used for the
// confidence band. Falls back to the series' own spread when the model does not
// expose fitted values.
function residualSpread(model, series) {
  if (model.fitted?.length === series.length) {
    return stdev(series.map((v, i) => v - model.fitted[i]));
  }
  return stdev(series.slice(-28));
}

export async function forecastMetric(hospitalId, metric, horizonDays, { subKey = null, rows } = {}) {
  const def = METRIC_DEFS[metric];
  if (!def) throw new Error(`Unknown forecast metric: ${metric}`);

  const history = rows || (await loadHistory(hospitalId)).rows;
  if (history.length < MIN_HISTORY_DAYS) {
    return { skipped: true, reason: `Needs at least ${MIN_HISTORY_DAYS} days of history, has ${history.length}.` };
  }

  const series = buildSeries(history, metric, subKey);
  const selection = selectModel(series);
  if (!selection) return { skipped: true, reason: 'No model produced a usable score.' };

  const { model, score } = selection;
  const raw = model.forecast(horizonDays);
  const spread = residualSpread(model, series);
  const lastDate = history.at(-1).date;

  const points = raw.map((value, i) => {
    const date = new Date(lastDate);
    date.setDate(date.getDate() + i + 1);
    return {
      date,
      value: clamp(value, def),
      lowerBound: clamp(value - Z_95 * spread, def),
      upperBound: clamp(value + Z_95 * spread, def),
    };
  });

  const currentValue = clamp(series.slice(-7).reduce((a, b) => a + b, 0) / Math.min(7, series.length), def);
  const forecastMean = clamp(points.reduce((a, p) => a + p.value, 0) / points.length, def);

  const forecast = await prisma.forecast.create({
    data: {
      hospitalId,
      metric,
      subKey,
      horizonDays,
      model: model.name,
      mae: round(score.mae),
      rmse: round(score.rmse),
      mape: round(score.mape),
      currentValue,
      forecastMean,
      points: { create: points },
    },
    include: { points: { orderBy: { date: 'asc' } } },
  });

  return { forecast, currentValue, forecastMean, points };
}

const round = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

// PRD section 41. Alerts are derived from the forecast, not from live occupancy,
// so management gets warned before capacity is actually breached.
export function evaluateAlerts({ metric, subKey, horizonDays, currentValue, forecastMean, points }) {
  const peak = Math.max(...points.map((p) => p.value));
  const growthPct = currentValue > 0 ? ((forecastMean - currentValue) / currentValue) * 100 : 0;
  const alerts = [];

  if (metric === 'ICU' && peak >= ALERT_THRESHOLDS.ICU_OCCUPANCY_PCT) {
    alerts.push({
      severity: 'CRITICAL',
      title: 'ICU capacity risk',
      message: `Forecasted ICU occupancy is expected to reach ${peak.toFixed(0)}% within ${horizonDays} days (currently ${currentValue.toFixed(0)}%).`,
      recommendation: 'Review ICU capacity, ventilator availability and critical-care staffing.',
      thresholdValue: ALERT_THRESHOLDS.ICU_OCCUPANCY_PCT,
      expectedValue: peak,
    });
  }

  if (metric === 'BEDS' && peak >= ALERT_THRESHOLDS.BED_OCCUPANCY_PCT) {
    alerts.push({
      severity: 'WARNING',
      title: 'Bed occupancy risk',
      message: `Forecasted bed occupancy is expected to reach ${peak.toFixed(0)}% within ${horizonDays} days (currently ${currentValue.toFixed(0)}%).`,
      recommendation: 'Plan discharges, review elective admissions and prepare reserve beds.',
      thresholdValue: ALERT_THRESHOLDS.BED_OCCUPANCY_PCT,
      expectedValue: peak,
    });
  }

  if (metric === 'OXYGEN' && growthPct >= ALERT_THRESHOLDS.OXYGEN_INCREASE_PCT) {
    alerts.push({
      severity: 'WARNING',
      title: 'Oxygen demand alert',
      message: `Expected oxygen demand may increase by ${growthPct.toFixed(0)}% over the next ${horizonDays} days (${currentValue} to ${forecastMean} cylinders/day).`,
      recommendation: 'Confirm supplier lead times and raise the standing order.',
      thresholdValue: ALERT_THRESHOLDS.OXYGEN_INCREASE_PCT,
      expectedValue: forecastMean,
    });
  }

  if (metric === 'BLOOD' && growthPct >= ALERT_THRESHOLDS.BLOOD_INCREASE_PCT) {
    alerts.push({
      severity: 'WARNING',
      title: `Blood demand alert${subKey ? ` (${subKey})` : ''}`,
      message: `Expected ${subKey || 'total'} blood demand may increase by ${growthPct.toFixed(0)}% over the next ${horizonDays} days (${currentValue} to ${forecastMean} units/day).`,
      recommendation: 'Coordinate with the blood bank and schedule a donation drive.',
      thresholdValue: ALERT_THRESHOLDS.BLOOD_INCREASE_PCT,
      expectedValue: forecastMean,
    });
  }

  return alerts;
}

// Full run for one hospital: every metric, every horizon, plus per-blood-group
// forecasts and the alerts that fall out of them.
export async function runForecasts(hospitalId, { horizons = FORECAST_HORIZONS, notifyAdmins = true } = {}) {
  const { rows, issues } = await loadHistory(hospitalId, { recordQuality: true });
  const results = [];
  const alertRows = [];

  const targets = [
    ...Object.keys(METRIC_DEFS).map((metric) => ({ metric, subKey: null })),
    ...BLOOD_GROUPS.map((group) => ({ metric: 'BLOOD', subKey: group })),
  ];

  for (const { metric, subKey } of targets) {
    for (const horizonDays of horizons) {
      const result = await forecastMetric(hospitalId, metric, horizonDays, { subKey, rows });
      if (result.skipped) {
        results.push({ metric, subKey, horizonDays, ...result });
        continue;
      }
      results.push({ metric, subKey, horizonDays, forecastId: result.forecast.id, model: result.forecast.model });

      // Alerts only on the shortest horizon that crosses a threshold — one alert
      // per metric is actionable, three copies of it is noise.
      if (horizonDays === horizons[0] || metric === 'ICU') {
        for (const alert of evaluateAlerts({ metric, subKey, horizonDays, ...result })) {
          alertRows.push({ ...alert, forecastId: result.forecast.id, hospitalId, metric });
        }
      }
    }
  }

  if (alertRows.length) {
    await prisma.forecastAlert.createMany({ data: alertRows });
    if (notifyAdmins) {
      const desk = await hospitalDeskUserIds(hospitalId);
      await Promise.all(alertRows.map((a) =>
        notifyMany(desk, {
          category: 'CAPACITY_ALERT',
          title: a.title,
          body: a.message,
          link: '/hospital/forecasting',
          severity: a.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
        })));
    }
  }

  return { hospitalId, generated: results.length, alerts: alertRows.length, qualityIssues: issues.length, results };
}
