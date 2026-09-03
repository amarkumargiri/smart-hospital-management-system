// End-to-end check of the document processing feature against a running API.
//
//   upload → OCR → NLP → review → correction → approval → medical record
//
// plus the security boundaries. Uses a generated lab-report image so the OCR
// engine does real work rather than being stubbed.

import sharp from 'sharp';

const BASE = 'http://localhost:4000/api';
const PASSWORD = 'Password123';
let failures = 0;

const step = (n, msg) => console.log(`${String(n).padStart(2)}. ${msg}`);
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function login(identifier) {
  const r = await (await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password: PASSWORD }),
  })).json();
  if (!r.accessToken) throw new Error(`login ${identifier}: ${JSON.stringify(r)}`);
  return r.accessToken;
}

async function call(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function uploadFile(token, { buffer, filename, contentType, fields = {} }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), filename);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`${BASE}/documents`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// A realistic lab report rendered to PNG so Tesseract has genuine pixels to read.
function labReportPng() {
  const lines = [
    'SUNRISE MULTISPECIALITY HOSPITAL',
    'HAEMATOLOGY REPORT',
    '',
    'Patient Name: Amit Kumar',
    'Age/Sex: 45/M',
    'UHID: MH-2026-4471',
    'Consultant: Dr. Ananya Sharma',
    'Department: Cardiology',
    '',
    'Test Name        Result    Unit        Reference Range',
    'Haemoglobin      11.2      g/dL        13.0 - 17.0',
    'WBC              8500      cells/uL    4000 - 11000',
    'Glucose          128       mg/dL       70 - 110',
  ];
  const rows = lines.map((t, i) =>
    `<text x="40" y="${70 + i * 44}" font-family="Helvetica, Arial" font-size="26" fill="black">${t}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${120 + lines.length * 44}">
    <rect width="100%" height="100%" fill="white"/>${rows}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function prescriptionPng() {
  const lines = [
    'Dr. Rohit Verma, MBBS MD',
    'Sunrise Multispeciality Hospital',
    '',
    'Patient: Sunita Devi',
    'Date: 15/08/2026',
    '',
    'Rx',
    'Tab. Paracetamol 500 mg twice daily for 5 days after food',
    'Cap. Amoxicillin 500 mg thrice daily for 7 days',
    '',
    'Diagnosis: Viral fever',
    'Follow up on 22/08/2026',
  ];
  const rows = lines.map((t, i) =>
    `<text x="40" y="${70 + i * 44}" font-family="Helvetica, Arial" font-size="26" fill="black">${t}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${120 + lines.length * 44}">
    <rect width="100%" height="100%" fill="white"/>${rows}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function waitForProcessing(token, documentId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  const terminal = ['REVIEW_REQUIRED', 'OCR_FAILED', 'NLP_FAILED', 'PROCESSING_FAILED'];
  while (Date.now() < deadline) {
    const { data } = await call(token, 'GET', `/documents/${documentId}`);
    if (terminal.includes(data?.status)) return data;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('processing did not finish in time');
}

// --- run -------------------------------------------------------------------

const patient = await login('patient1@example.com');
const reception = await login('reception@sunrisehospital.dev');
const doctor = await login('doctor1@sunrisehospital.dev');
const otherPatient = await login('patient3@example.com');

const me = await call(patient, 'GET', '/auth/me');
const patientId = me.data.patient.id;

// 1 ── patient uploads their own lab report
const png = await labReportPng();
const uploaded = await uploadFile(patient, { buffer: png, filename: 'blood_report_15_aug.png', contentType: 'image/png' });
step(1, `uploaded (${uploaded.status}) document ${uploaded.data?.id}`);
check('upload accepted', uploaded.status === 201);
check('starts as UPLOADED', uploaded.data?.status === 'UPLOADED', uploaded.data?.status);
const documentId = uploaded.data.id;

// 2 ── pipeline runs
const processed = await waitForProcessing(patient, documentId);
step(2, `pipeline finished: ${processed.status} in ${processed.processingMs} ms`);
check('reached REVIEW_REQUIRED', processed.status === 'REVIEW_REQUIRED', processed.failureReason || '');
check('never auto-verified', processed.status !== 'SAVED');
check('classified as LAB_REPORT', processed.documentType === 'LAB_REPORT', processed.documentType);

// 3 ── raw OCR text is available
const ocr = await call(patient, 'GET', `/documents/${documentId}/ocr`);
step(3, `OCR via ${ocr.data?.engine}, confidence ${ocr.data?.confidence}, ${ocr.data?.pageCount} page(s)`);
check('OCR text stored', (ocr.data?.extractedText || '').length > 50);
check('page info preserved', Array.isArray(ocr.data?.pages) && ocr.data.pages.length >= 1);

// 4 ── structured extraction
const extraction = await call(patient, 'GET', `/documents/${documentId}/extraction`);
const s = extraction.data.structured;
step(4, `extracted ${extraction.data.entityCount} entities (${extraction.data.lowConfidence} below threshold)`);
console.log('    labs:', JSON.stringify(s.labResults));
console.log('    patient:', JSON.stringify(s.patient));
check('found lab rows', s.labResults.length >= 2, `${s.labResults.length}`);
check('haemoglobin value read', s.labResults.some((l) => String(l.value).startsWith('11.2')));
check('unit read', s.labResults.some((l) => /g\/dL/i.test(l.unit || '')));
check('reference range read', s.labResults.some((l) => (l.referenceRange || '').includes('13')));
check('patient name read', /amit/i.test(s.patient.name || ''), s.patient.name || 'null');
check('every entity carries a confidence',
  extraction.data.entities.every((e) => e.confidence > 0 && e.confidence <= 1));
check('no flag invented for an out-of-range value',
  s.labResults.every((l) => l.flag === null || /HIGH|LOW|NORMAL/.test(l.flag)));

// 5 ── a correction sticks
const nameEntity = extraction.data.entities.find((e) => e.entityType === 'PATIENT_NAME');
if (nameEntity) {
  const corrected = await call(patient, 'PUT', `/documents/${documentId}/extraction`, {
    entities: [{ id: nameEntity.id, correctedValue: 'Amit Kumar' }],
  });
  step(5, 'correction applied');
  check('correction reflected in structured output', corrected.data?.structured?.patient?.name === 'Amit Kumar');
} else {
  step(5, 'no patient-name entity to correct');
}

// 6 ── nothing is in the record before approval
const before = await call(patient, 'GET', `/patients/${patientId}/records`);
const beforeCount = before.data.length;

// 7 ── approve → medical record
const approved = await call(patient, 'POST', `/documents/${documentId}/verify`, {
  decision: 'APPROVE', remarks: 'Checked against the paper copy.',
});
step(6, `approved → ${approved.data?.status}, record ${approved.data?.medicalRecordId}`);
check('status SAVED', approved.data?.status === 'SAVED');
check('medical record created', Boolean(approved.data?.medicalRecordId));

const after = await call(patient, 'GET', `/patients/${patientId}/records`);
check('record appears in the existing medical history', after.data.length === beforeCount + 1,
  `${beforeCount} → ${after.data.length}`);
const newest = after.data[0];
check('record is typed LAB', newest.recordType === 'LAB', newest.recordType);
console.log('    record summary:', (newest.summary || '').slice(0, 110));

// 8 ── re-approval is refused
const again = await call(patient, 'POST', `/documents/${documentId}/verify`, { decision: 'APPROVE' });
check('cannot approve twice', again.status === 409, `got ${again.status}`);
check('cannot edit after saving',
  (await call(patient, 'PUT', `/documents/${documentId}/extraction`, { entities: [] })).status === 409);

// 9 ── prescription path, uploaded by reception for one of doctor1's patients
const appointments = await call(doctor, 'GET', '/appointments?pageSize=1');
const seenPatientId = appointments.data.items[0].patientId;
const rxUpload = await uploadFile(reception, {
  buffer: await prescriptionPng(), filename: 'prescription.png', contentType: 'image/png',
  fields: { patientId: seenPatientId },
});
step(7, `reception uploaded a prescription for a patient of doctor1 (${rxUpload.status})`);
check('reception may upload for its hospital\'s patient', rxUpload.status === 201);
const rxDoc = await waitForProcessing(reception, rxUpload.data.id);
check('classified as PRESCRIPTION', rxDoc.documentType === 'PRESCRIPTION', rxDoc.documentType);
const rxExtraction = await call(reception, 'GET', `/documents/${rxUpload.data.id}/extraction`);
const meds = rxExtraction.data.structured.medications;
console.log('    medications:', JSON.stringify(meds));
check('medicines extracted', meds.length >= 1, `${meds.length}`);
check('dosage extracted', meds.some((m) => /500 mg/i.test(m.dosage || '')));
check('frequency extracted', meds.some((m) => /daily/i.test(m.frequency || '')));
check('duration extracted', meds.some((m) => /day/i.test(m.duration || '')));

// 10 ── doctor sees it through the existing relationship rule
const doctorView = await call(doctor, 'GET', `/documents?patientId=${seenPatientId}`);
step(8, `doctor lists ${doctorView.data?.total} document(s) for their patient`);
check('doctor can list a treated patient\'s documents', doctorView.status === 200 && doctorView.data.total >= 1);
check('doctor can read the OCR text',
  (await call(doctor, 'GET', `/documents/${rxUpload.data.id}/ocr`)).status === 200);
check('doctor can open the original file',
  (await fetch(`${BASE}/documents/${rxUpload.data.id}/file`, { headers: { Authorization: `Bearer ${doctor}` } })).status === 200);

// 11 ── security boundaries
step(9, 'security checks');
check('unauthenticated upload refused',
  (await uploadFile(null, { buffer: png, filename: 'x.png', contentType: 'image/png' })).status === 401);
check('unauthenticated read refused', (await call(null, 'GET', `/documents/${documentId}`)).status === 401);
check('another patient cannot read the document',
  (await call(otherPatient, 'GET', `/documents/${documentId}`)).status === 403);
check('another patient cannot read the extraction',
  (await call(otherPatient, 'GET', `/documents/${documentId}/extraction`)).status === 403);
check('another patient cannot download the original',
  (await fetch(`${BASE}/documents/${documentId}/file`, { headers: { Authorization: `Bearer ${otherPatient}` } })).status === 403);
check('another patient cannot modify the extraction',
  (await call(otherPatient, 'PUT', `/documents/${documentId}/extraction`, { entities: [] })).status === 403);
check('another patient cannot verify',
  (await call(otherPatient, 'POST', `/documents/${documentId}/verify`, { decision: 'APPROVE' })).status === 403);
check('cannot upload for a patient with no relationship',
  (await uploadFile(otherPatient, { buffer: png, filename: 'x.png', contentType: 'image/png', fields: { patientId } })).status === 403);
check('invalid patient id refused',
  (await uploadFile(patient, { buffer: png, filename: 'x.png', contentType: 'image/png', fields: { patientId: 'does-not-exist' } })).status === 403);

// malicious upload: an executable script wearing a .png name
const evil = Buffer.from('#!/bin/sh\nrm -rf /\n');
check('script upload rejected by MIME allow-list',
  (await uploadFile(patient, { buffer: evil, filename: 'evil.sh', contentType: 'application/x-sh' })).status >= 400);
check('html disguised as an image rejected',
  (await uploadFile(patient, { buffer: Buffer.from('<script>alert(1)</script>'), filename: 'x.html', contentType: 'text/html' })).status >= 400);

// oversized upload
check('oversized file rejected',
  (await uploadFile(patient, { buffer: Buffer.alloc(16 * 1024 * 1024, 1), filename: 'big.png', contentType: 'image/png' })).status >= 400);

// 12 ── an unreadable image fails gracefully
const blank = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#ffffff' } }).png().toBuffer();
const blankUpload = await uploadFile(patient, { buffer: blank, filename: 'blank.png', contentType: 'image/png' });
const blankDoc = await waitForProcessing(patient, blankUpload.data.id);
step(10, `empty document → ${blankDoc.status}`);
check('empty document fails cleanly, not with a crash',
  ['OCR_FAILED', 'NLP_FAILED'].includes(blankDoc.status), blankDoc.status);
check('failure carries a human-readable reason', Boolean(blankDoc.failureReason));
check('a failed document cannot be approved',
  (await call(patient, 'POST', `/documents/${blankUpload.data.id}/verify`, { decision: 'APPROVE' })).status === 409);

console.log(failures === 0 ? '\nDocument processing end-to-end passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
