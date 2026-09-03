import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { Async, Card, Table, fmtDateTime, useApi } from '../../components/ui.jsx';

// A doctor's patient list is derived from the appointments they have had, which
// is exactly the relationship that grants them record access.
export default function DoctorPatients() {
  const [search, setSearch] = useState('');
  const query = useApi(() => api.get('/appointments', { pageSize: 200 }), []);

  const patients = useMemo(() => {
    const map = new Map();
    for (const a of query.data?.items || []) {
      const existing = map.get(a.patientId);
      if (!existing || new Date(a.scheduledAt) > new Date(existing.lastVisit)) {
        map.set(a.patientId, {
          id: a.patientId,
          name: a.patient.user.fullName,
          mobile: a.patient.user.mobile,
          lastVisit: a.scheduledAt,
          visits: (existing?.visits || 0) + 1,
        });
      } else {
        existing.visits += 1;
      }
    }
    const list = [...map.values()].sort((a, b) => new Date(b.lastVisit) - new Date(a.lastVisit));
    const term = search.trim().toLowerCase();
    return term ? list.filter((p) => p.name.toLowerCase().includes(term) || p.mobile.includes(term)) : list;
  }, [query.data, search]);

  return (
    <div className="stack">
      <h1>My patients</h1>

      <Card action={<input placeholder="Search by name or mobile" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} />}>
        <Async query={query} empty="No patients yet.">
          {() => (
            <Table
              rows={patients}
              empty="No patients match that search."
              columns={[
                { key: 'name', header: 'Patient', render: (p) => <Link to={`/doctor/patients/${p.id}`}>{p.name}</Link> },
                { key: 'mobile', header: 'Contact' },
                { key: 'visits', header: 'Visits', num: true },
                { key: 'lastVisit', header: 'Last appointment', render: (p) => fmtDateTime(p.lastVisit) },
                { key: 'actions', header: '', render: (p) => <Link to={`/doctor/patients/${p.id}`}><button className="small ghost">Open record</button></Link> },
              ]}
            />
          )}
        </Async>
      </Card>
    </div>
  );
}
