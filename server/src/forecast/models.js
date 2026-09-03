// Forecasting models. Everything here is a pure function over a numeric series:
// fit(series) -> { forecast(h) -> number[], fitted -> number[] }.
//
// Hospital demand series are short (1-3 years of daily points) and dominated by
// a weekly cycle plus a slow trend. Holt-Winters with a 7-day season captures
// exactly that, and the simpler models are kept as baselines so the engine can
// prove the complex one is actually earning its place.

const SEASON = 7; // days per week

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

// --- Moving average --------------------------------------------------------

export function movingAverage(series, window = 7) {
  const w = Math.min(window, series.length);
  const level = mean(series.slice(-w));
  return {
    name: 'MOVING_AVERAGE',
    params: { window: w },
    forecast: (h) => Array.from({ length: h }, () => level),
  };
}

// --- Seasonal naive --------------------------------------------------------
// Prediction for day t is the value observed on the same weekday last week.

export function seasonalNaive(series) {
  const tail = series.slice(-SEASON);
  return {
    name: 'SEASONAL_NAIVE',
    params: { season: SEASON },
    forecast: (h) => Array.from({ length: h }, (_, i) => tail[i % SEASON] ?? series.at(-1)),
  };
}

// --- Linear trend (ordinary least squares on the time index) ---------------

export function linearTrend(series) {
  const n = series.length;
  const xMean = (n - 1) / 2;
  const yMean = mean(series);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (series[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;
  return {
    name: 'LINEAR_TREND',
    params: { slope, intercept },
    forecast: (h) => Array.from({ length: h }, (_, i) => intercept + slope * (n + i)),
  };
}

// --- Holt-Winters, additive trend and additive weekly seasonality ----------

function holtWintersFit(series, alpha, beta, gamma) {
  const n = series.length;
  if (n < SEASON * 2) return null;

  // Initial level/trend/seasonals from the first two complete weeks.
  const firstSeason = series.slice(0, SEASON);
  const secondSeason = series.slice(SEASON, SEASON * 2);
  let level = mean(firstSeason);
  let trend = (mean(secondSeason) - mean(firstSeason)) / SEASON;
  const seasonals = firstSeason.map((v) => v - level);

  const fitted = new Array(n).fill(0);
  for (let t = 0; t < n; t++) {
    const s = seasonals[t % SEASON];
    fitted[t] = level + trend + s;
    const value = series[t];
    const lastLevel = level;
    level = alpha * (value - s) + (1 - alpha) * (level + trend);
    trend = beta * (level - lastLevel) + (1 - beta) * trend;
    seasonals[t % SEASON] = gamma * (value - level) + (1 - gamma) * s;
  }

  const residuals = series.map((v, i) => v - fitted[i]);
  return { level, trend, seasonals, fitted, residuals, n };
}

export function holtWinters(series, { alpha = 0.3, beta = 0.05, gamma = 0.3 } = {}) {
  const state = holtWintersFit(series, alpha, beta, gamma);
  if (!state) return null;
  return {
    name: 'HOLT_WINTERS',
    params: { alpha, beta, gamma },
    fitted: state.fitted,
    forecast: (h) =>
      Array.from({ length: h }, (_, i) =>
        state.level + state.trend * (i + 1) + state.seasonals[(state.n + i) % SEASON]),
  };
}

// Coarse grid search. 125 fits over a few hundred points is milliseconds, and
// it beats hand-picked smoothing constants on every series we tested.
// ponytail: grid search, swap for Nelder-Mead only if fit time becomes visible.
const GRID = [0.1, 0.3, 0.5, 0.7, 0.9];

export function holtWintersTuned(series) {
  let best = null;
  let bestSse = Infinity;
  for (const alpha of GRID) {
    for (const beta of GRID) {
      for (const gamma of GRID) {
        const state = holtWintersFit(series, alpha, beta, gamma);
        if (!state) return null;
        // Skip the first season: those fitted values come from the seed values.
        let sse = 0;
        for (let t = SEASON; t < state.n; t++) sse += state.residuals[t] ** 2;
        if (Number.isFinite(sse) && sse < bestSse) {
          bestSse = sse;
          best = { alpha, beta, gamma };
        }
      }
    }
  }
  return best ? holtWinters(series, best) : null;
}

// Every candidate the engine will race against the others.
export function candidateModels(series) {
  return [movingAverage(series), seasonalNaive(series), linearTrend(series), holtWintersTuned(series)]
    .filter(Boolean);
}

export { SEASON };
