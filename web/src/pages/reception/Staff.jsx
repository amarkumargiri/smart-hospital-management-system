import { useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Async, Badge, Card, ErrorNote, Modal, Table, fmtDate, useApi } from '../../components/ui.jsx';

export default function ReceptionStaff() {
  const { user } = useAuth();
  const hospitalId = user?.staff?.hospitalId;
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);

  const staff = useApi(() => api.get(`/hospitals/${hospitalId}/staff`), [hospitalId], { skip: !hospitalId });
  const departments = useApi(() => api.get(`/hospitals/${hospitalId}/departments`), [hospitalId], { skip: !hospitalId });

  async function setStatus(id, status) {
    setError(null);
    try {
      await api.put(`/hospitals/${hospitalId}/staff/${id}`, { status });
      staff.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="stack">
      <div className="row between">
        <h1>Reception staff</h1>
        <button onClick={() => setAdding(true)}>Add reception account</button>
      </div>

      <Card>
        <ErrorNote error={error} />
        <Async query={staff} empty="No staff accounts yet.">
          {(list) => (
            <Table
              rows={list}
              columns={[
                { key: 'name', header: 'Name', render: (s) => s.user.fullName },
                { key: 'employeeId', header: 'Employee ID' },
                { key: 'department', header: 'Department', render: (s) => s.department?.name || '—' },
                { key: 'mobile', header: 'Mobile', render: (s) => s.user.mobile },
                { key: 'email', header: 'Email', render: (s) => s.user.email },
                { key: 'joiningDate', header: 'Joined', render: (s) => fmtDate(s.joiningDate) },
                { key: 'status', header: 'Status', render: (s) => <Badge value={s.status} /> },
                {
                  key: 'actions',
                  header: '',
                  render: (s) => (
                    <button className="small ghost" onClick={() => setStatus(s.id, s.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE')}>
                      {s.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}
                    </button>
                  ),
                },
              ]}
            />
          )}
        </Async>
      </Card>

      <DepartmentManager hospitalId={hospitalId} departments={departments} />

      {adding && (
        <AddStaffDialog
          hospitalId={hospitalId}
          departments={departments.data || []}
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); staff.reload(); }}
        />
      )}
    </div>
  );
}

function DepartmentManager({ hospitalId, departments }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);

  async function add(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/hospitals/${hospitalId}/departments`, { name, code });
      setName('');
      setCode('');
      departments.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Card title="Departments">
      <Async query={departments} empty="No departments configured.">
        {(list) => (
          <div className="row" style={{ marginBottom: '.8rem' }}>
            {list.map((d) => (
              <span key={d.id} className={`badge ${d.isActive ? 'info' : ''}`}>{d.name} · {d.code}</span>
            ))}
          </div>
        )}
      </Async>
      <form className="row" onSubmit={add}>
        <input placeholder="Department name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 240 }} required />
        <input placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 120 }} required />
        <button className="small">Add department</button>
      </form>
      <ErrorNote error={error} />
    </Card>
  );
}

function AddStaffDialog({ hospitalId, departments, onClose, onDone }) {
  const [form, setForm] = useState({
    fullName: '', email: '', mobile: '', password: '', employeeId: '', departmentId: '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/hospitals/${hospitalId}/staff`, {
        ...form,
        departmentId: form.departmentId || undefined,
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add a reception account"
      onClose={onClose}
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={submit} disabled={busy || !form.fullName || !form.email || form.password.length < 8}>
            Create account
          </button>
        </>
      )}
    >
      <div className="grid cols-2">
        <div className="field"><label>Full name</label><input value={form.fullName} onChange={set('fullName')} /></div>
        <div className="field"><label>Employee ID</label><input value={form.employeeId} onChange={set('employeeId')} placeholder="REC-002" /></div>
        <div className="field"><label>Email</label><input type="email" value={form.email} onChange={set('email')} /></div>
        <div className="field"><label>Mobile</label><input value={form.mobile} onChange={set('mobile')} /></div>
        <div className="field">
          <label>Department</label>
          <select value={form.departmentId} onChange={set('departmentId')}>
            <option value="">Not assigned</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Temporary password (at least 8 characters)</label>
        <input type="password" value={form.password} onChange={set('password')} />
      </div>
      <ErrorNote error={error} />
      <p className="small muted">They sign in with their email and this password, and can change it afterwards. A second reception account is what allows lab results to be released by someone other than whoever entered them.</p>
    </Modal>
  );
}
