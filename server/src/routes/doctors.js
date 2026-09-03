import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ROLES } from '../constants.js';
import { hashPassword } from '../lib/auth.js';
import { badRequest, conflict, forbidden, notFound, parse, serialize, wrap } from '../lib/http.js';
import { assertSameHospital, authenticate, requireRole } from '../middleware/auth.js';

const router = Router();

// --- Search (PRD section 13) ---------------------------------------------

const searchSchema = z.object({
  q: z.string().optional(),
  specialty: z.string().optional(),
  hospitalId: z.string().optional(),
  city: z.string().optional(),
  minExperience: z.coerce.number().int().min(0).optional(),
  maxFee: z.coerce.number().min(0).optional(),
  availableOn: z.string().optional(), // ISO date
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

router.get('/', wrap(async (req, res) => {
  const q = parse(searchSchema, req.query);
  const dayOfWeek = q.availableOn ? new Date(q.availableOn).getDay() : undefined;

  const where = {
    status: 'ACTIVE',
    ...(q.specialty ? { specialization: { contains: q.specialty } } : {}),
    ...(q.hospitalId ? { hospitalId: q.hospitalId } : {}),
    ...(q.minExperience ? { experienceYears: { gte: q.minExperience } } : {}),
    ...(q.maxFee !== undefined ? { consultationFee: { lte: q.maxFee } } : {}),
    ...(q.city ? { hospital: { city: { contains: q.city } } } : {}),
    ...(q.q ? { OR: [{ user: { fullName: { contains: q.q } } }, { specialization: { contains: q.q } }] } : {}),
    ...(dayOfWeek !== undefined ? { availability: { some: { dayOfWeek, isActive: true } } } : {}),
  };

  const [total, doctors] = await Promise.all([
    prisma.doctor.count({ where }),
    prisma.doctor.findMany({
      where,
      orderBy: [{ rating: 'desc' }, { experienceYears: 'desc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        user: { select: { fullName: true, photoUrl: true } },
        hospital: { select: { id: true, name: true, city: true } },
        department: { select: { id: true, name: true } },
        availability: { where: { isActive: true } },
      },
    }),
  ]);

  res.json(serialize({ total, page: q.page, pageSize: q.pageSize, items: doctors }));
}));

// --- Doctor dashboard (PRD section 18) -----------------------------------
// Declared before /:id so "me" is never read as a doctor id.
router.get('/me/dashboard', authenticate, requireRole(ROLES.DOCTOR), wrap(async (req, res) => {
  const doctorId = req.user.doctorId;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const [todayAppointments, pending, followUps, labResults, recentPrescriptions, notifications, admitted] = await Promise.all([
    prisma.appointment.findMany({
      where: { doctorId, scheduledAt: { gte: today, lt: tomorrow }, status: { notIn: ['CANCELLED', 'REJECTED'] } },
      orderBy: { scheduledAt: 'asc' },
      include: { patient: { include: { user: { select: { fullName: true, mobile: true } } } } },
    }),
    prisma.appointment.count({ where: { doctorId, status: 'REQUESTED' } }),
    prisma.consultation.findMany({
      where: { doctorId, followUpDate: { gte: today } },
      orderBy: { followUpDate: 'asc' },
      take: 10,
      include: { patient: { include: { user: { select: { fullName: true } } } } },
    }),
    prisma.labOrder.findMany({
      where: { doctorId, status: 'VERIFIED' },
      orderBy: { orderedAt: 'desc' },
      take: 10,
      include: {
        items: { include: { labTest: { select: { name: true } } } },
        patient: { include: { user: { select: { fullName: true } } } },
      },
    }),
    prisma.prescription.count({ where: { doctorId, issuedAt: { gte: today, lt: tomorrow } } }),
    prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
    prisma.admission.findMany({
      where: { doctorId, status: 'ADMITTED' },
      include: { patient: { include: { user: { select: { fullName: true } } } }, bed: true },
    }),
  ]);

  res.json(serialize({
    todayAppointments,
    pendingRequests: pending,
    followUps,
    labResults,
    prescriptionsToday: recentPrescriptions,
    unreadNotifications: notifications,
    admittedPatients: admitted,
    criticalResults: labResults.filter((o) => o.items.some((i) => i.flag === 'CRITICAL')).length,
  }));
}));

router.get('/:id', wrap(async (req, res) => {
  const doctor = await prisma.doctor.findUnique({
    where: { id: req.params.id },
    include: {
      user: { select: { fullName: true, photoUrl: true, email: true } },
      hospital: { select: { id: true, name: true, city: true, addressLine: true } },
      department: { select: { id: true, name: true } },
      availability: { where: { isActive: true }, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
    },
  });
  if (!doctor) throw notFound('Doctor not found.');
  res.json(serialize(doctor));
}));

// --- Free slots -----------------------------------------------------------

router.get('/:id/slots', wrap(async (req, res) => {
  const { date } = parse(z.object({ date: z.string() }), req.query);
  res.json(await freeSlots(req.params.id, date));
}));

// Expands the doctor's weekly availability into concrete slots for one date and
// removes the ones already taken. Past slots are dropped so today's list is
// actually bookable.
export async function freeSlots(doctorId, dateStr) {
  const day = new Date(dateStr);
  if (Number.isNaN(day.getTime())) throw badRequest('Invalid date.');
  day.setHours(0, 0, 0, 0);

  const doctor = await prisma.doctor.findUnique({
    where: { id: doctorId },
    include: { availability: { where: { dayOfWeek: day.getDay(), isActive: true } } },
  });
  if (!doctor) throw notFound('Doctor not found.');

  const dayEnd = new Date(day);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const booked = await prisma.appointment.findMany({
    where: {
      doctorId,
      scheduledAt: { gte: day, lt: dayEnd },
      status: { notIn: ['CANCELLED', 'REJECTED'] },
    },
    select: { scheduledAt: true },
  });
  const taken = new Set(booked.map((b) => b.scheduledAt.getTime()));

  const slots = [];
  const now = new Date();
  for (const window of doctor.availability) {
    const [sh, sm] = window.startTime.split(':').map(Number);
    const [eh, em] = window.endTime.split(':').map(Number);
    const cursor = new Date(day);
    cursor.setHours(sh, sm, 0, 0);
    const end = new Date(day);
    end.setHours(eh, em, 0, 0);

    while (cursor < end) {
      const slotEnd = new Date(cursor.getTime() + doctor.slotMinutes * 60_000);
      if (slotEnd > end) break;
      if (cursor > now && !taken.has(cursor.getTime())) {
        slots.push({ startsAt: new Date(cursor), endsAt: slotEnd });
      }
      cursor.setTime(slotEnd.getTime());
    }
  }
  return { doctorId, date: day.toISOString().slice(0, 10), slotMinutes: doctor.slotMinutes, slots };
}

// --- Registration & profile ----------------------------------------------

const doctorSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  mobile: z.string().min(8),
  password: z.string().min(8),
  hospitalId: z.string(),
  departmentId: z.string().optional(),
  registrationNumber: z.string().min(3),
  specialization: z.string().min(2),
  qualification: z.string().min(2),
  experienceYears: z.number().int().min(0).default(0),
  consultationFee: z.number().min(0).default(0),
  languages: z.string().default('English'),
  bio: z.string().optional(),
  slotMinutes: z.number().int().min(5).max(120).default(15),
});

// Doctors self-register but stay PENDING_VERIFICATION until an admin approves —
// an unverified doctor must not appear in search or take appointments.
router.post('/register', wrap(async (req, res) => {
  const data = parse(doctorSchema, req.body);
  const clash = await prisma.user.findFirst({
    where: { OR: [{ email: data.email }, { mobile: data.mobile }] },
  });
  if (clash) throw conflict('An account with this email or mobile already exists.');

  const user = await prisma.user.create({
    data: {
      fullName: data.fullName,
      email: data.email,
      mobile: data.mobile,
      passwordHash: await hashPassword(data.password),
      role: ROLES.DOCTOR,
      status: 'ACTIVE',
      doctor: {
        create: {
          hospitalId: data.hospitalId,
          departmentId: data.departmentId,
          registrationNumber: data.registrationNumber,
          specialization: data.specialization,
          qualification: data.qualification,
          experienceYears: data.experienceYears,
          consultationFee: data.consultationFee,
          languages: data.languages,
          bio: data.bio,
          slotMinutes: data.slotMinutes,
        },
      },
    },
    include: { doctor: true },
  });

  res.status(201).json(serialize({
    doctorId: user.doctor.id,
    status: user.doctor.status,
    message: 'Registration submitted. The account becomes visible once the hospital verifies it.',
  }));
}));

router.put('/:id', authenticate, wrap(async (req, res) => {
  const doctor = await prisma.doctor.findUnique({ where: { id: req.params.id } });
  if (!doctor) throw notFound('Doctor not found.');
  assertDoctorEditable(req.user, doctor);

  const data = parse(doctorSchema.partial().omit({
    email: true, mobile: true, password: true, fullName: true, hospitalId: true, registrationNumber: true,
  }), req.body);
  res.json(serialize(await prisma.doctor.update({ where: { id: doctor.id }, data })));
}));

// --- Availability ---------------------------------------------------------

router.get('/:id/availability', wrap(async (req, res) => {
  res.json(await prisma.doctorAvailability.findMany({
    where: { doctorId: req.params.id },
    orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
  }));
}));

const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;

router.put('/:id/availability', authenticate, wrap(async (req, res) => {
  const doctor = await prisma.doctor.findUnique({ where: { id: req.params.id } });
  if (!doctor) throw notFound('Doctor not found.');
  assertDoctorEditable(req.user, doctor);

  const { slots } = parse(z.object({
    slots: z.array(z.object({
      dayOfWeek: z.number().int().min(0).max(6),
      startTime: z.string().regex(timeRe, 'Use HH:MM'),
      endTime: z.string().regex(timeRe, 'Use HH:MM'),
      isActive: z.boolean().default(true),
    })),
  }), req.body);

  for (const s of slots) {
    if (s.startTime >= s.endTime) throw badRequest(`Slot ${s.startTime}-${s.endTime} ends before it starts.`);
  }

  // Replace the whole week in one transaction — a partial update would leave the
  // schedule in a state the doctor never chose.
  await prisma.$transaction([
    prisma.doctorAvailability.deleteMany({ where: { doctorId: doctor.id } }),
    prisma.doctorAvailability.createMany({ data: slots.map((s) => ({ ...s, doctorId: doctor.id })) }),
  ]);

  res.json(await prisma.doctorAvailability.findMany({
    where: { doctorId: doctor.id },
    orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
  }));
}));

// --- Hospital-side doctor management --------------------------------------

router.post('/:id/verify', authenticate, requireRole(ROLES.RECEPTIONIST), wrap(async (req, res) => {
  const doctor = await prisma.doctor.findUnique({ where: { id: req.params.id } });
  if (!doctor) throw notFound('Doctor not found.');
  assertSameHospital(req.user, doctor.hospitalId);
  const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'VERIFIED']) }), req.body);
  res.json(serialize(await prisma.doctor.update({ where: { id: doctor.id }, data: { status } })));
}));

function assertDoctorEditable(user, doctor) {
  if (user.doctorId === doctor.id) return;
  if (user.role === ROLES.RECEPTIONIST && user.hospitalId === doctor.hospitalId) return;
  throw forbidden('You cannot edit this doctor profile.');
}

export default router;
