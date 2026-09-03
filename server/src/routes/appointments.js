import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { APPOINTMENT_STATUS, APPOINTMENT_TRANSITIONS, APPOINTMENT_TYPES, ROLES } from '../constants.js';
import { badRequest, conflict, forbidden, notFound, parse, serialize, wrap } from '../lib/http.js';
import { notify } from '../lib/notify.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

const listSchema = z.object({
  patientId: z.string().optional(),
  doctorId: z.string().optional(),
  hospitalId: z.string().optional(),
  departmentId: z.string().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

router.get('/', wrap(async (req, res) => {
  const q = parse(listSchema, req.query);
  const where = {
    ...scopeFor(req.user),
    ...(q.patientId ? { patientId: q.patientId } : {}),
    ...(q.doctorId ? { doctorId: q.doctorId } : {}),
    ...(q.hospitalId ? { hospitalId: q.hospitalId } : {}),
    ...(q.departmentId ? { departmentId: q.departmentId } : {}),
    ...(q.status ? { status: { in: q.status.split(',') } } : {}),
    ...(q.type ? { type: q.type } : {}),
    ...(q.from || q.to
      ? { scheduledAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
      : {}),
    ...(q.q ? { patient: { user: { fullName: { contains: q.q } } } } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({
      where,
      orderBy: { scheduledAt: 'asc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: appointmentInclude,
    }),
  ]);
  res.json(serialize({ total, page: q.page, pageSize: q.pageSize, items }));
}));

router.get('/:id', wrap(async (req, res) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: req.params.id },
    include: { ...appointmentInclude, consultation: true },
  });
  if (!appointment) throw notFound('Appointment not found.');
  assertVisible(req.user, appointment);
  res.json(serialize(appointment));
}));

// --- Booking --------------------------------------------------------------

const bookSchema = z.object({
  doctorId: z.string(),
  scheduledAt: z.string(),
  type: z.enum(APPOINTMENT_TYPES).default('OPD'),
  reason: z.string().optional(),
  patientId: z.string().optional(), // receptionists book on a patient's behalf
});

router.post('/', wrap(async (req, res) => {
  const data = parse(bookSchema, req.body);
  const patientId = data.patientId || req.user.patientId;
  if (!patientId) throw badRequest('patientId is required.');
  if (req.user.role === ROLES.PATIENT && patientId !== req.user.patientId) {
    throw forbidden('You can only book appointments for yourself.');
  }

  const doctor = await prisma.doctor.findUnique({ where: { id: data.doctorId } });
  if (!doctor) throw notFound('Doctor not found.');
  if (doctor.status !== 'ACTIVE') throw badRequest('This doctor is not accepting appointments.');

  const scheduledAt = new Date(data.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) throw badRequest('Invalid scheduledAt.');
  if (scheduledAt < new Date()) throw badRequest('Cannot book a slot in the past.');
  await assertSlotIsOffered(doctor, scheduledAt);

  const endsAt = new Date(scheduledAt.getTime() + doctor.slotMinutes * 60_000);

  let appointment;
  try {
    appointment = await prisma.appointment.create({
      data: {
        patientId,
        doctorId: doctor.id,
        hospitalId: doctor.hospitalId,
        departmentId: doctor.departmentId,
        scheduledAt,
        endsAt,
        type: data.type,
        reason: data.reason,
        fee: doctor.consultationFee,
        status: APPOINTMENT_STATUS.REQUESTED,
      },
      include: appointmentInclude,
    });
  } catch (err) {
    // The unique index on (doctorId, scheduledAt) is what actually prevents a
    // double booking when two patients tap the same slot at once.
    if (err.code === 'P2002') throw conflict('This time slot is no longer available. Please select another slot.');
    throw err;
  }

  await notify(appointment.doctor.userId, {
    category: 'APPOINTMENT',
    title: 'New appointment request',
    body: `${appointment.patient.user.fullName} requested ${appointment.type} on ${formatWhen(scheduledAt)}.`,
    link: '/doctor/appointments',
  });
  await notify(appointment.patient.userId, {
    category: 'APPOINTMENT',
    title: 'Appointment requested',
    body: `Your appointment with Dr. ${appointment.doctor.user.fullName} on ${formatWhen(scheduledAt)} is awaiting confirmation.`,
    link: '/appointments',
  });

  res.status(201).json(serialize(appointment));
}));

// --- Reschedule / cancel --------------------------------------------------

