import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { BED_STATUS, BED_TYPES, ROLES } from '../constants.js';
import { badRequest, forbidden, notFound, parse, serialize, wrap } from '../lib/http.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { bedSummary } from './hospitals.js';

const router = Router();
router.use(authenticate);

const BED_ROLES = [ROLES.RECEPTIONIST];

router.get('/', requireRole(...BED_ROLES), wrap(async (req, res) => {
  const q = parse(z.object({
    type: z.string().optional(),
    status: z.string().optional(),
    ward: z.string().optional(),
    departmentId: z.string().optional(),
  }), req.query);

  const beds = await prisma.bed.findMany({
    where: {
      hospitalId: req.user.hospitalId,
      ...(q.type ? { type: { in: q.type.split(',') } } : {}),
      ...(q.status ? { status: { in: q.status.split(',') } } : {}),
      ...(q.ward ? { ward: q.ward } : {}),
      ...(q.departmentId ? { departmentId: q.departmentId } : {}),
    },
    orderBy: [{ ward: 'asc' }, { bedNumber: 'asc' }],
    include: {
      department: { select: { name: true } },
      admissions: {
        where: { status: 'ADMITTED' },
        select: {
          id: true, admittedAt: true, reason: true,
          patient: { select: { id: true, user: { select: { fullName: true } } } },
        },
      },
    },
  });
  res.json(serialize(beds));
}));

// Live occupancy for the dashboard and the ICU screen (PRD sections 27-28).
router.get('/summary', requireRole(...BED_ROLES), wrap(async (req, res) => {
  const [summary, byStatus] = await Promise.all([
    bedSummary(req.user.hospitalId),
    prisma.bed.groupBy({ by: ['type', 'status'], where: { hospitalId: req.user.hospitalId }, _count: { _all: true } }),
  ]);
  const criticalPatients = await prisma.admission.count({
    where: { hospitalId: req.user.hospitalId, status: 'ADMITTED', bed: { type: 'ICU' } },
  });
  res.json(serialize({
    ...summary,
    criticalPatients,
    breakdown: byStatus.map((r) => ({ type: r.type, status: r.status, count: r._count._all })),
  }));
}));

const bedSchema = z.object({
  bedNumber: z.string().min(1),
  ward: z.string().default('GENERAL'),
  type: z.enum(BED_TYPES).default('GENERAL'),
  hasVentilator: z.boolean().default(false),
  dailyCharge: z.number().min(0).default(0),
  departmentId: z.string().optional(),
});

router.post('/', requireRole(ROLES.RECEPTIONIST), wrap(async (req, res) => {
  const data = parse(bedSchema, req.body);
  const bed = await prisma.bed.create({ data: { ...data, hospitalId: req.user.hospitalId } });
  await syncCapacity(req.user.hospitalId);
  res.status(201).json(serialize(bed));
}));

// Bulk creation — a new ward is 20 beds, not 20 API calls.
router.post('/bulk', requireRole(ROLES.RECEPTIONIST), wrap(async (req, res) => {
  const data = parse(z.object({
    prefix: z.string().min(1),
    from: z.number().int().min(1),
    to: z.number().int().min(1),
    ward: z.string().default('GENERAL'),
    type: z.enum(BED_TYPES).default('GENERAL'),
    hasVentilator: z.boolean().default(false),
    dailyCharge: z.number().min(0).default(0),
    departmentId: z.string().optional(),
  }), req.body);
  if (data.to < data.from) throw badRequest('"to" must not be smaller than "from".');
  if (data.to - data.from > 500) throw badRequest('Create at most 500 beds in one request.');

  const rows = [];
  for (let i = data.from; i <= data.to; i++) {
    rows.push({
      hospitalId: req.user.hospitalId,
      bedNumber: `${data.prefix}-${String(i).padStart(3, '0')}`,
      ward: data.ward,
      type: data.type,
      hasVentilator: data.hasVentilator,
      dailyCharge: data.dailyCharge,
      departmentId: data.departmentId,
    });
  }
  const result = await prisma.bed.createMany({ data: rows, skipDuplicates: true });
  await syncCapacity(req.user.hospitalId);
  res.status(201).json({ created: result.count });
}));

router.put('/:id', requireRole(...BED_ROLES), wrap(async (req, res) => {
  const bed = await loadBed(req);
  const data = parse(bedSchema.partial().extend({ status: z.enum(BED_STATUS).optional() }), req.body);

  // An occupied bed is freed by discharging the patient, not by editing a field.
  if (data.status && bed.status === 'OCCUPIED' && data.status !== 'OCCUPIED') {
    const active = await prisma.admission.findFirst({ where: { bedId: bed.id, status: 'ADMITTED' } });
    if (active) throw badRequest('Discharge the patient before changing this bed status.');
  }
  const updated = await prisma.bed.update({ where: { id: bed.id }, data });
  if (data.type) await syncCapacity(req.user.hospitalId);
  res.json(serialize(updated));
}));

router.delete('/:id', requireRole(ROLES.RECEPTIONIST), wrap(async (req, res) => {
  const bed = await loadBed(req);
  if (bed.status === 'OCCUPIED') throw badRequest('Cannot delete an occupied bed.');
  await prisma.bed.delete({ where: { id: bed.id } });
  await syncCapacity(req.user.hospitalId);
  res.json({ message: 'Bed removed.' });
}));

async function loadBed(req) {
  const bed = await prisma.bed.findUnique({ where: { id: req.params.id } });
  if (!bed) throw notFound('Bed not found.');
  if (bed.hospitalId !== req.user.hospitalId) {
    throw forbidden('That bed belongs to another hospital.');
  }
  return bed;
}

// Hospital.totalBeds / icuCapacity are what the public profile and the forecast
// denominators read, so they follow the bed table rather than being typed twice.
export async function syncCapacity(hospitalId) {
  const [total, icu] = await Promise.all([
    prisma.bed.count({ where: { hospitalId, type: { not: 'ICU' } } }),
    prisma.bed.count({ where: { hospitalId, type: 'ICU' } }),
  ]);
  await prisma.hospital.update({ where: { id: hospitalId }, data: { totalBeds: total, icuCapacity: icu } });
}

export default router;
