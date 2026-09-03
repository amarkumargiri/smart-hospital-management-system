import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ROLES } from '../constants.js';
import { badRequest, forbidden, notFound, parse, serialize, wrap } from '../lib/http.js';
import { hospitalDeskUserIds, notify, notifyMany } from '../lib/notify.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

const PHARMACY_ROLES = [ROLES.RECEPTIONIST];

// --- Inventory (PRD section 26) ------------------------------------------

router.get('/inventory', requireRole(...PHARMACY_ROLES), wrap(async (req, res) => {
  const q = parse(z.object({
    search: z.string().optional(),
    lowStock: z.enum(['true', 'false']).optional(),
    expiringInDays: z.coerce.number().int().min(0).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  }), req.query);

  const where = {
    hospitalId: req.user.hospitalId,
    ...(q.search ? { OR: [{ name: { contains: q.search } }, { genericName: { contains: q.search } }] } : {}),
    ...(q.expiringInDays !== undefined
      ? { expiryDate: { lte: new Date(Date.now() + q.expiringInDays * 86_400_000) } }
      : {}),
  };

  const [total, all] = await Promise.all([
    prisma.medicine.count({ where }),
    prisma.medicine.findMany({
      where, orderBy: { name: 'asc' },
      skip: (q.page - 1) * q.pageSize, take: q.pageSize,
    }),
  ]);

  // Prisma cannot compare two columns in a where clause, so the low-stock filter
  // is applied after the query rather than pulled into raw SQL.
  const items = q.lowStock === 'true' ? all.filter((m) => m.quantity <= m.reorderLevel) : all;
  res.json(serialize({ total, page: q.page, pageSize: q.pageSize, items }));
}));

const medicineSchema = z.object({
  name: z.string().min(2),
  genericName: z.string().optional(),
  form: z.enum(['TABLET', 'SYRUP', 'INJECTION', 'CAPSULE', 'OINTMENT']).default('TABLET'),
  strength: z.string().optional(),
  batchNumber: z.string().min(1),
  quantity: z.number().int().min(0).default(0),
  reorderLevel: z.number().int().min(0).default(20),
  expiryDate: z.string(),
  supplier: z.string().optional(),
  price: z.number().min(0).default(0),
});

router.post('/inventory', requireRole(...PHARMACY_ROLES), wrap(async (req, res) => {
  const data = parse(medicineSchema, req.body);
  const expiryDate = new Date(data.expiryDate);
  if (Number.isNaN(expiryDate.getTime())) throw badRequest('Invalid expiryDate.');
  if (expiryDate < new Date()) throw badRequest('Cannot add stock that has already expired.');

  // Same medicine and batch arriving again is a restock, not a new row.
  const medicine = await prisma.medicine.upsert({
    where: { hospitalId_name_batchNumber: { hospitalId: req.user.hospitalId, name: data.name, batchNumber: data.batchNumber } },
    create: { ...data, expiryDate, hospitalId: req.user.hospitalId },
    update: { quantity: { increment: data.quantity }, price: data.price, supplier: data.supplier, expiryDate },
  });
  res.status(201).json(serialize(medicine));
}));

router.put('/inventory/:id', requireRole(...PHARMACY_ROLES), wrap(async (req, res) => {
  const medicine = await loadMedicine(req);
  const data = parse(medicineSchema.partial().omit({ name: true, batchNumber: true }), req.body);
  const updated = await prisma.medicine.update({
    where: { id: medicine.id },
    data: { ...data, ...(data.expiryDate ? { expiryDate: new Date(data.expiryDate) } : {}) },
  });
  res.json(serialize(updated));
}));

router.delete('/inventory/:id', requireRole(...PHARMACY_ROLES), wrap(async (req, res) => {
  const medicine = await loadMedicine(req);
  await prisma.medicine.delete({ where: { id: medicine.id } });
  res.json({ message: 'Stock entry removed.' });
}));

// Expired stock and stock at or below the reorder level — the two lists a
// pharmacist actually acts on.
router.get('/alerts', requireRole(...PHARMACY_ROLES), wrap(async (req, res) => {
  const medicines = await prisma.medicine.findMany({ where: { hospitalId: req.user.hospitalId } });
  const now = new Date();
  const soon = new Date(Date.now() + 30 * 86_400_000);
  res.json(serialize({
    expired: medicines.filter((m) => m.expiryDate < now),
    expiringSoon: medicines.filter((m) => m.expiryDate >= now && m.expiryDate <= soon),
    lowStock: medicines.filter((m) => m.quantity <= m.reorderLevel),
  }));
}));

