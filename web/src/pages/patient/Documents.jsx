import { useRef, useState } from 'react';
import { api, tokens } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import DocumentReview from '../../components/DocumentReview.jsx';
import { Async, Badge, Card, ErrorNote, Table, fmtDateTime, useApi } from '../../components/ui.jsx';

const ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
const MAX_BYTES = 15 * 1024 * 1024;

const STATUS_TONE = {
  SAVED: 'ok', VERIFIED: 'ok', REVIEW_REQUIRED: 'warn', NLP_COMPLETED: 'warn',
  OCR_FAILED: 'danger', NLP_FAILED: 'danger', PROCESSING_FAILED: 'danger', REJECTED: 'danger',
};

export default function PatientDocuments() {
  const { user } = useAuth();
  const patientId = user?.patient?.id;
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);

  const query = useApi(() => api.get('/documents', { pageSize: 50 }), [patientId], { skip: !patientId });

  function choose(picked) {
    setError(null);
    if (!picked) { setFile(null); return; }
    // Same checks the server enforces, surfaced before the upload starts.
    const okType = ['application/pdf', 'image/jpeg', 'image/png'].includes(picked.type);
    if (!okType) {
      setError(new Error('Unsupported file type. Please upload PDF, JPG, JPEG, or PNG.'));
      setFile(null);
      return;
    }
    if (picked.size > MAX_BYTES) {
      setError(new Error('This file is larger than 15 MB. Please upload a smaller file.'));
      setFile(null);
      return;
    }
    setFile(picked);
  }

  async function submit(e) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      // FormData needs the browser to set its own multipart boundary, so this
      // one call bypasses the JSON api helper.
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/documents', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.access}` },
        body: form,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Upload failed.');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      setOpenId(data.id);
      query.reload();
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <h1 style={{ marginBottom: '.2rem' }}>Medical documents</h1>
          <div className="muted small">
            Upload a report, prescription or discharge summary and the system will read it for you.
            You check what it found before anything is saved.
          </div>
        </div>
      </div>

      <Card title="Upload a medical document">
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="doc">Choose file</label>
            <input
              id="doc" ref={fileRef} type="file" accept={ACCEPT}
              onChange={(e) => choose(e.target.files?.[0] || null)}
            />
            <div className="small muted" style={{ marginTop: '.35rem' }}>
              Supported: PDF, JPG, JPEG, PNG · up to 15 MB.
              Scanned PDFs without a text layer should be uploaded as images.
            </div>
          </div>
          <ErrorNote error={error} />
          <button disabled={!file || uploading}>
            {uploading ? 'Uploading…' : 'Upload & process'}
          </button>
        </form>
        <p className="small muted" style={{ marginTop: '.9rem', marginBottom: 0 }}>
          The system extracts information from your document. It does not diagnose, prescribe, or
          change anything your doctor has written — and nothing reaches your medical record until you
          approve it.
        </p>
      </Card>

      {openId && (
        <DocumentReview
          documentId={openId}
          canVerify
          onChanged={query.reload}
          onClose={() => { setOpenId(null); query.reload(); }}
        />
      )}

      <Card title="My documents">
        <Async query={query} empty="No documents uploaded yet.">
          {(d) => (
            <Table
              rows={d.items}
              empty="No documents uploaded yet."
              columns={[
                { key: 'file', header: 'File', wrap: true, render: (x) => x.file.originalName },
                { key: 'documentType', header: 'Type', render: (x) => <Badge value={x.documentType} /> },
                { key: 'uploadedAt', header: 'Uploaded', render: (x) => fmtDateTime(x.uploadedAt) },
                { key: 'entityCount', header: 'Items found', num: true },
                { key: 'status', header: 'Status', render: (x) => <Badge value={x.status} tone={STATUS_TONE[x.status]} /> },
                {
                  key: 'actions',
                  header: '',
                  render: (x) => (
                    <button className="small ghost" onClick={() => setOpenId(x.id)}>
                      {x.status === 'REVIEW_REQUIRED' ? 'Review' : 'Open'}
                    </button>
                  ),
                },
              ]}
            />
          )}
        </Async>
      </Card>
    </div>
  );
}
