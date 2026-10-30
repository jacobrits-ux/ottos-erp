// ══════════════════════════════════════════════════════
// THE CLOCK — round 3: clock in / clock out on an accepted job, with location checks.
// Own clock.js file (own <script> tag), loaded AFTER assignments.js and BEFORE sync.js.
//
// PAID HOURS START at clock-in. A clock-in or clock-out is FLAGGED (and the session held back from
// payroll until an owner reviews it, round 4) when:
//   far           the device is more than 3 km from the job's site point
//   poorAccuracy  the location is worse than about 500 m (typical of laptops and PCs, or no GPS signal)
//   noLocation    no location could be read at all
// A flag never blocks the worker: they can always clock in and out, and the owner decides afterwards.
// Jobs sent with "no site check" skip location entirely.
//
// DATA
//   workSessions/{id}  one stretch of work. Raw readings are stored (device time, server time, lat/lng,
//                      accuracy, distance) so the owner side can recompute every flag itself in round 4;
//                      the flags saved here are the worker's device's opinion, not the authority.
//   clockState/{uid}   exists only while that person is clocked in. Clock-in creates it together with the
//                      session in ONE batch and the rules refuse a second one, so nobody can run two clocks.
// The rules, not this file, enforce who may write what.
//
// OFFLINE: a clock-in with no signal is saved on the phone and uploaded later. The session records both
// the device time and the server's receive time, so a late upload or a wrong phone clock is visible.
// ══════════════════════════════════════════════════════

const CLK_COLL = 'workSessions';
const CLK_STATE = 'clockState';
const CLK_RADIUS_M = 3000;
const CLK_ACCURACY_M = 500;
const CLK_MAX_OPEN_H = 14;
let CLK_SAVE_WAIT_MS = 4000;   // not const so tests can shorten the wait

let clkMine = [];            // this login's own sessions, live
let clkAll = [];             // owner: recent and open sessions of everyone, live
let clkMineReady = false;
let clkUnsubs = [];
let clkStarted = null;       // 'worker' | 'owner'
let clkBusy = false;
let clkTicker = null;
let clkRecent = [];          // owner listener 1 (last 14 days)
let clkOpenAll = [];         // owner listener 2 (every open session, however old)

// ── Pure helpers ────────────────────────────────────────────────────────────────
// Great-circle distance in metres (haversine).
function clkDistanceM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}
function clkSitePoint(a) {
  return a && a.siteCheck === true && typeof a.siteLat === 'number' && typeof a.siteLng === 'number' ? { lat: a.siteLat, lng: a.siteLng } : null;
}
// pos = {lat, lng, acc} or null when no reading was possible. Returns {flags, dist}.
function clkAssess(pos, site) {
  if (!site) return { flags: [], dist: null };   // "no site check": nothing to judge
  if (!pos) return { flags: ['noLocation'], dist: null };
  const dist = clkDistanceM(pos, site);
  const flags = [];
  if (!Number.isFinite(pos.acc) || pos.acc > CLK_ACCURACY_M) flags.push('poorAccuracy');
  if (dist > CLK_RADIUS_M) flags.push('far');
  return { flags, dist };
}
function clkFlagText(f) {
  return { far: 'more than 3 km from the site', poorAccuracy: 'location not accurate enough', noLocation: 'no location' }[f] || f;
}
function clkSessionId(uid, iso) { return `S${uid}_${Date.parse(iso).toString(36)}`; }
function clkFmtDuration(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m` : `${m} m`;
}
function clkFmtTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function clkFmtDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}`;
}
function clkSessionMs(s, nowMs) {
  const start = Date.parse(s.inAt);
  const end = s.status === 'closed' ? Date.parse(s.outAt) : nowMs;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}
// Phones and tablets only. This keeps honest people from clocking in on a laptop (whose location is a guess),
// but it is a convenience, not security: the owner-side flags are the backstop.
function clkDeviceOk() {
  const nav = window.navigator;
  const ua = nav.userAgent || '';
  const touch = (nav.maxTouchPoints || 0) > 0;
  const mobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const ipadOs = /Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1;
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return touch && (mobileUa || ipadOs || coarse);
}
function clkOwnUid() { return typeof asgOwnUid === 'function' ? asgOwnUid() : ''; }
function clkOpenSession() { return clkMine.find(s => s.status === 'open') || null; }

