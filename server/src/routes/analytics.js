import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ROLES } from '../constants.js';
import { badRequest, parse, serialize, wrap } from '../lib/http.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { bedSummary } from './hospitals.js';

const router = Router();
router.use(authenticate);

// The receptionist is the only staff role, so every analytics screen is theirs.
const ANALYTICS_ROLES = [ROLES.RECEPTIONIST];

const startOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86_400_000);
const num = (v) => Number(v ?? 0);

function range(query) {
  const { from, to } = parse(z.object({ from: z.string().optional(), to: z.string().optional() }), query);
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : addDays(startOfDay(end), -29);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw badRequest('Invalid date range.');
  return { start: startOfDay(start), end };
}

// --- Hospital operational dashboard (PRD section 36) ---------------------

router.get('/dashboard', requireRole(...ANALYTICS_ROLES), wrap(async (req, res) => {
  const hospitalId = req.user.hospitalId;
  const today = startOfDay();
  const tomorrow = addDays(today, 1);

  const [opd, admissions, discharges, emergencies, pendingTests, beds, revenueRows, unreadAlerts] = await Promise.all([
    prisma.appointment.count({ where: { hospitalId, scheduledAt: { gte: today, lt: tomorrow }, status: { notIn: ['CANCELLED', 'REJECTED'] } } }),
    prisma.admission.count({ where: { hospitalId, admittedAt: { gte: today, lt: tomorrow } } }),
    prisma.admission.count({ where: { hospitalId, dischargedAt: { gte: today, lt: tomorrow } } }),
    prisma.emergencyCase.count({ where: { hospitalId, arrivedAt: { gte: today, lt: tomorrow } } }),
    prisma.labOrder.count({ where: { hospitalId, status: { in: ['ORDERED', 'SAMPLE_COLLECTED', 'PROCESSING', 'RESULT_ENTERED'] } } }),
    bedSummary(hospitalId),
    prisma.payment.findMany({
      where: { status: 'PAID', paidAt: { gte: today, lt: tomorrow }, bill: { hospitalId } },
      select: { amount: true },
    }),
    prisma.forecastAlert.count({ where: { hospitalId, acknowledgedAt: null } }),
  ]);

  res.json(serialize({
    date: today.toISOString().slice(0, 10),
    todayOpd: opd,
    todayAdmissions: admissions,
    todayDischarges: discharges,
    emergencyPatients: emergencies,
    pendingTests,
    beds,
    todayRevenue: Math.round(revenueRows.reduce((s, p) => s + num(p.amount), 0) * 100) / 100,
    openForecastAlerts: unreadAlerts,
  }));
}));

// --- Patient analytics (PRD section 37) ----------------------------------

router.get('/patients', requireRole(...ANALYTICS_ROLES), wrap(async (req, res) => {
  const hospitalId = req.user.hospitalId;
  const { start, end } = range(req.query);

  const appointments = await prisma.appointment.findMany({
    where: { hospitalId, scheduledAt: { gte: start, lte: end }, status: { notIn: ['CANCELLED', 'REJECTED'] } },
    select: {
      scheduledAt: true, patientId: true, departmentId: true, status: true,
      department: { select: { name: true } },
      patient: { select: { gender: true, dateOfBirth: true, createdAt: true } },
    },
  });

  const daily = new Map();
  const byDepartment = new Map();
  const byGender = new Map();
  const byAge = new Map([['0-17', 0], ['18-35', 0], ['36-55', 0], ['56-70', 0], ['70+', 0]]);
  const seen = new Set();
  let newPatients = 0;

  for (const a of appointments) {
    const day = a.scheduledAt.toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) || 0) + 1);
    const dept = a.department?.name || 'Unassigned';
    byDepartment.set(dept, (byDepartment.get(dept) || 0) + 1);
    const gender = a.patient.gender || 'UNKNOWN';
    byGender.set(gender, (byGender.get(gender) || 0) + 1);

    if (!seen.has(a.patientId)) {
      seen.add(a.patientId);
      if (a.patient.createdAt >= start) newPatients++;
      const bucket = ageBucket(a.patient.dateOfBirth);
      if (bucket) byAge.set(bucket, byAge.get(bucket) + 1);
    }
  }

  res.json({
    range: { from: start.toISOString(), to: end.toISOString() },
    totalVisits: appointments.length,
    uniquePatients: seen.size,
    newPatients,
    returningPatients: seen.size - newPatients,
    daily: fillDays(start, end, daily),
    byDepartment: toPairs(byDepartment),
    byGender: toPairs(byGender),
    byAgeGroup: toPairs(byAge),
  });
}));

