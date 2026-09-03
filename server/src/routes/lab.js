import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AUDIT_ACTIONS, LAB_ORDER_STATUS, LAB_TRANSITIONS, ROLES } from '../constants.js';
import { assertPatientAccess } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound, parse, serialize, wrap } from '../lib/http.js';
import { notify } from '../lib/notify.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

const LAB_ROLES = [ROLES.RECEPTIONIST];

const orderInclude = {
  items: { include: { labTest: true } },
  report: true,
  patient: { include: { user: { select: { id: true, fullName: true, mobile: true } } } },
  doctor: { include: { user: { select: { id: true, fullName: true } } } },
};

// --- Test catalogue -------------------------------------------------------

router.get('/tests', wrap(async (req, res) => {
  const { q, category } = parse(z.object({ q: z.string().optional(), category: z.string().optional() }), req.query);
  res.json(serialize(await prisma.labTest.findMany({
    where: {
      isActive: true,
      ...(category ? { category } : {}),
      ...(q ? { OR: [{ name: { contains: q } }, { code: { contains: q } }] } : {}),
    },
    orderBy: { name: 'asc' },
  })));
}));

router.post('/tests', requireRole(...LAB_ROLES), wrap(async (req, res) => {
  const data = parse(z.object({
    code: z.string().min(2),
    name: z.string().min(2),
    category: z.enum(['HAEMATOLOGY', 'BIOCHEMISTRY', 'RADIOLOGY', 'PATHOLOGY']),
    sampleType: z.string().optional(),
    price: z.number().min(0).default(0),
    turnaroundHours: z.number().int().min(1).default(24),
  }), req.body);
  res.status(201).json(serialize(await prisma.labTest.create({ data })));
}));

// --- Orders (PRD section 23) ---------------------------------------------

router.post('/orders', requireRole(ROLES.DOCTOR), wrap(async (req, res) => {
  const data = parse(z.object({
    patientId: z.string(),
    testIds: z.array(z.string()).min(1, 'Select at least one test.'),
    consultationId: z.string().optional(),
    admissionId: z.string().optional(),
    priority: z.enum(['ROUTINE', 'URGENT', 'STAT']).default('ROUTINE'),
  }), req.body);
  await assertPatientAccess(req.user, data.patientId);

  const tests = await prisma.labTest.findMany({ where: { id: { in: data.testIds }, isActive: true } });
  if (tests.length !== data.testIds.length) throw badRequest('One or more selected tests do not exist.');

  const order = await prisma.labOrder.create({
    data: {
      patientId: data.patientId,
      doctorId: req.user.doctorId,
      hospitalId: req.user.hospitalId,
      consultationId: data.consultationId,
      admissionId: data.admissionId,
      priority: data.priority,
      items: { create: tests.map((t) => ({ labTestId: t.id })) },
    },
    include: orderInclude,
  });

  await notify(order.patient.userId, {
    category: 'REPORT',
    title: 'Lab tests ordered',
    body: `${tests.map((t) => t.name).join(', ')} ordered by Dr. ${order.doctor.user.fullName}.`,
    link: '/reports',
  });
  res.status(201).json(serialize(order));
}));

