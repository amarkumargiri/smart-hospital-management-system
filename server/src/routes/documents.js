// Intelligent medical document processing — upload, OCR/NLP status, review and
// verification.
//
// Everything security-related is reused, not reinvented: `authenticate` for
// identity, `canAccessPatient` for the relationship rule, `audit()` for the
// trail, and the same multer allow-list the existing file store uses.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../db.js';
import {
  AUDIT_ACTIONS, CONFIDENCE, DOCUMENT_MIME_TYPES, DOCUMENT_STATUS, DOCUMENT_TYPES,
  ENTITY_TYPES, FAILED_STATUSES, MAX_DOCUMENT_BYTES, REVIEWABLE_STATUSES, ROLES,
} from '../constants.js';
import { canAccessPatient } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound, parse, serialize, wrap } from '../lib/http.js';
import { notify } from '../lib/notify.js';
import { authenticate } from '../middleware/auth.js';
import { processDocument } from '../documents/pipeline.js';
import { toStructured } from '../documents/extract.js';

const router = Router();
router.use(authenticate);

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Same rules as the existing file store: allow-list by MIME, random stored
// name, extension derived from the verified type — never from the client.
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) =>
      cb(null, crypto.randomBytes(16).toString('hex') + DOCUMENT_MIME_TYPES.get(file.mimetype)),
  }),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => (DOCUMENT_MIME_TYPES.has(file.mimetype)
    ? cb(null, true)
    : cb(new Error('Unsupported file type. Please upload PDF, JPG, JPEG, or PNG.'))),
});

const documentInclude = {
  file: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true, createdAt: true } },
  patient: { include: { user: { select: { id: true, fullName: true } } } },
  uploadedBy: { select: { id: true, fullName: true, role: true } },
  verifications: {
    include: { reviewedBy: { select: { id: true, fullName: true, role: true } } },
    orderBy: { reviewedAt: 'desc' },
  },
};

// Loads a document and enforces the same relationship rule the rest of the
// medical record uses.
async function loadAccessible(req, { withEntities = false, withOcr = false } = {}) {
  const document = await prisma.medicalDocument.findUnique({
    where: { id: req.params.id },
    include: {
      ...documentInclude,
      ...(withEntities ? { entities: { orderBy: [{ groupKey: 'asc' }, { entityType: 'asc' }] } } : {}),
      ...(withOcr ? { ocrResult: true } : {}),
    },
  });
  if (!document) throw notFound('Document not found.');
  if (!(await canAccessPatient(req.user, document.patientId))) {
    throw forbidden('You do not have permission to access this document.');
  }
  return document;
}

// Only the patient the document belongs to, or clinical/desk staff with an
// existing relationship, may approve an extraction into the record.
function assertCanVerify(user, document) {
  if (user.role === ROLES.PATIENT) {
    if (user.patientId !== document.patientId) throw forbidden('You can only verify your own documents.');
    return;
  }
  if ([ROLES.DOCTOR, ROLES.RECEPTIONIST].includes(user.role)) return;
  throw forbidden('This role cannot verify medical documents.');
}

// --- upload ---------------------------------------------------------------

router.post('/', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw badRequest('No file was uploaded. Please upload PDF, JPG, JPEG, or PNG.');

  const cleanupAndThrow = async (error) => {
    await fsp.rm(req.file.path, { force: true }).catch(() => {});
    throw error;
  };

  const data = parse(z.object({
    patientId: z.string().optional(),
    documentType: z.enum(DOCUMENT_TYPES).optional(), // a hint; the classifier still runs
  }), req.body);

  const patientId = data.patientId || req.user.patientId;
  if (!patientId) await cleanupAndThrow(badRequest('patientId is required.'));
  if (!(await canAccessPatient(req.user, patientId))) {
    await cleanupAndThrow(forbidden('You cannot upload a document for this patient.'));
  }

  // The file itself lives in the existing store; the document row carries the
  // processing lifecycle on top of it.
  const document = await prisma.$transaction(async (tx) => {
    const asset = await tx.fileAsset.create({
      data: {
        hospitalId: req.user.hospitalId,
        patientId,
        uploadedById: req.user.id,
        fileType: 'LAB_REPORT',
        originalName: req.file.originalname,
        storedName: req.file.filename,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        accessLevel: 'CARE_TEAM',
      },
    });
    return tx.medicalDocument.create({
      data: {
        patientId,
        hospitalId: req.user.hospitalId,
        uploadedById: req.user.id,
        fileId: asset.id,
        documentType: data.documentType || 'OTHER',
        status: DOCUMENT_STATUS.UPLOADED,
      },
      include: documentInclude,
    });
  });

  await audit(req, AUDIT_ACTIONS.UPLOAD_DOCUMENT, {
    entityType: 'MedicalDocument',
    entityId: document.id,
    detail: `${req.file.mimetype} ${req.file.size} bytes`, // never the contents
  });

  // OCR takes seconds; the client polls rather than holding the request open.
  processDocument(document.id).catch((err) => console.error('[documents] background run failed:', err.message));

  res.status(201).json(serialize({
    ...document,
    message: 'Document uploaded. Processing has started — poll this document for status.',
  }));
}));

