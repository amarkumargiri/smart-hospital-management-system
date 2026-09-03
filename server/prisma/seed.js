/* eslint-disable no-console */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Deterministic PRNG so every run of the seed produces the same demo data and a
// forecast accuracy number that can actually be compared between runs.
function mulberry32(seed) {
  return function next() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260815);
const between = (min, max) => min + rand() * (max - min);
const intBetween = (min, max) => Math.round(between(min, max));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
// Box-Muller, so the noise is actually normal rather than a flat band.
const gauss = (mean = 0, sd = 1) =>
  mean + sd * Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

const HISTORY_DAYS = 730; // two years — enough for the weekly and annual patterns
const PASSWORD = 'Password123';

const BLOOD_GROUP_MIX = { 'O+': 0.37, 'B+': 0.22, 'A+': 0.18, 'AB+': 0.08, 'O-': 0.06, 'A-': 0.04, 'B-': 0.03, 'AB-': 0.02 };

const DEPARTMENTS = [
  { name: 'General Medicine', code: 'MED' },
  { name: 'Cardiology', code: 'CARD' },
  { name: 'Orthopaedics', code: 'ORTHO' },
  { name: 'Paediatrics', code: 'PAED' },
  { name: 'Obstetrics & Gynaecology', code: 'OBG' },
  { name: 'Emergency Medicine', code: 'EMER' },
  { name: 'Radiology', code: 'RAD' },
  { name: 'Pathology', code: 'PATH' },
];

const LAB_TESTS = [
  { code: 'CBC', name: 'Complete Blood Count', category: 'HAEMATOLOGY', sampleType: 'BLOOD', price: 350, turnaroundHours: 6 },
  { code: 'BSF', name: 'Blood Glucose (Fasting)', category: 'BIOCHEMISTRY', sampleType: 'BLOOD', price: 120, turnaroundHours: 4 },
  { code: 'LIPID', name: 'Lipid Profile', category: 'BIOCHEMISTRY', sampleType: 'BLOOD', price: 800, turnaroundHours: 12 },
  { code: 'LFT', name: 'Liver Function Test', category: 'BIOCHEMISTRY', sampleType: 'BLOOD', price: 900, turnaroundHours: 12 },
  { code: 'KFT', name: 'Kidney Function Test', category: 'BIOCHEMISTRY', sampleType: 'BLOOD', price: 850, turnaroundHours: 12 },
  { code: 'TSH', name: 'Thyroid Profile', category: 'BIOCHEMISTRY', sampleType: 'BLOOD', price: 650, turnaroundHours: 24 },
  { code: 'URINE', name: 'Urine Routine', category: 'PATHOLOGY', sampleType: 'URINE', price: 200, turnaroundHours: 4 },
  { code: 'XRAY', name: 'X-Ray Chest PA', category: 'RADIOLOGY', sampleType: 'NONE', price: 500, turnaroundHours: 2 },
  { code: 'CT', name: 'CT Scan (Head)', category: 'RADIOLOGY', sampleType: 'NONE', price: 4500, turnaroundHours: 6 },
  { code: 'MRI', name: 'MRI (Brain)', category: 'RADIOLOGY', sampleType: 'NONE', price: 8500, turnaroundHours: 24 },
  { code: 'USG', name: 'Ultrasound Abdomen', category: 'RADIOLOGY', sampleType: 'NONE', price: 1200, turnaroundHours: 4 },
];

