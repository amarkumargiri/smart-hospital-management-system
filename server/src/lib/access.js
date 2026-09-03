import { prisma } from '../db.js';
import { forbidden } from './http.js';
import { ROLES } from '../constants.js';

// PRD section 52: a doctor does not automatically see every patient. Access is
// role + hospital + an actual doctor-patient relationship.
//
// A relationship exists if the doctor has an appointment, consultation,
// admission, lab order or prescription with that patient. The receptionist sees
// patients who have a record at their own hospital, and only through the
// endpoints their role allows.
export async function canAccessPatient(user, patientId) {
  if (!patientId) return false;
  if (user.role === ROLES.PATIENT) return user.patientId === patientId;

  if (user.role === ROLES.DOCTOR) {
    const [appointment, admission, order, prescription] = await Promise.all([
      prisma.appointment.findFirst({ where: { doctorId: user.doctorId, patientId }, select: { id: true } }),
      prisma.admission.findFirst({ where: { doctorId: user.doctorId, patientId }, select: { id: true } }),
      prisma.labOrder.findFirst({ where: { doctorId: user.doctorId, patientId }, select: { id: true } }),
      prisma.prescription.findFirst({ where: { doctorId: user.doctorId, patientId }, select: { id: true } }),
    ]);
    return Boolean(appointment || admission || order || prescription);
  }

  if (user.hospitalId) {
    const [appointment, admission, order, emergency] = await Promise.all([
      prisma.appointment.findFirst({ where: { hospitalId: user.hospitalId, patientId }, select: { id: true } }),
      prisma.admission.findFirst({ where: { hospitalId: user.hospitalId, patientId }, select: { id: true } }),
      prisma.labOrder.findFirst({ where: { hospitalId: user.hospitalId, patientId }, select: { id: true } }),
      prisma.emergencyCase.findFirst({ where: { hospitalId: user.hospitalId, patientId }, select: { id: true } }),
    ]);
    return Boolean(appointment || admission || order || emergency);
  }

  return false;
}

export async function assertPatientAccess(user, patientId) {
  if (!(await canAccessPatient(user, patientId))) {
    throw forbidden('You do not have permission to access this record.');
  }
}
