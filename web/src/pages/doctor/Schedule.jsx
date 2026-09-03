import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Card, ErrorNote, money } from '../../components/ui.jsx';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function DoctorSchedule() {
  const { user, reload } = useAuth();
  const doctorId = user?.doctor?.id;
  const [slots, setSlots] = useState([]);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!doctorId) return;
    api.get(`/doctors/${doctorId}/availability`).then(setSlots).catch(setError);
    setProfile({
      consultationFee: user.doctor.consultationFee,
      slotMinutes: user.doctor.slotMinutes,
      languages: user.doctor.languages,
      bio: user.doctor.bio || '',
      experienceYears: user.doctor.experienceYears,
      specialization: user.doctor.specialization,
      qualification: user.doctor.qualification,
    });
  }, [doctorId, user]);

  const addSlot = (dayOfWeek) =>
    setSlots([...slots, { dayOfWeek, startTime: '09:00', endTime: '13:00', isActive: true }]);

  const updateSlot = (index, key, value) =>
    setSlots(slots.map((s, i) => (i === index ? { ...s, [key]: value } : s)));

  async function saveAvailability() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const clean = slots.map(({ dayOfWeek, startTime, endTime, isActive }) => ({
        dayOfWeek: Number(dayOfWeek), startTime, endTime, isActive: isActive !== false,
      }));
      setSlots(await api.put(`/doctors/${doctorId}/availability`, { slots: clean }));
      setSaved('Availability updated.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await api.put(`/doctors/${doctorId}`, {
        ...profile,
        consultationFee: Number(profile.consultationFee),
        slotMinutes: Number(profile.slotMinutes),
        experienceYears: Number(profile.experienceYears),
      });
      await reload();
      setSaved('Profile updated.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!profile) return null;
  const set = (key) => (e) => setProfile({ ...profile, [key]: e.target.value });

  return (
    <div className="stack">
      <h1>My schedule & profile</h1>
      {saved && <div className="alert ok">{saved}</div>}
      <ErrorNote error={error} />

      <Card
        title="Weekly availability"
        action={<button className="small" onClick={saveAvailability} disabled={busy}>Save availability</button>}
      >
        <p className="small muted">
          Patients can only book inside these windows, in {profile.slotMinutes}-minute slots.
        </p>
        {DAY_NAMES.map((name, day) => (
          <div key={day} style={{ borderBottom: '1px solid var(--border)', padding: '.5rem 0' }}>
            <div className="row between">
              <strong className="small">{name}</strong>
              <button className="ghost small" onClick={() => addSlot(day)}>Add window</button>
            </div>
            {slots.map((s, i) => (Number(s.dayOfWeek) === day ? (
              <div key={i} className="row" style={{ marginTop: '.35rem' }}>
                <input type="time" value={s.startTime} onChange={(e) => updateSlot(i, 'startTime', e.target.value)} style={{ width: 130 }} />
                <span className="muted">to</span>
                <input type="time" value={s.endTime} onChange={(e) => updateSlot(i, 'endTime', e.target.value)} style={{ width: 130 }} />
                <button className="ghost small" onClick={() => setSlots(slots.filter((_, x) => x !== i))}>Remove</button>
              </div>
            ) : null))}
          </div>
        ))}
      </Card>

      <Card title="Professional profile" action={<button className="small" onClick={saveProfile} disabled={busy}>Save profile</button>}>
        <div className="grid cols-3">
          <div className="field"><label>Specialization</label><input value={profile.specialization} onChange={set('specialization')} /></div>
          <div className="field"><label>Qualification</label><input value={profile.qualification} onChange={set('qualification')} /></div>
          <div className="field"><label>Years of experience</label><input type="number" min="0" value={profile.experienceYears} onChange={set('experienceYears')} /></div>
          <div className="field"><label>Consultation fee ({money(profile.consultationFee)})</label><input type="number" min="0" value={profile.consultationFee} onChange={set('consultationFee')} /></div>
          <div className="field"><label>Slot length (minutes)</label><input type="number" min="5" max="120" value={profile.slotMinutes} onChange={set('slotMinutes')} /></div>
          <div className="field"><label>Languages</label><input value={profile.languages} onChange={set('languages')} /></div>
        </div>
        <div className="field"><label>About</label><textarea value={profile.bio} onChange={set('bio')} /></div>
      </Card>
    </div>
  );
}