const MEDICINES = [
  { name: 'Paracetamol', genericName: 'Acetaminophen', form: 'TABLET', strength: '500 mg', price: 2, quantity: 5000 },
  { name: 'Amoxicillin', genericName: 'Amoxicillin', form: 'CAPSULE', strength: '500 mg', price: 8, quantity: 2400 },
  { name: 'Metformin', genericName: 'Metformin HCl', form: 'TABLET', strength: '500 mg', price: 3, quantity: 3600 },
  { name: 'Amlodipine', genericName: 'Amlodipine Besylate', form: 'TABLET', strength: '5 mg', price: 4, quantity: 3000 },
  { name: 'Atorvastatin', genericName: 'Atorvastatin Calcium', form: 'TABLET', strength: '10 mg', price: 6, quantity: 2000 },
  { name: 'Pantoprazole', genericName: 'Pantoprazole Sodium', form: 'TABLET', strength: '40 mg', price: 5, quantity: 1800 },
  { name: 'Ceftriaxone', genericName: 'Ceftriaxone Sodium', form: 'INJECTION', strength: '1 g', price: 45, quantity: 600 },
  { name: 'Salbutamol', genericName: 'Salbutamol Sulphate', form: 'SYRUP', strength: '2 mg/5 ml', price: 60, quantity: 400 },
  { name: 'Ibuprofen', genericName: 'Ibuprofen', form: 'TABLET', strength: '400 mg', price: 3, quantity: 15 }, // deliberately low stock
  { name: 'Oxygen Cylinder', genericName: 'Medical Oxygen', form: 'INJECTION', strength: 'D-type', price: 350, quantity: 180 },
];

const SPECIALISTS = [
  { name: 'Dr. Ananya Sharma', specialization: 'Cardiologist', qualification: 'MBBS, MD, DM (Cardiology)', dept: 'CARD', experience: 14, fee: 900 },
  { name: 'Dr. Rohit Verma', specialization: 'General Physician', qualification: 'MBBS, MD (Medicine)', dept: 'MED', experience: 9, fee: 500 },
  { name: 'Dr. Kavita Nair', specialization: 'Paediatrician', qualification: 'MBBS, MD (Paediatrics)', dept: 'PAED', experience: 11, fee: 600 },
  { name: 'Dr. Imran Qureshi', specialization: 'Orthopaedic Surgeon', qualification: 'MBBS, MS (Ortho)', dept: 'ORTHO', experience: 16, fee: 800 },
  { name: 'Dr. Meera Iyer', specialization: 'Gynaecologist', qualification: 'MBBS, MS (OBG)', dept: 'OBG', experience: 12, fee: 750 },
  { name: 'Dr. Sanjay Patil', specialization: 'Emergency Physician', qualification: 'MBBS, MD (Emergency)', dept: 'EMER', experience: 8, fee: 550 },
];

const PATIENT_NAMES = [
  'Aman Yadav', 'Priya Deshmukh', 'Rahul Menon', 'Sneha Kulkarni', 'Vikram Singh', 'Anjali Rao',
  'Karthik Reddy', 'Neha Gupta', 'Arjun Pillai', 'Divya Joshi', 'Manish Tiwari', 'Pooja Bhatt',
  'Suresh Kumar', 'Ritu Agarwal', 'Naveen Chandra', 'Shalini Prasad', 'Deepak Mishra', 'Fatima Sheikh',
  'Gaurav Malhotra', 'Ishita Banerjee', 'Joseph Thomas', 'Kiran Shetty', 'Lakshmi Narayan', 'Mohit Saxena',
  'Nandini Rao', 'Omkar Jadhav', 'Pallavi Sinha', 'Rajesh Khanna', 'Sunita Devi', 'Tarun Bhatia',
];

const SYMPTOMS = ['Fever, headache and body ache for 3 days', 'Persistent dry cough', 'Chest discomfort on exertion',
  'Abdominal pain after meals', 'Shortness of breath while climbing stairs', 'Joint pain in both knees'];
const DIAGNOSES = [
  { code: 'J06.9', description: 'Acute upper respiratory infection', severity: 'MILD' },
  { code: 'I10', description: 'Essential hypertension', severity: 'MODERATE' },
  { code: 'E11.9', description: 'Type 2 diabetes mellitus', severity: 'MODERATE' },
  { code: 'K29.7', description: 'Gastritis', severity: 'MILD' },
  { code: 'M17.9', description: 'Osteoarthritis of knee', severity: 'MODERATE' },
  { code: 'J45.9', description: 'Asthma, unspecified', severity: 'SEVERE' },
];

const dayMs = 86_400_000;
const addDays = (date, n) => new Date(date.getTime() + n * dayMs);
const atMidnight = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

