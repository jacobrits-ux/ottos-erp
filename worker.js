// ══════════════════════════════════════════════════════
// WORKER ROLE — round 1: cell-number login, worker profiles, landing page.
// Own worker.js file (own <script> tag), loaded AFTER roles.js and BEFORE sync.js.
// core.js is near its size ceiling, so it carries one tiny guarded hook for this file
// (renderPage routes 'myjobs' to window.renderMyJobs); roles.js and sync.js call in
// through window-guarded hooks (wkApplyRole, wkSignIn).
//
// THE SECURITY BOUNDARY IS THE FIRESTORE RULES, NOT THIS FILE. A worker profile
// (role 'worker') is granted nothing by the rules except reading its own users/{uid}
// document; the menu hiding here is convenience for honest users.
//
// HOW A WORKER SIGNS IN. Firebase Auth needs an email-shaped identifier, so a worker's
// login is derived from the cell number on their Crew record:
//     0821234567@workers.invalid        first login
//     0821234567-2@workers.invalid      replacement login (owner-created), then -3 … -5
// The worker only ever types the cell number and a password; wkSignIn tries the
// numbered logins in order. Why a counter: the client SDK cannot reset or delete
// another user's login, so a forgotten password means a NEW login, and the old email
// is taken. Cloud Functions would remove this limit (SaaS foundation phase).
//
// WHY ".invalid": Firebase will send a password-reset email to ANY address if someone
// calls its public API. On a domain someone could register, that would let them take
// over a worker's login. ".invalid" is reserved (RFC 2606) and can never be registered.
//
// The rules enforce the same address shape (worker role <=> this email pattern), so the
// two regexes below must stay identical to the one in firestore.rules (a test checks it).
// ══════════════════════════════════════════════════════

const WK_EMAIL_DOMAIN = 'workers.invalid';
const WK_MAX_LOGINS = 5;
const WK_EMAIL_RE = /^(0[6-8]\d{8})(?:-([2-5]))?@workers\.invalid$/;

let wkLastCreated = null;   // {crewId, email, uid}: login made but its profile write failed, so a retry reuses it
let wkSigningIn = false;

function wkEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Cell numbers and derived logins (pure functions) ────────────────────────────
// SA cell numbers only: 06x, 07x, 08x. Accepts spaces, hyphens, brackets, +27, 27 and 0027.
// Returns the canonical 0XXXXXXXXX form, or null when it is not a usable cell number.
function wkNormCell(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s || /[^\d\s()+-]/.test(s)) return null;
  s = s.replace(/[\s()-]/g, '');
  if (/^\+27\d{9}$/.test(s)) s = '0' + s.slice(3);
  else if (/^0027\d{9}$/.test(s)) s = '0' + s.slice(4);
  else if (/^27\d{9}$/.test(s)) s = '0' + s.slice(2);
  return /^0[6-8]\d{8}$/.test(s) ? s : null;
}
function wkFmtCell(cell) {
  return /^0\d{9}$/.test(cell || '') ? `${cell.slice(0, 3)} ${cell.slice(3, 6)} ${cell.slice(6)}` : String(cell || '');
}
function wkLoginEmail(cell, attempt) {
  const n = attempt == null ? 1 : attempt;
  if (!/^0[6-8]\d{8}$/.test(String(cell)) || !Number.isInteger(n) || n < 1 || n > WK_MAX_LOGINS) return null;
  return n === 1 ? `${cell}@${WK_EMAIL_DOMAIN}` : `${cell}-${n}@${WK_EMAIL_DOMAIN}`;
}
// {cell, attempt} for a derived login email, or null for any other address.
function wkParseLoginEmail(email) {
  const m = WK_EMAIL_RE.exec(String(email || '').toLowerCase());
  return m ? { cell: m[1], attempt: m[2] ? Number(m[2]) : 1 } : null;
}
// What the Users screen shows instead of the made-up address.
function wkDisplayId(u) {
  if (!u || u.role !== 'worker') return u && u.email;
  const p = wkParseLoginEmail(u.email);
  if (!p) return u.email;
  return `Cell ${wkFmtCell(p.cell)}${p.attempt > 1 ? ` · login ${p.attempt}` : ''}`;
}

