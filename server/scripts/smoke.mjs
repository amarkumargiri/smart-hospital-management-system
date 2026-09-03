// Hits every read endpoint the UI uses, as each role, and reports non-2xx.
const BASE = 'http://localhost:4000/api';

async function login(identifier) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password: 'Password123' }),
  });
  const data = await res.json();
  if (!data.accessToken) throw new Error(`login failed for ${identifier}: ${JSON.stringify(data)}`);
  return data.accessToken;
}

async function get(token, path) {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.text();
  return { status: res.status, path, body: body.slice(0, 160) };
}

const results = [];
const check = async (label, token, paths) => {
  for (const p of paths) {
    const r = await get(token, p);
    results.push({ role: label, ...r });
  }
};

const reception = await login('reception@sunrisehospital.dev');
const doctor = await login('doctor1@sunrisehospital.dev');
const patient = await login('patient1@example.com');

const me = await (await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${patient}` } })).json();
const patientId = me.patient.id;
const doctorMe = await (await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${doctor}` } })).json();
const hospitalId = doctorMe.doctor.hospitalId;

await check('patient', patient, [
  `/patients/${patientId}/dashboard`, `/patients/${patientId}/history`, `/patients/${patientId}/records`,
  `/patients/${patientId}/prescriptions`, `/patients/${patientId}/reports`, `/patients/${patientId}/bills`,
  '/appointments?pageSize=10', '/notifications', '/auth/sessions', `/billing/insurance/${patientId}`,
  '/hospitals?pageSize=5', `/hospitals/${hospitalId}`, '/doctors?pageSize=5',
]);

await check('doctor', doctor, [
  '/doctors/me/dashboard', '/appointments?pageSize=10', '/lab/orders?status=VERIFIED',
  '/admissions?pageSize=10', '/lab/tests', '/ot/surgeries',
]);

await check('reception', reception, [
  '/analytics/dashboard', '/analytics/patients', '/analytics/doctors', '/analytics/financial', '/analytics/operations',
  '/analytics/audit-logs?pageSize=10',
  '/analytics/reports/opd', '/analytics/reports/occupancy', '/analytics/reports/revenue', '/analytics/reports/pharmacy',
  '/analytics/reports/lab', '/analytics/reports/admissions', '/analytics/reports/forecast',
  '/beds', '/beds/summary', '/admissions', '/emergency', '/ot/rooms', '/ot/surgeries',
  '/billing?pageSize=10', '/patients?pageSize=10', `/hospitals/${hospitalId}/staff`, `/hospitals/${hospitalId}/departments`,
  '/lab/orders?status=ORDERED,SAMPLE_COLLECTED,PROCESSING', '/lab/tests',
  '/pharmacy/inventory', '/pharmacy/alerts', '/pharmacy/prescriptions',
  '/forecast/dashboard', '/forecast/icu?horizon=14', '/forecast/blood?horizon=7', '/forecast/alerts/list',
  '/forecast/data/quality', '/forecast/data/history?days=30', '/notifications',
]);

// Reception-only screens must stay shut to a doctor.
for (const path of ['/pharmacy/inventory', '/beds/summary', '/forecast/dashboard', '/analytics/dashboard']) {
  const r = await get(doctor, path);
  if (r.status !== 403) results.push({ role: 'doctor-should-be-403', ...r });
}

const failures = results.filter((r) => r.status >= 300);
console.log(`${results.length} endpoints checked, ${failures.length} failing`);
for (const f of failures) console.log(`  ${f.status} [${f.role}] ${f.path} -> ${f.body}`);
process.exit(failures.length ? 1 : 0);
