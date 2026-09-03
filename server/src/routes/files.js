import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../db.js';
import { AUDIT_ACTIONS, ROLES } from '../constants.js';
import { canAccessPatient } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound, parse, serialize, wrap } from '../lib/http.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Medical documents are PDFs and images in practice. Anything else is rejected
// rather than stored — an upload endpoint that accepts arbitrary types is the
// classic way a file store turns into a malware host.
const ALLOWED = new Map([
  ['application/pdf', '.pdf'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    // Client-supplied names never touch the filesystem: random name, extension
    // derived from the checked mime type.
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + ALLOWED.get(file.mimetype)),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) =>
    ALLOWED.has(file.mimetype) ? cb(null, true) : cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: PDF, JPEG, PNG, WebP.`)),
});

const FILE_TYPES = ['LAB_REPORT', 'PRESCRIPTION', 'INSURANCE', 'ID_PROOF', 'DISCHARGE_SUMMARY', 'CERTIFICATE', 'OTHER'];

router.post('/', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw badRequest('No file was uploaded.');
  const data = parse(z.object({
    fileType: z.enum(FILE_TYPES),
    patientId: z.string().optional(),
    accessLevel: z.enum(['PRIVATE', 'PATIENT', 'CARE_TEAM', 'HOSPITAL']).default('CARE_TEAM'),
  }), req.body);

  if (data.patientId && !(await canAccessPatient(req.user, data.patientId))) {
    fs.unlinkSync(req.file.path);
    throw forbidden('You cannot attach a file to this patient.');
  }

  const asset = await prisma.fileAsset.create({
    data: {
      hospitalId: req.user.hospitalId,
      patientId: data.patientId,
      uploadedById: req.user.id,
      fileType: data.fileType,
      originalName: req.file.originalname,
      storedName: req.file.filename,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      accessLevel: data.accessLevel,
    },
  });
  await audit(req, AUDIT_ACTIONS.UPLOAD_REPORT, { entityType: 'FileAsset', entityId: asset.id, detail: data.fileType });
  res.status(201).json(serialize(asset));
}));

router.get('/:id/download', wrap(async (req, res) => {
  const asset = await prisma.fileAsset.findUnique({ where: { id: req.params.id } });
  if (!asset) throw notFound('File not found.');
  await assertFileAccess(req.user, asset);

  const filePath = path.join(UPLOAD_DIR, asset.storedName);
  if (!fs.existsSync(filePath)) throw notFound('The stored file is missing.');

  await audit(req, AUDIT_ACTIONS.VIEW_MEDICAL_RECORD, { entityType: 'FileAsset', entityId: asset.id });
  res.setHeader('Content-Type', asset.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(asset.originalName)}"`);
  fs.createReadStream(filePath).pipe(res);
}));

router.get('/patient/:patientId', wrap(async (req, res) => {
  if (!(await canAccessPatient(req.user, req.params.patientId))) {
    throw forbidden('You do not have permission to access these files.');
  }
  res.json(serialize(await prisma.fileAsset.findMany({
    where: { patientId: req.params.patientId },
    orderBy: { createdAt: 'desc' },
  })));
}));

router.delete('/:id', wrap(async (req, res) => {
  const asset = await prisma.fileAsset.findUnique({ where: { id: req.params.id } });
  if (!asset) throw notFound('File not found.');
  if (asset.uploadedById !== req.user.id) {
    throw forbidden('Only the uploader can delete this file.');
  }
  await prisma.fileAsset.delete({ where: { id: asset.id } });
  fs.rmSync(path.join(UPLOAD_DIR, asset.storedName), { force: true });
  res.json({ message: 'File deleted.' });
}));

async function assertFileAccess(user, asset) {
  if (asset.uploadedById === user.id) return;
  if (asset.patientId) {
    if (asset.accessLevel === 'PRIVATE') throw forbidden('This file is private to its uploader.');
    if (await canAccessPatient(user, asset.patientId)) return;
  }
  if (asset.accessLevel === 'HOSPITAL' && asset.hospitalId && asset.hospitalId === user.hospitalId) return;
  throw forbidden('You do not have permission to access this file.');
}

export default router;
