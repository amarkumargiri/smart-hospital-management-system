import { prisma } from '../db.js';

// Notifications are rows in the database that dashboards poll. A push/SMS/email
// transport can subscribe to the same call later without touching callers.
export function notify(userId, { category, title, body, link, severity = 'INFO' }) {
  if (!userId) return Promise.resolve(null);
  return prisma.notification
    .create({ data: { userId, category, title, body, link, severity } })
    .catch((err) => console.error('[notify] failed:', err.message));
}

export function notifyMany(userIds, payload) {
  return Promise.all([...new Set(userIds.filter(Boolean))].map((id) => notify(id, payload)));
}

// Everyone on the hospital desk — used for capacity and inventory alerts.
export async function hospitalDeskUserIds(hospitalId) {
  const staff = await prisma.hospitalStaff.findMany({
    where: { hospitalId, status: 'ACTIVE' },
    select: { userId: true },
  });
  return staff.map((s) => s.userId);
}
