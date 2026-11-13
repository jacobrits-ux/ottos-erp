// ══════════════════════════════════════════════════════
// REVIEW — round 4: Action Items, owner review of clock sessions, and how worker-app hours reach
// Time Tracking and Payroll. Own review.js file, loaded AFTER clock.js and BEFORE sync.js.
//
// THE OWNER SIDE IS THE AUTHORITY. The phone's own flags are only its opinion, so every session is judged
// again here from the raw readings (locations, accuracy, device and server times) against the shared limits:
//   far / poor accuracy / no location    at clock-in and at clock-out (jobs with a site check)
//   clock difference                     device time vs server time further apart than the limit
//   long session                         ran (or is still running) longer than the maximum hours
//   overlap                              the same person has another session running at the same time
//
// WHAT COUNTS FOR PAY
//   counted   closed, not declined, and either approved/adjusted by an owner or nothing to question
//   payable   counted and not yet paid (settled)
// A session that needs review is held back until an owner approves, adjusts (corrects the times, note
// required, the phone's originals stay on file) or declines it (zero pay, kept on record).
//
// CARRY-FORWARD: a payable session joins the first payroll run whose period ends on or after its date and
// that does not already hold it. If its own week's run is already finalised it simply lands in the next run,
// shown on the payslip as carried hours. Finalised runs are never reopened.
// ══════════════════════════════════════════════════════

const REV_H = 3600000;
const REV_MAX_SPAN_H = 48;

