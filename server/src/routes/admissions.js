import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ADMISSION_STATUS, AUDIT_ACTIONS, ROLES } from '../constants.js';
import { assertPatientAccess } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound, parse, serialize, wrap } from '../lib/http.js';
import { notify } from '../lib/notify.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { createAdmissionBill } from './billing.js';

const router = Router();
router.use(authenticate);

const WARD_ROLES = [ROLES.RECEPTIONIST];

const include = {
  patient: { include: { user: { select: { id: true, fullName: true, mobile: true } } } },
  doctor: { include: { user: { select: { id: true, fullName: true } } } },
  bed: true,
  department: { select: { id: true, name: true } },
  discharge: true,
};

router.get('/', wrap(async (req, res) => {
  const q = parse(z.object({
    status: z.string().optional(),
    patientId: z.string().optional(),
    departmentId: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }), req.query);

  const scope = req.user.role === ROLES.PATIENT
    ? { patientId: req.user.patientId }
    : req.user.role === ROLES.DOCTOR ? { doctorId: req.user.doctorId }
    : { hospitalId: req.user.hospitalId };

  const where = {
    ...scope,
    ...(q.status ? { status: { in: q.status.split(',') } } : {}),
    ...(q.departmentId ? { departmentId: q.departmentId } : {}),
    ...(q.patientId && req.user.role !== ROLES.PATIENT ? { patientId: q.patientId } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.admission.count({ where }),
    prisma.admission.findMany({
      where, include, orderBy: { requestedAt: 'desc' },
      skip: (q.page - 1) * q.pageSize, take: q.pageSize,
    }),
  ]);
  res.json(serialize({ total, page: q.page, pageSize: q.pageSize, items }));
}));

router.get('/:id', wrap(async (req, res) => {
  const admission = await prisma.admission.findUnique({
    where: { id: req.params.id },
    include: { ...include, labOrders: { include: { items: { include: { labTest: true } }, report: true } }, surgeries: true },
  });
  if (!admission) throw notFound('Admission not found.');
  await assertPatientAccess(req.user, admission.patientId);
  res.json(serialize(admission));
}));

// A doctor recommends admission; the ward approves and allocates a bed.
router.post('/', requireRole(ROLES.DOCTOR), wrap(async (req, res) => {
  const data = parse(z.object({
    patientId: z.string(),
    departmentId: z.string().optional(),
    reason: z.string().min(3),
    diagnosis: z.string().optional(),
  }), req.body);
  await assertPatientAccess(req.user, data.patientId);

  const open = await prisma.admission.findFirst({
    where: { patientId: data.patientId, status: { in: ['REQUESTED', 'APPROVED', 'ADMITTED'] } },
  });
  if (open) throw conflict('This patient already has an open admission.');

  const admission = await prisma.admission.create({
    data: {
      ...data,
      doctorId: req.user.doctorId,
      hospitalId: req.user.hospitalId,
      departmentId: data.departmentId || req.user.departmentId,
    },
    include,
  });
  res.status(201).json(serialize(admission));
}));

router.post('/:id/approve', requireRole(...WARD_ROLES), wrap(async (req, res) => {
  const admission = await loadHospitalAdmission(req);
  if (admission.status !== ADMISSION_STATUS.REQUESTED) {
    throw badRequest(`Only a requested admission can be approved (this one is ${admission.status}).`);
  }
  res.json(serialize(await prisma.admission.update({
    where: { id: admission.id }, data: { status: ADMISSION_STATUS.APPROVED }, include,
  })));
}));

router.post('/:id/reject', requireRole(...WARD_ROLES), wrap(async (req, res) => {
  const admission = await loadHospitalAdmission(req);
  if (!['REQUESTED', 'APPROVED'].includes(admission.status)) {
    throw badRequest(`Cannot reject an admission that is ${admission.status}.`);
  }
  const updated = await prisma.admission.update({
    where: { id: admission.id }, data: { status: ADMISSION_STATUS.REJECTED }, include,
  });
  await notify(updated.doctor.userId, {
    category: 'SYSTEM',
    title: 'Admission request rejected',
    body: `The admission request for ${updated.patient.user.fullName} was rejected.`,
    link: '/doctor/admissions',
  });
  res.json(serialize(updated));
}));

// Bed allocation and admission are one step: claiming the bed is what makes the
// patient admitted, and doing it in a transaction is what stops two patients
// landing in the same bed.
router.post('/:id/admit', requireRole(...WARD_ROLES), wrap(async (req, res) => {
  const admission = await loadHospitalAdmission(req);
  if (!['REQUESTED', 'APPROVED'].includes(admission.status)) {
    throw badRequest(`Cannot admit a patient whose admission is ${admission.status}.`);
  }
  const { bedId } = parse(z.object({ bedId: z.string() }), req.body);

  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.bed.updateMany({
      where: { id: bedId, hospitalId: admission.hospitalId, status: 'AVAILABLE' },
      data: { status: 'OCCUPIED' },
    });
    if (claimed.count === 0) return null;
    return tx.admission.update({
      where: { id: admission.id },
      data: { status: ADMISSION_STATUS.ADMITTED, bedId, admittedAt: new Date() },
      include,
    });
  });
  if (!result) throw conflict('That bed is no longer available. Please choose another bed.');

  await audit(req, AUDIT_ACTIONS.ADMIT_PATIENT, { entityType: 'Admission', entityId: admission.id });
  await notify(result.patient.userId, {
    category: 'SYSTEM',
    title: 'Admitted',
    body: `You have been admitted to bed ${result.bed.bedNumber} (${result.bed.ward}).`,
    link: '/records',
  });
  res.json(serialize(result));
}));

