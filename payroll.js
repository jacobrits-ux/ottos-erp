// ══════════════════════════════════════════════════════
// PAYROLL PROCESSING — weekly wage calc from GPS Time Tracking,
// UIF/PAYE tracking, PDF payslips, expense recording.
// Split out into its own payroll.js file (own <script> tag) rather than
// folded into core.js — core.js is already close to the 300KB
// mobile-parse ceiling (see New Chat Briefing, Section 2) and this
// feature has zero dependency on the AI features file, so a third split
// file is the correct boundary. Loads AFTER core.js and ai-features.js —
// relies on core.js globals (store, save, toast, fmt, dt, openModal,
// closeModalDirect, statusBadge, downloadBlob, DEVICE_ID, COMPANY,
// syncEnabled, db, navigate, currentPage) plus the crew.rate /
// crew.uifEnrolled / crew.payeEnrolled fields and the timeSessions
// structure, both already present on core.js's store.
//
// SCOPE NOTE: this is a wage-calculation and record-keeping tool, not a
// SARS e-filing system. UIF/PAYE figures are computed from the rates in
// Payroll Settings (seeded with the 2026/2027 SARS/UIF tables below) and
// are estimates for payslip and expense purposes — reconcile against the
// actual EMP201/EMP501 returns before submitting to SARS. Every rate is
// editable in Settings so this doesn't silently go stale after a Budget.
// ══════════════════════════════════════════════════════

// ── Settings: defaults + accessor ──
const PAYROLL_TAX_YEAR = '2026/2027'; // 1 Mar 2026 – 28 Feb 2027

// SARS 2026/2027 individual tax table (cross-checked against Budget Feb
// 2026 coverage from Xero ZA, TaxTim, Accounter and SalaryCalculator.co.za
// — all agree on the thresholds/rates below). `base` is the cumulative tax
// at each bracket's floor, derived arithmetically from the marginal rates
// (base[n] = base[n-1] + (from[n]-from[n-1]) * rate[n-1]) — not itself an
// independently-published SARS figure, so treat it as internally
// consistent rather than penny-perfect against a SARS worked example.
// `upTo: null` on the last bracket means "no upper limit" — deliberately
// not `Infinity`, which does not survive JSON.stringify/parse for
// localStorage/Firestore storage.
function defaultPayrollTaxBrackets() {
  return [
    { from: 0,       upTo: 245100,  rate: 0.18, base: 0 },
    { from: 245100,  upTo: 383100,  rate: 0.26, base: 44118 },
    { from: 383100,  upTo: 530200,  rate: 0.31, base: 79998 },
    { from: 530200,  upTo: 695800,  rate: 0.36, base: 125599 },
    { from: 695800,  upTo: 887000,  rate: 0.39, base: 185215 },
    { from: 887000,  upTo: 1878600, rate: 0.41, base: 259783 },
    { from: 1878600, upTo: null,    rate: 0.45, base: 666339 },
  ];
}

function defaultPayrollSettings() {
  return {
    taxYear: PAYROLL_TAX_YEAR,
    standardHoursPerDay: 8,          // matches the hours/8 = days convention already used in Time Tracking's Weekly Summary — keep in sync so payslip gross pay reconciles to what Time Tracking already showed as "Est. Pay"
    uifEnabled: true,
    uifEmployeeRate: 0.01,           // 1%
    uifEmployerRate: 0.01,           // 1%, not deducted from the worker — an employer cost, shown on the payslip for transparency
    uifMonthlyCeiling: 17712,        // SARS/UIF earnings ceiling — unchanged since 1 Jun 2021 as of this tax year; verify at ufiling.gov.za
    payeEnabled: false,              // OFF by default — enable per your own judgement on whether formal PAYE applies to this crew; can also be toggled per worker
    primaryRebate: 17820,            // SARS 2026/2027 annual primary rebate (all ages — secondary/tertiary age rebates are not applied here since crew records don't capture date of birth; this is the conservative direction, i.e. slightly over-withholds rather than under-withholds for a 65+ worker)
    taxBrackets: defaultPayrollTaxBrackets(),
    // Employer's own SARS registration status — independent of any single
    // worker's UIF/PAYE enrollment above. OFF by default (matches an
    // unregistered business). Gates the Tax Year Summary below: there's
    // nothing to reconcile against an EMP501 without a PAYE reference
    // number, so that feature stays hidden until this is populated. A
    // future multi-tenant version scopes this per company rather than
    // globally, but the field itself doesn't change shape.
    payeRegistered: false,
    payeReferenceNumber: '',
    lastUpdated: null,
  };
}

function getPayrollSettings() {
  if (!store.payrollSettings || typeof store.payrollSettings !== 'object') {
    store.payrollSettings = defaultPayrollSettings();
  }
  return store.payrollSettings;
}

// ── Payroll Runs — own Firestore collection + own localStorage key,
// deliberately NOT part of store/erp/store. Same reasoning as Job
// Cards/Variation Orders: this grows every pay period, indefinitely, and
// erp/store is a single shared document capped at 1MB by Firestore. ──
const PAYROLL_KEY = 'ottos_erp_payroll_v1';
function loadPayrollRuns() {
  try {
    const s = localStorage.getItem(PAYROLL_KEY);
    if (s) { const p = JSON.parse(s); if (Array.isArray(p)) return p; }
  } catch (e) { console.warn('PayrollRuns load error:', e); }
  return [];
}
function savePayrollRunsLocal() {
  try { localStorage.setItem(PAYROLL_KEY, JSON.stringify(payrollRuns)); }
  catch (e) { console.warn('PayrollRuns save error:', e); }
}
let payrollRuns = loadPayrollRuns();

function savePayrollRun(run) {
  const idx = payrollRuns.findIndex(r => r.id === run.id);
  if (idx !== -1) payrollRuns[idx] = run; else payrollRuns.unshift(run);
  savePayrollRunsLocal();
  if (syncEnabled && db) {
    db.collection('payrollRuns').doc(run.id).set({ ...run, _dev: DEVICE_ID })
      .catch(err => console.warn('Payroll run sync failed:', err));
  }
}

// ── Calculation engine — pure functions, no DOM/store mutation, so they
// can be unit-tested in isolation from the UI layer. ──
function daysBetweenInclusive(startStr, endStr) {
  const start = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  return Math.round((end - start) / 86400000) + 1;
}

function getCompletedSessionsInPeriod(periodStart, periodEnd) {
  const start = new Date(periodStart + 'T00:00:00');
  const end = new Date(periodEnd + 'T23:59:59');
  return (store.timeSessions || []).filter(s => {
    if (!s.clockOut) return false; // only completed sessions have a duration
    const ci = new Date(s.clockIn);
    return ci >= start && ci <= end;
  });
}

function calcWorkerHoursInPeriod(workerName, sessions) {
  const mine = sessions.filter(s => s.worker === workerName);
  const totalMins = mine.reduce((sum, s) => sum + (s.duration || 0), 0);
  return { hoursWorked: totalMins / 60, minutesWorked: totalMins, sessionIds: mine.map(s => s.id) };
}

// Mirrors the existing Weekly Labour Summary formula exactly (hours/8 =
// days, days * day rate = gross) so a payslip's gross pay always
// reconciles to what Time Tracking already previewed as "Est. Pay" for
// the same week — a real trust concern if the two ever silently diverged.
function calcGrossPay(hoursWorked, dayRate, standardHoursPerDay) {
  const days = hoursWorked / (standardHoursPerDay || 8);
  return Math.round(days * dayRate * 100) / 100;
}

const UIF_AVG_DAYS_PER_MONTH = 30.4368; // 365.24 / 12 — used to prorate the monthly UIF ceiling to this run's period length
function calcUIF(grossPay, periodDays, settings) {
  if (!settings.uifEnabled) return { employee: 0, employer: 0, base: 0 };
  const periodCeiling = settings.uifMonthlyCeiling * (periodDays / UIF_AVG_DAYS_PER_MONTH);
  const base = Math.min(grossPay, periodCeiling);
  return {
    employee: Math.round(base * settings.uifEmployeeRate * 100) / 100,
    employer: Math.round(base * settings.uifEmployerRate * 100) / 100,
    base,
  };
}

