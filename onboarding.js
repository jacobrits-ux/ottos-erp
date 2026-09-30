// ══════════════════════════════════════════════════════
// EMPLOYEE ONBOARDING — emergency contact + banking details per worker.
// Own onboarding.js file (own <script> tag), loaded AFTER contracts.js and
// BEFORE sync.js. core.js is within ~3KB of the 300KB mobile-parse ceiling,
// so nothing here may grow it beyond the two tiny button hooks in
// renderCrew()/renderCrewCards(). Relies on core.js globals: store, save,
// toast, openModal, closeModalDirect, renderPage.
//
// DATA — stored ON the crew record as `crew.onboarding`:
//   { emergency:{name, relationship, phone, altPhone},
//     bank:{holder, bankName, accountType, accountNumber, branchCode},
//     updatedAt }
// Deliberately on the crew record (not a new Firestore collection): the
// erp/ collection is already staff-only under the published security rules,
// a new collection would need a rules change + republish, and crew records
// already carry idNumber/address/taxNumber. Address + ID number are NOT
// re-captured here; the checklist just reports whether Crew already has them.
//
// PLAIN TEXT, BY DESIGN — banking is stored as typed text (no Firebase
// Storage yet; any "photo of bank confirmation" stays a WhatsApp/email
// exchange outside the app). Consequences to keep in mind: it travels in the
// shared erp/store document and in "Backup Data" exports, so treat backup
// files like the bank details they contain. It is never put in a PDF, a
// WhatsApp/email share, or an AI request by this module.
// ══════════════════════════════════════════════════════

// Universal electronic branch codes (EFT/debit-order codes that work
// nationwide for the named bank). Only a convenience pre-fill — the field
// stays editable, and "Other" leaves it for the user to type.
const OB_BANKS = [
  { name: 'ABSA',          code: '632005' },
  { name: 'African Bank',  code: '430000' },
  { name: 'Bidvest Bank',  code: '462005' },
  { name: 'Capitec',       code: '470010' },
  { name: 'Discovery Bank', code: '679000' },
  { name: 'FNB',           code: '250655' },
  { name: 'Investec',      code: '580105' },
  { name: 'Nedbank',       code: '198765' },
  { name: 'Standard Bank', code: '051001' },
  { name: 'TymeBank',      code: '678910' },
  { name: 'Other',         code: '' },
];
const OB_ACCOUNT_TYPES = ['Cheque / Current', 'Savings', 'Transmission'];
const OB_RELATIONSHIPS = ['Spouse / Partner', 'Parent', 'Child', 'Sibling', 'Friend', 'Other'];

// Crew data is interpolated into HTML attributes and text; escape it so a name
// or note containing quotes/angle brackets cannot break the form or inject markup.
function obEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// SA mobile/landline: 10 digits starting 0, or +27/27 followed by 9 digits.
// Returns the canonical 0XXXXXXXXX form, '' for blank, or null when invalid.
function obNormPhone(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/[^\d\s()+-]/.test(s)) return null;
  s = s.replace(/[\s()-]/g, '');
  if (/^\+27\d{9}$/.test(s)) s = '0' + s.slice(3);
  else if (/^27\d{9}$/.test(s)) s = '0' + s.slice(2);
  return /^0\d{9}$/.test(s) ? s : null;
}
function obFmtPhone(p) {
  return /^0\d{9}$/.test(p || '') ? `${p.slice(0, 3)} ${p.slice(3, 6)} ${p.slice(6)}` : (p || '');
}
// Account numbers differ by bank (roughly 9–11 digits; allow 7–16). Spaces and
// hyphens are stripped because people type them; letters are rejected.
// Returns the digit string, '' for blank, or null when invalid.
function obNormAccount(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/[^\d\s-]/.test(s)) return null;
  const d = s.replace(/[\s-]/g, '');
  return /^\d{7,16}$/.test(d) ? d : null;
}
function obNormBranch(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/[^\d\s]/.test(s)) return null;
  const d = s.replace(/\s/g, '');
  return /^\d{6}$/.test(d) ? d : null;
}
function obMask(acc) {
  const d = String(acc || '');
  return d.length > 4 ? '••••' + d.slice(-4) : (d ? '••••' : '');
}

// For values placed inside an inline onclick="...": HTML-escaping alone is not enough, because
// the browser decodes the entities BEFORE running the JS — so quote it as a JS string first.
function obJs(v) { return obEsc(JSON.stringify(String(v == null ? '' : v))); }

