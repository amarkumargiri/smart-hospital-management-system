import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Card, ErrorNote } from '../components/ui.jsx';

const DEFAULT_DEPARTMENTS = [
  { name: 'General Medicine', code: 'MED' },
  { name: 'Emergency Medicine', code: 'EMER' },
];

export default function RegisterHospital() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: '', registrationNumber: '', type: 'PRIVATE', email: '', phone: '',
    addressLine: '', city: '', state: '', pincode: '',
    totalBeds: 50, icuCapacity: 10, otCount: 2, hasEmergency: true,
    adminName: '', adminEmail: '', adminMobile: '', adminPassword: '',
  });
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) =>
    setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/hospitals', {
        name: form.name,
        registrationNumber: form.registrationNumber,
        type: form.type,
        email: form.email,
        phone: form.phone,
        addressLine: form.addressLine,
        city: form.city,
        state: form.state,
        pincode: form.pincode,
        totalBeds: Number(form.totalBeds),
        icuCapacity: Number(form.icuCapacity),
        otCount: Number(form.otCount),
        hasEmergency: form.hasEmergency,
        departments: DEFAULT_DEPARTMENTS,
        admin: {
          fullName: form.adminName,
          email: form.adminEmail,
          mobile: form.adminMobile,
          password: form.adminPassword,
        },
      });
      setDone(res);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="auth">
        <div className="auth-card">
          <Card title="Hospital created">
            <div className="alert ok">{done.message}</div>
            <p className="small muted" style={{ marginTop: '.8rem' }}>
              {done.name} is live. The reception account can sign in now to add departments, beds,
              doctors and stock.
            </p>
            <button style={{ width: '100%' }} onClick={() => navigate('/login')}>Go to sign in</button>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <div className="auth-card" style={{ maxWidth: 560 }}>
        <Card title="Register a hospital">
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="name">Hospital name</label>
              <input id="name" value={form.name} onChange={set('name')} required minLength={3} />
            </div>
            <div className="grid cols-2">
              <div className="field">
                <label htmlFor="reg">Registration number</label>
                <input id="reg" value={form.registrationNumber} onChange={set('registrationNumber')} required />
              </div>
              <div className="field">
                <label htmlFor="type">Hospital type</label>
                <select id="type" value={form.type} onChange={set('type')}>
                  <option value="PRIVATE">Private</option>
                  <option value="GOVERNMENT">Government</option>
                  <option value="TRUST">Trust</option>
                  <option value="CLINIC">Clinic</option>
                </select>
              </div>
            </div>
            <div className="grid cols-2">
              <div className="field">
                <label htmlFor="email">Contact email</label>
                <input id="email" type="email" value={form.email} onChange={set('email')} required />
              </div>
              <div className="field">
                <label htmlFor="phone">Contact phone</label>
                <input id="phone" value={form.phone} onChange={set('phone')} required minLength={8} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="addr">Address</label>
              <input id="addr" value={form.addressLine} onChange={set('addressLine')} required />
            </div>
            <div className="grid cols-3">
              <div className="field">
                <label htmlFor="city">City</label>
                <input id="city" value={form.city} onChange={set('city')} required />
              </div>
              <div className="field">
                <label htmlFor="state">State</label>
                <input id="state" value={form.state} onChange={set('state')} required />
              </div>
              <div className="field">
                <label htmlFor="pin">PIN code</label>
                <input id="pin" value={form.pincode} onChange={set('pincode')} required />
              </div>
            </div>
            <div className="grid cols-3">
              <div className="field">
                <label htmlFor="beds">Total beds</label>
                <input id="beds" type="number" min="0" value={form.totalBeds} onChange={set('totalBeds')} />
              </div>
              <div className="field">
                <label htmlFor="icu">ICU capacity</label>
                <input id="icu" type="number" min="0" value={form.icuCapacity} onChange={set('icuCapacity')} />
              </div>
              <div className="field">
                <label htmlFor="ot">Operation theatres</label>
                <input id="ot" type="number" min="0" value={form.otCount} onChange={set('otCount')} />
              </div>
            </div>
            <label className="row small" style={{ marginBottom: '1rem' }}>
              <input type="checkbox" checked={form.hasEmergency} onChange={set('hasEmergency')} style={{ width: 'auto' }} />
              Emergency services available 24x7
            </label>

            <h3>Reception account</h3>
            <div className="grid cols-2">
              <div className="field">
                <label htmlFor="an">Full name</label>
                <input id="an" value={form.adminName} onChange={set('adminName')} required />
              </div>
              <div className="field">
                <label htmlFor="am">Mobile</label>
                <input id="am" value={form.adminMobile} onChange={set('adminMobile')} required minLength={8} />
              </div>
            </div>
            <div className="grid cols-2">
              <div className="field">
                <label htmlFor="ae">Email</label>
                <input id="ae" type="email" value={form.adminEmail} onChange={set('adminEmail')} required />
              </div>
              <div className="field">
                <label htmlFor="ap">Password</label>
                <input id="ap" type="password" value={form.adminPassword} onChange={set('adminPassword')} required minLength={8} />
              </div>
            </div>

            <ErrorNote error={error} />
            <button style={{ width: '100%', marginTop: '.6rem' }} disabled={busy}>
              {busy ? 'Creating…' : 'Create hospital'}
            </button>
            <p className="small muted" style={{ marginTop: '.8rem' }}>
              <Link to="/login">Back to sign in</Link>
            </p>
          </form>
        </Card>
      </div>
    </div>
  );
}
