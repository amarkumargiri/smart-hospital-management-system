import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AUDIT_ACTIONS, ROLES } from '../constants.js';
import { assertPatientAccess } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound, parse, serialize, wrap } from '../lib/http.js';
import { notify } from '../lib/notify.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

const include = {
  items: { include: { medicine: { select: { id: true, name: true, quantity: true } } } },
  doctor: { include: { user: { select: { fullName: true } }, hospital: { select: { name: true } } } },
  patient: { include: { user: { select: { id: true, fullName: true } } } },
};

const itemSchema = z.object({
  medicineId: z.string().optional(),
  medicineName: z.string().min(1),
  dosage: z.string().min(1),
  frequency: z.string().min(1),
  durationDays: z.number().int().min(1).max(365),
  route: z.enum(['ORAL', 'IV', 'IM', 'TOPICAL', 'INHALED']).default('ORAL'),
  instruction: z.string().optional(),
});

router.post('/', requireRole(ROLES.DOCTOR), wrap(async (req, res) => {
  const data = parse(z.object({
    patientId: z.string(),
    consultationId: z.string().optional(),
    notes: z.string().optional(),
    items: z.array(itemSchema).min(1, 'A prescription needs at least one medicine.'),
  }), req.body);
  await assertPatientAccess(req.user, data.patientId);

  const prescription = await prisma.prescription.create({
    data: {
      patientId: data.patientId,
      doctorId: req.user.doctorId,
      consultationId: data.consultationId,
      notes: data.notes,
      items: { create: data.items },
    },
    include,
  });

  await prisma.medicalRecord.create({
    data: {
      patientId: data.patientId,
      recordType: 'CONSULTATION',
      title: `Prescription — ${data.items.length} medicine${data.items.length > 1 ? 's' : ''}`,
      summary: data.items.map((i) => `${i.medicineName} ${i.dosage} ${i.frequency} x${i.durationDays}d`).join('; '),
      recordedBy: req.user.id,
      consultationId: data.consultationId,
    },
  });

  await audit(req, AUDIT_ACTIONS.CREATE_PRESCRIPTION, { entityType: 'Prescription', entityId: prescription.id });
  await notify(prescription.patient.userId, {
    category: 'REPORT',
    title: 'Prescription available',
    body: `Dr. ${prescription.doctor.user.fullName} issued a prescription with ${data.items.length} medicine(s).`,
    link: '/prescriptions',
  });

  res.status(201).json(serialize(prescription));
}));

router.get('/:id', wrap(async (req, res) => {
  const prescription = await prisma.prescription.findUnique({ where: { id: req.params.id }, include });
  if (!prescription) throw notFound('Prescription not found.');
  await assertPatientAccess(req.user, prescription.patientId);
  res.json(serialize(prescription));
}));

router.get('/patient/:patientId', wrap(async (req, res) => {
  await assertPatientAccess(req.user, req.params.patientId);
  res.json(serialize(await prisma.prescription.findMany({
    where: { patientId: req.params.patientId },
    include,
    orderBy: { issuedAt: 'desc' },
  })));
}));

// Only the prescriber may cancel, and only while nothing has been dispensed.
router.post('/:id/cancel', requireRole(ROLES.DOCTOR), wrap(async (req, res) => {
  const prescription = await prisma.prescription.findUnique({ where: { id: req.params.id }, include: { items: true } });
  if (!prescription) throw notFound('Prescription not found.');
  if (prescription.doctorId !== req.user.doctorId) {
    throw forbidden('Only the prescribing doctor can cancel this prescription.');
  }
  if (prescription.items.some((i) => i.dispensedQty > 0)) {
    throw forbidden('Medicines have already been dispensed against this prescription.');
  }
  res.json(serialize(await prisma.prescription.update({
    where: { id: prescription.id }, data: { status: 'CANCELLED' }, include,
  })));
}));

export default router;
