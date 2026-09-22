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
          hideLoginOverlay();
          updateAuthStatusLine(user);
          setupFirestoreListeners();
        } else {
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
let firestoreListenersInitialized = false;
function setupFirestoreListeners() {
  if (firestoreListenersInitialized) return;
  firestoreListenersInitialized = true;

    // ── Main store listener ──
    db.collection('erp').doc('store').onSnapshot(doc => {
      if (!doc.exists()) {
        db.collection('erp').doc('store').set({ ...store, _ts: Date.now(), _dev: DEVICE_ID }).catch(() => {});
        return;
      }
      const remote = doc.data();
      const meta = doc.metadata;
      if (meta.hasPendingWrites) return;
      if (remote._dev && remote._dev !== DEVICE_ID) {
        COLLECTIONS.forEach(k => { if (Array.isArray(remote[k])) store[k] = remote[k]; });
        // payrollSettings is a bounded object, not an array — COLLECTIONS'
        // Array.isArray guard above intentionally skips it, so merge it here.
        if (remote.payrollSettings && typeof remote.payrollSettings === 'object') store.payrollSettings = remote.payrollSettings;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch(e) {}
        renderPage(currentPage);
        updateSyncBadges();
        toast('⟳ Live update from other device');
      }
      updateSyncIndicator(meta.fromCache ? 'offline' : 'synced');
    }, err => { console.warn('Firestore listener:', err); updateSyncIndicator('offline'); });

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
    }, err => console.warn('ClientForms listener:', err));

    // ── Client portal — quote approve/decline actions from clients ──
    db.collection('clientPortal').onSnapshot(snapshot => {
      snapshot.docChanges().forEach(change => {
        if (change.type === 'removed') return;
        const d = change.doc.data();
        if (!d.actions) return;
        try { applyPortalActions(change.doc.id, JSON.parse(d.actions)); } catch(e) { console.warn('Portal action parse error:', e); }
      });
    }, err => console.warn('ClientPortal listener:', err));

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
    }, err => console.warn('JobCards listener:', err));

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
    }, err => console.warn('VariationOrders listener:', err));

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
    }, err => console.warn('PayrollRuns listener:', err));

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
    }, err => console.warn('EmployeeContracts listener:', err));

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
  if (!email || !password) { if (errEl) errEl.textContent = 'Enter both email and password'; return; }
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