function taxOnAnnualIncome(annualIncome, brackets) {
  if (!annualIncome || annualIncome <= 0) return 0;
  const b = brackets.find(x => x.upTo === null || annualIncome <= x.upTo) || brackets[brackets.length - 1];
  return b.base + (annualIncome - b.from) * b.rate;
}

// Standard SARS "average" annualisation method for period-based PAYE:
// extrapolate this period's gross to an annual equivalent, tax that via
// the bracket table, subtract the primary rebate, then divide back down
// to a per-period amount. periodDays drives the annualisation factor, so
// this works for weekly, fortnightly, or custom-length runs alike.
function calcPAYE(grossPay, periodDays, settings) {
  if (!settings.payeEnabled) return 0;
  const periodsPerYear = 365.25 / periodDays;
  const annualEquivalent = grossPay * periodsPerYear;
  const annualTax = Math.max(0, taxOnAnnualIncome(annualEquivalent, settings.taxBrackets) - settings.primaryRebate);
  return Math.round((annualTax / periodsPerYear) * 100) / 100;
}

function buildPayslip(crewMember, periodStart, periodEnd, sessions, settings) {
  const { hoursWorked, sessionIds } = calcWorkerHoursInPeriod(crewMember.name, sessions);
  const periodDays = daysBetweenInclusive(periodStart, periodEnd);
  const grossPay = calcGrossPay(hoursWorked, crewMember.rate, settings.standardHoursPerDay);
  const uifEnrolled = crewMember.uifEnrolled !== false; // default true — UIF applies to virtually all employees by law
  const payeEnrolled = !!crewMember.payeEnrolled;        // default false — many day-rate crew may sit below threshold; opt in per worker
  const uif = uifEnrolled ? calcUIF(grossPay, periodDays, settings) : { employee: 0, employer: 0, base: 0 };
  const paye = payeEnrolled ? calcPAYE(grossPay, periodDays, settings) : 0;
  const totalDeductions = Math.round((uif.employee + paye) * 100) / 100;
  return {
    crewId: crewMember.id,
    worker: crewMember.name,
    role: crewMember.role,
    ratePerDay: crewMember.rate,
    hoursWorked: Math.round(hoursWorked * 100) / 100,
    daysWorked: Math.round((hoursWorked / (settings.standardHoursPerDay || 8)) * 100) / 100,
    grossPay,
    uifEnrolled, uifEmployee: uif.employee, uifEmployer: uif.employer,
    payeEnrolled, payeAmount: paye,
    otherDeductions: [],
    totalDeductions,
    netPay: Math.round((grossPay - totalDeductions) * 100) / 100,
    timeSessionIds: sessionIds,
    manualEntry: false,
    paid: false, paidDate: null, paymentMethod: null, expenseId: null,
  };
}

function payrollRunTotals(payslips) {
  return payslips.reduce((t, p) => ({
    grossPay: Math.round((t.grossPay + p.grossPay) * 100) / 100,
    uifEmployee: Math.round((t.uifEmployee + p.uifEmployee) * 100) / 100,
    uifEmployer: Math.round((t.uifEmployer + p.uifEmployer) * 100) / 100,
    payeAmount: Math.round((t.payeAmount + p.payeAmount) * 100) / 100,
    otherDeductions: Math.round((t.otherDeductions + (p.otherDeductions || []).reduce((s, d) => s + d.amount, 0)) * 100) / 100,
    netPay: Math.round((t.netPay + p.netPay) * 100) / 100,
  }), { grossPay: 0, uifEmployee: 0, uifEmployer: 0, payeAmount: 0, otherDeductions: 0, netPay: 0 });
}

function nextPayrollRunId(periodStart) {
  return 'PR-' + periodStart.replace(/-/g, '');
}

function findOverlappingPayrollRun(periodStart, periodEnd, excludeId) {
  const s = new Date(periodStart), e = new Date(periodEnd);
  return payrollRuns.find(r => {
    if (r.id === excludeId || r.status === 'voided') return false;
    const rs = new Date(r.periodStart), re = new Date(r.periodEnd);
    return s <= re && e >= rs; // ranges overlap
  });
}

function buildPayrollRunDraft(periodStart, periodEnd) {
  const settings = getPayrollSettings();
  const sessions = getCompletedSessionsInPeriod(periodStart, periodEnd);
  const eligible = store.crew.filter(c => calcWorkerHoursInPeriod(c.name, sessions).minutesWorked > 0);
  const payslips = eligible.map(c => buildPayslip(c, periodStart, periodEnd, sessions, settings));
  return {
    id: nextPayrollRunId(periodStart),
    periodStart, periodEnd,
    status: 'draft',
    createdAt: new Date().toISOString(),
    finalizedAt: null, voidedAt: null, voidReason: null,
    payslips,
    totals: payrollRunTotals(payslips),
    device: DEVICE_ID,
    notes: '',
  };
}

// ── Draft / review workflow (in-memory only until finalized) ──
let payrollDraft = null;
let payrollViewingRunId = null;

function getLastCompletedWeekRange() {
  const now = new Date();
  const dow = now.getDay() === 0 ? 6 : now.getDay() - 1; // days since Monday this week
  const thisMonday = new Date(now);
  thisMonday.setHours(0, 0, 0, 0);
  thisMonday.setDate(thisMonday.getDate() - dow);
  const lastMonday = new Date(thisMonday); lastMonday.setDate(lastMonday.getDate() - 7);
  const lastSunday = new Date(lastMonday); lastSunday.setDate(lastSunday.getDate() + 6);
  return { start: lastMonday.toISOString().split('T')[0], end: lastSunday.toISOString().split('T')[0] };
}

function showNewPayrollRun() {
  const { start, end } = getLastCompletedWeekRange();
  openModal('NEW PAYROLL RUN', `
    <div class="form-grid">
      <div class="form-group"><label>Period Start</label><input type="date" id="f-pr-start" value="${start}"></div>
      <div class="form-group"><label>Period End</label><input type="date" id="f-pr-end" value="${end}"></div>
    </div>
    <div style="font-family:var(--fm);font-size:10px;color:var(--text3);margin:8px 0;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);">
      Pulls completed Time Tracking sessions in this range, per worker, using each worker's day rate. UIF/PAYE applied per your Payroll Settings and each worker's enrollment — every figure can be adjusted before finalizing.
    </div>
    <div class="form-actions">
      <button class="topbar-btn" onclick="generatePayrollDraftFromModal()">GENERATE DRAFT</button>
      <button class="topbar-btn secondary" onclick="closeModalDirect()">CANCEL</button>
    </div>`);
}

function generatePayrollDraftFromModal() {
  const start = (document.getElementById('f-pr-start') || {}).value;
  const end = (document.getElementById('f-pr-end') || {}).value;
  if (!start || !end) { alert('Both dates are required'); return; }
  if (new Date(end) < new Date(start)) { alert('Period end must be on or after period start'); return; }
  const overlap = findOverlappingPayrollRun(start, end, null);
  if (overlap && !confirm(`This overlaps existing run ${overlap.id} (${overlap.periodStart} → ${overlap.periodEnd}, ${overlap.status}). Continue anyway?`)) return;
  const draft = buildPayrollRunDraft(start, end);
  if (draft.payslips.length === 0) { toast('No completed Time Tracking sessions found in this period — add workers manually below if needed'); }
  payrollDraft = draft;
  payrollViewingRunId = null;
  closeModalDirect();
  navigate('payroll');
}

function recalcPayrollDraftRow(idx) {
  const p = payrollDraft.payslips[idx];
  const otherTotal = (p.otherDeductions || []).reduce((s, d) => s + (d.amount || 0), 0);
  p.totalDeductions = Math.round((p.uifEmployee + p.payeAmount + otherTotal) * 100) / 100;
  p.netPay = Math.round((p.grossPay - p.totalDeductions) * 100) / 100;
  payrollDraft.totals = payrollRunTotals(payrollDraft.payslips);
}

