import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ROLES } from '../constants.js';
import { hashPassword } from '../lib/auth.js';
import { conflict, notFound, parse, serialize, wrap } from '../lib/http.js';
import { assertSameHospital, authenticate, requireRole } from '../middleware/auth.js';

const router = Router();

// --- Public search (PRD section 11) ---------------------------------------

const searchSchema = z.object({
  q: z.string().optional(),
  city: z.string().optional(),
  specialty: z.string().optional(),
  department: z.string().optional(),
  emergency: z.enum(['true', 'false']).optional(),
  availableToday: z.enum(['true', 'false']).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  sort: z.enum(['rating', 'name', 'distance']).default('rating'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

router.get('/', wrap(async (req, res) => {
  const q = parse(searchSchema, req.query);

  const where = {
    status: 'ACTIVE',
    ...(q.city ? { city: { contains: q.city } } : {}),
    ...(q.emergency === 'true' ? { hasEmergency: true } : {}),
    ...(q.minRating ? { rating: { gte: q.minRating } } : {}),
    ...(q.q ? { OR: [{ name: { contains: q.q } }, { city: { contains: q.q } }] } : {}),
    ...(q.specialty ? { doctors: { some: { specialization: { contains: q.specialty }, status: 'ACTIVE' } } } : {}),
    ...(q.department ? { departments: { some: { name: { contains: q.department }, isActive: true } } } : {}),
    ...(q.availableToday === 'true'
      ? { doctors: { some: { status: 'ACTIVE', availability: { some: { dayOfWeek: new Date().getDay(), isActive: true } } } } }
      : {}),
  };

  const [total, hospitals] = await Promise.all([
    prisma.hospital.count({ where }),
    prisma.hospital.findMany({
      where,
      orderBy: q.sort === 'name' ? { name: 'asc' } : { rating: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        departments: { where: { isActive: true }, select: { id: true, name: true } },
        _count: { select: { doctors: true } },
      },
    }),
  ]);

  const withAvailability = await Promise.all(hospitals.map(async (h) => ({
    ...h,
    availability: await bedSummary(h.id),
    distanceKm: distanceKm(q.lat, q.lng, h.latitude, h.longitude),
  })));

  // Distance sorting happens after the page is fetched; a proper geo query needs
  // PostGIS, which is not worth pulling in for a city-level search.
  if (q.sort === 'distance') {
    withAvailability.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  }

  res.json(serialize({ total, page: q.page, pageSize: q.pageSize, items: withAvailability }));
}));

router.get('/:id', wrap(async (req, res) => {
  const hospital = await prisma.hospital.findUnique({
    where: { id: req.params.id },
    include: {
      departments: { where: { isActive: true } },
      doctors: {
        where: { status: 'ACTIVE' },
        include: { user: { select: { fullName: true, photoUrl: true } }, department: { select: { name: true } } },
      },
    },
  });
  if (!hospital) throw notFound('Hospital not found.');
  res.json(serialize({ ...hospital, availability: await bedSummary(hospital.id) }));
}));

// --- Registration & profile ----------------------------------------------

const hospitalSchema = z.object({
  name: z.string().min(3),
  registrationNumber: z.string().min(3),
  type: z.enum(['GOVERNMENT', 'PRIVATE', 'TRUST', 'CLINIC']),
  email: z.string().email(),
  phone: z.string().min(8),
  addressLine: z.string().min(3),
  city: z.string().min(2),
  state: z.string().min(2),
  pincode: z.string().min(4),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  totalBeds: z.number().int().min(0).default(0),
  icuCapacity: z.number().int().min(0).default(0),
  otCount: z.number().int().min(0).default(0),
  hasEmergency: z.boolean().default(true),
  hasLab: z.boolean().default(true),
  hasPharmacy: z.boolean().default(true),
  openingHours: z.string().default('24x7'),
  departments: z.array(z.object({ name: z.string(), code: z.string() })).default([]),
  admin: z.object({
    fullName: z.string().min(2),
    email: z.string().email(),
    mobile: z.string().min(8),
    password: z.string().min(8),
    employeeId: z.string().default('REC-001'),
  }),
});

// A hospital signs up with its first reception account in one call — the hospital
// is useless without someone able to log in and finish setting it up. There is no
// platform administrator to approve it, so it goes live immediately.
router.post('/', wrap(async (req, res) => {
  const data = parse(hospitalSchema, req.body);
  const clash = await prisma.user.findFirst({
    where: { OR: [{ email: data.admin.email }, { mobile: data.admin.mobile }] },
  });
  if (clash) throw conflict('An account with this email or mobile already exists.');

  const hospital = await prisma.$transaction(async (tx) => {
    const created = await tx.hospital.create({
      data: {
        ...pick(data, ['name', 'registrationNumber', 'type', 'email', 'phone', 'addressLine', 'city',
          'state', 'pincode', 'latitude', 'longitude', 'totalBeds', 'icuCapacity', 'otCount',
          'hasEmergency', 'hasLab', 'hasPharmacy', 'openingHours']),
        status: 'ACTIVE',
        verifiedAt: new Date(),
        departments: { create: data.departments },
      },
    });
    await tx.user.create({
      data: {
        fullName: data.admin.fullName,
        email: data.admin.email,
        mobile: data.admin.mobile,
        passwordHash: await hashPassword(data.admin.password),
        role: ROLES.RECEPTIONIST,
        status: 'ACTIVE',
        staff: {
          create: { hospitalId: created.id, employeeId: data.admin.employeeId, role: ROLES.RECEPTIONIST },
        },
      },
    });
    return created;
  });

  res.status(201).json(serialize({
    ...hospital,
    message: 'Hospital created. The reception account can sign in now.',
  }));
}));

router.put('/:id', authenticate, requireRole(ROLES.RECEPTIONIST), wrap(async (req, res) => {
  assertSameHospital(req.user, req.params.id);
  const data = parse(hospitalSchema.partial().omit({ admin: true, departments: true, registrationNumber: true }), req.body);
  const hospital = await prisma.hospital.update({ where: { id: req.params.id }, data });
  res.json(serialize(hospital));
}));

// --- Departments ----------------------------------------------------------

router.get('/:id/departments', wrap(async (req, res) => {
  res.json(await prisma.department.findMany({ where: { hospitalId: req.params.id }, orderBy: { name: 'asc' } }));
}));

router.post('/:id/departments', authenticate, requireRole(ROLES.RECEPTIONIST), wrap(async (req, res) => {
  assertSameHospital(req.user, req.params.id);
  const data = parse(z.object({ name: z.string().min(2), code: z.string().min(1), description: z.string().optional() }), req.body);
  res.status(201).json(await prisma.department.create({ data: { ...data, hospitalId: req.params.id } }));
}));

router.put('/:id/departments/:deptId', authenticate, requireRole(ROLES.RECEPTIONIST), wrap(async (req, res) => {
  assertSameHospital(req.user, req.params.id);
  const data = parse(z.object({ name: z.string().optional(), description: z.string().optional(), isActive: z.boolean().optional() }), req.body);
  res.json(await prisma.department.update({ where: { id: req.params.deptId }, data }));
}));

// --- Staff (PRD section 48) ----------------------------------------------

const staffSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  mobile: z.string().min(8),
  password: z.string().min(8),
  employeeId: z.string().min(1),
  departmentId: z.string().optional(),
  joiningDate: z.string().datetime().optional(),
});

router.get('/:id/staff', authenticate, requireRole(ROLES.RECEPTIONIST), wrap(async (req, res) => {
  assertSameHospital(req.user, req.params.id);
  const staff = await prisma.hospitalStaff.findMany({
    where: { hospitalId: req.params.id },
    include: { user: { select: { fullName: true, email: true, mobile: true, status: true } }, department: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(staff);
}));

router.post('/:id/staff', authenticate, requireRole(ROLES.RECEPTIONIST), wrap(async (req, res) => {
  assertSameHospital(req.user, req.params.id);
  const data = parse(staffSchema, req.body);
  const clash = await prisma.user.findFirst({ where: { OR: [{ email: data.email }, { mobile: data.mobile }] } });
  if (clash) throw conflict('An account with this email or mobile already exists.');

  const user = await prisma.user.create({
    data: {
      fullName: data.fullName,
      email: data.email,
      mobile: data.mobile,
      passwordHash: await hashPassword(data.password),
      role: ROLES.RECEPTIONIST,
      status: 'ACTIVE',
      staff: {
        create: {
          hospitalId: req.params.id,
          employeeId: data.employeeId,
          role: ROLES.RECEPTIONIST,
          departmentId: data.departmentId,
          joiningDate: data.joiningDate ? new Date(data.joiningDate) : undefined,
        },
      },
    },
    include: { staff: true },
  });
  res.status(201).json({ id: user.staff.id, userId: user.id, fullName: user.fullName, role: user.role });
}));

router.put('/:id/staff/:staffId', authenticate, requireRole(ROLES.RECEPTIONIST), wrap(async (req, res) => {
  assertSameHospital(req.user, req.params.id);
  const data = parse(z.object({
    departmentId: z.string().nullable().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  }), req.body);
  const staff = await prisma.hospitalStaff.update({ where: { id: req.params.staffId }, data });
  if (data.status) {
    await prisma.user.update({
      where: { id: staff.userId },
      data: { status: data.status === 'ACTIVE' ? 'ACTIVE' : 'BLOCKED' },
    });
  }
  res.json(staff);
}));

// --- helpers --------------------------------------------------------------

export async function bedSummary(hospitalId) {
  const beds = await prisma.bed.groupBy({
    by: ['type', 'status'],
    where: { hospitalId },
    _count: { _all: true },
  });
  const summary = { totalBeds: 0, availableBeds: 0, totalIcu: 0, availableIcu: 0, ventilators: 0 };
  for (const row of beds) {
    const n = row._count._all;
    if (row.type === 'ICU') {
      summary.totalIcu += n;
      if (row.status === 'AVAILABLE') summary.availableIcu += n;
    } else {
      summary.totalBeds += n;
      if (row.status === 'AVAILABLE') summary.availableBeds += n;
    }
  }
  summary.ventilators = await prisma.bed.count({ where: { hospitalId, hasVentilator: true, status: 'AVAILABLE' } });
  summary.bedOccupancyPct = summary.totalBeds ? round(((summary.totalBeds - summary.availableBeds) / summary.totalBeds) * 100) : 0;
  summary.icuOccupancyPct = summary.totalIcu ? round(((summary.totalIcu - summary.availableIcu) / summary.totalIcu) * 100) : 0;
  return summary;
}

const round = (n) => Math.round(n * 10) / 10;

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

// Haversine — good enough for "how far is this hospital", no geo library needed.
function distanceKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined)) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10;
}

export default router;