// --- listing and status ----------------------------------------------------

router.get('/', wrap(async (req, res) => {
  const q = parse(z.object({
    patientId: z.string().optional(),
    status: z.string().optional(),
    documentType: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }), req.query);

  let patientId = q.patientId;
  if (req.user.role === ROLES.PATIENT) {
    patientId = req.user.patientId; // patients only ever see their own
  } else if (!patientId) {
    throw badRequest('patientId is required.');
  }
  if (!(await canAccessPatient(req.user, patientId))) {
    throw forbidden('You do not have permission to access these documents.');
  }

  const where = {
    patientId,
    ...(q.status ? { status: { in: q.status.split(',') } } : {}),
    ...(q.documentType ? { documentType: q.documentType } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.medicalDocument.count({ where }),
    prisma.medicalDocument.findMany({
      where,
      include: documentInclude,
      orderBy: { uploadedAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);

  res.json(serialize({ total, page: q.page, pageSize: q.pageSize, items }));
}));

router.get('/:id', wrap(async (req, res) => {
  const document = await loadAccessible(req);
  res.json(serialize(document));
}));

// Raw OCR text — the doctor's "what did the machine actually read?" view.
router.get('/:id/ocr', wrap(async (req, res) => {
  const document = await loadAccessible(req, { withOcr: true });
  if (!document.ocrResult) {
    throw conflict(`OCR has not completed for this document (status: ${document.status}).`);
  }
  await audit(req, AUDIT_ACTIONS.VIEW_DOCUMENT, { entityType: 'MedicalDocument', entityId: document.id, detail: 'ocr text' });
  res.json(serialize({
    documentId: document.id,
    engine: document.ocrResult.engine,
    confidence: document.ocrResult.confidence,
    pageCount: document.ocrResult.pageCount,
    durationMs: document.ocrResult.durationMs,
    extractedText: document.ocrResult.extractedText,
    pages: document.ocrResult.pages ? JSON.parse(document.ocrResult.pages) : [],
  }));
}));

// Structured extraction plus the flat entity list the review screen edits.
router.get('/:id/extraction', wrap(async (req, res) => {
  const document = await loadAccessible(req, { withEntities: true, withOcr: true });
  const live = document.entities.filter((e) => !e.rejected);

  await audit(req, AUDIT_ACTIONS.VIEW_DOCUMENT, { entityType: 'MedicalDocument', entityId: document.id, detail: 'extraction' });

  res.json(serialize({
    documentId: document.id,
    status: document.status,
    documentType: document.documentType,
    typeConfidence: document.typeConfidence,
    failureReason: document.failureReason,
    entityCount: document.entityCount,
    lowConfidence: document.lowConfidence,
    processingMs: document.processingMs,
    thresholds: CONFIDENCE,
    ocr: document.ocrResult
      ? { engine: document.ocrResult.engine, confidence: document.ocrResult.confidence, pageCount: document.ocrResult.pageCount }
      : null,
    structured: toStructured(live),
    entities: document.entities,
  }));
}));

// --- correction ------------------------------------------------------------

// The reviewer fixes what the machine got wrong. Corrections are stored beside
// the original extraction, never over it, so the trail stays intact.
router.put('/:id/extraction', wrap(async (req, res) => {
  const document = await loadAccessible(req, { withEntities: true });
  assertCanVerify(req.user, document);
  if ([DOCUMENT_STATUS.SAVED, DOCUMENT_STATUS.VERIFIED].includes(document.status)) {
    throw conflict('This document has already been verified and can no longer be edited.');
  }

  const data = parse(z.object({
    documentType: z.enum(DOCUMENT_TYPES).optional(),
    entities: z.array(z.object({
      id: z.string(),
      correctedValue: z.string().max(500).nullable().optional(),
      rejected: z.boolean().optional(),
    })).max(500).default([]),
    added: z.array(z.object({
      entityType: z.enum(ENTITY_TYPES),
      entityValue: z.string().min(1).max(500),
      unit: z.string().max(50).optional(),
      groupKey: z.string().max(50).optional(),
    })).max(100).default([]),
  }), req.body);

  const own = new Set(document.entities.map((e) => e.id));
  if (data.entities.some((e) => !own.has(e.id))) {
    throw badRequest('An entity does not belong to this document.');
  }

  await prisma.$transaction([
    ...data.entities.map((e) => prisma.extractedEntity.update({
      where: { id: e.id },
      data: {
        ...(e.correctedValue !== undefined ? { correctedValue: e.correctedValue } : {}),
        ...(e.rejected !== undefined ? { rejected: e.rejected } : {}),
      },
    })),
    ...data.added.map((e) => prisma.extractedEntity.create({
      data: {
        documentId: document.id,
        entityType: e.entityType,
        entityValue: e.entityValue,
        unit: e.unit ?? null,
        groupKey: e.groupKey ?? null,
        // Entered by a person, so it is certain by definition — but still not
        // "verified" until the document as a whole is approved.
        confidence: 1,
        pageNumber: 1,
        sourceText: 'Added during review',
      },
    })),
    ...(data.documentType ? [prisma.medicalDocument.update({
      where: { id: document.id },
      data: { documentType: data.documentType, typeConfidence: 1 },
    })] : []),
  ]);

  const refreshed = await prisma.extractedEntity.findMany({
    where: { documentId: document.id },
    orderBy: [{ groupKey: 'asc' }, { entityType: 'asc' }],
  });
  res.json(serialize({
    documentId: document.id,
    entities: refreshed,
    structured: toStructured(refreshed.filter((e) => !e.rejected)),
  }));
}));

// --- verification ----------------------------------------------------------

// Approval is the only path into the medical record. Rejection keeps the
// document and its text but writes nothing clinical.
router.post('/:id/verify', wrap(async (req, res) => {
  const document = await loadAccessible(req, { withEntities: true });
  assertCanVerify(req.user, document);

  const { decision, remarks } = parse(z.object({
    decision: z.enum(['APPROVE', 'REJECT']),
    remarks: z.string().max(1000).optional(),
  }), req.body);

  if (document.status === DOCUMENT_STATUS.SAVED) throw conflict('This document has already been saved to the medical record.');
  if (decision === 'APPROVE' && !REVIEWABLE_STATUSES.includes(document.status)) {
    throw conflict(
      FAILED_STATUSES.includes(document.status)
        ? 'This document failed processing and has nothing to approve.'
        : `This document is not ready for review yet (status: ${document.status}).`,
    );
  }

  if (decision === 'REJECT') {
    const [, verification] = await prisma.$transaction([
      prisma.medicalDocument.update({
        where: { id: document.id },
        data: { status: DOCUMENT_STATUS.REJECTED },
      }),
      prisma.documentVerification.create({
        data: { documentId: document.id, reviewedById: req.user.id, status: 'REJECTED', remarks },
      }),
    ]);
    await audit(req, AUDIT_ACTIONS.VERIFY_DOCUMENT, { entityType: 'MedicalDocument', entityId: document.id, detail: 'REJECTED' });
    return res.json(serialize({ documentId: document.id, status: DOCUMENT_STATUS.REJECTED, verification }));
  }

  const accepted = document.entities.filter((e) => !e.rejected);
  if (accepted.length === 0) throw badRequest('Nothing has been accepted — approve at least one item or reject the document.');

  const structured = toStructured(accepted);
  const summary = summarise(structured);

  // The single write into the existing medical-record system.
  const [record] = await prisma.$transaction([
    prisma.medicalRecord.create({
      data: {
        patientId: document.patientId,
        recordType: RECORD_TYPE_BY_DOCUMENT[document.documentType] || 'NOTE',
        title: `${document.documentType.replace(/_/g, ' ').toLowerCase()} — ${document.file.originalName}`,
        summary,
        recordedBy: req.user.id,
      },
    }),
    prisma.extractedEntity.updateMany({
      where: { documentId: document.id, rejected: false },
      data: { verified: true },
    }),
    prisma.documentVerification.create({
      data: { documentId: document.id, reviewedById: req.user.id, status: 'APPROVED', remarks },
    }),
  ]);

  const saved = await prisma.medicalDocument.update({
    where: { id: document.id },
    data: { status: DOCUMENT_STATUS.SAVED, medicalRecordId: record.id },
    include: documentInclude,
  });

  await audit(req, AUDIT_ACTIONS.VERIFY_DOCUMENT, {
    entityType: 'MedicalDocument',
    entityId: document.id,
    detail: `APPROVED · ${accepted.length} item(s) → MedicalRecord ${record.id}`,
  });

  // Tell the patient, unless they are the one who just approved it.
  if (req.user.role !== ROLES.PATIENT) {
    await notify(document.patient.user.id, {
      category: 'REPORT',
      title: 'Document added to your records',
      body: `${document.file.originalName} was reviewed and added to your medical records.`,
      link: '/app/documents',
    });
  }

  res.json(serialize({ documentId: document.id, status: saved.status, medicalRecordId: record.id, structured }));
}));

// --- reprocess -------------------------------------------------------------

// Useful after a failure, or once a better engine is available.
router.post('/:id/reprocess', wrap(async (req, res) => {
  const document = await loadAccessible(req);
  assertCanVerify(req.user, document);
  if (document.status === DOCUMENT_STATUS.SAVED) throw conflict('A saved document cannot be reprocessed.');

  await prisma.medicalDocument.update({
    where: { id: document.id },
    data: { status: DOCUMENT_STATUS.PROCESSING, failureReason: null },
  });
  await audit(req, AUDIT_ACTIONS.PROCESS_DOCUMENT, { entityType: 'MedicalDocument', entityId: document.id, detail: 'reprocess' });
  processDocument(document.id).catch((err) => console.error('[documents] reprocess failed:', err.message));

  res.json({ documentId: document.id, status: DOCUMENT_STATUS.PROCESSING });
}));

// --- original file ---------------------------------------------------------

// Streamed through the API so the access check always applies. The upload
// directory is never served statically.
router.get('/:id/file', wrap(async (req, res) => {
  const document = await loadAccessible(req);

  // storedName is read only here, never through the shared include — the
  // on-disk filename is not something any client needs to know.
  const asset = await prisma.fileAsset.findUnique({
    where: { id: document.fileId },
    select: { storedName: true },
  });
  if (!asset) throw notFound('The stored file is missing.');

  const filePath = path.join(UPLOAD_DIR, asset.storedName);
  // storedName is generated server-side, but resolve defensively anyway.
  if (!path.resolve(filePath).startsWith(UPLOAD_DIR)) throw forbidden('Invalid file path.');
  if (!fs.existsSync(filePath)) throw notFound('The stored file is missing.');

  await audit(req, AUDIT_ACTIONS.VIEW_DOCUMENT, { entityType: 'MedicalDocument', entityId: document.id, detail: 'original file' });
  res.setHeader('Content-Type', document.file.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(document.file.originalName)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(filePath).pipe(res);
}));

// --- helpers ---------------------------------------------------------------

const RECORD_TYPE_BY_DOCUMENT = {
  LAB_REPORT: 'LAB',
  RADIOLOGY_REPORT: 'IMAGING',
  DISCHARGE_SUMMARY: 'DISCHARGE',
  PRESCRIPTION: 'CONSULTATION',
  CONSULTATION_NOTE: 'CONSULTATION',
  MEDICAL_CERTIFICATE: 'NOTE',
  OTHER: 'NOTE',
};

// A short human-readable summary for the record timeline. It reports what the
// document said — it does not interpret it.
function summarise(structured) {
  const parts = [];
  if (structured.diagnoses.length) parts.push(`Diagnosis: ${structured.diagnoses.join(', ')}`);
  if (structured.labResults.length) {
    parts.push(`Results: ${structured.labResults
      .map((l) => `${l.test} ${l.value}${l.unit ? ` ${l.unit}` : ''}`).join('; ')}`);
  }
  if (structured.medications.length) {
    parts.push(`Medicines: ${structured.medications
      .map((m) => [m.name, m.dosage, m.frequency].filter(Boolean).join(' ')).join('; ')}`);
  }
  if (structured.procedures.length) parts.push(`Procedures: ${structured.procedures.join(', ')}`);
  if (structured.allergies.length) parts.push(`Allergies: ${structured.allergies.join(', ')}`);
  return parts.join(' · ').slice(0, 2000) || 'Extracted from an uploaded medical document.';
}

export default router;
