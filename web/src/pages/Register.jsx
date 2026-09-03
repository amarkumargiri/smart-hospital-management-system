import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { HOME_FOR_ROLE } from '../auth.jsx';
import { Card, ErrorNote } from '../components/ui.jsx';

const BLOOD_GROUPS = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];

export default function Register() {
  const { verifyOtp } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    fullName: '', email: '', mobile: '', password: '',
    dateOfBirth: '', gender: '', bloodGroup: '', addressLine: '', city: '', state: '', pincode: '',
    emergencyName: '', emergencyPhone: '',
  });
  const [pending, setPending] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        ...form,
        // The date input gives a plain date; the API wants a full timestamp.
        dateOfBirth: form.dateOfBirth ? new Date(form.dateOfBirth).toISOString() : undefined,
        gender: form.gender || undefined,
        bloodGroup: form.bloodGroup || undefined,
      };
      const res = await api.post('/auth/register', payload);
      setPending(res);
      if (res.devOtp) setCode(res.devOtp);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await verifyOtp({ userId: pending.userId, code, purpose: 'SIGNUP' });
      navigate(HOME_FOR_ROLE[me?.role] || '/app', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <Card title={pending ? 'Verify your account' : 'Create a patient account'}>
          {pending ? (
            <form onSubmit={confirm}>
              <p className="small muted">{pending.message}</p>
              <div className="field">
                <label htmlFor="code">6-digit code</label>
                <input id="code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} inputMode="numeric" required />
              </div>
              <ErrorNote error={error} />
              <button style={{ width: '100%', marginTop: '.6rem' }} disabled={busy}>{busy ? 'Verifying…' : 'Verify and continue'}</button>
            </form>
          ) : (
            <form onSubmit={submit}>
              <div className="field">
                <label htmlFor="fullName">Full name</label>
                <input id="fullName" value={form.fullName} onChange={set('fullName')} required minLength={2} />
              </div>
              <div className="grid cols-2">
                <div className="field">
                  <label htmlFor="email">Email</label>
                  <input id="email" type="email" value={form.email} onChange={set('email')} required />
                </div>
                <div className="field">
                  <label htmlFor="mobile">Mobile</label>
                  <input id="mobile" value={form.mobile} onChange={set('mobile')} required minLength={8} maxLength={15} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="password">Password (at least 8 characters)</label>
                <input id="password" type="password" value={form.password} onChange={set('password')} required minLength={8} />
              </div>
              <div className="grid cols-3">
                <div className="field">
                  <label htmlFor="dob">Date of birth</label>
                  <input id="dob" type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} />
                </div>
                <div className="field">
                  <label htmlFor="gender">Gender</label>
                  <select id="gender" value={form.gender} onChange={set('gender')}>
                    <option value="">Prefer not to say</option>
                    <option value="MALE">Male</option>
                    <option value="FEMALE">Female</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="blood">Blood group</label>
                  <select id="blood" value={form.bloodGroup} onChange={set('bloodGroup')}>
                    <option value="">Unknown</option>
                    {BLOOD_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor="address">Address</label>
                <input id="address" value={form.addressLine} onChange={set('addressLine')} />
              </div>
              <div className="grid cols-3">
                <div className="field">
                  <label htmlFor="city">City</label>
                  <input id="city" value={form.city} onChange={set('city')} />
                </div>
                <div className="field">
                  <label htmlFor="state">State</label>
                  <input id="state" value={form.state} onChange={set('state')} />
                </div>
                <div className="field">
                  <label htmlFor="pincode">PIN code</label>
                  <input id="pincode" value={form.pincode} onChange={set('pincode')} />
                </div>
              </div>
              <div className="grid cols-2">
                <div className="field">
                  <label htmlFor="ecName">Emergency contact name</label>
                  <input id="ecName" value={form.emergencyName} onChange={set('emergencyName')} />
                </div>
                <div className="field">
                  <label htmlFor="ecPhone">Emergency contact phone</label>
                  <input id="ecPhone" value={form.emergencyPhone} onChange={set('emergencyPhone')} />
                </div>
              </div>
              <ErrorNote error={error} />
              <button style={{ width: '100%', marginTop: '.6rem' }} disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
              <p className="small muted" style={{ marginTop: '.8rem' }}>
                Already registered? <Link to="/login">Sign in</Link>
              </p>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