async function main() {
  console.log('Seeding…');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  // --- Hospitals -----------------------------------------------------------
  const hospital = await prisma.hospital.create({
    data: {
      name: 'Sunrise Multispeciality Hospital',
      registrationNumber: 'MH-PUN-2011-4471',
      type: 'PRIVATE',
      email: 'contact@sunrisehospital.dev',
      phone: '02041000100',
      addressLine: 'Plot 14, Baner Road',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411045',
      latitude: 18.5602,
      longitude: 73.7769,
      hasEmergency: true,
      rating: 4.4,
      ratingCount: 862,
      status: 'ACTIVE',
      verifiedAt: new Date(),
      departments: { create: DEPARTMENTS },
    },
    include: { departments: true },
  });

  const secondHospital = await prisma.hospital.create({
    data: {
      name: 'City Care General Hospital',
      registrationNumber: 'MH-PUN-2015-9982',
      type: 'TRUST',
      email: 'info@citycare.dev',
      phone: '02041000200',
      addressLine: 'FC Road',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411005',
      latitude: 18.5236,
      longitude: 73.8478,
      rating: 4.0,
      ratingCount: 311,
      status: 'ACTIVE',
      verifiedAt: new Date(),
      departments: { create: DEPARTMENTS.slice(0, 4) },
    },
    include: { departments: true },
  });

  const deptByCode = Object.fromEntries(hospital.departments.map((d) => [d.code, d]));

  // --- Reception desk ------------------------------------------------------
  // Two accounts, not one: releasing a lab report requires someone other than
  // the person who entered the results, and that rule is worth keeping.
  const staffSpec = [
    { fullName: 'Rekha Pawar', employeeId: 'REC-001', email: 'reception@sunrisehospital.dev', mobile: '9000000002' },
    { fullName: 'Sameer Joshi', employeeId: 'REC-002', email: 'reception2@sunrisehospital.dev', mobile: '9000000003' },
  ];
  for (const s of staffSpec) {
    await prisma.user.create({
      data: {
        fullName: s.fullName,
        email: s.email,
        mobile: s.mobile,
        passwordHash,
        role: 'RECEPTIONIST',
        status: 'ACTIVE',
        emailVerified: true,
        mobileVerified: true,
        staff: { create: { hospitalId: hospital.id, employeeId: s.employeeId, role: 'RECEPTIONIST', departmentId: deptByCode.MED.id } },
      },
    });
  }

  // --- Doctors -------------------------------------------------------------
  const doctors = [];
  for (const [i, spec] of SPECIALISTS.entries()) {
    const user = await prisma.user.create({
      data: {
        fullName: spec.name,
        email: `doctor${i + 1}@sunrisehospital.dev`,
        mobile: `90000001${String(i).padStart(2, '0')}`,
        passwordHash,
        role: 'DOCTOR',
        status: 'ACTIVE',
        emailVerified: true,
        mobileVerified: true,
        doctor: {
          create: {
            hospitalId: hospital.id,
            departmentId: deptByCode[spec.dept].id,
            registrationNumber: `MMC-${20000 + i}`,
            specialization: spec.specialization,
            qualification: spec.qualification,
            experienceYears: spec.experience,
            consultationFee: spec.fee,
            languages: 'English, Hindi, Marathi',
            bio: `${spec.specialization} with ${spec.experience} years of clinical experience.`,
            slotMinutes: 15,
            rating: Math.round(between(3.8, 4.9) * 10) / 10,
            ratingCount: intBetween(40, 400),
            status: 'ACTIVE',
            // Mon-Sat, morning and evening clinics.
            availability: {
              create: [1, 2, 3, 4, 5, 6].flatMap((dayOfWeek) => ([
                { dayOfWeek, startTime: '09:00', endTime: '13:00' },
                { dayOfWeek, startTime: '17:00', endTime: '20:00' },
              ])),
            },
          },
        },
      },
      include: { doctor: true },
    });
    doctors.push({ ...user.doctor, fullName: spec.name, userId: user.id });
  }

  // A doctor at the second hospital, so cross-hospital access control has
  // something real to be tested against.
  await prisma.user.create({
    data: {
      fullName: 'Dr. Prakash Salvi',
      email: 'doctor@citycare.dev',
      mobile: '9000000199',
      passwordHash,
      role: 'DOCTOR',
      status: 'ACTIVE',
      doctor: {
        create: {
          hospitalId: secondHospital.id,
          departmentId: secondHospital.departments[0].id,
          registrationNumber: 'MMC-30001',
          specialization: 'General Physician',
          qualification: 'MBBS, MD',
          experienceYears: 7,
          consultationFee: 400,
          status: 'ACTIVE',
          availability: { create: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startTime: '10:00', endTime: '14:00' })) },
        },
      },
    },
  });

  // --- Beds, wards, theatres ----------------------------------------------
  const bedRows = [];
  for (let i = 1; i <= 90; i++) {
    bedRows.push({ hospitalId: hospital.id, bedNumber: `GEN-${String(i).padStart(3, '0')}`, ward: 'GENERAL', type: 'GENERAL', dailyCharge: 1800 });
  }
  for (let i = 1; i <= 20; i++) {
    bedRows.push({ hospitalId: hospital.id, bedNumber: `PVT-${String(i).padStart(3, '0')}`, ward: 'PRIVATE', type: 'PRIVATE', dailyCharge: 4500 });
  }
  for (let i = 1; i <= 30; i++) {
    bedRows.push({
      hospitalId: hospital.id, bedNumber: `ICU-${String(i).padStart(3, '0')}`, ward: 'ICU', type: 'ICU',
      hasVentilator: i <= 18, dailyCharge: 9500,
    });
  }
  for (let i = 1; i <= 10; i++) {
    bedRows.push({ hospitalId: hospital.id, bedNumber: `EMR-${String(i).padStart(3, '0')}`, ward: 'EMERGENCY', type: 'EMERGENCY', dailyCharge: 2500 });
  }
  await prisma.bed.createMany({ data: bedRows });

  await prisma.operatingRoom.createMany({
    data: ['OT-1', 'OT-2', 'OT-3', 'OT-4'].map((name) => ({ name, hospitalId: hospital.id })),
  });

  await prisma.hospital.update({
    where: { id: hospital.id },
    data: {
      totalBeds: bedRows.filter((b) => b.type !== 'ICU').length,
      icuCapacity: bedRows.filter((b) => b.type === 'ICU').length,
      otCount: 4,
    },
  });

  // --- Catalogues ----------------------------------------------------------
  await prisma.labTest.createMany({ data: LAB_TESTS });

  const expiry = (months) => addDays(new Date(), months * 30);
  await prisma.medicine.createMany({
    data: MEDICINES.map((m, i) => ({
      ...m,
      hospitalId: hospital.id,
      batchNumber: `B${2026}${String(i + 1).padStart(3, '0')}`,
      reorderLevel: m.name === 'Ibuprofen' ? 100 : 200,
      expiryDate: expiry(m.name === 'Ceftriaxone' ? 1 : intBetween(8, 30)),
      supplier: pick(['MedSupply India', 'PharmaLink', 'HealthDist Pvt Ltd']),
    })),
  });
  // Blood stock is modelled as inventory so the forecast can read consumption
  // out of the same dispense records as everything else.
  await prisma.medicine.createMany({
    data: Object.keys(BLOOD_GROUP_MIX).map((group, i) => ({
      hospitalId: hospital.id,
      name: `Blood Unit ${group}`,
      genericName: 'Whole Blood',
      form: 'INJECTION',
      strength: group,
      batchNumber: `BLD${String(i + 1).padStart(3, '0')}`,
      quantity: intBetween(20, 90),
      reorderLevel: 25,
      expiryDate: expiry(1),
      supplier: 'Regional Blood Bank',
      price: 1200,
    })),
  });

  // --- Patients ------------------------------------------------------------
  const patients = [];
  for (const [i, name] of PATIENT_NAMES.entries()) {
    const user = await prisma.user.create({
      data: {
        fullName: name,
        email: `patient${i + 1}@example.com`,
        mobile: `98${String(10000000 + i * 137).padStart(8, '0')}`,
        passwordHash,
        role: 'PATIENT',
        status: 'ACTIVE',
        emailVerified: true,
        mobileVerified: true,
        patient: {
          create: {
            dateOfBirth: addDays(new Date(), -intBetween(6, 78) * 365),
            gender: i % 2 === 0 ? 'MALE' : 'FEMALE',
            bloodGroup: pick(Object.keys(BLOOD_GROUP_MIX)),
            addressLine: `${intBetween(1, 200)}, ${pick(['Baner', 'Kothrud', 'Viman Nagar', 'Hadapsar', 'Aundh'])}`,
            city: 'Pune',
            state: 'Maharashtra',
            pincode: pick(['411045', '411038', '411014', '411028', '411007']),
            emergencyName: pick(PATIENT_NAMES),
            emergencyPhone: `97${String(10000000 + i * 271).padStart(8, '0')}`,
            allergies: i % 7 === 0 ? 'Penicillin' : null,
            chronicConditions: i % 5 === 0 ? 'Hypertension' : null,
          },
        },
      },
      include: { patient: true },
    });
    patients.push({ ...user.patient, fullName: name, userId: user.id });
  }

  // --- Recent clinical activity -------------------------------------------
  await seedClinicalActivity({ hospital, doctors, patients });

  // --- Two years of daily resource history --------------------------------
  await seedResourceHistory(hospital.id, bedRows);
  await seedResourceHistory(secondHospital.id, null, 0.45);

  console.log('Seed complete.');
  console.log(`  Hospital:   ${hospital.name} (${hospital.id})`);
  console.log(`  Doctors:    ${doctors.length}  Patients: ${patients.length}  Beds: ${bedRows.length}`);
  console.log(`  History:    ${HISTORY_DAYS} days per hospital`);
  console.log('');
  console.log('  Logins (password for every account: Password123)');
  console.log('    Patient       patient1@example.com');
  console.log('    Doctor        doctor1@sunrisehospital.dev');
  console.log('    Receptionist  reception@sunrisehospital.dev');
  console.log('    Receptionist  reception2@sunrisehospital.dev  (second pair of eyes for lab release)');
}