// --- Doctor analytics -----------------------------------------------------

router.get('/doctors', requireRole(...ANALYTICS_ROLES), wrap(async (req, res) => {
  const hospitalId = req.user.hospitalId;
  const { start, end } = range(req.query);

  const doctors = await prisma.doctor.findMany({
    where: { hospitalId },
    include: { user: { select: { fullName: true } }, department: { select: { name: true } } },
  });

  const grouped = await prisma.appointment.groupBy({
    by: ['doctorId', 'status'],
    where: { hospitalId, scheduledAt: { gte: start, lte: end } },
    _count: { _all: true },
  });

  const stats = new Map();
  for (const row of grouped) {
    const entry = stats.get(row.doctorId) || { total: 0, completed: 0, noShow: 0, cancelled: 0, followUp: 0 };
    entry.total += row._count._all;
    if (row.status === 'COMPLETED') entry.completed += row._count._all;
    if (row.status === 'NO_SHOW') entry.noShow += row._count._all;
    if (row.status === 'CANCELLED') entry.cancelled += row._count._all;
    stats.set(row.doctorId, entry);
  }

  const followUps = await prisma.appointment.groupBy({
    by: ['doctorId'],
    where: { hospitalId, scheduledAt: { gte: start, lte: end }, type: 'FOLLOW_UP' },
    _count: { _all: true },
  });
  for (const row of followUps) {
    const entry = stats.get(row.doctorId) || { total: 0, completed: 0, noShow: 0, cancelled: 0, followUp: 0 };
    entry.followUp = row._count._all;
    stats.set(row.doctorId, entry);
  }

  const items = doctors.map((d) => {
    const s = stats.get(d.id) || { total: 0, completed: 0, noShow: 0, cancelled: 0, followUp: 0 };
    return {
      doctorId: d.id,
      name: d.user.fullName,
      department: d.department?.name || null,
      specialization: d.specialization,
      ...s,
      noShowRatePct: s.total ? Math.round((s.noShow / s.total) * 1000) / 10 : 0,
      completionRatePct: s.total ? Math.round((s.completed / s.total) * 1000) / 10 : 0,
    };
  }).sort((a, b) => b.completed - a.completed);

  res.json({ range: { from: start.toISOString(), to: end.toISOString() }, items });
}));

// --- Financial analytics --------------------------------------------------

