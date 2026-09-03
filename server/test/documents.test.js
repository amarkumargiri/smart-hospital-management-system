import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDocument, cleanText, toLines } from '../src/documents/classify.js';
import { extractEntities, toStructured } from '../src/documents/extract.js';

// Helper: pull one entity type out of a result.
const valuesOf = (entities, type) =>
  entities.filter((e) => e.entityType === type).map((e) => e.entityValue);
const firstOf = (entities, type) => entities.find((e) => e.entityType === type);

// --- text cleaning ---------------------------------------------------------

test('cleaning repairs the OCR confusions that break extraction', () => {
  const cleaned = cleanText('Hb 11.2 l/dL\r\nParacetamol 500 rng\n\n\n\nDone');
  assert.match(cleaned, /g\/dL/);
  assert.match(cleaned, /500 mg/);
  assert.doesNotMatch(cleaned, /\n{3,}/);
});

test('lines are trimmed and blanks dropped', () => {
  assert.deepEqual(toLines('  a  \n\n   \n b '), ['a', 'b']);
});

// --- classification --------------------------------------------------------

test('classifies a lab report', () => {
  const { type, confidence } = classifyDocument(`
    HAEMATOLOGY REPORT
    Test Name          Result    Unit        Reference Range
    Haemoglobin        11.2      g/dL        13.0 - 17.0
    WBC                8500      cells/uL    4000 - 11000
  `);
  assert.equal(type, 'LAB_REPORT');
  assert.ok(confidence > 0.5, `confidence should be decisive, got ${confidence}`);
});

test('classifies a prescription', () => {
  const { type } = classifyDocument(`
    Rx
    Tab. Paracetamol 500 mg twice daily for 5 days after food
    Cap. Amoxicillin 500 mg thrice daily for 7 days
  `);
  assert.equal(type, 'PRESCRIPTION');
});

test('classifies a discharge summary', () => {
  const { type } = classifyDocument(`
    DISCHARGE SUMMARY
    Date of Admission: 10/08/2026
    Date of Discharge: 15/08/2026
    Course in the hospital: Patient improved on IV antibiotics.
  `);
  assert.equal(type, 'DISCHARGE_SUMMARY');
});

test('classifies a radiology report', () => {
  const { type } = classifyDocument(`
    X-RAY CHEST PA VIEW
    Findings: Bilateral lung fields are clear.
    Impression: No significant abnormality detected.
  `);
  assert.equal(type, 'RADIOLOGY_REPORT');
});

test('classifies a medical certificate', () => {
  const { type } = classifyDocument(`
    MEDICAL CERTIFICATE
    This is to certify that Mr. Amit Kumar was under my treatment.
    He is fit to resume duty from 16/08/2026.
  `);
  assert.equal(type, 'MEDICAL_CERTIFICATE');
});

test('unrecognisable text falls back to OTHER with low confidence', () => {
  const { type, confidence } = classifyDocument('Dear sir, please find attached the invoice for stationery.');
  assert.equal(type, 'OTHER');
  assert.ok(confidence < 0.5);
});

// --- the worked example from the specification -----------------------------

test('extracts the specification example end to end', () => {
  const text = `Patient: Amit Kumar
Diagnosis: Viral fever
Tab. Paracetamol 500 mg twice daily for 5 days after meals
Hb 11.2 g/dL`;

  const { entities, structured } = extractEntities(text, { documentType: 'PRESCRIPTION' });

  assert.equal(structured.patient.name, 'Amit Kumar');
  assert.deepEqual(structured.diagnoses, ['Viral fever']);

  const med = structured.medications.find((m) => /paracetamol/i.test(m.name));
  assert.ok(med, 'Paracetamol should be extracted');
  assert.equal(med.dosage, '500 mg');
  assert.equal(med.frequency, 'twice daily');
  assert.equal(med.duration, '5 days');
  assert.equal(med.instructions, 'after meals');
  assert.equal(med.route, 'ORAL');

  const hb = structured.labResults.find((l) => /hb/i.test(l.test));
  assert.ok(hb, 'Hb should be extracted');
  assert.equal(hb.value, '11.2');
  assert.equal(hb.unit, 'g/dL');

  assert.ok(entities.every((e) => e.confidence > 0 && e.confidence <= 1));
});