// onchange (not oninput) deliberately — re-renders the whole review table
// to keep the totals footer in sync, and onchange (fires on blur/enter)
// avoids losing input focus on every keystroke the way oninput would.
function payrollDraftFieldChange(idx, field, value) {
  const p = payrollDraft.payslips[idx];
  const num = parseFloat(value);
  const safe = isNaN(num) ? 0 : num;
  if (field === 'grossPay') p.grossPay = safe;
  else if (field === 'uifEmployee') p.uifEmployee = safe;
  else if (field === 'payeAmount') p.payeAmount = safe;
  else if (field === 'otherAmount') p.otherDeductions = safe > 0 ? [{ label: (p.otherDeductions[0] || {}).label || 'Adjustment', amount: safe }] : [];
  else if (field === 'otherLabel') { if (p.otherDeductions[0]) p.otherDeductions[0].label = value || 'Adjustment'; }
  recalcPayrollDraftRow(idx);
  renderPayrollDraftReview();
}

function removePayrollDraftRow(idx) {
  if (!confirm('Remove this worker from the draft run?')) return;
  payrollDraft.payslips.splice(idx, 1);
  payrollDraft.totals = payrollRunTotals(payrollDraft.payslips);
  renderPayrollDraftReview();
}

function showAddWorkerToDraft() {
  if (!payrollDraft) return;
  const already = new Set(payrollDraft.payslips.map(p => p.crewId));
  const available = store.crew.filter(c => !already.has(c.id));
  if (available.length === 0) { toast('All workers are already in this run'); return; }
  openModal('ADD WORKER TO RUN', `
    <div class="form-grid">
      <div class="form-group full"><label>Worker</label><select id="f-add-worker">${available.map(c => `<option value="${c.id}">${c.name} — ${c.role}</option>`).join('')}</select></div>
      <div class="form-group full"><label>Days to Pay</label><input type="number" id="f-add-days" min="0" step="0.5" placeholder="e.g. 5"></div>
    </div>
    <div style="font-family:var(--fm);font-size:10px;color:var(--text3);margin:8px 0;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);">
      For a worker paid this run without logged Time Tracking sessions — e.g. a fixed weekly draw. Marked "(manual)" on the payslip.
    </div>
    <div class="form-actions">
      <button class="topbar-btn" onclick="confirmAddWorkerToDraft()">ADD</button>
      <button class="topbar-btn secondary" onclick="closeModalDirect()">CANCEL</button>
    </div>`);
}

function confirmAddWorkerToDraft() {
  const crewId = (document.getElementById('f-add-worker') || {}).value;
  const days = parseFloat((document.getElementById('f-add-days') || {}).value || '0');
  const c = store.crew.find(x => String(x.id) === String(crewId));
  if (!c || !days) { alert('Select a worker and enter days'); return; }
  const settings = getPayrollSettings();
  const hoursWorked = days * (settings.standardHoursPerDay || 8);
  const grossPay = calcGrossPay(hoursWorked, c.rate, settings.standardHoursPerDay);
  const periodDays = daysBetweenInclusive(payrollDraft.periodStart, payrollDraft.periodEnd);
  const uifEnrolled = c.uifEnrolled !== false;
  const payeEnrolled = !!c.payeEnrolled;
  const uif = uifEnrolled ? calcUIF(grossPay, periodDays, settings) : { employee: 0, employer: 0 };
  const paye = payeEnrolled ? calcPAYE(grossPay, periodDays, settings) : 0;
  const totalDeductions = Math.round((uif.employee + paye) * 100) / 100;
  payrollDraft.payslips.push({
    crewId: c.id, worker: c.name, role: c.role, ratePerDay: c.rate,
    hoursWorked, daysWorked: days, grossPay,
    uifEnrolled, uifEmployee: uif.employee, uifEmployer: uif.employer,
    payeEnrolled, payeAmount: paye,
    otherDeductions: [], totalDeductions,
    netPay: Math.round((grossPay - totalDeductions) * 100) / 100,
    timeSessionIds: [], manualEntry: true,
    paid: false, paidDate: null, paymentMethod: null, expenseId: null,
  });
  payrollDraft.totals = payrollRunTotals(payrollDraft.payslips);
  closeModalDirect();
  renderPayrollDraftReview();
}

function discardPayrollDraft() {
  if (!confirm('Discard this draft? Nothing has been saved yet.')) return;
  payrollDraft = null;
  renderPayrollPage();
  toast('Draft discarded');
}

function finalizePayrollRun() {
  if (!payrollDraft || payrollDraft.payslips.length === 0) { toast('Nothing to finalize'); return; }
  if (payrollDraft.payslips.some(p => p.netPay < 0)) { alert('One or more payslips have a negative net pay — fix before finalizing'); return; }
  payrollDraft.status = 'finalized';
  payrollDraft.finalizedAt = new Date().toISOString();
  payrollDraft.notes = (document.getElementById('pr-notes') || {}).value || '';
  const run = payrollDraft;
  savePayrollRun(run);
  store.activity.unshift({ text: `Payroll run finalized — ${run.id} — ${run.payslips.length} worker(s), ${fmt(run.totals.netPay)} net`, time: 'Just now', type: 'green' });
  save();
  payrollDraft = null;
  updatePayrollBadge();
  toast('Payroll run finalized ✓');
  viewPayrollRun(run.id);
}

// ── Run history & detail ──
function updatePayrollBadge() {
  const count = payrollRuns.filter(r => r.status === 'finalized').reduce((s, r) => s + r.payslips.filter(p => !p.paid).length, 0);
  const badge = document.getElementById('payroll-unpaid-badge');
  if (badge) { badge.textContent = count; badge.style.display = count > 0 ? '' : 'none'; }
}

function viewPayrollRun(runId) {
  payrollViewingRunId = runId;
  payrollDraft = null;
  navigate('payroll');
}

function backToPayrollHistory() {
  payrollViewingRunId = null;
  renderPayrollPage();
}

function showVoidPayrollRun(runId) {
  const run = payrollRuns.find(r => r.id === runId); if (!run) return;
  openModal(`VOID PAYROLL RUN — ${run.id}`, `
    <div style="background:rgba(224,82,82,.08);border:1px solid rgba(224,82,82,.25);padding:10px 14px;margin-bottom:14px;font-size:12px;color:var(--text2)">
      Voiding does not reverse any expense entries already logged via Mark Paid — it flags this run's wage calculation as void/superseded. Any amounts already paid remain a factual record in Expenses.
    </div>
    <div class="form-grid"><div class="form-group full"><label>Reason</label><input type="text" id="f-void-reason" placeholder="e.g. Recalculated after correcting a time entry"></div></div>
    <div class="form-actions">
      <button class="topbar-btn" style="background:var(--red)" onclick="confirmVoidPayrollRun('${runId}')">VOID RUN</button>
      <button class="topbar-btn secondary" onclick="closeModalDirect()">CANCEL</button>
    </div>`);
}

function confirmVoidPayrollRun(runId) {
  const run = payrollRuns.find(r => r.id === runId); if (!run) return;
  const reason = (document.getElementById('f-void-reason') || {}).value;
  if (!reason) { alert('Reason is required'); return; }
  run.status = 'voided';
  run.voidedAt = new Date().toISOString();
  run.voidReason = reason;
  savePayrollRun(run);
  store.activity.unshift({ text: `Payroll run ${run.id} voided — ${reason}`, time: 'Just now', type: 'red' });
  save();
  updatePayrollBadge();
  closeModalDirect();
  renderPayrollPage();
  toast('Payroll run voided');
}

function showMarkPayslipPaid(runId, idx) {
  const run = payrollRuns.find(r => r.id === runId); if (!run) return;
  const p = run.payslips[idx];
  const today = new Date().toISOString().split('T')[0];
  openModal('MARK PAYSLIP PAID', `
    <div style="font-size:13px;margin-bottom:12px;"><strong>${p.worker}</strong> — Net Pay: <span style="color:var(--green);font-family:var(--fm)">${fmt(p.netPay)}</span></div>
    <div class="form-grid">
      <div class="form-group"><label>Payment Date</label><input type="date" id="f-pay-date" value="${today}"></div>
      <div class="form-group"><label>Method</label><select id="f-pay-method"><option>EFT</option><option>Cash</option><option>Other</option></select></div>
    </div>
    <div style="font-family:var(--fm);font-size:10px;color:var(--text3);margin:8px 0;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);">
      Logs ${fmt(p.netPay)} as a Labour expense. UIF/PAYE withheld are tracked separately on the payslip — remit to SARS via your monthly EMP201, not from this button.
    </div>
    <div class="form-actions">
      <button class="topbar-btn" onclick="confirmMarkPayslipPaid('${runId}',${idx})">CONFIRM PAID</button>
      <button class="topbar-btn secondary" onclick="closeModalDirect()">CANCEL</button>
    </div>`);
}

