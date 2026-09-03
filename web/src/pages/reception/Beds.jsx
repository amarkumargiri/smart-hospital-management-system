import { useState } from 'react';
import { api } from '../../api.js';
import { Async, Badge, Card, ErrorNote, Modal, Stat, fmtDate, money, useApi } from '../../components/ui.jsx';

const STATUSES = ['AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING', 'MAINTENANCE'];
const TYPES = ['GENERAL', 'ICU', 'ISOLATION', 'PRIVATE', 'EMERGENCY'];

export default function Beds() {
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);

  const summary = useApi(() => api.get('/beds/summary'), []);
  const beds = useApi(() => api.get('/beds', { type, status }), [type, status]);

  async function setBedStatus(bed, next) {
    setError(null);
    try {
      await api.put(`/beds/${bed.id}`, { status: next });
      setSelected(null);
      beds.reload();
      summary.reload();
    } catch (err) {
      setError(err);
    }
  }

  const wards = groupBy(beds.data || [], (b) => b.ward);

  return (
    <div className="stack">
      <div className="row between">
        <h1>Beds & ICU</h1>
        <button onClick={() => setAdding(true)}>Add beds</button>
      </div>

      <Async query={summary}>
        {(s) => (
          <div className="grid cols-4">
            <Stat label="General beds available" value={`${s.availableBeds} / ${s.totalBeds}`} percent={s.bedOccupancyPct} hint={`${s.bedOccupancyPct}% occupied`} />
            <Stat label="ICU beds available" value={`${s.availableIcu} / ${s.totalIcu}`} percent={s.icuOccupancyPct} hint={`${s.icuOccupancyPct}% occupied`} tone={s.icuOccupancyPct >= 90 ? 'danger' : undefined} />
            <Stat label="Ventilators free" value={s.ventilators} />
            <Stat label="Critical patients in ICU" value={s.criticalPatients} />
          </div>
        )}
      </Async>

      <ErrorNote error={error} />

      <Card
        title="Ward map"
        action={(
          <div className="row">
            <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 150 }}>
              <option value="">All types</option>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 160 }}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
      >
        <Async query={beds} empty="No beds match those filters.">
          {() => (
            <div className="stack">
              {Object.entries(wards).map(([ward, list]) => (
                <div key={ward}>
                  <div className="row between" style={{ marginBottom: '.4rem' }}>
                    <strong className="small">{ward} ward</strong>
                    <span className="small muted">
                      {list.filter((b) => b.status === 'AVAILABLE').length} available of {list.length}
                    </span>
                  </div>
                  <div className="bed-grid">
                    {list.map((b) => (
                      <div key={b.id} className={`bed ${b.status}`} onClick={() => setSelected(b)} title={`${b.bedNumber} · ${b.status}`}>
                        <div><strong>{b.bedNumber.split('-').pop()}</strong></div>
                        <div style={{ fontSize: '.62rem' }}>{b.admissions[0]?.patient.user.fullName.split(' ')[0] || b.status.slice(0, 5).toLowerCase()}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <div className="row small muted">
                {STATUSES.map((s) => (
                  <span key={s} className="row" style={{ gap: '.3rem' }}>
                    <span className={`bed ${s}`} style={{ width: 14, height: 14, padding: 0 }} /> {s.toLowerCase()}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Async>
      </Card>

      {selected && (
        <Modal title={`Bed ${selected.bedNumber}`} onClose={() => setSelected(null)}>
          <table>
            <tbody>
              <tr><td className="muted">Ward</td><td>{selected.ward}</td></tr>
              <tr><td className="muted">Type</td><td>{selected.type}</td></tr>
              <tr><td className="muted">Ventilator</td><td>{selected.hasVentilator ? 'Yes' : 'No'}</td></tr>
              <tr><td className="muted">Daily charge</td><td>{money(selected.dailyCharge)}</td></tr>
              <tr><td className="muted">Status</td><td><Badge value={selected.status} /></td></tr>
              {selected.admissions[0] && (
                <>
                  <tr><td className="muted">Patient</td><td>{selected.admissions[0].patient.user.fullName}</td></tr>
                  <tr><td className="muted">Admitted</td><td>{fmtDate(selected.admissions[0].admittedAt)}</td></tr>
                  <tr><td className="muted">Reason</td><td>{selected.admissions[0].reason}</td></tr>
                </>
              )}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: '1rem' }}>
            {STATUSES.filter((s) => s !== selected.status && s !== 'OCCUPIED').map((s) => (
              <button key={s} className="small ghost" onClick={() => setBedStatus(selected, s)}>Mark {s.toLowerCase()}</button>
            ))}
          </div>
          {selected.status === 'OCCUPIED' && (
            <p className="small muted" style={{ marginTop: '.6rem' }}>
              This bed is freed by discharging the patient from the Admissions screen.
            </p>
          )}
        </Modal>
      )}

      {adding && (
        <AddBedsDialog
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); beds.reload(); summary.reload(); }}
        />
      )}
    </div>
  );
}

function AddBedsDialog({ onClose, onDone }) {
  const [form, setForm] = useState({ prefix: 'GEN', from: 1, to: 10, ward: 'GENERAL', type: 'GENERAL', hasVentilator: false, dailyCharge: 1800 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/beds/bulk', {
        ...form,
        from: Number(form.from),
        to: Number(form.to),
        dailyCharge: Number(form.dailyCharge),
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
      title="Add beds"
      onClose={onClose}
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create beds'}</button>
        </>
      )}
    >
      <div className="grid cols-3">
        <div className="field"><label>Number prefix</label><input value={form.prefix} onChange={set('prefix')} /></div>
        <div className="field"><label>From</label><input type="number" min="1" value={form.from} onChange={set('from')} /></div>
        <div className="field"><label>To</label><input type="number" min="1" value={form.to} onChange={set('to')} /></div>
      </div>
      <div className="grid cols-3">
        <div className="field"><label>Ward</label><input value={form.ward} onChange={set('ward')} /></div>
        <div className="field">
          <label>Type</label>
          <select value={form.type} onChange={set('type')}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="field"><label>Daily charge</label><input type="number" min="0" value={form.dailyCharge} onChange={set('dailyCharge')} /></div>
      </div>
      <label className="row small">
        <input type="checkbox" style={{ width: 'auto' }} checked={form.hasVentilator} onChange={set('hasVentilator')} />
        These beds have ventilators
      </label>
      <p className="small muted">Creates {Math.max(0, Number(form.to) - Number(form.from) + 1)} beds numbered {form.prefix}-001 upward. Existing numbers are skipped.</p>
      <ErrorNote error={error} />
    </Modal>
  );
}

function groupBy(list, key) {
  return list.reduce((acc, item) => {
    const k = key(item);
    (acc[k] ||= []).push(item);
    return acc;
  }, {});
}
