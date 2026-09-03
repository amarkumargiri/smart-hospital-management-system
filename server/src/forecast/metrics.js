// Accuracy metrics used to pick the winning model (PRD section 43).

export function mae(actual, predicted) {
  const n = actual.length;
  if (!n) return Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(actual[i] - predicted[i]);
  return sum / n;
}

export function rmse(actual, predicted) {
  const n = actual.length;
  if (!n) return Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (actual[i] - predicted[i]) ** 2;
  return Math.sqrt(sum / n);
}

// Percentage error is undefined when the actual is zero, so those points are
// skipped rather than counted as infinite error.
export function mape(actual, predicted) {
  let sum = 0;
  let counted = 0;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] === 0) continue;
    sum += Math.abs((actual[i] - predicted[i]) / actual[i]);
    counted++;
  }
  return counted ? (sum / counted) * 100 : Infinity;
}

export const scoreAll = (actual, predicted) => ({
  mae: mae(actual, predicted),
  rmse: rmse(actual, predicted),
  mape: mape(actual, predicted),
});

export function stdev(values) {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
}
