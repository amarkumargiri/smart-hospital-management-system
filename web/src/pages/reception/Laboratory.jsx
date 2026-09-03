import { useState } from 'react';
import { api } from '../../api.js';
import { Async, Badge, Card, ErrorNote, Modal, Table, Tabs, fmtDateTime, money, useApi } from '../../components/ui.jsx';

export default function Laboratory() {
  const [tab, setTab] = useState('ORDERED,SAMPLE_COLLECTED,PROCESSING');
  const [collecting, setCollecting] = useState(null);
  const [entering, setEntering] = useState(null);
  const [error, setError] = useState(null);

  const orders = useApi(() => api.get('/lab/orders', { status: tab, pageSize: 100 }), [tab]);

  async function act(id, action, body) {
    setError(null);
    try {
      await api.post(`/lab/orders/${id}/${action}`, body || {});
      orders.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="stack">
      <h1>Laboratory</h1>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { value: 'ORDERED,SAMPLE_COLLECTED,PROCESSING', label: 'Work queue' },
          { value: 'RESULT_ENTERED', label: 'Awaiting verification' },
          { value: 'VERIFIED', label: 'Verified' },
          { value: '', label: 'All orders' },
        ]}
      />

      <Card>
        <ErrorNote error={error} />
        <Async query={orders} empty="Nothing in this queue.">
          {(d) => (
            <Table
              rows={d.items}
              columns={[
                { key: 'orderedAt', header: 'Ordered', render: (o) => fmtDateTime(o.orderedAt) },
                { key: 'patient', header: 'Patient', render: (o) => o.patient.user.fullName },
                { key: 'doctor', header: 'Ordered by', render: (o) => o.doctor.user.fullName },
                { key: 'tests', header: 'Tests', wrap: true, render: (o) => o.items.map((i) => i.labTest.name).join(', ') },
                { key: 'priority', header: 'Priority', render: (o) => <Badge value={o.priority} tone={o.priority === 'STAT' ? 'danger' : o.priority === 'URGENT' ? 'warn' : undefined} /> },
                { key: 'sampleId', header: 'Sample', render: (o) => o.sampleId || '—' },
                { key: 'status', header: 'Status', render: (o) => <Badge value={o.status} /> },
                {
                  key: 'actions',
                  header: '',
                  render: (o) => (
                    <span className="row">
                      {o.status === 'ORDERED' && <button className="small" onClick={() => setCollecting(o)}>Collect sample</button>}
                      {o.status === 'SAMPLE_COLLECTED' && <button className="small" onClick={() => act(o.id, 'process')}>Start processing</button>}
                      {['PROCESSING', 'SAMPLE_COLLECTED'].includes(o.status) && <button className="small ghost" onClick={() => setEntering(o)}>Enter results</button>}
                      {o.status === 'RESULT_ENTERED' && (
                        <>
                          <button className="small" onClick={() => act(o.id, 'verify')}>Verify & release</button>
                          <button className="small ghost" onClick={() => setEntering(o)}>Edit results</button>
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

      <TestCatalogue />

      {collecting && (
        <CollectDialog
          order={collecting}
          onClose={() => setCollecting(null)}
          onDone={() => { setCollecting(null); orders.reload(); }}
        />
      )}
      {entering && (
        <ResultsDialog
          order={entering}
          onClose={() => setEntering(null)}
          onDone={() => { setEntering(null); orders.reload(); }}
        />
      )}
    </div>
  );
}

function CollectDialog({ order, onClose, onDone }) {
  const [sampleId, setSampleId] = useState(`S${Math.floor(10000 + Math.random() * 89999)}`);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/lab/orders/${order.id}/collect`, { sampleId });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Record sample collection"
      onClose={onClose}
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={submit} disabled={busy || !sampleId}>Record collection</button>
        </>
      )}
    >
      <p className="small muted">{order.patient.user.fullName} · {order.items.map((i) => i.labTest.name).join(', ')}</p>
      <div className="field">
        <label>Sample identifier</label>
        <input value={sampleId} onChange={(e) => setSampleId(e.target.value)} />
      </div>
      <ErrorNote error={error} />
    </Modal>
  );
}

function ResultsDialog({ order, onClose, onDone }) {
  const [results, setResults] = useState(order.items.map((i) => ({
    itemId: i.id,
    name: i.labTest.name,
    resultValue: i.resultValue || '',
    unit: i.unit || '',
    referenceRange: i.referenceRange || '',
    flag: i.flag || 'NORMAL',
  })));
  const [summary, setSummary] = useState(order.report?.summary || '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const update = (index, key, value) => setResults(results.map((r, i) => (i === index ? { ...r, [key]: value } : r)));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/lab/orders/${order.id}/results`, {
        summary,
        results: results
          .filter((r) => r.resultValue)
          .map(({ itemId, resultValue, unit, referenceRange, flag }) => ({ itemId, resultValue, unit, referenceRange, flag })),
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
      title={`Results — ${order.patient.user.fullName}`}
      onClose={onClose}
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={submit} disabled={busy || !results.some((r) => r.resultValue)}>Save results</button>
        </>
      )}
    >
      {results.map((r, i) => (
        <div key={r.itemId} style={{ borderTop: i ? '1px solid var(--border)' : 'none', paddingTop: i ? '.6rem' : 0 }}>
          <strong className="small">{r.name}</strong>
          <div className="grid cols-2">
            <div className="field"><label>Result</label><input value={r.resultValue} onChange={(e) => update(i, 'resultValue', e.target.value)} /></div>
            <div className="field"><label>Unit</label><input value={r.unit} onChange={(e) => update(i, 'unit', e.target.value)} placeholder="mg/dL" /></div>
            <div className="field"><label>Reference range</label><input value={r.referenceRange} onChange={(e) => update(i, 'referenceRange', e.target.value)} placeholder="4 - 11" /></div>
            <div className="field">
              <label>Flag</label>
              <select value={r.flag} onChange={(e) => update(i, 'flag', e.target.value)}>
                {['NORMAL', 'HIGH', 'LOW', 'CRITICAL'].map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
          </div>
        </div>
      ))}
      <div className="field">
        <label>Report summary</label>
        <textarea value={summary} onChange={(e) => setSummary(e.target.value)} />
      </div>
      <ErrorNote error={error} />
      <p className="small muted">
        Results are released to the doctor and patient only after a second person verifies them.
      </p>
    </Modal>
  );
}

function TestCatalogue() {
  const [adding, setAdding] = useState(false);
  const tests = useApi(() => api.get('/lab/tests'), []);

  return (
    <Card title="Test catalogue" action={<button className="small ghost" onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add test'}</button>}>
      {adding && <AddTestForm onDone={() => { setAdding(false); tests.reload(); }} />}
      <Async query={tests} empty="No tests configured.">
        {(list) => (
          <Table
            rows={list}
            columns={[
              { key: 'code', header: 'Code' },
              { key: 'name', header: 'Test' },
              { key: 'category', header: 'Category' },
              { key: 'sampleType', header: 'Sample' },
              { key: 'turnaroundHours', header: 'Turnaround', num: true, render: (t) => `${t.turnaroundHours} h` },
              { key: 'price', header: 'Price', num: true, render: (t) => money(t.price) },
            ]}
          />
        )}
      </Async>
    </Card>
  );
}

function AddTestForm({ onDone }) {
  const [form, setForm] = useState({ code: '', name: '', category: 'BIOCHEMISTRY', sampleType: 'BLOOD', price: 0, turnaroundHours: 24 });
  const [error, setError] = useState(null);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/lab/tests', { ...form, price: Number(form.price), turnaroundHours: Number(form.turnaroundHours) });
      onDone();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <form onSubmit={submit} style={{ marginBottom: '1rem' }}>
      <div className="grid cols-3">
        <div className="field"><label>Code</label><input value={form.code} onChange={set('code')} required /></div>
        <div className="field"><label>Name</label><input value={form.name} onChange={set('name')} required /></div>
        <div className="field">
          <label>Category</label>
          <select value={form.category} onChange={set('category')}>
            {['HAEMATOLOGY', 'BIOCHEMISTRY', 'RADIOLOGY', 'PATHOLOGY'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="field"><label>Sample type</label><input value={form.sampleType} onChange={set('sampleType')} /></div>
        <div className="field"><label>Price</label><input type="number" min="0" value={form.price} onChange={set('price')} /></div>
        <div className="field"><label>Turnaround (hours)</label><input type="number" min="1" value={form.turnaroundHours} onChange={set('turnaroundHours')} /></div>
      </div>
      <ErrorNote error={error} />
      <button className="small">Add test</button>
    </form>
  );
}