router.put('/:id', wrap(async (req, res) => {
  const { scheduledAt } = parse(z.object({ scheduledAt: z.string() }), req.body);
  const appointment = await loadEditable(req.user, req.params.id);
  if (!['REQUESTED', 'CONFIRMED'].includes(appointment.status)) {
    throw badRequest(`An appointment that is ${appointment.status} cannot be rescheduled.`);
  }

  const next = new Date(scheduledAt);
  if (Number.isNaN(next.getTime())) throw badRequest('Invalid scheduledAt.');
  if (next < new Date()) throw badRequest('Cannot reschedule into the past.');
  const doctor = await prisma.doctor.findUnique({ where: { id: appointment.doctorId } });
  await assertSlotIsOffered(doctor, next);

  try {
    const updated = await prisma.appointment.update({
      where: { id: appointment.id },
      data: {
        scheduledAt: next,
        endsAt: new Date(next.getTime() + doctor.slotMinutes * 60_000),
        status: APPOINTMENT_STATUS.REQUESTED,
      },
      include: appointmentInclude,
    });
    await notify(updated.doctor.userId, {
      category: 'APPOINTMENT',
      title: 'Appointment rescheduled',
      body: `${updated.patient.user.fullName} moved their appointment to ${formatWhen(next)}.`,
      link: '/doctor/appointments',
    });
    res.json(serialize(updated));
  } catch (err) {
    if (err.code === 'P2002') throw conflict('This time slot is no longer available. Please select another slot.');
    throw err;
  }
}));

router.delete('/:id', wrap(async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().optional() }), req.body || {});
  const appointment = await loadEditable(req.user, req.params.id);
  assertTransition(appointment.status, APPOINTMENT_STATUS.CANCELLED);

  const updated = await prisma.appointment.update({
    where: { id: appointment.id },
    data: { status: APPOINTMENT_STATUS.CANCELLED, cancelledAt: new Date(), cancelReason: reason },
    include: appointmentInclude,
  });
  await notify(updated.doctor.userId, {
    category: 'APPOINTMENT',
    title: 'Appointment cancelled',
    body: `${updated.patient.user.fullName} cancelled the ${formatWhen(updated.scheduledAt)} appointment.`,
    link: '/doctor/appointments',
  });
  await notify(updated.patient.userId, {
    category: 'APPOINTMENT',
    title: 'Appointment cancelled',
    body: `Your appointment on ${formatWhen(updated.scheduledAt)} has been cancelled.`,
    link: '/appointments',
  });
  res.json(serialize(updated));
}));

// --- Lifecycle (PRD section 15) ------------------------------------------

router.post('/:id/status', wrap(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(Object.keys(APPOINTMENT_TRANSITIONS)) }), req.body);
  const appointment = await prisma.appointment.findUnique({ where: { id: req.params.id }, include: appointmentInclude });
  if (!appointment) throw notFound('Appointment not found.');
  assertVisible(req.user, appointment);

  // Patients may only cancel; every other transition belongs to the clinic side.
  if (req.user.role === ROLES.PATIENT && status !== APPOINTMENT_STATUS.CANCELLED) {
    throw forbidden('Only the hospital or doctor can change this appointment status.');
  }
  assertTransition(appointment.status, status);

  const now = new Date();
  const stamps = {
    CHECKED_IN: { checkedInAt: now },
    IN_CONSULTATION: { startedAt: now },
    COMPLETED: { completedAt: now },
    CANCELLED: { cancelledAt: now },
  }[status] || {};

  // Token is issued at check-in, when the patient is physically in the queue.
  const tokenNumber = status === APPOINTMENT_STATUS.CHECKED_IN && !appointment.tokenNumber
    ? await nextToken(appointment.doctorId, appointment.scheduledAt)
    : undefined;

  const updated = await prisma.appointment.update({
    where: { id: appointment.id },
    data: { status, ...stamps, ...(tokenNumber ? { tokenNumber } : {}) },
    include: appointmentInclude,
  });

  const messages = {
    CONFIRMED: 'Your appointment is confirmed.',
    CHECKED_IN: `You are checked in. Token ${updated.tokenNumber}.`,
    COMPLETED: 'Your consultation is complete.',
    REJECTED: 'Your appointment request was declined.',
    NO_SHOW: 'You were marked as absent for this appointment.',
  };
  if (messages[status]) {
    await notify(updated.patient.userId, {
      category: 'APPOINTMENT',
      title: 'Appointment update',
      body: `${messages[status]} (${formatWhen(updated.scheduledAt)})`,
      link: '/appointments',
    });
  }

  res.json(serialize(updated));
}));

// --- Queue (PRD section 17) ----------------------------------------------

