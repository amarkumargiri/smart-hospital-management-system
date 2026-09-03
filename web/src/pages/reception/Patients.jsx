import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { Async, Card, Table, fmtDate, useApi } from '../../components/ui.jsx';

export default function ReceptionPatients() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const query = useApi(() => api.get('/patients', { q, page, pageSize: 25 }), [q, page]);

  return (
    <div className="stack">
      <h1>Patients</h1>

      <Card
        action={(
          <input
            placeholder="Search by name, mobile or email"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            style={{ width: 300 }}
          />
        )}
      >
        <Async query={query} empty="No patients found.">
          {(d) => (
            <>
              <Table
                rows={d.items}
                columns={[
                  { key: 'name', header: 'Patient', render: (p) => <Link to={`/reception/patients/${p.id}`}>{p.user.fullName}</Link> },
                  { key: 'mobile', header: 'Mobile', render: (p) => p.user.mobile },
                  { key: 'email', header: 'Email', render: (p) => p.user.email },
                  { key: 'gender', header: 'Gender' },
                  { key: 'bloodGroup', header: 'Blood group' },
                  { key: 'dob', header: 'Date of birth', render: (p) => fmtDate(p.dateOfBirth) },
                  { key: 'city', header: 'City' },
                  { key: 'actions', header: '', render: (p) => <Link to={`/reception/patients/${p.id}`}><button className="small ghost">Open record</button></Link> },
                ]}
              />
              <div className="row between" style={{ marginTop: '.8rem' }}>
                <span className="small muted">{d.total} patient(s) · page {d.page}</span>
                <span className="row">
                  <button className="small ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
                  <button className="small ghost" disabled={page * d.pageSize >= d.total} onClick={() => setPage(page + 1)}>Next</button>
                </span>
              </div>
            </>
          )}
        </Async>
      </Card>
    </div>
  );
}
