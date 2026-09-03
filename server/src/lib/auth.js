import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';

const SECRET = process.env.JWT_SECRET;
const ACCESS_TTL = process.env.JWT_EXPIRES_IN || '30m';
const REFRESH_DAYS = Number(process.env.REFRESH_EXPIRES_DAYS || 30);

if (!SECRET) throw new Error('JWT_SECRET is not set.');

export const hashPassword = (plain) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, SECRET, { expiresIn: ACCESS_TTL });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, SECRET);
}

export async function issueSession(userId, { device, ipAddress } = {}) {
  const refreshToken = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 86_400_000);
  await prisma.session.create({ data: { userId, refreshToken, device, ipAddress, expiresAt } });
  return { refreshToken, expiresAt };
}

export async function rotateSession(refreshToken) {
  const session = await prisma.session.findUnique({
    where: { refreshToken },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  const next = await issueSession(session.userId, { device: session.device, ipAddress: session.ipAddress });
  return { user: session.user, ...next };
}

export async function revokeSession(refreshToken) {
  await prisma.session.updateMany({
    where: { refreshToken, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// --- OTP -------------------------------------------------------------------

const OTP_TTL_MINUTES = 10;

export async function createOtp(userId, purpose) {
  // Six digits, uniformly distributed — Math.random() is not acceptable for a
  // credential even a short-lived one.
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000);
  await prisma.otpToken.create({ data: { userId, code, purpose, expiresAt } });
  if (process.env.OTP_DEV_MODE === 'true') {
    console.log(`[otp] user=${userId} purpose=${purpose} code=${code}`);
  }
  return code;
}

export async function consumeOtp(userId, purpose, code) {
  const token = await prisma.otpToken.findFirst({
    where: { userId, purpose, code, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!token) return false;
  await prisma.otpToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
  return true;
}