// One reading, as precise as the device can give. Never throws.
function clkGetPosition() {
  return new Promise(resolve => {
    const nav = window.navigator;
    if (!nav.geolocation) { resolve({ pos: null, reason: 'unsupported' }); return; }
    nav.geolocation.getCurrentPosition(
      p => resolve({ pos: { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }, reason: null }),
      e => resolve({ pos: null, reason: e && e.code === 1 ? 'denied' : e && e.code === 3 ? 'timeout' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}
const CLK_REASONS = {
  denied: 'Location is switched off for this site in your browser settings.',
  timeout: 'Your phone could not find its location in time.',
  unavailable: 'Your phone could not find its location.',
  unsupported: 'This device cannot share its location.',
};

// ── Clock in ────────────────────────────────────────────────────────────────────
// Waits a few seconds for the server; with no signal the write is kept on the phone and uploads later,
// and the screen updates from the phone's own copy either way.
async function clkSaveBatch(batch) {
  let failed = null;
  const p = batch.commit().catch(err => { failed = err; });
  const outcome = await Promise.race([p.then(() => 'done'), new Promise(r => setTimeout(() => r('slow'), CLK_SAVE_WAIT_MS))]);
  if (failed) throw failed;
  return outcome;
}
function clkWriteError(err) {
  return 'That did not save (' + ((err && err.code) || (err && err.message) || 'unknown error') + '). Check your connection and try again.';
}

async function clkIn(assignmentId) {
  if (clkBusy) return;
  const a = (typeof asgMine !== 'undefined' ? asgMine : []).find(x => x.id === assignmentId);
  const uid = clkOwnUid();
  if (!a || a.status !== 'accepted' || !uid) return;
  if (!clkDeviceOk()) { alert('Please clock in from your phone or tablet.'); return; }
  if (clkOpenSession()) { alert('You are already clocked in. Clock out first.'); return; }
  clkBusy = true;
  try {
    const site = clkSitePoint(a);
    let read = { pos: null, reason: null };
    if (site) {
      toast('Getting your location…');
      read = await clkGetPosition();
    }
    const { flags, dist } = clkAssess(read.pos, site);
    if (flags.length) {
      const why = read.pos ? flags.map(clkFlagText).join(' and ') : (CLK_REASONS[read.reason] || 'No location.');
      if (!confirm(`${why}\n\nYou can still clock in, but the owner will be asked to check this clock-in before it counts. Clock in anyway?\n\n(Cancel to try again, ideally outside.)`)) return;
    }
    const now = new Date().toISOString();
    const sid = clkSessionId(uid, now);
    const s = {
      assignmentId: a.id, jobKey: a.jobKey, jobTask: a.jobTask, workerUid: uid, workerCrewId: a.workerCrewId, workerName: a.workerName,
      siteCheck: a.siteCheck === true, status: 'open', flagged: flags.length > 0,
      inAt: now, inServerAt: firebase.firestore.FieldValue.serverTimestamp(), inFlags: flags,
    };
    if (a.projectId) s.projectId = a.projectId;
    if (a.projectName) s.projectName = a.projectName;
    if (site) { s.siteLat = site.lat; s.siteLng = site.lng; }
    if (read.pos) { s.inLat = read.pos.lat; s.inLng = read.pos.lng; s.inAcc = Math.round(read.pos.acc); }
    if (dist != null) s.inDist = dist;
    const batch = db.batch();
    batch.set(db.collection(CLK_STATE).doc(uid), { sessionId: sid, assignmentId: a.id, startedAt: now });
    batch.set(db.collection(CLK_COLL).doc(sid), s);
    const outcome = await clkSaveBatch(batch);
    toast(outcome === 'slow' ? 'Clocked in. Saved on your phone, it uploads when you have signal.' : 'Clocked in ✓');
  } catch (err) {
    alert(clkWriteError(err));
  } finally {
    clkBusy = false;
  }
}

// ── Clock out ───────────────────────────────────────────────────────────────────
async function clkOut() {
  if (clkBusy) return;
  const open = clkOpenSession();
  const uid = clkOwnUid();
  if (!open || !uid) return;
  if (!clkDeviceOk()) { alert('Please clock out from your phone or tablet.'); return; }
  clkBusy = true;
  try {
    const site = open.siteCheck === true && typeof open.siteLat === 'number' && typeof open.siteLng === 'number' ? { lat: open.siteLat, lng: open.siteLng } : null;
    let read = { pos: null, reason: null };
    if (site) { toast('Getting your location…'); read = await clkGetPosition(); }
    const { flags, dist } = clkAssess(read.pos, site);
    if (flags.length) {
      const why = read.pos ? flags.map(clkFlagText).join(' and ') : (CLK_REASONS[read.reason] || 'No location.');
      if (!confirm(`${why}\n\nYou can still clock out, but the owner will be asked to check this session before it counts. Clock out anyway?\n\n(Cancel to try again, ideally outside.)`)) return;
    }
    const now = new Date().toISOString();
    const upd = {
      status: 'closed', outAt: now, outServerAt: firebase.firestore.FieldValue.serverTimestamp(), outFlags: flags,
      flagged: (open.inFlags || []).length > 0 || flags.length > 0,
    };
    if (read.pos) { upd.outLat = read.pos.lat; upd.outLng = read.pos.lng; upd.outAcc = Math.round(read.pos.acc); }
    if (dist != null) upd.outDist = dist;
    const batch = db.batch();
    batch.update(db.collection(CLK_COLL).doc(open.id), upd);
    batch.delete(db.collection(CLK_STATE).doc(uid));
    const outcome = await clkSaveBatch(batch);
    const worked = clkFmtDuration(Date.parse(now) - Date.parse(open.inAt));
    toast(outcome === 'slow' ? `Clocked out (${worked}). Saved on your phone, it uploads when you have signal.` : `Clocked out ✓ ${worked}`);
  } catch (err) {
    alert(clkWriteError(err));
  } finally {
    clkBusy = false;
  }
}

// ── Worker views (called from assignments.js / worker.js) ───────────────────────
// The banner is separate from the job cards on purpose: it must still offer CLOCK OUT if the owner
// cancels the assignment while someone is on the clock.
function clkBannerHtml() {
  const s = clkOpenSession();
  if (!s) return '';
  const ms = clkSessionMs(s, Date.now());
  const long = ms > CLK_MAX_OPEN_H * 3600000;
  return `<div class="card-item" style="margin:14px 0;border-left:3px solid ${long ? 'var(--red)' : 'var(--green)'}">
    <div style="font-family:var(--fm);font-size:10px;letter-spacing:2px;color:${long ? 'var(--red)' : 'var(--green)'}">● CLOCKED IN</div>
    <div style="font-size:15px;font-weight:600;margin-top:4px">${wkEsc(s.jobTask)}</div>
    <div style="font-size:12px;color:var(--text2);margin-top:2px">Since ${wkEsc(clkFmtTime(s.inAt))} · ${wkEsc(clkFmtDuration(ms))}</div>
    ${long ? `<div style="font-size:12px;color:var(--red);margin-top:6px">You have been clocked in for over ${CLK_MAX_OPEN_H} hours. Clock out now. The owner will check this session.</div>` : ''}
    ${(s.inFlags || []).length ? '<div style="font-size:11px;color:var(--text3);margin-top:6px">Your clock-in will be checked by the owner.</div>' : ''}
    <div style="margin-top:10px"><button class="topbar-btn" onclick="clkOut()">CLOCK OUT</button></div></div>`;
}

// What an ACCEPTED job card shows in place of a button-less line.
function clkCardAction(a) {
  const open = clkOpenSession();
  if (!clkDeviceOk()) return '<div style="font-size:11px;color:var(--text3);margin-top:10px">Clock in from your phone or tablet.</div>';
  if (open && open.assignmentId === a.id) return '<div style="font-size:11px;color:var(--green);margin-top:10px">You are clocked in on this job. Use CLOCK OUT above.</div>';
  if (open) return `<div style="font-size:11px;color:var(--text3);margin-top:10px">You are clocked in on “${wkEsc(open.jobTask)}”. Clock out first.</div>`;
  const note = a.siteCheck === true
    ? 'Your location is checked when you clock in.'
    : 'No site check on this job.';
  return `<div style="margin-top:12px"><button class="topbar-btn" onclick="clkIn(${rlJs(a.id)})">CLOCK IN</button>
    <div style="font-size:11px;color:var(--text3);margin-top:6px">${note}</div></div>`;
}

// The worker's own recent sessions, so they can see what they have done.
function clkHoursHtml() {
  const list = clkMine.slice().sort((a, b) => String(b.inAt).localeCompare(String(a.inAt))).slice(0, 10);
  if (!list.length) return '';
  const now = Date.now();
  const rows = list.map(s => {
    const range = s.status === 'closed' ? `${clkFmtTime(s.inAt)}–${clkFmtTime(s.outAt)}` : `${clkFmtTime(s.inAt)}–now`;
    return `<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">
      <div><div>${wkEsc(clkFmtDay(s.inAt))} · ${wkEsc(range)}</div><div style="color:var(--text3);margin-top:2px">${wkEsc(s.jobTask)}</div></div>
      <div style="text-align:right;white-space:nowrap">${wkEsc(clkFmtDuration(clkSessionMs(s, now)))}${s.flagged ? '<div style="font-size:10px;color:var(--accent);margin-top:2px">Owner will check</div>' : ''}</div></div>`;
  }).join('');
  return `<div style="font-family:var(--fm);font-size:10px;letter-spacing:2px;color:var(--text3);text-transform:uppercase;margin:24px 0 6px">My recent hours</div>${rows}`;
}

// ── Owner views ─────────────────────────────────────────────────────────────────
function clkSessionsForAssignment(a) { return clkAll.filter(s => s.assignmentId === a.id); }
function clkOwnerLine(a) {
  const list = clkSessionsForAssignment(a);
  if (!list.length) return '';
  const open = list.find(s => s.status === 'open');
  const now = Date.now();
  const closedMs = list.filter(s => s.status === 'closed').reduce((t, s) => t + clkSessionMs(s, now), 0);
  const flagged = list.filter(s => s.flagged).length;
  const parts = [];
  if (open) parts.push(`<span style="color:var(--green)">● on the clock since ${wkEsc(clkFmtTime(open.inAt))} (${wkEsc(clkFmtDuration(clkSessionMs(open, now)))})</span>`);
  if (closedMs > 0 || list.some(s => s.status === 'closed')) parts.push(`${wkEsc(clkFmtDuration(closedMs))} worked`);
  if (flagged) parts.push(`<span style="color:var(--accent)">⚠ ${flagged} to check</span>`);
  return `<div style="font-size:11px;color:var(--text3);margin-top:4px">${parts.join(' · ')}</div>`;
}
function clkOnSiteCount(ticket) {
  return ticket && ticket.jobKey ? clkAll.filter(s => s.status === 'open' && s.jobKey === ticket.jobKey).length : 0;
}

// ── Live data ───────────────────────────────────────────────────────────────────
function clkRedraw() {
  if (currentPage === 'myjobs' && typeof renderMyJobs === 'function') renderMyJobs();
  if (currentPage === 'jobs' && typeof renderPage === 'function') renderPage('jobs');
  if (typeof asgRefreshTicketWorkers === 'function') asgRefreshTicketWorkers();
}
function clkEnsureTicker() {
  const needed = clkMine.some(s => s.status === 'open') || clkAll.some(s => s.status === 'open');
  if (needed && !clkTicker) clkTicker = window.setInterval(clkRedraw, 30000);
  if (!needed && clkTicker) { window.clearInterval(clkTicker); clkTicker = null; }
}
function clkStopTicker() { if (clkTicker) { window.clearInterval(clkTicker); clkTicker = null; } }
function clkStopSync() {
  clkUnsubs.forEach(u => { try { u(); } catch (e) { /* already closed */ } });
  clkUnsubs = []; clkMine = []; clkAll = []; clkRecent = []; clkOpenAll = []; clkMineReady = false; clkStarted = null; clkBusy = false;
  clkStopTicker();
}
const clkDocs = qs => qs.docs.map(d => Object.assign({ id: d.id }, d.data()));
function clkDiag(err) { if (typeof syncDiagError === 'function') syncDiagError(CLK_COLL, err); }

// A person listens to ONLY their own sessions; the rules refuse anything wider.
function clkStartWorkerSync() {
  if (clkStarted === 'worker') return;
  clkStopSync(); clkStarted = 'worker';
  const uid = clkOwnUid();
  if (!uid) return;
  clkUnsubs.push(db.collection(CLK_COLL).where('workerUid', '==', uid).onSnapshot(qs => {
    clkMine = clkDocs(qs); clkMineReady = true; clkEnsureTicker(); clkRedraw();
  }, err => { clkDiag(err); }));
}
// Owners: the last 14 days plus every session still open (a stuck one may be older than that).
function clkStartOwnerSync() {
  if (clkStarted === 'owner') return;
  clkStopSync(); clkStarted = 'owner';
  const merge = () => {
    const byId = new Map();
    clkRecent.concat(clkOpenAll).forEach(s => byId.set(s.id, s));
    clkAll = [...byId.values()];
    const me = clkOwnUid();
    clkMine = clkAll.filter(s => s.workerUid === me);
    clkMineReady = true; clkEnsureTicker(); clkRedraw();
  };
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
  clkUnsubs.push(db.collection(CLK_COLL).where('inAt', '>=', cutoff).onSnapshot(qs => { clkRecent = clkDocs(qs); merge(); }, clkDiag));
  clkUnsubs.push(db.collection(CLK_COLL).where('status', '==', 'open').onSnapshot(qs => { clkOpenAll = clkDocs(qs); merge(); }, clkDiag));
}
