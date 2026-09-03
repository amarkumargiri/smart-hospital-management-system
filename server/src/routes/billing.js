import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AUDIT_ACTIONS, BILL_CATEGORIES, PAYMENT_METHODS, ROLES } from '../constants.js';
import { assertPatientAccess } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound, parse, serialize, wrap } from '../lib/http.js';
import { notify } from '../lib/notify.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();

const num = (v) => Number(v ?? 0);
const money = (n) => Math.round(n * 100) / 100;

// Random suffix rather than a counter: two bills raised in the same millisecond
// must not collide, and a sequence would need its own locked table.
const billNumber = () => `INV-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

const billInclude = {
  items: true,
  payments: true,
  claims: true,
  patient: { include: { user: { select: { id: true, fullName: true, mobile: true } } } },
  hospital: { select: { id: true, name: true } },
};

// Recomputes totals from the line items. Every mutation goes through this so a
// bill's total can never disagree with what it is made of.
async function recalculate(billId, tx = prisma) {
  const bill = await tx.bill.findUnique({ where: { id: billId }, include: { items: true, payments: true } });
  const subtotal = bill.items.reduce((sum, i) => sum + num(i.amount), 0);
  const total = money(subtotal - num(bill.discount) + num(bill.tax));
  const paidAmount = money(bill.payments.filter((p) => p.status === 'PAID').reduce((sum, p) => sum + num(p.amount), 0));

  let status = 'PENDING';
  if (paidAmount >= total && total > 0) status = 'PAID';
  else if (paidAmount > 0) status = 'PARTIALLY_PAID';
  if (bill.status === 'CANCELLED' || bill.status === 'REFUNDED') status = bill.status;

  return tx.bill.update({
    where: { id: billId },
    data: { subtotal: money(subtotal), total, paidAmount, status },
    include: billInclude,
  });
}

// --- Automatic bills ------------------------------------------------------

// Called when a consultation completes. Idempotent: the unique appointmentId
// means a retried request returns the existing bill instead of a duplicate.
export async function createConsultationBill(appointmentId) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { doctor: { include: { user: { select: { fullName: true } } } } },
  });
  if (!appointment) return null;

  const existing = await prisma.bill.findUnique({ where: { appointmentId }, include: billInclude });
  if (existing) return serialize(existing);

  const fee = num(appointment.fee);
  const bill = await prisma.bill.create({
    data: {
      billNumber: billNumber(),
      patientId: appointment.patientId,
      hospitalId: appointment.hospitalId,
      appointmentId,
      items: {
        create: [{
          category: 'CONSULTATION',
          description: `Consultation — Dr. ${appointment.doctor.user.fullName}`,
          quantity: 1,
          unitPrice: fee,
          amount: fee,
        }],
      },
    },
  });
  return serialize(await recalculate(bill.id));
}

// Called at discharge. Pulls together room/ICU nights, verified lab work,
// dispensed medicines and surgeries for the whole stay.
export async function createAdmissionBill(admissionId) {
  const admission = await prisma.admission.findUnique({
    where: { id: admissionId },
    include: {
      bed: true,
      surgeries: true,
      labOrders: { where: { status: 'VERIFIED' }, include: { items: { include: { labTest: true } } } },
    },
  });
  if (!admission) return null;

  const existing = await prisma.bill.findFirst({ where: { admissionId }, include: billInclude });
  if (existing) return serialize(existing);

  const items = [];
  const start = admission.admittedAt || admission.requestedAt;
  const end = admission.dischargedAt || new Date();
  // A part-day still occupies the bed for that night, so round up, minimum one.
  const nights = Math.max(1, Math.ceil((end - start) / 86_400_000));

  if (admission.bed) {
    const rate = num(admission.bed.dailyCharge);
    items.push({
      category: admission.bed.type === 'ICU' ? 'ICU' : 'ROOM',
      description: `${admission.bed.type} bed ${admission.bed.bedNumber} (${nights} day${nights > 1 ? 's' : ''})`,
      quantity: nights,
      unitPrice: rate,
      amount: money(rate * nights),
    });
  }

  for (const order of admission.labOrders) {
    for (const item of order.items) {
      items.push({
        category: item.labTest.category === 'RADIOLOGY' ? 'IMAGING' : 'LAB',
        description: item.labTest.name,
        quantity: 1,
        unitPrice: num(item.labTest.price),
        amount: num(item.labTest.price),
      });
    }
  }

  for (const surgery of admission.surgeries.filter((s) => s.status === 'COMPLETED')) {
    items.push({
      category: 'PROCEDURE',
      description: surgery.procedure,
      quantity: 1,
      unitPrice: num(surgery.charge),
      amount: num(surgery.charge),
    });
  }

  const dispensed = await prisma.dispenseRecord.findMany({
    where: { prescriptionId: { not: null }, dispensedAt: { gte: start, lte: end } },
    include: { medicine: true },
  });
  for (const d of dispensed.filter((d) => d.medicine.hospitalId === admission.hospitalId)) {
    items.push({
      category: 'PHARMACY',
      description: `${d.medicine.name} x${d.quantity}`,
      quantity: d.quantity,
      unitPrice: num(d.medicine.price),
      amount: money(num(d.medicine.price) * d.quantity),
    });
  }

  const bill = await prisma.bill.create({
    data: {
      billNumber: billNumber(),
      patientId: admission.patientId,
      hospitalId: admission.hospitalId,
      admissionId,
      items: { create: items },
    },
  });
  return serialize(await recalculate(bill.id));
}

// --- Routes ---------------------------------------------------------------

router.use(authenticate);

const BILLING_ROLES = [ROLES.RECEPTIONIST];

router.get('/', wrap(async (req, res) => {
  const q = parse(z.object({
    patientId: z.string().optional(),
    hospitalId: z.string().optional(),
    status: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }), req.query);

  const scope = req.user.role === ROLES.PATIENT
    ? { patientId: req.user.patientId }
    : { hospitalId: req.user.hospitalId };

  const where = {
    ...scope,
    ...(q.patientId && req.user.role !== ROLES.PATIENT ? { patientId: q.patientId } : {}),
    ...(q.status ? { status: { in: q.status.split(',') } } : {}),
    ...(q.from || q.to
      ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.bill.count({ where }),
    prisma.bill.findMany({
      where, include: billInclude, orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize, take: q.pageSize,
    }),
  ]);
  res.json(serialize({ total, page: q.page, pageSize: q.pageSize, items }));
}));

router.get('/:id', wrap(async (req, res) => {
  const bill = await prisma.bill.findUnique({ where: { id: req.params.id }, include: billInclude });
  if (!bill) throw notFound('Bill not found.');
  await assertPatientAccess(req.user, bill.patientId);
  res.json(serialize(bill));
}));

// Manual bill — walk-in services that are not tied to an appointment or stay.
router.post('/', requireRole(...BILLING_ROLES), wrap(async (req, res) => {
  const data = parse(z.object({
    patientId: z.string(),
    admissionId: z.string().optional(),
    discount: z.number().min(0).default(0),
    tax: z.number().min(0).default(0),
    items: z.array(z.object({
      category: z.enum(BILL_CATEGORIES),
      description: z.string().min(1),
      quantity: z.number().int().min(1).default(1),
      unitPrice: z.number().min(0),
    })).min(1),
  }), req.body);

  const bill = await prisma.bill.create({
    data: {
      billNumber: billNumber(),
      patientId: data.patientId,
      hospitalId: req.user.hospitalId,
      admissionId: data.admissionId,
      discount: data.discount,
      tax: data.tax,
      items: { create: data.items.map((i) => ({ ...i, amount: money(i.unitPrice * i.quantity) })) },
    },
  });
  const full = await recalculate(bill.id);
  await audit(req, AUDIT_ACTIONS.GENERATE_BILL, { entityType: 'Bill', entityId: bill.id, detail: full.billNumber });
  res.status(201).json(serialize(full));
}));

router.post('/:id/items', requireRole(...BILLING_ROLES), wrap(async (req, res) => {
  const bill = await loadHospitalBill(req);
  if (['PAID', 'CANCELLED', 'REFUNDED'].includes(bill.status)) {
    throw badRequest(`Cannot add items to a bill that is ${bill.status}.`);
  }
  const item = parse(z.object({
    category: z.enum(BILL_CATEGORIES),
    description: z.string().min(1),
    quantity: z.number().int().min(1).default(1),
    unitPrice: z.number().min(0),
  }), req.body);

  await prisma.billItem.create({
    data: { ...item, billId: bill.id, amount: money(item.unitPrice * item.quantity) },
  });
  res.json(serialize(await recalculate(bill.id)));
}));

router.delete('/:id/items/:itemId', requireRole(...BILLING_ROLES), wrap(async (req, res) => {
  const bill = await loadHospitalBill(req);
  await prisma.billItem.delete({ where: { id: req.params.itemId } });
  res.json(serialize(await recalculate(bill.id)));
}));

router.put('/:id', requireRole(...BILLING_ROLES), wrap(async (req, res) => {
  const bill = await loadHospitalBill(req);
  const data = parse(z.object({
    discount: z.number().min(0).optional(),
    tax: z.number().min(0).optional(),
    status: z.enum(['CANCELLED', 'REFUNDED']).optional(),
  }), req.body);
  await prisma.bill.update({ where: { id: bill.id }, data });
  res.json(serialize(await recalculate(bill.id)));
}));

// --- Payments -------------------------------------------------------------

router.post('/:id/payments', wrap(async (req, res) => {
  const bill = await prisma.bill.findUnique({ where: { id: req.params.id }, include: { patient: true } });
  if (!bill) throw notFound('Bill not found.');
  const isOwnBill = req.user.patientId && bill.patientId === req.user.patientId;
  if (!isOwnBill && !BILLING_ROLES.includes(req.user.role)) {
    throw forbidden('You cannot record a payment against this bill.');
  }

  const data = parse(z.object({
    amount: z.number().positive(),
    method: z.enum(PAYMENT_METHODS),
    transactionId: z.string().optional(),
    status: z.enum(['PENDING', 'PAID', 'FAILED']).default('PAID'),
  }), req.body);

  const due = money(num(bill.total) - num(bill.paidAmount));
  if (data.status === 'PAID' && data.amount > due) {
    throw badRequest(`Payment exceeds the outstanding amount of ${due}.`);
  }

  await prisma.payment.create({
    data: { ...data, billId: bill.id, paidAt: data.status === 'PAID' ? new Date() : null },
  });
  const updated = await recalculate(bill.id);
  await audit(req, AUDIT_ACTIONS.RECORD_PAYMENT, { entityType: 'Bill', entityId: bill.id, detail: `${data.method} ${data.amount}` });

  if (data.status === 'PAID') {
    await notify(bill.patient.userId, {
      category: 'PAYMENT',
      title: 'Payment received',
      body: `Payment of ₹${data.amount} recorded against bill ${updated.billNumber}. Outstanding: ₹${money(num(updated.total) - num(updated.paidAmount))}.`,
      link: '/bills',
    });
  }
  res.status(201).json(serialize(updated));
}));

// --- Insurance (PRD section 34) ------------------------------------------

router.get('/insurance/:patientId', wrap(async (req, res) => {
  await assertPatientAccess(req.user, req.params.patientId);
  res.json(serialize(await prisma.insurance.findMany({
    where: { patientId: req.params.patientId },
    include: { claims: { include: { bill: { select: { billNumber: true, total: true } } } } },
  })));
}));

router.post('/insurance', wrap(async (req, res) => {
  const data = parse(z.object({
    patientId: z.string(),
    provider: z.string().min(2),
    policyNumber: z.string().min(3),
    coverageAmount: z.number().min(0).default(0),
    validFrom: z.string().datetime().optional(),
    validTo: z.string().datetime().optional(),
    documentFileId: z.string().optional(),
  }), req.body);
  if (req.user.role === ROLES.PATIENT && data.patientId !== req.user.patientId) {
    throw forbidden('You can only add insurance to your own profile.');
  }

  const insurance = await prisma.insurance.create({
    data: {
      ...data,
      validFrom: data.validFrom ? new Date(data.validFrom) : null,
      validTo: data.validTo ? new Date(data.validTo) : null,
    },
  });
  res.status(201).json(serialize(insurance));
}));

router.post('/:id/claims', requireRole(...BILLING_ROLES), wrap(async (req, res) => {
  const bill = await loadHospitalBill(req);
  const { insuranceId, claimedAmount } = parse(
    z.object({ insuranceId: z.string(), claimedAmount: z.number().positive() }),
    req.body,
  );
  const insurance = await prisma.insurance.findUnique({ where: { id: insuranceId } });
  if (!insurance || insurance.patientId !== bill.patientId) {
    throw badRequest('That policy does not belong to this patient.');
  }
  if (claimedAmount > num(bill.total)) throw badRequest('Claim cannot exceed the bill total.');

  const claim = await prisma.insuranceClaim.create({
    data: { insuranceId, billId: bill.id, claimedAmount },
  });
  res.status(201).json(serialize(claim));
}));

router.put('/claims/:claimId', requireRole(...BILLING_ROLES), wrap(async (req, res) => {
  const data = parse(z.object({
    status: z.enum(['UNDER_REVIEW', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'SETTLED']),
    approvedAmount: z.number().min(0).default(0),
    rejectedAmount: z.number().min(0).default(0),
    remarks: z.string().optional(),
  }), req.body);

  const claim = await prisma.insuranceClaim.update({
    where: { id: req.params.claimId },
    data: { ...data, settledAt: data.status === 'SETTLED' ? new Date() : null },
    include: { bill: true },
  });

  // A settled claim is money actually received, so it becomes a payment.
  if (data.status === 'SETTLED' && data.approvedAmount > 0) {
    await prisma.payment.create({
      data: {
        billId: claim.billId,
        amount: data.approvedAmount,
        method: 'INSURANCE',
        status: 'PAID',
        transactionId: `CLAIM-${claim.id}`,
        paidAt: new Date(),
      },
    });
    await recalculate(claim.billId);
  }
  res.json(serialize(claim));
}));

async function loadHospitalBill(req) {
  const bill = await prisma.bill.findUnique({ where: { id: req.params.id } });
  if (!bill) throw notFound('Bill not found.');
  if (bill.hospitalId !== req.user.hospitalId) {
    throw forbidden('This bill belongs to another hospital.');
  }
  return bill;
}

export default router;
