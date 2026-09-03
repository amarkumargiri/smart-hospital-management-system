import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { HOME_FOR_ROLE, useAuth } from '../auth.jsx';
import { Card, ErrorNote } from '../components/ui.jsx';

// The seeded accounts, so the platform can be explored without hunting through
// the seed script for credentials.
const DEMO = [
  ['Patient', 'patient1@example.com'],
  ['Doctor', 'doctor1@sunrisehospital.dev'],
  ['Reception', 'reception@sunrisehospital.dev'],
  ['Reception (second desk)', 'reception2@sunrisehospital.dev'],
];

export default function Login() {
  const { user, login, verifyOtp } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('Password123');
  const [otpStep, setOtpStep] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={HOME_FOR_ROLE[user.role] || '/app'} replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(identifier, password);
      if (result?.requiresOtp) {
        setOtpStep(result);
        // In development the API returns the OTP so the flow can be completed
        // without an SMS provider wired up.
        if (result.devOtp) setCode(result.devOtp);
      } else {
        navigate(HOME_FOR_ROLE[result?.role] || '/app', { replace: true });
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitOtp(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await verifyOtp({ userId: otpStep.userId, code, purpose: otpStep.purpose });
      navigate(HOME_FOR_ROLE[me?.role] || '/app', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-card stack">
        <Card title={otpStep ? 'Verification code' : 'Sign in'}>
          {otpStep ? (
            <form onSubmit={submitOtp}>
              <p className="small muted">{otpStep.message}</p>
              <div className="field">
                <label htmlFor="code">6-digit code</label>
                <input id="code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} inputMode="numeric" required />
              </div>
              <ErrorNote error={error} />
              <div className="row" style={{ marginTop: '.8rem' }}>
                <button disabled={busy}>{busy ? 'Verifying…' : 'Verify'}</button>
                <button type="button" className="ghost" onClick={() => { setOtpStep(null); setError(null); }}>Back</button>
              </div>
            </form>
          ) : (
            <form onSubmit={submit}>
              <div className="field">
                <label htmlFor="identifier">Email or mobile number</label>
                <input id="identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" required />
              </div>
              <div className="field">
                <label htmlFor="password">Password</label>
                <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </div>
              <ErrorNote error={error} />
              <button style={{ width: '100%', marginTop: '.6rem' }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
              <p className="small muted" style={{ marginTop: '.9rem' }}>
                New patient? <Link to="/register">Create an account</Link><br />
                Registering a hospital? <Link to="/register-hospital">Start here</Link>
              </p>
            </form>
          )}
        </Card>

        {!otpStep && (
          <Card title="Demo accounts">
            <p className="small muted">Password for every account: <code>Password123</code>. Click to fill.</p>
            <div className="list">
              {DEMO.map(([label, email]) => (
                <div key={email} className="list-item row between" onClick={() => setIdentifier(email)} style={{ cursor: 'pointer' }}>
                  <span className="small">{label}</span>
                  <code className="small">{email}</code>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
