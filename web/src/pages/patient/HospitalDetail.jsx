import { Link, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { Async, Badge, Card, Stat, money, useApi } from '../../components/ui.jsx';

export default function HospitalDetail() {
  const { id } = useParams();
  const query = useApi(() => api.get(`/hospitals/${id}`), [id]);

  return (
    <Async query={query}>
      {(h) => (
        <div className="stack">
          <div className="row between">
            <div>
              <h1 style={{ marginBottom: '.2rem' }}>{h.name}</h1>
              <div className="muted small">{h.addressLine}, {h.city}, {h.state} {h.pincode} · {h.phone}</div>
            </div>
            <div className="row">
              <span className="badge info">★ {h.rating} ({h.ratingCount})</span>
              <Badge value={h.status} />
            </div>
          </div>

          <div className="grid cols-4">
            <Stat label="Beds available" value={`${h.availability.availableBeds} / ${h.availability.totalBeds}`} percent={h.availability.bedOccupancyPct} hint={`${h.availability.bedOccupancyPct}% occupied`} />
            <Stat label="ICU available" value={`${h.availability.availableIcu} / ${h.availability.totalIcu}`} percent={h.availability.icuOccupancyPct} hint={`${h.availability.icuOccupancyPct}% occupied`} />
            <Stat label="Ventilators free" value={h.availability.ventilators} />
            <Stat label="Operating hours" value={h.openingHours} hint={h.hasEmergency ? 'Emergency available' : 'No emergency service'} />
          </div>

          <div className="grid cols-2">
            <Card title="Departments">
              <div className="row">
                {h.departments.map((d) => <span key={d.id} className="badge">{d.name}</span>)}
              </div>
            </Card>
            <Card title="Facilities">
              <div className="row">
                {h.hasEmergency && <Badge value="Emergency" tone="danger" />}
                {h.hasLab && <span className="badge">Laboratory</span>}
                {h.hasPharmacy && <span className="badge">Pharmacy</span>}
                <span className="badge">{h.otCount} operation theatres</span>
                <span className="badge">{h.type.toLowerCase()}</span>
              </div>
            </Card>
          </div>

          <Card title={`Doctors (${h.doctors.length})`}>
            <div className="grid cols-3">
              {h.doctors.map((d) => (
                <div key={d.id} className="list-item">
                  <div className="row between">
                    <strong>{d.user.fullName}</strong>
                    <span className="badge info">★ {d.rating}</span>
                  </div>
                  <div className="small muted">{d.specialization} · {d.department?.name}</div>
                  <div className="small">{d.experienceYears} years experience · {money(d.consultationFee)}</div>
                  <Link to={`/app/doctors/${d.id}`}>
                    <button className="small ghost" style={{ width: '100%', marginTop: '.4rem' }}>View & book</button>
                  </Link>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </Async>
  );
}
