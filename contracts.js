// ══════════════════════════════════════════════════════
// EMPLOYEE CONTRACTS — capture terms, on-device dual signature
// (employee + manager), branded PDF, WhatsApp/Email sharing.
// Split into its own contracts.js file (own <script> tag) rather than
// folded into core.js — core.js was already within ~2KB of the 300KB
// mobile-parse ceiling after the Payroll addenda. Loads AFTER core.js,
// ai-features.js and payroll.js — relies on core.js globals (store, save,
// toast, fmt, dt, openModal, closeModalDirect, statusBadge, downloadBlob,
// DEVICE_ID, COMPANY, syncEnabled, db, navigate, currentPage,
// initSignaturePad, captureGPS) and on crew fields (rate, idNumber,
// address, phone).
//
// SCOPE NOTE — NOT LEGAL ADVICE: probation, notice period, and annual
// leave defaults below are seeded from BCEA (Basic Conditions of
// Employment Act) minimums as a starting point, editable per contract.
// This is a record-keeping and on-device signing tool, not a substitute
// for a labour law professional reviewing your actual contract wording —
// said plainly on the Contracts page and repeated on every generated PDF.
// ══════════════════════════════════════════════════════

function defaultContractTerms() {
  return {
    standardHoursPerDay: 8,
    workDaysPerWeek: 5,
    probationMonths: 3,
    annualLeaveDays: 21, // BCEA Section 20 minimum per 12-month cycle
    noticePeriodText: 'As per the Basic Conditions of Employment Act: 1 week during the first 6 months of employment, 2 weeks from 6 months to 1 year, and 4 weeks after 1 year of employment.',
    sickLeaveText: '30 days paid sick leave over each 3-year cycle, as per the Basic Conditions of Employment Act.',
  };
}

// ── Data layer — own Firestore collection + own localStorage key,
// deliberately NOT part of store/erp/store. Same reasoning as Job Cards,
// Variation Orders, and Payroll Runs: contracts persist indefinitely and
// carry two embedded signature images each, and erp/store is a single
// shared document capped at 1MB by Firestore. ──
const CONTRACTS_KEY = 'ottos_erp_contracts_v1';
function loadContracts() {
  try {
    const s = localStorage.getItem(CONTRACTS_KEY);
    if (s) { const c = JSON.parse(s); if (Array.isArray(c)) return c; }
  } catch (e) { console.warn('Contracts load error:', e); }
  return [];
}
function saveContractsLocal() {
  try { localStorage.setItem(CONTRACTS_KEY, JSON.stringify(employeeContracts)); }
  catch (e) { console.warn('Contracts save error:', e); }
}
let employeeContracts = loadContracts();

function saveContract(c) {
  const idx = employeeContracts.findIndex(x => x.id === c.id);
  if (idx !== -1) employeeContracts[idx] = c; else employeeContracts.unshift(c);
  saveContractsLocal();
  if (syncEnabled && db) {
    db.collection('employeeContracts').doc(c.id).set({ ...c, _dev: DEVICE_ID })
      .catch(err => console.warn('Contract sync failed:', err));
  }
}

function nextContractId(crewId) {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  return `EC-${crewId}-${ts}`;
}

// ── New Contract form (single modal, no canvas yet — safe to re-render
// the allowances rows in place while this is open) ──
let contractDraft = null;
let contractViewingId = null;

function showNewContract() {
  if (!store.crew.length) { toast('Add a worker under Crew & Workers first'); return; }
  const defaults = defaultContractTerms();
  openModal('NEW EMPLOYEE CONTRACT', contractFormHTML(store.crew[0], defaults, []));
}

