import assert from 'node:assert/strict';
import test from 'node:test';
import { holtWintersTuned, linearTrend, movingAverage, seasonalNaive } from '../src/forecast/models.js';
import { mae, mape, rmse } from '../src/forecast/metrics.js';
import { validateRows } from '../src/forecast/quality.js';
import { evaluateAlerts } from '../src/forecast/engine.js';

// A series with a known weekly shape and upward trend — the models must be able
// to recover it, otherwise nothing downstream can be trusted.
function syntheticSeries(days = 180) {
  const weekday = [0.6, 1.2, 1.1, 1.05, 1.05, 1.1, 0.9];
  return Array.from({ length: days }, (_, i) => Math.round(400 * weekday[i % 7] + i * 0.5));
}

test('metrics compute the textbook values', () => {
  const actual = [10, 20, 30];
  const predicted = [12, 18, 33];
  assert.equal(mae(actual, predicted), (2 + 2 + 3) / 3);
  assert.equal(rmse(actual, predicted), Math.sqrt((4 + 4 + 9) / 3));
  assert.ok(Math.abs(mape(actual, predicted) - ((0.2 + 0.1 + 0.1) / 3) * 100) < 1e-9);
});

test('mape skips zero actuals instead of returning Infinity', () => {
  assert.equal(mape([0, 100], [5, 90]), 10);
});

test('seasonal naive reproduces the weekly pattern exactly', () => {
  const series = syntheticSeries();
  const predicted = seasonalNaive(series).forecast(7);
  const actualNextWeek = series.slice(-7).map((v) => v + 3.5); // one week of trend
  assert.ok(mape(actualNextWeek, predicted) < 2);
});

test('holt-winters beats a flat moving average on a seasonal series', () => {
  const series = syntheticSeries(200);
  const train = series.slice(0, 180);
  const holdout = series.slice(180);

  const hw = holtWintersTuned(train);
  assert.ok(hw, 'holt-winters should fit a 180-point series');

  const hwError = mape(holdout, hw.forecast(holdout.length));
  const maError = mape(holdout, movingAverage(train).forecast(holdout.length));
  assert.ok(hwError < maError, `holt-winters (${hwError.toFixed(2)}%) should beat moving average (${maError.toFixed(2)}%)`);
  assert.ok(hwError < 5, `holt-winters error should be small on a clean series, got ${hwError.toFixed(2)}%`);
});

test('linear trend extrapolates a straight line', () => {
  const series = Array.from({ length: 30 }, (_, i) => 100 + 2 * i);
  const [next] = linearTrend(series).forecast(1);
  assert.ok(Math.abs(next - 160) < 1e-6);
});

test('holt-winters refuses a series shorter than two seasons', () => {
  assert.equal(holtWintersTuned([1, 2, 3, 4, 5, 6, 7, 8]), null);
});

// --- Data quality ---------------------------------------------------------

const row = (over = {}) => ({
  hospitalId: 'h1',
  date: new Date('2026-01-10'),
  opdVisits: 400, ipdAdmissions: 40, discharges: 38,
  occupiedBeds: 80, totalBeds: 100, occupiedIcuBeds: 20, totalIcuBeds: 30,
  otCases: 12, oxygenUnits: 300, bloodUnits: 20,
  ...over,
});

test('negative quantities are rejected, not trained on', () => {
  const { clean, issues } = validateRows([row(), row({ date: new Date('2026-01-11'), opdVisits: -50 })]);
  assert.equal(clean.length, 1);
  assert.ok(issues.some((i) => i.rule === 'NEGATIVE_QUANTITY' && i.field === 'opdVisits'));
});

test('duplicate dates are dropped', () => {
  const { clean, issues } = validateRows([row(), row()]);
  assert.equal(clean.length, 1);
  assert.ok(issues.some((i) => i.rule === 'DUPLICATE'));
});

test('occupancy above capacity is flagged as inconsistent', () => {
  const { clean, issues } = validateRows([row({ occupiedBeds: 140 })]);
  assert.equal(clean.length, 0);
  assert.ok(issues.some((i) => i.rule === 'INCONSISTENT_UNIT'));
});

test('future dates are rejected', () => {
  const { clean } = validateRows([row({ date: new Date(Date.now() + 5 * 86_400_000) })]);
  assert.equal(clean.length, 0);
});

test('a genuine surge is flagged but kept for training', () => {
  const rows = Array.from({ length: 40 }, (_, i) => row({
    date: new Date(2026, 0, i + 1),
    opdVisits: 400 + (i % 3),
  }));
  rows.push(row({ date: new Date(2026, 1, 15), opdVisits: 2000 }));
  const { clean, issues } = validateRows(rows);
  assert.equal(clean.length, 41, 'the outlier row is still usable data');
  assert.ok(issues.some((i) => i.rule === 'OUTLIER' && i.severity === 'WARNING'));
});

// --- Alerts ---------------------------------------------------------------

test('ICU alert fires when the forecast peak crosses 90 percent', () => {
  const alerts = evaluateAlerts({
    metric: 'ICU', horizonDays: 7, currentValue: 82, forecastMean: 88,
    points: [{ value: 86 }, { value: 91 }, { value: 89 }],
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'CRITICAL');
});

test('ICU alert stays quiet below the threshold', () => {
  const alerts = evaluateAlerts({
    metric: 'ICU', horizonDays: 7, currentValue: 70, forecastMean: 74,
    points: [{ value: 72 }, { value: 75 }],
  });
  assert.equal(alerts.length, 0);
});

test('oxygen alert fires on a demand increase, not on an absolute level', () => {
  const alerts = evaluateAlerts({
    metric: 'OXYGEN', horizonDays: 14, currentValue: 400, forecastMean: 472,
    points: [{ value: 470 }, { value: 474 }],
  });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /18%/);
});
