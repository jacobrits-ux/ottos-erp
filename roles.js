// ══════════════════════════════════════════════════════
// USER ROLES & PERMISSIONS — step 1: Owner role, per-user profiles, Users screen.
// Own roles.js file (own <script> tag), loaded AFTER onboarding.js and BEFORE
// sync.js (sync.js calls ensureProfile()). core.js is near its size ceiling, so
// it only carries four tiny guarded hooks: navigate() permission guard,
// renderPage() 'users' route, handlePrimary() 'users' route (all via window.*).
//
// THE SECURITY BOUNDARY IS THE FIRESTORE RULES, NOT THIS FILE.
// Everything here that hides a menu item or blocks a page is a convenience for
// honest users. A signed-in person can call the Firestore API directly, so the
// published rules (firestore.rules) are what actually stop a Worker reading
// payroll. Never rely on a can() check alone to protect data.
//
// DATA — one document per login at users/{uid}:
//   { email, name, role, tenantId, platformAdmin, active, createdAt, createdBy, crewId? }
// - crewId: worker logins only; the id of their Crew record (worker.js).
// - role: 'owner' | 'supervisor' | 'worker'. Owner has every permission; worker only 'myjobs'
//   (worker.js). Supervisor is declared but not `ready`: it grants nothing (deny by default)
//   and cannot be assigned until its access is designed.
// - tenantId: 'ottos' today. Carried from day one so the multi-tenant data model
//   (matrix item 12) doesn't force a rewrite of every rule.
// - platformAdmin: the platform operator (Jaco). NOT a company role; it sits
//   above companies and only the rules can grant it.
// - active: false = access switched off without deleting the login.
//
// FIRST SIGN-IN (bootstrap): a signed-in user with no profile tries to create
// their own as Owner. The TRANSITIONAL rules allow that only for the two
// allowlisted founder emails; the FINAL rules allow it for nobody, so after the
// migration an unknown login lands on the "No access" screen.
// ══════════════════════════════════════════════════════

// Used ONLY to decide what to ask for at bootstrap; the rules independently
// refuse platformAdmin:true for any other email, so editing this client-side
// constant grants nothing.
const PLATFORM_ADMIN_EMAIL = 'jaco.brits@hotmail.com';
const DEFAULT_TENANT = 'ottos';

// Adding a role later = a new entry here (+ matching rules). `perms` are page
// keys (the same strings navigate() uses) plus: users, backup, restore,
// syncsetup, aisetup.
const ROLES = {
  owner:      { label: 'Owner',      perms: '*', ready: true },
  supervisor: { label: 'Supervisor', perms: [],  ready: false },
  // A worker sees only their own jobs and clock. viaUsers:false = never offered in the Add user / role
  // dropdowns: a worker login needs a crew link and a cell-number login, so it is made in worker.js.
  worker:     { label: 'Worker',     perms: ['myjobs'], ready: true, viaUsers: false },
};

// Sidebar entries that call a function rather than navigate('page').
const NAV_FUNC_PERMS = { backupData: 'backup', restoreData: 'restore', showFirebaseSetup: 'syncsetup', showAISetup: 'aisetup' };
const BNAV_PAGES = ['dashboard', 'projects', 'invoices', 'crew'];

let currentProfile = null;
// False until sign-in is required on this device. While false (Firebase Auth
// not switched on), there are no roles to apply and the app behaves as it
// always has; once true, anything without an active profile is denied.
let rolesEnforced = false;
let rlLastCreated = null; // {email, uid}: auth account made but its profile write failed, so a retry reuses it

function rlEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// A value inside an inline onclick="…": JSON-quote it as a JS string, THEN HTML-escape
// (the browser decodes entities before running the JS, so escaping alone is unsafe).
function rlJs(v) { return rlEsc(JSON.stringify(String(v == null ? '' : v))); }

function can(perm) {
  if (!rolesEnforced) return true;
  const p = currentProfile;
  if (!p || p.active !== true) return false;
  const r = ROLES[p.role];
  if (!r) return false;
  return r.perms === '*' || r.perms.indexOf(perm) !== -1;
}
function canView(page) { return can(page); }

// Compat SDK: DocumentSnapshot.exists is a boolean PROPERTY; the modular SDK makes it a method.
// (Calling it as a method unconditionally is the bug that once stopped all shared-data sync.)
function rlSnapExists(snap) { return typeof snap.exists === 'function' ? snap.exists() : snap.exists; }

