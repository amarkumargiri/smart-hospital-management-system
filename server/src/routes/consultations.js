import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { APPOINTMENT_STATUS, AUDIT_ACTIONS, ROLES } from '../constants.js';
import { assertPatientAccess } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound, parse, serialize, wrap } from '../lib/http.js';
import { notify } from '../lib/notify.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { createConsultationBill } from './billing.js';

const router = Router();
router.use(authenticate);

const consultationInclude = {
  vitals: true,
  diagnoses: true,
  prescriptions: { include: { items: true } },
  labOrders: { include: { items: { include: { labTest: true } }, report: true } },
  patient: { include: { user: { select: { fullName: true, mobile: true } } } },
  doctor: { include: { user: { select: { fullName: true } } } },
  appointment: { select: { id: true, scheduledAt: true, type: true, hospitalId: true } },
};

// Starting a consultation is what moves the appointment to IN_CONSULTATION —
// the two are the same clinical event, so one call does both.
router.post('/', requireRole(ROLES.DOCTOR), wrap(async (req, res) => {
  const { appointmentId } = parse(z.object({ appointmentId: z.string() }), req.body);
  const appointment = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appointment) throw notFound('Appointment not found.');
  if (appointment.doctorId !== req.user.doctorId) {
    throw forbidden('This appointment belongs to another doctor.');
  }

  const existing = await prisma.consultation.findUnique({ where: { appointmentId }, include: consultationInclude });
  if (existing) return res.json(serialize(existing));

  if (![APPOINTMENT_STATUS.CHECKED_IN, APPOINTMENT_STATUS.CONFIRMED].includes(appointment.status)) {
    throw badRequest(`Cannot start a consultation for an appointment that is ${appointment.status}.`);
  }

  const consultation = await prisma.$transaction(async (tx) => {
    const created = await tx.consultation.create({
      data: { appointmentId, patientId: appointment.patientId, doctorId: appointment.doctorId },
    });
    await tx.appointment.update({
      where: { id: appointmentId },
      data: { status: APPOINTMENT_STATUS.IN_CONSULTATION, startedAt: new Date() },
    });
    return created;
  });

  await audit(req, AUDIT_ACTIONS.VIEW_MEDICAL_RECORD, { entityType: 'Consultation', entityId: consultation.id });
  res.status(201).json(serialize(await prisma.consultation.findUnique({ where: { id: consultation.id }, include: consultationInclude })));
}));

router.get('/:id', wrap(async (req, res) => {
  const consultation = await prisma.consultation.findUnique({ where: { id: req.params.id }, include: consultationInclude });
  if (!consultation) throw notFound('Consultation not found.');
  await assertPatientAccess(req.user, consultation.patientId);
  res.json(serialize(consultation));
}));

const updateSchema = z.object({
  symptoms: z.string().optional(),
  clinicalNotes: z.string().optional(),
  treatmentPlan: z.string().optional(),
  followUpDate: z.string().datetime().nullable().optional(),
});

router.put('/:id', requireRole(ROLES.DOCTOR), wrap(async (req, res) => {
  const consultation = await loadOwn(req, req.params.id);
  if (consultation.status === 'COMPLETED') throw badRequest('This consultation is already complete.');
  const data = parse(updateSchema, req.body);
  const updated = await prisma.consultation.update({
    where: { id: consultation.id },
    data: {
      ...data,
      ...(data.followUpDate !== undefined ? { followUpDate: data.followUpDate ? new Date(data.followUpDate) : null } : {}),
    },
    include: consultationInclude,
  });
  await audit(req, AUDIT_ACTIONS.MODIFY_MEDICAL_RECORD, { entityType: 'Consultation', entityId: consultation.id });
  res.json(serialize(updated));
}));

// --- Vitals ---------------------------------------------------------------

const vitalsSchema = z.object({
  temperatureC: z.number().min(25).max(45).optional(),
  systolic: z.number().int().min(40).max(300).optional(),
  diastolic: z.number().int().min(20).max(200).optional(),
  heartRate: z.number().int().min(20).max(300).optional(),
  respiratoryRate: z.number().int().min(4).max(80).optional(),
  spo2: z.number().int().min(30).max(100).optional(),
  weightKg: z.number().min(0.5).max(500).optional(),
  heightCm: z.number().min(20).max(280).optional(),
});

