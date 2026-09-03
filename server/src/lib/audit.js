import { prisma } from '../db.js';

// Audit writes must never break the request they describe, so failures are
// logged and swallowed.
export function audit(req, action, { entityType, entityId, detail } = {}) {
  return prisma.auditLog
    .create({
      data: {
        userId: req.user?.id || null,
        action,
        entityType,
        entityId,
        detail,
        ipAddress: req.ip,
      },
    })
    .catch((err) => console.error('[audit] failed:', err.message));
}
