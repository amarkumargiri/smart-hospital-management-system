import { prisma } from '../db.js';
import { stdev } from './metrics.js';

// PRD section 44. Rows that fail an ERROR rule are excluded from training;
// WARNING rows are kept but recorded so the hospital can fix its data entry.

const NON_NEGATIVE_FIELDS = [
  'opdVisits', 'ipdAdmissions', 'discharges', 'occupiedBeds', 'totalBeds',
  'occupiedIcuBeds', 'totalIcuBeds', 'otCases', 'oxygenUnits', 'bloodUnits',
];

const OUTLIER_SIGMAS = 4;

export function validateRows(rows) {
  const clean = [];
  const issues = [];
  const seenDates = new Set();

  for (const row of rows) {
    const date = row.date instanceof Date ? row.date : new Date(row.date);
    const push = (rule, field, detail, severity = 'ERROR') =>
      issues.push({ hospitalId: row.hospitalId, date, rule, field, detail, severity });

    if (Number.isNaN(date.getTime())) {
      push('INVALID_DATE', 'date', `Unparseable date: ${row.date}`);
      continue;
    }
    if (date > new Date()) {
      push('INVALID_DATE', 'date', `Date is in the future: ${date.toISOString().slice(0, 10)}`);
      continue;
    }

    const key = date.toISOString().slice(0, 10);
    if (seenDates.has(key)) {
      push('DUPLICATE', 'date', `More than one record for ${key}`);
      continue;
    }
    seenDates.add(key);

    let rowIsBad = false;
    for (const field of NON_NEGATIVE_FIELDS) {
      const value = row[field];
      if (value === null || value === undefined) {
        push('MISSING_VALUE', field, `${field} is missing for ${key}`, 'WARNING');
        continue;
      }
      if (Number(value) < 0) {
        push('NEGATIVE_QUANTITY', field, `${field} = ${value} for ${key}`);
        rowIsBad = true;
      }
    }

    // Occupancy above capacity means the two numbers came from different places.
    if (Number(row.occupiedBeds) > Number(row.totalBeds) && Number(row.totalBeds) > 0) {
      push('INCONSISTENT_UNIT', 'occupiedBeds',
        `Occupied beds (${row.occupiedBeds}) exceeds total beds (${row.totalBeds}) on ${key}`);
      rowIsBad = true;
    }
    if (Number(row.occupiedIcuBeds) > Number(row.totalIcuBeds) && Number(row.totalIcuBeds) > 0) {
      push('INCONSISTENT_UNIT', 'occupiedIcuBeds',
        `Occupied ICU beds (${row.occupiedIcuBeds}) exceeds ICU capacity (${row.totalIcuBeds}) on ${key}`);
      rowIsBad = true;
    }

    if (!rowIsBad) clean.push(row);
  }

  // Outliers are judged against the surviving rows, and only flagged — a genuine
  // surge is exactly the signal the forecast is supposed to learn from.
  for (const field of ['opdVisits', 'ipdAdmissions', 'oxygenUnits']) {
    const values = clean.map((r) => Number(r[field] ?? 0));
    if (values.length < 14) continue;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = stdev(values);
    if (sd === 0) continue;
    clean.forEach((row, i) => {
      if (Math.abs(values[i] - avg) > OUTLIER_SIGMAS * sd) {
        issues.push({
          hospitalId: row.hospitalId,
          date: row.date,
          rule: 'OUTLIER',
          field,
          detail: `${field} = ${values[i]} is ${OUTLIER_SIGMAS}+ standard deviations from the mean (${avg.toFixed(1)})`,
          severity: 'WARNING',
        });
      }
    });
  }

  return { clean, issues };
}

export async function recordIssues(issues) {
  if (!issues.length) return 0;
  await prisma.dataQualityIssue.createMany({ data: issues });
  return issues.length;
}