// Nurses record vitals as often as doctors do, so both roles are allowed here.
router.put('/:id/vitals', requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST), wrap(async (req, res) => {
  const consultation = await prisma.consultation.findUnique({ where: { id: req.params.id } });
  if (!consultation) throw notFound('Consultation not found.');
  await assertPatientAccess(req.user, consultation.patientId);
  const data = parse(vitalsSchema, req.body);

  const vitals = await prisma.vitals.upsert({
    where: { consultationId: consultation.id },
    create: { consultationId: consultation.id, ...data },
    update: { ...data, recordedAt: new Date() },
  });
  res.json(serialize(vitals));
}));

// --- Diagnosis ------------------------------------------------------------

router.post('/:id/diagnoses', requireRole(ROLES.DOCTOR), wrap(async (req, res) => {
  const consultation = await loadOwn(req, req.params.id);
  const data = parse(z.object({
    code: z.string().optional(),
    description: z.string().min(2),
    severity: z.enum(['MILD', 'MODERATE', 'SEVERE']).default('MODERATE'),
    isPrimary: z.boolean().default(false),
  }), req.body);

  const diagnosis = await prisma.diagnosis.create({ data: { ...data, consultationId: consultation.id } });
  await audit(req, AUDIT_ACTIONS.MODIFY_MEDICAL_RECORD, {
    entityType: 'Diagnosis', entityId: diagnosis.id, detail: diagnosis.description,
  });
  res.status(201).json(serialize(diagnosis));
}));

router.delete('/:id/diagnoses/:diagnosisId', requireRole(ROLES.DOCTOR), wrap(async (req, res) => {
  await loadOwn(req, req.params.id);
  await prisma.diagnosis.delete({ where: { id: req.params.diagnosisId } });
  res.json({ message: 'Diagnosis removed.' });
}));

// --- Completion -----------------------------------------------------------

// Completing a consultation closes the appointment, writes the medical-record
// entry the patient will see, and raises the consultation bill.
router.post('/:id/complete', requireRole(ROLES.DOCTOR), wrap(async (req, res) => {
  const consultation = await prisma.consultation.findUnique({
    where: { id: req.params.id },
    include: { diagnoses: true, appointment: true, patient: true },
  });
  if (!consultation) throw notFound('Consultation not found.');
  if (consultation.doctorId !== req.user.doctorId) {
    throw forbidden('This consultation belongs to another doctor.');
  }
  if (consultation.status === 'COMPLETED') throw badRequest('This consultation is already complete.');
  if (!consultation.diagnoses.length) throw badRequest('Record at least one diagnosis before completing the consultation.');

  const now = new Date();
  const primary = consultation.diagnoses.find((d) => d.isPrimary) || consultation.diagnoses[0];

  await prisma.$transaction([
    prisma.consultation.update({ where: { id: consultation.id }, data: { status: 'COMPLETED', completedAt: now } }),
    prisma.appointment.update({
      where: { id: consultation.appointmentId },
      data: { status: APPOINTMENT_STATUS.COMPLETED, completedAt: now },
    }),
    prisma.medicalRecord.create({
      data: {
        patientId: consultation.patientId,
        recordType: 'CONSULTATION',
        title: primary.description,
        summary: consultation.clinicalNotes || consultation.symptoms,
        recordedBy: req.user.id,
        recordedAt: now,
        consultationId: consultation.id,
      },
    }),
  ]);

  const bill = await createConsultationBill(consultation.appointmentId);

  await notify(consultation.patient.userId, {
    category: 'APPOINTMENT',
    title: 'Consultation complete',
    body: `Your consultation notes and prescription are available.${bill ? ` Bill ${bill.billNumber} has been generated.` : ''}`,
    link: '/records',
  });
  if (consultation.followUpDate) {
    await notify(consultation.patient.userId, {
      category: 'FOLLOW_UP',
      title: 'Follow-up recommended',
      body: `Your doctor recommends a follow-up on ${new Date(consultation.followUpDate).toDateString()}.`,
      link: '/appointments',
    });
  }

  res.json(serialize({
    consultation: await prisma.consultation.findUnique({ where: { id: consultation.id }, include: consultationInclude }),
    bill,
  }));
}));

async function loadOwn(req, id) {
  const consultation = await prisma.consultation.findUnique({ where: { id } });
  if (!consultation) throw notFound('Consultation not found.');
  if (consultation.doctorId !== req.user.doctorId) {
    throw forbidden('This consultation belongs to another doctor.');
  }
  return consultation;
}

export default router;