// ── Signing in with a cell number ───────────────────────────────────────────────
// Wrong-password and unknown-account answers look the same to us (Firebase can hide the
// difference), so each means "try the next numbered login". Anything else stops at once:
// retrying through rate limits, a dead connection or a disabled account only makes it worse.
const WK_TRY_NEXT = ['auth/user-not-found', 'auth/wrong-password', 'auth/invalid-credential', 'auth/invalid-login-credentials'];
const WK_SIGNIN_ERRORS = {
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/network-request-failed': 'No connection. Try again when you are online.',
  'auth/user-disabled': 'This login has been switched off. Ask an owner.',
};

async function wkSignIn(raw, password, errEl) {
  const say = m => { if (errEl) errEl.textContent = m; };
  if (wkSigningIn) return;
  const cell = wkNormCell(raw);
  if (!cell) { say('Enter your cell number (for example 082 123 4567) or your email address.'); return; }
  wkSigningIn = true;
  try {
    for (let n = 1; n <= WK_MAX_LOGINS; n++) {
      try {
        await firebase.auth().signInWithEmailAndPassword(wkLoginEmail(cell, n), password);
        return;   // onAuthStateChanged takes it from here (profile check, then the app)
      } catch (err) {
        const code = err && err.code;
        if (WK_TRY_NEXT.indexOf(code) !== -1) continue;
        say(WK_SIGNIN_ERRORS[code] || ('Sign-in failed (' + (code || (err && err.message) || 'unknown error') + ').'));
        return;
      }
    }
    say('Cell number or password is not correct. If you forgot your password, ask an owner to set up a new login for you.');
  } finally {
    wkSigningIn = false;
  }
}

// ── Applying the worker role to the UI (convenience only; the rules are the boundary) ──
function wkIsWorker() { return !!(currentProfile && currentProfile.role === 'worker'); }
// An owner who also does jobs has their profile linked to their crew record and gets My Jobs too.
function wkHasMyJobs() {
  return !!(currentProfile && currentProfile.active === true &&
    (currentProfile.role === 'worker' || (currentProfile.role === 'owner' && currentProfile.crewId)));
}

function wkApplyRole() {
  const worker = wkIsWorker();
  const hasPage = wkHasMyJobs();
  const navEl = document.getElementById('nav-myjobs');
  const bnavEl = document.getElementById('bnav-myjobs');
  const primary = document.getElementById('topbar-primary');
  const sections = document.querySelectorAll('.nav-section');

  if (!hasPage || !worker) {
    if (bnavEl) bnavEl.remove();
    if (primary) primary.style.display = '';
    sections.forEach(s => { s.style.display = ''; });
    if (!hasPage) { if (navEl) navEl.remove(); return; }
  }

  if (!navEl) {
    const el = document.createElement('div');
    el.className = 'nav-item';
    el.id = 'nav-myjobs';
    el.setAttribute('onclick', "navigate('myjobs')");
    el.innerHTML = '<span class="nav-icon">◈</span>My Jobs';
    const sidebar = document.getElementById('sidebar');
    const logo = sidebar && sidebar.querySelector('.logo');
    if (logo) logo.insertAdjacentElement('afterend', el);
    else if (sidebar) sidebar.insertBefore(el, sidebar.firstChild);
  }
  if (!worker) return;   // an owner gets the menu entry only; the rest of their menu is untouched
  if (!bnavEl) {
    const more = document.getElementById('bnav-more');
    if (more) {
      const b = document.createElement('button');
      b.className = 'bnav-item';
      b.id = 'bnav-myjobs';
      b.setAttribute('onclick', "navigate('myjobs')");
      b.innerHTML = '<span class="bnav-icon">◈</span><span>My Jobs</span>';
      more.insertAdjacentElement('beforebegin', b);
    }
  }
  // "+ NEW" does nothing for a worker; sections whose items are all hidden would be empty headings.
  if (primary) primary.style.display = 'none';
  sections.forEach(s => {
    const items = [...s.querySelectorAll('.nav-item')];
    s.style.display = items.length && items.every(i => i.style.display === 'none') ? 'none' : '';
  });
  if (typeof navigate === 'function' && currentPage !== 'myjobs') navigate('myjobs');
}

