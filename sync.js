// ══════════════════════════════════════════════════════
// FIREBASE SYNC + AUTH — Firestore listener setup and the opt-in
// sign-in gate. Split into its own sync.js file, loaded LAST (after
// core.js, ai-features.js, payroll.js, contracts.js) rather than left
// inline in core.js, for two reasons:
//   1. core.js was pushing past the 300KB mobile-parse ceiling once the
//      Firebase Auth UI/logic was added on top of Payroll/Contracts —
//      this is the single largest relocatable chunk of core.js's original
//      content, so moving it (not just new code) actually reduces core.js
//      back under the ceiling.
//   2. setupFirestoreListeners() below now wires up payrollRuns and
//      employeeContracts listeners too, which reference payrollRuns,
//      employeeContracts, renderPayrollPage, renderContractsPage etc. —
//      all declared in payroll.js/contracts.js. Loading this file LAST
//      guarantees every one of those globals already exists by the time
//      initFirebase() actually runs (triggered from the very bottom of
//      this file, not from core.js's own bootstrap — see the comment
//      there), so the typeof-guards used for cross-file safety elsewhere
//      in this codebase aren't even needed for the calls made directly
//      from here, only inside the async onSnapshot callbacks that could
//      in principle fire before this file finishes (they can't in
//      practice, but the guards there cost nothing and stay as written).
// ══════════════════════════════════════════════════════

function initFirebase() {
  const cfg = JSON.parse(localStorage.getItem('ottos_firebase_config') || 'null');
  if (!cfg || !cfg.apiKey) { updateSyncIndicator('not-configured'); return; }
  try {
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    db = firebase.firestore();
    db.enablePersistence({ synchronizeTabs: true }).catch(e => {
      syncDiag.persistence = e.code || String(e);
      if (e.code === 'failed-precondition') console.warn('Multi-tab: persistence limited');
    });

    // Auth is opt-in (cfg.authEnabled, default falsy) and deliberately NOT
    // tied to Firebase being configured at all — flipping it on requires an
    // explicit step in Sync Setup, taken only after accounts already exist
    // in Firebase Console. Defaulting this to "on" the moment Auth code
    // shipped would have locked out every device already using sync today,
    // since no Firebase Auth users would yet exist to sign in as.
    if (cfg.authEnabled && typeof firebase.auth === 'function') {
      showLoginOverlay();
      firebase.auth().onAuthStateChanged(user => {
        currentAuthUser = user;
        if (user) {
          // A login alone is not access: it needs an active profile (roles.js). Listeners
          // start only once that is confirmed, so a stranger's login never subscribes to data.
          ensureProfile(user, () => {
            hideLoginOverlay();
            updateAuthStatusLine(user);
            rlUpdateStatusLine(user);
            // A worker login can read only its own profile: the owner listeners would be refused by the
            // rules (and show OFFLINE), so they never start for a worker.
            // Workers listen only to their own assignments (assignments.js); owners get the store listeners
            // plus the live assignments list.
            if (currentProfile && currentProfile.role === 'worker') {
              if (window.asgStartWorkerSync) asgStartWorkerSync(); else updateSyncIndicator('not-configured');
            } else {
              setupFirestoreListeners();
              if (window.asgStartOwnerSync) asgStartOwnerSync();
            }
          });
        } else {
          clearProfile();
          if (window.asgStopSync) asgStopSync();
          showLoginOverlay();
          updateAuthStatusLine(null);
        }
      });
    } else {
      setupFirestoreListeners();
    }
  } catch(err) { console.warn('Firebase init error:', err); updateSyncIndicator('offline'); }
}

// Guards against double-registration — onAuthStateChanged only fires on
// real sign-in/sign-out transitions (not token refreshes, that's
// onIdTokenChanged), so this shouldn't normally re-fire while already
// signed in, but the guard costs nothing and keeps a future change safe.
// ── Sync diagnostics ─────────────────────────────────────────────────────────
// The OFFLINE badge says nothing about WHY. This records what the listeners last reported and
// powers the TEST SYNC button in Sync Setup, which probes each layer separately — browser
// online flag, sign-in token refresh, a server read through the SDK, and raw REST reachability —
// each with its own timeout so one hung layer cannot hide the others. Read-only: it never
// writes to Firestore.
const syncDiag = { store: null, errors: {}, persistence: null };

