import { useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Async, Badge, Card, ErrorNote, Modal, Table, fmtDate, money, useApi } from '../../components/ui.jsx';

const METHODS = ['UPI', 'CARD', 'NETBANKING'];

export default function PatientBills() {
  const { user } = useAuth();
  const patientId = user?.patient?.id;
  const [paying, setPaying] = useState(null);
  const query = useApi(() => api.get(`/patients/${patientId}/bills`), [patientId], { skip: !patientId });

  const totalDue = (query.data || []).reduce((sum, b) => sum + (Number(b.total) - Number(b.paidAmount)), 0);

  return (
    <div className="stack">
      <div className="row between">
        <h1>Bills & payments</h1>
        {totalDue > 0 && <span className="badge warn">Outstanding {money(totalDue)}</span>}
      </div>

      <Async query={query} empty="No bills yet.">
        {(bills) => (
          <div className="stack">
            {bills.map((b) => {
              const due = Number(b.total) - Number(b.paidAmount);
              return (
                <Card
                  key={b.id}
                  title={<span className="mono">{b.billNumber}</span>}
                  action={<span className="row"><span className="small muted">{fmtDate(b.createdAt)}</span><Badge value={b.status} /></span>}
                >
                  <div className="small muted" style={{ marginBottom: '.5rem' }}>{b.hospital.name}</div>
                  <Table
                    rows={b.items}
                    columns={[
                      { key: 'category', header: 'Category' },
                      { key: 'description', header: 'Description', wrap: true },
                      { key: 'quantity', header: 'Qty', num: true },
                      { key: 'unitPrice', header: 'Rate', num: true, render: (i) => money(i.unitPrice) },
                      { key: 'amount', header: 'Amount', num: true, render: (i) => money(i.amount) },
                    ]}
                  />
                  <div className="row between" style={{ marginTop: '.7rem' }}>
                    <div className="small muted">
                      Subtotal {money(b.subtotal)}
                      {Number(b.discount) > 0 && ` · Discount ${money(b.discount)}`}
                      {Number(b.tax) > 0 && ` · Tax ${money(b.tax)}`}
                      {' · '}Paid {money(b.paidAmount)}
                    </div>
                    <div className="row">
                      <strong style={{ fontSize: '1.1rem' }}>{money(b.total)}</strong>
                      {due > 0 && <button onClick={() => setPaying({ ...b, due })}>Pay {money(due)}</button>}
                    </div>
                  </div>
                  {b.payments.length > 0 && (
                    <div className="small muted" style={{ marginTop: '.5rem' }}>
                      Payments: {b.payments.map((p) => `${p.method} ${money(p.amount)} (${p.status})`).join(', ')}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </Async>

      {paying && (
        <PayDialog bill={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); query.reload(); }} />
      )}
    </div>
  );
}

function PayDialog({ bill, onClose, onDone }) {
  const [amount, setAmount] = useState(bill.due);
  const [method, setMethod] = useState('UPI');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      // A real deployment swaps this for a gateway callback; the API records the
      // payment either way, so nothing else changes.
      await api.post(`/billing/${bill.id}/payments`, {
        amount: Number(amount),
        method,
        status: 'PAID',
        transactionId: `DEMO-${Date.now()}`,
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
      title={`Pay bill ${bill.billNumber}`}
      onClose={onClose}
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={pay} disabled={busy || !(Number(amount) > 0)}>{busy ? 'Processing…' : `Pay ${money(amount)}`}</button>
        </>
      )}
    >
      <div className="field">
        <label htmlFor="amount">Amount (outstanding {money(bill.due)})</label>
        <input id="amount" type="number" min="1" max={bill.due} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="method">Payment method</label>
        <select id="method" value={method} onChange={(e) => setMethod(e.target.value)}>
          {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <ErrorNote error={error} />
    </Modal>
  );
}