function contractFormHTML(crewMember, terms, allowances) {
  const c = crewMember;
  return `
    <div class="form-grid">
      <div class="form-group full"><label>Employee</label><select id="f-ct-crew" onchange="onContractCrewChange()">${store.crew.map(x => `<option value="${x.id}" ${x.id === c.id ? 'selected' : ''}>${x.name} — ${x.role}</option>`).join('')}</select></div>
      <div class="form-group full"><label>ID Number</label><input type="text" id="f-ct-idnum" value="${c.idNumber || ''}" placeholder="13-digit SA ID number"></div>
      <div class="form-group full"><label>Address</label><input type="text" id="f-ct-address" value="${c.address || ''}" placeholder="Residential address"></div>
      <div class="form-group"><label>Start Date</label><input type="date" id="f-ct-start" value="${new Date().toISOString().split('T')[0]}"></div>
      <div class="form-group"><label>Job Title</label><input type="text" id="f-ct-role" value="${c.role}"></div>
      <div class="form-group full" style="border-top:1px solid var(--border);padding-top:10px;margin-top:4px;">
        <label>Pay Structure</label>
        <select id="f-ct-paystruct" onchange="onContractPayStructChange()">
          <option value="day-rate">Day Rate (matches Time Tracking / Payroll)</option>
          <option value="salary">Fixed Salary</option>
        </select>
      </div>
      <div class="form-group" id="f-ct-dayrate-wrap"><label>Day Rate (R)</label><input type="number" id="f-ct-dayrate" value="${c.rate || 0}"></div>
      <div class="form-group" id="f-ct-salary-wrap" style="display:none;"><label>Salary Amount (R)</label><input type="number" id="f-ct-salary" value="0"></div>
      <div class="form-group" id="f-ct-salaryperiod-wrap" style="display:none;"><label>Salary Period</label><select id="f-ct-salaryperiod"><option value="monthly">Monthly</option><option value="weekly">Weekly</option></select></div>
      <div class="form-group"><label>Standard Hours / Day</label><input type="number" id="f-ct-hrs" value="${terms.standardHoursPerDay}" step="0.5"></div>
      <div class="form-group"><label>Work Days / Week</label><input type="number" id="f-ct-days" value="${terms.workDaysPerWeek}"></div>
      <div class="form-group full" style="border-top:1px solid var(--border);padding-top:10px;margin-top:4px;">
        <label>Allowances</label>
        <div id="contract-allowances-rows">${allowanceRowsHTML(allowances)}</div>
        <button class="action-btn" style="margin-top:6px;" onclick="addContractAllowanceRow()">+ Add Allowance</button>
      </div>
      <div class="form-group"><label>Probation (months)</label><input type="number" id="f-ct-probation" value="${terms.probationMonths}"></div>
      <div class="form-group"><label>Annual Leave (days/year)</label><input type="number" id="f-ct-leave" value="${terms.annualLeaveDays}"></div>
      <div class="form-group full"><label>Notice Period</label><textarea id="f-ct-notice" rows="2">${terms.noticePeriodText}</textarea></div>
      <div class="form-group full"><label>Sick Leave</label><textarea id="f-ct-sick" rows="2">${terms.sickLeaveText}</textarea></div>
      <div class="form-group full"><label>Additional Terms (optional)</label><textarea id="f-ct-additional" rows="3" placeholder="Any other agreed terms specific to this role"></textarea></div>
    </div>
    <div style="font-family:var(--fm);font-size:9px;color:var(--text3);margin:10px 0;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);">
      Probation, notice, and leave above are BCEA minimums as a starting point — adjust to what you're actually agreeing, and have a labour law professional review your wording before relying on it in a dispute.
    </div>
    <div class="form-actions">
      <button class="topbar-btn" onclick="continueToContractSigning()">CONTINUE TO SIGNING →</button>
      <button class="topbar-btn secondary" onclick="closeModalDirect()">CANCEL</button>
    </div>`;
}

function allowanceRowsHTML(allowances) {
  return allowances.map((a, i) => `
    <div style="display:flex;gap:8px;margin-bottom:6px;align-items:center;" data-allowance-row="${i}">
      <input type="text" value="${a.label}" placeholder="e.g. Cell Phone Allowance" style="flex:2;" onchange="updateContractAllowance(${i},'label',this.value)">
      <input type="number" value="${a.amount}" placeholder="R" style="flex:1;font-family:var(--fm);" onchange="updateContractAllowance(${i},'amount',this.value)">
      <select style="flex:1;" onchange="updateContractAllowance(${i},'frequency',this.value)">
        <option value="monthly" ${a.frequency === 'monthly' ? 'selected' : ''}>/month</option>
        <option value="weekly" ${a.frequency === 'weekly' ? 'selected' : ''}>/week</option>
        <option value="once-off" ${a.frequency === 'once-off' ? 'selected' : ''}>once-off</option>
      </select>
      <button class="action-btn danger" onclick="removeContractAllowanceRow(${i})">✕</button>
    </div>`).join('') || '<div style="font-size:11px;color:var(--text3);">None yet</div>';
}

