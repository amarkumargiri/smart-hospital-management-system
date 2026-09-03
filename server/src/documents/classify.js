// Text cleaning and document classification.
//
// Classification is keyword scoring, not a model. Medical documents announce
// themselves — a lab report says "reference range", a prescription says "Rx" and
// "twice daily" — and on that signal a scored rule set is more accurate and far
// more debuggable than a classifier trained on a handful of samples.
//
// The contract (text in, { type, confidence, scores } out) is what a trained
// classifier would also satisfy, so swapping one in later touches this file only.

// OCR routinely confuses these. Fixing them before extraction improves both
// classification and entity matching.
const OCR_FIXES = [
  [/\bl\/dL\b/gi, 'g/dL'],
  [/\bm9\b/g, 'mg'],
  [/\brng\b/gi, 'mg'],
  [/\bO(?=\d)/g, '0'],
  [/(?<=\d)O\b/g, '0'],
  [/\bl(?=\d)/g, '1'],
];

/** Normalises whitespace and repairs common OCR confusions. */
export function cleanText(raw) {
  if (!raw) return '';
  let text = String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ')
    // Tesseract emits stray pipes and underscores for table rules.
    .replace(/[|_]{2,}/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');

  for (const [pattern, replacement] of OCR_FIXES) text = text.replace(pattern, replacement);

  return text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

export function toLines(text) {
  return cleanText(text).split('\n').map((l) => l.trim()).filter(Boolean);
}

// Weighted signals. A phrase that only ever appears in one kind of document
// scores higher than a word that could appear anywhere.
const SIGNALS = {
  LAB_REPORT: [
    [/reference\s*(range|interval|value)/i, 5],
    [/\b(haematology|hematology|biochemistry|pathology)\b/i, 4],
    [/\bspecimen\b|\bsample\s*(id|type|collected)/i, 3],
    [/\b(haemoglobin|hemoglobin|hb|wbc|rbc|platelet|creatinine|bilirubin|tsh)\b/i, 3],
    [/\b(g\/dL|mg\/dL|mmol\/L|IU\/L|cells\/[uµ]L|\/[uµ]L)\b/i, 3],
    [/\btest\s*(name|result)?\b.*\bresult\b/i, 3],
    [/\bnormal\b|\babnormal\b|\bhigh\b|\blow\b/i, 1],
  ],
  PRESCRIPTION: [
    [/\bRx\b/, 5],
    [/\b(tab|tablet|cap|capsule|syp|syrup|inj|injection)\.?\s+[A-Z]/i, 4],
    [/\b(once|twice|thrice|[1-4]\s*times?)\s*(a|per)?\s*day\b|\b[bt]\.?i\.?d\.?\b|\bo\.?d\.?\b|\bq\.?d\.?s\.?\b/i, 4],
    [/\bfor\s+\d+\s*(day|week|month)s?\b/i, 3],
    [/\b(after|before)\s+(food|meals?)\b/i, 3],
    [/\bprescription\b/i, 3],
    [/\brefill\b|\bdispense\b/i, 2],
  ],
  DISCHARGE_SUMMARY: [
    [/\bdischarge\s*(summary|advice|instructions?)\b/i, 6],
    [/\bdate\s*of\s*(admission|discharge)\b/i, 5],
    [/\bcourse\s*in\s*(the\s*)?hospital\b/i, 5],
    [/\badmitted\s+on\b/i, 3],
    [/\bfollow[\s-]*up\b/i, 2],
    [/\bcondition\s+at\s+discharge\b/i, 4],
  ],
  MEDICAL_CERTIFICATE: [
    [/\bmedical\s*(certificate|fitness)\b/i, 6],
    [/\bfit\s+to\s+(resume|join|work)\b/i, 5],
    [/\bthis\s+is\s+to\s+certify\b/i, 5],
    [/\bsick\s*leave\b|\brest\s+for\b/i, 3],
  ],
  RADIOLOGY_REPORT: [
    [/\b(x-?ray|ct\s*scan|mri|ultrasound|sonography|usg|doppler)\b/i, 5],
    [/\bimpression\s*:/i, 4],
    [/\bfindings\s*:/i, 3],
    [/\bcontrast\b|\bradiolog(y|ist)\b/i, 3],
    [/\bno\s+(significant\s+)?abnormality\s+detected\b/i, 3],
  ],
  CONSULTATION_NOTE: [
    [/\bchief\s+complaints?\b/i, 5],
    [/\bconsultation\s*(note|record)\b/i, 5],
    [/\bo\/e\b|\bon\s+examination\b/i, 4],
    [/\bhistory\s+of\s+present(ing)?\s+illness\b/i, 4],
    [/\btreatment\s+plan\b/i, 3],
    [/\bvitals?\b.*\b(bp|pulse|temp)\b/i, 3],
  ],
};

/**
 * @returns {{ type: string, confidence: number, scores: object }}
 */
export function classifyDocument(text) {
  const clean = cleanText(text);
  const scores = {};
  let best = { type: 'OTHER', score: 0 };

  for (const [type, signals] of Object.entries(SIGNALS)) {
    let score = 0;
    for (const [pattern, weight] of signals) if (pattern.test(clean)) score += weight;
    scores[type] = score;
    if (score > best.score) best = { type, score };
  }

  // Nothing matched strongly enough to name the document.
  if (best.score < 4) return { type: 'OTHER', confidence: 0.3, scores };

  // Confidence reflects both how much evidence there is and how clearly the
  // winner beat the runner-up. A document scoring 12 against a 10 is a coin
  // flip and should not be presented as certain.
  const sorted = Object.values(scores).sort((a, b) => b - a);
  const margin = sorted[0] - (sorted[1] || 0);
  const evidence = Math.min(1, best.score / 12);
  const separation = Math.min(1, margin / 6);
  const confidence = Math.round((0.45 * evidence + 0.55 * separation) * 100) / 100;

  return { type: best.type, confidence: Math.max(0.35, confidence), scores };
}