// --- prescription extraction ----------------------------------------------

test('extracts several medicines with their own dosing', () => {
  const { structured } = extractEntities(`Rx
Tab. Paracetamol 500 mg twice daily for 5 days after food
Cap. Amoxicillin 500 mg thrice daily for 7 days
Inj. Ceftriaxone 1 g once daily for 3 days`);

  assert.equal(structured.medications.length, 3);
  const [para, amox, ceft] = structured.medications;
  assert.match(para.name, /Paracetamol/i);
  assert.equal(amox.frequency, 'three times daily');
  assert.equal(ceft.route, 'IV');
  assert.equal(ceft.duration, '3 days');
});

test('understands BD/TDS shorthand and 1-0-1 dose patterns', () => {
  const a = extractEntities('Tab. Metformin 500 mg BD for 30 days').structured.medications[0];
  assert.equal(a.frequency, 'twice daily');

  const b = extractEntities('Tab. Amlodipine 5 mg TDS x 14 days').structured.medications[0];
  assert.equal(b.frequency, 'three times daily');

  const c = extractEntities('Tab. Pantoprazole 40 mg 1-0-1 for 10 days').structured.medications[0];
  assert.match(c.frequency, /2 time\(s\) daily/);
});

test('a known generic scores higher than an unknown brand', () => {
  const known = extractEntities('Tab. Paracetamol 500 mg').entities;
  const unknown = extractEntities('Tab. Zyxovir 500 mg').entities;
  const k = firstOf(known, 'MEDICATION_NAME');
  const u = firstOf(unknown, 'MEDICATION_NAME');
  assert.ok(k.confidence > u.confidence, `${k.confidence} should beat ${u.confidence}`);
});

// --- lab report extraction -------------------------------------------------

test('extracts test, value, unit, range and stated flag', () => {
  const { structured } = extractEntities(`Haemoglobin 11.2 g/dL 13.0 - 17.0 Low
WBC 8500 cells/uL 4000 - 11000 Normal
Glucose 128 mg/dL 70 - 110 High`);

  assert.equal(structured.labResults.length, 3);
  const hb = structured.labResults[0];
  assert.match(hb.test, /Haemoglobin/i);
  assert.equal(hb.value, '11.2');
  assert.equal(hb.unit, 'g/dL');
  assert.equal(hb.referenceRange, '13.0 - 17.0');
  assert.equal(hb.flag, 'LOW');
});

test('an abnormal value is NOT flagged unless the document says so', () => {
  // 11.2 is below a normal haemoglobin range, but the document does not say
  // "low" — deciding that would be the system forming a clinical opinion.
  const { structured } = extractEntities('Haemoglobin 11.2 g/dL 13.0 - 17.0');
  assert.equal(structured.labResults[0].flag, null);
});

test('a colon-separated lab line still parses', () => {
  const { structured } = extractEntities('Creatinine : 1.4 mg/dL (Ref: 0.6 - 1.2)');
  const row = structured.labResults[0];
  assert.match(row.test, /Creatinine/i);
  assert.equal(row.value, '1.4');
  assert.equal(row.unit, 'mg/dL');
});

test('a prescription line is not mistaken for a lab result', () => {
  const { structured } = extractEntities('Tab. Paracetamol 500 mg twice daily');
  assert.equal(structured.labResults.length, 0);
  assert.equal(structured.medications.length, 1);
});

// --- demographics and provenance ------------------------------------------

test('extracts combined age/sex fields', () => {
  const { structured } = extractEntities('Patient Name: Sunita Devi\nAge/Sex: 45/F');
  assert.equal(structured.patient.name, 'Sunita Devi');
  assert.equal(structured.patient.age, '45');
  assert.equal(structured.patient.gender, 'FEMALE');
});

test('extracts doctor, department and patient identifier', () => {
  const { structured } = extractEntities(`UHID: MH-2026-4471
Consultant: Dr. Ananya Sharma
Department: Cardiology`);
  assert.equal(structured.patient.patientId, 'MH-2026-4471');
  assert.match(structured.provenance.doctor, /Ananya Sharma/);
  assert.equal(structured.provenance.department, 'Cardiology');
});