// Module-level working copy of the allowances list while the form modal is
// open — re-rendering just the #contract-allowances-rows container is safe
// here because this modal has no signature canvas yet (that only appears
// on the NEXT, separate modal — see continueToContractSigning below).
let contractFormAllowances = [];

function addContractAllowanceRow() {
  contractFormAllowances.push({ label: '', amount: 0, frequency: 'monthly' });
  document.getElementById('contract-allowances-rows').innerHTML = allowanceRowsHTML(contractFormAllowances);
}
function removeContractAllowanceRow(i) {
  contractFormAllowances.splice(i, 1);
  document.getElementById('contract-allowances-rows').innerHTML = allowanceRowsHTML(contractFormAllowances);
}
function updateContractAllowance(i, field, value) {
  if (!contractFormAllowances[i]) return;
  contractFormAllowances[i][field] = field === 'amount' ? (parseFloat(value) || 0) : value;
}

function onContractCrewChange() {
  const crewId = document.getElementById('f-ct-crew').value;
  const c = store.crew.find(x => String(x.id) === String(crewId));
  if (!c) return;
  document.getElementById('f-ct-idnum').value = c.idNumber || '';
  document.getElementById('f-ct-address').value = c.address || '';
  document.getElementById('f-ct-role').value = c.role;
  document.getElementById('f-ct-dayrate').value = c.rate || 0;
}

function onContractPayStructChange() {
  const isSalary = document.getElementById('f-ct-paystruct').value === 'salary';
  document.getElementById('f-ct-dayrate-wrap').style.display = isSalary ? 'none' : '';
  document.getElementById('f-ct-salary-wrap').style.display = isSalary ? '' : 'none';
  document.getElementById('f-ct-salaryperiod-wrap').style.display = isSalary ? '' : 'none';
}

// ── Continue to signing — this is the hard boundary: everything above is
// re-render-safe (no canvas yet). From here on, once the signing modal is
// open, it must NEVER be rebuilt in place — a fresh canvas per attempt,
// exactly like Job Cards' sign-off flow (see initSignaturePad's own
// comment for why: re-rendering destroys the canvas's drawing state). ──
function continueToContractSigning() {
  const crewId = document.getElementById('f-ct-crew').value;
  const c = store.crew.find(x => String(x.id) === String(crewId));
  if (!c) { alert('Select an employee'); return; }
  const payStructure = document.getElementById('f-ct-paystruct').value;
  const dayRate = parseFloat(document.getElementById('f-ct-dayrate').value) || 0;
  const salaryAmount = parseFloat(document.getElementById('f-ct-salary').value) || 0;
  if (payStructure === 'day-rate' && dayRate <= 0) { alert('Enter a day rate'); return; }
  if (payStructure === 'salary' && salaryAmount <= 0) { alert('Enter a salary amount'); return; }

  contractDraft = {
    id: nextContractId(c.id),
    crewId: c.id,
    employeeName: c.name,
    employeeRole: document.getElementById('f-ct-role').value,
    employeeIdNumber: document.getElementById('f-ct-idnum').value.trim(),
    employeeAddress: document.getElementById('f-ct-address').value.trim(),
    employeePhone: c.phone || '',
    startDate: document.getElementById('f-ct-start').value,
    payStructure,
    dayRate: payStructure === 'day-rate' ? dayRate : null,
    salaryAmount: payStructure === 'salary' ? salaryAmount : null,
    salaryPeriod: payStructure === 'salary' ? document.getElementById('f-ct-salaryperiod').value : null,
    standardHoursPerDay: parseFloat(document.getElementById('f-ct-hrs').value) || 8,
    workDaysPerWeek: parseFloat(document.getElementById('f-ct-days').value) || 5,
    allowances: contractFormAllowances.filter(a => a.label.trim() && a.amount > 0),
    probationMonths: parseFloat(document.getElementById('f-ct-probation').value) || 0,
    annualLeaveDays: parseFloat(document.getElementById('f-ct-leave').value) || 21,
    noticePeriodText: document.getElementById('f-ct-notice').value.trim(),
    sickLeaveText: document.getElementById('f-ct-sick').value.trim(),
    additionalTerms: document.getElementById('f-ct-additional').value.trim(),
    status: 'draft',
    createdAt: new Date().toISOString(),
    voidedAt: null, voidReason: null,
    employeeSignature: null, employeeSignedAt: null,
    managerName: '', managerSignature: null, managerSignedAt: null,
    gps: null,
    device: DEVICE_ID,
  };

  // Persist idNumber/address back onto the crew record for reuse next time
  // (e.g. Onboarding or a future contract), since the employee just
  // provided or confirmed them.
  const crewIdx = store.crew.findIndex(x => x.id === c.id);
  if (crewIdx !== -1) {
    store.crew[crewIdx].idNumber = contractDraft.employeeIdNumber;
    store.crew[crewIdx].address = contractDraft.employeeAddress;
    save();
  }

  openModal(`SIGN — ${contractDraft.employeeName}`, contractSignOffHTML());
  setTimeout(() => {
    contractEmployeeSigCanvas = initSignaturePad('contract-emp-sig');
    contractManagerSigCanvas = initSignaturePad('contract-mgr-sig');
  }, 50);
  captureGPS().then(gps => {
    if (contractDraft) contractDraft.gps = gps;
    const el = document.getElementById('contract-gps-line');
    if (el) el.textContent = '📍 ' + gps.address;
  });
}