router.get('/financial', requireRole(...ANALYTICS_ROLES), wrap(async (req, res) => {
  const hospitalId = req.user.hospitalId;
  const { start, end } = range(req.query);

  const [payments, items, outstanding] = await Promise.all([
    prisma.payment.findMany({
      where: { status: 'PAID', paidAt: { gte: start, lte: end }, bill: { hospitalId } },
      select: { amount: true, method: true, paidAt: true },
    }),
    prisma.billItem.findMany({
      where: { bill: { hospitalId, createdAt: { gte: start, lte: end } } },
      select: { category: true, amount: true },
    }),
    prisma.bill.findMany({
      where: { hospitalId, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
      select: { total: true, paidAmount: true },
    }),
  ]);

  const daily = new Map();
  const byMethod = new Map();
  for (const p of payments) {
    const day = p.paidAt.toISOString().slice(0, 10);
    daily.set(day, Math.round((((daily.get(day) || 0) + num(p.amount))) * 100) / 100);
    byMethod.set(p.method, Math.round((((byMethod.get(p.method) || 0) + num(p.amount))) * 100) / 100);
  }

  const byCategory = new Map();
  for (const i of items) {
    byCategory.set(i.category, Math.round((((byCategory.get(i.category) || 0) + num(i.amount))) * 100) / 100);
  }

  res.json({
    range: { from: start.toISOString(), to: end.toISOString() },
    totalCollected: Math.round(payments.reduce((s, p) => s + num(p.amount), 0) * 100) / 100,
    outstanding: Math.round(outstanding.reduce((s, b) => s + (num(b.total) - num(b.paidAmount)), 0) * 100) / 100,
    daily: fillDays(start, end, daily, 0),
    byCategory: toPairs(byCategory),
    byPaymentMethod: toPairs(byMethod),
  });
}));

// --- Operational / bed analytics -----------------------------------------

router.get('/operations', requireRole(...ANALYTICS_ROLES), wrap(async (req, res) => {
  const hospitalId = req.user.hospitalId;
  const { start, end } = range(req.query);

  const [daily, waiting, labs] = await Promise.all([
    prisma.hospitalResourceDaily.findMany({
      where: { hospitalId, date: { gte: start, lte: end } },
      orderBy: { date: 'asc' },
    }),
    prisma.appointment.findMany({
      where: { hospitalId, status: 'COMPLETED', checkedInAt: { not: null }, startedAt: { not: null }, scheduledAt: { gte: start, lte: end } },
      select: { checkedInAt: true, startedAt: true },
    }),
    prisma.labOrder.groupBy({ by: ['status'], where: { hospitalId, orderedAt: { gte: start, lte: end } }, _count: { _all: true } }),
  ]);

  const waitMinutes = waiting.map((a) => (a.startedAt - a.checkedInAt) / 60_000).filter((m) => m >= 0);

  res.json(serialize({
    range: { from: start.toISOString(), to: end.toISOString() },
    occupancy: daily.map((d) => ({
      date: d.date.toISOString().slice(0, 10),
      bedOccupancyPct: d.totalBeds ? Math.round((d.occupiedBeds / d.totalBeds) * 1000) / 10 : 0,
      icuOccupancyPct: d.totalIcuBeds ? Math.round((d.occupiedIcuBeds / d.totalIcuBeds) * 1000) / 10 : 0,
      opdVisits: d.opdVisits,
      ipdAdmissions: d.ipdAdmissions,
      otCases: d.otCases,
      oxygenUnits: d.oxygenUnits,
      bloodUnits: d.bloodUnits,
    })),
    averageWaitMinutes: waitMinutes.length
      ? Math.round((waitMinutes.reduce((a, b) => a + b, 0) / waitMinutes.length) * 10) / 10
      : null,
    labOrdersByStatus: labs.map((l) => ({ status: l.status, count: l._count._all })),
  }));
}));

// --- Audit log (PRD section 50) ------------------------------------------

// Scoped to people who work at this hospital — its own doctors and desk staff.
// Without that filter a receptionist would read another hospital's audit trail.
router.get('/audit-logs', requireRole(...ANALYTICS_ROLES), wrap(async (req, res) => {
  const q = parse(z.object({
    action: z.string().optional(),
    entityType: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  }), req.query);

  const [doctors, staff] = await Promise.all([
    prisma.doctor.findMany({ where: { hospitalId: req.user.hospitalId }, select: { userId: true } }),
    prisma.hospitalStaff.findMany({ where: { hospitalId: req.user.hospitalId }, select: { userId: true } }),
  ]);
  const userIds = [...doctors, ...staff].map((r) => r.userId);

  const where = {
    userId: { in: userIds },
    ...(q.action ? { action: { in: q.action.split(',') } } : {}),
    ...(q.entityType ? { entityType: q.entityType } : {}),
    ...(q.from || q.to
      ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { fullName: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);
  res.json(serialize({ total, page: q.page, pageSize: q.pageSize, items }));
}));

// --- Reports & export (PRD section 66) -----------------------------------

const REPORTS = {
  opd: async (hospitalId, start, end) => {
    const rows = await prisma.appointment.findMany({
      where: { hospitalId, scheduledAt: { gte: start, lte: end } },
      include: {
        patient: { include: { user: { select: { fullName: true } } } },
        doctor: { include: { user: { select: { fullName: true } } } },
        department: { select: { name: true } },
      },
      orderBy: { scheduledAt: 'asc' },
    });
    return rows.map((a) => ({
      date: a.scheduledAt.toISOString().slice(0, 10),
      time: a.scheduledAt.toISOString().slice(11, 16),
      patient: a.patient.user.fullName,
      doctor: a.doctor.user.fullName,
      department: a.department?.name || '',
      type: a.type,
      status: a.status,
      fee: num(a.fee),
    }));
  },
  admissions: async (hospitalId, start, end) => {
    const rows = await prisma.admission.findMany({
      where: { hospitalId, requestedAt: { gte: start, lte: end } },
      include: {
        patient: { include: { user: { select: { fullName: true } } } },
        doctor: { include: { user: { select: { fullName: true } } } },
        bed: true, department: { select: { name: true } },
      },
      orderBy: { requestedAt: 'asc' },
    });
    return rows.map((a) => ({
      admissionId: a.id,
      patient: a.patient.user.fullName,
      doctor: a.doctor.user.fullName,
      department: a.department?.name || '',
      bed: a.bed?.bedNumber || '',
      status: a.status,
      admittedAt: a.admittedAt?.toISOString() || '',
      dischargedAt: a.dischargedAt?.toISOString() || '',
    }));
  },
  occupancy: async (hospitalId, start, end) => {
    const rows = await prisma.hospitalResourceDaily.findMany({
      where: { hospitalId, date: { gte: start, lte: end } }, orderBy: { date: 'asc' },
    });
    return rows.map((d) => ({
      date: d.date.toISOString().slice(0, 10),
      occupiedBeds: d.occupiedBeds,
      totalBeds: d.totalBeds,
      bedOccupancyPct: d.totalBeds ? Math.round((d.occupiedBeds / d.totalBeds) * 1000) / 10 : 0,
      occupiedIcuBeds: d.occupiedIcuBeds,
      totalIcuBeds: d.totalIcuBeds,
      icuOccupancyPct: d.totalIcuBeds ? Math.round((d.occupiedIcuBeds / d.totalIcuBeds) * 1000) / 10 : 0,
      otCases: d.otCases,
      oxygenUnits: d.oxygenUnits,
      bloodUnits: d.bloodUnits,
    }));
  },
  revenue: async (hospitalId, start, end) => {
    const rows = await prisma.bill.findMany({
      where: { hospitalId, createdAt: { gte: start, lte: end } },
      include: { patient: { include: { user: { select: { fullName: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((b) => ({
      billNumber: b.billNumber,
      date: b.createdAt.toISOString().slice(0, 10),
      patient: b.patient.user.fullName,
      total: num(b.total),
      paid: num(b.paidAmount),
      outstanding: Math.round((num(b.total) - num(b.paidAmount)) * 100) / 100,
      status: b.status,
    }));
  },
  pharmacy: async (hospitalId) => {
    const rows = await prisma.medicine.findMany({ where: { hospitalId }, orderBy: { name: 'asc' } });
    return rows.map((m) => ({
      medicine: m.name,
      batch: m.batchNumber,
      quantity: m.quantity,
      reorderLevel: m.reorderLevel,
      expiryDate: m.expiryDate.toISOString().slice(0, 10),
      supplier: m.supplier || '',
      price: num(m.price),
    }));
  },
  lab: async (hospitalId, start, end) => {
    const rows = await prisma.labOrder.findMany({
      where: { hospitalId, orderedAt: { gte: start, lte: end } },
      include: {
        items: { include: { labTest: true } },
        patient: { include: { user: { select: { fullName: true } } } },
      },
      orderBy: { orderedAt: 'asc' },
    });
    return rows.flatMap((o) => o.items.map((i) => ({
      date: o.orderedAt.toISOString().slice(0, 10),
      patient: o.patient.user.fullName,
      test: i.labTest.name,
      result: i.resultValue || '',
      flag: i.flag || '',
      status: o.status,
      price: num(i.labTest.price),
    })));
  },
  forecast: async (hospitalId) => {
    const rows = await prisma.forecast.findMany({
      where: { hospitalId },
      orderBy: { generatedAt: 'desc' },
      take: 200,
      include: { points: { orderBy: { date: 'asc' } } },
    });
    return rows.map((f) => ({
      metric: f.metric + (f.subKey ? ` (${f.subKey})` : ''),
      horizonDays: f.horizonDays,
      model: f.model,
      currentValue: f.currentValue,
      forecastMean: f.forecastMean,
      mae: f.mae,
      rmse: f.rmse,
      mape: f.mape,
      generatedAt: f.generatedAt.toISOString(),
    }));
  },
};

router.get('/reports/:type', requireRole(...ANALYTICS_ROLES), wrap(async (req, res) => {
  const type = req.params.type;
  const build = REPORTS[type];
  if (!build) throw badRequest(`Unknown report. Available: ${Object.keys(REPORTS).join(', ')}.`);

  const { format } = parse(z.object({ format: z.enum(['json', 'csv']).default('json') }), req.query);
  const { start, end } = range(req.query);
  const rows = await build(req.user.hospitalId, start, end);

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${type}-report.csv"`);
    return res.send(toCsv(rows));
  }
  res.json({ type, range: { from: start.toISOString(), to: end.toISOString() }, rows });
}));

// --- helpers --------------------------------------------------------------

function ageBucket(dob) {
  if (!dob) return null;
  const years = Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 86_400_000));
  if (years < 18) return '0-17';
  if (years <= 35) return '18-35';
  if (years <= 55) return '36-55';
  if (years <= 70) return '56-70';
  return '70+';
}

// Charts need a point for every day in the range, including the empty ones.
function fillDays(start, end, map, fallback = 0) {
  const out = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, value: map.get(key) ?? fallback });
  }
  return out;
}

const toPairs = (map) => [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n');
}

export default router;