test('a labelled patient name outranks a bare Name field', () => {
  const strong = firstOf(extractEntities('Patient Name: Amit Kumar').entities, 'PATIENT_NAME');
  const weak = firstOf(extractEntities('Name: Amit Kumar').entities, 'PATIENT_NAME');
  assert.ok(strong.confidence > weak.confidence);
});

test('splits a comma-separated diagnosis list', () => {
  const { structured } = extractEntities('Diagnosis: Viral fever, Acute gastritis, Anaemia');
  assert.equal(structured.diagnoses.length, 3);
  assert.ok(structured.diagnoses.includes('Acute gastritis'));
});

test('extracts allergies and follow-up date', () => {
  const { structured } = extractEntities(`Known allergies: Penicillin, Sulpha drugs
Follow up on 22/08/2026`);
  assert.deepEqual(structured.allergies, ['Penicillin', 'Sulpha drugs']);
  assert.equal(structured.provenance.followUpDate, '22/08/2026');
});

// --- confidence behaviour --------------------------------------------------

test('poor OCR confidence drags entity confidence down', () => {
  const text = 'Patient Name: Amit Kumar';
  const good = extractEntities(text, { ocrConfidence: 0.98, pages: [{ page: 1, text, confidence: 0.98 }] });
  const bad = extractEntities(text, { ocrConfidence: 0.35, pages: [{ page: 1, text, confidence: 0.35 }] });
  const g = firstOf(good.entities, 'PATIENT_NAME').confidence;
  const b = firstOf(bad.entities, 'PATIENT_NAME').confidence;
  assert.ok(g > b, `${g} should beat ${b}`);
  assert.ok(b >= 0.3, 'confidence stays within the documented floor');
});

test('every confidence is a probability', () => {
  const { entities } = extractEntities(`Patient: Amit Kumar
Diagnosis: Viral fever
Tab. Paracetamol 500 mg twice daily for 5 days
Hb 11.2 g/dL 13.0 - 17.0`);
  assert.ok(entities.length > 0);
  for (const e of entities) {
    assert.ok(e.confidence >= 0.3 && e.confidence <= 0.99, `${e.entityType} = ${e.confidence}`);
  }
});

test('a bare symptom mention is low confidence — "no fever" contains "fever"', () => {
  const mention = firstOf(extractEntities('Patient reports no fever today.').entities, 'SYMPTOM');
  assert.ok(mention);
  assert.ok(mention.confidence < 0.85, 'must fall below the auto-accept threshold');
});

// --- empty and degenerate input -------------------------------------------

test('empty text yields no entities rather than throwing', () => {
  const { entities, structured } = extractEntities('');
  assert.equal(entities.length, 0);
  assert.equal(structured.medications.length, 0);
  assert.equal(structured.patient.name, null);
});

test('gibberish yields nothing structured', () => {
  const { structured } = extractEntities('qwe rty uiop asdf ghjkl zxcvb');
  assert.equal(structured.labResults.length, 0);
  assert.equal(structured.medications.length, 0);
});

// --- structuring and human corrections ------------------------------------

test('a human correction replaces the machine value in the structured output', () => {
  const { entities } = extractEntities('Patient Name: Amlt Kumnar'); // OCR mangled it
  const corrected = entities.map((e) => (e.entityType === 'PATIENT_NAME'
    ? { ...e, correctedValue: 'Amit Kumar' }
    : e));
  assert.equal(toStructured(corrected).patient.name, 'Amit Kumar');
});

test('rejected entities are excluded by the caller before structuring', () => {
  const { entities } = extractEntities('Tab. Paracetamol 500 mg\nTab. Ibuprofen 400 mg');
  const kept = entities.filter((e) => !/Ibuprofen/i.test(e.entityValue));
  const structured = toStructured(kept);
  assert.ok(!structured.medications.some((m) => /Ibuprofen/i.test(m.name || '')));
});

test('medication group confidence is the weakest field in the group', () => {
  const { structured } = extractEntities('Tab. Zyxovir 500 mg twice daily');
  const med = structured.medications[0];
  assert.ok(med.confidence <= 0.85, 'an unknown brand should not read as certain');
});
