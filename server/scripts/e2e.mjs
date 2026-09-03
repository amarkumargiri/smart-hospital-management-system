// Full clinical journey: book -> confirm -> check in -> consult -> diagnose ->
// prescribe -> order labs -> collect -> results -> verify -> complete -> bill -> pay.
const BASE = 'http://localhost:4000/api';
const tok = {};

const login = async (id) => {
  const r = await (await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: id, password: 'Password123' }),
  })).json();
  if (!r.accessToken) throw new Error(`login ${id}: ${JSON.stringify(r)}`);
  return r.accessToken;
};

async function call(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const step = (n, msg) => console.log(`${String(n).padStart(2)}. ${msg}`);

tok.patient = await login('patient2@example.com');
tok.doctor = await login('doctor2@sunrisehospital.dev');
tok.desk = await login('reception@sunrisehospital.dev');
tok.desk2 = await login('reception2@sunrisehospital.dev');

const me = await call(tok.patient, 'GET', '/auth/me');
const docMe = await call(tok.doctor, 'GET', '/auth/me');
const doctorId = docMe.doctor.id;

// 1. find a free slot a few days out
let slots = { slots: [] };
for (let d = 1; d <= 7 && !slots.slots.length; d++) {
  const date = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  slots = await call(tok.patient, 'GET', `/doctors/${doctorId}/slots?date=${date}`);
}
if (!slots.slots.length) throw new Error('no free slot found in the next week');
step(1, `free slot found: ${slots.slots[0].startsAt}`);

// 2. book
const appt = await call(tok.patient, 'POST', '/appointments', {
  doctorId, scheduledAt: slots.slots[0].startsAt, reason: 'Persistent cough and fever', type: 'OPD',
});
step(2, `booked appointment ${appt.id} (${appt.status}) fee ₹${appt.fee}`);

// 3-4. confirm, check in
await call(tok.doctor, 'POST', `/appointments/${appt.id}/status`, { status: 'CONFIRMED' });
const checkedIn = await call(tok.doctor, 'POST', `/appointments/${appt.id}/status`, { status: 'CHECKED_IN' });
step(3, `confirmed and checked in, token ${checkedIn.tokenNumber}`);

// 5. queue position
const queue = await call(tok.patient, 'GET', `/appointments/queue/status?doctorId=${doctorId}&date=${appt.scheduledAt}`);
step(4, `queue: token ${queue.yourToken}, ${queue.patientsAhead} ahead, ~${queue.estimatedWaitMinutes} min`);

// 6. start consultation
const consult = await call(tok.doctor, 'POST', '/consultations', { appointmentId: appt.id });
step(5, `consultation ${consult.id} started (appointment now IN_CONSULTATION)`);

// 7. notes + vitals
await call(tok.doctor, 'PUT', `/consultations/${consult.id}`, {
  symptoms: 'Cough for 5 days, fever 101F', clinicalNotes: 'Chest clear, throat congested',
  treatmentPlan: 'Antibiotics and review in one week',
  followUpDate: new Date(Date.now() + 7 * 86_400_000).toISOString(),
});
await call(tok.doctor, 'PUT', `/consultations/${consult.id}/vitals`, {
  temperatureC: 38.4, systolic: 128, diastolic: 82, heartRate: 92, spo2: 97, weightKg: 68, heightCm: 172,
});
step(6, 'notes and vitals recorded');

// 8. diagnosis
await call(tok.doctor, 'POST', `/consultations/${consult.id}/diagnoses`, {
  code: 'J06.9', description: 'Acute upper respiratory infection', severity: 'MODERATE', isPrimary: true,
});
step(7, 'diagnosis recorded');

// 9. prescription
const rx = await call(tok.doctor, 'POST', '/prescriptions', {
  patientId: consult.patientId, consultationId: consult.id,
  items: [{ medicineName: 'Amoxicillin', dosage: '500 mg', frequency: '3 times/day', durationDays: 5, route: 'ORAL', instruction: 'After food' }],
});
step(8, `prescription ${rx.id} issued with ${rx.items.length} medicine(s)`);

// 10. lab order
const tests = await call(tok.doctor, 'GET', '/lab/tests');
const cbc = tests.find((t) => t.code === 'CBC');
const order = await call(tok.doctor, 'POST', '/lab/orders', {
  patientId: consult.patientId, consultationId: consult.id, testIds: [cbc.id], priority: 'URGENT',
});
step(9, `lab order ${order.id} placed (${order.status})`);

// 11-13. lab workflow
await call(tok.desk, 'POST', `/lab/orders/${order.id}/collect`, { sampleId: 'S99001' });
await call(tok.desk, 'POST', `/lab/orders/${order.id}/process`);
await call(tok.desk, 'POST', `/lab/orders/${order.id}/results`, {
  summary: 'Mild leucocytosis consistent with infection.',
  results: [{ itemId: order.items[0].id, resultValue: '13.2', unit: '10^3/µL', referenceRange: '4 - 11', flag: 'HIGH' }],
});
step(10, 'sample collected, processed and results entered');

// verification must be a different person than the technician who entered them
let selfVerifyBlocked = false;
try {
  await call(tok.desk, 'POST', `/lab/orders/${order.id}/verify`);
} catch (err) {
  selfVerifyBlocked = /verified by someone other/.test(err.message);
}
step(11, `self-verification blocked: ${selfVerifyBlocked}`);

const verified = await call(tok.desk2, 'POST', `/lab/orders/${order.id}/verify`);
step(12, `report verified by the second desk account (${verified.status})`);

// 14. complete consultation -> generates the bill
const completed = await call(tok.doctor, 'POST', `/consultations/${consult.id}/complete`);
step(13, `consultation completed, bill ${completed.bill.billNumber} for ₹${completed.bill.total}`);

// 15. add the lab charge, then pay in full
await call(tok.desk, 'POST', `/billing/${completed.bill.id}/items`, {
  category: 'LAB', description: cbc.name, quantity: 1, unitPrice: cbc.price,
});
const withLab = await call(tok.desk, 'GET', `/billing/${completed.bill.id}`);
step(14, `lab charge added, bill total now ₹${withLab.total}`);

// overpayment must be rejected
let overpayBlocked = false;
try {
  await call(tok.patient, 'POST', `/billing/${withLab.id}/payments`, { amount: withLab.total + 1000, method: 'UPI' });
} catch (err) {
  overpayBlocked = /exceeds the outstanding/.test(err.message);
}
step(15, `overpayment rejected: ${overpayBlocked}`);

const paid = await call(tok.patient, 'POST', `/billing/${withLab.id}/payments`, {
  amount: withLab.total, method: 'UPI', transactionId: 'E2E-TEST',
});
step(16, `paid in full, status ${paid.status}`);

// 16. patient sees everything
const dash = await call(tok.patient, 'GET', `/patients/${me.patient.id}/dashboard`);
const reports = await call(tok.patient, 'GET', `/patients/${me.patient.id}/reports`);
const notifications = await call(tok.patient, 'GET', '/notifications');
step(17, `patient view: ${reports.length} report(s), ${dash.activePrescriptions.length} active prescription(s), ${notifications.unreadCount} unread notification(s)`);

// 17. another patient must not be able to read this record
const other = await login('patient3@example.com');
let isolated = false;
try {
  await call(other, 'GET', `/patients/${me.patient.id}/history`);
} catch (err) {
  isolated = /permission/.test(err.message);
}
step(18, `cross-patient record access blocked: ${isolated}`);

const allGood = selfVerifyBlocked && overpayBlocked && isolated && paid.status === 'PAID';
console.log(allGood ? '\nEnd-to-end journey passed.' : '\nEnd-to-end journey FAILED a guard check.');
process.exit(allGood ? 0 : 1);
