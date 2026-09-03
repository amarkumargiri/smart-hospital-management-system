import { useState } from 'react';
import { api } from '../../api.js';
import { Async, Badge, Card, ErrorNote, Modal, Stat, Table, Tabs, fmtDate, money, useApi } from '../../components/ui.jsx';

export default function Pharmacy() {
  const [tab, setTab] = useState('inventory');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [dispensing, setDispensing] = useState(null);

  const inventory = useApi(() => api.get('/pharmacy/inventory', { search, pageSize: 200 }), [search]);
  const alerts = useApi(() => api.get('/pharmacy/alerts'), []);
  const prescriptions = useApi(() => api.get('/pharmacy/prescriptions'), []);

  return (
    <div className="stack">
      <div className="row between">
        <h1>Pharmacy</h1>
        <button onClick={() => setAdding(true)}>Add stock</button>
      </div>

      <Async query={alerts}>
        {(a) => (
          <div className="grid cols-3">
            <Stat label="Low stock items" value={a.lowStock.length} tone={a.lowStock.length ? 'warn' : undefined} />
            <Stat label="Expiring within 30 days" value={a.expiringSoon.length} tone={a.expiringSoon.length ? 'warn' : undefined} />
            <Stat label="Expired items" value={a.expired.length} tone={a.expired.length ? 'danger' : undefined} />
          </div>
        )}
      </Async>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { value: 'inventory', label: 'Inventory' },
          { value: 'prescriptions', label: 'Prescriptions to dispense' },
          { value: 'alerts', label: 'Stock alerts' },
        ]}
      />

      {tab === 'inventory' && (
        <Card action={<input placeholder="Search medicine" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} />}>
          <Async query={inventory} empty="No stock recorded.">
            {(d) => (
              <Table
                rows={d.items}
                columns={[
                  { key: 'name', header: 'Medicine' },
                  { key: 'genericName', header: 'Generic' },
                  { key: 'form', header: 'Form' },
                  { key: 'strength', header: 'Strength' },
                  { key: 'batchNumber', header: 'Batch' },
                  {
                    key: 'quantity',
                    header: 'In stock',
                    num: true,
                    render: (m) => (
                      <span className={m.quantity <= m.reorderLevel ? 'badge warn' : ''}>{m.quantity}</span>
                    ),
                  },
                  { key: 'reorderLevel', header: 'Reorder at', num: true },
                  {
                    key: 'expiryDate',
                    header: 'Expiry',
                    render: (m) => (
                      <span className={new Date(m.expiryDate) < new Date() ? 'badge danger' : ''}>{fmtDate(m.expiryDate)}</span>
                    ),
                  },
                  { key: 'supplier', header: 'Supplier' },
                  { key: 'price', header: 'Price', num: true, render: (m) => money(m.price) },
                ]}
              />
            )}
          </Async>
        </Card>
      )}

      {tab === 'prescriptions' && (
        <Card title="Active prescriptions">
          <Async query={prescriptions} empty="Nothing waiting to be dispensed.">
            {(list) => (
              <div className="stack">
                {list.map((p) => (
                  <div key={p.id} className="list-item">
                    <div className="row between">
                      <strong>{p.patient.user.fullName} <span className="muted small">· {p.patient.user.mobile}</span></strong>
                      <span className="row">
                        <span className="small muted">{fmtDate(p.issuedAt)} · {p.doctor.user.fullName}</span>
                        <button className="small" onClick={() => setDispensing(p)}>Dispense</button>
                      </span>
                    </div>
                    {p.items.map((i) => (
                      <div key={i.id} className="small">
                        {i.medicineName} {i.dosage} · {i.frequency} · {i.durationDays} days
                        {i.dispensedQty > 0 && <Badge value={`${i.dispensedQty} dispensed`} tone="ok" />}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </Async>
        </Card>
      )}

      {tab === 'alerts' && (
        <Async query={alerts}>
          {(a) => (
            <div className="stack">
              <Card title="Below reorder level">
                <Table rows={a.lowStock} columns={stockColumns} empty="All items are above their reorder level." />
              </Card>
              <Card title="Expiring within 30 days">
                <Table rows={a.expiringSoon} columns={stockColumns} empty="Nothing expiring soon." />
              </Card>
              <Card title="Expired — remove from shelf">
                <Table rows={a.expired} columns={stockColumns} empty="No expired stock." />
              </Card>
            </div>
          )}
        </Async>
      )}

      {adding && <AddStockDialog onClose={() => setAdding(false)} onDone={() => { setAdding(false); inventory.reload(); alerts.reload(); }} />}
      {dispensing && (
        <DispenseDialog
          prescription={dispensing}
          onClose={() => setDispensing(null)}
          onDone={() => { setDispensing(null); prescriptions.reload(); inventory.reload(); alerts.reload(); }}
        />
      )}
    </div>
  );
}

const stockColumns = [
  { key: 'name', header: 'Medicine' },
  { key: 'batchNumber', header: 'Batch' },
  { key: 'quantity', header: 'Quantity', num: true },
  { key: 'reorderLevel', header: 'Reorder at', num: true },
  { key: 'expiryDate', header: 'Expiry', render: (m) => fmtDate(m.expiryDate) },
  { key: 'supplier', header: 'Supplier' },
];

function AddStockDialog({ onClose, onDone }) {
  const [form, setForm] = useState({
    name: '', genericName: '', form: 'TABLET', strength: '', batchNumber: '',
    quantity: 100, reorderLevel: 20, expiryDate: '', supplier: '', price: 0,
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/pharmacy/inventory', {
        ...form,
        quantity: Number(form.quantity),
        reorderLevel: Number(form.reorderLevel),
        price: Number(form.price),
        expiryDate: new Date(form.expiryDate).toISOString(),
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
      title="Add stock"
      onClose={onClose}
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={submit} disabled={busy || !form.name || !form.batchNumber || !form.expiryDate}>Add stock</button>
        </>
      )}
    >
      <div className="grid cols-2">
        <div className="field"><label>Medicine name</label><input value={form.name} onChange={set('name')} /></div>
        <div className="field"><label>Generic name</label><input value={form.genericName} onChange={set('genericName')} /></div>
        <div className="field">
          <label>Form</label>
          <select value={form.form} onChange={set('form')}>
            {['TABLET', 'CAPSULE', 'SYRUP', 'INJECTION', 'OINTMENT'].map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div className="field"><label>Strength</label><input value={form.strength} onChange={set('strength')} placeholder="500 mg" /></div>
        <div className="field"><label>Batch number</label><input value={form.batchNumber} onChange={set('batchNumber')} /></div>
        <div className="field"><label>Expiry date</label><input type="date" value={form.expiryDate} onChange={set('expiryDate')} /></div>
        <div className="field"><label>Quantity</label><input type="number" min="0" value={form.quantity} onChange={set('quantity')} /></div>
        <div className="field"><label>Reorder level</label><input type="number" min="0" value={form.reorderLevel} onChange={set('reorderLevel')} /></div>
        <div className="field"><label>Unit price</label><input type="number" min="0" step="0.01" value={form.price} onChange={set('price')} /></div>
        <div className="field"><label>Supplier</label><input value={form.supplier} onChange={set('supplier')} /></div>
      </div>
      <ErrorNote error={error} />
      <p className="small muted">Adding an existing medicine and batch tops up that batch rather than creating a duplicate.</p>
    </Modal>
  );
}

function DispenseDialog({ prescription, onClose, onDone }) {
  const [lines, setLines] = useState(prescription.items.map((i) => ({
    prescriptionItemId: i.id,
    label: `${i.medicineName} ${i.dosage}`,
    medicineId: '',
    quantity: Math.max(1, i.durationDays),
  })));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const inventory = useApi(() => api.get('/pharmacy/inventory', { pageSize: 200 }), []);

  const update = (index, key, value) => setLines(lines.map((l, i) => (i === index ? { ...l, [key]: value } : l)));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/pharmacy/dispense', {
        prescriptionId: prescription.id,
        items: lines
          .filter((l) => l.medicineId && Number(l.quantity) > 0)
          .map(({ prescriptionItemId, medicineId, quantity }) => ({ prescriptionItemId, medicineId, quantity: Number(quantity) })),
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
      title={`Dispense to ${prescription.patient.user.fullName}`}
      onClose={onClose}
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={submit} disabled={busy || !lines.some((l) => l.medicineId)}>Dispense</button>
        </>
      )}
    >
      {lines.map((l, i) => (
        <div key={l.prescriptionItemId} className="grid cols-2" style={{ borderTop: i ? '1px solid var(--border)' : 'none', paddingTop: i ? '.6rem' : 0 }}>
          <div className="field">
            <label>{l.label}</label>
            <select value={l.medicineId} onChange={(e) => update(i, 'medicineId', e.target.value)}>
              <option value="">Skip this item</option>
              {(inventory.data?.items || []).map((m) => (
                <option key={m.id} value={m.id}>{m.name} {m.strength} — batch {m.batchNumber} ({m.quantity} in stock)</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Quantity</label>
            <input type="number" min="1" value={l.quantity} onChange={(e) => update(i, 'quantity', e.target.value)} />
          </div>
        </div>
      ))}
      <ErrorNote error={error} />
      <p className="small muted">Expired batches and quantities beyond available stock are rejected.</p>
    </Modal>
  );
}