router.get('/queue/status', wrap(async (req, res) => {
  const { doctorId, date } = parse(z.object({ doctorId: z.string(), date: z.string().optional() }), req.query);
  const day = startOfDay(date ? new Date(date) : new Date());
  const dayEnd = new Date(day);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } });
  if (!doctor) throw notFound('Doctor not found.');

  const queue = await prisma.appointment.findMany({
    where: {
      doctorId,
      scheduledAt: { gte: day, lt: dayEnd },
      status: { in: ['CHECKED_IN', 'IN_CONSULTATION', 'COMPLETED'] },
      tokenNumber: { not: null },
    },
    orderBy: { checkedInAt: 'asc' },
    select: { id: true, tokenNumber: true, status: true, patientId: true, checkedInAt: true },
  });

  const inConsultation = queue.find((a) => a.status === 'IN_CONSULTATION');
  const lastCompleted = [...queue].reverse().find((a) => a.status === 'COMPLETED');
  const currentToken = inConsultation?.tokenNumber || lastCompleted?.tokenNumber || null;
  const waiting = queue.filter((a) => a.status === 'CHECKED_IN');

  // Waiting time uses today's measured consultation length and falls back to the
  // doctor's configured slot when there is nothing to measure yet.
  const avgMinutes = await averageConsultationMinutes(doctorId, day, dayEnd, doctor.slotMinutes);

  const mine = req.user.patientId
    ? queue.find((a) => a.patientId === req.user.patientId)
    : null;
  const aheadOfMe = mine ? waiting.filter((a) => (a.checkedInAt ?? 0) < (mine.checkedInAt ?? 0)).length : null;

  res.json({
    doctorId,
    date: day.toISOString().slice(0, 10),
    currentToken,
    waitingCount: waiting.length,
    averageConsultationMinutes: avgMinutes,
    yourToken: mine?.tokenNumber || null,
    patientsAhead: aheadOfMe,
    estimatedWaitMinutes: aheadOfMe === null ? null : aheadOfMe * avgMinutes,
    queue: waiting.map((a) => ({ tokenNumber: a.tokenNumber, status: a.status })),
  });
}));

// --- helpers --------------------------------------------------------------

const appointmentInclude = {
  patient: { include: { user: { select: { id: true, fullName: true, mobile: true } } } },
  doctor: { include: { user: { select: { id: true, fullName: true } } } },
  hospital: { select: { id: true, name: true, city: true } },
  department: { select: { id: true, name: true } },
};

function scopeFor(user) {
  if (user.role === ROLES.PATIENT) return { patientId: user.patientId };
  if (user.role === ROLES.DOCTOR) return { doctorId: user.doctorId };
  return { hospitalId: user.hospitalId };
}

function assertVisible(user, appointment) {
  if (user.role === ROLES.PATIENT && appointment.patientId === user.patientId) return;
  if (user.role === ROLES.DOCTOR && appointment.doctorId === user.doctorId) return;
  if (user.hospitalId && appointment.hospitalId === user.hospitalId) return;
  throw forbidden('You do not have permission to access this appointment.');
}

async function loadEditable(user, id) {
  const appointment = await prisma.appointment.findUnique({ where: { id } });
  if (!appointment) throw notFound('Appointment not found.');
  assertVisible(user, appointment);
  return appointment;
}

function assertTransition(from, to) {
  if (!APPOINTMENT_TRANSITIONS[from]?.includes(to)) {
    throw badRequest(`Cannot move an appointment from ${from} to ${to}.`);
  }
}

// The requested time must fall inside a window the doctor actually publishes and
// land on a slot boundary — otherwise the calendar drifts out of alignment.
async function assertSlotIsOffered(doctor, when) {
  const windows = await prisma.doctorAvailability.findMany({
    where: { doctorId: doctor.id, dayOfWeek: when.getDay(), isActive: true },
  });
  if (!windows.length) throw badRequest('The doctor is not available on this day.');

  const minutes = when.getHours() * 60 + when.getMinutes();
  const fits = windows.some((w) => {
    const start = toMinutes(w.startTime);
    const end = toMinutes(w.endTime);
    return minutes >= start && minutes + doctor.slotMinutes <= end && (minutes - start) % doctor.slotMinutes === 0;
  });
  if (!fits) throw badRequest('The selected time is not an available slot for this doctor.');
}

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

async function nextToken(doctorId, scheduledAt) {
  const day = startOfDay(scheduledAt);
  const dayEnd = new Date(day);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const issued = await prisma.appointment.count({
    where: { doctorId, scheduledAt: { gte: day, lt: dayEnd }, tokenNumber: { not: null } },
  });
  return `A-${String(issued + 1).padStart(2, '0')}`;
}

async function averageConsultationMinutes(doctorId, from, to, fallback) {
  const done = await prisma.appointment.findMany({
    where: { doctorId, scheduledAt: { gte: from, lt: to }, status: 'COMPLETED', startedAt: { not: null }, completedAt: { not: null } },
    select: { startedAt: true, completedAt: true },
  });
  if (!done.length) return fallback;
  const total = done.reduce((sum, a) => sum + (a.completedAt - a.startedAt) / 60_000, 0);
  return Math.max(1, Math.round(total / done.length));
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

const formatWhen = (date) =>
  new Date(date).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export default router;
