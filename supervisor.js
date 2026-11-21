// supervisor.js — the Supervisor role, round 2 (Nov 2026): a named supervisor on a job, and accepting for a worker.
//
// WHAT A SUPERVISOR IS: a cell-number login (worker.js) who, on the jobs an owner names them on, can see the crew
// and record that a worker agreed to the job. Round 3 adds that job's hours review. Never pay, payslips or banking.
//
// HOW IT FITS:
//  - The owner picks a supervisor when sending a job (assignments.js calls svSendFieldHtml / svPicked) and can
//    change it later from the job's workers list (svTicketLine). The supervisor's id and name are stored on each
//    assignment (supervisorUid, supervisorName) and copied onto each work session by clock.js.
//  - THE FIRESTORE RULES ARE THE BOUNDARY, not this file: a supervisor can read only assignments (and later
//    sessions) carrying their own id, and may only accept (never decline or edit) for a worker on their own job.
//  - An owner may be the named supervisor too: owners can already do everything, so for them it is just a label.
//
// Every name here starts with sv/SV_ and is unique across the app files.

const SV_COLL = 'assignments';
let svCrew = [];            // supervisor: the assignments on jobs they supervise, live (never their own jobs)
let svCrewReady = false;    // first snapshot has arrived
let svCrewError = '';

function svIsSupervisor() { return !!(currentProfile && currentProfile.role === 'supervisor' && currentProfile.active === true); }

