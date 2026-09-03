import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { Async, Badge, Card, useApi } from '../../components/ui.jsx';

export default function HospitalSearch() {
  const [filters, setFilters] = useState({ q: '', city: '', specialty: '', emergency: '', availableToday: '', minRating: '', sort: 'rating' });
  const [applied, setApplied] = useState(filters);
  const query = useApi(() => api.get('/hospitals', { ...applied, pageSize: 24 }), [applied]);

  const set = (key) => (e) => setFilters({ ...filters, [key]: e.target.value });

  return (
    <div className="stack">
      <h1>Find a hospital</h1>

      <Card>
        <form
          className="grid cols-4"
          onSubmit={(e) => { e.preventDefault(); setApplied(filters); }}
        >
          <div className="field"><label>Search</label><input value={filters.q} onChange={set('q')} placeholder="Hospital name" /></div>
          <div className="field"><label>City</label><input value={filters.city} onChange={set('city')} placeholder="Pune" /></div>
          <div className="field"><label>Specialty</label><input value={filters.specialty} onChange={set('specialty')} placeholder="Cardiologist" /></div>
          <div className="field">
            <label>Minimum rating</label>
            <select value={filters.minRating} onChange={set('minRating')}>
              <option value="">Any</option><option value="3">3+</option><option value="4">4+</option><option value="4.5">4.5+</option>
            </select>
          </div>
          <div className="field">
            <label>Emergency</label>
            <select value={filters.emergency} onChange={set('emergency')}>
              <option value="">Any</option><option value="true">Emergency available</option>
            </select>
          </div>
          <div className="field">
            <label>Availability</label>
            <select value={filters.availableToday} onChange={set('availableToday')}>
              <option value="">Any</option><option value="true">Doctors available today</option>
            </select>
          </div>
          <div className="field">
            <label>Sort by</label>
            <select value={filters.sort} onChange={set('sort')}>
              <option value="rating">Rating</option><option value="name">Name</option>
            </select>
          </div>
          <div className="field" style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button style={{ width: '100%' }}>Search</button>
          </div>
        </form>
      </Card>

      <Async query={query} empty="No hospitals match those filters.">
        {(d) => (
          <>
            <p className="small muted">{d.total} hospital(s) found.</p>
            <div className="grid cols-3">
              {d.items.map((h) => (
                <Card key={h.id}>
                  <div className="row between">
                    <h3 style={{ margin: 0 }}>{h.name}</h3>
                    <span className="badge info">★ {h.rating}</span>
                  </div>
                  <p className="small muted" style={{ margin: '.3rem 0 .6rem' }}>
                    {h.addressLine}, {h.city} · {h.type.toLowerCase()}
                  </p>
                  <div className="row small" style={{ marginBottom: '.5rem' }}>
                    {h.hasEmergency && <Badge value="EMERGENCY 24x7" tone="danger" />}
                    {h.hasLab && <span className="badge">Laboratory</span>}
                    {h.hasPharmacy && <span className="badge">Pharmacy</span>}
                  </div>
                  <div className="small">
                    Beds available: <strong>{h.availability.availableBeds}</strong> / {h.availability.totalBeds}
                    {' · '}ICU: <strong>{h.availability.availableIcu}</strong> / {h.availability.totalIcu}
                  </div>
                  <div className="small muted" style={{ marginBottom: '.6rem' }}>
                    {h._count.doctors} doctors · {h.departments.length} departments
                  </div>
                  <Link to={`/app/hospitals/${h.id}`}><button className="small" style={{ width: '100%' }}>View hospital</button></Link>
                </Card>
              ))}
            </div>
          </>
        )}
      </Async>
    </div>
  );
}