// Appointments, consultations, prescriptions, lab orders, admissions and bills
// across the last three weeks, so every dashboard has something on it.
async function seedClinicalActivity({ hospital, doctors, patients }) {
  const tests = await prisma.labTest.findMany();
  const beds = await prisma.bed.findMany({ where: { hospitalId: hospital.id } });
  const today = atMidnight(new Date());

  for (let dayOffset = -21; dayOffset <= 7; dayOffset++) {
    const day = addDays(today, dayOffset);
    if (day.getDay() === 0) continue; // clinics closed on Sunday
    const isPast = dayOffset < 0;

    for (const doctor of doctors) {
      const count = intBetween(3, 7);
      for (let slot = 0; slot < count; slot++) {
        const scheduledAt = new Date(day);
        scheduledAt.setHours(9, slot * 15, 0, 0);
        const patient = pick(patients);

        const status = isPast
          ? (rand() < 0.82 ? 'COMPLETED' : rand() < 0.5 ? 'NO_SHOW' : 'CANCELLED')
          : (dayOffset === 0 ? pick(['CONFIRMED', 'CHECKED_IN']) : pick(['REQUESTED', 'CONFIRMED']));

        let appointment;
        try {
          appointment = await prisma.appointment.create({
            data: {
              patientId: patient.id,
              doctorId: doctor.id,
              hospitalId: hospital.id,
              departmentId: doctor.departmentId,
              scheduledAt,
              endsAt: new Date(scheduledAt.getTime() + 15 * 60_000),
              type: rand() < 0.2 ? 'FOLLOW_UP' : 'OPD',
              status,
              reason: pick(SYMPTOMS),
              fee: doctor.consultationFee,
              tokenNumber: status === 'COMPLETED' || status === 'CHECKED_IN' ? `A-${String(slot + 1).padStart(2, '0')}` : null,
              checkedInAt: status === 'COMPLETED' || status === 'CHECKED_IN' ? new Date(scheduledAt.getTime() - 10 * 60_000) : null,
              startedAt: status === 'COMPLETED' ? scheduledAt : null,
              completedAt: status === 'COMPLETED' ? new Date(scheduledAt.getTime() + 12 * 60_000) : null,
            },
          });
        } catch {
          continue; // slot already taken by an earlier iteration
        }

        if (status !== 'COMPLETED') continue;

        const diagnosis = pick(DIAGNOSES);
        const consultation = await prisma.consultation.create({
          data: {
            appointmentId: appointment.id,
            patientId: patient.id,
            doctorId: doctor.id,
            symptoms: appointment.reason,
            clinicalNotes: 'Patient examined. Vitals stable. Advised medication and review.',
            treatmentPlan: 'Symptomatic treatment, review after one week.',
            followUpDate: rand() < 0.35 ? addDays(day, 7) : null,
            status: 'COMPLETED',
            startedAt: scheduledAt,
            completedAt: new Date(scheduledAt.getTime() + 12 * 60_000),
            vitals: {
              create: {
                temperatureC: Math.round(between(36.2, 39.1) * 10) / 10,
                systolic: intBetween(105, 150),
                diastolic: intBetween(68, 95),
                heartRate: intBetween(62, 104),
                respiratoryRate: intBetween(12, 22),
                spo2: intBetween(93, 99),
                weightKg: Math.round(between(45, 95) * 10) / 10,
                heightCm: intBetween(150, 186),
              },
            },
            diagnoses: { create: [{ ...diagnosis, isPrimary: true }] },
          },
        });

        await prisma.medicalRecord.create({
          data: {
            patientId: patient.id,
            recordType: 'CONSULTATION',
            title: diagnosis.description,
            summary: 'Patient examined. Vitals stable. Advised medication and review.',
            recordedBy: doctor.userId,
            recordedAt: scheduledAt,
            consultationId: consultation.id,
          },
        });

        await prisma.prescription.create({
          data: {
            patientId: patient.id,
            doctorId: doctor.id,
            consultationId: consultation.id,
            issuedAt: scheduledAt,
            notes: 'Take medicines after food. Return if symptoms worsen.',
            items: {
              create: [
                { medicineName: 'Paracetamol', dosage: '500 mg', frequency: '2 times/day', durationDays: 5, route: 'ORAL', instruction: 'After food' },
                ...(rand() < 0.5
                  ? [{ medicineName: 'Pantoprazole', dosage: '40 mg', frequency: '1 time/day', durationDays: 7, route: 'ORAL', instruction: 'Before breakfast' }]
                  : []),
              ],
            },
          },
        });

        if (rand() < 0.4) {
          const chosen = [pick(tests), pick(tests)].filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i);
          const verified = rand() < 0.7;
          const order = await prisma.labOrder.create({
            data: {
              patientId: patient.id,
              doctorId: doctor.id,
              hospitalId: hospital.id,
              consultationId: consultation.id,
              orderedAt: scheduledAt,
              status: verified ? 'VERIFIED' : 'ORDERED',
              sampleId: verified ? `S${intBetween(10000, 99999)}` : null,
              collectedAt: verified ? new Date(scheduledAt.getTime() + 30 * 60_000) : null,
              items: {
                create: chosen.map((t) => ({
                  labTestId: t.id,
                  resultValue: verified ? String(intBetween(4, 180)) : null,
                  unit: verified ? pick(['g/dL', 'mg/dL', 'mmol/L', '/µL']) : null,
                  referenceRange: verified ? '4 - 11' : null,
                  flag: verified ? (rand() < 0.75 ? 'NORMAL' : pick(['HIGH', 'LOW', 'CRITICAL'])) : null,
                })),
              },
            },
          });
          if (verified) {
            await prisma.labReport.create({
              data: {
                labOrderId: order.id,
                summary: 'All parameters reviewed. See values against reference ranges.',
                enteredAt: new Date(scheduledAt.getTime() + 3 * 3600_000),
                status: 'VERIFIED',
                verifiedAt: new Date(scheduledAt.getTime() + 4 * 3600_000),
              },
            });
          }
        }

        // Bill for the visit, mostly paid.
        const paid = rand() < 0.75;
        const bill = await prisma.bill.create({
          data: {
            billNumber: `INV-2026-${appointment.id.slice(-8).toUpperCase()}`,
            patientId: patient.id,
            hospitalId: hospital.id,
            appointmentId: appointment.id,
            subtotal: doctor.consultationFee,
            total: doctor.consultationFee,
            paidAmount: paid ? doctor.consultationFee : 0,
            status: paid ? 'PAID' : 'PENDING',
            createdAt: scheduledAt,
            items: {
              create: [{
                category: 'CONSULTATION',
                description: `Consultation — ${doctor.fullName}`,
                quantity: 1,
                unitPrice: doctor.consultationFee,
                amount: doctor.consultationFee,
              }],
            },
          },
        });
        if (paid) {
          await prisma.payment.create({
            data: {
              billId: bill.id,
              amount: doctor.consultationFee,
              method: pick(['UPI', 'CARD', 'CASH']),
              status: 'PAID',
              paidAt: scheduledAt,
              createdAt: scheduledAt,
            },
          });
        }
      }
    }
  }

  // A handful of live inpatients so the ward and ICU screens are not empty.
  const icuBeds = beds.filter((b) => b.type === 'ICU').slice(0, 22);
  const wardBeds = beds.filter((b) => b.type === 'GENERAL').slice(0, 64);
  const occupied = [...icuBeds, ...wardBeds];
  for (const [i, bed] of occupied.entries()) {
    const patient = patients[i % patients.length];
    const doctor = doctors[i % doctors.length];
    const admittedAt = addDays(today, -intBetween(1, 9));
    await prisma.admission.create({
      data: {
        patientId: patient.id,
        hospitalId: hospital.id,
        doctorId: doctor.id,
        departmentId: doctor.departmentId,
        bedId: bed.id,
        reason: bed.type === 'ICU' ? 'Requires intensive monitoring' : 'Requires inpatient management',
        diagnosis: pick(DIAGNOSES).description,
        status: 'ADMITTED',
        requestedAt: admittedAt,
        admittedAt,
      },
    });
    await prisma.bed.update({ where: { id: bed.id }, data: { status: 'OCCUPIED' } });
  }

  // Emergency cases waiting in the department right now.
  for (let i = 0; i < 5; i++) {
    await prisma.emergencyCase.create({
      data: {
        hospitalId: hospital.id,
        patientId: pick(patients).id,
        triage: pick(['CRITICAL', 'HIGH', 'MEDIUM', 'MEDIUM', 'LOW']),
        complaint: pick(['Road traffic accident — multiple injuries', 'Severe chest pain', 'High-grade fever with seizure',
          'Fall from height', 'Acute breathlessness']),
        status: 'REGISTERED',
        arrivedAt: new Date(Date.now() - intBetween(10, 300) * 60_000),
      },
    });
  }

  // Scheduled surgeries for the OT board.
  const rooms = await prisma.operatingRoom.findMany({ where: { hospitalId: hospital.id } });
  const admissions = await prisma.admission.findMany({ where: { hospitalId: hospital.id, status: 'ADMITTED' }, take: 8 });
  for (const [i, admission] of admissions.entries()) {
    const scheduledAt = addDays(today, Math.floor(i / 2));
    scheduledAt.setHours(9 + (i % 4) * 2, 0, 0, 0);
    await prisma.surgery.create({
      data: {
        operatingRoomId: rooms[i % rooms.length].id,
        admissionId: admission.id,
        surgeonId: admission.doctorId,
        procedure: pick(['Appendicectomy', 'Total knee replacement', 'Laparoscopic cholecystectomy', 'Caesarean section', 'Angioplasty']),
        scheduledAt,
        durationMinutes: intBetween(60, 180),
        charge: intBetween(25000, 180000),
        status: 'SCHEDULED',
      },
    });
  }
}