// ── Pure helpers ────────────────────────────────────────────────────────────────
// Accepts ISO text, a Firestore Timestamp, {seconds}, a Date or a number. NaN when it cannot be read.
function revToMs(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v);
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.getTime === 'function') return v.getTime();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  return NaN;
}
function revCtx() {
  return { cfg: clkCfg(), nowMs: Date.now(), all: typeof clkAll !== 'undefined' ? clkAll : [] };
}
function revFmtDist(m) { return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`; }
function revSite(s) {
  return s.siteCheck === true && typeof s.siteLat === 'number' && typeof s.siteLng === 'number' ? { lat: s.siteLat, lng: s.siteLng } : null;
}
// The times that count: an owner's correction replaces the phone's.
function revInterval(s, nowMs) {
  const a = revToMs(s.adjInAt || s.inAt);
  const b = s.status === 'closed' ? revToMs(s.adjOutAt || s.outAt) : nowMs;
  return [a, b];
}
function revMinutes(s) {
  const [a, b] = revInterval(s, 0);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? Math.round((b - a) / 60000) : 0;
}

// Every reason this session should be looked at, judged from the raw readings. [{code, text}]
function revReasons(s, ctx) {
  const cfg = ctx.cfg, out = [];
  const site = revSite(s);
  const point = (lat, lng, acc, when) => {
    if (typeof lat !== 'number' || typeof lng !== 'number') { out.push({ code: 'noLocation', text: `No location when ${when}` }); return; }
    const d = clkDistanceM({ lat, lng }, site);
    if (d > cfg.radiusM) out.push({ code: 'far', text: `${when === 'clocking in' ? 'Clocked in' : 'Clocked out'} ${revFmtDist(d)} from the site` });
    if (!(acc <= cfg.accuracyM)) out.push({ code: 'poorAccuracy', text: `Location when ${when} was only accurate to ${Number.isFinite(acc) ? '±' + Math.round(acc) + ' m' : 'an unknown distance'}` });
  };
  if (site) {
    point(s.inLat, s.inLng, s.inAcc, 'clocking in');
    if (s.status === 'closed') point(s.outLat, s.outLng, s.outAcc, 'clocking out');
  }
  const skew = (devIso, server, when) => {
    const a = revToMs(devIso), b = revToMs(server);
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(b - a) > cfg.skewMin * 60000)
      out.push({ code: 'clockSkew', text: `Phone time and server time were ${Math.round(Math.abs(b - a) / 60000)} min apart ${when} (late upload or wrong phone clock)` });
  };
  skew(s.inAt, s.inServerAt, 'at clock-in');
  if (s.status === 'closed') skew(s.outAt, s.outServerAt, 'at clock-out');
  const [a, b] = revInterval(s, ctx.nowMs);
  if (Number.isFinite(a) && Number.isFinite(b) && b - a > cfg.maxHours * REV_H)
    out.push({ code: 'long', text: s.status === 'closed' ? `Ran ${clkFmtDuration(b - a)}` : `Still clocked in after ${clkFmtDuration(b - a)}` });
  ctx.all.forEach(o => {
    if (o.id === s.id || o.workerUid !== s.workerUid || o.reviewStatus === 'declined') return;
    const [oa, ob] = revInterval(o, ctx.nowMs);
    const ov = Math.min(b, ob) - Math.max(a, oa);
    if (ov > 60000) out.push({ code: 'overlap', text: `Overlaps “${o.jobTask}” by ${clkFmtDuration(ov)}` });
  });
  return out;
}

// Needs an owner's decision now. A running clock is only a question once it is stuck (running too long).
function revNeedsReview(s, ctx) {
  if (s.reviewStatus || s.settled === true) return false;
  const r = revReasons(s, ctx);
  return s.status === 'open' ? r.some(x => x.code === 'long') : r.length > 0;
}
function revCounted(s, ctx) {
  if (s.status !== 'closed' || s.reviewStatus === 'declined' || revMinutes(s) <= 0) return false;
  return s.reviewStatus === 'approved' || s.reviewStatus === 'adjusted' || revReasons(s, ctx).length === 0;
}
function revPayable(s, ctx) { return s.settled !== true && revCounted(s, ctx); }

// A worker-app session in the shape Time Tracking and Payroll already understand.
function revMapExt(s) {
  const crew = (store.crew || []).find(c => wkCrewKey(c) === String(s.workerCrewId));
  const [a] = revInterval(s, Date.now());
  const closed = s.status === 'closed';
  return {
    id: s.id, worker: crew ? crew.name : s.workerName, project: s.projectName || '-', address: s.siteLabel || '',
    clockIn: new Date(a).toISOString(), clockOut: closed ? new Date(revInterval(s, 0)[1]).toISOString() : null,
    duration: closed ? revMinutes(s) : null, _ext: true,
  };
}

// Time Tracking: its own sessions plus worker-app sessions that are running or counted (paid or not), newest first.
// Sessions still waiting for a decision are left out so Est. Pay never includes hours nobody has approved.
function allTimeSessions() {
  const legacy = store.timeSessions || [];
  const all = typeof clkAll !== 'undefined' ? clkAll : [];
  if (!all.length) return legacy;
  const ctx = revCtx();
  const ext = all.filter(s => (s.status === 'open' && Number.isFinite(revInterval(s, 0)[0]) && !revNeedsReview(s, ctx)) || revCounted(s, ctx)).map(revMapExt);
  return ext.length ? legacy.concat(ext).sort((x, y) => Date.parse(y.clockIn) - Date.parse(x.clockIn)) : legacy;
}

// Payroll: payable worker-app sessions dated on or before the period's end that no finalised run holds yet.
// Those dated before the period's start are CARRIED hours (marked so the payslip can say so).
function payableWorkSessions(periodStart, periodEnd, paidIds) {
  const all = typeof clkAll !== 'undefined' ? clkAll : [];
  const start = new Date(periodStart + 'T00:00:00').getTime();
  const end = new Date(periodEnd + 'T23:59:59').getTime();
  const paid = paidIds instanceof Set ? paidIds : new Set(paidIds || []);
  const ctx = revCtx();
  return all.filter(s => !paid.has(s.id) && revPayable(s, ctx))
    .map(s => ({ s, a: revInterval(s, 0)[0] }))
    .filter(x => x.a <= end)
    .map(x => Object.assign(revMapExt(x.s), { _carried: x.a < start }));
}
// Sessions waiting for a decision that would have been in this run: so the owner is warned before finalising.
function revPending(periodEnd) {
  const all = typeof clkAll !== 'undefined' ? clkAll : [];
  const end = new Date(periodEnd + 'T23:59:59').getTime();
  const ctx = revCtx();
  const list = all.filter(s => s.status === 'closed' && revNeedsReview(s, ctx) && revInterval(s, 0)[0] <= end);
  return { count: list.length, minutes: list.reduce((t, s) => t + revMinutes(s), 0) };
}
function revWaitingCount() { const ctx = revCtx(); return (typeof clkAll !== 'undefined' ? clkAll : []).filter(s => revNeedsReview(s, ctx)).length; }

// ── Settlement (called by payroll.js when a run is finalised or voided) ─────────
async function revSettle(run) {
  const ids = new Set((run.payslips || []).flatMap(p => p.timeSessionIds || []));
  const mine = (typeof clkAll !== 'undefined' ? clkAll : []).filter(s => ids.has(s.id) && s.settled !== true);
  for (let i = 0; i < mine.length; i += 400) {
    const batch = db.batch();
    mine.slice(i, i + 400).forEach(s => batch.update(db.collection(CLK_COLL).doc(s.id), { settled: true, paidRunId: String(run.id) }));
    try { await batch.commit(); } catch (err) { toast('The run is saved, but some worker-app sessions could not be marked as paid (' + ((err && err.code) || 'error') + ').'); return; }
  }
}
async function revUnsettle(run) {
  const mine = (typeof clkAll !== 'undefined' ? clkAll : []).filter(s => s.paidRunId === String(run.id));
  const del = firebase.firestore.FieldValue.delete();
  for (let i = 0; i < mine.length; i += 400) {
    const batch = db.batch();
    mine.slice(i, i + 400).forEach(s => batch.update(db.collection(CLK_COLL).doc(s.id), { settled: false, paidRunId: del }));
    try { await batch.commit(); } catch (err) { toast('The run is voided, but some worker-app sessions could not be released (' + ((err && err.code) || 'error') + ').'); return; }
  }
}

// ── Menu entry and badge ────────────────────────────────────────────────────────
function revApplyRole() {
  const existing = document.getElementById('nav-actions');
  if (typeof can !== 'function' || !can('actions')) { if (existing) existing.remove(); return; }
  if (!existing) {
    const el = document.createElement('div');
    el.className = 'nav-item';
    el.id = 'nav-actions';
    el.setAttribute('onclick', "navigate('actions')");
    el.innerHTML = '<span class="nav-icon">⚑</span>Action Items <span id="rev-badge" style="display:none;margin-left:6px;background:var(--accent);color:#000;border-radius:9px;padding:0 6px;font-size:10px"></span>';
    const users = document.getElementById('nav-users');
    const sidebar = document.getElementById('sidebar');
    if (users) users.insertAdjacentElement('afterend', el);
    else if (sidebar) sidebar.appendChild(el);
  }
  revRefresh();
}
function revRefresh() {
  const badge = document.getElementById('rev-badge');
  if (badge) { const n = revWaitingCount(); badge.textContent = String(n); badge.style.display = n ? '' : 'none'; }
  if (currentPage === 'actions') renderActions();
}

// ── The Action Items page ───────────────────────────────────────────────────────
function revRoot() {
  let page = document.getElementById('page-actions');
  if (!page) {
    page = document.createElement('div');
    page.className = 'page';
    page.id = 'page-actions';
    page.innerHTML = '<div class="panel"><div id="actions-root"></div></div>';
    (document.querySelector('.content') || document.body).appendChild(page);
  }
  if (currentPage === 'actions') page.classList.add('active');
  return document.getElementById('actions-root');
}
function revTimeRange(s) {
  const [a, b] = revInterval(s, Date.now());
  const day = clkFmtDay(new Date(a).toISOString());
  return s.status === 'closed' ? `${day} · ${clkFmtTime(new Date(a).toISOString())}–${clkFmtTime(new Date(b).toISOString())} · ${clkFmtDuration(b - a)}` : `${day} · from ${clkFmtTime(new Date(a).toISOString())}, still running (${clkFmtDuration(b - a)})`;
}
function revPoints(s) {
  const link = (p, label) => `<a href="${wkEsc(asgMapsUrl(p))}" target="_blank" rel="noopener" style="color:var(--accent)">${label}</a>`;
  const parts = [];
  if (typeof s.inLat === 'number' && typeof s.inLng === 'number') parts.push(link({ lat: s.inLat, lng: s.inLng }, 'Clock-in point'));
  if (typeof s.outLat === 'number' && typeof s.outLng === 'number') parts.push(link({ lat: s.outLat, lng: s.outLng }, 'Clock-out point'));
  if (revSite(s)) parts.push(link(revSite(s), 'Site'));
  return parts.length ? `<div style="font-size:11px;margin-top:8px;display:flex;gap:14px;flex-wrap:wrap">${parts.join('')}</div>` : '';
}
function revCardHtml(s, ctx) {
  const id = rlJs(s.id);
  const reasons = revReasons(s, ctx).map(r => `<div style="font-size:12px;color:var(--accent);margin-top:4px">⚠ ${wkEsc(r.text)}</div>`).join('');
  const stuck = s.status === 'open';
  const btns = stuck
    ? `<button class="action-btn" onclick="revAdjustAsk(${id})">Set end time</button>`
    : `<button class="action-btn" onclick="revApprove(${id})">Approve</button> <button class="action-btn" onclick="revAdjustAsk(${id})">Adjust</button> <button class="action-btn" onclick="revDeclineAsk(${id})">Decline</button>`;
  return `<div class="card-item" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;gap:10px"><strong>${wkEsc(s.workerName)}</strong><span style="font-family:var(--fm);font-size:10px;color:var(--text3)">${stuck ? 'STILL RUNNING' : 'NEEDS A DECISION'}</span></div>
    <div style="font-size:13px;margin-top:2px">${wkEsc(s.jobTask)}${s.projectName ? ` <span style="color:var(--text3)">· ${wkEsc(s.projectName)}</span>` : ''}</div>
    <div style="font-family:var(--fm);font-size:11px;color:var(--text2);margin-top:4px">${wkEsc(revTimeRange(s))}</div>
    ${reasons}${revPoints(s)}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">${btns} <button class="action-btn danger" onclick="revDelete(${id})">Delete</button></div></div>`;
}
function revDecidedHtml(s) {
  const label = { approved: 'Approved', adjusted: 'Adjusted', declined: 'Declined' }[s.reviewStatus];
  const undo = s.settled === true && s.reviewStatus !== 'declined' ? '' : (s.closedBy === 'owner' ? '' : `<button class="action-btn" onclick="revUndo(${rlJs(s.id)})">Undo</button>`);
  return `<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">
    <div><div><strong>${wkEsc(s.workerName)}</strong> · ${wkEsc(s.jobTask)}</div><div style="color:var(--text3);margin-top:2px">${wkEsc(revTimeRange(s))}${s.reviewNote ? ` · “${wkEsc(s.reviewNote)}”` : ''}</div></div>
    <div style="text-align:right;white-space:nowrap"><div style="color:${s.reviewStatus === 'declined' ? 'var(--red)' : 'var(--green)'}">${label}</div>${undo}</div></div>`;
}
function renderActions() {
  const root = revRoot();
  const title = document.getElementById('page-title');
  if (title) title.textContent = 'Action Items';
  if (!can('actions')) { root.innerHTML = ''; return; }
  const ctx = revCtx(), cfg = ctx.cfg;
  const all = ctx.all.filter(s => s.status === 'closed' || s.status === 'open');
  const need = all.filter(s => revNeedsReview(s, ctx)).sort((a, b) => revInterval(a, 0)[0] - revInterval(b, 0)[0]);
  const waitingPay = all.filter(s => revPayable(s, ctx));
  const payMin = waitingPay.reduce((t, s) => t + revMinutes(s), 0);
  const decided = all.filter(s => s.reviewStatus).sort((a, b) => String(b.reviewedAt || '').localeCompare(String(a.reviewedAt || ''))).slice(0, 15);
  root.innerHTML = `<div style="padding:18px;max-width:760px">
    <div style="font-size:11px;color:var(--text3);line-height:1.6;margin-bottom:14px">Limits: ${wkEsc(revFmtDist(cfg.radiusM))} from the site · location accurate to ${cfg.accuracyM} m · ${cfg.maxHours} h longest session · ${cfg.skewMin} min phone-clock difference.
      <a href="#" onclick="revSettingsAsk();return false" style="color:var(--accent)">Change limits</a></div>
    <div style="font-family:var(--fm);font-size:10px;letter-spacing:2px;color:var(--text3);text-transform:uppercase;margin-bottom:8px">Needs your decision (${need.length})</div>
    ${need.length ? need.map(s => revCardHtml(s, ctx)).join('') : '<div style="font-size:13px;color:var(--text3);padding:6px 0 14px">Nothing needs your attention.</div>'}
    <div style="font-size:12px;color:var(--text2);margin:14px 0">${waitingPay.length} session${waitingPay.length === 1 ? '' : 's'} (${wkEsc(clkFmtDuration(payMin * 60000))}) counted and waiting for the next payroll run.</div>
    ${decided.length ? `<div style="font-family:var(--fm);font-size:10px;letter-spacing:2px;color:var(--text3);text-transform:uppercase;margin:18px 0 6px">Recently decided</div>${decided.map(revDecidedHtml).join('')}` : ''}
  </div>`;
}

