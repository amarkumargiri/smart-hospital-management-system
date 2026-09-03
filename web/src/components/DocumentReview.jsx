import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Async, Badge, Card, ErrorNote, Loading, Table, fmtDateTime, useApi } from './ui.jsx';

// Review and verification screen for one processed document. Used by the
// patient reviewing their own upload and by clinical staff reviewing a
// patient's — the API decides what each may do, so one component serves both.

const STATUS_MESSAGE = {
  UPLOADED: 'Uploaded. Processing is about to start.',
  PROCESSING: 'Reading the document…',
  OCR_COMPLETED: 'Text extracted. Looking for medical information…',
  NLP_COMPLETED: 'Medical information found. Ready for your review.',
  REVIEW_REQUIRED: 'Please review the extracted information before it is saved.',
  VERIFIED: 'Verified.',
  SAVED: 'Saved to the medical record.',
  REJECTED: 'Rejected — nothing was saved to the medical record.',
  OCR_FAILED: 'We could not extract readable text from this document. Please upload a clearer document.',
  NLP_FAILED: 'Document text was extracted, but medical information could not be automatically structured.',
  PROCESSING_FAILED: 'The document could not be processed.',
};

const STATUS_TONE = {
  SAVED: 'ok', VERIFIED: 'ok', REVIEW_REQUIRED: 'warn', NLP_COMPLETED: 'warn',
  OCR_FAILED: 'danger', NLP_FAILED: 'danger', PROCESSING_FAILED: 'danger', REJECTED: 'danger',
};

const IN_FLIGHT = ['UPLOADED', 'PROCESSING', 'OCR_COMPLETED'];
const EDITABLE = ['REVIEW_REQUIRED', 'NLP_COMPLETED'];

const pct = (c) => `${Math.round((c ?? 0) * 100)}%`;

// Field labels the reviewer reads, rather than the wire enum.
const LABELS = {
  PATIENT_NAME: 'Patient name', PATIENT_AGE: 'Age', PATIENT_GENDER: 'Gender', PATIENT_ID: 'Patient ID',
  DIAGNOSIS: 'Diagnosis', SYMPTOM: 'Symptom', CONDITION: 'Condition', ALLERGY: 'Allergy',
  PROCEDURE: 'Procedure', TREATMENT: 'Treatment',
  MEDICATION_NAME: 'Medicine', MEDICATION_DOSAGE: 'Dose', MEDICATION_FREQUENCY: 'Frequency',
  MEDICATION_DURATION: 'Duration', MEDICATION_ROUTE: 'Route', MEDICATION_INSTRUCTION: 'Instruction',
  LAB_TEST: 'Test', LAB_VALUE: 'Value', LAB_UNIT: 'Unit', LAB_REFERENCE_RANGE: 'Reference range', LAB_FLAG: 'Flag',
  DOCTOR_NAME: 'Doctor', HOSPITAL_NAME: 'Hospital', DEPARTMENT: 'Department',
  REPORT_DATE: 'Report date', PRESCRIPTION_DATE: 'Prescription date', FOLLOW_UP_DATE: 'Follow-up date',
};

// The API returns entities sorted by type, which puts "Reference range" before
// "Test". A reader wants them in the order they appear on the document.
const FIELD_ORDER = [
  'PATIENT_NAME', 'PATIENT_AGE', 'PATIENT_GENDER', 'PATIENT_ID',
  'DIAGNOSIS', 'SYMPTOM', 'CONDITION', 'ALLERGY', 'PROCEDURE', 'TREATMENT',
  'MEDICATION_NAME', 'MEDICATION_DOSAGE', 'MEDICATION_FREQUENCY',
  'MEDICATION_DURATION', 'MEDICATION_ROUTE', 'MEDICATION_INSTRUCTION',
  'LAB_TEST', 'LAB_VALUE', 'LAB_UNIT', 'LAB_REFERENCE_RANGE', 'LAB_FLAG',
  'DOCTOR_NAME', 'HOSPITAL_NAME', 'DEPARTMENT',
  'REPORT_DATE', 'PRESCRIPTION_DATE', 'FOLLOW_UP_DATE',
];
const orderOf = (type) => {
  const i = FIELD_ORDER.indexOf(type);
  return i === -1 ? FIELD_ORDER.length : i;
};
const byFieldOrder = (a, b) => orderOf(a.entityType) - orderOf(b.entityType);

