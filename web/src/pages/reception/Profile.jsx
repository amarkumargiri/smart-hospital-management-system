import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Badge, Card, ErrorNote, Loading, Stat } from '../../components/ui.jsx';

export default function HospitalProfile() {
  const { user } = useAuth();
  const hospitalId = user?.staff?.hospitalId;
  const [hospital, setHospital] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!hospitalId) return;
    api.get(`/hospitals/${hospitalId}`)
      .then((h) => {
        setHospital(h);
        setForm({
          name: h.name, email: h.email, phone: h.phone, addressLine: h.addressLine,
          city: h.city, state: h.state, pincode: h.pincode, openingHours: h.openingHours,
          hasEmergency: h.hasEmergency, hasLab: h.hasLab, hasPharmacy: h.hasPharmacy,
          type: h.type,
        });
      })
      .catch(setError);
  }, [hospitalId]);

  if (error && !hospital) return <ErrorNote error={error} />;
  if (!form) return <Loading />;

  const set = (key) => (e) =>
    setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      setHospital({ ...hospital, ...(await api.put(`/hospitals/${hospitalId}`, form)) });
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="row between">
        <h1>Hospital profile</h1>
        <Badge value={hospital.status} />
      </div>

      <div className="grid cols-4">
        <Stat label="Total beds" value={hospital.totalBeds} />
        <Stat label="ICU capacity" value={hospital.icuCapacity} />
        <Stat label="Operation theatres" value={hospital.otCount} />
        <Stat label="Rating" value={`★ ${hospital.rating}`} hint={`${hospital.ratingCount} ratings`} />
      </div>

      <Card title="Details">
        <form onSubmit={save}>
          <div className="grid cols-2">
            <div className="field"><label>Hospital name</label><input value={form.name} onChange={set('name')} /></div>
            <div className="field">
              <label>Type</label>
              <select value={form.type} onChange={set('type')}>
                {['PRIVATE', 'GOVERNMENT', 'TRUST', 'CLINIC'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="field"><label>Contact email</label><input type="email" value={form.email} onChange={set('email')} /></div>
            <div className="field"><label>Contact phone</label><input value={form.phone} onChange={set('phone')} /></div>
          </div>
          <div className="field"><label>Address</label><input value={form.addressLine} onChange={set('addressLine')} /></div>
          <div className="grid cols-4">
            <div className="field"><label>City</label><input value={form.city} onChange={set('city')} /></div>
            <div className="field"><label>State</label><input value={form.state} onChange={set('state')} /></div>
            <div className="field"><label>PIN code</label><input value={form.pincode} onChange={set('pincode')} /></div>
            <div className="field"><label>Opening hours</label><input value={form.openingHours} onChange={set('openingHours')} /></div>
          </div>
          <div className="row" style={{ marginBottom: '1rem' }}>
            <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={form.hasEmergency} onChange={set('hasEmergency')} /> Emergency services</label>
            <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={form.hasLab} onChange={set('hasLab')} /> Laboratory</label>
            <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={form.hasPharmacy} onChange={set('hasPharmacy')} /> Pharmacy</label>
          </div>
          <ErrorNote error={error} />
          {saved && <div className="alert ok">Hospital profile updated.</div>}
          <button disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        </form>
        <p className="small muted" style={{ marginTop: '.8rem' }}>
          Bed and ICU capacity are maintained from the Beds screen and update automatically.
          The registration number is fixed after verification.
        </p>
      </Card>

      <Card title="Departments">
        <div className="row">
          {hospital.departments.map((d) => <span key={d.id} className="badge info">{d.name} · {d.code}</span>)}
        </div>
      </Card>
    </div>
  );
}