// --- Dispensing -----------------------------------------------------------

router.get('/prescriptions', requireRole(...PHARMACY_ROLES), wrap(async (req, res) => {
  // Prescriptions written by this hospital's doctors that still have medicine
  // left to hand over.
  const prescriptions = await prisma.prescription.findMany({
    where: { status: 'ACTIVE', doctor: { hospitalId: req.user.hospitalId } },
    include: {
      items: true,
      patient: { include: { user: { select: { fullName: true, mobile: true } } } },
      doctor: { include: { user: { select: { fullName: true } } } },
    },
    orderBy: { issuedAt: 'desc' },
    take: 100,
  });
  res.json(serialize(prescriptions));
}));

router.post('/dispense', requireRole(...PHARMACY_ROLES), wrap(async (req, res) => {
  const data = parse(z.object({
    prescriptionId: z.string(),
    items: z.array(z.object({
      prescriptionItemId: z.string(),
      medicineId: z.string(),
      quantity: z.number().int().min(1),
    })).min(1),
  }), req.body);

  const prescription = await prisma.prescription.findUnique({
    where: { id: data.prescriptionId },
    include: { items: true, patient: true, doctor: true },
  });
  if (!prescription) throw notFound('Prescription not found.');
  if (prescription.status === 'CANCELLED') throw badRequest('This prescription was cancelled.');
  if (prescription.doctor.hospitalId !== req.user.hospitalId) {
    throw forbidden('This prescription belongs to another hospital.');
  }

  const medicines = await prisma.medicine.findMany({ where: { id: { in: data.items.map((i) => i.medicineId) } } });
  const byId = new Map(medicines.map((m) => [m.id, m]));
  const now = new Date();

  for (const item of data.items) {
    const medicine = byId.get(item.medicineId);
    if (!medicine) throw badRequest(`Unknown medicine ${item.medicineId}.`);
    if (medicine.hospitalId !== req.user.hospitalId) throw forbidden('That stock belongs to another hospital.');
    if (medicine.expiryDate < now) throw badRequest(`${medicine.name} (batch ${medicine.batchNumber}) has expired.`);
    if (medicine.quantity < item.quantity) {
      throw badRequest(`Only ${medicine.quantity} unit(s) of ${medicine.name} are in stock.`);
    }
    if (!prescription.items.some((p) => p.id === item.prescriptionItemId)) {
      throw badRequest('An item does not belong to this prescription.');
    }
  }

  await prisma.$transaction([
    ...data.items.flatMap((item) => [
      prisma.medicine.update({ where: { id: item.medicineId }, data: { quantity: { decrement: item.quantity } } }),
      prisma.prescriptionMedicine.update({
        where: { id: item.prescriptionItemId },
        data: { dispensedQty: { increment: item.quantity }, medicineId: item.medicineId },
      }),
      prisma.dispenseRecord.create({
        data: {
          medicineId: item.medicineId,
          prescriptionId: prescription.id,
          quantity: item.quantity,
          dispensedBy: req.user.id,
        },
      }),
    ]),
    prisma.prescription.update({ where: { id: prescription.id }, data: { status: 'DISPENSED' } }),
  ]);

  await notify(prescription.patient.userId, {
    category: 'REPORT',
    title: 'Medicines dispensed',
    body: `${data.items.length} medicine(s) from your prescription have been dispensed.`,
    link: '/prescriptions',
  });

  // Warn the admins about anything that just crossed its reorder level.
  const restocked = await prisma.medicine.findMany({ where: { id: { in: data.items.map((i) => i.medicineId) } } });
  const low = restocked.filter((m) => m.quantity <= m.reorderLevel);
  if (low.length) {
    const desk = await hospitalDeskUserIds(req.user.hospitalId);
    await notifyMany(desk, {
      category: 'SYSTEM',
      title: 'Low medicine inventory',
      body: low.map((m) => `${m.name}: ${m.quantity} left (reorder at ${m.reorderLevel})`).join('; '),
      link: '/hospital/pharmacy',
      severity: 'WARNING',
    });
  }

  res.json(serialize({ message: 'Dispensed.', lowStock: low }));
}));

async function loadMedicine(req) {
  const medicine = await prisma.medicine.findUnique({ where: { id: req.params.id } });
  if (!medicine) throw notFound('Medicine not found.');
  if (medicine.hospitalId !== req.user.hospitalId) {
    throw forbidden('That stock belongs to another hospital.');
  }
  return medicine;
}

export default router;
