// Medical entity extraction.
//
// This is deterministic pattern + lexicon extraction, not a trained model, and
// that is a deliberate choice. Medical documents are semi-structured: a lab line
// is "<test> <value> <unit> <range>", a prescription line is "<form> <drug>
// <dose> <frequency> <duration>". Rules read that structure exactly, explain
// themselves when they are wrong, and need no training data. A general-purpose
// English NER would do worse here and could not say why.
//
// The seam for an upgrade is the return shape: any extractor producing
// { entityType, entityValue, confidence, sourceText, ... } can be added to or
// replace these without the pipeline or the UI changing.
//
// SAFETY: this module reports what the document says. It never infers a
// diagnosis, never decides whether a value is abnormal unless the document
// states it, and never marks anything as verified — that is a human's job.

import { cleanText, toLines } from './classify.js';

// --- lexicons --------------------------------------------------------------

// Common generics seen on Indian prescriptions. A hit raises confidence; a miss
// does not block extraction, because brand names are endless.
const MEDICINES = [
  'paracetamol', 'acetaminophen', 'ibuprofen', 'diclofenac', 'aceclofenac', 'aspirin',
  'amoxicillin', 'augmentin', 'azithromycin', 'cefixime', 'ceftriaxone', 'cephalexin',
  'ciprofloxacin', 'levofloxacin', 'doxycycline', 'metronidazole', 'ofloxacin',
  'metformin', 'glimepiride', 'insulin', 'sitagliptin',
  'amlodipine', 'telmisartan', 'losartan', 'atenolol', 'metoprolol', 'ramipril',
  'atorvastatin', 'rosuvastatin', 'clopidogrel',
  'pantoprazole', 'omeprazole', 'rabeprazole', 'ranitidine', 'domperidone', 'ondansetron',
  'cetirizine', 'levocetirizine', 'montelukast', 'salbutamol', 'budesonide', 'theophylline',
  'prednisolone', 'dexamethasone', 'hydrocortisone',
  'levothyroxine', 'thyroxine', 'folic acid', 'ferrous sulphate', 'ferrous ascorbate',
  'calcium', 'vitamin d3', 'cholecalciferol', 'vitamin b12', 'methylcobalamin',
  'tramadol', 'gabapentin', 'pregabalin', 'amitriptyline', 'alprazolam',
  'furosemide', 'spironolactone', 'warfarin', 'heparin', 'enoxaparin',
];

const LAB_TESTS = [
  'haemoglobin', 'hemoglobin', 'hb', 'hct', 'haematocrit', 'hematocrit',
  'wbc', 'white blood cell', 'total leucocyte count', 'tlc', 'rbc', 'red blood cell',
  'platelet', 'platelet count', 'mcv', 'mch', 'mchc', 'rdw', 'esr',
  'neutrophils', 'lymphocytes', 'monocytes', 'eosinophils', 'basophils',
  'glucose', 'fasting blood sugar', 'fbs', 'random blood sugar', 'rbs', 'hba1c',
  'urea', 'blood urea nitrogen', 'bun', 'creatinine', 'uric acid',
  'sodium', 'potassium', 'chloride', 'calcium', 'phosphorus', 'magnesium',
  'bilirubin', 'total bilirubin', 'direct bilirubin', 'sgot', 'sgpt', 'ast', 'alt',
  'alkaline phosphatase', 'alp', 'total protein', 'albumin', 'globulin',
  'cholesterol', 'total cholesterol', 'hdl', 'ldl', 'vldl', 'triglycerides',
  'tsh', 't3', 't4', 'ft3', 'ft4',
  'crp', 'c-reactive protein', 'vitamin d', 'vitamin b12', 'ferritin', 'iron',
  'inr', 'pt', 'aptt', 'd-dimer', 'troponin',
];

const UNITS = [
  'g/dL', 'mg/dL', 'g/L', 'mg/L', 'ng/mL', 'pg/mL', 'µg/dL', 'ug/dL',
  'mmol/L', 'µmol/L', 'umol/L', 'mEq/L', 'IU/L', 'U/L', 'mIU/L', 'µIU/mL', 'uIU/mL',
  'cells/µL', 'cells/uL', '/µL', '/uL', '/cumm', 'lakhs/µL', 'million/µL',
  'fL', 'pg', '%', 'mm/hr', 'sec', 'ratio',
];