let contractEmployeeSigCanvas = null;
let contractManagerSigCanvas = null;

function contractSignOffHTML() {
  const c = contractDraft;
  const payLine = c.payStructure === 'day-rate'
    ? `Day rate: R${c.dayRate.toLocaleString('en-ZA')}/day`
    : `Salary: R${c.salaryAmount.toLocaleString('en-ZA')} ${c.salaryPeriod}`;
  return `
    <div style="background:var(--surface2);padding:12px 14px;margin-bottom:14px;font-size:12px;color:var(--text2);line-height:1.8;">
      <div style="font-weight:600;color:var(--text);margin-bottom:4px;">${c.employeeName} — ${c.employeeRole}</div>
      <div>${payLine}</div>
      <div>Starts ${dt(c.startDate)} · ${c.standardHoursPerDay}h/day, ${c.workDaysPerWeek} days/week · ${c.probationMonths}-month probation</div>
      ${c.allowances.length ? `<div>Allowances: ${c.allowances.map(a => `${a.label} (R${a.amount}/${a.frequency})`).join(', ')}</div>` : ''}
    </div>
    <div id="contract-gps-line" style="font-family:var(--fm);font-size:10px;color:var(--text3);margin-bottom:12px;">📍 Capturing location…</div>

    <label style="font-family:var(--fm);font-size:9px;letter-spacing:2px;color:var(--text3);text-transform:uppercase;">Employee Signature</label>
    <canvas id="contract-emp-sig" style="width:100%;height:120px;background:#fff;border:1px solid var(--border);touch-action:none;cursor:crosshair;margin-top:6px;"></canvas>
    <button onclick="contractEmployeeSigCanvas && contractEmployeeSigCanvas._clear()" class="action-btn" style="margin-top:6px;margin-bottom:16px;">CLEAR</button>

    <div class="form-group" style="margin-bottom:10px;"><label>Manager Printed Name</label><input type="text" id="f-ct-manager-name" placeholder="Full name"></div>
    <label style="font-family:var(--fm);font-size:9px;letter-spacing:2px;color:var(--text3);text-transform:uppercase;">Manager Signature</label>
    <canvas id="contract-mgr-sig" style="width:100%;height:120px;background:#fff;border:1px solid var(--border);touch-action:none;cursor:crosshair;margin-top:6px;"></canvas>
    <button onclick="contractManagerSigCanvas && contractManagerSigCanvas._clear()" class="action-btn" style="margin-top:6px;">CLEAR</button>

    <div style="font-family:var(--fm);font-size:9px;color:var(--text3);margin-top:14px;line-height:1.7;">By signing, both parties confirm agreement to the terms above.</div>
    <div class="form-actions">
      <button class="topbar-btn" style="background:var(--green);" onclick="confirmContractSignOff()">✓ CONFIRM &amp; GENERATE CONTRACT</button>
      <button class="topbar-btn secondary" onclick="discardContractDraft()">✕ CANCEL</button>
    </div>`;
}