// ── Decisions ───────────────────────────────────────────────────────────────────
function revFind(id) { return (typeof clkAll !== 'undefined' ? clkAll : []).find(s => s.id === id) || null; }
function revWriteError(err) { return 'That did not save (' + ((err && err.code) || (err && err.message) || 'unknown error') + '). Check your connection and try again.'; }
function revDecision(status, note) {
  const d = { reviewStatus: status, reviewedBy: currentProfile.email, reviewedAt: new Date().toISOString() };
  if (note) d.reviewNote = String(note).slice(0, 500);
  return d;
}
async function revApprove(id) {
  const s = revFind(id);
  if (!can('actions') || !s || s.status !== 'closed' || s.reviewStatus || s.settled === true) return;
  try { await db.collection(CLK_COLL).doc(id).update(revDecision('approved', '')); toast('Approved ✓'); }
  catch (err) { alert(revWriteError(err)); }
}
function revDeclineAsk(id) {
  const s = revFind(id);
  if (!can('actions') || !s || s.status !== 'closed' || s.reviewStatus || s.settled === true) return;
  openModal('DECLINE THIS SESSION', `<div style="font-size:13px;margin-bottom:10px"><strong>${wkEsc(s.workerName)}</strong> · ${wkEsc(s.jobTask)}<br><span style="color:var(--text3)">${wkEsc(revTimeRange(s))}</span></div>
    <div style="font-size:12px;color:var(--text2);margin-bottom:10px">A declined session is not paid. It stays on record.</div>
    <div class="form-group full"><label>Why? (required)</label><textarea id="f-rev-note" rows="3" maxlength="500"></textarea></div>
    <div class="form-actions"><button class="topbar-btn" onclick="revDeclineSave(${rlJs(id)})">DECLINE</button><button class="topbar-btn secondary" onclick="closeModalDirect()">BACK</button></div>`);
}
async function revDeclineSave(id) {
  const s = revFind(id);
  const note = ((document.getElementById('f-rev-note') || {}).value || '').trim();
  if (!can('actions') || !s || s.status !== 'closed' || s.reviewStatus || s.settled === true) return;
  if (note.length < 3) { alert('Please give a reason, in a few words.'); return; }
  try { await db.collection(CLK_COLL).doc(id).update(Object.assign(revDecision('declined', note), { settled: true })); closeModalDirect(); toast('Declined'); }
  catch (err) { alert(revWriteError(err)); }
}