function obFindCrew(crewId) {
  return store.crew.find(x => String(x.id) === String(crewId));
}

// Three checklist items, each true/false. "personal" reads the fields Crew and
// Contracts already capture; the other two are judged on VALID data, so a
// half-typed or malformed entry never counts as done.
function obProgress(c) {
  const ob = (c && c.onboarding) || {};
  const em = ob.emergency || {}, bk = ob.bank || {};
  const personal = !!(String(c && c.address || '').trim() && String(c && c.idNumber || '').trim());
  const emergency = !!(String(em.name || '').trim() && obNormPhone(em.phone));
  const bank = !!(String(bk.holder || '').trim() && bk.bankName && bk.accountType &&
                  obNormAccount(bk.accountNumber) && obNormBranch(bk.branchCode));
  return { personal, emergency, bank, done: [personal, emergency, bank].filter(Boolean).length };
}

// Button dropped into the Crew table row and mobile card by core.js.
function obBtn(c) {
  const p = obProgress(c);
  const label = p.done === 3 ? 'Onboard ✓' : `Onboard ${p.done}/3`;
  return `<button class="action-btn" onclick="openOnboarding(${obJs(c.id)})">${label}</button> `;
}

function obOptions(list, selected, key) {
  return list.map(o => {
    const v = key ? o[key] : o;
    return `<option value="${obEsc(v)}" ${v === selected ? 'selected' : ''}>${obEsc(v)}</option>`;
  }).join('');
}

function openOnboarding(crewId) {
  const c = obFindCrew(crewId);
  if (!c) { toast('Worker not found'); return; }
  const ob = c.onboarding || {};
  const em = ob.emergency || {}, bk = ob.bank || {};
  const p = obProgress(c);
  const tick = ok => ok ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--text3)">○</span>';
  const bankOpts = '<option value="">— Select bank —</option>' + obOptions(OB_BANKS, bk.bankName, 'name');
  const typeOpts = '<option value="">— Select —</option>' + obOptions(OB_ACCOUNT_TYPES, bk.accountType);
  const relOpts  = '<option value="">— Select —</option>' + obOptions(OB_RELATIONSHIPS, em.relationship);
  openModal('ONBOARDING — ' + obEsc(c.name), `<div class="form-grid">
    <div class="form-group full" style="font-size:12px;line-height:1.7;">
      ${tick(p.personal)} Address &amp; ID number ${p.personal ? '' : '<span style="color:var(--text3)">(add under Edit worker)</span>'}<br>
      ${tick(p.emergency)} Emergency contact<br>
      ${tick(p.bank)} Banking details
    </div>
    <div class="form-group full" style="border-top:1px solid var(--border);padding-top:10px;"><label>Emergency contact</label></div>
    <div class="form-group"><label>Name</label><input type="text" id="f-ob-em-name" value="${obEsc(em.name)}" placeholder="Full name"></div>
    <div class="form-group"><label>Relationship</label><select id="f-ob-em-rel">${relOpts}</select></div>
    <div class="form-group"><label>Phone</label><input type="tel" id="f-ob-em-phone" value="${obEsc(obFmtPhone(em.phone))}" placeholder="082 000 0000"></div>
    <div class="form-group"><label>Alternate phone (optional)</label><input type="tel" id="f-ob-em-alt" value="${obEsc(obFmtPhone(em.altPhone))}" placeholder="082 000 0000"></div>
    <div class="form-group full" style="border-top:1px solid var(--border);padding-top:10px;"><label>Banking details</label></div>
    <div class="form-group full"><label>Account holder</label><input type="text" id="f-ob-holder" value="${obEsc(bk.holder)}" placeholder="Name as on the bank account"></div>
    <div class="form-group"><label>Bank</label><select id="f-ob-bank" onchange="obOnBankChange()">${bankOpts}</select></div>
    <div class="form-group"><label>Account type</label><select id="f-ob-type">${typeOpts}</select></div>
    <div class="form-group"><label>Account number</label><input type="text" inputmode="numeric" id="f-ob-acc" value="${obEsc(bk.accountNumber)}" placeholder="Digits only"></div>
    <div class="form-group"><label>Branch code</label><input type="text" inputmode="numeric" id="f-ob-branch" value="${obEsc(bk.branchCode)}" placeholder="6 digits"></div>
    <div class="form-group full" style="font-size:11px;color:var(--text3);line-height:1.5;">
      ${bk.accountNumber ? `Saved account ending ${obEsc(obMask(bk.accountNumber))}. ` : ''}Banking is stored as plain text, visible to signed-in staff and included in Backup Data files. Don't photograph cards or IDs into this app — ask for the bank confirmation letter on WhatsApp or email instead.
    </div>
  </div><div class="form-actions">
    <button class="topbar-btn" onclick="saveOnboarding(${obJs(c.id)})">SAVE</button>
    <button class="topbar-btn secondary" onclick="closeModalDirect()">CANCEL</button>
    ${bk.accountNumber ? `<button class="topbar-btn secondary" onclick="clearOnboardingBank(${obJs(c.id)})">REMOVE BANKING</button>` : ''}
  </div>`);
}

