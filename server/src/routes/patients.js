import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AUDIT_ACTIONS, ROLES } from '../constants.js';
import { assertPatientAccess } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound, parse, serialize, wrap } from '../lib/http.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// Patients edit their own demographics. Clinical fields (allergies, chronic
// conditions) are written by clinicians — PRD section 10 asks for exactly that
// split.
const profileSchema = z.object({
  fullName: z.string().min(2).optional(),
  dateOfBirth: z.string().datetime().nullable().optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  bloodGroup: z.string().optional(),
  addressLine: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  emergencyName: z.string().optional(),
  emergencyPhone: z.string().optional(),
  photoUrl: z.string().optional(),
});

const clinicalSchema = z.object({
  allergies: z.string().optional(),
  chronicConditions: z.string().optional(),
});

router.get('/:id', wrap(async (req, res) => {
  await assertPatientAccess(req.user, req.params.id);
  const patient = await prisma.patient.findUnique({
    where: { id: req.params.id },
    include: { user: { select: { fullName: true, email: true, mobile: true, photoUrl: true } }, insurances: true },
  });
  if (!patient) throw notFound('Patient not found.');
  if (req.user.role !== ROLES.PATIENT) {
    await audit(req, AUDIT_ACTIONS.VIEW_MEDICAL_RECORD, { entityType: 'Patient', entityId: patient.id });
  }
  res.json(serialize(patient));
}));

router.put('/:id', wrap(async (req, res) => {
  if (req.user.patientId !== req.params.id) {
    throw forbidden('You can only edit your own profile.');
  }
  const data = parse(profileSchema, req.body);
  const { fullName, photoUrl, ...patientFields } = data;

  const patient = await prisma.patient.update({
    where: { id: req.params.id },
    data: {
      ...patientFields,
      ...(patientFields.dateOfBirth !== undefined
        ? { dateOfBirth: patientFields.dateOfBirth ? new Date(patientFields.dateOfBirth) : null }
        : {}),
      ...(fullName || photoUrl ? { user: { update: { ...(fullName ? { fullName } : {}), ...(photoUrl ? { photoUrl } : {}) } } } : {}),
    },
    include: { user: { select: { fullName: true, email: true, mobile: true, photoUrl: true } } },
  });
  res.json(serialize(patient));
}));

// Clinical flags — doctors and nurses only.
router.put('/:id/clinical', wrap(async (req, res) => {
  if (![ROLES.DOCTOR, ROLES.RECEPTIONIST].includes(req.user.role)) {
    throw forbidden('Only clinical staff can change allergies or chronic conditions.');
  }
  await assertPatientAccess(req.user, req.params.id);
  const data = parse(clinicalSchema, req.body);
  const patient = await prisma.patient.update({ where: { id: req.params.id }, data });
  await audit(req, AUDIT_ACTIONS.MODIFY_MEDICAL_RECORD, { entityType: 'Patient', entityId: patient.id, detail: 'clinical flags updated' });
  res.json(serialize(patient));
}));

// --- Clinical history -----------------------------------------------------

router.get('/:id/records', wrap(async (req, res) => {
  await assertPatientAccess(req.user, req.params.id);
  const records = await prisma.medicalRecord.findMany({
    where: { patientId: req.params.id },
    orderBy: { recordedAt: 'desc' },
    take: 200,
  });
  await audit(req, AUDIT_ACTIONS.VIEW_MEDICAL_RECORD, { entityType: 'Patient', entityId: req.params.id });
  res.json(serialize(records));
}));

// The full clinical picture a doctor opens during consultation (PRD section 20).
router.get('/:id/history', wrap(async (req, res) => {
  await assertPatientAccess(req.user, req.params.id);
  const patientId = req.params.id;

  const [patient, consultations, prescriptions, labOrders, admissions] = await Promise.all([
    prisma.patient.findUnique({
      where: { id: patientId },
      include: { user: { select: { fullName: true, email: true, mobile: true } } },
    }),
    prisma.consultation.findMany({
      where: { patientId },
      orderBy: { startedAt: 'desc' },
      take: 50,
      include: {
        diagnoses: true,
        vitals: true,
        doctor: { include: { user: { select: { fullName: true } }, hospital: { select: { name: true } } } },
      },
    }),
    prisma.prescription.findMany({
      where: { patientId },
      orderBy: { issuedAt: 'desc' },
      take: 50,
      include: { items: true, doctor: { include: { user: { select: { fullName: true } } } } },
    }),
    prisma.labOrder.findMany({
      where: { patientId },
      orderBy: { orderedAt: 'desc' },
      take: 50,
      include: { items: { include: { labTest: true } }, report: true },
    }),
    prisma.admission.findMany({
      where: { patientId },
      orderBy: { requestedAt: 'desc' },
      include: { discharge: true, hospital: { select: { name: true } }, bed: { select: { bedNumber: true, ward: true } } },
    }),
  ]);
  if (!patient) throw notFound('Patient not found.');

  await audit(req, AUDIT_ACTIONS.VIEW_MEDICAL_RECORD, { entityType: 'Patient', entityId: patientId, detail: 'full history' });
  res.json(serialize({ patient, consultations, prescriptions, labOrders, admissions }));
}));

