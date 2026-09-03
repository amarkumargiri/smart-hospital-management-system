import { Link, Navigate } from 'react-router-dom';
import { HOME_FOR_ROLE, useAuth } from '../auth.jsx';

// Public front page. Anyone already signed in is sent to their own dashboard
// rather than being shown a marketing page they do not need.

const ROLES = [
  {
    name: 'Patient',
    line: 'Find care and keep the record',
    points: [
      'Search hospitals by city, specialty and live bed availability',
      'Book a real slot from the doctor’s published clinic hours',
      'Live OPD queue — your token, who is being seen, how long left',
      'Every consultation, prescription and lab report in one place',
      'Itemised bills with UPI, card and net-banking payment',
    ],
  },
  {
    name: 'Doctor',
    line: 'Run the clinic, write the record',
    points: [
      'Today’s list, pending requests, follow-ups and critical results',
      'Consultation workspace: symptoms, vitals, ICD-coded diagnosis',
      'Prescriptions with full dosing, and lab orders by priority',
      'Complete patient history while consulting, not after',
      'Admission requests and discharge summaries',
    ],
  },
  {
    name: 'Reception',
    line: 'Everything the hospital runs on',
    points: [
      'Booking, check-in and token queue at the front desk',
      'Ward map, ICU, admissions, transfers and theatre board',
      'Laboratory pipeline and pharmacy stock with expiry control',
      'Billing, payments, insurance claims and seven CSV reports',
      'Demand forecasting and capacity alerts',
    ],
  },
];

const MODULES = [
  ['Appointments', 'Slot generation, lifecycle, token queue'],
  ['Consultations', 'Vitals, diagnosis, treatment plan, follow-up'],
  ['Prescriptions', 'Dose, frequency, duration, route, instructions'],
  ['Laboratory', 'Order → sample → result → independent verification'],
  ['Pharmacy', 'Batches, expiry, reorder levels, dispensing'],
  ['Beds & ICU', 'Live ward map, ventilators, occupancy'],
  ['Admissions', 'Approval, bed allocation, transfer, discharge'],
  ['Emergency', 'Walk-in triage, doctor assignment, escalation'],
  ['Theatres', 'Overlap-checked surgery scheduling'],
  ['Billing', 'Automatic bills, payments, insurance claims'],
  ['Analytics', 'Patient, doctor, financial and operational views'],
  ['Audit', 'Who saw what, who changed what, when'],
];

const ACCURACY = [
  ['ICU occupancy', 'Linear trend', '2.5%'],
  ['Oxygen consumption', 'Holt-Winters', '3.2%'],
  ['OPD visits', 'Holt-Winters', '4.5%'],
  ['Bed occupancy', 'Holt-Winters', '8.5%'],
  ['IPD admissions', 'Holt-Winters', '9.4%'],
];

const JOURNEY = ['Books', 'Confirmed', 'Checked in', 'Consulted', 'Lab & pharmacy', 'Billed', 'Follow-up'];