// Picking a bank pre-fills its universal branch code — but only when the field
// is empty or still holds another bank's pre-filled code, so a code the user
// typed deliberately (e.g. a bank-specific one) is never overwritten.
function obOnBankChange() {
  const sel = document.getElementById('f-ob-bank'), br = document.getElementById('f-ob-branch');
  if (!sel || !br) return;
  const bank = OB_BANKS.find(b => b.name === sel.value);
  const cur = br.value.replace(/\s/g, '');
  const isPrefill = !cur || OB_BANKS.some(b => b.code && b.code === cur);
  if (bank && bank.code && isPrefill) br.value = bank.code;
  else if (bank && !bank.code && isPrefill) br.value = '';
}

// Validation result: {ok:true, emergency, bank} or {ok:false, msg}. Either
// section may be left entirely blank (progress can be saved in stages), but a
// section that is started must be complete and valid — a half-saved bank
// account is worse than none.
function obCollect() {
  const v = id => (document.getElementById(id) || {}).value || '';
  const emName = v('f-ob-em-name').trim(), emRel = v('f-ob-em-rel');
  const emPhoneRaw = v('f-ob-em-phone'), emAltRaw = v('f-ob-em-alt');
  let emergency = null;
  if (emName || emRel || emPhoneRaw.trim() || emAltRaw.trim()) {
    const phone = obNormPhone(emPhoneRaw), alt = obNormPhone(emAltRaw);
    if (!emName) return { ok: false, msg: 'Emergency contact name is required' };
    if (!phone) return { ok: false, msg: 'Enter a valid emergency contact phone number (e.g. 082 000 0000)' };
    if (alt === null) return { ok: false, msg: 'Alternate phone number is not valid' };
    emergency = { name: emName, relationship: emRel, phone, altPhone: alt };
  }
  const holder = v('f-ob-holder').trim(), bankName = v('f-ob-bank'), accType = v('f-ob-type');
  const accRaw = v('f-ob-acc'), brRaw = v('f-ob-branch');
  let bank = null;
  if (holder || bankName || accType || accRaw.trim() || brRaw.trim()) {
    const acc = obNormAccount(accRaw), br = obNormBranch(brRaw);
    if (!holder) return { ok: false, msg: 'Account holder name is required' };
    if (!bankName) return { ok: false, msg: 'Select the bank' };
    if (!accType) return { ok: false, msg: 'Select the account type' };
    if (!acc) return { ok: false, msg: 'Account number must be 7–16 digits' };
    if (!br) return { ok: false, msg: 'Branch code must be 6 digits' };
    bank = { holder, bankName, accountType: accType, accountNumber: acc, branchCode: br };
  }
  return { ok: true, emergency, bank };
}

function saveOnboarding(crewId) {
  const c = obFindCrew(crewId);
  if (!c) { toast('Worker not found'); return; }
  const r = obCollect();
  if (!r.ok) { alert(r.msg); return; }
  if (!r.emergency && !r.bank) delete c.onboarding;
  else {
    const next = { updatedAt: new Date().toISOString() };
    if (r.emergency) next.emergency = r.emergency;
    if (r.bank) next.bank = r.bank;
    c.onboarding = next;
  }
  save(); closeModalDirect(); renderPage('crew'); toast('Onboarding saved ✓');
}

function clearOnboardingBank(crewId) {
  const c = obFindCrew(crewId);
  if (!c || !c.onboarding || !c.onboarding.bank) return;
  if (!confirm('Remove the saved banking details for ' + c.name + '?')) return;
  delete c.onboarding.bank;
  if (!c.onboarding.emergency) delete c.onboarding;
  else c.onboarding.updatedAt = new Date().toISOString();
  save(); closeModalDirect(); renderPage('crew'); toast('Banking details removed');
}
