// Allowed values for the String columns that stand in for enums (SQLite has no
// enum type). Anything that reaches the database goes through these first.

// Three roles. The receptionist is the hospital desk: registration, scheduling,
// wards, laboratory, pharmacy, billing and the forecasting dashboard all sit
// with them, so a small hospital needs exactly one staff account type.
export const ROLES = {
  PATIENT: 'PATIENT',
  DOCTOR: 'DOCTOR',
  RECEPTIONIST: 'RECEPTIONIST',
};

export const APPOINTMENT_STATUS = {
  REQUESTED: 'REQUESTED',
  CONFIRMED: 'CONFIRMED',
  CHECKED_IN: 'CHECKED_IN',
  IN_CONSULTATION: 'IN_CONSULTATION',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  NO_SHOW: 'NO_SHOW',
};

// Which status can follow which. Enforced in the appointment routes so the
// lifecycle in the PRD cannot be short-circuited.
export const APPOINTMENT_TRANSITIONS = {
  REQUESTED: ['CONFIRMED', 'CANCELLED', 'REJECTED'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['IN_CONSULTATION', 'CANCELLED', 'NO_SHOW'],
  IN_CONSULTATION: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  REJECTED: [],
  NO_SHOW: [],
};

export const APPOINTMENT_TYPES = ['OPD', 'FOLLOW_UP', 'EMERGENCY', 'SPECIALIST', 'TELECONSULT'];

export const BED_STATUS = ['AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING', 'MAINTENANCE'];
export const BED_TYPES = ['GENERAL', 'ICU', 'ISOLATION', 'PRIVATE', 'EMERGENCY'];

export const ADMISSION_STATUS = {
  REQUESTED: 'REQUESTED',
  APPROVED: 'APPROVED',
  ADMITTED: 'ADMITTED',
  DISCHARGED: 'DISCHARGED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
};

export const LAB_ORDER_STATUS = {
  ORDERED: 'ORDERED',
  SAMPLE_COLLECTED: 'SAMPLE_COLLECTED',
  PROCESSING: 'PROCESSING',
  RESULT_ENTERED: 'RESULT_ENTERED',
  VERIFIED: 'VERIFIED',
  CANCELLED: 'CANCELLED',
};

export const LAB_TRANSITIONS = {
  ORDERED: ['SAMPLE_COLLECTED', 'CANCELLED'],
  SAMPLE_COLLECTED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['RESULT_ENTERED', 'CANCELLED'],
  RESULT_ENTERED: ['VERIFIED', 'PROCESSING'],
  VERIFIED: [],
  CANCELLED: [],
};

export const PAYMENT_METHODS = ['UPI', 'CARD', 'NETBANKING', 'CASH', 'INSURANCE'];
export const BILL_STATUS = ['PENDING', 'PAID', 'PARTIALLY_PAID', 'FAILED', 'REFUNDED', 'CANCELLED'];
export const BILL_CATEGORIES = [
  'CONSULTATION', 'ROOM', 'ICU', 'LAB', 'IMAGING', 'PHARMACY', 'PROCEDURE', 'DOCTOR_FEE', 'OTHER',
];

export const TRIAGE_LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export const BLOOD_GROUPS = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];

export const FORECAST_METRICS = ['OPD', 'IPD', 'BEDS', 'ICU', 'OT', 'OXYGEN', 'BLOOD'];
export const FORECAST_HORIZONS = [7, 14, 30];

