import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { Async, Badge, Card, ErrorNote, Modal, Table, fmtDateTime, money, useApi } from '../../components/ui.jsx';

export default function PatientAppointments() {
  const [filter, setFilter] = useState('');
  const [cancelling, setCancelling] = useState(null);
  const [queueFor, setQueueFor] = useState(null);
  const [error, setError] = useState(null);
  const query = useApi(() => api.get('/appointments', { status: filter, pageSize: 100 }), [filter]);

  async function cancel(reason) {
    try {
      await api.del(`/appointments/${cancelling.id}`, { reason });
      setCancelling(null);
      query.reload();
    } catch (err) {
      setError(err);
    }
  }

  const columns = [
    { key: 'scheduledAt', header: 'When', render: (a) => fmtDateTime(a.scheduledAt) },
    { key: 'doctor', header: 'Doctor', render: (a) => a.doctor.user.fullName },
    { key: 'hospital', header: 'Hospital', render: (a) => a.hospital.name },
    { key: 'type', header: 'Type', render: (a) => a.type.replace('_', ' ') },
    { key: 'token', header: 'Token', render: (a) => a.tokenNumber || '—' },
    { key: 'fee', header: 'Fee', num: true, render: (a) => money(a.fee) },
    { key: 'status', header: 'Status', render: (a) => <Badge value={a.status} /> },
    {
      key: 'actions',
      header: '',
      render: (a) => (
        <span className="row">
          {['CHECKED_IN', 'IN_CONSULTATION'].includes(a.status) && (
            <button className="small ghost" onClick={() => setQueueFor(a)}>Queue</button>
          )}
          {['REQUESTED', 'CONFIRMED'].includes(a.status) && (
            <button className="small ghost" onClick={() => setCancelling(a)}>Cancel</button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="stack">
      <div className="row between">
        <h1>My appointments</h1>
        <Link to="/app/doctors"><button>Book new</button></Link>
      </div>

      <Card
        action={(
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }}>
            <option value="">All appointments</option>
            <option value="REQUESTED,CONFIRMED,CHECKED_IN">Upcoming</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED,REJECTED,NO_SHOW">Cancelled / missed</option>
          </select>
        )}
        title="History"
      >
        <ErrorNote error={error} />
        <Async query={query} empty="No appointments yet.">
          {(d) => <Table columns={columns} rows={d.items} />}
        </Async>
      </Card>

      {cancelling && (
        <CancelDialog appointment={cancelling} onClose={() => setCancelling(null)} onConfirm={cancel} />
      )}
      {queueFor && <QueueDialog appointment={queueFor} onClose={() => setQueueFor(null)} />}
    </div>
  );
}

function CancelDialog({ appointment, onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      title="Cancel appointment"
      onClose={onClose}
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Keep it</button>
          <button className="danger" onClick={() => onConfirm(reason)}>Cancel appointment</button>
        </>
      )}
    >
      <p className="small">
        {appointment.doctor.user.fullName} · {fmtDateTime(appointment.scheduledAt)}
      </p>
      <div className="field">
        <label htmlFor="reason">Reason (optional)</label>
        <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Modal>
  );
}

// Live OPD queue position — the token board from PRD section 17.
function QueueDialog({ appointment, onClose }) {
  const query = useApi(
    () => api.get('/appointments/queue/status', { doctorId: appointment.doctorId, date: appointment.scheduledAt }),
    [appointment.id],
  );

  return (
    <Modal title="Queue status" onClose={onClose}>
      <Async query={query}>
        {(q) => (
          <div className="grid cols-2">
            <div className="stat"><div className="stat-label">Your token</div><div className="stat-value">{q.yourToken || '—'}</div></div>
            <div className="stat"><div className="stat-label">Now serving</div><div className="stat-value">{q.currentToken || '—'}</div></div>
            <div className="stat"><div className="stat-label">Patients ahead</div><div className="stat-value">{q.patientsAhead ?? '—'}</div></div>
            <div className="stat">
              <div className="stat-label">Estimated wait</div>
              <div className="stat-value">{q.estimatedWaitMinutes == null ? '—' : `${q.estimatedWaitMinutes} min`}</div>
              <div className="stat-hint">{q.averageConsultationMinutes} min average consultation</div>
            </div>
          </div>
        )}
      </Async>
    </Modal>
  );
}