// ── My Jobs (worker landing page) ───────────────────────────────────────────────
function wkMyJobsRoot() {
  let page = document.getElementById('page-myjobs');
  if (!page) {
    page = document.createElement('div');
    page.className = 'page';
    page.id = 'page-myjobs';
    page.innerHTML = '<div class="panel"><div id="myjobs-root"></div></div>';
    (document.querySelector('.content') || document.body).appendChild(page);
  }
  if (currentPage === 'myjobs') page.classList.add('active');
  return document.getElementById('myjobs-root');
}

function renderMyJobs() {
  const root = wkMyJobsRoot();
  const title = document.getElementById('page-title');
  if (title) title.textContent = 'My Jobs';
  if (!wkHasMyJobs()) {
    root.innerHTML = '<div style="padding:24px;color:var(--text3);font-size:13px;line-height:1.6;max-width:520px">This page shows the jobs sent to you. Owners get it once the platform admin links their login to their crew record (Users screen).</div>';
    return;
  }
  const worker = wkIsWorker();
  const p = wkParseLoginEmail(currentProfile.email);
  const who = worker
    ? (p ? `Signed in with cell number ${wkEsc(wkFmtCell(p.cell))}` : `Signed in as ${wkEsc(currentProfile.email)}`)
    : 'Jobs sent to you as a crew member';
  const jobs = window.asgMyJobsHtml ? asgMyJobsHtml() : '';
  root.innerHTML = `<div style="padding:24px;max-width:560px">
    <div style="font-family:var(--fm);font-size:10px;letter-spacing:2px;color:var(--accent);text-transform:uppercase;margin-bottom:6px">${worker ? 'Welcome' : 'My jobs'}</div>
    <div style="font-size:20px;font-weight:600;margin-bottom:4px">${wkEsc(currentProfile.name)}</div>
    <div style="font-size:12px;color:var(--text3);margin-bottom:6px">${who}</div>
    ${jobs}
    ${worker ? '<div style="margin-top:28px"><button class="topbar-btn secondary" onclick="signOutUser()">SIGN OUT</button></div>' : ''}
  </div>`;
}

// ── Add worker login (owners, from the Users screen) ────────────────────────────
// Crew ids are NUMBERS in the ERP store (nextCrewId() returns max+1), but a form field hands back
// text and the rules require crewId to be a string. So the link is always the id as text, and every
// comparison goes through this one function. A record with no id cannot be linked at all.
function wkCrewKey(c) {
  const k = c && c.id != null ? String(c.id).trim() : '';
  return k && k.length <= 40 ? k : null;
}

// Which crew members can be given a login right now, and which login number each gets.
function wkCrewChoices() {
  const logins = (typeof rlUsers !== 'undefined' ? rlUsers : []).filter(u => u.role === 'worker');
  const out = { ok: [], noPhone: [], noId: [], hasLogin: [], clash: [], full: [] };
  (store.crew || []).forEach(c => {
    const key = wkCrewKey(c);
    if (!key) { out.noId.push(c); return; }
    const cell = wkNormCell(c.phone);
    if (!cell) { out.noPhone.push(c); return; }
    if (logins.some(u => u.crewId === key && u.active === true)) { out.hasLogin.push(c); return; }
    // Two crew records sharing one number would make "which login is whose" ambiguous.
    if (logins.some(u => u.crewId !== key && u.active === true && (wkParseLoginEmail(u.email) || {}).cell === cell)) { out.clash.push(c); return; }
    let attempt = 1;
    logins.forEach(u => {
      const p = wkParseLoginEmail(u.email);
      if (p && p.cell === cell && p.attempt >= attempt) attempt = p.attempt + 1;
    });
    if (attempt > WK_MAX_LOGINS) { out.full.push(c); return; }
    out.ok.push({ crew: c, key, cell, attempt });
  });
  return out;
}

