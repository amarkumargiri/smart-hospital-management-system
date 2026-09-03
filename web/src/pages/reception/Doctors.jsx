import { useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Async, Badge, Card, ErrorNote, Table, money, useApi } from '../../components/ui.jsx';

export default function ReceptionDoctors() {
  const { user } = useAuth();
  const hospitalId = user?.staff?.hospitalId;
  const [error, setError] = useState(null);
  const query = useApi(() => api.get('/doctors', { hospitalId, pageSize: 100 }), [hospitalId], { skip: !hospitalId });

  async function setStatus(id, status) {
    setError(null);
    try {
      await api.post(`/doctors/${id}/verify`, { status });
      query.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="stack">
      <h1>Doctors</h1>

      <Card title="Doctors at this hospital">
        <ErrorNote error={error} />
        <Async query={query} empty="No doctors registered.">
          {(d) => (
            <Table
              rows={d.items}
              columns={[
                { key: 'name', header: 'Doctor', render: (x) => x.user.fullName },
                { key: 'specialization', header: 'Specialization' },
                { key: 'qualification', header: 'Qualification' },
                { key: 'department', header: 'Department', render: (x) => x.department?.name || '—' },
                { key: 'registrationNumber', header: 'Registration' },
                { key: 'experienceYears', header: 'Experience', num: true, render: (x) => `${x.experienceYears} yr` },
                { key: 'consultationFee', header: 'Fee', num: true, render: (x) => money(x.consultationFee) },
                { key: 'rating', header: 'Rating', num: true, render: (x) => `★ ${x.rating}` },
                { key: 'clinics', header: 'Clinic windows', num: true, render: (x) => x.availability.length },
                { key: 'status', header: 'Status', render: (x) => <Badge value={x.status} /> },
                {
                  key: 'actions',
                  header: '',
                  render: (x) => (
                    <span className="row">
                      {x.status !== 'ACTIVE' && <button className="small" onClick={() => setStatus(x.id, 'ACTIVE')}>Activate</button>}
                      {x.status === 'ACTIVE' && <button className="small ghost" onClick={() => setStatus(x.id, 'SUSPENDED')}>Suspend</button>}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Async>
      </Card>

      <Card title="Adding a doctor">
        <p className="small muted">
          Doctors register themselves from the public registration page and choose this hospital. They appear
          here as <strong>pending verification</strong> until activated above — an unverified doctor is not
          visible in search and cannot take appointments.
        </p>
      </Card>
    </div>
  );
}
