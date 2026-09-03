import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { Async, Badge, Card, ErrorNote, Modal, Table, fmtDate, useApi } from '../../components/ui.jsx';
import { DischargeDialog } from '../doctor/Admissions.jsx';

export default function Admissions() {
  const [status, setStatus] = useState('REQUESTED,APPROVED,ADMITTED');
  const [allocating, setAllocating] = useState(null);
  const [transferring, setTransferring] = useState(null);
  const [discharging, setDischarging] = useState(null);
  const [error, setError] = useState(null);

  const query = useApi(() => api.get('/admissions', { status, pageSize: 100 }), [status]);

  async function act(id, action) {
    setError(null);
    try {
      await api.post(`/admissions/${id}/${action}`, {});
      query.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="stack">
      <h1>Admissions</h1>

      <Card
        action={(
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 220 }}>
            <option value="REQUESTED,APPROVED,ADMITTED">Open</option>
            <option value="REQUESTED">Awaiting approval</option>
            <option value="APPROVED">Approved, needs a bed</option>
            <option value="ADMITTED">Currently admitted</option>
            <option value="DISCHARGED">Discharged</option>
            <option value="">All</option>
          </select>
        )}
      >
        <ErrorNote error={error} />
        <Async query={query} empty="No admissions.">
          {(d) => (
            <Table
              rows={d.items}
              columns={[
                { key: 'patient', header: 'Patient', render: (a) => <Link to={`/reception/patients/${a.patientId}`}>{a.patient.user.fullName}</Link> },
                { key: 'doctor', header: 'Doctor', render: (a) => a.doctor.user.fullName },
                { key: 'department', header: 'Department', render: (a) => a.department?.name || '—' },
                { key: 'reason', header: 'Reason', wrap: true },
                { key: 'bed', header: 'Bed', render: (a) => (a.bed ? `${a.bed.bedNumber} (${a.bed.ward})` : '—') },
                { key: 'requestedAt', header: 'Requested', render: (a) => fmtDate(a.requestedAt) },
                { key: 'admittedAt', header: 'Admitted', render: (a) => fmtDate(a.admittedAt) },
                { key: 'status', header: 'Status', render: (a) => <Badge value={a.status} /> },
                {
                  key: 'actions',
                  header: '',
                  render: (a) => (
                    <span className="row">
                      {a.status === 'REQUESTED' && (
                        <>
                          <button className="small" onClick={() => act(a.id, 'approve')}>Approve</button>
                          <button className="small ghost" onClick={() => act(a.id, 'reject')}>Reject</button>
                        </>
                      )}
                      {['REQUESTED', 'APPROVED'].includes(a.status) && (
                        <button className="small" onClick={() => setAllocating(a)}>Allocate bed</button>
                      )}
                      {a.status === 'ADMITTED' && (
                        <>
                          <button className="small ghost" onClick={() => setTransferring(a)}>Transfer</button>
                          <button className="small ghost" onClick={() => setDischarging(a)}>Discharge</button>
                        </>
                      )}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Async>
      </Card>

      {allocating && (
        <BedPicker
          title={`Allocate a bed for ${allocating.patient.user.fullName}`}
          onClose={() => setAllocating(null)}
          onPick={async (bedId) => {
            await api.post(`/admissions/${allocating.id}/admit`, { bedId });
            setAllocating(null);
            query.reload();
          }}
        />
      )}

      {transferring && (
        <BedPicker
          title={`Transfer ${transferring.patient.user.fullName}`}
          onClose={() => setTransferring(null)}
          onPick={async (bedId) => {
            await api.post(`/admissions/${transferring.id}/transfer`, { bedId });
            setTransferring(null);
            query.reload();
          }}
        />
      )}

      {discharging && (
        <DischargeDialog
          admission={discharging}
          onClose={() => setDischarging(null)}
          onDone={() => { setDischarging(null); query.reload(); }}
        />
      )}
    </div>
  );
}

// Only free beds are offered; the API still re-checks, because between rendering
// this list and clicking, someone else may have taken the bed.
function BedPicker({ title, onClose, onPick }) {
  const [type, setType] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const beds = useApi(() => api.get('/beds', { status: 'AVAILABLE', type }), [type]);

  async function pick(bedId) {
    setBusy(true);
    setError(null);
    try {
      await onPick(bedId);
    } catch (err) {
      setError(err);
      beds.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="field">
        <label>Bed type</label>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Any</option>
          {['GENERAL', 'ICU', 'ISOLATION', 'PRIVATE', 'EMERGENCY'].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <ErrorNote error={error} />
      <Async query={beds} empty="No free beds of this type.">
        {(list) => (
          <div className="bed-grid">
            {list.map((b) => (
              <div key={b.id} className="bed AVAILABLE" onClick={() => !busy && pick(b.id)} title={`${b.ward} · ${b.type}`}>
                <div><strong>{b.bedNumber}</strong></div>
                <div style={{ fontSize: '.62rem' }}>{b.hasVentilator ? 'ventilator' : b.type.toLowerCase()}</div>
              </div>
            ))}
          </div>
        )}
      </Async>
    </Modal>
  );
}