// Moving a patient between beds — both beds change state together.
router.post('/:id/transfer', requireRole(...WARD_ROLES), wrap(async (req, res) => {
  const admission = await loadHospitalAdmission(req);
  if (admission.status !== ADMISSION_STATUS.ADMITTED) throw badRequest('Only an admitted patient can be transferred.');
  const { bedId } = parse(z.object({ bedId: z.string() }), req.body);
  if (bedId === admission.bedId) throw badRequest('The patient is already in that bed.');

  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.bed.updateMany({
      where: { id: bedId, hospitalId: admission.hospitalId, status: 'AVAILABLE' },
      data: { status: 'OCCUPIED' },
    });
    if (claimed.count === 0) return null;
    if (admission.bedId) {
      await tx.bed.update({ where: { id: admission.bedId }, data: { status: 'CLEANING' } });
    }
    return tx.admission.update({ where: { id: admission.id }, data: { bedId }, include });
  });
  if (!result) throw conflict('That bed is no longer available. Please choose another bed.');
  res.json(serialize(result));
}));

// --- Discharge (PRD section 30) ------------------------------------------

router.post('/:id/discharge', requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST), wrap(async (req, res) => {
  const admission = await prisma.admission.findUnique({ where: { id: req.params.id }, include });
  if (!admission) throw notFound('Admission not found.');
  if (admission.hospitalId !== req.user.hospitalId) {
    throw forbidden('This admission belongs to another hospital.');
  }
  if (admission.status !== ADMISSION_STATUS.ADMITTED) throw badRequest('This patient is not currently admitted.');

  const data = parse(z.object({
    diagnosis: z.string().optional(),
    procedures: z.string().optional(),
    medications: z.string().optional(),
    testSummary: z.string().optional(),
    instructions: z.string().optional(),
    followUpDate: z.string().datetime().optional(),
    dischargeType: z.enum(['ROUTINE', 'LAMA', 'REFERRED', 'DEATH']).default('ROUTINE'),
  }), req.body);

  const now = new Date();
  await prisma.$transaction([
    prisma.discharge.create({
      data: {
        ...data,
        admissionId: admission.id,
        followUpDate: data.followUpDate ? new Date(data.followUpDate) : null,
        dischargedBy: req.user.id,
        dischargedAt: now,
      },
    }),
    prisma.admission.update({
      where: { id: admission.id },
      data: { status: ADMISSION_STATUS.DISCHARGED, dischargedAt: now },
    }),
    // The bed goes to CLEANING, not AVAILABLE — it is not usable until turned over.
    ...(admission.bedId ? [prisma.bed.update({ where: { id: admission.bedId }, data: { status: 'CLEANING' } })] : []),
    prisma.medicalRecord.create({
      data: {
        patientId: admission.patientId,
        recordType: 'DISCHARGE',
        title: `Discharge summary — ${data.diagnosis || admission.reason}`,
        summary: data.instructions,
        recordedBy: req.user.id,
        admissionId: admission.id,
      },
    }),
  ]);

  const bill = await createAdmissionBill(admission.id);

  await audit(req, AUDIT_ACTIONS.DISCHARGE_PATIENT, { entityType: 'Admission', entityId: admission.id });
  await notify(admission.patient.userId, {
    category: 'SYSTEM',
    title: 'Discharged',
    body: `Your discharge summary is available.${bill ? ` Final bill ${bill.billNumber}: ₹${bill.total}.` : ''}`,
    link: '/records',
  });

  res.json(serialize({
    admission: await prisma.admission.findUnique({ where: { id: admission.id }, include }),
    bill,
  }));
}));

router.get('/:id/discharge-summary', wrap(async (req, res) => {
  const admission = await prisma.admission.findUnique({
    where: { id: req.params.id },
    include: {
      ...include,
      hospital: { select: { name: true, addressLine: true, city: true, phone: true } },
      labOrders: { where: { status: 'VERIFIED' }, include: { items: { include: { labTest: true } }, report: true } },
      surgeries: true,
      bills: { include: { items: true, payments: true } },
    },
  });
  if (!admission) throw notFound('Admission not found.');
  await assertPatientAccess(req.user, admission.patientId);
  if (!admission.discharge) throw badRequest('This patient has not been discharged yet.');
  res.json(serialize(admission));
}));

async function loadHospitalAdmission(req) {
  const admission = await prisma.admission.findUnique({ where: { id: req.params.id } });
  if (!admission) throw notFound('Admission not found.');
  if (admission.hospitalId !== req.user.hospitalId) {
    throw forbidden('This admission belongs to another hospital.');
  }
  return admission;
}

export default router;
