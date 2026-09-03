// Image preprocessing ahead of OCR.
//
// Scanned medical documents are photographed on phones: skewed, shadowed, low
// contrast. A few cheap transforms lift recognition noticeably. Each step is a
// named function so the pipeline can be tuned or replaced without touching the
// OCR engine.
//
// sharp is loaded lazily and every failure degrades to the original buffer —
// preprocessing is an optimisation, never a reason for an upload to fail.

let sharpModule;
let sharpUnavailable = false;

async function getSharp() {
  if (sharpUnavailable) return null;
  if (!sharpModule) {
    try {
      sharpModule = (await import('sharp')).default;
    } catch {
      sharpUnavailable = true;
      return null;
    }
  }
  return sharpModule;
}

// Tesseract reads small text badly. Anything narrower than this is scaled up.
const MIN_WIDTH = 1400;
// Beyond this, OCR time grows without accuracy following.
const MAX_WIDTH = 3000;

export const STEPS = ['rotate', 'grayscale', 'resize', 'normalise', 'sharpen', 'threshold'];

/**
 * Returns { buffer, applied[], skipped? }. Never throws.
 *
 * @param {Buffer} input        original image bytes
 * @param {object} options
 * @param {boolean} options.threshold  binarise (helps clean scans, hurts photos
 *                                     with uneven lighting, so it is off by default —
 *                                     Tesseract applies its own Otsu binarisation)
 */
export async function preprocessImage(input, { threshold = false } = {}) {
  const sharp = await getSharp();
  if (!sharp) return { buffer: input, applied: [], skipped: 'sharp is not installed' };

  try {
    const image = sharp(input, { failOn: 'none' });
    const meta = await image.metadata();
    const applied = [];

    // 1. Rotation correction — honours the EXIF orientation a phone camera
    //    writes. True deskew of an arbitrarily rotated scan needs Hough line
    //    detection; that belongs in a later iteration, not here.
    let pipeline = image.rotate();
    applied.push('rotate');

    // 2. Grayscale — colour carries no signal for text recognition.
    pipeline = pipeline.grayscale();
    applied.push('grayscale');

    // 3. Resize so small text has enough pixels to be recognised.
    const width = meta.width || 0;
    if (width && width < MIN_WIDTH) {
      pipeline = pipeline.resize({ width: MIN_WIDTH, withoutEnlargement: false });
      applied.push('resize:up');
    } else if (width > MAX_WIDTH) {
      pipeline = pipeline.resize({ width: MAX_WIDTH });
      applied.push('resize:down');
    }

    // 4. Contrast enhancement — stretches the histogram so faded print separates
    //    from the paper.
    pipeline = pipeline.normalise();
    applied.push('normalise');

    // 5. Mild sharpening recovers edges softened by the resize.
    pipeline = pipeline.sharpen();
    applied.push('sharpen');

    // 6. Optional binarisation for clean scans.
    if (threshold) {
      pipeline = pipeline.threshold(140);
      applied.push('threshold');
    }

    return { buffer: await pipeline.png().toBuffer(), applied };
  } catch (err) {
    // A corrupt or exotic image still gets a chance at raw OCR.
    return { buffer: input, applied: [], skipped: err.message };
  }
}

export async function preprocessingAvailable() {
  return Boolean(await getSharp());
}