const GROUP_TITLE = (key) => (key?.startsWith('med:') ? 'Medicine' : key?.startsWith('lab:') ? 'Test result' : 'Details');

export default function DocumentReview({ documentId, canVerify, onChanged, onClose }) {
  const [document, setDocument] = useState(null);
  const [extraction, setExtraction] = useState(null);
  const [edits, setEdits] = useState({});          // entityId → corrected string
  const [rejected, setRejected] = useState({});    // entityId → true
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [showText, setShowText] = useState(false);

  const ocr = useApi(() => api.get(`/documents/${documentId}/ocr`), [documentId, showText], { skip: !showText });

  // Poll while the pipeline is still working, then stop.
  useEffect(() => {
    let alive = true;
    let timer;

    const load = async () => {
      try {
        const doc = await api.get(`/documents/${documentId}`);
        if (!alive) return;
        setDocument(doc);
        if (IN_FLIGHT.includes(doc.status)) {
          timer = setTimeout(load, 1500);
          return;
        }
        const ex = await api.get(`/documents/${documentId}/extraction`);
        if (alive) setExtraction(ex);
      } catch (err) {
        if (alive) setError(err);
      }
    };

    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [documentId]);

  if (error && !document) return <ErrorNote error={error} />;
  if (!document) return <Loading label="Loading document…" />;

  const processing = IN_FLIGHT.includes(document.status);
  const editable = canVerify && EDITABLE.includes(document.status);
  const entities = (extraction?.entities || []).filter((e) => !e.rejected);
  const threshold = extraction?.thresholds?.AUTO ?? 0.85;

  const valueOf = (e) => edits[e.id] ?? e.correctedValue ?? e.entityValue;

  async function saveCorrections() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const payload = entities
        .filter((e) => edits[e.id] !== undefined || rejected[e.id])
        .map((e) => ({
          id: e.id,
          ...(edits[e.id] !== undefined ? { correctedValue: edits[e.id] } : {}),
          ...(rejected[e.id] ? { rejected: true } : {}),
        }));
      if (!payload.length) { setNotice('Nothing changed.'); return; }
      const updated = await api.put(`/documents/${documentId}/extraction`, { entities: payload });
      setExtraction({ ...extraction, entities: updated.entities, structured: updated.structured });
      setEdits({}); setRejected({});
      setNotice('Corrections saved. They are not in the medical record until you approve.');
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  async function decide(decision) {
    setBusy(true); setError(null); setNotice(null);
    try {
      // Save any pending edits first so approval covers what is on screen.
      const pending = entities
        .filter((e) => edits[e.id] !== undefined || rejected[e.id])
        .map((e) => ({
          id: e.id,
          ...(edits[e.id] !== undefined ? { correctedValue: edits[e.id] } : {}),
          ...(rejected[e.id] ? { rejected: true } : {}),
        }));
      if (pending.length) await api.put(`/documents/${documentId}/extraction`, { entities: pending });

      await api.post(`/documents/${documentId}/verify`, { decision });
      const doc = await api.get(`/documents/${documentId}`);
      setDocument(doc);
      setNotice(decision === 'APPROVE'
        ? 'Approved and saved to the medical record.'
        : 'Rejected. Nothing was saved to the medical record.');
      onChanged?.();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  async function reprocess() {
    setBusy(true); setError(null);
    try {
      await api.post(`/documents/${documentId}/reprocess`, {});
      setDocument({ ...document, status: 'PROCESSING' });
      setTimeout(() => window.location.reload(), 100);
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  // Entities that belong together (one medicine, one lab row) are shown together.
  const groups = [];
  const loose = [];
  for (const e of entities) {
    if (!e.groupKey) { loose.push(e); continue; }
    let group = groups.find((g) => g.key === e.groupKey);
    if (!group) { group = { key: e.groupKey, items: [] }; groups.push(group); }
    group.items.push(e);
  }
  for (const g of groups) g.items.sort(byFieldOrder);
  loose.sort(byFieldOrder);

  return (
    <div className="stack">
      <Card
        title={document.file.originalName}
        action={(
          <span className="row">
            <Badge value={document.documentType} />
            <Badge value={document.status} tone={STATUS_TONE[document.status]} />
          </span>
        )}
      >
        <div className="row between small muted">
          <span>
            Uploaded {fmtDateTime(document.uploadedAt)} by {document.uploadedBy.fullName}
            {document.pageCount ? ` · ${document.pageCount} page(s)` : ''}
            {document.processingMs ? ` · processed in ${document.processingMs} ms` : ''}
          </span>
          <span className="row">
            <a href={`/api/documents/${documentId}/file`} target="_blank" rel="noreferrer">
              <button className="small ghost" type="button">View original</button>
            </a>
            <button className="small ghost" type="button" onClick={() => setShowText(!showText)}>
              {showText ? 'Hide' : 'View'} extracted text
            </button>
            {onClose && <button className="small ghost" type="button" onClick={onClose}>Close</button>}
          </span>
        </div>

        <div className={`alert ${STATUS_TONE[document.status] === 'danger' ? 'error'
          : STATUS_TONE[document.status] === 'ok' ? 'ok' : 'info'}`} style={{ marginTop: '.7rem' }}>
          {document.failureReason || STATUS_MESSAGE[document.status] || document.status}
        </div>

        {document.typeConfidence > 0 && document.typeConfidence < 0.6 && (
          <div className="alert warn" style={{ marginTop: '.5rem' }}>
            The document type was detected with low confidence. Please check it is correct before approving.
          </div>
        )}

        {processing && <Loading label="Processing — this usually takes a few seconds." />}

        {canVerify && ['OCR_FAILED', 'NLP_FAILED', 'PROCESSING_FAILED'].includes(document.status) && (
          <button className="small" style={{ marginTop: '.6rem' }} onClick={reprocess} disabled={busy}>
            Try processing again
          </button>
        )}
      </Card>

      {showText && (
        <Card title="Extracted text — exactly what the reader produced">
          <Async query={ocr} empty="No text available.">
            {(d) => (
              <>
                <div className="row small muted" style={{ marginBottom: '.5rem' }}>
                  <span className="badge">{d.engine.replace(/_/g, ' ').toLowerCase()}</span>
                  <span className="badge">reader confidence {pct(d.confidence)}</span>
                  <span className="badge">{d.pageCount} page(s)</span>
                </div>
                {(d.pages?.length ? d.pages : [{ page: 1, text: d.extractedText }]).map((p) => (
                  <div key={p.page} style={{ marginBottom: '.8rem' }}>
                    {d.pages?.length > 1 && <div className="stat-label">Page {p.page}</div>}
                    <pre className="ocr-text">{p.text}</pre>
                  </div>
                ))}
              </>
            )}
          </Async>
        </Card>
      )}

      <ErrorNote error={error} />
      {notice && <div className="alert ok">{notice}</div>}

      {extraction && entities.length > 0 && (
        <Card
          title="Extracted information"
          action={<span className="small muted">
            {extraction.entityCount} item(s){extraction.lowConfidence ? ` · ${extraction.lowConfidence} need checking` : ''}
          </span>}
        >
          {extraction.lowConfidence > 0 && (
            <div className="alert warn" style={{ marginBottom: '.8rem' }}>
              Some information could not be confidently extracted. Please review before saving.
            </div>
          )}
          <p className="small muted">
            This is what the system read from the document. It has not been interpreted, and nothing is
            added to the medical record until {canVerify ? 'you approve it' : 'an authorised reviewer approves it'}.
          </p>

          {groups.map((group) => (
            <div key={group.key} className="review-group">
              <h4>{GROUP_TITLE(group.key)}</h4>
              <div className="grid cols-3">
                {group.items.map((e) => (
                  <EntityField
                    key={e.id} entity={e} value={valueOf(e)} threshold={threshold} editable={editable}
                    rejected={Boolean(rejected[e.id])}
                    onChange={(v) => setEdits({ ...edits, [e.id]: v })}
                    onToggleReject={() => setRejected({ ...rejected, [e.id]: !rejected[e.id] })}
                  />
                ))}
              </div>
            </div>
          ))}

          {loose.length > 0 && (
            <div className="review-group">
              <h4>Details</h4>
              <div className="grid cols-3">
                {loose.map((e) => (
                  <EntityField
                    key={e.id} entity={e} value={valueOf(e)} threshold={threshold} editable={editable}
                    rejected={Boolean(rejected[e.id])}
                    onChange={(v) => setEdits({ ...edits, [e.id]: v })}
                    onToggleReject={() => setRejected({ ...rejected, [e.id]: !rejected[e.id] })}
                  />
                ))}
              </div>
            </div>
          )}

          {editable && (
            <div className="row between" style={{ marginTop: '1rem', paddingTop: '.8rem', borderTop: '1px solid var(--border)' }}>
              <button className="ghost" onClick={saveCorrections} disabled={busy}>Save corrections</button>
              <span className="row">
                <button className="ghost danger-text" onClick={() => decide('REJECT')} disabled={busy}>Reject document</button>
                <button onClick={() => decide('APPROVE')} disabled={busy}>
                  {busy ? 'Saving…' : 'Approve and save to medical record'}
                </button>
              </span>
            </div>
          )}

          {document.status === 'SAVED' && (
            <div className="alert ok" style={{ marginTop: '.8rem' }}>
              Saved to the medical record{document.verifications?.[0]
                ? ` · verified by ${document.verifications[0].reviewedBy.fullName} on ${fmtDateTime(document.verifications[0].reviewedAt)}`
                : ''}.
            </div>
          )}
        </Card>
      )}

      {document.verifications?.length > 0 && (
        <Card title="Verification history">
          <Table
            rows={document.verifications}
            columns={[
              { key: 'reviewedAt', header: 'When', render: (v) => fmtDateTime(v.reviewedAt) },
              { key: 'by', header: 'Reviewed by', render: (v) => `${v.reviewedBy.fullName} (${v.reviewedBy.role.toLowerCase()})` },
              { key: 'status', header: 'Decision', render: (v) => <Badge value={v.status} /> },
              { key: 'remarks', header: 'Remarks', wrap: true },
            ]}
          />
        </Card>
      )}
    </div>
  );
}

// One extracted field with its confidence, editable by the reviewer.
function EntityField({ entity, value, threshold, editable, rejected, onChange, onToggleReject }) {
  const low = entity.confidence < threshold;
  return (
    <div className={`entity ${rejected ? 'entity-rejected' : ''}`}>
      <div className="row between">
        <label style={{ margin: 0 }}>{LABELS[entity.entityType] || entity.entityType}</label>
        <span className={`badge ${low ? 'warn' : 'ok'}`} title={low ? 'Below the auto-accept threshold' : 'High confidence'}>
          {pct(entity.confidence)}
        </span>
      </div>
      <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={!editable || rejected} />
      {entity.sourceText && (
        <div className="entity-source" title={entity.sourceText}>
          from: {entity.sourceText.slice(0, 60)}{entity.sourceText.length > 60 ? '…' : ''}
        </div>
      )}
      {editable && (
        <button type="button" className="small ghost" style={{ marginTop: '.3rem' }} onClick={onToggleReject}>
          {rejected ? 'Keep this' : 'Discard this'}
        </button>
      )}
    </div>
  );
}