export const AUDIT_ACTIONS = {
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  VIEW_MEDICAL_RECORD: 'VIEW_MEDICAL_RECORD',
  MODIFY_MEDICAL_RECORD: 'MODIFY_MEDICAL_RECORD',
  CREATE_PRESCRIPTION: 'CREATE_PRESCRIPTION',
  UPLOAD_REPORT: 'UPLOAD_REPORT',
  VERIFY_REPORT: 'VERIFY_REPORT',
  GENERATE_BILL: 'GENERATE_BILL',
  RECORD_PAYMENT: 'RECORD_PAYMENT',
  BLOCK_USER: 'BLOCK_USER',
  PERMISSION_CHANGED: 'PERMISSION_CHANGED',
  VERIFY_HOSPITAL: 'VERIFY_HOSPITAL',
  VERIFY_DOCTOR: 'VERIFY_DOCTOR',
  ADMIT_PATIENT: 'ADMIT_PATIENT',
  DISCHARGE_PATIENT: 'DISCHARGE_PATIENT',
  RUN_FORECAST: 'RUN_FORECAST',
  UPLOAD_DOCUMENT: 'UPLOAD_DOCUMENT',
  PROCESS_DOCUMENT: 'PROCESS_DOCUMENT',
  VIEW_DOCUMENT: 'VIEW_DOCUMENT',
  VERIFY_DOCUMENT: 'VERIFY_DOCUMENT',
};

// Capacity thresholds that trigger forecast alerts.
export const ALERT_THRESHOLDS = {
  ICU_OCCUPANCY_PCT: 90,
  BED_OCCUPANCY_PCT: 85,
  OXYGEN_INCREASE_PCT: 15,
  BLOOD_INCREASE_PCT: 20,
  MEDICINE_REORDER_MULTIPLIER: 1,
};

// ---------------------------------------------------------------------------
// Intelligent document processing — OCR + entity extraction
// ---------------------------------------------------------------------------

export const DOCUMENT_TYPES = [
  'LAB_REPORT',
  'PRESCRIPTION',
  'DISCHARGE_SUMMARY',
  'MEDICAL_CERTIFICATE',
  'CONSULTATION_NOTE',
  'RADIOLOGY_REPORT',
  'OTHER',
];

export const DOCUMENT_STATUS = {
  UPLOADED: 'UPLOADED',
  PROCESSING: 'PROCESSING',
  OCR_COMPLETED: 'OCR_COMPLETED',
  NLP_COMPLETED: 'NLP_COMPLETED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  VERIFIED: 'VERIFIED',
  SAVED: 'SAVED',
  REJECTED: 'REJECTED',
  OCR_FAILED: 'OCR_FAILED',
  NLP_FAILED: 'NLP_FAILED',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
};

// A document may only be reviewed once the pipeline has finished with it.
export const REVIEWABLE_STATUSES = [DOCUMENT_STATUS.REVIEW_REQUIRED, DOCUMENT_STATUS.NLP_COMPLETED];
export const FAILED_STATUSES = [
  DOCUMENT_STATUS.OCR_FAILED, DOCUMENT_STATUS.NLP_FAILED, DOCUMENT_STATUS.PROCESSING_FAILED,
];

export const ENTITY_TYPES = [
  // who the document is about
  'PATIENT_NAME', 'PATIENT_AGE', 'PATIENT_GENDER', 'PATIENT_ID',
  // clinical content
  'DIAGNOSIS', 'SYMPTOM', 'CONDITION', 'ALLERGY', 'PROCEDURE', 'TREATMENT',
  // medication, grouped per drug by groupKey
  'MEDICATION_NAME', 'MEDICATION_DOSAGE', 'MEDICATION_FREQUENCY',
  'MEDICATION_DURATION', 'MEDICATION_ROUTE', 'MEDICATION_INSTRUCTION',
  // laboratory, grouped per row by groupKey
  'LAB_TEST', 'LAB_VALUE', 'LAB_UNIT', 'LAB_REFERENCE_RANGE', 'LAB_FLAG',
  // provenance
  'DOCTOR_NAME', 'HOSPITAL_NAME', 'DEPARTMENT',
  'REPORT_DATE', 'PRESCRIPTION_DATE', 'FOLLOW_UP_DATE',
];

// Anything at or above AUTO can be pre-ticked for the reviewer; anything below
// REVIEW is surfaced as "please check this" rather than presented as a fact.
// Nothing is ever saved to the medical record without a human approving it.
export const CONFIDENCE = {
  AUTO: 0.85,
  REVIEW: 0.6,
};

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

export const DOCUMENT_MIME_TYPES = new Map([
  ['application/pdf', '.pdf'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);
