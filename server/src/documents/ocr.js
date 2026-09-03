// OCR layer.
//
// Two engines, picked by what the file actually is:
//
//   PDF with a text layer  → pdfjs-dist reads the text directly. Digitally
//                            generated lab reports and discharge summaries are
//                            this case, and the text is exact rather than guessed.
//   Image                  → tesseract.js (WASM). No system binary, no second
//                            runtime — the same reasoning that kept forecasting
//                            inside this process.
//   Scanned PDF (no text)  → needs rasterising to images first. `pdftoppm` is
//                            used when present on PATH; when it is not, the
//                            document fails with an actionable message rather
//                            than silently returning nothing.
//
// Everything returns { ok, engine, text, pages[], confidence, durationMs } and
// nothing throws past the caller — an OCR failure is a document status, not a
// 500.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { preprocessImage } from './preprocess.js';

const execFileAsync = promisify(execFile);

export const ENGINES = { TESSERACT: 'TESSERACT_JS', PDF_TEXT: 'PDF_TEXT_LAYER' };

// Below this, whatever came back is noise rather than a document.
const MIN_USEFUL_CHARS = 12;
const PDF_TEXT_MIN_CHARS_PER_PAGE = 20;

// One worker is created on first use and reused. Spinning a WASM worker per
// upload costs about a second each time.
let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      return createWorker('eng', 1, {
        // Keep the language data beside the app so a second run works offline.
        cachePath: path.resolve(process.env.TESSDATA_DIR || './tessdata'),
        logger: () => {}, // never log document contents
      });
    })();
  }
  return workerPromise;
}

export async function shutdownOcr() {
  if (!workerPromise) return;
  const worker = await workerPromise.catch(() => null);
  workerPromise = null;
  if (worker) await worker.terminate().catch(() => {});
}

// --- images ----------------------------------------------------------------

async function recogniseImage(buffer, pageNumber = 1) {
  const { buffer: prepared, applied } = await preprocessImage(buffer);
  const worker = await getWorker();
  const { data } = await worker.recognize(prepared);

  // Tesseract reports confidence 0-100 per word; the page mean is the honest
  // summary of how much to trust this text.
  return {
    page: pageNumber,
    text: (data.text || '').trim(),
    confidence: Math.max(0, Math.min(1, (data.confidence || 0) / 100)),
    preprocessing: applied,
  };
}

// --- PDFs ------------------------------------------------------------------

async function readPdfTextLayer(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // Node has no DOM; these keep pdfjs from reaching for browser APIs.
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
  }).promise;

  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    // Items carry position; joining with spaces and breaking on end-of-line
    // markers preserves enough structure for line-based extraction.
    const text = content.items
      .map((item) => (item.hasEOL ? `${item.str}\n` : item.str))
      .join(' ')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
    // A text layer is exact, not recognised, so confidence is 1 where text exists.
    pages.push({ page: n, text, confidence: text.length >= PDF_TEXT_MIN_CHARS_PER_PAGE ? 1 : 0 });
  }
  await doc.destroy();
  return pages;
}

// Scanned PDFs carry no text layer. poppler's pdftoppm is the lightest way to
// turn them into page images; it is optional and absence is reported clearly.
async function rasterisePdf(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'medocr-'));
  const pdfPath = path.join(dir, 'in.pdf');
  try {
    await fs.writeFile(pdfPath, buffer);
    await execFileAsync('pdftoppm', ['-png', '-r', '200', pdfPath, path.join(dir, 'page')], {
      timeout: 120_000,
    });
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.png')).sort();
    return await Promise.all(files.map((f) => fs.readFile(path.join(dir, f))));
  } catch (err) {
    if (err.code === 'ENOENT') return null; // pdftoppm not installed
    throw err;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function processPdf(buffer) {
  let pages = [];
  try {
    pages = await readPdfTextLayer(buffer);
  } catch (err) {
    return { ok: false, reason: `The PDF could not be opened (${err.message}).`, pageCount: 0 };
  }

  const textChars = pages.reduce((sum, p) => sum + p.text.length, 0);
  if (textChars >= MIN_USEFUL_CHARS) {
    return {
      ok: true,
      engine: ENGINES.PDF_TEXT,
      pages,
      confidence: pages.length ? pages.reduce((s, p) => s + p.confidence, 0) / pages.length : 0,
    };
  }

  // No usable text layer — this is a scan.
  const images = await rasterisePdf(buffer).catch(() => null);
  if (!images) {
    return {
      ok: false,
      pageCount: pages.length,
      reason:
        'This PDF contains no text layer, so it is a scan. Scanned PDFs need page rasterisation, '
        + 'which is not available on this server. Please upload the pages as JPG or PNG images instead.',
    };
  }

  const recognised = [];
  for (const [i, image] of images.entries()) {
    recognised.push(await recogniseImage(image, i + 1));
  }
  return {
    ok: true,
    engine: ENGINES.TESSERACT,
    pages: recognised,
    confidence: recognised.reduce((s, p) => s + p.confidence, 0) / (recognised.length || 1),
  };
}

// --- entry point -----------------------------------------------------------

/**
 * @param {Buffer} buffer   file bytes
 * @param {string} mimeType validated upstream against DOCUMENT_MIME_TYPES
 */
export async function runOcr(buffer, mimeType) {
  const started = Date.now();

  try {
    const result = mimeType === 'application/pdf'
      ? await processPdf(buffer)
      : {
        ok: true,
        engine: ENGINES.TESSERACT,
        pages: [await recogniseImage(buffer, 1)],
      };

    if (!result.ok) {
      return { ok: false, reason: result.reason, pageCount: result.pageCount || 0, durationMs: Date.now() - started };
    }

    const pages = result.pages;
    const text = pages.map((p) => p.text).join('\n\n').trim();

    if (text.replace(/\s/g, '').length < MIN_USEFUL_CHARS) {
      return {
        ok: false,
        reason: 'We could not extract readable text from this document. Please upload a clearer document.',
        pageCount: pages.length,
        durationMs: Date.now() - started,
      };
    }

    const confidence = result.confidence
      ?? pages.reduce((s, p) => s + p.confidence, 0) / (pages.length || 1);

    return {
      ok: true,
      engine: result.engine,
      text,
      pages,
      pageCount: pages.length,
      confidence: Math.round(confidence * 1000) / 1000,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    // Log the failure, never the document contents.
    console.error('[ocr] failed:', err.message);
    return {
      ok: false,
      reason: 'The document could not be processed. Please try again or upload a different file.',
      pageCount: 0,
      durationMs: Date.now() - started,
    };
  }
}
