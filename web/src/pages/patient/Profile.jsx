import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Async, Card, ErrorNote, Table, fmtDate, money, useApi } from '../../components/ui.jsx';

const BLOOD_GROUPS = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];
const dateInput = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');

export default function PatientProfile() {
  const { user, reload } = useAuth();
  const patientId = user?.patient?.id;
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const insurance = useApi(() => api.get(`/billing/insurance/${patientId}`), [patientId], { skip: !patientId });
  const sessions = useApi(() => api.get('/auth/sessions'), []);

  useEffect(() => {
    if (!user?.patient) return;
    setForm({
      fullName: user.fullName,
      dateOfBirth: dateInput(user.patient.dateOfBirth),
      gender: user.patient.gender || '',
      bloodGroup: user.patient.bloodGroup || '',
      addressLine: user.patient.addressLine || '',
      city: user.patient.city || '',
      state: user.patient.state || '',
      pincode: user.patient.pincode || '',
      emergencyName: user.patient.emergencyName || '',
      emergencyPhone: user.patient.emergencyPhone || '',
    });
  }, [user]);

  if (!form) return null;
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.put(`/patients/${patientId}`, {
        ...form,
        dateOfBirth: form.dateOfBirth ? new Date(form.dateOfBirth).toISOString() : null,
        gender: form.gender || undefined,
      });
      await reload();
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function toggleMfa() {
    await api.post('/auth/mfa', { enabled: !user.mfaEnabled });
    await reload();
  }

  return (
    <div className="stack">
      <h1>My profile</h1>

      <Card title="Personal details">
        <form onSubmit={save}>
          <div className="grid cols-2">
            <div className="field"><label>Full name</label><input value={form.fullName} onChange={set('fullName')} required /></div>
            <div className="field"><label>Date of birth</label><input type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} /></div>
          </div>
          <div className="grid cols-2">
            <div className="field">
              <label>Gender</label>
              <select value={form.gender} onChange={set('gender')}>
                <option value="">Prefer not to say</option>
                <option value="MALE">Male</option><option value="FEMALE">Female</option><option value="OTHER">Other</option>
              </select>
            </div>
            <div className="field">
              <label>Blood group</label>
              <select value={form.bloodGroup} onChange={set('bloodGroup')}>
                <option value="">Unknown</option>
                {BLOOD_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          </div>
          <div className="field"><label>Address</label><input value={form.addressLine} onChange={set('addressLine')} /></div>
          <div className="grid cols-3">
            <div className="field"><label>City</label><input value={form.city} onChange={set('city')} /></div>
            <div className="field"><label>State</label><input value={form.state} onChange={set('state')} /></div>
            <div className="field"><label>PIN code</label><input value={form.pincode} onChange={set('pincode')} /></div>
          </div>
          <div className="grid cols-2">
            <div className="field"><label>Emergency contact name</label><input value={form.emergencyName} onChange={set('emergencyName')} /></div>
            <div className="field"><label>Emergency contact phone</label><input value={form.emergencyPhone} onChange={set('emergencyPhone')} /></div>
          </div>
          <ErrorNote error={error} />
          {saved && <div className="alert ok">Profile updated.</div>}
          <button style={{ marginTop: '.6rem' }} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        </form>
      </Card>

      <Card title="Clinical information">
        <div className="grid cols-2">
          <div><div className="stat-label">Allergies</div><div>{user.patient.allergies || 'None recorded'}</div></div>
          <div><div className="stat-label">Chronic conditions</div><div>{user.patient.chronicConditions || 'None recorded'}</div></div>
        </div>
        <p className="small muted" style={{ marginTop: '.7rem' }}>
          Allergies and chronic conditions are maintained by your treating clinician and cannot be edited here.
        </p>
      </Card>

      <Card title="Insurance">
        <Async query={insurance} empty="No insurance policy on file.">
          {(policies) => (
            <Table
              rows={policies}
              columns={[
                { key: 'provider', header: 'Provider' },
                { key: 'policyNumber', header: 'Policy number' },
                { key: 'coverageAmount', header: 'Coverage', num: true, render: (p) => money(p.coverageAmount) },
                { key: 'validTo', header: 'Valid until', render: (p) => fmtDate(p.validTo) },
                { key: 'claims', header: 'Claims', num: true, render: (p) => p.claims.length },
              ]}
            />
          )}
        </Async>
      </Card>

      <Card title="Security" action={<button className="ghost small" onClick={toggleMfa}>{user.mfaEnabled ? 'Disable' : 'Enable'} two-factor</button>}>
        <p className="small muted">
          Two-factor authentication is {user.mfaEnabled ? 'on' : 'off'}. When enabled, a verification code is
          required at every sign-in.
        </p>
        <Async query={sessions} empty="No other active sessions.">
          {(list) => (
            <Table
              rows={list}
              columns={[
                { key: 'device', header: 'Device', wrap: true, render: (s) => s.device || 'Unknown device' },
                { key: 'ipAddress', header: 'IP address' },
                { key: 'createdAt', header: 'Signed in', render: (s) => fmtDate(s.createdAt) },
                {
                  key: 'actions',
                  header: '',
                  render: (s) => (
                    <button className="small ghost" onClick={async () => { await api.del(`/auth/sessions/${s.id}`); sessions.reload(); }}>
                      Revoke
                    </button>
                  ),
                },
              ]}
            />
          )}
        </Async>
      </Card>
    </div>
  );
}