function confirmMarkPayslipPaid(runId, idx) {
  const run = payrollRuns.find(r => r.id === runId); if (!run) return;
  const p = run.payslips[idx];
  const date = (document.getElementById('f-pay-date') || {}).value || new Date().toISOString().split('T')[0];
  const method = (document.getElementById('f-pay-method') || {}).value || 'EFT';
  const expenseId = nextExpenseId();
  store.expenses.unshift({
    id: expenseId,
    desc: `Payroll — ${p.worker} — ${dt(run.periodStart)} to ${dt(run.periodEnd)}`,
    cat: 'Labour', project: '-', supplier: p.worker, amount: p.netPay, date,
    payrollRunId: run.id,
  });
  p.paid = true; p.paidDate = date; p.paymentMethod = method; p.expenseId = expenseId;
  save();
  savePayrollRun(run);
  updatePayrollBadge();
  closeModalDirect();
  renderPayrollPage();
  toast(`${p.worker} marked paid ✓`);
}

// ── Payslip PDF — mirrors buildDocHTML's visual template (brand header,
// totals block, print toolbar) so payslips match the same branded look as
// invoices/quotes, and mirrors the invoice PDF pipeline's in-iframe
// html2pdf approach exactly, since that already solved three real bugs
// (stale gesture, blank cross-document capture, stale cached library). ──
function buildPayslipHTML(run, payslip) {
  const p = payslip;
  const settings = getPayrollSettings();
  const money = n => (n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>PAYSLIP ${p.worker} ${run.id}</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@300;400;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'IBM Plex Sans',sans-serif;font-size:13px;color:#1a1200;background:#fff;}
  @page{size:A4;margin:14mm 14mm 18mm 14mm;}
  @media print{.no-print{display:none!important;}button{display:none!important;}}
  .page{max-width:800px;margin:0 auto;padding:32px 36px;}
  .doc-header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:20px;border-bottom:3px solid #d4a843;margin-bottom:24px;}
  .brand-block{display:flex;align-items:flex-start;gap:14px;}
  .brand-name{font-family:'Cormorant Garamond',serif;font-size:26px;font-weight:600;color:#b8822a;line-height:1;}
  .brand-tagline{font-size:10px;color:#8a7040;letter-spacing:1px;margin-top:3px;text-transform:uppercase;}
  .brand-contact{font-size:11px;color:#5a4a20;line-height:1.7;margin-top:6px;}
  .doc-type-block{text-align:right;}
  .doc-type{font-family:'Cormorant Garamond',serif;font-size:26px;font-weight:600;color:#1a1200;letter-spacing:2px;line-height:1;}
  .doc-num{font-family:'IBM Plex Mono',monospace;font-size:13px;color:#b8822a;margin-top:4px;}
  .doc-dates{font-size:11px;color:#5a4a20;margin-top:6px;line-height:1.8;}
  .bill-section{display:flex;gap:40px;margin-bottom:24px;}
  .bill-to{flex:1;}
  .bill-label{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#8a7040;margin-bottom:6px;}
  .bill-name{font-size:15px;font-weight:600;margin-bottom:2px;}
  .bill-detail{font-size:12px;color:#4a3a10;line-height:1.7;}
  .line-table{width:100%;border-collapse:collapse;margin-bottom:0;}
  .line-table thead tr{background:#d4a843;}
  .line-table thead th{padding:9px 12px;text-align:left;font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#1a1200;font-weight:600;}
  .line-table thead th:last-child{text-align:right;}
  .line-table td{padding:9px 12px;border-bottom:1px solid #e8d89a;font-size:13px;}
  .line-table td:last-child{text-align:right;font-family:monospace;font-weight:600;}
  .line-table tbody tr:nth-child(even) td{background:#fdf8ec;}
  .section-label{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#8a7040;margin:18px 0 6px;}
  .totals-block{width:100%;margin-top:14px;border:1px solid #e8d89a;}
  .total-row{display:flex;justify-content:space-between;padding:7px 14px;font-size:13px;border-bottom:1px solid #e8d89a;}
  .total-row:last-child{border-bottom:none;}
  .total-row.grand{background:#4caf7d;font-weight:700;font-size:16px;}
  .total-label{color:#5a4a20;}
  .total-row.grand .total-label,.total-row.grand .total-val{color:#0d2617;}
  .total-val{font-family:'IBM Plex Mono',monospace;font-weight:600;}
  .info-box{background:#fdf8ec;border:1px solid #e8d89a;padding:12px 14px;font-size:11px;color:#5a4a20;line-height:1.7;margin-top:16px;}
  .doc-footer{margin-top:28px;padding-top:16px;border-top:1px solid #e8d89a;display:flex;gap:30px;}
  .footer-section{flex:1;}
  .footer-label{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#8a7040;margin-bottom:5px;}
  .footer-text{font-size:11px;color:#4a3a10;line-height:1.6;}
  .print-toolbar{background:#1a1200;padding:12px 24px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:100;}
  .ptbtn{padding:8px 16px;font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:600;letter-spacing:1px;cursor:pointer;border:none;text-transform:uppercase;}
  .ptbtn.primary{background:#d4a843;color:#1a1200;}
  .ptbtn.secondary{background:transparent;color:#d4a843;border:1px solid #d4a843;}
  .toolbar-title{font-family:'Cormorant Garamond',serif;font-size:16px;color:#d4a843;flex:1;}
</style></head>
<body>
<div class="print-toolbar no-print">
  <div class="toolbar-title">PAYSLIP — ${p.worker} — ${run.id}</div>
  <button class="ptbtn primary" onclick="window.print()">⬇ DOWNLOAD / PRINT PDF</button>
  <button class="ptbtn secondary" onclick="window.close()">✕ CLOSE</button>
</div>
<div class="page">
  <div class="doc-header">
    <div class="brand-block">
      <svg width="44" height="36" viewBox="0 0 56 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="22" width="8" height="20" fill="none" stroke="#d4a843" stroke-width="2.5"/>
        <rect x="13" y="12" width="8" height="30" fill="none" stroke="#d4a843" stroke-width="2.5"/>
        <rect x="24" y="2" width="8" height="40" fill="none" stroke="#d4a843" stroke-width="2.5"/>
        <rect x="35" y="14" width="8" height="28" fill="none" stroke="#d4a843" stroke-width="2.5"/>
        <rect x="46" y="20" width="8" height="22" fill="none" stroke="#d4a843" stroke-width="2.5"/>
      </svg>
      <div>
        <div class="brand-name">${COMPANY.name}</div>
        <div class="brand-tagline">${COMPANY.tagline}</div>
        <div class="brand-contact">${COMPANY.address}<br>${COMPANY.phone}</div>
      </div>
    </div>
    <div class="doc-type-block">
      <div class="doc-type">PAYSLIP</div>
      <div class="doc-num">${run.id}</div>
      <div class="doc-dates">Pay Period:<br><strong>${dt(run.periodStart)} – ${dt(run.periodEnd)}</strong>${p.paid ? `<br>Paid: <strong>${dt(p.paidDate)}</strong> (${p.paymentMethod || 'EFT'})` : ''}</div>
    </div>
  </div>

  <div class="bill-section">
    <div class="bill-to">
      <div class="bill-label">Employee</div>
      <div class="bill-name">${p.worker}</div>
      <div class="bill-detail">${p.role}</div>
      <div class="bill-detail">Day Rate: R ${money(p.ratePerDay)}</div>
    </div>
    <div class="bill-to">
      <div class="bill-label">Hours / Days This Period</div>
      <div class="bill-name">${p.hoursWorked}h / ${p.daysWorked}d${p.manualEntry ? ' (manual entry)' : ''}</div>
      <div class="bill-detail">UIF: ${p.uifEnrolled ? 'Enrolled' : 'Not enrolled'} &nbsp;·&nbsp; PAYE: ${p.payeEnrolled ? 'Enrolled' : 'Not enrolled'}</div>
    </div>
  </div>

  <div class="section-label">Earnings</div>
  <table class="line-table">
    <thead><tr><th>Description</th><th style="text-align:right">Amount (R)</th></tr></thead>
    <tbody>
      <tr><td>Gross Pay (${p.daysWorked} days @ R${money(p.ratePerDay)}/day)</td><td>${money(p.grossPay)}</td></tr>
    </tbody>
  </table>

  <div class="section-label">Deductions</div>
  <table class="line-table">
    <thead><tr><th>Description</th><th style="text-align:right">Amount (R)</th></tr></thead>
    <tbody>
      ${p.uifEnrolled ? `<tr><td>UIF Contribution (Employee, ${(settings.uifEmployeeRate * 100).toFixed(1)}%)</td><td>−${money(p.uifEmployee)}</td></tr>` : ''}
      ${p.payeEnrolled ? `<tr><td>PAYE (Income Tax)</td><td>−${money(p.payeAmount)}</td></tr>` : ''}
      ${(p.otherDeductions || []).map(d => `<tr><td>${d.label}</td><td>−${money(d.amount)}</td></tr>`).join('')}
      ${(!p.uifEnrolled && !p.payeEnrolled && (!p.otherDeductions || p.otherDeductions.length === 0)) ? `<tr><td colspan="2" style="color:#8a7040">No deductions this period</td></tr>` : ''}
    </tbody>
  </table>

  <div class="totals-block">
    <div class="total-row"><span class="total-label">Gross Pay</span><span class="total-val">R ${money(p.grossPay)}</span></div>
    <div class="total-row"><span class="total-label">Total Deductions</span><span class="total-val">− R ${money(p.totalDeductions)}</span></div>
    <div class="total-row grand"><span class="total-label">NET PAY</span><span class="total-val">R ${money(p.netPay)}</span></div>
  </div>

  ${p.uifEnrolled ? `<div class="info-box"><strong>Employer UIF Contribution (informational — not deducted from employee):</strong> R ${money(p.uifEmployer)}. UIF/PAYE shown are estimates based on ${COMPANY.name}'s configured Payroll Settings (tax year ${settings.taxYear}) — reconcile against the SARS EMP201 monthly return before submitting; this is not a statutory filing.</div>` : ''}

  <div class="doc-footer">
    <div class="footer-section">
      <div class="footer-label">Banking Reference</div>
      <div class="footer-text">${COMPANY.bank}<br>Reference: ${run.id}-${p.crewId}</div>
    </div>
    <div class="footer-section" style="text-align:right;">
      <div class="footer-label">Authorised Signature</div>
      <div style="border-bottom:1px solid #c8b878;width:160px;height:40px;margin-left:auto;margin-top:8px;"></div>
      <div class="footer-text" style="margin-top:4px">${COMPANY.name}</div>
    </div>
  </div>
</div>
</body></html>`;
}

function previewPayslip(runId, idx) {
  const run = payrollRuns.find(r => r.id === runId); if (!run) return;
  const html = buildPayslipHTML(run, run.payslips[idx]);
  const w = window.open('', '_blank', 'width=900,height=750');
  if (!w) { toast('Allow pop-ups to open the payslip preview'); return; }
  w.document.write(html); w.document.close();
}

// Mirrors generateDocPDFBlob's in-iframe html2pdf approach exactly — that
// pipeline already root-caused and fixed a stale-gesture bug, a blank
// cross-document html2canvas capture, and stale-cached-library issue for
// invoices/quotes, so payslip PDFs reuse the same proven mechanism rather
// than risk reintroducing any of the three.
function generatePayslipPDFBlob(run, payslip) {
  const attempt = new Promise((resolve, reject) => {
    let html = buildPayslipHTML(run, payslip);
    html = html.replace(/<div class="print-toolbar no-print">[\s\S]*?(?=<div class="page">)/, '');
    const libTag = '<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"><\/script>';
    html = html.includes('</body>') ? html.replace('</body>', libTag + '</body>') : html + libTag;
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:820px;height:1131px;border:0;';
    document.body.appendChild(iframe);
    const cleanup = () => { if (iframe.parentNode) document.body.removeChild(iframe); };
    iframe.onload = () => {
      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;
      const waitForLib = new Promise((res, rej) => {
        let tries = 0;
        const iv = setInterval(() => {
          tries++;
          if (win.html2pdf) { clearInterval(iv); res(); }
          else if (tries > 100) { clearInterval(iv); rej(new Error('PDF library failed to load inside iframe')); }
        }, 50);
      });
      waitForLib.then(() => {
        const target = doc.querySelector('.page') || doc.body;
        const ready = doc.fonts && doc.fonts.ready ? doc.fonts.ready : new Promise(r => setTimeout(r, 400));
        return ready.then(() => win.html2pdf().set({
          margin: 0,
          filename: payslip.worker.replace(/\s+/g, '_') + '_' + run.id + '.pdf',
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true, windowWidth: 820 },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        }).from(target).outputPdf('blob'));
      }).then(blob => { cleanup(); resolve(blob); }).catch(err => { cleanup(); reject(err); });
    };
    iframe.srcdoc = html;
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('PDF generation timed out after 20s')), 20000));
  return Promise.race([attempt, timeout]);
}

async function sharePayslipPdfOrFallback(runId, idx, fallbackFn) {
  const run = payrollRuns.find(r => r.id === runId); if (!run) return;
  const p = run.payslips[idx];
  let blob;
  try { toast('Preparing PDF…'); blob = await generatePayslipPDFBlob(run, p); }
  catch (err) { console.warn('Payslip PDF generation failed, using text-link fallback:', err); fallbackFn(); return; }
  const filename = p.worker.replace(/\s+/g, '_') + '_' + run.id + '.pdf';
  const file = new File([blob], filename, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    openModal('📄 PDF READY', `
      <div style="text-align:center;padding:6px 0 18px;">
        <div style="font-size:40px;margin-bottom:14px;">📄</div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:20px;">${p.worker}'s payslip PDF is ready to send.</div>
        <button id="payslip-ready-share-btn" style="width:100%;background:var(--accent);color:var(--bg);border:none;padding:14px;font-family:var(--fd);font-size:20px;letter-spacing:1px;cursor:pointer;">📤 TAP TO SHARE</button>
      </div>`);
    const btn = document.getElementById('payslip-ready-share-btn');
    if (btn) btn.onclick = async () => {
      closeModalDirect();
      try { await navigator.share({ files: [file], title: 'Payslip', text: `Payslip for ${p.worker} — ${run.id}` }); }
      catch (err) {
        if (err && err.name === 'AbortError') return;
        console.warn('navigator.share failed, using text-link fallback:', err);
        downloadBlob(blob, filename);
        toast('PDF downloaded — attach it in the message that opens');
        fallbackFn();
      }
    };
    return;
  }
  downloadBlob(blob, filename);
  toast('PDF downloaded — attach it in the message that opens');
  fallbackFn();
}

function sharePayslipWhatsApp(runId, idx) {
  const run = payrollRuns.find(r => r.id === runId); if (!run) return;
  const p = run.payslips[idx];
  const fallback = () => {
    const msg = `Hi ${p.worker}, here's your payslip for ${dt(run.periodStart)} – ${dt(run.periodEnd)}: Net Pay R${p.netPay.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}. — ${COMPANY.name}`;
    const crewMember = store.crew.find(c => c.id === p.crewId) || {};
    const phone = (crewMember.phone || '').replace(/\D/g, '');
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
  };
  sharePayslipPdfOrFallback(runId, idx, fallback);
}

function sharePayslipEmail(runId, idx) {
  const run = payrollRuns.find(r => r.id === runId); if (!run) return;
  const p = run.payslips[idx];
  const fallback = () => {
    const subject = `Payslip — ${p.worker} — ${dt(run.periodStart)} to ${dt(run.periodEnd)}`;
    const body = `Hi ${p.worker},\n\nPlease find your payslip details below.\n\nPeriod: ${dt(run.periodStart)} – ${dt(run.periodEnd)}\nGross Pay: R${p.grossPay.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}\nNet Pay: R${p.netPay.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}\n\nRegards,\n${COMPANY.name}`;
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };
  sharePayslipPdfOrFallback(runId, idx, fallback);
}

// ── Settings modal ──
function showPayrollSettings() {
  const s = getPayrollSettings();
  openModal('⚙ PAYROLL SETTINGS', `
    <div style="font-family:var(--fm);font-size:10px;color:var(--text3);margin-bottom:12px;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);">
      Defaults seeded from published SARS/UIF rates for the ${s.taxYear} tax year. Verify at sars.gov.za and ufiling.gov.za before relying on these for statutory submissions — figures change with each Budget.
    </div>
    <div class="form-grid">
      <div class="form-group"><label>Tax Year Label</label><input type="text" id="f-ps-year" value="${s.taxYear}"></div>
      <div class="form-group"><label>Standard Hours / Day</label><input type="number" id="f-ps-hrs" value="${s.standardHoursPerDay}" step="0.5"></div>
      <div class="form-group full" style="border-top:1px solid var(--border);padding-top:10px;margin-top:4px;">
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;text-transform:none;font-family:var(--fb);"><input type="checkbox" id="f-ps-registered" ${s.payeRegistered ? 'checked' : ''} style="width:auto;" onchange="document.getElementById('f-ps-ref-wrap').style.display=this.checked?'':'none'"> Registered as an employer with SARS (PAYE/UIF)</label>
      </div>
      <div class="form-group full" id="f-ps-ref-wrap" style="display:${s.payeRegistered ? '' : 'none'};">
        <label>PAYE Reference Number</label><input type="text" id="f-ps-ref" value="${s.payeReferenceNumber || ''}" placeholder="7000000000">
        <div style="font-family:var(--fm);font-size:9px;color:var(--text3);margin-top:4px;">Unlocks the Tax Year Summary below Payroll Runs — there's nothing to reconcile against an EMP501 without this.</div>
      </div>
      <div class="form-group full" style="border-top:1px solid var(--border);padding-top:10px;margin-top:4px;">
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;text-transform:none;font-family:var(--fb);"><input type="checkbox" id="f-ps-uif-on" ${s.uifEnabled ? 'checked' : ''} style="width:auto;"> Enable UIF calculation</label>
      </div>
      <div class="form-group"><label>UIF Employee Rate (%)</label><input type="number" id="f-ps-uif-emp" value="${s.uifEmployeeRate * 100}" step="0.1"></div>
      <div class="form-group"><label>UIF Employer Rate (%)</label><input type="number" id="f-ps-uif-empr" value="${s.uifEmployerRate * 100}" step="0.1"></div>
      <div class="form-group full"><label>UIF Monthly Earnings Ceiling (R)</label><input type="number" id="f-ps-uif-ceil" value="${s.uifMonthlyCeiling}"></div>
      <div class="form-group full" style="border-top:1px solid var(--border);padding-top:10px;margin-top:4px;">
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;text-transform:none;font-family:var(--fb);"><input type="checkbox" id="f-ps-paye-on" ${s.payeEnabled ? 'checked' : ''} style="width:auto;"> Enable PAYE calculation</label>
      </div>
      <div class="form-group full"><label>Annual Primary Rebate (R)</label><input type="number" id="f-ps-rebate" value="${s.primaryRebate}"></div>
      <div class="form-group full">
        <label>Tax Brackets (Advanced — JSON)</label>
        <textarea id="f-ps-brackets" rows="7" style="font-family:var(--fm);font-size:10px;">${JSON.stringify(s.taxBrackets, null, 2)}</textarea>
      </div>
    </div>
    <div class="form-actions">
      <button class="topbar-btn" onclick="savePayrollSettingsFromModal()">SAVE SETTINGS</button>
      <button class="topbar-btn secondary" onclick="resetPayrollSettingsDefaults()">↺ RESET TO ${PAYROLL_TAX_YEAR} DEFAULTS</button>
      <button class="topbar-btn secondary" onclick="closeModalDirect()">CANCEL</button>
    </div>`);
}

function savePayrollSettingsFromModal() {
  const s = getPayrollSettings();
  let brackets;
  try {
    brackets = JSON.parse(document.getElementById('f-ps-brackets').value);
    if (!Array.isArray(brackets) || brackets.length === 0) throw new Error('empty');
  } catch (e) { alert('Tax Brackets JSON is invalid — settings not saved'); return; }
  s.taxYear = document.getElementById('f-ps-year').value || s.taxYear;
  s.standardHoursPerDay = parseFloat(document.getElementById('f-ps-hrs').value) || 8;
  s.payeRegistered = document.getElementById('f-ps-registered').checked;
  s.payeReferenceNumber = document.getElementById('f-ps-ref').value.trim();
  s.uifEnabled = document.getElementById('f-ps-uif-on').checked;
  s.uifEmployeeRate = (parseFloat(document.getElementById('f-ps-uif-emp').value) || 0) / 100;
  s.uifEmployerRate = (parseFloat(document.getElementById('f-ps-uif-empr').value) || 0) / 100;
  s.uifMonthlyCeiling = parseFloat(document.getElementById('f-ps-uif-ceil').value) || 0;
  s.payeEnabled = document.getElementById('f-ps-paye-on').checked;
  s.primaryRebate = parseFloat(document.getElementById('f-ps-rebate').value) || 0;
  s.taxBrackets = brackets;
  s.lastUpdated = new Date().toISOString();
  store.payrollSettings = s;
  save();
  closeModalDirect();
  toast('Payroll settings saved ✓');
}

function resetPayrollSettingsDefaults() {
  if (!confirm(`Reset all Payroll Settings to the ${PAYROLL_TAX_YEAR} SARS/UIF defaults? This overwrites your current settings.`)) return;
  store.payrollSettings = defaultPayrollSettings();
  save();
  closeModalDirect();
  showPayrollSettings();
  toast('Reset to defaults ✓');
}

// ── Rendering ──
function renderPayrollPage() {
  updatePayrollBadge();
  const draftSection = document.getElementById('payroll-draft-section');
  const detailSection = document.getElementById('payroll-detail-section');
  const historySection = document.getElementById('payroll-history-section');
  if (payrollDraft) {
    if (draftSection) draftSection.style.display = '';
    if (detailSection) detailSection.style.display = 'none';
    if (historySection) historySection.style.display = 'none';
    renderPayrollDraftReview();
  } else if (payrollViewingRunId) {
    if (draftSection) draftSection.style.display = 'none';
    if (detailSection) detailSection.style.display = '';
    if (historySection) historySection.style.display = 'none';
    renderPayrollRunDetail(payrollViewingRunId);
  } else {
    if (draftSection) draftSection.style.display = 'none';
    if (detailSection) detailSection.style.display = 'none';
    if (historySection) historySection.style.display = '';
    renderPayrollHistory();
  }
}

function renderPayrollDraftReview() {
  if (!payrollDraft) return;
  const periodEl = document.getElementById('payroll-draft-period');
  if (periodEl) periodEl.textContent = `${dt(payrollDraft.periodStart)} – ${dt(payrollDraft.periodEnd)}`;

  const rows = payrollDraft.payslips.map((p, idx) => `
    <tr>
      <td><strong>${p.worker}</strong><br><span class="mono" style="color:var(--text3);font-size:9px">${p.role}</span></td>
      <td class="mono">${p.daysWorked}d / ${p.hoursWorked}h${p.manualEntry ? '<br><span style="color:var(--text3)">(manual)</span>' : ''}</td>
      <td><input type="number" value="${p.grossPay}" step="0.01" style="width:80px;font-family:var(--fm);" onchange="payrollDraftFieldChange(${idx},'grossPay',this.value)"></td>
      <td>${p.uifEnrolled ? `<input type="number" value="${p.uifEmployee}" step="0.01" style="width:70px;font-family:var(--fm);" onchange="payrollDraftFieldChange(${idx},'uifEmployee',this.value)">` : '<span style="color:var(--text3)">—</span>'}</td>
      <td>${p.payeEnrolled ? `<input type="number" value="${p.payeAmount}" step="0.01" style="width:70px;font-family:var(--fm);" onchange="payrollDraftFieldChange(${idx},'payeAmount',this.value)">` : '<span style="color:var(--text3)">—</span>'}</td>
      <td><input type="number" value="${(p.otherDeductions[0] || {}).amount || 0}" step="0.01" style="width:70px;font-family:var(--fm);" placeholder="0" onchange="payrollDraftFieldChange(${idx},'otherAmount',this.value)"></td>
      <td style="font-family:var(--fm);color:var(--green);font-weight:600">${fmt(p.netPay)}</td>
      <td><button class="action-btn danger" onclick="removePayrollDraftRow(${idx})">✕</button></td>
    </tr>`).join('');
  const body = document.getElementById('payroll-draft-body');
  if (body) body.innerHTML = rows || `<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text3);">No workers in this draft — click + Add Worker above</td></tr>`;

  const t = payrollDraft.totals;
  const totalsEl = document.getElementById('payroll-draft-totals');
  if (totalsEl) totalsEl.innerHTML = `
    <td colspan="2" style="font-family:var(--fm);font-size:10px;letter-spacing:1px;">TOTALS</td>
    <td style="font-family:var(--fm);color:var(--accent);font-weight:600">${fmt(t.grossPay)}</td>
    <td style="font-family:var(--fm);color:var(--red)">${fmt(t.uifEmployee)}</td>
    <td style="font-family:var(--fm);color:var(--red)">${fmt(t.payeAmount)}</td>
    <td style="font-family:var(--fm);color:var(--red)">${fmt(t.otherDeductions)}</td>
    <td style="font-family:var(--fm);color:var(--green);font-weight:700">${fmt(t.netPay)}</td>
    <td></td>`;

  const cardsEl = document.getElementById('payroll-draft-cards');
  if (cardsEl) cardsEl.innerHTML = payrollDraft.payslips.map((p, idx) => `
    <div class="card-item">
      <div class="card-item-header"><div><div class="card-item-title">${p.worker}</div><div class="card-item-id">${p.role} · ${p.daysWorked}d</div></div><button class="action-btn danger" onclick="removePayrollDraftRow(${idx})">✕</button></div>
      <div class="card-item-row"><span style="color:var(--text3)">Gross</span><input type="number" value="${p.grossPay}" step="0.01" style="width:90px;font-family:var(--fm);text-align:right;" onchange="payrollDraftFieldChange(${idx},'grossPay',this.value)"></div>
      ${p.uifEnrolled ? `<div class="card-item-row"><span style="color:var(--text3)">UIF (Employee)</span><input type="number" value="${p.uifEmployee}" step="0.01" style="width:90px;font-family:var(--fm);text-align:right;" onchange="payrollDraftFieldChange(${idx},'uifEmployee',this.value)"></div>` : ''}
      ${p.payeEnrolled ? `<div class="card-item-row"><span style="color:var(--text3)">PAYE</span><input type="number" value="${p.payeAmount}" step="0.01" style="width:90px;font-family:var(--fm);text-align:right;" onchange="payrollDraftFieldChange(${idx},'payeAmount',this.value)"></div>` : ''}
      <div class="card-item-row"><span style="color:var(--text3)">Net Pay</span><span style="font-family:var(--fm);color:var(--green);font-weight:600">${fmt(p.netPay)}</span></div>
    </div>`).join('') || '<div style="text-align:center;padding:20px;color:var(--text3);">No workers in this draft</div>';
}

// ── Tax Year Summary — gated behind Settings.payeRegistered, since
// there's nothing to reconcile against an EMP501 without an employer PAYE
// reference number. Aggregates finalized (non-voided) Payroll Runs per
// worker across a SARS tax year (1 Mar–end Feb). This is a working
// summary to prepare an IRP5/EMP501 from — not a SARS submission format
// in itself; that still goes through e@syFile/eFiling.
let currentTaxYearSummary = null;

function getTaxYearBounds(taxYearLabel) {
  const parts = String(taxYearLabel).split('/');
  const startYear = parseInt(parts[0], 10);
  const endYear = parseInt(parts[1], 10) || (startYear + 1);
  const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const febEnd = isLeap(endYear) ? 29 : 28;
  return { start: `${startYear}-03-01`, end: `${endYear}-02-${String(febEnd).padStart(2, '0')}` };
}

function currentSATaxYearLabel() {
  const now = new Date();
  const startYear = now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1; // Mar-Dec: this year starts it; Jan-Feb: previous year does
  return `${startYear}/${startYear + 1}`;
}

function getAvailableTaxYears() {
  const years = new Set([currentSATaxYearLabel()]);
  payrollRuns.filter(r => r.status === 'finalized').forEach(r => {
    const d = new Date(r.periodStart + 'T00:00:00');
    const y = d.getMonth() >= 2 ? d.getFullYear() : d.getFullYear() - 1;
    years.add(`${y}/${y + 1}`);
  });
  return Array.from(years).sort().reverse();
}

function buildTaxYearSummary(taxYearLabel) {
  const { start, end } = getTaxYearBounds(taxYearLabel);
  const runsInYear = payrollRuns.filter(r => r.status === 'finalized' && r.periodStart >= start && r.periodStart <= end);
  const byWorker = {};
  runsInYear.forEach(run => {
    run.payslips.forEach(p => {
      if (!byWorker[p.crewId]) byWorker[p.crewId] = { crewId: p.crewId, worker: p.worker, role: p.role, taxNumber: '', grossPay: 0, uifEmployee: 0, uifEmployer: 0, payeAmount: 0, runCount: 0 };
      const w = byWorker[p.crewId];
      w.grossPay += p.grossPay; w.uifEmployee += p.uifEmployee; w.uifEmployer += p.uifEmployer; w.payeAmount += p.payeAmount; w.runCount += 1;
    });
  });
  Object.values(byWorker).forEach(w => {
    const c = store.crew.find(cr => cr.id === w.crewId);
    w.taxNumber = (c && c.taxNumber) || '';
    w.grossPay = Math.round(w.grossPay * 100) / 100;
    w.uifEmployee = Math.round(w.uifEmployee * 100) / 100;
    w.uifEmployer = Math.round(w.uifEmployer * 100) / 100;
    w.payeAmount = Math.round(w.payeAmount * 100) / 100;
  });
  return { taxYear: taxYearLabel, periodStart: start, periodEnd: end, workers: Object.values(byWorker).sort((a, b) => a.worker.localeCompare(b.worker)), runCount: runsInYear.length };
}

function showTaxYearSummary() {
  if (!getPayrollSettings().payeRegistered) { toast('Enable "Registered as an employer with SARS" in Payroll Settings first'); return; }
  currentTaxYearSummary = buildTaxYearSummary(currentSATaxYearLabel());
  renderTaxYearSummaryModal();
}

function changeTaxYearSummary(label) {
  currentTaxYearSummary = buildTaxYearSummary(label);
  renderTaxYearSummaryModal();
}

function renderTaxYearSummaryModal() {
  const summary = currentTaxYearSummary;
  const missingTax = summary.workers.filter(w => !w.taxNumber);
  openModal(`📋 TAX YEAR SUMMARY`, `
    <select id="f-tys-year" onchange="changeTaxYearSummary(this.value)" style="margin-bottom:10px;">${getAvailableTaxYears().map(y => `<option value="${y}" ${y === summary.taxYear ? 'selected' : ''}>${y}</option>`).join('')}</select>
    <div style="font-family:var(--fm);font-size:10px;color:var(--text3);margin-bottom:12px;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);">
      ${dt(summary.periodStart)} to ${dt(summary.periodEnd)} · ${summary.runCount} finalized run(s). A working summary to prepare your EMP501/IRP5s from — not a SARS submission format itself; that still goes through e@syFile or eFiling.
    </div>
    ${missingTax.length ? `<div style="background:rgba(224,82,82,.08);border:1px solid rgba(224,82,82,.25);padding:8px 12px;margin-bottom:12px;font-size:11px;color:var(--text2)">${missingTax.length} worker(s) have no tax number on file — add it on their Crew record before filing: ${missingTax.map(w => w.worker).join(', ')}</div>` : ''}
    <div class="table-scroll" style="max-height:280px;overflow-y:auto;">
      <table class="data-table">
        <thead><tr><th>Worker</th><th>Tax No.</th><th>Gross</th><th>UIF (Emp.)</th><th>UIF (Empr.)</th><th>PAYE</th></tr></thead>
        <tbody>
          ${summary.workers.map(w => `<tr><td>${w.worker}</td><td class="mono">${w.taxNumber || '—'}</td><td style="font-family:var(--fm)">${fmt(w.grossPay)}</td><td style="font-family:var(--fm)">${fmt(w.uifEmployee)}</td><td style="font-family:var(--fm)">${fmt(w.uifEmployer)}</td><td style="font-family:var(--fm)">${fmt(w.payeAmount)}</td></tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:16px;">No finalized runs in this tax year yet</td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="form-actions">
      <button class="topbar-btn" onclick="downloadTaxYearSummaryCSV()">⬇ DOWNLOAD CSV</button>
      <button class="topbar-btn secondary" onclick="closeModalDirect()">CLOSE</button>
    </div>`);
}

function downloadTaxYearSummaryCSV() {
  if (!currentTaxYearSummary) return;
  const rows = [['Worker', 'Tax Number', 'Role', 'Gross Pay', 'UIF Employee', 'UIF Employer', 'PAYE']];
  currentTaxYearSummary.workers.forEach(w => rows.push([w.worker, w.taxNumber || '', w.role || '', w.grossPay, w.uifEmployee, w.uifEmployer, w.payeAmount]));
  const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `TaxYearSummary_${currentTaxYearSummary.taxYear.replace('/', '-')}.csv`);
  toast('CSV downloaded ✓');
}

function renderPayrollHistory() {
  const tysBtn = document.getElementById('payroll-tax-summary-btn');
  if (tysBtn) tysBtn.style.display = getPayrollSettings().payeRegistered ? '' : 'none';
  const sorted = [...payrollRuns].sort((a, b) => b.periodStart.localeCompare(a.periodStart));
  const body = document.getElementById('payroll-history-body');
  if (body) {
    body.innerHTML = sorted.length ? sorted.map(r => `
      <tr>
        <td class="mono">${r.id}</td>
        <td class="mono">${dt(r.periodStart)} – ${dt(r.periodEnd)}</td>
        <td>${statusBadge(r.status)}</td>
        <td class="mono">${r.payslips.length}</td>
        <td style="font-family:var(--fm);color:var(--accent)">${fmt(r.totals.grossPay)}</td>
        <td style="font-family:var(--fm);color:var(--green)">${fmt(r.totals.netPay)}</td>
        <td><button class="action-btn" onclick="viewPayrollRun('${r.id}')">View</button></td>
      </tr>`).join('') : `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text3);font-family:var(--fm);font-size:11px;">No payroll runs yet — click + NEW PAYROLL RUN to process your first week</td></tr>`;
  }
  const cardsEl = document.getElementById('payroll-history-cards');
  if (cardsEl) {
    cardsEl.innerHTML = sorted.map(r => `
      <div class="card-item">
        <div class="card-item-header"><div><div class="card-item-title">${r.id}</div><div class="card-item-id">${dt(r.periodStart)} – ${dt(r.periodEnd)}</div></div>${statusBadge(r.status)}</div>
        <div class="card-item-row"><span style="color:var(--text3)">Workers</span><span class="mono">${r.payslips.length}</span></div>
        <div class="card-item-row"><span style="color:var(--text3)">Net Pay</span><span style="font-family:var(--fm);color:var(--green)">${fmt(r.totals.netPay)}</span></div>
        <div class="card-item-actions"><button class="action-btn" onclick="viewPayrollRun('${r.id}')">View</button></div>
      </div>`).join('') || '<div style="text-align:center;padding:20px;color:var(--text3);font-family:var(--fm);font-size:11px;">No payroll runs yet</div>';
  }
}

function renderPayrollRunDetail(runId) {
  const run = payrollRuns.find(r => r.id === runId);
  if (!run) { payrollViewingRunId = null; renderPayrollHistory(); return; }
  const rowsHtml = run.payslips.map((p, idx) => `
    <tr>
      <td><strong>${p.worker}</strong><br><span class="mono" style="color:var(--text3);font-size:9px">${p.role}</span></td>
      <td class="mono">${p.daysWorked}d / ${p.hoursWorked}h${p.manualEntry ? '<br><span style="color:var(--text3)">(manual)</span>' : ''}</td>
      <td style="font-family:var(--fm);color:var(--accent)">${fmt(p.grossPay)}</td>
      <td style="font-family:var(--fm);color:var(--red)">${p.uifEnrolled ? fmt(p.uifEmployee) : '—'}</td>
      <td style="font-family:var(--fm);color:var(--red)">${p.payeEnrolled ? fmt(p.payeAmount) : '—'}</td>
      <td style="font-family:var(--fm);color:var(--green);font-weight:600">${fmt(p.netPay)}</td>
      <td>${p.paid ? `<span class="badge badge-green">PAID ${dt(p.paidDate)}</span>` : `<span class="badge badge-yellow">UNPAID</span>`}</td>
      <td style="white-space:nowrap;">
        <button class="action-btn" onclick="previewPayslip('${run.id}',${idx})">PDF</button>
        <button class="action-btn" onclick="sharePayslipWhatsApp('${run.id}',${idx})" style="color:#25D366;border-color:#25D366">WA</button>
        <button class="action-btn" onclick="sharePayslipEmail('${run.id}',${idx})">Email</button>
        ${!p.paid && run.status === 'finalized' ? `<button class="action-btn" onclick="showMarkPayslipPaid('${run.id}',${idx})">Mark Paid</button>` : ''}
      </td>
    </tr>`).join('');
  const body = document.getElementById('payroll-detail-body');
  if (body) body.innerHTML = rowsHtml;

  const cardsEl = document.getElementById('payroll-detail-cards');
  if (cardsEl) cardsEl.innerHTML = run.payslips.map((p, idx) => `
    <div class="card-item">
      <div class="card-item-header"><div><div class="card-item-title">${p.worker}</div><div class="card-item-id">${p.role} · ${p.daysWorked}d</div></div>${p.paid ? `<span class="badge badge-green">PAID</span>` : `<span class="badge badge-yellow">UNPAID</span>`}</div>
      <div class="card-item-row"><span style="color:var(--text3)">Net Pay</span><span style="font-family:var(--fm);color:var(--green);font-weight:600">${fmt(p.netPay)}</span></div>
      <div class="card-item-actions">
        <button class="action-btn" onclick="previewPayslip('${run.id}',${idx})">PDF</button>
        <button class="action-btn" onclick="sharePayslipWhatsApp('${run.id}',${idx})" style="color:#25D366;border-color:#25D366">WA</button>
        <button class="action-btn" onclick="sharePayslipEmail('${run.id}',${idx})">Email</button>
        ${!p.paid && run.status === 'finalized' ? `<button class="action-btn" onclick="showMarkPayslipPaid('${run.id}',${idx})">Mark Paid</button>` : ''}
      </div>
    </div>`).join('');

  const header = document.getElementById('payroll-detail-header');
  if (header) header.innerHTML = `
    <strong>${run.id}</strong> · ${dt(run.periodStart)} – ${dt(run.periodEnd)} · ${statusBadge(run.status)}
    <div class="mono" style="font-size:11px;color:var(--text3);margin-top:4px;">
      Gross ${fmt(run.totals.grossPay)} · UIF (Employee) ${fmt(run.totals.uifEmployee)} · UIF (Employer) ${fmt(run.totals.uifEmployer)} · PAYE ${fmt(run.totals.payeAmount)} · Net ${fmt(run.totals.netPay)}
    </div>${run.status === 'voided' ? `<div style="color:var(--red);font-size:11px;margin-top:4px;">Voided: ${run.voidReason}</div>` : ''}`;

  const voidBtn = document.getElementById('payroll-void-btn');
  if (voidBtn) voidBtn.style.display = run.status === 'finalized' ? '' : 'none';
}

