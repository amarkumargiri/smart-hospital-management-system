import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { Async, Card, money, useApi } from '../../components/ui.jsx';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function DoctorSearch() {
  const [filters, setFilters] = useState({ q: '', specialty: '', city: '', minExperience: '', maxFee: '', availableOn: '' });
  const [applied, setApplied] = useState(filters);
  const query = useApi(() => api.get('/doctors', { ...applied, pageSize: 24 }), [applied]);

  const set = (key) => (e) => setFilters({ ...filters, [key]: e.target.value });

  return (
    <div className="stack">
      <h1>Find a doctor</h1>

      <Card>
        <form className="grid cols-4" onSubmit={(e) => { e.preventDefault(); setApplied(filters); }}>
          <div className="field"><label>Name or specialty</label><input value={filters.q} onChange={set('q')} placeholder="Cardiologist" /></div>
          <div className="field"><label>City</label><input value={filters.city} onChange={set('city')} placeholder="Pune" /></div>
          <div className="field"><label>Minimum experience</label>
            <select value={filters.minExperience} onChange={set('minExperience')}>
              <option value="">Any</option><option value="5">5+ years</option><option value="10">10+ years</option><option value="15">15+ years</option>
            </select>
          </div>
          <div className="field"><label>Maximum fee</label>
            <select value={filters.maxFee} onChange={set('maxFee')}>
              <option value="">Any</option><option value="500">₹500</option><option value="800">₹800</option><option value="1500">₹1,500</option>
            </select>
          </div>
          <div className="field"><label>Available on</label><input type="date" value={filters.availableOn} onChange={set('availableOn')} /></div>
          <div className="field" style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button style={{ width: '100%' }}>Search</button>
          </div>
        </form>
      </Card>

      <Async query={query} empty="No doctors match those filters.">
        {(d) => (
          <>
            <p className="small muted">{d.total} doctor(s) found.</p>
            <div className="grid cols-3">
              {d.items.map((doc) => {
                const days = [...new Set(doc.availability.map((a) => a.dayOfWeek))].sort();
                return (
                  <Card key={doc.id}>
                    <div className="row between">
                      <h3 style={{ margin: 0 }}>{doc.user.fullName}</h3>
                      <span className="badge info">★ {doc.rating}</span>
                    </div>
                    <div className="small muted">{doc.specialization}</div>
                    <div className="small" style={{ margin: '.35rem 0' }}>
                      {doc.qualification}<br />
                      {doc.experienceYears} years experience · {money(doc.consultationFee)}
                    </div>
                    <div className="small muted">{doc.hospital.name}, {doc.hospital.city}</div>
                    <div className="row small" style={{ margin: '.5rem 0' }}>
                      {days.map((day) => <span key={day} className="badge">{DAY_NAMES[day]}</span>)}
                    </div>
                    <Link to={`/app/doctors/${doc.id}`}>
                      <button className="small" style={{ width: '100%' }}>View profile & book</button>
                    </Link>
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </Async>
    </div>
  );
}
