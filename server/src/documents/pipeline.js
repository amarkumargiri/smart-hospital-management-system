// Document processing pipeline.
//
//   UPLOADED → PROCESSING → OCR_COMPLETED → NLP_COMPLETED → REVIEW_REQUIRED
//                    ↓            ↓              ↓
//              PROCESSING_FAILED  OCR_FAILED   NLP_FAILED
//
// Nothing here writes to the medical record. The pipeline's job ends at
// REVIEW_REQUIRED; a human moves it to VERIFIED and SAVED (see routes/documents.js).
//
// Runs in-process. OCR takes a couple of seconds per page, so the upload route
// starts it in the background and the client polls status — a queue would be a
// second piece of infrastructure for work that is already short.

import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db.js';
import { CONFIDENCE, DOCUMENT_STATUS } from '../constants.js';
import { classifyDocument, cleanText } from './classify.js';
import { extractEntities } from './extract.js';
import { runOcr } from './ocr.js';

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');

async function setStatus(documentId, status, extra = {}) {
  return prisma.medicalDocument.update({ where: { id: documentId }, data: { status, ...extra } });
}

// Processing metadata only — never document contents.
function logRun(documentId, fields) {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`[documents] id=${documentId} ${parts}`);
}

/**
 * Runs OCR → classification → extraction for one document and records the
 * result. Never throws: every failure becomes a status the UI can explain.
 */
export async function processDocument(documentId) {
  const started = Date.now();

  const document = await prisma.medicalDocument.findUnique({
    where: { id: documentId },
    include: { file: true },
  });
  if (!document) return { ok: false, reason: 'Document not found.' };

  try {
    await setStatus(documentId, DOCUMENT_STATUS.PROCESSING);

    // --- read the stored file -------------------------------------------
    let buffer;
    try {
      buffer = await fs.readFile(path.join(UPLOAD_DIR, document.file.storedName));
    } catch {
      await setStatus(documentId, DOCUMENT_STATUS.PROCESSING_FAILED, {
        failureReason: 'The stored file could not be read.',
        processedAt: new Date(),
      });
      logRun(documentId, { stage: 'read', ok: false });
      return { ok: false, reason: 'The stored file could not be read.' };
    }

    // --- OCR --------------------------------------------------------------
    const ocr = await runOcr(buffer, document.file.mimeType);
    if (!ocr.ok) {
      await setStatus(documentId, DOCUMENT_STATUS.OCR_FAILED, {
        failureReason: ocr.reason,
        pageCount: ocr.pageCount || 0,
        processingMs: Date.now() - started,
        processedAt: new Date(),
      });
      logRun(documentId, { stage: 'ocr', ok: false, ms: ocr.durationMs });
      return { ok: false, status: DOCUMENT_STATUS.OCR_FAILED, reason: ocr.reason };
    }

    const text = cleanText(ocr.text);
    await prisma.ocrResult.upsert({
      where: { documentId },
      create: {
        documentId,
        extractedText: text,
        pages: JSON.stringify(ocr.pages.map((p) => ({ page: p.page, text: p.text, confidence: p.confidence }))),
        engine: ocr.engine,
        confidence: ocr.confidence,
        pageCount: ocr.pageCount,
        durationMs: ocr.durationMs,
      },
      update: {
        extractedText: text,
        pages: JSON.stringify(ocr.pages.map((p) => ({ page: p.page, text: p.text, confidence: p.confidence }))),
        engine: ocr.engine,
        confidence: ocr.confidence,
        pageCount: ocr.pageCount,
        durationMs: ocr.durationMs,
      },
    });
    await setStatus(documentId, DOCUMENT_STATUS.OCR_COMPLETED, { pageCount: ocr.pageCount });

    // --- classification + extraction -------------------------------------
    let classification;
    let entities = [];
    try {
      classification = classifyDocument(text);
      ({ entities } = extractEntities(text, {
        documentType: classification.type,
        ocrConfidence: ocr.confidence,
        pages: ocr.pages,
      }));
    } catch (err) {
      console.error('[documents] extraction failed:', err.message);
      await setStatus(documentId, DOCUMENT_STATUS.NLP_FAILED, {
        failureReason: 'Document text was extracted, but medical information could not be automatically structured.',
        processingMs: Date.now() - started,
        processedAt: new Date(),
      });
      logRun(documentId, { stage: 'nlp', ok: false });
      return { ok: false, status: DOCUMENT_STATUS.NLP_FAILED };
    }

    // Text came out but nothing recognisable was in it. That is a partial
    // success: the reader still gets the text, just no structure.
    if (entities.length === 0) {
      await setStatus(documentId, DOCUMENT_STATUS.NLP_FAILED, {
        documentType: classification.type,
        typeConfidence: classification.confidence,
        failureReason: 'Document text was extracted, but medical information could not be automatically structured.',
        processingMs: Date.now() - started,
        processedAt: new Date(),
      });
      logRun(documentId, { stage: 'nlp', ok: true, entities: 0, type: classification.type });
      return { ok: false, status: DOCUMENT_STATUS.NLP_FAILED, text };
    }

    await prisma.extractedEntity.deleteMany({ where: { documentId } }); // reprocessing replaces
    await prisma.extractedEntity.createMany({
      data: entities.map((e) => ({
        documentId,
        entityType: e.entityType,
        entityValue: String(e.entityValue).slice(0, 500),
        unit: e.unit ?? null,
        referenceRange: e.referenceRange ?? null,
        flag: e.flag ?? null,
        confidence: e.confidence,
        pageNumber: e.pageNumber || 1,
        sourceText: e.sourceText ? String(e.sourceText).slice(0, 500) : null,
        groupKey: e.groupKey ?? null,
      })),
    });

    const lowConfidence = entities.filter((e) => e.confidence < CONFIDENCE.AUTO).length;
    const processingMs = Date.now() - started;

    // Always REVIEW_REQUIRED. Even an extraction where every field is confident
    // is a machine's reading of a medical document, and a human confirms it
    // before it becomes part of the record.
    await setStatus(documentId, DOCUMENT_STATUS.REVIEW_REQUIRED, {
      documentType: classification.type,
      typeConfidence: classification.confidence,
      entityCount: entities.length,
      lowConfidence,
      processingMs,
      processedAt: new Date(),
      failureReason: null,
    });

    logRun(documentId, {
      stage: 'done', ok: true, type: classification.type,
      pages: ocr.pageCount, entities: entities.length, low: lowConfidence,
      engine: ocr.engine, ms: processingMs,
    });

    return { ok: true, status: DOCUMENT_STATUS.REVIEW_REQUIRED, entityCount: entities.length, processingMs };
  } catch (err) {
    console.error('[documents] pipeline failed:', err.message);
    await setStatus(documentId, DOCUMENT_STATUS.PROCESSING_FAILED, {
      failureReason: 'The document could not be processed.',
      processingMs: Date.now() - started,
      processedAt: new Date(),
    }).catch(() => {});
    return { ok: false, status: DOCUMENT_STATUS.PROCESSING_FAILED };
  }
}
