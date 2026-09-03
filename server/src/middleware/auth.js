import { prisma } from '../db.js';
import { verifyAccessToken } from '../lib/auth.js';
import { forbidden, unauthorized } from '../lib/http.js';
import { ROLES } from '../constants.js';

// Attaches req.user with the role-specific profile ids the routes need
// (patientId / doctorId / staffId / hospitalId) so downstream handlers never
// have to re-query them.
export async function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized());

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return next(unauthorized('Session expired or token invalid.'));
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { patient: true, doctor: true, staff: true },
  });
  if (!user) return next(unauthorized());
  if (user.status === 'BLOCKED') return next(forbidden('This account has been blocked.'));

  req.user = {
    id: user.id,
    role: user.role,
    fullName: user.fullName,
    email: user.email,
    patientId: user.patient?.id || null,
    doctorId: user.doctor?.id || null,
    staffId: user.staff?.id || null,
    hospitalId: user.doctor?.hospitalId || user.staff?.hospitalId || null,
    departmentId: user.doctor?.departmentId || user.staff?.departmentId || null,
  };
  next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) {
    return next(forbidden(`This action requires one of: ${roles.join(', ')}.`));
  }
  next();
};

// Doctor and receptionist actions must stay inside their own hospital.
export function assertSameHospital(user, hospitalId) {
  if (!user.hospitalId || user.hospitalId !== hospitalId) {
    throw forbidden('This record belongs to another hospital.');
  }
}