function syncDiagError(where, err) {
  syncDiag.errors[where] = {
    code: (err && err.code) || 'unknown',
    message: String((err && err.message) || err).slice(0, 160),
    at: Date.now(),
  };
}

function syncWithTimeout(promise, ms) {
  let timer;
  const clock = new Promise((_, rej) => {
    timer = setTimeout(() => rej({ code: 'timeout', message: 'no answer after ' + (ms / 1000) + 's' }), ms);
  });
  return Promise.race([promise, clock]).then(
    v => { clearTimeout(timer); return v; },
    e => { clearTimeout(timer); throw e; });
}

function syncEsc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Each row: {label, ok, detail}. ok is true / false / null (null = informational).
async function syncProbe(timeoutMs) {
  const ms = timeoutMs || 12000;
  const rows = [];
  const add = (label, ok, detail) => rows.push({ label, ok, detail });
  const cfg = JSON.parse(localStorage.getItem('ottos_firebase_config') || 'null') || {};
  const fail = e => (e && e.code ? e.code + (e.message && e.code === 'timeout' ? ' (' + e.message + ')' : '') : String((e && e.message) || e));

  add('Browser says online', navigator.onLine ? true : false, navigator.onLine ? 'yes' : 'NO — the phone reports no connection');
  add('Phone date/time', null, new Date().toString());
  add('Sync configured', !!(cfg.apiKey && cfg.projectId), cfg.projectId ? 'project ' + cfg.projectId : 'no project saved');

  let user = null;
  try { user = (typeof firebase !== 'undefined' && firebase.auth && firebase.apps.length) ? firebase.auth().currentUser : null; } catch (e) { user = null; }
  if (cfg.authEnabled) {
    add('Signed in', !!user, user ? user.email : 'NOT signed in');
    if (user) {
      try { await syncWithTimeout(user.getIdToken(true), ms); add('Sign-in token refresh', true, 'ok'); }
      catch (e) { add('Sign-in token refresh', false, fail(e)); }
    }
  }

  if (typeof db !== 'undefined' && db) {
    try {
      const snap = await syncWithTimeout(db.collection('erp').doc('store').get({ source: 'server' }), ms);
      const exists = typeof snap.exists === 'function' ? snap.exists() : snap.exists;
      add('Server read via the app connection', true, exists ? 'ok — shared data found' : 'ok — no shared data yet');
    } catch (e) { add('Server read via the app connection', false, fail(e)); }
  } else {
    add('Server read via the app connection', false, 'sync is not running (no database object)');
  }

  if (cfg.projectId) {
    try {
      const r = await syncWithTimeout(fetch('https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(cfg.projectId) + '/databases/(default)/documents/clientForms/sync-probe'), ms);
      add('Firebase reachable (plain web request)', r.status === 404 || r.status === 403 || r.status === 200, 'HTTP ' + r.status + (r.status === 403 ? ' (reachable; the rules refuse anonymous reads)' : r.status === 404 ? ' (reachable)' : ''));
    } catch (e) { add('Firebase reachable (plain web request)', false, fail(e)); }
  }

  const s = syncDiag.store;
  add('Last shared-data message', null, s ? (s.fromCache ? 'from the phone\'s own copy only' : 'from the server') + ', ' + Math.round((Date.now() - s.at) / 1000) + 's ago' : 'none received since the app opened');
  const errs = Object.keys(syncDiag.errors);
  add('Errors the live connections reported', errs.length ? false : null, errs.length ? errs.map(k => k + ': ' + syncDiag.errors[k].code).join(', ') : 'none');
  if (syncDiag.persistence) add('Local copy storage', false, syncDiag.persistence);
  return rows;
}

// One plain-English conclusion from the rows, most specific cause first.
function syncVerdict(rows) {
  const by = l => rows.find(r => r.label === l);
  const rest = by('Firebase reachable (plain web request)'), srv = by('Server read via the app connection'), tok = by('Sign-in token refresh');
  const signed = by('Signed in'), online = by('Browser says online');
  if (online && online.ok === false) return 'The phone reports it is offline. Check Wi-Fi and mobile data first.';
  if (by('Sync configured') && by('Sync configured').ok === false) return 'Sync is not set up on this device. Open Sync Setup and activate it.';
  if (signed && signed.ok === false) return 'The app is not signed in. Sign in again from Sync Setup.';
  if (tok && tok.ok === false) return 'The sign-in token cannot be refreshed (' + tok.detail + '). Sign out and sign in again; if that fails, check the phone\'s date and time are automatic.';
  if (srv && srv.ok === false && /permission-denied/.test(srv.detail)) return 'Firebase refused the read: the published security rules do not let this login in.';
  if (srv && srv.ok === false && /unauthenticated/.test(srv.detail)) return 'Firebase did not accept the sign-in. Sign out and in again.';
  if (srv && srv.ok === false && rest && rest.ok) return 'Firebase is reachable with a plain web request, but the app\'s live connection fails (' + srv.detail + '). Something on this phone or network is blocking the streaming connection (browser data saver, ad or DNS filter, VPN) or the browser\'s stored copy is damaged.';
  if (srv && srv.ok === false && rest && rest.ok === false) return 'Firebase cannot be reached at all (' + rest.detail + '). Network problem, or a filter is blocking Google services.';
  if (srv && srv.ok === false) return 'The server read failed (' + srv.detail + ').';
  return 'Everything checks out right now. Close all ERP tabs, reopen the app in one tab, and watch the badge.';
}

async function runSyncTest() {
  openModal('SYNC TEST', '<div style="padding:8px 0;color:var(--text3);font-size:12px">Testing each layer… this can take up to a minute.</div>');
  let rows;
  try { rows = await syncProbe(); }
  catch (e) { openModal('SYNC TEST', '<div style="color:var(--red);font-size:12px">The test itself failed: ' + syncEsc((e && e.message) || e) + '</div>'); return; }
  const mark = r => r.ok === true ? '<span style="color:var(--green)">✓</span>' : r.ok === false ? '<span style="color:var(--red)">✗</span>' : '<span style="color:var(--text3)">•</span>';
  openModal('SYNC TEST', '<div style="font-size:12px;line-height:1.7">' +
    rows.map(r => mark(r) + ' <b>' + syncEsc(r.label) + '</b><br><span style="color:var(--text3);margin-left:16px;display:inline-block">' + syncEsc(r.detail) + '</span>').join('<br>') +
    '</div><div style="margin-top:12px;padding:10px;border:1px solid var(--border);font-size:12px;line-height:1.6"><b>Conclusion:</b> ' + syncEsc(syncVerdict(rows)) + '</div>' +
    '<div class="form-actions"><button class="topbar-btn" onclick="runSyncTest()">RUN AGAIN</button><button class="topbar-btn secondary" onclick="closeModalDirect()">CLOSE</button></div>');
}

let firestoreListenersInitialized = false;

// Opens the push gate on the first SERVER-confirmed snapshot of erp/store (never a cache-only one,
// which can be stale or empty). Until then saveStore() still writes locally but does not push.
let lastMergedRemoteSig = null;   // last remote version merged into this device (see the store listener)
let storeEditsReplaced = false;  // edits saved while gated were overwritten by a remote merge

// True when this device (the last writer) holds edits the server never received. Guarded: if the local copy
// has FEWER records than the server's it might be a reset or corrupted local store, and pushing it would
// wipe real shared data — so that case waits for an explicit save instead of pushing automatically.
function storeHasUnpushedEdits(remote) {
  const j = v => JSON.stringify(v == null ? null : v);
  const count = o => COLLECTIONS.reduce((n, k) => n + (Array.isArray(o[k]) ? o[k].length : 0), 0);
  const differs = COLLECTIONS.some(k => j(store[k] || []) !== j(remote[k] || [])) || j(store.payrollSettings) !== j(remote.payrollSettings);
  return differs && count(store) >= count(remote);
}

function openStorePullGate() {
  if (storePullDone) return;
  storePullDone = true;
  if (storeEditsReplaced) {
    storeEditsReplaced = false;
    // Last-writer-wins: the other device's newer copy replaced what was saved while the gate was closed.
    // Say so instead of letting it vanish silently.
    toast('⚠ Sync: edits made before first sync were replaced by newer data from the other device');
  }
  // Whatever is still blocked was saved AFTER the last merge (or none happened), so it is the newest copy.
  if (storePushBlocked) { storePushBlocked = false; saveStore(store); }
}

function setupFirestoreListeners() {
  if (firestoreListenersInitialized) return;
  firestoreListenersInitialized = true;

    // ── Main store listener ──
    // includeMetadataChanges is REQUIRED for the badge and the push gate. With the default, when the
    // phone's cached copy already equals the server's, the listener fires ONCE (fromCache: true) and the
    // later "server confirmed" step is a metadata-only change that is never delivered: the badge stuck
    // on OFFLINE and the gate (which opens only on a server-confirmed snapshot) never opened, so nothing
    // this phone saved was pushed. (Firestore SDK: QueryListener.shouldRaiseEvent.)
    db.collection('erp').doc('store').onSnapshot({ includeMetadataChanges: true }, doc => {
      // `exists` is a boolean PROPERTY in the compat SDK that index.html loads (a method only in
      // the modular SDK). Calling it as a method threw a TypeError on every existing document, so
      // no device ever pulled the shared store — only the device that wrote it had any data.
      const docExists = typeof doc.exists === 'function' ? doc.exists() : doc.exists;
      const meta = doc.metadata;
      if (!docExists) {
        // A cache-only "missing" doesn't prove the server has nothing (offline first run);
        // creating the document from here could overwrite real data on reconnect.
        if (meta.fromCache) return;
        db.collection('erp').doc('store').set({ ...store, _ts: Date.now(), _dev: DEVICE_ID }).catch(() => {});
        openStorePullGate();
        return;
      }
      const remote = doc.data();
      syncDiag.store = { at: Date.now(), fromCache: meta.fromCache, pending: meta.hasPendingWrites };
      if (meta.hasPendingWrites) return;
      // includeMetadataChanges re-delivers the SAME remote data when the server confirms a cache-only
      // snapshot; merge (and toast) each distinct remote version once.
      const remoteSig = String(remote._ts) + ':' + remote._dev;
      if (remote._dev && remote._dev !== DEVICE_ID && remoteSig !== lastMergedRemoteSig) {
        lastMergedRemoteSig = remoteSig;
        // Anything saved while the push gate was closed is about to be overwritten by this merge.
        if (storePushBlocked) { storePushBlocked = false; storeEditsReplaced = true; }
        COLLECTIONS.forEach(k => { if (Array.isArray(remote[k])) store[k] = remote[k]; });
        // payrollSettings is a bounded object, not an array — COLLECTIONS'
        // Array.isArray guard above intentionally skips it, so merge it here.
        if (remote.payrollSettings && typeof remote.payrollSettings === 'object') store.payrollSettings = remote.payrollSettings;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch(e) {}
        renderPage(currentPage);
        updateSyncBadges();
        toast('⟳ Live update from other device');
      }
      if (!meta.fromCache) {
        // Our own device wrote last, so a local copy that differs from the server's holds edits that were
        // never pushed (e.g. saved while the gate was closed in an earlier session): push them.
        if (!storePullDone && remote._dev === DEVICE_ID && storeHasUnpushedEdits(remote)) storePushBlocked = true;
        openStorePullGate();
      }
      updateSyncIndicator(meta.fromCache ? 'offline' : 'synced');
    }, err => { console.warn('Firestore listener:', err); syncDiagError('erp/store', err); updateSyncIndicator('offline'); });

    // ── Client intake form submissions listener ──
    db.collection('clientForms').onSnapshot(snapshot => {
      snapshot.docChanges().forEach(change => {
        const data = { id: change.doc.id, ...change.doc.data() };
        if (data.status === 'submitted' && !data._imported && !processedFormIds.has(data.id)) {
          processedFormIds.add(data.id);
          // Remove existing record for same client if any, then prepend
          pendingFormSubmissions = pendingFormSubmissions.filter(f => f.id !== data.id);
          pendingFormSubmissions.unshift(data);
          toast('📋 Form submitted by ' + (data.clientName || data.declName || 'client'));
          updateFormBadge();
          if (currentPage === 'clients') renderClients();
        }
      });
    }, err => { console.warn('ClientForms listener:', err); syncDiagError('clientForms', err); });

    // ── Client portal — quote approve/decline actions from clients ──
    db.collection('clientPortal').onSnapshot(snapshot => {
      snapshot.docChanges().forEach(change => {
        if (change.type === 'removed') return;
        const d = change.doc.data();
        if (!d.actions) return;
        try { applyPortalActions(change.doc.id, JSON.parse(d.actions)); } catch(e) { console.warn('Portal action parse error:', e); }
      });
    }, err => { console.warn('ClientPortal listener:', err); syncDiagError('clientPortal', err); });

    // ── Job Cards — own collection, not nested in erp/store (avoids 1MB single-doc ceiling) ──
    db.collection('jobCards').onSnapshot(snapshot => {
      let changed = false;
      snapshot.docChanges().forEach(change => {
        if (change.doc.metadata.hasPendingWrites) return; // skip our own optimistic write
        const data = change.doc.data();
        const idx = jobCards.findIndex(j => j.id === data.id);
        if (change.type === 'removed') { if (idx !== -1) { jobCards.splice(idx,1); changed = true; } }
        else { if (idx !== -1) jobCards[idx] = data; else jobCards.unshift(data); changed = true; }
      });
      if (changed) {
        saveJobCardsLocal();
        if (currentPage === 'jobcards') renderJobCards();
        updateJobCardBadge();
      }
    }, err => { console.warn('JobCards listener:', err); syncDiagError('jobCards', err); });

    // ── Variation Orders — own collection, remote portal approvals sync back here ──
    db.collection('variationOrders').onSnapshot(snapshot => {
      let changed = false;
      snapshot.docChanges().forEach(change => {
        if (change.doc.metadata.hasPendingWrites) return;
        const data = change.doc.data();
        const idx = variationOrders.findIndex(v => v.id === data.id);
        const prevStatus = idx !== -1 ? variationOrders[idx].status : null;
        if (change.type === 'removed') { if (idx !== -1) { variationOrders.splice(idx,1); changed = true; } }
        else {
          if (idx !== -1) variationOrders[idx] = data; else variationOrders.unshift(data);
          changed = true;
          if (prevStatus === 'pending' && (data.status === 'approved' || data.status === 'declined')) {
            toast(`🔔 Client ${data.status} variation ${data.id}`);
            store.activity.unshift({ text: `Variation ${data.id} ${data.status} by client via Client Portal`, time: 'Just now', type: data.status === 'approved' ? 'green' : 'red' });
            save();
          }
        }
      });
      if (changed) {
        saveVariationOrdersLocal();
        if (currentPage === 'jobcards') renderJobCards();
      }
    }, err => { console.warn('VariationOrders listener:', err); syncDiagError('variationOrders', err); });

    // ── Payroll Runs — own collection, not nested in erp/store. Same
    // reasoning as Job Cards/Variation Orders above: weekly wage records
    // with UIF/PAYE detail accumulate indefinitely, and erp/store is a
    // single shared, whole-blob-synced document capped at 1MB by Firestore.
    // Guarded with typeof checks because this listener is registered here
    // in core.js (called from the bootstrap at the bottom of this file,
    // before payroll.js has loaded) but payrollRuns/updatePayrollBadge are
    // declared in payroll.js. Safe in practice — onSnapshot only invokes
    // this callback asynchronously, well after payroll.js has finished
    // loading — but the guard keeps a future script-order change from
    // throwing instead of just skipping a redundant sync tick.
    db.collection('payrollRuns').onSnapshot(snapshot => {
      if (typeof payrollRuns === 'undefined') return;
      let changed = false;
      snapshot.docChanges().forEach(change => {
        if (change.doc.metadata.hasPendingWrites) return;
        const data = change.doc.data();
        const idx = payrollRuns.findIndex(r => r.id === data.id);
        if (change.type === 'removed') { if (idx !== -1) { payrollRuns.splice(idx,1); changed = true; } }
        else { if (idx !== -1) payrollRuns[idx] = data; else payrollRuns.unshift(data); changed = true; }
      });
      if (changed) {
        savePayrollRunsLocal();
        if (currentPage === 'payroll') renderPayrollPage();
        if (typeof updatePayrollBadge === 'function') updatePayrollBadge();
      }
    }, err => { console.warn('PayrollRuns listener:', err); syncDiagError('payrollRuns', err); });

    // ── Employee Contracts — own collection, same 1MB-cap reasoning as
    // above; each contract also embeds two signature images. Same
    // typeof-guarded cross-file pattern as Payroll Runs — employeeContracts
    // is declared in contracts.js, loaded after core.js.
    db.collection('employeeContracts').onSnapshot(snapshot => {
      if (typeof employeeContracts === 'undefined') return;
      let changed = false;
      snapshot.docChanges().forEach(change => {
        if (change.doc.metadata.hasPendingWrites) return;
        const data = change.doc.data();
        const idx = employeeContracts.findIndex(c => c.id === data.id);
        if (change.type === 'removed') { if (idx !== -1) { employeeContracts.splice(idx,1); changed = true; } }
        else { if (idx !== -1) employeeContracts[idx] = data; else employeeContracts.unshift(data); changed = true; }
      });
      if (changed) {
        saveContractsLocal();
        if (currentPage === 'contracts') renderContractsPage();
      }
    }, err => { console.warn('EmployeeContracts listener:', err); syncDiagError('employeeContracts', err); });

    syncEnabled = true;
    updateSyncIndicator('synced');
}

// ── Authentication — opt-in gate in front of Firestore access. Sign-in
// only; there is deliberately no self-service sign-up UI here, since the
// client SDK's createUserWithEmailAndPassword would let anyone who finds
// the page create their own account and get in. New accounts are created
// by an admin directly in Firebase Console → Authentication → Add User. ──
let currentAuthUser = null;

function showLoginOverlay() {
  const el = document.getElementById('login-overlay');
  if (el) el.style.display = 'flex';
}
function hideLoginOverlay() {
  const el = document.getElementById('login-overlay');
  if (el) el.style.display = 'none';
}

function attemptSignIn() {
  const email = (document.getElementById('login-email') || {}).value?.trim();
  const password = (document.getElementById('login-password') || {}).value;
  const errEl = document.getElementById('login-error');
  if (errEl) errEl.textContent = '';
  if (!email || !password) { if (errEl) errEl.textContent = 'Enter both email (or cell number) and password'; return; }
  // No '@' = a worker typing their cell number (worker.js derives and tries their login).
  if (email.indexOf('@') === -1 && window.wkSignIn) { wkSignIn(email, password, errEl); return; }
  firebase.auth().signInWithEmailAndPassword(email, password).catch(err => {
    const messages = {
      'auth/user-not-found': 'No account with that email — ask whoever manages this system to create one for you',
      'auth/wrong-password': 'Incorrect password',
      'auth/invalid-email': "That doesn't look like a valid email address",
      'auth/too-many-requests': 'Too many attempts — wait a few minutes and try again',
      'auth/invalid-credential': 'Incorrect email or password',
      'auth/user-disabled': 'This account has been disabled',
    };
    if (errEl) errEl.textContent = messages[err.code] || ('Sign-in failed: ' + err.message);
  });
}

function signOutUser() {
  if (!confirm('Sign out?')) return;
  firebase.auth().signOut();
}

function updateAuthStatusLine(user) {
  const el = document.getElementById('auth-status-line');
  if (el) el.textContent = user ? `Signed in as ${user.email}` : '';
}

// Bootstrap trigger, deliberately placed here rather than in core.js's own
// bootstrap block (see the comment there) — this is the LAST file loaded,
// so every global initFirebase()/setupFirestoreListeners() could possibly
// touch (across all four earlier files) is guaranteed to already exist.
// Reuses core.js's own _formToken/_formPid (not re-derived here) to match
// its client-form-embed-mode guard exactly: initFirebase() was never
// called in that mode before this refactor, and shouldn't start being
// called there now.
if (!(_formToken && _formPid)) {
  initFirebase();
}