const SYMPTOMS = [
  'fever', 'cough', 'cold', 'headache', 'body ache', 'bodyache', 'fatigue', 'weakness',
  'vomiting', 'nausea', 'diarrhoea', 'diarrhea', 'constipation', 'abdominal pain',
  'chest pain', 'breathlessness', 'shortness of breath', 'dyspnoea', 'palpitations',
  'dizziness', 'giddiness', 'swelling', 'rash', 'itching', 'joint pain', 'back pain',
  'loss of appetite', 'weight loss', 'night sweats', 'sore throat', 'runny nose',
];

const CONDITIONS = [
  'diabetes', 'diabetes mellitus', 'type 2 diabetes', 'hypertension', 'asthma',
  'copd', 'tuberculosis', 'anaemia', 'anemia', 'hypothyroidism', 'hyperthyroidism',
  'coronary artery disease', 'ischaemic heart disease', 'chronic kidney disease',
  'dyslipidaemia', 'dyslipidemia', 'obesity', 'epilepsy', 'migraine', 'arthritis',
];

const ROUTE_BY_FORM = {
  tab: 'ORAL', tablet: 'ORAL', cap: 'ORAL', capsule: 'ORAL',
  syp: 'ORAL', syrup: 'ORAL', susp: 'ORAL', suspension: 'ORAL', drops: 'ORAL',
  inj: 'IV', injection: 'IV', iv: 'IV', im: 'IM',
  oint: 'TOPICAL', ointment: 'TOPICAL', cream: 'TOPICAL', gel: 'TOPICAL',
  inhaler: 'INHALED', puff: 'INHALED', neb: 'INHALED', nebulisation: 'INHALED',
};

// --- helpers ---------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UNIT_RE = new RegExp(`(?:${UNITS.map(escapeRe).join('|')})`, 'i');
const MEDICINE_RE = new RegExp(`\\b(${MEDICINES.map(escapeRe).join('|')})\\b`, 'i');
const LAB_TEST_RE = new RegExp(`^\\s*(${LAB_TESTS.map(escapeRe).join('|')})\\b`, 'i');

const titleCase = (s) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

/**
 * Confidence for one extraction.
 *
 * Two independent things can go wrong: the OCR may have misread the characters,
 * and the rule may have matched the wrong thing. Both are folded in, and the
 * result is capped below 1 because a rule is never certain.
 */
function score({ pattern, lexicon = false, ocr = 1 }) {
  const ocrFactor = 0.55 + 0.45 * Math.max(0, Math.min(1, ocr)); // OCR never zeroes a match
  const raw = pattern * (lexicon ? 1.08 : 1) * ocrFactor;
  return Math.round(Math.max(0.3, Math.min(0.99, raw)) * 100) / 100;
}

function pageOf(pages, line) {
  if (!pages?.length) return 1;
  const hit = pages.find((p) => p.text && p.text.includes(line));
  return hit ? hit.page : 1;
}

function ocrConfidenceFor(pages, pageNumber, fallback) {
  const page = pages?.find((p) => p.page === pageNumber);
  return page?.confidence ?? fallback ?? 1;
}

// --- labelled fields -------------------------------------------------------