router.get('/:id/prescriptions', wrap(async (req, res) => {
  await assertPatientAccess(req.user, req.params.id);
  res.json(serialize(await prisma.prescription.findMany({
    where: { patientId: req.params.id },
    orderBy: { issuedAt: 'desc' },
    include: { items: true, doctor: { include: { user: { select: { fullName: true } } } } },
  })));
}));

router.get('/:id/reports', wrap(async (req, res) => {
  await assertPatientAccess(req.user, req.params.id);
  res.json(serialize(await prisma.labOrder.findMany({
    where: { patientId: req.params.id, status: { in: ['RESULT_ENTERED', 'VERIFIED'] } },
    orderBy: { orderedAt: 'desc' },
    include: { items: { include: { labTest: true } }, report: true, hospital: { select: { name: true } } },
  })));
}));

router.get('/:id/bills', wrap(async (req, res) => {
  await assertPatientAccess(req.user, req.params.id);
  res.json(serialize(await prisma.bill.findMany({
    where: { patientId: req.params.id },
    orderBy: { createdAt: 'desc' },
    include: { items: true, payments: true, hospital: { select: { name: true } } },
  })));
}));

// --- Dashboard (PRD section 9) -------------------------------------------

router.get('/:id/dashboard', wrap(async (req, res) => {
  await assertPatientAccess(req.user, req.params.id);
  const patientId = req.params.id;
  const now = new Date();

  const [upcoming, recentReports, activePrescriptions, pendingBills, notifications, followUps] = await Promise.all([
    prisma.appointment.findMany({
      where: { patientId, scheduledAt: { gte: now }, status: { in: ['REQUESTED', 'CONFIRMED', 'CHECKED_IN'] } },
      orderBy: { scheduledAt: 'asc' },
      take: 5,
      include: {
        doctor: { include: { user: { select: { fullName: true } } } },
        hospital: { select: { name: true, city: true } },
      },
    }),
    prisma.labOrder.findMany({
      where: { patientId, status: 'VERIFIED' },
      orderBy: { orderedAt: 'desc' },
      take: 5,
      include: { items: { include: { labTest: { select: { name: true } } } }, report: true },
    }),
    prisma.prescription.findMany({
      where: { patientId, status: 'ACTIVE' },
      orderBy: { issuedAt: 'desc' },
      take: 5,
      include: { items: true },
    }),
    prisma.bill.findMany({
      where: { patientId, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
      orderBy: { createdAt: 'desc' },
      include: { hospital: { select: { name: true } } },
    }),
    prisma.notification.findMany({
      where: { userId: req.user.id, readAt: null },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.consultation.findMany({
      where: { patientId, followUpDate: { gte: now } },
      orderBy: { followUpDate: 'asc' },
      take: 5,
      include: { doctor: { include: { user: { select: { fullName: true } } } } },
    }),
  ]);

  const pendingAmount = pendingBills.reduce((sum, b) => sum + (Number(b.total) - Number(b.paidAmount)), 0);

  res.json(serialize({
    upcomingAppointments: upcoming,
    recentReports,
    activePrescriptions,
    pendingBills,
    pendingAmount: Math.round(pendingAmount * 100) / 100,
    notifications,
    followUps,
  }));
}));

// Hospital-side patient list (receptionist / admin).
router.get('/', wrap(async (req, res) => {
  if (req.user.role === ROLES.PATIENT) throw forbidden('Patients cannot list other patients.');
  const { q, page, pageSize } = parse(z.object({
    q: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }), req.query);

  // Scoped to the caller's own hospital: everyone who has any record there.
  const scope = {
    OR: [
      { appointments: { some: { hospitalId: req.user.hospitalId } } },
      { admissions: { some: { hospitalId: req.user.hospitalId } } },
      { labOrders: { some: { hospitalId: req.user.hospitalId } } },
      { emergencyCases: { some: { hospitalId: req.user.hospitalId } } },
    ],
  };
  const where = {
    ...scope,
    ...(q ? { user: { OR: [{ fullName: { contains: q } }, { mobile: { contains: q } }, { email: { contains: q } }] } } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.patient.count({ where }),
    prisma.patient.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { fullName: true, mobile: true, email: true } } },
    }),
  ]);
  res.json(serialize({ total, page, pageSize, items }));
}));

export default router;