// ── Sign-in gate ────────────────────────────────────────────────────────────────
// onReady runs only for a user with an ACTIVE profile and a known role.
function ensureProfile(user, onReady) {
  rolesEnforced = true;
  currentProfile = null;
  hideNoAccess();
  const ref = db.collection('users').doc(user.uid);
  ref.get()
    .then(snap => rlSnapExists(snap) ? snap.data() : rlBootstrapProfile(ref, user))
    .then(profile => {
      if (!profile) { showNoAccess(user, 'Your login has not been given access yet. Ask an owner to add you.'); return; }
      if (profile.active !== true) { showNoAccess(user, 'Your access has been switched off. Ask an owner if this is a mistake.'); return; }
      if (!ROLES[profile.role]) { showNoAccess(user, 'Your account has a role this version does not recognise.'); return; }
      currentProfile = profile;
      applyRoleToUi();
      rlUpdateStatusLine(user);
      onReady();
    })
    .catch(err => showNoAccess(user, 'Could not check your access (' + (err && err.code || err && err.message || 'unknown error') + '). Check your connection and try again.'));
}

function rlBootstrapProfile(ref, user) {
  const email = String(user.email || '').toLowerCase();
  const profile = {
    email,
    name: user.displayName || email.split('@')[0],
    role: 'owner',
    tenantId: DEFAULT_TENANT,
    platformAdmin: email === PLATFORM_ADMIN_EMAIL,
    active: true,
    createdAt: new Date().toISOString(),
    createdBy: 'bootstrap',
  };
  return ref.set(profile).then(() => profile).catch(err => {
    if (err && err.code === 'permission-denied') return null; // rules refused: no profile, no access
    throw err;
  });
}

function clearProfile() {
  currentProfile = null;
  hideNoAccess();
}

function rlUpdateStatusLine(user) {
  const el = document.getElementById('auth-status-line');
  if (el && currentProfile) el.textContent = `Signed in as ${user.email} · ${ROLES[currentProfile.role].label}${currentProfile.platformAdmin ? ' · Platform admin' : ''}`;
}