// Two years of daily operational history with a weekly cycle, an annual season,
// a slow upward trend and correlated resource use — this is what the forecasting
// models are trained and scored on.
async function seedResourceHistory(hospitalId, bedRows, scale = 1) {
  const totalBeds = bedRows ? bedRows.filter((b) => b.type !== 'ICU').length : 80;
  const totalIcu = bedRows ? bedRows.filter((b) => b.type === 'ICU').length : 15;

  // Mon-Sat busy, Sunday quiet — the pattern every OPD register shows.
  const weekdayFactor = [0.55, 1.18, 1.1, 1.06, 1.04, 1.09, 0.92];
  const today = atMidnight(new Date());
  const rows = [];

  let occupancy = 0.7; // carries over day to day, the way real occupancy does
  let icuOccupancy = 0.75;

  for (let i = HISTORY_DAYS; i >= 1; i--) {
    const date = addDays(today, -i);
    const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / dayMs);

    // Winter respiratory season peaks around January, plus a slow growth trend.
    const seasonal = 1 + 0.18 * Math.cos((2 * Math.PI * (dayOfYear - 15)) / 365);
    const trend = 1 + ((HISTORY_DAYS - i) / HISTORY_DAYS) * 0.12;
    const festivalDip = [0, 1, 2].includes(date.getDate()) && date.getMonth() === 10 ? 0.7 : 1;

    const opdVisits = Math.max(
      20,
      Math.round(410 * scale * weekdayFactor[date.getDay()] * seasonal * trend * festivalDip + gauss(0, 22 * scale)),
    );
    const ipdAdmissions = Math.max(0, Math.round(opdVisits * 0.11 * between(0.85, 1.15)));
    const discharges = Math.max(0, Math.round(ipdAdmissions * between(0.85, 1.12)));

    // Occupancy drifts with the admission/discharge balance and is pulled back
    // toward a comfortable level, so it neither runs away nor sits flat.
    occupancy += ((ipdAdmissions - discharges) / totalBeds) + (0.72 - occupancy) * 0.08 + gauss(0, 0.012);
    occupancy = Math.min(0.99, Math.max(0.35, occupancy));

    icuOccupancy += (seasonal - 1) * 0.06 + (0.78 - icuOccupancy) * 0.1 + gauss(0, 0.02);
    icuOccupancy = Math.min(0.99, Math.max(0.4, icuOccupancy));

    const occupiedBeds = Math.round(occupancy * totalBeds);
    const occupiedIcuBeds = Math.round(icuOccupancy * totalIcu);
    const otCases = Math.max(0, Math.round((date.getDay() === 0 ? 3 : 12) * scale * seasonal + gauss(0, 2.5)));

    // Oxygen tracks ICU load far more than headcount does.
    const oxygenUnits = Math.round((occupiedIcuBeds * 11 + occupiedBeds * 1.3 + gauss(0, 14)) * 10) / 10;

    const bloodUnits = Math.max(0, Math.round(otCases * 1.8 + ipdAdmissions * 0.22 + gauss(0, 3)));
    const bloodByGroup = {};
    let assigned = 0;
    const groups = Object.entries(BLOOD_GROUP_MIX);
    groups.forEach(([group, share], idx) => {
      const units = idx === groups.length - 1 ? bloodUnits - assigned : Math.round(bloodUnits * share);
      bloodByGroup[group] = Math.max(0, units);
      assigned += bloodByGroup[group];
    });

    rows.push({
      hospitalId,
      date,
      opdVisits,
      ipdAdmissions,
      discharges,
      occupiedBeds,
      totalBeds,
      occupiedIcuBeds,
      totalIcuBeds: totalIcu,
      otCases,
      oxygenUnits: Math.max(0, oxygenUnits),
      bloodUnits,
      bloodByGroup: JSON.stringify(bloodByGroup),
      revenue: Math.round((opdVisits * 620 + ipdAdmissions * 14500 + otCases * 48000) * between(0.9, 1.1)),
      source: 'SYNTHETIC',
    });
  }

  // Chunked because SQLite has a hard limit on variables per statement.
  for (let i = 0; i < rows.length; i += 200) {
    await prisma.hospitalResourceDaily.createMany({ data: rows.slice(i, i + 200) });
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