function discardContractDraft() {
  contractDraft = null;
  contractFormAllowances = [];
  closeModalDirect();
}

function confirmContractSignOff() {
  if (!contractDraft) return;
  const managerName = (document.getElementById('f-ct-manager-name') || {}).value || '';
  if (!managerName.trim()) { alert('Manager printed name is required'); return; }
  if (!contractEmployeeSigCanvas || !contractEmployeeSigCanvas._hasContent()) { alert('Employee signature is required'); return; }
  if (!contractManagerSigCanvas || !contractManagerSigCanvas._hasContent()) { alert('Manager signature is required'); return; }

  const now = new Date().toISOString();
  contractDraft.status = 'signed';
  contractDraft.employeeSignature = contractEmployeeSigCanvas._toDataURL();
  contractDraft.employeeSignedAt = now;
  contractDraft.managerName = managerName.trim();
  contractDraft.managerSignature = contractManagerSigCanvas._toDataURL();
  contractDraft.managerSignedAt = now;

  const contract = contractDraft;
  saveContract(contract);
  store.activity.unshift({ text: `Employee contract signed — ${contract.employeeName}`, time: 'Just now', type: 'green' });
  save();

  contractDraft = null;
  contractFormAllowances = [];
  contractEmployeeSigCanvas = null;
  contractManagerSigCanvas = null;
  closeModalDirect();
  toast('Contract signed ✓');
  viewContract(contract.id);
}

// ── History & detail ──
function viewContract(id) {
  contractViewingId = id;
  navigate('contracts');
}
function backToContractsHistory() {
  contractViewingId = null;
  renderContractsPage();
}

function renderContractsPage() {
  const detailSection = document.getElementById('contract-detail-section');
  const historySection = document.getElementById('contracts-history-section');
  if (contractViewingId) {
    if (detailSection) detailSection.style.display = '';
    if (historySection) historySection.style.display = 'none';
    renderContractDetail(contractViewingId);
  } else {
    if (detailSection) detailSection.style.display = 'none';
    if (historySection) historySection.style.display = '';
    renderContractsHistory();
  }
}

function renderContractsHistory() {
  const sorted = [...employeeContracts].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const payText = c => c.payStructure === 'day-rate' ? `R${c.dayRate}/day` : `R${c.salaryAmount}/${c.salaryPeriod}`;
  const body = document.getElementById('contracts-history-body');
  if (body) body.innerHTML = sorted.length ? sorted.map(c => `
    <tr>
      <td>${c.employeeName}<br><span class="mono" style="color:var(--text3);font-size:9px">${c.employeeRole}</span></td>
      <td class="mono">${dt(c.startDate)}</td>
      <td style="font-family:var(--fm)">${payText(c)}</td>
      <td>${statusBadge(c.status)}</td>
      <td><button class="action-btn" onclick="viewContract('${c.id}')">View</button></td>
    </tr>`).join('') : `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text3);font-family:var(--fm);font-size:11px;">No contracts yet — click + NEW CONTRACT to create one</td></tr>`;

  const cardsEl = document.getElementById('contracts-history-cards');
  if (cardsEl) cardsEl.innerHTML = sorted.map(c => `
    <div class="card-item">
      <div class="card-item-header"><div><div class="card-item-title">${c.employeeName}</div><div class="card-item-id">${c.employeeRole} · ${dt(c.startDate)}</div></div>${statusBadge(c.status)}</div>
      <div class="card-item-row"><span style="color:var(--text3)">Pay</span><span style="font-family:var(--fm)">${payText(c)}</span></div>
      <div class="card-item-actions"><button class="action-btn" onclick="viewContract('${c.id}')">View</button></div>
    </div>`).join('') || '<div style="text-align:center;padding:20px;color:var(--text3);font-family:var(--fm);font-size:11px;">No contracts yet</div>';
}

