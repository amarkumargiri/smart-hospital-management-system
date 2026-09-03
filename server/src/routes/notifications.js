import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { parse, serialize, wrap } from '../lib/http.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

router.get('/', wrap(async (req, res) => {
  const { unreadOnly, category, limit } = parse(z.object({
    unreadOnly: z.enum(['true', 'false']).default('false'),
    category: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }), req.query);

  const where = {
    userId: req.user.id,
    ...(unreadOnly === 'true' ? { readAt: null } : {}),
    ...(category ? { category } : {}),
  };
  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
    prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
  ]);
  res.json(serialize({ unreadCount, items }));
}));

router.post('/:id/read', wrap(async (req, res) => {
  // updateMany rather than update: it scopes to the caller, so one user cannot
  // mark another user's notification as read.
  const result = await prisma.notification.updateMany({
    where: { id: req.params.id, userId: req.user.id, readAt: null },
    data: { readAt: new Date() },
  });
  res.json({ updated: result.count });
}));

router.post('/read-all', wrap(async (req, res) => {
  const result = await prisma.notification.updateMany({
    where: { userId: req.user.id, readAt: null },
    data: { readAt: new Date() },
  });
  res.json({ updated: result.count });
}));

export default router;
