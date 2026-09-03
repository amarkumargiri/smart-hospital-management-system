import { useState } from 'react';
import { api } from '../../api.js';
import { Async, Badge, Card, ErrorNote, Modal, Stat, Table, fmtDate, money, useApi } from '../../components/ui.jsx';

const CATEGORIES = ['CONSULTATION', 'ROOM', 'ICU', 'LAB', 'IMAGING', 'PHARMACY', 'PROCEDURE', 'DOCTOR_FEE', 'OTHER'];
const METHODS = ['UPI', 'CARD', 'NETBANKING', 'CASH', 'INSURANCE'];

export default function Billing() {
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState(null);
  const [error, setError] = useState(null);

  const bills = useApi(() => api.get('/billing', { status, pageSize: 100 }), [status]);

  const totals = (bills.data?.items || []).reduce((acc, b) => {
    acc.billed += Number(b.total);
    acc.collected += Number(b.paidAmount);
    return acc;
  }, { billed: 0, collected: 0 });

  return (
    <div className="stack">
      <div className="row between">
        <h1>Billing</h1>
        <button onClick={() => setCreating(true)}>Create bill</button>
      </div>

      <div className="grid cols-3">
        <Stat label="Billed (listed)" value={money(totals.billed)} />
        <Stat label="Collected (listed)" value={money(totals.collected)} />
        <Stat label="Outstanding (listed)" value={money(totals.billed - totals.collected)} tone={totals.billed - totals.collected > 0 ? 'warn' : undefined} />
      </div>

      <Card
        action={(
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 200 }}>
            <option value="">All bills</option>
            <option value="PENDING,PARTIALLY_PAID">Outstanding</option>
            <option value="PAID">Paid</option>
            <option value="CANCELLED,REFUNDED">Cancelled / refunded</option>
          </select>
        )}
      >
        <ErrorNote error={error} />
        <Async query={bills} empty="No bills.">
          {(d) => (
            <Table
              rows={d.items}
              columns={[
                { key: 'billNumber', header: 'Bill' },
                { key: 'createdAt', header: 'Date', render: (b) => fmtDate(b.createdAt) },
                { key: 'patient', header: 'Patient', render: (b) => b.patient.user.fullName },
                { key: 'items', header: 'Items', num: true, render: (b) => b.items.length },
                { key: 'total', header: 'Total', num: true, render: (b) => money(b.total) },
                { key: 'paidAmount', header: 'Paid', num: true, render: (b) => money(b.paidAmount) },
                { key: 'due', header: 'Due', num: true, render: (b) => money(Number(b.total) - Number(b.paidAmount)) },
                { key: 'status', header: 'Status', render: (b) => <Badge value={b.status} /> },
                {
                  key: 'actions',
                  header: '',
                  render: (b) => Number(b.total) > Number(b.paidAmount) && !['CANCELLED', 'REFUNDED'].includes(b.status) && (
                    <button className="small" onClick={() => setPaying(b)}>Record payment</button>
                  ),
                },
              ]}
            />
          )}
        </Async>
      </Card>

      {creating && <CreateBillDialog onClose={() => setCreating(false)} onDone={() => { setCreating(false); bills.reload(); }} />}
      {paying && <PaymentDialog bill={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); bills.reload(); }} />}
    </div>
  );
}

function CreateBillDialog({ onClose, onDone }) {
  const [search, setSearch] = useState('');
  const [patientId, setPatientId] = useState('');
  const [discount, setDiscount] = useState(0);
  const [tax, setTax] = useState(0);
  const [items, setItems] = useState([{ category: 'OTHER', description: '', quantity: 1, unitPrice: 0 }]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const patients = useApi(() => api.get('/patients', { q: search, pageSize: 20 }), [search]);

  const update = (index, key, value) => setItems(items.map((it, i) => (i === index ? { ...it, [key]: value } : it)));
  const subtotal = items.reduce((sum, i) => sum + Number(i.unitPrice || 0) * Number(i.quantity || 0), 0);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/billing', {
        patientId,
        discount: Number(discount),
        tax: Number(tax),
        items: items
          .filter((i) => i.description && Number(i.unitPrice) >= 0)
          .map((i) => ({ ...i, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice) })),
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
      title="Create a bill"
      onClose={onClose}
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={submit} disabled={busy || !patientId || !items[0].description}>
            Create bill · {money(subtotal - Number(discount) + Number(tax))}
          </button>
        </>
      )}
    >
      <div className="field"><label>Search patient</label><input value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <div className="field">
        <label>Patient</label>
        <select value={patientId} onChange={(e) => setPatientId(e.target.value)}>
          <option value="">Select a patient</option>
          {(patients.data?.items || []).map((p) => <option key={p.id} value={p.id}>{p.user.fullName} — {p.user.mobile}</option>)}
        </select>
      </div>

      {items.map((item, i) => (
        <div key={i} className="grid cols-4" style={{ borderTop: i ? '1px solid var(--border)' : 'none', paddingTop: i ? '.6rem' : 0 }}>
          <div className="field">
            <label>Category</label>
            <select value={item.category} onChange={(e) => update(i, 'category', e.target.value)}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field"><label>Description</label><input value={item.description} onChange={(e) => update(i, 'description', e.target.value)} /></div>
          <div className="field"><label>Quantity</label><input type="number" min="1" value={item.quantity} onChange={(e) => update(i, 'quantity', e.target.value)} /></div>
          <div className="field"><label>Unit price</label><input type="number" min="0" step="0.01" value={item.unitPrice} onChange={(e) => update(i, 'unitPrice', e.target.value)} /></div>
        </div>
      ))}
      <button className="ghost small" onClick={() => setItems([...items, { category: 'OTHER', description: '', quantity: 1, unitPrice: 0 }])}>
        Add line item
      </button>

      <div className="grid cols-2" style={{ marginTop: '.8rem' }}>
        <div className="field"><label>Discount</label><input type="number" min="0" value={discount} onChange={(e) => setDiscount(e.target.value)} /></div>
        <div className="field"><label>Tax</label><input type="number" min="0" value={tax} onChange={(e) => setTax(e.target.value)} /></div>
      </div>
      <div className="small muted">Subtotal {money(subtotal)}</div>
      <ErrorNote error={error} />
    </Modal>
  );
}

function PaymentDialog({ bill, onClose, onDone }) {
  const due = Number(bill.total) - Number(bill.paidAmount);
  const [amount, setAmount] = useState(due);
  const [method, setMethod] = useState('CASH');
  const [transactionId, setTransactionId] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/billing/${bill.id}/payments`, {
        amount: Number(amount),
        method,
        status: 'PAID',
        transactionId: transactionId || undefined,
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
      title={`Record payment — ${bill.billNumber}`}
      onClose={onClose}
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={submit} disabled={busy || !(Number(amount) > 0)}>Record {money(amount)}</button>
        </>
      )}
    >
      <p className="small muted">{bill.patient.user.fullName} · outstanding {money(due)}</p>
      <div className="grid cols-2">
        <div className="field"><label>Amount</label><input type="number" min="1" max={due} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="field">
          <label>Method</label>
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>
      <div className="field"><label>Transaction reference</label><input value={transactionId} onChange={(e) => setTransactionId(e.target.value)} /></div>
      <ErrorNote error={error} />
    </Modal>
  );
}