export default function Landing() {
  const { user, loading } = useAuth();
  if (!loading && user) return <Navigate to={HOME_FOR_ROLE[user.role] || '/app'} replace />;

  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-wrap row between">
          <div className="brand" style={{ padding: 0 }}>
            <span className="brand-mark">+</span>
            <span>Smart Hospital</span>
          </div>
          <nav className="row">
            <a className="landing-navlink" href="#roles">Who it is for</a>
            <a className="landing-navlink" href="#forecasting">Forecasting</a>
            <a className="landing-navlink" href="#modules">Modules</a>
            <Link to="/login"><button className="ghost small">Sign in</button></Link>
          </nav>
        </div>
      </header>

      {/* --- hero ---------------------------------------------------- */}
      <section className="landing-hero">
        <div className="landing-wrap">
          <span className="pill">Hospital management · patient care · demand forecasting</span>
          <h1>
            One platform for the whole patient journey — and for{' '}
            <span className="accent">what the hospital needs next week.</span>
          </h1>
          <p className="hero-sub">
            Registration, appointments, consultations, laboratory, pharmacy, wards, billing and
            analytics in a single system — with a forecasting engine that predicts OPD, bed, ICU,
            oxygen and blood demand 7, 14 and 30 days ahead, and warns before capacity runs out.
          </p>
          <div className="row" style={{ gap: '.7rem', marginTop: '1.6rem' }}>
            <Link to="/login"><button className="big">Sign in</button></Link>
            <Link to="/register"><button className="ghost big">Create a patient account</button></Link>
            <Link to="/register-hospital"><button className="ghost big">Register a hospital</button></Link>
          </div>
          <p className="small muted" style={{ marginTop: '1rem' }}>
            Exploring it? Every demo account uses the password <code>Password123</code> — the sign-in
            page lists them.
          </p>

          <div className="hero-stats">
            <div><strong>3</strong><span>roles</span></div>
            <div><strong>7</strong><span>forecast metrics</span></div>
            <div><strong>45</strong><span>forecasts per run</span></div>
            <div><strong>~150 ms</strong><span>to generate them</span></div>
          </div>
        </div>
      </section>

      {/* --- journey ------------------------------------------------- */}
      <section className="landing-band">
        <div className="landing-wrap">
          <h2 className="section-title">One episode, end to end</h2>
          <div className="journey">
            {JOURNEY.map((step, i) => (
              <span key={step} className="journey-step">
                <span className="journey-dot">{i + 1}</span>
                {step}
              </span>
            ))}
          </div>
          <p className="small muted" style={{ textAlign: 'center', marginTop: '.8rem' }}>
            Each handover is a real state transition the system enforces — an appointment cannot skip
            from requested to completed, and a lab result cannot reach a patient unverified.
          </p>
        </div>
      </section>

      {/* --- roles --------------------------------------------------- */}
      <section className="landing-section" id="roles">
        <div className="landing-wrap">
          <h2 className="section-title">Three roles, nothing spare</h2>
          <p className="section-sub">
            A small hospital does not staff seven separate software logins. Patients ask for care,
            doctors deliver it, and reception runs everything else.
          </p>
          <div className="grid cols-3">
            {ROLES.map((r) => (
              <div className="role-card" key={r.name}>
                <h3>{r.name}</h3>
                <p className="role-line">{r.line}</p>
                <ul>
                  {r.points.map((p) => <li key={p}>{p}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --- forecasting --------------------------------------------- */}
      <section className="landing-band" id="forecasting">
        <div className="landing-wrap">
          <span className="pill">The differentiator</span>
          <h2 className="section-title" style={{ textAlign: 'left', marginTop: '.6rem' }}>
            It does not just record the past. It forecasts the demand.
          </h2>
          <div className="grid cols-2" style={{ alignItems: 'start', marginTop: '1.2rem' }}>
            <div>
              <p>
                Every day of operations is rolled into one row per hospital. A quality gate drops
                impossible rows and flags genuine surges. Then four models — moving average, seasonal
                naive, linear trend and Holt-Winters with a seven-day season — compete on a held-out
                window, and the lowest error wins.
              </p>
              <p>
                The winner is refit on the full series and produces the forecast with a 95% confidence
                band. The dashboard prints the winning model and its error rate beside every number, so
                a prediction is never shown as more certain than it is.
              </p>
              <div className="alert-demo">
                <strong>⚠ ICU capacity risk</strong>
                Forecasted ICU occupancy is expected to reach 91% within 7 days (currently 82%).
                <span>Recommended: review ICU capacity, ventilator availability and critical-care staffing.</span>
              </div>
            </div>
            <div>
              <div className="accuracy-card">
                <h4>Measured accuracy on two years of data</h4>
                <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Metric</th><th>Winning model</th><th className="num">MAPE</th></tr>
                  </thead>
                  <tbody>
                    {ACCURACY.map(([metric, model, mape]) => (
                      <tr key={metric}>
                        <td>{metric}</td>
                        <td className="muted">{model}</td>
                        <td className="num"><strong>{mape}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                <p className="small muted" style={{ marginTop: '.6rem' }}>
                  Different metrics pick different winners — which is the point of racing them.
                </p>
              </div>
              <div className="row" style={{ gap: '.4rem', marginTop: '.8rem' }}>
                {['OPD', 'IPD', 'Beds', 'ICU', 'Theatre', 'Oxygen', 'Blood by group'].map((m) => (
                  <span className="badge info" key={m}>{m}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* --- modules ------------------------------------------------- */}
      <section className="landing-section" id="modules">
        <div className="landing-wrap">
          <h2 className="section-title">What is inside</h2>
          <p className="section-sub">Twelve working modules, not twelve placeholders.</p>
          <div className="module-grid">
            {MODULES.map(([name, line]) => (
              <div className="module" key={name}>
                <strong>{name}</strong>
                <span>{line}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --- trust --------------------------------------------------- */}
      <section className="landing-band">
        <div className="landing-wrap">
          <h2 className="section-title">Built like clinical software, not a demo</h2>
          <div className="grid cols-3" style={{ marginTop: '1rem' }}>
            <div className="trust">
              <h4>Records stay private</h4>
              <p>
                A doctor reaches a chart only through a real treating relationship — an appointment,
                admission, lab order or prescription. Reception is scoped to its own hospital. Every
                record opened is audited.
              </p>
            </div>
            <div className="trust">
              <h4>Two people, one bed</h4>
              <p>
                Slot booking and bed allocation are settled by the database, not by an application
                check a second request can slip past. The loser gets a clear message, never a double
                booking.
              </p>
            </div>
            <div className="trust">
              <h4>Results need four eyes</h4>
              <p>
                A lab result is invisible to the patient until someone other than the person who
                entered it releases it. Bills recompute from their line items, so a total can never
                disagree with what it is made of.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* --- cta ----------------------------------------------------- */}
      <section className="landing-cta">
        <div className="landing-wrap">
          <h2>Ready to look around?</h2>
          <p className="muted">
            Sign in with a demo account, or create a real patient account in under a minute.
          </p>
          <div className="row" style={{ justifyContent: 'center', gap: '.7rem', marginTop: '1.2rem' }}>
            <Link to="/login"><button className="big">Sign in</button></Link>
            <Link to="/register"><button className="ghost big">Create an account</button></Link>
          </div>
        </div>
      </section>

      <footer className="landing-foot">
        <div className="landing-wrap row between">
          <span className="small muted">
            Smart Hospital Management, Patient Care &amp; Forecasting Platform
          </span>
          <span className="row small">
            <Link to="/login">Sign in</Link>
            <Link to="/register">Patient sign-up</Link>
            <Link to="/register-hospital">Hospital sign-up</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
