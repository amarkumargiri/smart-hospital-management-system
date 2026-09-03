import { prisma } from '../db.js';

// Turns a day of operational activity into the single row the forecasting models
// train on. Runs once per day per hospital; re-running for the same date
// overwrites rather than duplicates.
export async function captureDailySnapshot(hospitalId, date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const [opdVisits, ipdAdmissions, discharges, otCases, beds, dispensedOxygen, bloodItems, payments] = await Promise.all([
    prisma.appointment.count({
      where: { hospitalId, scheduledAt: { gte: start, lt: end }, status: { in: ['COMPLETED', 'IN_CONSULTATION', 'CHECKED_IN'] } },
    }),
    prisma.admission.count({ where: { hospitalId, admittedAt: { gte: start, lt: end } } }),
    prisma.admission.count({ where: { hospitalId, dischargedAt: { gte: start, lt: end } } }),
    prisma.surgery.count({
      where: { operatingRoom: { hospitalId }, scheduledAt: { gte: start, lt: end }, status: { in: ['COMPLETED', 'IN_PROGRESS'] } },
    }),
    prisma.bed.groupBy({ by: ['type', 'status'], where: { hospitalId }, _count: { _all: true } }),
    // Oxygen is tracked as a pharmacy item; if the hospital does not stock it
    // that way the row stays 0 and the metric simply has no signal.
    prisma.dispenseRecord.aggregate({
      where: { dispensedAt: { gte: start, lt: end }, medicine: { hospitalId, name: { contains: 'Oxygen' } } },
      _sum: { quantity: true },
    }),
    prisma.dispenseRecord.findMany({
      where: { dispensedAt: { gte: start, lt: end }, medicine: { hospitalId, name: { contains: 'Blood' } } },
      include: { medicine: { select: { name: true, strength: true } } },
    }),
    prisma.payment.aggregate({
      where: { status: 'PAID', paidAt: { gte: start, lt: end }, bill: { hospitalId } },
      _sum: { amount: true },
    }),
  ]);

  let totalBeds = 0;
  let occupiedBeds = 0;
  let totalIcuBeds = 0;
  let occupiedIcuBeds = 0;
  for (const row of beds) {
    const n = row._count._all;
    if (row.type === 'ICU') {
      totalIcuBeds += n;
      if (row.status === 'OCCUPIED') occupiedIcuBeds += n;
    } else {
      totalBeds += n;
      if (row.status === 'OCCUPIED') occupiedBeds += n;
    }
  }

  // Blood stock is named "Blood <group>" with the group in `strength`.
  const bloodByGroup = {};
  let bloodUnits = 0;
  for (const d of bloodItems) {
    const group = d.medicine.strength || 'UNKNOWN';
    bloodByGroup[group] = (bloodByGroup[group] || 0) + d.quantity;
    bloodUnits += d.quantity;
  }

  const data = {
    hospitalId,
    date: start,
    opdVisits,
    ipdAdmissions,
    discharges,
    occupiedBeds,
    totalBeds,
    occupiedIcuBeds,
    totalIcuBeds,
    otCases,
    oxygenUnits: dispensedOxygen._sum.quantity || 0,
    bloodUnits,
    bloodByGroup: JSON.stringify(bloodByGroup),
    revenue: payments._sum.amount || 0,
    source: 'OPERATIONAL',
  };

  return prisma.hospitalResourceDaily.upsert({
    where: { hospitalId_date: { hospitalId, date: start } },
    create: data,
    update: data,
  });
}

export async function captureAllHospitals(date = new Date()) {
  const hospitals = await prisma.hospital.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
  return Promise.all(hospitals.map((h) => captureDailySnapshot(h.id, date)));
}
