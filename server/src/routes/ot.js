import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ROLES } from '../constants.js';
import { badRequest, conflict, forbidden, notFound, parse, serialize, wrap } from '../lib/http.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

const OT_ROLES = [ROLES.RECEPTIONIST, ROLES.DOCTOR];

router.get('/rooms', requireRole(...OT_ROLES), wrap(async (req, res) => {
  const rooms = await prisma.operatingRoom.findMany({
    where: { hospitalId: req.user.hospitalId },
    orderBy: { name: 'asc' },
    include: {
      surgeries: {
        where: { status: { in: ['SCHEDULED', 'IN_PROGRESS'] }, scheduledAt: { gte: startOfToday() } },
        orderBy: { scheduledAt: 'asc' },
        include: { surgeon: { include: { user: { select: { fullName: true } } } } },
      },
    },
  });
  res.json(serialize(rooms));
}));

router.post('/rooms', requireRole(ROLES.RECEPTIONIST), wrap(async (req, res) => {
  const { name } = parse(z.object({ name: z.string().min(1) }), req.body);
  const room = await prisma.operatingRoom.create({ data: { name, hospitalId: req.user.hospitalId } });
  await prisma.hospital.update({
    where: { id: req.user.hospitalId },
    data: { otCount: await prisma.operatingRoom.count({ where: { hospitalId: req.user.hospitalId } }) },
  });
  res.status(201).json(serialize(room));
}));

router.put('/rooms/:id', requireRole(ROLES.RECEPTIONIST), wrap(async (req, res) => {
  const room = await loadRoom(req);
  const data = parse(z.object({
    name: z.string().optional(),
    status: z.enum(['AVAILABLE', 'IN_USE', 'CLEANING', 'MAINTENANCE']).optional(),
  }), req.body);
  res.json(serialize(await prisma.operatingRoom.update({ where: { id: room.id }, data })));
}));

// --- Surgery scheduling ---------------------------------------------------

router.get('/surgeries', requireRole(...OT_ROLES), wrap(async (req, res) => {
  const q = parse(z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    status: z.string().optional(),
  }), req.query);

  const surgeries = await prisma.surgery.findMany({
    where: {
      operatingRoom: { hospitalId: req.user.hospitalId },
      ...(q.status ? { status: { in: q.status.split(',') } } : {}),
      ...(q.from || q.to
        ? { scheduledAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
        : {}),
    },
    orderBy: { scheduledAt: 'asc' },
    include: {
      operatingRoom: { select: { id: true, name: true } },
      surgeon: { include: { user: { select: { fullName: true } } } },
      admission: { include: { patient: { include: { user: { select: { fullName: true } } } } } },
    },
  });
  res.json(serialize(surgeries));
}));

router.post('/surgeries', requireRole(ROLES.RECEPTIONIST, ROLES.DOCTOR), wrap(async (req, res) => {
  const data = parse(z.object({
    operatingRoomId: z.string(),
    surgeonId: z.string(),
    admissionId: z.string().optional(),
    procedure: z.string().min(3),
    scheduledAt: z.string(),
    durationMinutes: z.number().int().min(15).max(1440).default(60),
    charge: z.number().min(0).default(0),
    notes: z.string().optional(),
  }), req.body);

  const room = await prisma.operatingRoom.findUnique({ where: { id: data.operatingRoomId } });
  if (!room) throw notFound('Operating room not found.');
  if (room.hospitalId !== req.user.hospitalId) {
    throw forbidden('That operating room belongs to another hospital.');
  }

  const start = new Date(data.scheduledAt);
  if (Number.isNaN(start.getTime())) throw badRequest('Invalid scheduledAt.');
  const end = new Date(start.getTime() + data.durationMinutes * 60_000);

  // Overlap check: any live booking in this room that starts before ours ends.
  // Prisma cannot express "start + duration > x", so the candidate window is
  // narrowed by the longest allowed surgery and the exact test is done in JS.
  const neighbours = await prisma.surgery.findMany({
    where: {
      operatingRoomId: room.id,
      status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
      scheduledAt: { gte: new Date(start.getTime() - 1440 * 60_000), lt: end },
    },
  });
  const clash = neighbours.find((s) => new Date(s.scheduledAt.getTime() + s.durationMinutes * 60_000) > start);
  if (clash) throw conflict(`${room.name} is already booked from ${clash.scheduledAt.toISOString()} for ${clash.durationMinutes} minutes.`);

  const surgery = await prisma.surgery.create({
    data: { ...data, scheduledAt: start },
    include: { operatingRoom: true, surgeon: { include: { user: { select: { fullName: true } } } } },
  });
  res.status(201).json(serialize(surgery));
}));

router.post('/surgeries/:id/status', requireRole(...OT_ROLES), wrap(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['IN_PROGRESS', 'COMPLETED', 'CANCELLED']) }), req.body);
  const surgery = await prisma.surgery.findUnique({ where: { id: req.params.id }, include: { operatingRoom: true } });
  if (!surgery) throw notFound('Surgery not found.');
  if (surgery.operatingRoom.hospitalId !== req.user.hospitalId) {
    throw forbidden('That surgery belongs to another hospital.');
  }

  // The room follows the surgery: in use while operating, cleaning afterwards.
  const roomStatus = { IN_PROGRESS: 'IN_USE', COMPLETED: 'CLEANING', CANCELLED: 'AVAILABLE' }[status];
  const [updated] = await prisma.$transaction([
    prisma.surgery.update({ where: { id: surgery.id }, data: { status } }),
    prisma.operatingRoom.update({ where: { id: surgery.operatingRoomId }, data: { status: roomStatus } }),
  ]);
  res.json(serialize(updated));
}));

async function loadRoom(req) {
  const room = await prisma.operatingRoom.findUnique({ where: { id: req.params.id } });
  if (!room) throw notFound('Operating room not found.');
  if (room.hospitalId !== req.user.hospitalId) {
    throw forbidden('That operating room belongs to another hospital.');
  }
  return room;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export default router;