function showNoAccess(user, msg) {
  currentProfile = null;
  let el = document.getElementById('noaccess-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'noaccess-overlay';
    el.style.cssText = 'position:fixed;inset:0;z-index:100000;background:var(--bg,#0d0c0a);display:flex;align-items:center;justify-content:center;padding:24px;';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div style="max-width:380px;text-align:center;font-family:var(--fb);color:var(--text,#eee)">
    <div style="font-family:var(--fm);letter-spacing:3px;font-size:12px;color:var(--red,#e05252);margin-bottom:10px">NO ACCESS</div>
    <div style="font-size:14px;line-height:1.6;margin-bottom:14px">${rlEsc(msg)}</div>
    <div style="font-family:var(--fm);font-size:11px;color:var(--text3,#888);margin-bottom:6px">Signed in as ${rlEsc(user && user.email)}</div>
    <div style="font-family:var(--fm);font-size:10px;color:var(--text3,#888);margin-bottom:18px;word-break:break-all">Login ID: ${rlEsc(user && user.uid)}<br>(give this to whoever manages access)</div>
    <button class="topbar-btn" onclick="rlForceSignOut()">SIGN OUT</button></div>`;
  el.style.display = 'flex';
}
function hideNoAccess() {
  const el = document.getElementById('noaccess-overlay');
  if (el) el.style.display = 'none';
}
function rlForceSignOut() { firebase.auth().signOut(); }

// ── Applying the role to the UI (convenience only — see header) ────────────────
function rlNavPerm(onclick) {
  let m = onclick.match(/navigate\('([a-z]+)'\)/);
  if (m) return m[1];
  for (const fn in NAV_FUNC_PERMS) if (onclick.indexOf(fn + '(') !== -1) return NAV_FUNC_PERMS[fn];
  return null;
}
function applyRoleToUi() {
  document.querySelectorAll('.nav-item').forEach(el => {
    if (el.id === 'nav-users') return;
    const perm = rlNavPerm(el.getAttribute('onclick') || '');
    if (perm) el.style.display = can(perm) ? '' : 'none';
  });
  document.querySelectorAll('.bnav-item').forEach(el => {
    const m = (el.id || '').match(/^bnav-(.+)$/);
    if (m && BNAV_PAGES.indexOf(m[1]) !== -1) el.style.display = can(m[1]) ? '' : 'none';
  });
  rlEnsureUsersNav();
  if (window.wkApplyRole) wkApplyRole();   // worker.js: My Jobs entry, hides what a worker cannot use
}
function rlEnsureUsersNav() {
  let el = document.getElementById('nav-users');
  if (!can('users')) { if (el) el.remove(); return; }
  if (el) return;
  const crew = [...document.querySelectorAll('.nav-item')].find(n => (n.getAttribute('onclick') || '').indexOf("navigate('crew')") !== -1);
  if (!crew) return;
  el = document.createElement('div');
  el.className = 'nav-item';
  el.id = 'nav-users';
  el.setAttribute('onclick', "navigate('users')");
  el.innerHTML = '<span class="nav-icon">👤</span>Users';
  crew.insertAdjacentElement('afterend', el);
}

// ── Users screen ────────────────────────────────────────────────────────────────
let rlUsers = [];

function rlUsersRoot() {
  let page = document.getElementById('page-users');
  if (!page) {
    page = document.createElement('div');
    page.className = 'page';
    page.id = 'page-users';
    page.innerHTML = '<div class="panel"><div id="users-root"></div></div>';
    (document.querySelector('.content') || document.body).appendChild(page);
    if (document.getElementById('page-title') && currentPage === 'users') page.classList.add('active');
  }
  return document.getElementById('users-root');
}

function renderUsers() {
  const root = rlUsersRoot();
  const btn = document.getElementById('topbar-primary');
  if (btn) btn.textContent = '+ ADD USER';
  const page = document.getElementById('page-users');
  if (page && currentPage === 'users') page.classList.add('active');
  if (!can('users')) { root.innerHTML = '<div style="padding:24px;color:var(--text3);font-family:var(--fm);font-size:11px">Only owners can manage users.</div>'; return; }
  root.innerHTML = '<div style="padding:24px;color:var(--text3);font-family:var(--fm);font-size:11px">Loading users…</div>';
  rlLoadUsers().then(list => { rlUsers = list; root.innerHTML = rlUsersHtml(list); })
    .catch(err => { root.innerHTML = `<div style="padding:24px;color:var(--red);font-size:12px">Could not load users (${rlEsc(err && err.code || err && err.message)}).</div>`; });
}

function rlLoadUsers() {
  return db.collection('users').where('tenantId', '==', currentProfile.tenantId).get().then(qs => {
    const out = [];
    qs.forEach(d => out.push(Object.assign({ uid: d.id }, d.data())));
    out.sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
    return out;
  });
}

function rlReadyRoleOptions(selected) {
  return Object.keys(ROLES).filter(k => (ROLES[k].ready && ROLES[k].viaUsers !== false) || k === selected)
    .map(k => `<option value="${k}" ${k === selected ? 'selected' : ''} ${ROLES[k].ready ? '' : 'disabled'}>${rlEsc(ROLES[k].label)}</option>`).join('');
}

// Workers are shown by cell number, not by their made-up login address (worker.js).
function rlShownId(u) { return (window.wkDisplayId ? wkDisplayId(u) : u.email) + (window.asgLinkSuffix ? asgLinkSuffix(u) : ''); }

function rlUsersHtml(list) {
  if (!list.length) return '<div style="padding:24px;color:var(--text3)">No users yet.</div>';
  const me = auth_uid();
  const parts = list.map(u => {
    const isMe = currentProfile && u.uid === me;
    const locked = isMe || u.platformAdmin === true;   // mirrors the rules: no self-edits, platform admin untouchable by owners
    return {
      u,
      name: rlEsc(u.name),
      email: rlEsc(rlShownId(u)),
      tags: (isMe ? ' <span class="badge badge-blue">You</span>' : '') + (u.platformAdmin ? ' <span class="badge badge-yellow">Platform admin</span>' : ''),
      role: locked || u.role === 'worker'
        ? rlEsc((ROLES[u.role] || {}).label || u.role)
        : `<select onchange="changeUserRole(${rlJs(u.uid)}, this.value)">${rlReadyRoleOptions(u.role)}</select>`,
      status: u.active === true ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-gray">Inactive</span>',
      actions:
        (rlCanRename(u) ? `<button class="action-btn" onclick="renameUser(${rlJs(u.uid)})">Rename</button> ` : '') +
        (locked ? '' : `<button class="action-btn ${u.active === true ? 'danger' : ''}" onclick="setUserActive(${rlJs(u.uid)}, ${u.active === true ? 'false' : 'true'})">${u.active === true ? 'Deactivate' : 'Activate'}</button> `) +
        (u.role === 'worker' ? '' : `<button class="action-btn" onclick="resetUserPassword(${rlJs(u.email)})">Reset password</button>`) +
        (window.asgLinkButton ? ' ' + asgLinkButton(u) : ''),
    };
  });
  // The app hides .table-scroll and shows .card-list below 768px (phones), so BOTH must be rendered —
  // a table alone is invisible on a phone. Same pattern as the Crew and Clients pages.
  const rows = parts.map(p => `<tr><td>${p.name}${p.tags}<br><span class="mono" style="color:var(--text3);font-size:10px">${p.email}</span></td><td>${p.role}</td><td>${p.status}</td><td>${p.actions}</td></tr>`).join('');
  const cards = parts.map(p => `<div class="card-item">
      <div class="card-item-header">
        <div><div class="card-item-title">${p.name}${p.tags}</div><div class="card-item-id">${p.email}</div></div>
        ${p.status}
      </div>
      <div class="card-item-row"><span style="color:var(--text3)">Role</span><span>${p.role}</span></div>
      <div class="card-item-actions">${p.actions}</div>
    </div>`).join('');
  const addWorkerBar = window.showAddWorker
    ? '<div style="padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="action-btn" onclick="showAddWorker()">+ ADD WORKER LOGIN</button><span style="font-size:11px;color:var(--text3)">Workers sign in with their cell number.</span></div>'
    : '';
  return `${addWorkerBar}<div class="table-scroll"><table class="data-table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="card-list" style="padding:10px 10px 0">${cards}</div>
    <div style="padding:10px 14px;font-size:11px;color:var(--text3);line-height:1.6">Owners have full access, including payroll and banking details. The Supervisor role is not available yet. A forgotten worker password means an owner adds a replacement login.</div>`;
}
function auth_uid() { const u = firebase.auth().currentUser; return u ? u.uid : null; }

function rlFind(uid) { return rlUsers.find(u => u.uid === uid); }

function changeUserRole(uid, role) {
  const u = rlFind(uid);
  if (!can('users') || !u || !ROLES[role] || !ROLES[role].ready || ROLES[role].viaUsers === false || u.role === 'worker' || u.role === role) { renderUsers(); return; }
  if (!confirm(`Change ${u.name || u.email} to ${ROLES[role].label}?`)) { renderUsers(); return; }
  db.collection('users').doc(uid).update({ role })
    .then(() => { toast('Role updated'); renderUsers(); })
    .catch(err => { alert('Could not change the role (' + (err.code || err.message) + ').'); renderUsers(); });
}

// Mirrors the Firestore rules: an owner may rename OTHER users (never the platform admin); the platform admin
// may rename anyone, including themselves. Everyone else cannot edit their own profile.
function rlCanRename(u) {
  if (!can('users') || !currentProfile) return false;
  return currentProfile.platformAdmin === true || (u.uid !== auth_uid() && u.platformAdmin !== true);
}

function renameUser(uid) {
  const u = rlFind(uid);
  if (!u || !rlCanRename(u)) return;
  const next = String(prompt('Name for ' + u.email, u.name || '') || '').trim();
  if (!next || next === u.name) return;
  if (next.length > 60) { alert('Keep the name under 60 characters'); return; }
  db.collection('users').doc(uid).update({ name: next })
    .then(() => { toast('Name updated'); renderUsers(); })
    .catch(err => alert('Could not rename (' + (err.code || err.message) + ').'));
}

function setUserActive(uid, active) {
  const u = rlFind(uid);
  if (!can('users') || !u || uid === auth_uid() || u.platformAdmin === true) return;
  if (!confirm(`${active ? 'Activate' : 'Deactivate'} ${u.name || u.email}?${active ? '' : ' They will be locked out straight away.'}`)) return;
  db.collection('users').doc(uid).update({ active: !!active })
    .then(() => { toast(active ? 'User activated' : 'User deactivated'); renderUsers(); })
    .catch(err => alert('Could not update the user (' + (err.code || err.message) + ').'));
}

function resetUserPassword(email) {
  if (!can('users') || !email) return;
  if (!confirm('Send a password reset email to ' + email + '?')) return;
  firebase.auth().sendPasswordResetEmail(email)
    .then(() => toast('Reset email sent to ' + email))
    .catch(err => alert('Could not send the reset email (' + (err.code || err.message) + ').'));
}

// ── Add user ────────────────────────────────────────────────────────────────────
function showAddUser() {
  if (!can('users')) { toast('Only owners can add users'); return; }
  openModal('ADD USER', `<div class="form-grid">
    <div class="form-group full"><label>Name</label><input type="text" id="f-usr-name" placeholder="Full name"></div>
    <div class="form-group full"><label>Email (their login)</label><input type="email" id="f-usr-email" placeholder="name@example.com"></div>
    <div class="form-group"><label>Role</label><select id="f-usr-role">${rlReadyRoleOptions('owner')}</select></div>
    <div class="form-group"><label>Starting password</label><input type="text" id="f-usr-pass" placeholder="At least 8 characters"></div>
    <div class="form-group full" style="font-size:11px;color:var(--text3);line-height:1.5">Owners have full access, including payroll and banking details. Give them the password in person or by phone and use Reset password so they choose their own.</div>
  </div><div class="form-actions">
    <button class="topbar-btn" onclick="saveNewUser()">ADD USER</button>
    <button class="topbar-btn secondary" onclick="closeModalDirect()">CANCEL</button></div>`);
}

const RL_AUTH_ERRORS = {
  'auth/email-already-in-use': 'That email already has a sign-in. Use a different email, or ask the platform admin to give that existing login access.',
  'auth/invalid-email': 'That email address is not valid.',
  'auth/weak-password': 'Choose a stronger password (at least 8 characters).',
  'auth/network-request-failed': 'No connection. Try again when you are online.',
  'auth/operation-not-allowed': 'Creating accounts is switched off in Firebase (Authentication → Sign-in method). It is safe to turn on: a new login sees nothing until an owner gives it a role.',
  'auth/admin-restricted-operation': 'Creating accounts is switched off in Firebase (Authentication → Settings → User actions → Enable create). It is safe to turn on: a new login sees nothing until an owner gives it a role.',
};

// createUserWithEmailAndPassword signs the NEW user in on whichever app instance
// calls it, which would log the owner out. A throwaway second app instance takes
// the hit instead and is discarded.
function rlCreateAuthAccount(email, password) {
  const cfg = JSON.parse(localStorage.getItem('ottos_firebase_config') || 'null');
  const app = firebase.initializeApp(cfg, 'user-creator-' + Date.now());
  const done = (fn) => app.delete().then(fn, fn);
  return app.auth().createUserWithEmailAndPassword(email, password)
    .then(cred => { const uid = cred.user.uid; return app.auth().signOut().then(() => uid); })
    .then(uid => done(() => uid),
          err => done(() => { throw err; }));
}

// crewId links a worker login to their Crew record; only worker profiles carry one in this build.
function rlWriteProfile(uid, name, email, role, crewId) {
  const profile = {
    email, name, role,
    tenantId: currentProfile.tenantId,
    platformAdmin: false,
    active: true,
    createdAt: new Date().toISOString(),
    createdBy: currentProfile.email,
  };
  if (crewId) profile.crewId = crewId;
  return db.collection('users').doc(uid).set(profile);
}

function saveNewUser() {
  if (!can('users')) return;
  const v = id => (document.getElementById(id) || {}).value || '';
  const name = v('f-usr-name').trim(), email = v('f-usr-email').trim().toLowerCase(), role = v('f-usr-role'), pass = v('f-usr-pass');
  if (!name) { alert('Enter the person\'s name'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { alert('Enter a valid email address'); return; }
  if (!ROLES[role] || !ROLES[role].ready || ROLES[role].viaUsers === false) { alert('Choose a role'); return; }
  if (pass.length < 8) { alert('The starting password must be at least 8 characters'); return; }

  const finish = uid => rlWriteProfile(uid, name, email, role).then(() => {
    rlLastCreated = null;
    closeModalDirect(); toast('User added'); renderUsers();
  }).catch(err => {
    rlLastCreated = { email, uid };
    alert('Their login was created but the access record could not be saved (' + (err.code || err.message) + '). Press ADD USER again to retry.');
  });

  // Retry after a failed profile write: the login already exists, so reuse its uid.
  if (rlLastCreated && rlLastCreated.email === email) { finish(rlLastCreated.uid); return; }
  rlCreateAuthAccount(email, pass).then(finish)
    .catch(err => alert(RL_AUTH_ERRORS[err.code] || ('Could not create the login (' + (err.code || err.message) + ').')));
}
