import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Badge, fmtDateTime } from './ui.jsx';

// Navigation per role. Staff roles get the hospital menu trimmed to what their
// role can actually reach, so the sidebar never offers a 403.
const PATIENT_NAV = [
  { section: 'Care' },
  { to: '/app', label: 'Dashboard', end: true },
  { to: '/app/appointments', label: 'Appointments' },
  { to: '/app/hospitals', label: 'Find a hospital' },
  { to: '/app/doctors', label: 'Find a doctor' },
  { section: 'Records' },
  { to: '/app/records', label: 'Medical records' },
  { to: '/app/prescriptions', label: 'Prescriptions' },
  { to: '/app/reports', label: 'Lab reports' },
  { section: 'Account' },
  { to: '/app/bills', label: 'Bills & payments' },
  { to: '/app/profile', label: 'Profile' },
];

const DOCTOR_NAV = [
  { section: 'Clinic' },
  { to: '/doctor', label: 'Dashboard', end: true },
  { to: '/doctor/appointments', label: 'Appointments' },
  { to: '/doctor/patients', label: 'Patients' },
  { section: 'Clinical' },
  { to: '/doctor/lab', label: 'Lab results' },
  { to: '/doctor/admissions', label: 'Inpatients' },
  { to: '/doctor/schedule', label: 'My schedule' },
];

const RECEPTION_NAV = [
  { section: 'Overview' },
  { to: '/reception', label: 'Dashboard', end: true },
  { to: '/reception/analytics', label: 'Analytics' },
  { to: '/reception/forecasting', label: 'Forecasting' },
  { to: '/reception/reports', label: 'Reports' },
  { section: 'Operations' },
  { to: '/reception/appointments', label: 'Appointments' },
  { to: '/reception/patients', label: 'Patients' },
  { to: '/reception/beds', label: 'Beds & ICU' },
  { to: '/reception/admissions', label: 'Admissions' },
  { to: '/reception/emergency', label: 'Emergency' },
  { to: '/reception/ot', label: 'Operation theatres' },
  { section: 'Services' },
  { to: '/reception/lab', label: 'Laboratory' },
  { to: '/reception/pharmacy', label: 'Pharmacy' },
  { to: '/reception/billing', label: 'Billing' },
  { section: 'Administration' },
  { to: '/reception/doctors', label: 'Doctors' },
  { to: '/reception/staff', label: 'Reception staff' },
  { to: '/reception/profile', label: 'Hospital profile' },
  { to: '/reception/audit', label: 'Audit log' },
];

export const NAV_BY_AREA = { patient: PATIENT_NAV, doctor: DOCTOR_NAV, reception: RECEPTION_NAV };

export default function Layout({ area }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState({ unreadCount: 0, items: [] });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.get('/notifications', { limit: 12 })
      .then((n) => !cancelled && setNotifications(n))
      .catch(() => {});
    load();
    // Polling keeps this to one moving part; a websocket would be a second
    // transport to deploy and secure for a badge that can be a minute stale.
    const timer = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const items = NAV_BY_AREA[area] || [];

  async function markAllRead() {
    await api.post('/notifications/read-all');
    setNotifications({ unreadCount: 0, items: notifications.items.map((n) => ({ ...n, readAt: new Date().toISOString() })) });
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">+</span>
          <span>Smart Hospital</span>
        </div>
        {items.map((item, i) => item.section
          ? <div key={`s${i}`} className="nav-section">{item.section}</div>
          : (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              {item.label}
            </NavLink>
          ))}
        <div className="nav-spacer" />
        <button className="ghost small" onClick={async () => { await logout(); navigate('/login'); }}>Sign out</button>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <strong>{user?.fullName}</strong>
            <span className="muted small"> · {String(user?.role || '').replace(/_/g, ' ')}</span>
            {user?.doctor?.hospital?.name && <span className="muted small"> · {user.doctor.hospital.name}</span>}
            {user?.staff?.hospital?.name && <span className="muted small"> · {user.staff.hospital.name}</span>}
          </div>
          <div className="row" style={{ position: 'relative' }}>
            <button className="ghost small" onClick={() => setOpen(!open)}>
              Notifications {notifications.unreadCount > 0 && <span className="badge danger">{notifications.unreadCount}</span>}
            </button>
            {open && (
              <div className="card" style={{ position: 'absolute', right: 0, top: '2.4rem', width: 360, zIndex: 20, maxHeight: 420, overflowY: 'auto' }}>
                <div className="card-head">
                  <h3>Notifications</h3>
                  <button className="ghost small" onClick={markAllRead}>Mark all read</button>
                </div>
                {notifications.items.length === 0 && <div className="empty">Nothing new.</div>}
                <div className="list">
                  {notifications.items.map((n) => (
                    <div key={n.id} className="list-item" style={{ opacity: n.readAt ? 0.6 : 1 }}>
                      <div className="row between">
                        <strong className="small">{n.title}</strong>
                        <Badge value={n.severity} />
                      </div>
                      <div className="small">{n.body}</div>
                      <div className="small muted">{fmtDateTime(n.createdAt)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