// "Label: value" is the most reliable shape in a medical document.
const LABELLED_FIELDS = [
  { type: 'PATIENT_NAME', labels: ['patient name', 'name of patient', 'patient', "patient's name", 'pt name'], weight: 0.94 },
  { type: 'PATIENT_NAME', labels: ['name'], weight: 0.72 }, // bare "Name" may be the doctor's
  { type: 'PATIENT_ID', labels: ['patient id', 'uhid', 'mrn', 'hospital no', 'reg no', 'registration no', 'ip no', 'op no'], weight: 0.93 },
  { type: 'PATIENT_AGE', labels: ['age'], weight: 0.93 },
  { type: 'PATIENT_GENDER', labels: ['sex', 'gender'], weight: 0.93 },
  { type: 'DOCTOR_NAME', labels: ['doctor', 'consultant', 'referred by', 'referring doctor', 'attending physician', 'physician'], weight: 0.9 },
  { type: 'DEPARTMENT', labels: ['department', 'dept', 'speciality', 'specialty', 'unit'], weight: 0.88 },
  { type: 'HOSPITAL_NAME', labels: ['hospital', 'clinic', 'centre', 'center', 'laboratory', 'lab'], weight: 0.7 },
  { type: 'REPORT_DATE', labels: ['report date', 'date of report', 'reported on', 'collected on', 'sample date', 'date'], weight: 0.85 },
  { type: 'PRESCRIPTION_DATE', labels: ['prescription date', 'date of prescription', 'rx date'], weight: 0.92 },
  { type: 'FOLLOW_UP_DATE', labels: ['follow up', 'follow-up', 'followup', 'review on', 'next visit', 'revisit'], weight: 0.9 },
  { type: 'DIAGNOSIS', labels: ['diagnosis', 'provisional diagnosis', 'final diagnosis', 'clinical diagnosis', 'impression'], weight: 0.94 },
  { type: 'SYMPTOM', labels: ['chief complaint', 'chief complaints', 'complaints', 'presenting complaint', 'c/o'], weight: 0.9 },
  { type: 'ALLERGY', labels: ['allergy', 'allergies', 'known allergies', 'drug allergy'], weight: 0.94 },
  { type: 'PROCEDURE', labels: ['procedure', 'procedures', 'operation', 'surgery performed'], weight: 0.92 },
  { type: 'TREATMENT', labels: ['treatment', 'treatment given', 'management', 'advice', 'plan'], weight: 0.85 },
  { type: 'CONDITION', labels: ['known case of', 'k/c/o', 'past history', 'comorbidities'], weight: 0.9 },
];

// Values that are a list get split; a free-text plan does not.
const SPLITTABLE = new Set(['DIAGNOSIS', 'SYMPTOM', 'ALLERGY', 'PROCEDURE', 'CONDITION']);

