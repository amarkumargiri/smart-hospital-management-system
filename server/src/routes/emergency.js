import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ROLES, TRIAGE_LEVELS } from '../constants.js';
import { badRequest, conflict, forbidden, notFound, parse, serialize, wrap } from '../lib/http.js';
import { notify } from '../lib/notify.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

const ED_ROLES = [ROLES.RECEPTIONIST, ROLES.DOCTOR];

const include = {
  patient: { include: { user: { select: { id: true, fullName: true, mobile: true } } } },
};

// Triage order, then arrival time — the list is the working queue.
const TRIAGE_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

router.get('/', requireRole(...ED_ROLES), wrap(async (req, res) => {
  const { status } = parse(z.object({ status: z.string().optional() }), req.query);
  const cases = await prisma.emergencyCase.findMany({
    where: {
      hospitalId: req.user.hospitalId,
      status: { in: status ? status.split(',') : ['REGISTERED', 'IN_TREATMENT'] },
    },
    include,
    orderBy: { arrivedAt: 'asc' },
  });
  cases.sort((a, b) => TRIAGE_RANK[a.triage] - TRIAGE_RANK[b.triage] || a.arrivedAt - b.arrivedAt);
  res.json(serialize(cases));
}));

// Emergency registration accepts a walk-in with no account — asking an
// unconscious patient to sign up first is not a workable triage flow.
router.post('/', requireRole(...ED_ROLES), wrap(async (req, res) => {
  const data = parse(z.object({
    patientId: z.string().optional(),
    walkInName: z.string().optional(),
    walkInPhone: z.string().optional(),
    triage: z.enum(TRIAGE_LEVELS).default('MEDIUM'),
    complaint: z.string().min(3),
    assignedDoctorId: z.string().optional(),
  }), req.body);
  if (!data.patientId && !data.walkInName) throw badRequest('Provide either a registered patient or a walk-in name.');

  const emergencyCase = await prisma.emergencyCase.create({
    data: { ...data, hospitalId: req.user.hospitalId },
    include,
  });

  if (data.assignedDoctorId) await notifyDoctor(data.assignedDoctorId, emergencyCase);
  res.status(201).json(serialize(emergencyCase));
}));

router.put('/:id', requireRole(...ED_ROLES), wrap(async (req, res) => {
  const emergencyCase = await load(req);
  const data = parse(z.object({
    triage: z.enum(TRIAGE_LEVELS).optional(),
    complaint: z.string().optional(),
    assignedDoctorId: z.string().optional(),
    status: z.enum(['IN_TREATMENT', 'DISCHARGED', 'REFERRED']).optional(),
  }), req.body);

  const updated = await prisma.emergencyCase.update({
    where: { id: emergencyCase.id },
    data: { ...data, ...(data.status && data.status !== 'IN_TREATMENT' ? { closedAt: new Date() } : {}) },
    include,
  });
  if (data.assignedDoctorId && data.assignedDoctorId !== emergencyCase.assignedDoctorId) {
    await notifyDoctor(data.assignedDoctorId, updated);
  }
  res.json(serialize(updated));
}));

// Allocating an emergency bed claims it atomically, same as a ward admission.
router.post('/:id/allocate-bed', requireRole(...ED_ROLES), wrap(async (req, res) => {
  const emergencyCase = await load(req);
  const { bedId } = parse(z.object({ bedId: z.string() }), req.body);

  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.bed.updateMany({
      where: { id: bedId, hospitalId: req.user.hospitalId, status: 'AVAILABLE' },
      data: { status: 'OCCUPIED' },
    });
    if (claimed.count === 0) return null;
    if (emergencyCase.bedId) await tx.bed.update({ where: { id: emergencyCase.bedId }, data: { status: 'CLEANING' } });
    return tx.emergencyCase.update({
      where: { id: emergencyCase.id },
      data: { bedId, status: 'IN_TREATMENT' },
      include,
    });
  });
  if (!result) throw conflict('No bed is available at that location. Please choose another bed.');
  res.json(serialize(result));
}));

// Escalating an emergency case into an inpatient admission.
router.post('/:id/admit', requireRole(...ED_ROLES), wrap(async (req, res) => {
  const emergencyCase = await load(req);
  if (!emergencyCase.patientId) throw badRequest('Register the walk-in as a patient before admitting them.');
  const { doctorId, departmentId, reason } = parse(z.object({
    doctorId: z.string(),
    departmentId: z.string().optional(),
    reason: z.string().optional(),
  }), req.body);

  const admission = await prisma.admission.create({
    data: {
      patientId: emergencyCase.patientId,
      hospitalId: emergencyCase.hospitalId,
      doctorId,
      departmentId,
      reason: reason || emergencyCase.complaint,
      status: 'APPROVED',
    },
  });
  await prisma.emergencyCase.update({
    where: { id: emergencyCase.id },
    data: { status: 'ADMITTED', closedAt: new Date() },
  });
  res.status(201).json(serialize(admission));
}));

async function notifyDoctor(doctorId, emergencyCase) {
  const doctor = await prisma.doctor.findUnique({ where: { id: doctorId }, select: { userId: true } });
  if (!doctor) return;
  const name = emergencyCase.patient?.user.fullName || emergencyCase.walkInName;
  await notify(doctor.userId, {
    category: 'SYSTEM',
    title: `Emergency patient assigned (${emergencyCase.triage})`,
    body: `${name}: ${emergencyCase.complaint}`,
    link: '/doctor/emergency',
    severity: emergencyCase.triage === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
  });
}

async function load(req) {
  const emergencyCase = await prisma.emergencyCase.findUnique({ where: { id: req.params.id } });
  if (!emergencyCase) throw notFound('Emergency case not found.');
  if (emergencyCase.hospitalId !== req.user.hospitalId) {
    throw forbidden('That case belongs to another hospital.');
  }
  return emergencyCase;
}

export default router;
