import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { HttpError } from './lib/http.js';
import { prisma } from './db.js';

import admissionRoutes from './routes/admissions.js';
import analyticsRoutes from './routes/analytics.js';
import appointmentRoutes from './routes/appointments.js';
import authRoutes from './routes/auth.js';
import bedRoutes from './routes/beds.js';
import billingRoutes from './routes/billing.js';
import consultationRoutes from './routes/consultations.js';
import doctorRoutes from './routes/doctors.js';
import documentRoutes from './routes/documents.js';
import emergencyRoutes from './routes/emergency.js';
import fileRoutes from './routes/files.js';
import forecastRoutes from './routes/forecast.js';
import hospitalRoutes from './routes/hospitals.js';
import labRoutes from './routes/lab.js';
import notificationRoutes from './routes/notifications.js';
import otRoutes from './routes/ot.js';
import patientRoutes from './routes/patients.js';
import pharmacyRoutes from './routes/pharmacy.js';
import prescriptionRoutes from './routes/prescriptions.js';

const app = express();

app.set('trust proxy', 1); // rate limiting and audit logs need the real client IP
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/hospitals', hospitalRoutes);
app.use('/api/doctors', doctorRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/consultations', consultationRoutes);
app.use('/api/prescriptions', prescriptionRoutes);
app.use('/api/lab', labRoutes);
app.use('/api/pharmacy', pharmacyRoutes);
app.use('/api/beds', bedRoutes);
app.use('/api/admissions', admissionRoutes);
app.use('/api/ot', otRoutes);
app.use('/api/emergency', emergencyRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/forecast', forecastRoutes);

app.use((_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));

// Single error surface: known HttpErrors keep their message, Prisma's
// constraint errors get a readable one, everything else is logged and hidden.
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err?.code === 'P2002') {
    return res.status(409).json({ error: 'A record with these details already exists.' });
  }
  if (err?.code === 'P2025') {
    return res.status(404).json({ error: 'Not found.' });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is too large. The limit is 15 MB.' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () => console.log(`API listening on http://localhost:${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

export default app;