function extractLabelled(lines, pages, ocrFallback) {
  const found = [];
  const seen = new Set();

  for (const line of lines) {
    for (const field of LABELLED_FIELDS) {
      for (const label of field.labels) {
        const re = new RegExp(`^\\s*${escapeRe(label)}\\s*[:\\-]\\s*(.+)$`, 'i');
        const m = line.match(re);
        if (!m) continue;

        let value = m[1].trim().replace(/[.;,]$/, '');
        if (!value || value.length > 200) continue;
        // "Age/Sex: 34/M" style combined fields are handled by their own rules.
        if (/^[-–—]+$/.test(value)) continue;

        const pageNumber = pageOf(pages, line);
        const ocr = ocrConfidenceFor(pages, pageNumber, ocrFallback);

        const values = SPLITTABLE.has(field.type)
          ? value.split(/\s*[,;]\s*|\s+\d+[.)]\s+/).map((v) => v.trim()).filter((v) => v.length > 1)
          : [value];

        for (const v of values) {
          const key = `${field.type}:${v.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          found.push({
            entityType: field.type,
            entityValue: v,
            confidence: score({ pattern: field.weight, ocr }),
            pageNumber,
            sourceText: line,
          });
        }
        break; // first matching label for this field wins
      }
    }
  }
  return found;
}

// "Age/Sex: 34/M" and "34 Y / F" — one line carrying two fields.
function extractAgeSex(lines, pages, ocrFallback) {
  const found = [];
  for (const line of lines) {
    const m = line.match(/\b(?:age\s*\/\s*sex|sex\s*\/\s*age)\s*[:\-]?\s*(\d{1,3})\s*(?:y(?:rs?|ears?)?)?\s*[/\\]\s*([mf]|male|female)\b/i)
      || line.match(/\b(\d{1,3})\s*(?:y(?:rs?|ears?)?)\s*[/\\]\s*([mf]|male|female)\b/i);
    if (!m) continue;
    const pageNumber = pageOf(pages, line);
    const ocr = ocrConfidenceFor(pages, pageNumber, ocrFallback);
    found.push({ entityType: 'PATIENT_AGE', entityValue: m[1], confidence: score({ pattern: 0.92, ocr }), pageNumber, sourceText: line });
    const g = m[2].toLowerCase();
    found.push({
      entityType: 'PATIENT_GENDER',
      entityValue: g.startsWith('m') ? 'MALE' : 'FEMALE',
      confidence: score({ pattern: 0.92, ocr }),
      pageNumber,
      sourceText: line,
    });
  }
  return found;
}

// --- medications -----------------------------------------------------------

const FORM_RE = /\b(tab|tablet|cap|capsule|syp|syrup|susp|suspension|inj|injection|oint|ointment|cream|gel|drops|inhaler|neb|nebulisation|puff)\b\.?/i;
const DOSAGE_RE = /\b(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ug|g|ml|l|iu|units?|%)\b/i;
const DURATION_RE = /\b(?:for|x|×)\s*(\d+)\s*(day|days|week|weeks|month|months)\b|\b(\d+)\s*(day|days|week|weeks|month|months)\b/i;
const INSTRUCTION_RE = /\b(after\s+(?:food|meals?)|before\s+(?:food|meals?)|with\s+(?:food|meals?|water|milk)|empty\s+stomach|at\s+bed\s*time|bedtime|h\/s|sos|as\s+(?:needed|required)|prn)\b/i;

// "day" and "daily" are both written; matching only \bday\b silently misses
// "twice daily", which is how most prescriptions are actually worded.
const DAILY = '(?:day|daily)';
const FREQUENCY_PATTERNS = [
  [new RegExp(`\\b(?:four\\s*times|4\\s*times)\\s*(?:a|per)?\\s*${DAILY}\\b|\\bq\\.?i\\.?d\\.?(?!\\w)|\\bq\\.?d\\.?s\\.?(?!\\w)`, 'i'), 'four times daily'],
  [new RegExp(`\\b(?:thrice|three\\s*times|3\\s*times)\\s*(?:a|per)?\\s*${DAILY}\\b|\\bt\\.?d\\.?s\\.?(?!\\w)|\\bt\\.?i\\.?d\\.?(?!\\w)`, 'i'), 'three times daily'],
  [new RegExp(`\\b(?:twice|2)\\s*(?:a|per)?\\s*${DAILY}\\b|\\bb\\.?i\\.?d\\.?(?!\\w)|\\bb\\.?d\\.?(?!\\w)`, 'i'), 'twice daily'],
  [new RegExp(`\\b(?:once|1)\\s*(?:a|per)?\\s*${DAILY}\\b|\\bo\\.?d\\.?(?!\\w)|\\bq\\.?d\\.?(?!\\w)`, 'i'), 'once daily'],
  [/\b(?:every|q)\s*(\d+)\s*(?:hours?|hrs?|h)\b/i, null], // keep the literal text
  [/\bweekly\b|\bonce\s*a\s*week\b/i, 'weekly'],
  [/\balternate\s*days?\b|\bevery\s*other\s*day\b/i, 'alternate days'],
];

// "1-0-1" and "1-1-1" are the Indian shorthand for morning-noon-night.
const DOSE_PATTERN_RE = /\b([01](?:\.5)?)\s*-\s*([01](?:\.5)?)\s*-\s*([01](?:\.5)?)\b/;

function frequencyFrom(line) {
  for (const [re, label] of FREQUENCY_PATTERNS) {
    const m = line.match(re);
    if (m) return { value: label || m[0].trim(), weight: 0.9 };
  }
  const pattern = line.match(DOSE_PATTERN_RE);
  if (pattern) {
    const times = [pattern[1], pattern[2], pattern[3]].filter((x) => Number(x) > 0).length;
    return { value: `${times} time(s) daily (${pattern[0]})`, weight: 0.86 };
  }
  return null;
}

function extractMedications(lines, pages, ocrFallback) {
  const found = [];
  let index = 0;

  for (const line of lines) {
    const formMatch = line.match(FORM_RE);
    const medMatch = line.match(MEDICINE_RE);
    const dosage = line.match(DOSAGE_RE);

    // A medication line needs a drug identity: a dosage form prefix, a known
    // generic, or a capitalised word immediately followed by a dose.
    let name = null;
    let nameWeight = 0;
    let lexicon = false;

    if (medMatch) {
      name = titleCase(medMatch[1]);
      nameWeight = 0.95;
      lexicon = true;
    } else if (formMatch) {
      const after = line.slice(formMatch.index + formMatch[0].length).trim();
      const candidate = after.match(/^([A-Za-z][A-Za-z0-9'’\-]*(?:\s+[A-Z][A-Za-z0-9'’\-]*)?)/);
      if (candidate && candidate[1].length > 2) {
        name = titleCase(candidate[1].trim());
        nameWeight = 0.82;
      }
    } else if (dosage) {
      const before = line.slice(0, dosage.index).trim();
      const candidate = before.match(/([A-Z][A-Za-z0-9'’\-]{2,}(?:\s+[A-Z][A-Za-z0-9'’\-]+)?)\s*$/);
      if (candidate) {
        name = titleCase(candidate[1].trim());
        nameWeight = 0.62; // could easily be a lab test name
      }
    }

    if (!name) continue;
    // A line that reads like a lab result is not a prescription line.
    if (LAB_TEST_RE.test(line) && !medMatch) continue;

    const pageNumber = pageOf(pages, line);
    const ocr = ocrConfidenceFor(pages, pageNumber, ocrFallback);
    const groupKey = `med:${index++}`;
    const push = (entityType, entityValue, weight) => found.push({
      entityType, entityValue, groupKey, pageNumber, sourceText: line,
      confidence: score({ pattern: weight, lexicon, ocr }),
    });

    push('MEDICATION_NAME', name, nameWeight);
    if (dosage) push('MEDICATION_DOSAGE', `${dosage[1]} ${dosage[2].toLowerCase()}`, 0.93);

    const frequency = frequencyFrom(line);
    if (frequency) push('MEDICATION_FREQUENCY', frequency.value, frequency.weight);

    const duration = line.match(DURATION_RE);
    if (duration) {
      const count = duration[1] || duration[3];
      const unit = (duration[2] || duration[4]).toLowerCase().replace(/s$/, '');
      push('MEDICATION_DURATION', `${count} ${unit}${Number(count) === 1 ? '' : 's'}`, 0.9);
    }

    const route = formMatch ? ROUTE_BY_FORM[formMatch[1].toLowerCase()] : null;
    if (route) push('MEDICATION_ROUTE', route, 0.88);

    const instruction = line.match(INSTRUCTION_RE);
    if (instruction) push('MEDICATION_INSTRUCTION', instruction[1].toLowerCase(), 0.88);
  }

  return found;
}

// --- laboratory results ----------------------------------------------------

const FLAG_RE = /\b(high|low|normal|abnormal|borderline)\b|(?:^|\s)(H|L|N)(?:\s|$)/i;
const RANGE_RE = new RegExp(
  `(?:ref(?:erence)?\\s*(?:range|interval|value)?\\s*[:\\-]?\\s*)?`
  + `((?:<|>|≤|≥)\\s*\\d+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?\\s*[-–]\\s*\\d+(?:\\.\\d+)?)`,
  'i',
);

function extractLabResults(lines, pages, ocrFallback) {
  const found = [];
  let index = 0;

  for (const line of lines) {
    // Skip the header row of a results table.
    if (/^\s*(test|investigation|parameter)\s*(name)?\s*(result|value)/i.test(line)) continue;

    const known = line.match(LAB_TEST_RE);
    const unitMatch = line.match(UNIT_RE);

    // Value: the first standalone number that is not part of the reference range.
    const valueMatch = line.match(/(?:^|[\s:])((?:<|>|≤|≥)?\s*\d+(?:[.,]\d+)?)(?=\s|$|[a-zA-Zµ%/])/);
    if (!valueMatch) continue;

    let name = null;
    let nameWeight = 0;
    if (known) {
      name = titleCase(known[1]);
      nameWeight = 0.95;
    } else {
      // Unknown test: take the label before the value, but only when a unit or a
      // reference range makes it clear this really is a result line.
      const before = line.slice(0, valueMatch.index).replace(/[:\-]\s*$/, '').trim();
      if (!before || before.length < 2 || before.length > 60) continue;
      if (!unitMatch && !RANGE_RE.test(line)) continue;
      if (MEDICINE_RE.test(line) || FORM_RE.test(line)) continue; // a prescription line
      if (/\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(before)) continue; // a date, not a test
      name = before.replace(/^[^A-Za-z]+/, '');
      if (!name) continue;
      nameWeight = 0.66;
    }

    const pageNumber = pageOf(pages, line);
    const ocr = ocrConfidenceFor(pages, pageNumber, ocrFallback);
    const groupKey = `lab:${index++}`;
    const value = valueMatch[1].replace(/\s+/g, '').replace(',', '.');

    // The reference range must not be mistaken for the result itself.
    const afterValue = line.slice(valueMatch.index + valueMatch[0].length);
    const rangeMatch = afterValue.match(RANGE_RE);

    const push = (entityType, entityValue, weight, extra = {}) => found.push({
      entityType, entityValue, groupKey, pageNumber, sourceText: line,
      confidence: score({ pattern: weight, lexicon: Boolean(known), ocr }),
      ...extra,
    });

    push('LAB_TEST', name, nameWeight);
    push('LAB_VALUE', value, 0.9);
    if (unitMatch) push('LAB_UNIT', unitMatch[0], 0.92);
    if (rangeMatch) push('LAB_REFERENCE_RANGE', rangeMatch[1].replace(/\s+/g, ' ').trim(), 0.85);

    // Only when the document states it. Deriving "abnormal" by comparing the
    // value to the range would be the system forming a clinical opinion.
    const flagMatch = afterValue.match(FLAG_RE);
    if (flagMatch) {
      const raw = (flagMatch[1] || flagMatch[2] || '').toUpperCase();
      const flag = { H: 'HIGH', L: 'LOW', N: 'NORMAL' }[raw] || raw;
      if (flag) push('LAB_FLAG', flag, 0.86, { flag });
    }
  }

  return found;
}

// --- free-text clinical mentions ------------------------------------------

function extractLexiconMentions(text, pages, ocrFallback) {
  const found = [];
  const seen = new Set();
  const clean = cleanText(text);

  const scan = (list, entityType, weight) => {
    for (const term of list) {
      const re = new RegExp(`\\b${escapeRe(term)}\\b`, 'i');
      const m = clean.match(re);
      if (!m) continue;
      const key = `${entityType}:${term.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = clean.split('\n').find((l) => re.test(l)) || '';
      const pageNumber = pageOf(pages, line);
      found.push({
        entityType,
        entityValue: titleCase(m[0]),
        // A bare mention is weaker evidence than a labelled field: "no fever"
        // also contains "fever". Flagged low so a reviewer looks at it.
        confidence: score({ pattern: weight, lexicon: true, ocr: ocrConfidenceFor(pages, pageNumber, ocrFallback) }),
        pageNumber,
        sourceText: line,
      });
    }
  };

  scan(SYMPTOMS, 'SYMPTOM', 0.6);
  scan(CONDITIONS, 'CONDITION', 0.62);
  return found;
}

// --- dates -----------------------------------------------------------------

const DATE_RE = /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{2,4})\b/i;

function extractDates(lines, pages, ocrFallback, documentType) {
  const found = [];
  for (const line of lines) {
    if (!/follow[\s-]*up|review on|next visit|revisit/i.test(line)) continue;
    const m = line.match(DATE_RE);
    if (!m) continue;
    const pageNumber = pageOf(pages, line);
    found.push({
      entityType: 'FOLLOW_UP_DATE',
      entityValue: m[1],
      confidence: score({ pattern: 0.9, ocr: ocrConfidenceFor(pages, pageNumber, ocrFallback) }),
      pageNumber,
      sourceText: line,
    });
  }

  // A prescription's bare "Date:" is its prescription date.
  if (documentType === 'PRESCRIPTION') {
    for (const line of lines) {
      const m = line.match(/^\s*date\s*[:\-]\s*(.+)$/i);
      if (!m) continue;
      const d = m[1].match(DATE_RE);
      if (!d) continue;
      const pageNumber = pageOf(pages, line);
      found.push({
        entityType: 'PRESCRIPTION_DATE',
        entityValue: d[1],
        confidence: score({ pattern: 0.86, ocr: ocrConfidenceFor(pages, pageNumber, ocrFallback) }),
        pageNumber,
        sourceText: line,
      });
    }
  }
  return found;
}

// --- entry point -----------------------------------------------------------

// Keep the strongest instance of any duplicate.
function dedupe(entities) {
  const best = new Map();
  for (const e of entities) {
    const key = `${e.entityType}|${e.groupKey || ''}|${String(e.entityValue).toLowerCase()}`;
    const existing = best.get(key);
    if (!existing || e.confidence > existing.confidence) best.set(key, e);
  }
  return [...best.values()];
}

/**
 * @param {string} text            cleaned OCR text
 * @param {object} options
 * @param {string} options.documentType  from classifyDocument
 * @param {number} options.ocrConfidence document-level fallback
 * @param {Array}  options.pages         [{ page, text, confidence }]
 * @returns {{ entities: Array, structured: object }}
 */
export function extractEntities(text, { documentType = 'OTHER', ocrConfidence = 1, pages = [] } = {}) {
  const clean = cleanText(text);
  const lines = toLines(clean);

  const entities = dedupe([
    ...extractLabelled(lines, pages, ocrConfidence),
    ...extractAgeSex(lines, pages, ocrConfidence),
    ...extractMedications(lines, pages, ocrConfidence),
    ...extractLabResults(lines, pages, ocrConfidence),
    ...extractDates(lines, pages, ocrConfidence, documentType),
    ...extractLexiconMentions(clean, pages, ocrConfidence),
  ]);

  return { entities, structured: toStructured(entities) };
}

/**
 * Groups flat entities into the shape a reviewer and the API consumer read.
 * Medications and lab rows are reassembled from their groupKey.
 */
export function toStructured(entities) {
  const first = (type) => entities.find((e) => e.entityType === type);
  const all = (type) => entities.filter((e) => e.entityType === type);
  const value = (e) => (e ? (e.correctedValue ?? e.entityValue) : null);

  const groups = (prefix) => {
    const byKey = new Map();
    for (const e of entities) {
      if (!e.groupKey?.startsWith(prefix)) continue;
      if (!byKey.has(e.groupKey)) byKey.set(e.groupKey, []);
      byKey.get(e.groupKey).push(e);
    }
    return [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  };

  const medications = groups('med:').map(([, items]) => {
    const pick = (type) => value(items.find((i) => i.entityType === type));
    const confidences = items.map((i) => i.confidence);
    return {
      name: pick('MEDICATION_NAME'),
      dosage: pick('MEDICATION_DOSAGE'),
      frequency: pick('MEDICATION_FREQUENCY'),
      duration: pick('MEDICATION_DURATION'),
      route: pick('MEDICATION_ROUTE'),
      instructions: pick('MEDICATION_INSTRUCTION'),
      confidence: Math.round(Math.min(...confidences) * 100) / 100,
    };
  }).filter((m) => m.name);

  const labResults = groups('lab:').map(([, items]) => {
    const pick = (type) => value(items.find((i) => i.entityType === type));
    const confidences = items.map((i) => i.confidence);
    return {
      test: pick('LAB_TEST'),
      value: pick('LAB_VALUE'),
      unit: pick('LAB_UNIT'),
      referenceRange: pick('LAB_REFERENCE_RANGE'),
      flag: pick('LAB_FLAG'),
      confidence: Math.round(Math.min(...confidences) * 100) / 100,
    };
  }).filter((l) => l.test && l.value !== null);

  return {
    patient: {
      name: value(first('PATIENT_NAME')),
      age: value(first('PATIENT_AGE')),
      gender: value(first('PATIENT_GENDER')),
      patientId: value(first('PATIENT_ID')),
    },
    diagnoses: all('DIAGNOSIS').map(value),
    symptoms: all('SYMPTOM').map(value),
    conditions: all('CONDITION').map(value),
    allergies: all('ALLERGY').map(value),
    procedures: all('PROCEDURE').map(value),
    treatments: all('TREATMENT').map(value),
    medications,
    labResults,
    provenance: {
      doctor: value(first('DOCTOR_NAME')),
      hospital: value(first('HOSPITAL_NAME')),
      department: value(first('DEPARTMENT')),
      reportDate: value(first('REPORT_DATE')),
      prescriptionDate: value(first('PRESCRIPTION_DATE')),
      followUpDate: value(first('FOLLOW_UP_DATE')),
    },
  };
}