function renderContractDetail(id) {
  const c = employeeContracts.find(x => x.id === id);
  if (!c) { contractViewingId = null; renderContractsHistory(); return; }
  const header = document.getElementById('contract-detail-header');
  if (header) header.innerHTML = `<strong>${c.employeeName}</strong> — ${c.employeeRole} · ${statusBadge(c.status)}`;
  const payText = c.payStructure === 'day-rate' ? `R${c.dayRate}/day` : `R${c.salaryAmount}/${c.salaryPeriod}`;
  const body = document.getElementById('contract-detail-body');
  if (body) body.innerHTML = `
    <div style="font-size:12px;color:var(--text2);line-height:1.9;margin-bottom:16px;">
      <div>Start Date: ${dt(c.startDate)}</div>
      <div>Pay: ${payText}</div>
      <div>Hours: ${c.standardHoursPerDay}h/day, ${c.workDaysPerWeek} days/week</div>
      <div>Probation: ${c.probationMonths} months · Annual Leave: ${c.annualLeaveDays} days</div>
      ${c.allowances.length ? `<div>Allowances: ${c.allowances.map(a => `${a.label} (R${a.amount}/${a.frequency})`).join(', ')}</div>` : ''}
      ${c.status === 'voided' ? `<div style="color:var(--red);margin-top:6px;">Voided: ${c.voidReason}</div>` : ''}
    </div>
    <div class="form-actions">
      <button class="topbar-btn" onclick="previewContract('${c.id}')">PDF</button>
      <button class="topbar-btn secondary" onclick="shareContractWhatsApp('${c.id}')" style="color:#25D366;border-color:#25D366">WhatsApp</button>
      <button class="topbar-btn secondary" onclick="shareContractEmail('${c.id}')">Email</button>
    </div>`;
  const voidBtn = document.getElementById('contract-void-btn');
  if (voidBtn) voidBtn.style.display = c.status === 'signed' ? '' : 'none';
}

function showVoidContract(id) {
  const c = employeeContracts.find(x => x.id === id); if (!c) return;
  openModal(`VOID CONTRACT — ${c.employeeName}`, `
    <div style="background:rgba(224,82,82,.08);border:1px solid rgba(224,82,82,.25);padding:10px 14px;margin-bottom:14px;font-size:12px;color:var(--text2)">
      Voiding flags this contract as superseded — it does not delete the signed record, which remains as a factual document of what was agreed and when.
    </div>
    <div class="form-grid"><div class="form-group full"><label>Reason</label><input type="text" id="f-void-contract-reason" placeholder="e.g. Superseded by a new contract after a raise"></div></div>
    <div class="form-actions">
      <button class="topbar-btn" style="background:var(--red)" onclick="confirmVoidContract('${id}')">VOID CONTRACT</button>
      <button class="topbar-btn secondary" onclick="closeModalDirect()">CANCEL</button>
    </div>`);
}
function confirmVoidContract(id) {
  const c = employeeContracts.find(x => x.id === id); if (!c) return;
  const reason = (document.getElementById('f-void-contract-reason') || {}).value;
  if (!reason) { alert('Reason is required'); return; }
  c.status = 'voided'; c.voidedAt = new Date().toISOString(); c.voidReason = reason;
  saveContract(c);
  store.activity.unshift({ text: `Contract voided — ${c.employeeName} — ${reason}`, time: 'Just now', type: 'red' });
  save();
  closeModalDirect();
  renderContractsPage();
  toast('Contract voided');
}