router.get('/orders', wrap(async (req, res) => {
  const q = parse(z.object({
    status: z.string().optional(),
    patientId: z.string().optional(),
    priority: z.string().optional(),
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
    ...(q.priority ? { priority: q.priority } : {}),
    ...(q.patientId && req.user.role !== ROLES.PATIENT ? { patientId: q.patientId } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.labOrder.count({ where }),
    prisma.labOrder.findMany({
      where, include: orderInclude,
      // STAT before URGENT before ROUTINE, oldest first inside each band.
      orderBy: [{ priority: 'desc' }, { orderedAt: 'asc' }],
      skip: (q.page - 1) * q.pageSize, take: q.pageSize,
    }),
  ]);
  res.json(serialize({ total, page: q.page, pageSize: q.pageSize, items }));
}));

router.get('/orders/:id', wrap(async (req, res) => {
  const order = await prisma.labOrder.findUnique({ where: { id: req.params.id }, include: orderInclude });
  if (!order) throw notFound('Lab order not found.');
  await assertPatientAccess(req.user, order.patientId);
  res.json(serialize(order));
}));

// --- Technician workflow --------------------------------------------------

router.post('/orders/:id/collect', requireRole(...LAB_ROLES), wrap(async (req, res) => {
  const order = await loadHospitalOrder(req);
  assertTransition(order.status, LAB_ORDER_STATUS.SAMPLE_COLLECTED);
  const { sampleId } = parse(z.object({ sampleId: z.string().min(1) }), req.body);

  const updated = await prisma.labOrder.update({
    where: { id: order.id },
    data: {
      status: LAB_ORDER_STATUS.SAMPLE_COLLECTED,
      sampleId,
      collectedAt: new Date(),
      collectedBy: req.user.id,
    },
    include: orderInclude,
  });
  res.json(serialize(updated));
}));

router.post('/orders/:id/process', requireRole(...LAB_ROLES), wrap(async (req, res) => {
  const order = await loadHospitalOrder(req);
  assertTransition(order.status, LAB_ORDER_STATUS.PROCESSING);
  res.json(serialize(await prisma.labOrder.update({
    where: { id: order.id }, data: { status: LAB_ORDER_STATUS.PROCESSING }, include: orderInclude,
  })));
}));

// Results are entered per test, then the order moves to RESULT_ENTERED as a
// whole — a half-filled report must not reach the patient.
router.post('/orders/:id/results', requireRole(...LAB_ROLES), wrap(async (req, res) => {
  const order = await loadHospitalOrder(req);
  if (![LAB_ORDER_STATUS.PROCESSING, LAB_ORDER_STATUS.SAMPLE_COLLECTED, LAB_ORDER_STATUS.RESULT_ENTERED].includes(order.status)) {
    throw badRequest(`Cannot enter results while the order is ${order.status}.`);
  }
  const data = parse(z.object({
    summary: z.string().optional(),
    fileId: z.string().optional(),
    results: z.array(z.object({
      itemId: z.string(),
      resultValue: z.string().min(1),
      unit: z.string().optional(),
      referenceRange: z.string().optional(),
      flag: z.enum(['NORMAL', 'HIGH', 'LOW', 'CRITICAL']).default('NORMAL'),
    })).min(1),
  }), req.body);

  const orderItems = await prisma.labOrderItem.findMany({ where: { labOrderId: order.id } });
  const known = new Set(orderItems.map((i) => i.id));
  if (data.results.some((r) => !known.has(r.itemId))) throw badRequest('A result refers to a test that is not on this order.');

  await prisma.$transaction([
    ...data.results.map((r) => prisma.labOrderItem.update({
      where: { id: r.itemId },
      data: { resultValue: r.resultValue, unit: r.unit, referenceRange: r.referenceRange, flag: r.flag },
    })),
    prisma.labOrder.update({ where: { id: order.id }, data: { status: LAB_ORDER_STATUS.RESULT_ENTERED } }),
  ]);

  await prisma.labReport.upsert({
    where: { labOrderId: order.id },
    create: { labOrderId: order.id, summary: data.summary, fileId: data.fileId, enteredBy: req.user.id },
    update: { summary: data.summary, fileId: data.fileId, enteredBy: req.user.id, enteredAt: new Date(), status: 'PENDING_VERIFICATION' },
  });

  await audit(req, AUDIT_ACTIONS.UPLOAD_REPORT, { entityType: 'LabOrder', entityId: order.id });
  res.json(serialize(await prisma.labOrder.findUnique({ where: { id: order.id }, include: orderInclude })));
}));

// Verification is the gate that releases a report to the doctor and patient.
router.post('/orders/:id/verify', requireRole(...LAB_ROLES), wrap(async (req, res) => {
  const order = await loadHospitalOrder(req);
  assertTransition(order.status, LAB_ORDER_STATUS.VERIFIED);
  const report = await prisma.labReport.findUnique({ where: { labOrderId: order.id } });
  if (!report) throw badRequest('No results have been entered for this order yet.');
  if (report.enteredBy === req.user.id) {
    throw forbidden('Results must be verified by someone other than the technician who entered them.');
  }

  const full = await prisma.labOrder.findUnique({ where: { id: order.id }, include: orderInclude });

  await prisma.$transaction([
    prisma.labReport.update({
      where: { labOrderId: order.id },
      data: { status: 'VERIFIED', verifiedBy: req.user.id, verifiedAt: new Date() },
    }),
    prisma.labOrder.update({ where: { id: order.id }, data: { status: LAB_ORDER_STATUS.VERIFIED } }),
    prisma.medicalRecord.create({
      data: {
        patientId: order.patientId,
        recordType: full.items.some((i) => i.labTest.category === 'RADIOLOGY') ? 'IMAGING' : 'LAB',
        title: full.items.map((i) => i.labTest.name).join(', '),
        summary: report.summary,
        recordedBy: req.user.id,
      },
    }),
  ]);

  const critical = full.items.filter((i) => i.flag === 'CRITICAL');
  await notify(full.patient.userId, {
    category: 'REPORT',
    title: 'Lab report available',
    body: `Your report for ${full.items.map((i) => i.labTest.name).join(', ')} is ready.`,
    link: '/reports',
  });
  await notify(full.doctor.userId, {
    category: 'REPORT',
    title: critical.length ? 'Critical lab result' : 'Lab result available',
    body: `${full.patient.user.fullName}: ${full.items.map((i) => `${i.labTest.name} ${i.resultValue ?? ''}`).join(', ')}`,
    link: '/doctor/lab-reports',
    severity: critical.length ? 'CRITICAL' : 'INFO',
  });

  await audit(req, AUDIT_ACTIONS.VERIFY_REPORT, { entityType: 'LabOrder', entityId: order.id });
  res.json(serialize(await prisma.labOrder.findUnique({ where: { id: order.id }, include: orderInclude })));
}));

router.post('/orders/:id/cancel', wrap(async (req, res) => {
  const order = await prisma.labOrder.findUnique({ where: { id: req.params.id } });
  if (!order) throw notFound('Lab order not found.');
  const isOrderingDoctor = req.user.doctorId === order.doctorId;
  if (!isOrderingDoctor && !LAB_ROLES.includes(req.user.role)) {
    throw forbidden('You cannot cancel this lab order.');
  }
  assertTransition(order.status, LAB_ORDER_STATUS.CANCELLED);
  res.json(serialize(await prisma.labOrder.update({
    where: { id: order.id }, data: { status: LAB_ORDER_STATUS.CANCELLED }, include: orderInclude,
  })));
}));

router.get('/reports/:id', wrap(async (req, res) => {
  const report = await prisma.labReport.findUnique({
    where: { id: req.params.id },
    include: { labOrder: { include: orderInclude } },
  });
  if (!report) throw notFound('Report not found.');
  await assertPatientAccess(req.user, report.labOrder.patientId);
  if (report.status !== 'VERIFIED' && req.user.role === ROLES.PATIENT) {
    throw forbidden('This report has not been verified yet.');
  }
  await audit(req, AUDIT_ACTIONS.VIEW_MEDICAL_RECORD, { entityType: 'LabReport', entityId: report.id });
  res.json(serialize(report));
}));

function assertTransition(from, to) {
  if (!LAB_TRANSITIONS[from]?.includes(to)) throw badRequest(`Cannot move a lab order from ${from} to ${to}.`);
}

async function loadHospitalOrder(req) {
  const order = await prisma.labOrder.findUnique({ where: { id: req.params.id } });
  if (!order) throw notFound('Lab order not found.');
  if (order.hospitalId !== req.user.hospitalId) {
    throw forbidden('This lab order belongs to another hospital.');
  }
  return order;
}

export default router;