// datetime-local needs "YYYY-MM-DDTHH:mm" in local time.
function revLocalInput(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function revAdjustAsk(id) {
  const s = revFind(id);
  if (!can('actions') || !s || s.reviewStatus || s.settled === true) return;
  const [a, b] = revInterval(s, 0);
  const stuck = s.status === 'open';
  openModal(stuck ? 'SET THE END TIME' : 'ADJUST THIS SESSION', `<div style="font-size:13px;margin-bottom:10px"><strong>${wkEsc(s.workerName)}</strong> · ${wkEsc(s.jobTask)}<br><span style="color:var(--text3)">${wkEsc(revTimeRange(s))}</span></div>
    <div class="form-grid">
      <div class="form-group"><label>Started</label><input type="datetime-local" id="f-rev-in" value="${wkEsc(revLocalInput(a))}"></div>
      <div class="form-group"><label>Finished</label><input type="datetime-local" id="f-rev-out" value="${stuck ? '' : wkEsc(revLocalInput(b))}"></div>
      <div class="form-group full"><label>Why? (required)</label><textarea id="f-rev-note" rows="2" maxlength="500"></textarea></div>
    </div>
    <div style="font-size:11px;color:var(--text3);margin-top:6px">The phone's original times stay on record. These corrected times are what is paid.</div>
    <div class="form-actions"><button class="topbar-btn" onclick="revAdjustSave(${rlJs(id)})">SAVE</button><button class="topbar-btn secondary" onclick="closeModalDirect()">BACK</button></div>`);
}
async function revAdjustSave(id) {
  const s = revFind(id);
  if (!can('actions') || !s || s.reviewStatus || s.settled === true) return;
  const v = k => (document.getElementById(k) || {}).value || '';
  const a = new Date(v('f-rev-in')).getTime(), b = new Date(v('f-rev-out')).getTime(), note = v('f-rev-note').trim();
  if (!Number.isFinite(a) || !Number.isFinite(b)) { alert('Set both the start and the finish.'); return; }
  if (b <= a) { alert('The finish must be after the start.'); return; }
  if (b - a > REV_MAX_SPAN_H * REV_H) { alert(`That is longer than ${REV_MAX_SPAN_H} hours. Split it into separate sessions or decline it.`); return; }
  if (note.length < 3) { alert('Please give a reason, in a few words.'); return; }
  const upd = Object.assign(revDecision('adjusted', note), { adjInAt: new Date(a).toISOString(), adjOutAt: new Date(b).toISOString() });
  try {
    if (s.status === 'open') {
      // Closing a stuck clock also frees that person to clock in again (their pointer is removed, but only if it is this session's).
      Object.assign(upd, { status: 'closed', outAt: upd.adjOutAt, closedBy: 'owner' });
      const batch = db.batch();
      batch.update(db.collection(CLK_COLL).doc(id), upd);
      const ptr = await db.collection('clockState').doc(s.workerUid).get();
      if (ptr.exists && ptr.data().sessionId === id) batch.delete(db.collection('clockState').doc(s.workerUid));
      await batch.commit();
    } else {
      await db.collection(CLK_COLL).doc(id).update(upd);
    }
    closeModalDirect(); toast('Saved ✓');
  } catch (err) { alert(revWriteError(err)); }
}

// Take a decision back (not once the session has been paid, and not for a clock an owner closed).
async function revUndo(id) {
  const s = revFind(id);
  if (!can('actions') || !s || !s.reviewStatus || s.closedBy === 'owner') return;
  if (s.settled === true && s.reviewStatus !== 'declined') { alert('That session has already been paid.'); return; }
  if (!confirm('Take this decision back? The session will need a decision again.')) return;
  const del = firebase.firestore.FieldValue.delete();
  try {
    await db.collection(CLK_COLL).doc(id).update({ reviewStatus: del, reviewedBy: del, reviewedAt: del, reviewNote: del, adjInAt: del, adjOutAt: del, settled: false });
    toast('Decision taken back');
  } catch (err) { alert(revWriteError(err)); }
}

// Test sessions and mistakes. Never a session a payroll run has paid.
async function revDelete(id) {
  const s = revFind(id);
  if (!can('actions') || !s) return;
  if (s.settled === true && s.paidRunId) { alert('That session was paid in a payroll run and cannot be deleted.'); return; }
  if (!confirm(`Delete this session for ${s.workerName}? Use this for test sessions or mistakes. It cannot be undone.`)) return;
  try {
    const batch = db.batch();
    batch.delete(db.collection(CLK_COLL).doc(id));
    if (s.status === 'open') {
      const ptr = await db.collection('clockState').doc(s.workerUid).get();
      if (ptr.exists && ptr.data().sessionId === id) batch.delete(db.collection('clockState').doc(s.workerUid));
    }
    await batch.commit(); toast('Deleted');
  } catch (err) { alert(revWriteError(err)); }
}

// Time Tracking's "Clock Out" on a worker-app session comes here instead of the old timer.
function revOpen(id) {
  const s = revFind(id);
  if (!s) { toast('That session is not loaded. Open Action Items.'); return; }
  if (s.status === 'open' && typeof navigate === 'function') navigate('actions');
  revAdjustAsk(id);
}

// ── Limits ──────────────────────────────────────────────────────────────────────
function revSettingsAsk() {
  if (!can('actions')) return;
  const c = clkCfg();
  openModal('CLOCK LIMITS', `<div style="font-size:12px;color:var(--text2);margin-bottom:10px;line-height:1.6">These apply to every worker's phone and to your checks. Changing them does not change sessions already reviewed.</div>
    <div class="form-grid">
      <div class="form-group"><label>Furthest from the site (km)</label><input type="number" id="f-rev-radius" min="0.1" max="50" step="0.1" value="${c.radiusM / 1000}"></div>
      <div class="form-group"><label>Location accurate to (m)</label><input type="number" id="f-rev-acc" min="20" max="5000" step="10" value="${c.accuracyM}"></div>
      <div class="form-group"><label>Longest session (hours)</label><input type="number" id="f-rev-max" min="4" max="48" step="1" value="${c.maxHours}"></div>
      <div class="form-group"><label>Phone-clock difference (minutes)</label><input type="number" id="f-rev-skew" min="1" max="120" step="1" value="${c.skewMin}"></div>
    </div>
    <div class="form-actions"><button class="topbar-btn" onclick="revSettingsSave()">SAVE</button><button class="topbar-btn secondary" onclick="closeModalDirect()">CANCEL</button></div>`);
}
async function revSettingsSave() {
  if (!can('actions')) return;
  const n = id => Number((document.getElementById(id) || {}).value);
  const doc = { radiusM: Math.round(n('f-rev-radius') * 1000), accuracyM: Math.round(n('f-rev-acc')), maxHours: Math.round(n('f-rev-max')), skewMin: Math.round(n('f-rev-skew')) };
  const bad = (v, lo, hi) => !Number.isFinite(v) || v < lo || v > hi;
  if (bad(doc.radiusM, 100, 50000)) { alert('The distance must be between 0.1 and 50 km.'); return; }
  if (bad(doc.accuracyM, 20, 5000)) { alert('The accuracy must be between 20 and 5000 m.'); return; }
  if (bad(doc.maxHours, 4, 48)) { alert('The longest session must be between 4 and 48 hours.'); return; }
  if (bad(doc.skewMin, 1, 120)) { alert('The clock difference must be between 1 and 120 minutes.'); return; }
  doc.updatedAt = new Date().toISOString(); doc.updatedBy = currentProfile.email;
  try { await db.collection('settings').doc(CLK_SETTINGS_DOC).set(doc); closeModalDirect(); toast('Limits saved ✓'); }
  catch (err) { alert(revWriteError(err)); }
}