// ── PDF — mirrors buildDocHTML/buildPayslipHTML's visual template, plus
// both signature images embedded as <img> tags. ──
function buildContractHTML(c) {
  const money = n => (n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const payLine = c.payStructure === 'day-rate'
    ? `Day rate of R ${money(c.dayRate)} per day worked, calculated per the Company's standard time-tracking records.`
    : `A fixed salary of R ${money(c.salaryAmount)} per ${c.salaryPeriod === 'monthly' ? 'month' : 'week'}.`;
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Employment Contract — ${c.employeeName}</title>
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
  .doc-type{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600;color:#1a1200;letter-spacing:1px;line-height:1.2;}
  .doc-num{font-family:'IBM Plex Mono',monospace;font-size:12px;color:#b8822a;margin-top:4px;}
  .section-label{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#8a7040;margin:18px 0 6px;border-bottom:1px solid #e8d89a;padding-bottom:4px;}
  .clause{font-size:12px;color:#3a2e10;line-height:1.8;margin-bottom:8px;}
  .clause strong{color:#1a1200;}
  .sig-block{display:flex;gap:40px;margin-top:24px;}
  .sig-col{flex:1;}
  .sig-img{width:100%;max-width:260px;height:80px;object-fit:contain;border-bottom:1px solid #1a1200;background:#fff;}
  .sig-label{font-size:11px;color:#5a4a20;margin-top:4px;}
  .print-toolbar{background:#1a1200;padding:12px 24px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:100;}
  .ptbtn{padding:8px 16px;font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:600;letter-spacing:1px;cursor:pointer;border:none;text-transform:uppercase;}
  .ptbtn.primary{background:#d4a843;color:#1a1200;}
  .ptbtn.secondary{background:transparent;color:#d4a843;border:1px solid #d4a843;}
  .toolbar-title{font-family:'Cormorant Garamond',serif;font-size:16px;color:#d4a843;flex:1;}
  .disclaimer{font-size:10px;color:#8a7040;margin-top:20px;padding-top:12px;border-top:1px solid #e8d89a;line-height:1.6;}
</style></head>
<body>
<div class="print-toolbar no-print">
  <div class="toolbar-title">EMPLOYMENT CONTRACT — ${c.employeeName}</div>
  <button class="ptbtn primary" onclick="window.print()">⬇ DOWNLOAD / PRINT PDF</button>
  <button class="ptbtn secondary" onclick="window.close()">✕ CLOSE</button>
</div>
<div class="page">
  <div class="doc-header">
    <div class="brand-block">
      <div>
        <div class="brand-name">${COMPANY.name}</div>
        <div class="brand-tagline">${COMPANY.tagline}</div>
        <div class="brand-contact">${COMPANY.address}<br>${COMPANY.phone}</div>
      </div>
    </div>
    <div class="doc-type-block">
      <div class="doc-type">CONTRACT OF<br>EMPLOYMENT</div>
      <div class="doc-num">${c.id}</div>
    </div>
  </div>

  <div class="section-label">Parties</div>
  <p class="clause"><strong>Employer:</strong> ${COMPANY.name}, ${COMPANY.address}</p>
  <p class="clause"><strong>Employee:</strong> ${c.employeeName}${c.employeeIdNumber ? `, ID No. ${c.employeeIdNumber}` : ''}${c.employeeAddress ? `, of ${c.employeeAddress}` : ''}</p>

  <div class="section-label">Position &amp; Start Date</div>
  <p class="clause">The Employee is appointed as <strong>${c.employeeRole}</strong>, commencing <strong>${dt(c.startDate)}</strong>, subject to a probationary period of <strong>${c.probationMonths} month(s)</strong> from the start date.</p>

  <div class="section-label">Remuneration</div>
  <p class="clause">${payLine}</p>
  ${c.allowances.length ? `<p class="clause"><strong>Allowances:</strong> ${c.allowances.map(a => `${a.label} — R ${money(a.amount)} ${a.frequency === 'once-off' ? '(once-off)' : 'per ' + (a.frequency === 'monthly' ? 'month' : 'week')}`).join('; ')}.</p>` : ''}

  <div class="section-label">Hours of Work</div>
  <p class="clause">${c.standardHoursPerDay} hours per day, ${c.workDaysPerWeek} days per week.</p>

  <div class="section-label">Leave</div>
  <p class="clause"><strong>Annual Leave:</strong> ${c.annualLeaveDays} days per annual leave cycle.</p>
  <p class="clause"><strong>Sick Leave:</strong> ${c.sickLeaveText}</p>

  <div class="section-label">Termination</div>
  <p class="clause">${c.noticePeriodText}</p>

  ${c.additionalTerms ? `<div class="section-label">Additional Terms</div><p class="clause">${c.additionalTerms}</p>` : ''}

  <div class="sig-block">
    <div class="sig-col">
      <img class="sig-img" src="${c.employeeSignature}" alt="Employee signature">
      <div class="sig-label">${c.employeeName} (Employee)<br>${c.employeeSignedAt ? dt(c.employeeSignedAt.split('T')[0]) : ''}</div>
    </div>
    <div class="sig-col">
      <img class="sig-img" src="${c.managerSignature}" alt="Manager signature">
      <div class="sig-label">${c.managerName} (for ${COMPANY.name})<br>${c.managerSignedAt ? dt(c.managerSignedAt.split('T')[0]) : ''}</div>
    </div>
  </div>

  <div class="disclaimer">This contract's probation, notice, and leave terms are based on Basic Conditions of Employment Act minimums as configured by ${COMPANY.name} at the time of signing. It is a record-keeping document, not a substitute for review by a labour law professional.${c.gps && c.gps.address ? ` Signed at approximately: ${c.gps.address}.` : ''}</div>
</div>
</body></html>`;
}

function previewContract(id) {
  const c = employeeContracts.find(x => x.id === id); if (!c) return;
  const html = buildContractHTML(c);
  const w = window.open('', '_blank', 'width=900,height=750');
  if (!w) { toast('Allow pop-ups to open the contract preview'); return; }
  w.document.write(html); w.document.close();
}

function generateContractPDFBlob(c) {
  const attempt = new Promise((resolve, reject) => {
    let html = buildContractHTML(c);
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
          filename: c.employeeName.replace(/\s+/g, '_') + '_Contract.pdf',
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

async function shareContractPdfOrFallback(id, fallbackFn) {
  const c = employeeContracts.find(x => x.id === id); if (!c) return;
  let blob;
  try { toast('Preparing PDF…'); blob = await generateContractPDFBlob(c); }
  catch (err) { console.warn('Contract PDF generation failed, using text-link fallback:', err); fallbackFn(); return; }
  const filename = c.employeeName.replace(/\s+/g, '_') + '_Contract.pdf';
  const file = new File([blob], filename, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    openModal('📄 PDF READY', `
      <div style="text-align:center;padding:6px 0 18px;">
        <div style="font-size:40px;margin-bottom:14px;">📄</div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:20px;">${c.employeeName}'s contract PDF is ready to send.</div>
        <button id="contract-ready-share-btn" style="width:100%;background:var(--accent);color:var(--bg);border:none;padding:14px;font-family:var(--fd);font-size:20px;letter-spacing:1px;cursor:pointer;">📤 TAP TO SHARE</button>
      </div>`);
    const btn = document.getElementById('contract-ready-share-btn');
    if (btn) btn.onclick = async () => {
      closeModalDirect();
      try { await navigator.share({ files: [file], title: 'Employment Contract', text: `Employment contract for ${c.employeeName}` }); }
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

function shareContractWhatsApp(id) {
  const c = employeeContracts.find(x => x.id === id); if (!c) return;
  const fallback = () => {
    const msg = `Hi ${c.employeeName}, here's a copy of your employment contract with ${COMPANY.name}, signed ${dt(c.startDate)}.`;
    const phone = (c.employeePhone || '').replace(/\D/g, '');
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
  };
  shareContractPdfOrFallback(id, fallback);
}
function shareContractEmail(id) {
  const c = employeeContracts.find(x => x.id === id); if (!c) return;
  const fallback = () => {
    const subject = `Employment Contract — ${c.employeeName}`;
    const body = `Hi ${c.employeeName},\n\nPlease find a copy of your signed employment contract with ${COMPANY.name}.\n\nRegards,\n${COMPANY.name}`;
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };
  shareContractPdfOrFallback(id, fallback);
}

