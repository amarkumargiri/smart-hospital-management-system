import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AUDIT_ACTIONS, ROLES } from '../constants.js';
import { audit } from '../lib/audit.js';
import {
  consumeOtp, createOtp, hashPassword, issueSession, revokeSession,
  rotateSession, signAccessToken, verifyPassword,
} from '../lib/auth.js';
import { badRequest, conflict, parse, unauthorized, wrap } from '../lib/http.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Credential endpoints are the obvious brute-force target.
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

const devOtp = (code) => (process.env.OTP_DEV_MODE === 'true' ? { devOtp: code } : {});

const registerSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  mobile: z.string().min(8).max(15),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
  dateOfBirth: z.string().datetime().optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  bloodGroup: z.string().optional(),
  addressLine: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  emergencyName: z.string().optional(),
  emergencyPhone: z.string().optional(),
});

// Patient self-registration. Doctors and staff are created by an admin instead.
router.post('/register', authLimiter, wrap(async (req, res) => {
  const data = parse(registerSchema, req.body);
  const existing = await prisma.user.findFirst({
    where: { OR: [{ email: data.email }, { mobile: data.mobile }] },
  });
  if (existing) throw conflict('An account with this email or mobile already exists.');

  const user = await prisma.user.create({
    data: {
      email: data.email,
      mobile: data.mobile,
      fullName: data.fullName,
      passwordHash: await hashPassword(data.password),
      role: ROLES.PATIENT,
      status: 'PENDING_VERIFICATION',
      patient: {
        create: {
          dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
          gender: data.gender,
          bloodGroup: data.bloodGroup,
          addressLine: data.addressLine,
          city: data.city,
          state: data.state,
          pincode: data.pincode,
          emergencyName: data.emergencyName,
          emergencyPhone: data.emergencyPhone,
        },
      },
    },
  });

  const code = await createOtp(user.id, 'SIGNUP');
  res.status(201).json({
    userId: user.id,
    message: 'Account created. Verify the OTP sent to your mobile/email to activate it.',
    ...devOtp(code),
  });
}));

router.post('/verify-otp', authLimiter, wrap(async (req, res) => {
  const { userId, code, purpose } = parse(
    z.object({ userId: z.string(), code: z.string().length(6), purpose: z.enum(['SIGNUP', 'LOGIN', 'MFA', 'RESET_PASSWORD']) }),
    req.body,
  );
  if (!(await consumeOtp(userId, purpose, code))) throw badRequest('Invalid or expired OTP.');

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      emailVerified: true,
      mobileVerified: true,
      ...(purpose === 'SIGNUP' ? { status: 'ACTIVE' } : {}),
      lastLoginAt: new Date(),
    },
  });

  const { refreshToken } = await issueSession(user.id, { device: req.headers['user-agent'], ipAddress: req.ip });
  res.json({ accessToken: signAccessToken(user), refreshToken, user: publicUser(user) });
}));

router.post('/resend-otp', authLimiter, wrap(async (req, res) => {
  const { userId, purpose } = parse(
    z.object({ userId: z.string(), purpose: z.enum(['SIGNUP', 'LOGIN', 'MFA', 'RESET_PASSWORD']) }),
    req.body,
  );
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw badRequest('Unknown account.');
  const code = await createOtp(user.id, purpose);
  res.json({ message: 'OTP sent.', ...devOtp(code) });
}));

// One login endpoint for every role. The dashboards differ, the credential check
// does not — separate endpoints per role would be four copies of this handler.
router.post('/login', authLimiter, wrap(async (req, res) => {
  const { identifier, password } = parse(
    z.object({ identifier: z.string().min(3), password: z.string().min(1) }),
    req.body,
  );

  const user = await prisma.user.findFirst({
    where: { OR: [{ email: identifier }, { mobile: identifier }] },
  });
  // Same message either way: telling an attacker the account exists is a free hint.
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw unauthorized('Invalid email/mobile or password.');
  }
  if (user.status === 'BLOCKED') throw unauthorized('This account has been blocked. Contact support.');
  if (user.status === 'PENDING_VERIFICATION') {
    const code = await createOtp(user.id, 'SIGNUP');
    return res.status(202).json({
      requiresOtp: true, purpose: 'SIGNUP', userId: user.id,
      message: 'Account is not verified yet. Enter the OTP to continue.', ...devOtp(code),
    });
  }
  if (user.mfaEnabled) {
    const code = await createOtp(user.id, 'MFA');
    return res.status(202).json({
      requiresOtp: true, purpose: 'MFA', userId: user.id,
      message: 'Enter the verification code to complete login.', ...devOtp(code),
    });
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const { refreshToken } = await issueSession(user.id, { device: req.headers['user-agent'], ipAddress: req.ip });
  await audit({ user: { id: user.id }, ip: req.ip }, AUDIT_ACTIONS.LOGIN, { entityType: 'User', entityId: user.id });
  res.json({ accessToken: signAccessToken(user), refreshToken, user: publicUser(user) });
}));

router.post('/refresh-token', wrap(async (req, res) => {
  const { refreshToken } = parse(z.object({ refreshToken: z.string() }), req.body);
  const rotated = await rotateSession(refreshToken);
  if (!rotated) throw unauthorized('Refresh token is invalid or expired.');
  res.json({ accessToken: signAccessToken(rotated.user), refreshToken: rotated.refreshToken });
}));

router.post('/logout', authenticate, wrap(async (req, res) => {
  const { refreshToken } = parse(z.object({ refreshToken: z.string().optional() }), req.body);
  if (refreshToken) await revokeSession(refreshToken);
  await audit(req, AUDIT_ACTIONS.LOGOUT, { entityType: 'User', entityId: req.user.id });
  res.json({ message: 'Logged out.' });
}));

router.get('/me', authenticate, wrap(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { patient: true, doctor: { include: { hospital: true, department: true } }, staff: { include: { hospital: true } } },
  });
  res.json({
    ...publicUser(user),
    patient: user.patient,
    doctor: user.doctor,
    staff: user.staff,
  });
}));

router.post('/change-password', authenticate, wrap(async (req, res) => {
  const { currentPassword, newPassword } = parse(
    z.object({ currentPassword: z.string(), newPassword: z.string().min(8) }),
    req.body,
  );
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw unauthorized('Current password is incorrect.');
  }
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });
  // Any other device holding a refresh token loses it — a password change is
  // the standard signal that the old sessions should not survive.
  await prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  res.json({ message: 'Password updated. Please sign in again on other devices.' });
}));

router.post('/mfa', authenticate, wrap(async (req, res) => {
  const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
  await prisma.user.update({ where: { id: req.user.id }, data: { mfaEnabled: enabled } });
  res.json({ mfaEnabled: enabled });
}));

router.get('/sessions', authenticate, wrap(async (req, res) => {
  const sessions = await prisma.session.findMany({
    where: { userId: req.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, device: true, ipAddress: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(sessions);
}));

router.delete('/sessions/:id', authenticate, wrap(async (req, res) => {
  await prisma.session.updateMany({
    where: { id: req.params.id, userId: req.user.id },
    data: { revokedAt: new Date() },
  });
  res.json({ message: 'Session revoked.' });
}));

function publicUser(user) {
  return {
    id: user.id, fullName: user.fullName, email: user.email, mobile: user.mobile,
    role: user.role, status: user.status, photoUrl: user.photoUrl, mfaEnabled: user.mfaEnabled,
  };
}

export default router;