// ── Owner: choose and change the supervisor of a job ────────────────────────────────────────────
// Active supervisors and owners (an owner can supervise their own crew).
function svSupervisors() {
  const users = typeof rlUsers !== 'undefined' ? rlUsers : [];
  return users
    .filter(u => u && u.uid && u.active === true && (u.role === 'supervisor' || u.role === 'owner'))
    .map(u => ({ uid: u.uid, name: String(u.name || u.email || ''), role: u.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The supervisor already named on this job (so sending it to more people keeps the same one by default).
function svCurrentUid(ticket) {
  const a = (typeof asgForTicket === 'function' ? asgForTicket(ticket) : []).find(x => x.supervisorUid);
  return a ? a.supervisorUid : '';
}

function svOptionsHtml(selectedUid) {
  return ['<option value="">No supervisor</option>']
    .concat(svSupervisors().map(s => `<option value="${wkEsc(s.uid)}"${s.uid === selectedUid ? ' selected' : ''}>${wkEsc(s.name)} (${s.role})</option>`))
    .join('');
}

// The field shown in the "Send to workers" form; '' when nobody can be a supervisor yet.
function svSendFieldHtml(ticket) {
  if (!svSupervisors().length) return '';
  return `<div class="form-group full"><label>Supervisor <span style="color:var(--text3);font-weight:400;text-transform:none">optional</span></label>
    <select id="f-sv-pick">${svOptionsHtml(svCurrentUid(ticket))}</select>
    <div style="font-size:11px;color:var(--text3);margin-top:6px;line-height:1.5">A supervisor sees who is on this job and can accept it for a worker who agreed by phone. Reviewing hours comes next. They never see pay.</div></div>`;
}

// What the form chose, checked against the live people list, or null for "no supervisor".
function svPicked() {
  const el = document.getElementById('f-sv-pick');
  if (!el || !el.value) return null;
  const s = svSupervisors().find(x => x.uid === el.value);
  return s ? { uid: s.uid, name: s.name } : null;
}

// One line at the top of a job's workers list: who supervises it, with a Change button.
function svTicketLine(ticket) {
  if (!can('jobs') || !ticket) return '';
  const names = [...new Set(asgForTicket(ticket).map(a => a.supervisorName).filter(Boolean))];
  return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">
    <span>Supervisor: <strong>${names.length ? names.map(wkEsc).join(', ') : 'none'}</strong></span>
    <button class="action-btn" onclick="svChangeAsk(${rlJs(asgSig(ticket))})">Change</button></div>`;
}

async function svChangeAsk(sig) {
  if (!can('jobs')) return;
  const ticket = asgFindTicket(sig);
  if (!ticket || !asgForTicket(ticket).length) return;
  try { rlUsers = await rlLoadUsers(); }
  catch (err) { alert('Could not load the people list (' + ((err && err.code) || (err && err.message)) + ').'); return; }
  openModal('SUPERVISOR FOR THIS JOB', `<div style="font-size:13px;margin-bottom:12px"><strong>${wkEsc(ticket.task)}</strong></div>
    <div class="form-group full"><label>Supervisor</label><select id="f-sv-change">${svOptionsHtml(svCurrentUid(ticket))}</select>
    <div style="font-size:11px;color:var(--text3);margin-top:6px;line-height:1.5">Applies to everyone who has this job. Hours already clocked stay with the supervisor named when they clocked in.</div></div>
    <div class="form-actions"><button class="topbar-btn" onclick="svChangeSave(${rlJs(sig)})">SAVE</button><button class="topbar-btn secondary" onclick="closeModalDirect()">CANCEL</button></div>`);
}

async function svChangeSave(sig) {
  if (!can('jobs')) return;
  const ticket = asgFindTicket(sig);
  if (!ticket) { alert('That job is no longer on the list.'); return; }
  const el = document.getElementById('f-sv-change');
  const want = el && el.value ? svSupervisors().find(x => x.uid === el.value) : null;
  if (el && el.value && !want) { alert('Choose a supervisor from the list'); return; }
  const del = firebase.firestore.FieldValue.delete();
  const patch = want ? { supervisorUid: want.uid.slice(0, 128), supervisorName: want.name.slice(0, 120) } : { supervisorUid: del, supervisorName: del };
  const todo = asgForTicket(ticket).filter(a => (a.supervisorUid || '') !== (want ? want.uid : ''));
  if (!todo.length) { closeModalDirect(); return; }
  const results = await Promise.allSettled(todo.map(a => db.collection(SV_COLL).doc(a.id).update(patch)));
  const failed = results.filter(r => r.status === 'rejected');
  const idx = store.jobs.indexOf(ticket);
  closeModalDirect();
  if (failed.length) alert(`Changed ${results.length - failed.length} of ${results.length}. The rest did not save (${(failed[0].reason && failed[0].reason.code) || 'unknown error'}): open the list and change it again.`);
  else toast(want ? `Supervisor: ${want.name} ✓` : 'Supervisor removed ✓');
  if (idx !== -1 && typeof showTicketWorkers === 'function') showTicketWorkers(idx);
}

// ── Supervisor: the crew on my jobs ─────────────────────────────────────────────────────────────
function svStartSync() {
  if (!svIsSupervisor()) return;
  const uid = typeof asgOwnUid === 'function' ? asgOwnUid() : '';
  if (!uid) return;
  svCrew = []; svCrewReady = false; svCrewError = '';
  asgUnsubs.push(db.collection(SV_COLL).where('supervisorUid', '==', uid).onSnapshot({ includeMetadataChanges: false }, qs => {
    // Their own jobs (if the owner also named them as the worker) live in the normal list above, not here.
    svCrew = qs.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(a => a.workerUid !== uid);
    svCrewReady = true; svCrewError = '';
    if (currentPage === 'myjobs' && typeof renderMyJobs === 'function') renderMyJobs();
  }, err => {
    svCrewError = (err && err.code) || (err && err.message) || 'unknown error';
    if (typeof asgDiag === 'function') asgDiag(err);
    if (currentPage === 'myjobs' && typeof renderMyJobs === 'function') renderMyJobs();
  }));
}
function svStopSync() { svCrew = []; svCrewReady = false; svCrewError = ''; }

function svCrewCardHtml(a) {
  const id = rlJs(a.id);
  const via = a.status === 'accepted' && a.respondedVia === 'supervisor' ? ' · by supervisor' : '';
  const action = a.status === 'assigned'
    ? `<div style="display:flex;gap:10px;margin-top:10px"><button class="topbar-btn" onclick="svAcceptFor(${id})">ACCEPT FOR THEM</button></div>`
    : a.status === 'declined' && a.declineReason
      ? `<div style="font-size:12px;color:var(--text2);margin-top:6px">“${wkEsc(a.declineReason)}”</div>` : '';
  return `<div class="card-item" style="margin-bottom:10px">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
      <div style="font-size:14px;font-weight:600">${wkEsc(a.workerName)}</div>
      <span style="font-family:var(--fm);font-size:10px;color:${asgStatusColor(a)};white-space:nowrap">${wkEsc(asgStatusText(a))}${via}</span></div>
    <div style="font-size:12px;color:var(--text2);margin-top:4px">${wkEsc(a.jobTask)}${a.projectName ? ` <span style="color:var(--text3)">· ${wkEsc(a.projectName)}</span>` : ''}</div>
    ${a.due ? `<div style="font-family:var(--fm);font-size:11px;color:var(--text3);margin-top:4px">Due ${wkEsc(asgDate(a.due))}</div>` : ''}
    ${action}</div>`;
}

// The "Crew on my jobs" section of My Jobs; '' for everyone except an active supervisor.
function svCrewHtml() {
  if (!svIsSupervisor()) return '';
  const head = n => `<div style="font-family:var(--fm);font-size:10px;letter-spacing:2px;color:var(--text3);text-transform:uppercase;margin:22px 0 8px">Crew on my jobs${n == null ? '' : ` (${n})`}</div>`;
  if (svCrewError) return head() + `<div style="font-size:13px;color:var(--red);line-height:1.6">The crew list could not be loaded (${wkEsc(svCrewError)}). Check your connection and reopen the app.</div>`;
  if (!svCrewReady) return head() + '<div style="font-size:13px;color:var(--text3)">Loading…</div>';
  if (!svCrew.length) return head(0) + '<div style="font-size:13px;color:var(--text3);line-height:1.6">Nobody is on a job you supervise yet. When an owner names you supervisor on a job, the workers on it appear here.</div>';
  const order = { assigned: 0, accepted: 1, declined: 2 };
  const list = svCrew.slice().sort((a, b) => (order[a.status] - order[b.status]) || String(a.workerName).localeCompare(String(b.workerName)) || String(a.jobTask).localeCompare(String(b.jobTask)));
  return head(list.length) + list.map(svCrewCardHtml).join('');
}

// Record that a worker on THEIR job agreed. The rules allow exactly this write and nothing wider.
async function svAcceptFor(id) {
  const a = svCrew.find(x => x.id === id);
  if (!svIsSupervisor() || !a || a.status !== 'assigned' || a.workerUid === asgOwnUid()) return;
  if (!confirm(`Accept “${a.jobTask}” for ${a.workerName}? Only do this if they agreed with you.`)) return;
  try {
    await db.collection(SV_COLL).doc(id).update({ status: 'accepted', respondedAt: new Date().toISOString(), respondedBy: currentProfile.email, respondedVia: 'supervisor' });
  } catch (err) { alert(asgWriteError(err)); }
}