function showAddWorker() {
  if (!can('users')) { toast('Only owners can add workers'); return; }
  rlLoadUsers().then(list => {
    rlUsers = list;
    const ch = wkCrewChoices();
    const names = a => a.map(c => wkEsc(c.name)).join(', ');
    const notes = [
      ch.noPhone.length ? `No valid cell number on the Crew page (fix it there first): ${names(ch.noPhone)}.` : '',
      ch.noId.length ? `Have no crew ID, so they cannot be linked: ${names(ch.noId)}.` : '',
      ch.hasLogin.length ? `Already have an active login (deactivate it first to make a replacement): ${names(ch.hasLogin)}.` : '',
      ch.clash.length ? `Share a cell number with another worker's login: ${names(ch.clash)}.` : '',
      ch.full.length ? `Have used all ${WK_MAX_LOGINS} logins for their number. Ask the platform admin: ${names(ch.full)}.` : '',
    ].filter(Boolean).map(t => `<div style="margin-top:6px">${t}</div>`).join('');
    if (!ch.ok.length) {
      openModal('ADD WORKER LOGIN', `<div style="font-size:13px;line-height:1.6;color:var(--text2)">There is nobody to add right now.${notes}</div>
        <div class="form-actions"><button class="topbar-btn secondary" onclick="closeModalDirect()">CLOSE</button></div>`);
      return;
    }
    const options = ch.ok.map(x => `<option value="${wkEsc(x.key)}">${wkEsc(x.crew.name)} · ${wkEsc(wkFmtCell(x.cell))}${x.attempt > 1 ? ` · login ${x.attempt}` : ''}</option>`).join('');
    openModal('ADD WORKER LOGIN', `<div class="form-grid">
      <div class="form-group full"><label>Crew member (their cell number is their login)</label><select id="f-wk-crew">${options}</select></div>
      <div class="form-group full"><label>Starting password</label><input type="text" id="f-wk-pass" placeholder="At least 8 characters" autocomplete="off"></div>
      <div class="form-group full" style="font-size:11px;color:var(--text3);line-height:1.5">The worker signs in with their cell number and this password. Give it to them in person or by phone, not in a group chat. A worker only ever sees their own jobs and clock.${notes}</div>
    </div><div class="form-actions">
      <button class="topbar-btn" onclick="saveNewWorker()">ADD WORKER LOGIN</button>
      <button class="topbar-btn secondary" onclick="closeModalDirect()">CANCEL</button></div>`);
  }).catch(err => alert('Could not load the users (' + (err && err.code || err && err.message) + ').'));
}

async function saveNewWorker() {
  if (!can('users')) return;
  const v = id => (document.getElementById(id) || {}).value || '';
  const crewId = v('f-wk-crew'), pass = v('f-wk-pass');
  if (pass.length < 8) { alert('The starting password must be at least 8 characters'); return; }
  // Decided again from fresh data, never from what the form says, so a stale form cannot
  // create a second active login for someone.
  const pick = wkCrewChoices().ok.find(x => x.key === crewId);
  if (!pick) { alert('Choose a crew member from the list'); return; }

  let uid = null, email = null;
  if (wkLastCreated && wkLastCreated.crewId === crewId) {
    uid = wkLastCreated.uid; email = wkLastCreated.email;   // login already exists, only its profile is missing
  } else {
    for (let n = pick.attempt; n <= WK_MAX_LOGINS; n++) {
      email = wkLoginEmail(pick.cell, n);
      try { uid = await rlCreateAuthAccount(email, pass); break; }
      catch (err) {
        if (err && err.code === 'auth/email-already-in-use') continue;   // taken by an account with no profile: use the next number
        alert(RL_AUTH_ERRORS[err && err.code] || ('Could not create the login (' + (err && (err.code || err.message)) + ').'));
        return;
      }
    }
    if (!uid) { alert(`All ${WK_MAX_LOGINS} logins for this cell number are taken. Ask the platform admin to clear unused ones in the Firebase Console.`); return; }
  }
  try {
    await rlWriteProfile(uid, pick.crew.name, email, 'worker', pick.key);
    wkLastCreated = null;
    closeModalDirect();
    toast('Worker login added');
    renderUsers();
  } catch (err) {
    wkLastCreated = { crewId, email, uid };
    alert('Their login was created but the access record could not be saved (' + (err && (err.code || err.message)) + '). Press ADD WORKER LOGIN again to retry.');
  }
}
