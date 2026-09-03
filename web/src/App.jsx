import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import { Loading } from './components/ui.jsx';
import { HOME_FOR_ROLE, useAuth } from './auth.jsx';

import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import RegisterHospital from './pages/RegisterHospital.jsx';

import PatientDashboard from './pages/patient/Dashboard.jsx';
import PatientAppointments from './pages/patient/Appointments.jsx';
import HospitalSearch from './pages/patient/HospitalSearch.jsx';
import HospitalDetail from './pages/patient/HospitalDetail.jsx';
import DoctorSearch from './pages/patient/DoctorSearch.jsx';
import DoctorDetail from './pages/patient/DoctorDetail.jsx';
import PatientRecords from './pages/patient/Records.jsx';
import PatientPrescriptions from './pages/patient/Prescriptions.jsx';
import PatientReports from './pages/patient/Reports.jsx';
import PatientBills from './pages/patient/Bills.jsx';
import PatientProfile from './pages/patient/Profile.jsx';

import DoctorDashboard from './pages/doctor/Dashboard.jsx';
import DoctorAppointments from './pages/doctor/Appointments.jsx';
import Consultation from './pages/doctor/Consultation.jsx';
import DoctorPatients from './pages/doctor/Patients.jsx';
import PatientRecord from './pages/shared/PatientRecord.jsx';
import DoctorLab from './pages/doctor/LabResults.jsx';
import DoctorAdmissions from './pages/doctor/Admissions.jsx';
import DoctorSchedule from './pages/doctor/Schedule.jsx';

import ReceptionDashboard from './pages/reception/Dashboard.jsx';
import Analytics from './pages/reception/Analytics.jsx';
import Forecasting from './pages/reception/Forecasting.jsx';
import Reports from './pages/reception/Reports.jsx';
import ReceptionAppointments from './pages/reception/Appointments.jsx';
import ReceptionPatients from './pages/reception/Patients.jsx';
import Beds from './pages/reception/Beds.jsx';
import Admissions from './pages/reception/Admissions.jsx';
import Emergency from './pages/reception/Emergency.jsx';
import OperationTheatres from './pages/reception/OperationTheatres.jsx';
import Laboratory from './pages/reception/Laboratory.jsx';
import Pharmacy from './pages/reception/Pharmacy.jsx';
import Billing from './pages/reception/Billing.jsx';
import ReceptionDoctors from './pages/reception/Doctors.jsx';
import ReceptionStaff from './pages/reception/Staff.jsx';
import HospitalProfile from './pages/reception/Profile.jsx';
import AuditLog from './pages/reception/AuditLog.jsx';

// Gate for an area of the app. A role that does not belong is sent to its own
// home rather than shown an error.
function Require({ role, children }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={HOME_FOR_ROLE[user.role] || '/login'} replace />;
  return children;
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/register-hospital" element={<RegisterHospital />} />

      {/* Patient */}
      <Route path="/app" element={<Require role="PATIENT"><Layout area="patient" /></Require>}>
        <Route index element={<PatientDashboard />} />
        <Route path="appointments" element={<PatientAppointments />} />
        <Route path="hospitals" element={<HospitalSearch />} />
        <Route path="hospitals/:id" element={<HospitalDetail />} />
        <Route path="doctors" element={<DoctorSearch />} />
        <Route path="doctors/:id" element={<DoctorDetail />} />
        <Route path="records" element={<PatientRecords />} />
        <Route path="prescriptions" element={<PatientPrescriptions />} />
        <Route path="reports" element={<PatientReports />} />
        <Route path="bills" element={<PatientBills />} />
        <Route path="profile" element={<PatientProfile />} />
      </Route>

      {/* Doctor */}
      <Route path="/doctor" element={<Require role="DOCTOR"><Layout area="doctor" /></Require>}>
        <Route index element={<DoctorDashboard />} />
        <Route path="appointments" element={<DoctorAppointments />} />
        <Route path="consultation/:appointmentId" element={<Consultation />} />
        <Route path="patients" element={<DoctorPatients />} />
        <Route path="patients/:patientId" element={<PatientRecord />} />
        <Route path="lab" element={<DoctorLab />} />
        <Route path="admissions" element={<DoctorAdmissions />} />
        <Route path="schedule" element={<DoctorSchedule />} />
      </Route>

      {/* Reception — the hospital desk: everything operational */}
      <Route path="/reception" element={<Require role="RECEPTIONIST"><Layout area="reception" /></Require>}>
        <Route index element={<ReceptionDashboard />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="forecasting" element={<Forecasting />} />
        <Route path="reports" element={<Reports />} />
        <Route path="appointments" element={<ReceptionAppointments />} />
        <Route path="patients" element={<ReceptionPatients />} />
        <Route path="patients/:patientId" element={<PatientRecord />} />
        <Route path="beds" element={<Beds />} />
        <Route path="admissions" element={<Admissions />} />
        <Route path="emergency" element={<Emergency />} />
        <Route path="ot" element={<OperationTheatres />} />
        <Route path="lab" element={<Laboratory />} />
        <Route path="pharmacy" element={<Pharmacy />} />
        <Route path="billing" element={<Billing />} />
        <Route path="doctors" element={<ReceptionDoctors />} />
        <Route path="staff" element={<ReceptionStaff />} />
        <Route path="profile" element={<HospitalProfile />} />
        <Route path="audit" element={<AuditLog />} />
      </Route>

      <Route
        path="*"
        element={loading ? <Loading /> : <Navigate to={user ? HOME_FOR_ROLE[user.role] || '/login' : '/login'} replace />}
      />
    </Routes>
  );
}
