// ══════════════════════════════════════════════════════
// ASSIGNMENTS — round 2: send a job (a ticket on the Jobs page) to one or more people.
// Own assignments.js file (own <script> tag), loaded AFTER worker.js and BEFORE sync.js.
// core.js carries only small guarded hooks (a "Workers" button and a status line per ticket).
//
// DATA — one document per person per job at assignments/{jobKey}_{uid}:
//   jobKey (stable id stored on the ticket; ticket ids like TKT-003 can repeat after a delete),
//   jobId, jobTask, projectId, projectName, due        snapshots, so the card reads right even if the ticket is deleted
//   workerUid, workerCrewId, workerName                  who it is for (crewId is the crew id as TEXT)
//   siteLabel, siteLat, siteLng, siteCheck               the site point; siteCheck=false means "no site check"
//   status 'assigned' | 'accepted' | 'declined', respondedAt/By/Via, declineReason, note, createdAt, createdBy
//
// WHO MAY DO WHAT is decided by firestore.rules, not here: owners write everything; the assigned
// person reads only their own and may only answer it (assigned -> accepted/declined, as themselves).
//
// Owners can work jobs too: an owner whose profile is linked to their crew record (platform admin
// does that on the Users screen) appears in the people list and gets their own My Jobs.
// ══════════════════════════════════════════════════════

const ASG_COLL = 'assignments';
const ASG_DEFAULT_CENTER = [-25.7479, 28.2293];   // map starting point only (Pretoria)

let asgAll = [];            // owner: every assignment, live
let asgMine = [];           // this login's own assignments, live
let asgMineReady = false;   // first snapshot has arrived
let asgMineError = '';
let asgUnsubs = [];
let asgStarted = null;      // 'owner' | 'worker'
let asgSend = null;         // the open "Send to workers" form: {sig, ref, hadCoords}
let asgMap = null;
let asgMapMarker = null;

// ── Pure helpers ────────────────────────────────────────────────────────────────
// Accepts "-25.7479, 28.2293", "-25.7479 28.2293" and Google Maps links (@lat,lng / q=lat,lng /
// !3dlat!4dlng). Comma decimals ("-25,7479") are refused: they cannot be told apart from a list.
function asgParseCoords(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s || s.length > 600) return null;
  const NUM = '-?\\d{1,3}(?:\\.\\d+)?';
  const patterns = [
    new RegExp(`!3d(${NUM})!4d(${NUM})`),
    new RegExp(`@(${NUM}),(${NUM})`),
    new RegExp(`[?&](?:q|ll|query|center|destination)=(${NUM})(?:,|%2C)(${NUM})`, 'i'),
    new RegExp(`^(${NUM})\\s*[,;\\s]\\s*(${NUM})$`),
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (!m) continue;
    const lat = Number(m[1]), lng = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
  }
  return null;
}
function asgFmtCoords(p) { return `${Number(p.lat).toFixed(6)}, ${Number(p.lng).toFixed(6)}`; }
// A typo can still be a valid point. Anything outside South Africa gets a warning, not a refusal.
function asgOutsideSA(p) { return p.lat < -35.5 || p.lat > -21.5 || p.lng < 15.5 || p.lng > 33.5; }
function asgMapsUrl(p) { return `https://www.google.com/maps?q=${p.lat},${p.lng}`; }
function asgDirectionsUrl(p) { return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`; }
function asgNewKey() { return 'J' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function asgDocId(jobKey, uid) { return `${jobKey}_${uid}`; }
function asgDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return '';
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1];
  return mon ? `${Number(m[3])} ${mon} ${m[1]}` : '';
}
function asgOwnUid() {
  try { return (firebase.auth().currentUser || {}).uid || ''; } catch (e) { return ''; }
}

// The ticket's site: ticket -> project -> client -> property. Returns the label, the property's
// GPS text and a reference used to remember a newly set point on that property.
function asgResolveSite(ticket) {
  const out = { label: '', coordsText: '', ref: null };
  if (!ticket) return out;
  const project = (store.projects || []).find(p => p.id === ticket.project);
  if (!project) return out;
  const client = (store.clients || []).find(c => c.name === project.client);
  const props = client && typeof getClientProperties === 'function' ? getClientProperties(client) : [];
  let prop = project.propertyId ? props.find(p => p.id === project.propertyId) : null;
  if (!prop && !project.propertyId && props.length === 1) prop = props[0];
  out.label = (prop && (prop.siteAddress || prop.siteName)) || project.propertyLabel || project.name || '';
  if (prop) { out.coordsText = prop.gpsCoords || ''; out.ref = { client, prop, legacy: prop.id === 'legacy' }; }
  return out;
}
// Legacy clients keep GPS on the client itself; getClientProperties hands out a COPY for those.
function asgRememberPoint(ref, p) {
  const text = asgFmtCoords(p);
  if (ref.legacy) ref.client.gpsCoords = text; else ref.prop.gpsCoords = text;
}

// Active worker logins and active owner logins that are linked to a crew record.
function asgPeople() {
  const users = typeof rlUsers !== 'undefined' ? rlUsers : [];
  const crew = store.crew || [];
  const people = [], unlinked = [];
  users.forEach(u => {
    if (u.active !== true || (u.role !== 'worker' && u.role !== 'owner')) return;
    const key = u.crewId == null ? '' : String(u.crewId);
    if (!key) { if (u.role === 'owner') unlinked.push(u); return; }
    const c = crew.find(x => wkCrewKey(x) === key);
    people.push({ uid: u.uid, crewId: key, name: (c && c.name) || u.name || u.email, role: u.role, crew: c || null });
  });
  return { people, unlinked };
}

function asgForTicket(t) { return t && t.jobKey ? asgAll.filter(a => a.jobKey === t.jobKey) : []; }

// One document per person. Truncations match the limits in firestore.rules.
function asgBuildDocs(ticket, people, o) {
  return people.map(p => {
    const d = {
      jobKey: ticket.jobKey,
      jobId: String(ticket.id || '').slice(0, 40),
      jobTask: String(ticket.task || '').slice(0, 200),
      workerUid: p.uid,
      workerCrewId: p.crewId,
      workerName: String(p.name || '').slice(0, 120),
      siteCheck: !!o.siteCheck,
      status: 'assigned',
      createdAt: o.now,
      createdBy: o.by,
    };
    if (ticket.project) d.projectId = String(ticket.project).slice(0, 40);
    if (o.projectName) d.projectName = String(o.projectName).slice(0, 200);
    if (typeof ticket.due === 'string' && ticket.due) d.due = ticket.due.slice(0, 20);
    if (o.siteLabel) d.siteLabel = String(o.siteLabel).slice(0, 300);
    if (o.siteCheck && o.point) { d.siteLat = o.point.lat; d.siteLng = o.point.lng; }
    if (o.note) d.note = String(o.note).slice(0, 500);
    return d;
  });
}

function asgStatusText(a) {
  if (a.status === 'accepted') return a.respondedVia === 'owner' ? 'Accepted (by owner)' : 'Accepted';
  if (a.status === 'declined') return 'Declined';
  return 'Waiting';
}
function asgStatusColor(a) { return a.status === 'accepted' ? 'var(--green)' : a.status === 'declined' ? 'var(--red)' : 'var(--accent)'; }

// The worker's cell number for the WhatsApp button: their crew record's phone, or (worker logins)
// the number their login was made from.
function asgCellFor(a) {
  const c = (store.crew || []).find(x => wkCrewKey(x) === String(a.workerCrewId));
  const fromCrew = c ? wkNormCell(c.phone) : null;
  if (fromCrew) return fromCrew;
  const u = (typeof rlUsers !== 'undefined' ? rlUsers : []).find(x => x.uid === a.workerUid);
  const p = u ? wkParseLoginEmail(u.email) : null;
  return p ? p.cell : null;
}
function asgWhatsAppUrl(a, appUrl) {
  const cell = asgCellFor(a);
  if (!cell) return null;
  const lines = [
    `Hi ${String(a.workerName || '').split(' ')[0] || 'there'}, you have a new job from Otto's Renovation & Beautification:`,
    `${a.jobTask}${a.projectName ? ' (' + a.projectName + ')' : ''}`,
  ];
  if (a.siteLabel) lines.push(`Site: ${a.siteLabel}`);
  if (a.due) lines.push(`Due: ${asgDate(a.due)}`);
  lines.push(`Open the app, sign in with your cell number and accept it: ${appUrl}`);
  return `https://wa.me/27${cell.slice(1)}?text=${encodeURIComponent(lines.join('\n'))}`;
}

// ── Owner: status line and button on the Jobs page ──────────────────────────────
function asgTicketBadge(t) {
  const list = asgForTicket(t);
  if (!list.length) return '';
  const n = s => list.filter(a => a.status === s).length;
  const onSite = window.clkOnSiteCount ? clkOnSiteCount(t) : 0;
  const parts = [[onSite, 'on site'], [n('accepted'), 'accepted'], [n('assigned'), 'waiting'], [n('declined'), 'declined']].filter(x => x[0]).map(x => `${x[0]} ${x[1]}`);
  return `<div style="font-family:var(--fm);font-size:10px;color:var(--text3);margin-top:3px">👷 ${parts.join(' · ')}</div>`;
}
function asgOpenTicket(i) {
  const t = store.jobs[i];
  if (!t) return;
  if (asgForTicket(t).length) showTicketWorkers(i); else showSendToWorkers(i);
}
// The ticket is found again by what it is (not by list position) because another device's
// changes can reorder the list while a form is open.
function asgSig(t) { return `${t.id}|${t.task}|${t.project}`; }
function asgFindTicket(sig) { return (store.jobs || []).find(t => asgSig(t) === sig) || null; }

// ── Owner: Send to workers ──────────────────────────────────────────────────────
async function showSendToWorkers(i) {
  if (!can('jobs')) { toast('Only owners can send jobs to workers'); return; }
  const ticket = store.jobs[i];
  if (!ticket) return;
  try { rlUsers = await rlLoadUsers(); }
  catch (err) { alert('Could not load the people list (' + ((err && err.code) || (err && err.message)) + ').'); return; }
  const { people, unlinked } = asgPeople();
  const have = new Map(asgForTicket(ticket).map(a => [a.workerUid, a]));
  const site = asgResolveSite(ticket);
  const parsed = asgParseCoords(site.coordsText);
  asgSend = { sig: asgSig(ticket), ref: site.ref, hadCoords: !!parsed };

  const rows = people.length ? people.map(p => {
    const a = have.get(p.uid);
    return `<label style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);${a ? 'opacity:.55' : ''}">
      <input type="checkbox" name="asg-person" value="${wkEsc(p.uid)}" ${a ? 'disabled' : ''}>
      <span style="flex:1">${wkEsc(p.name)} <span style="font-size:10px;color:var(--text3)">${p.role === 'owner' ? 'owner' : 'worker'}</span></span>
      ${a ? `<span style="font-size:10px;color:var(--text3)">${wkEsc(asgStatusText(a))}</span>` : ''}</label>`;
  }).join('') : '<div style="padding:8px 0;color:var(--text3);font-size:12px">Nobody can receive jobs yet. Add worker logins on the Users screen.</div>';
  const hint = unlinked.length
    ? `<div style="font-size:11px;color:var(--text3);margin-top:8px">To send a job to yourself, link your login to your crew record on the Users screen (platform admin): ${wkEsc(unlinked.map(u => u.name || u.email).join(', '))}.</div>`
    : '';
  const projectName = ((store.projects || []).find(p => p.id === ticket.project) || {}).name || '';

  openModal('SEND TO WORKERS', `<div style="font-size:13px;margin-bottom:12px"><strong>${wkEsc(ticket.task)}</strong>${projectName ? ` <span style="color:var(--text3)">· ${wkEsc(projectName)}</span>` : ''}</div>
    <div class="form-grid">
      <div class="form-group full"><label>Who is it for?</label><div>${rows}</div>${hint}</div>
      <div class="form-group full"><label>Site name or address</label><input type="text" id="f-asg-label" value="${wkEsc(site.label)}" maxlength="300"></div>
      <div class="form-group full"><label style="display:flex;gap:8px;align-items:center;text-transform:none"><input type="checkbox" id="f-asg-check" checked onchange="asgToggleCheck()"> Check clock-ins against the site (flag anything over 3 km away)</label></div>
      <div id="asg-site-box" class="form-group full">
        <label>Site point (coordinates, or paste a Google Maps link)</label>
        <input type="text" id="f-asg-coords" value="${wkEsc(parsed ? asgFmtCoords(parsed) : site.coordsText)}" oninput="asgCoordsChanged()" placeholder="-25.7479, 28.2293" autocomplete="off">
        <div id="asg-coords-status" style="font-size:11px;margin-top:6px;color:var(--text3)"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <button type="button" class="action-btn" onclick="asgUseMyLocation()">📍 Use my location</button>
          <button type="button" class="action-btn" onclick="asgFindAddress()">🔎 Find from address</button>
          <button type="button" class="action-btn" onclick="asgPickOnMap()">🗺 Pick on map</button>
          <a class="action-btn" id="asg-open-maps" href="#" target="_blank" rel="noopener" style="text-decoration:none;display:none">Check in Maps</a>
        </div>
        <div id="asg-map-wrap" style="display:none;margin-top:10px"><div id="asg-map" style="height:260px;border:1px solid var(--border)"></div></div>
        ${site.ref ? `<label style="display:flex;gap:8px;align-items:center;text-transform:none;margin-top:10px"><input type="checkbox" id="f-asg-save" ${parsed ? '' : 'checked'}> Remember this point on the client's property</label>` : ''}
      </div>
      <div class="form-group full"><label>Note for the worker <span style="color:var(--text3);font-weight:400;text-transform:none">optional</span></label><textarea id="f-asg-note" rows="2" maxlength="500"></textarea></div>
    </div>
    <div class="form-actions"><button class="topbar-btn" onclick="asgSendConfirm()">SEND</button><button class="topbar-btn secondary" onclick="closeModalDirect()">CANCEL</button></div>`);
  asgCoordsChanged();
}

function asgToggleCheck() {
  const on = document.getElementById('f-asg-check').checked;
  const box = document.getElementById('asg-site-box');
  if (box) box.style.display = on ? '' : 'none';
}

function asgCoordsChanged() {
  const input = document.getElementById('f-asg-coords');
  const status = document.getElementById('asg-coords-status');
  const link = document.getElementById('asg-open-maps');
  if (!input || !status) return;
  const p = asgParseCoords(input.value);
  if (link) { link.style.display = p ? '' : 'none'; if (p) link.href = asgMapsUrl(p); }
  if (!input.value.trim()) { status.style.color = 'var(--text3)'; status.textContent = 'No point yet.'; return; }
  if (!p) { status.style.color = 'var(--red)'; status.textContent = 'Not a recognised point. Use "-25.7479, 28.2293" or paste a Google Maps link.'; return; }
  if (asgOutsideSA(p)) { status.style.color = 'var(--red)'; status.textContent = `${asgFmtCoords(p)} is outside South Africa. Check it before sending.`; return; }
  status.style.color = 'var(--green)'; status.textContent = `✓ ${asgFmtCoords(p)}`;
}

function asgSetCoords(p, extra) {
  const input = document.getElementById('f-asg-coords');
  if (!input) return;
  input.value = asgFmtCoords(p);
  asgCoordsChanged();
  const status = document.getElementById('asg-coords-status');
  if (status && extra) status.textContent += ' ' + extra;
}

function asgUseMyLocation() {
  const status = document.getElementById('asg-coords-status');
  if (!navigator.geolocation) { toast('This device cannot share its location'); return; }
  if (status) { status.style.color = 'var(--text3)'; status.textContent = 'Getting your location…'; }
  navigator.geolocation.getCurrentPosition(pos => {
    const acc = Math.round(pos.coords.accuracy || 0);
    asgSetCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude },
      acc > 500 ? `Accuracy is only about ±${acc} m. Go outside and try again.` : (acc ? `(±${acc} m)` : ''));
  }, err => {
    const msg = err && err.code === 1 ? 'Location is switched off for this site. Allow it in the browser settings.'
      : err && err.code === 3 ? 'Timed out. Go outside and try again.' : 'Could not get your location.';
    if (status) { status.style.color = 'var(--red)'; status.textContent = msg; }
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}

async function asgFindAddress() {
  const label = (document.getElementById('f-asg-label') || {}).value || '';
  const status = document.getElementById('asg-coords-status');
  if (label.trim().length < 5) { if (status) { status.style.color = 'var(--red)'; status.textContent = 'Type the site address above first.'; } return; }
  if (status) { status.style.color = 'var(--text3)'; status.textContent = 'Looking up the address…'; }
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=za&q=${encodeURIComponent(label.trim())}`, { headers: { 'Accept-Language': 'en' } });
    const list = await r.json();
    const hit = Array.isArray(list) ? list[0] : null;
    const p = hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) {
      if (status) { status.style.color = 'var(--red)'; status.textContent = 'Address not found. Add the suburb or town, or pick the spot on the map.'; }
      return;
    }
    asgSetCoords(p, '(from the address. Check it in Maps before sending.)');
  } catch (err) {
    if (status) { status.style.color = 'var(--red)'; status.textContent = 'Address lookup failed. Check your connection, or pick the spot on the map.'; }
  }
}

function asgPickOnMap() {
  const wrap = document.getElementById('asg-map-wrap');
  const status = document.getElementById('asg-coords-status');
  if (!wrap) return;
  wrap.style.display = 'block';
  if (typeof ttLoadLeaflet !== 'function') { toast('Map is not available'); return; }
  ttLoadLeaflet().then(() => {
    setTimeout(() => {
      if (typeof L === 'undefined' || !document.getElementById('asg-map')) return;
      if (asgMap) { try { asgMap.remove(); } catch (e) { /* the old map's element is already gone */ } }
      const cur = asgParseCoords((document.getElementById('f-asg-coords') || {}).value);
      asgMap = L.map('asg-map').setView(cur ? [cur.lat, cur.lng] : ASG_DEFAULT_CENTER, cur ? 17 : 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 }).addTo(asgMap);
      asgMapMarker = cur ? L.marker([cur.lat, cur.lng]).addTo(asgMap) : null;
      asgMap.on('click', e => {
        if (asgMapMarker) asgMap.removeLayer(asgMapMarker);
        asgMapMarker = L.marker([e.latlng.lat, e.latlng.lng]).addTo(asgMap);
        asgSetCoords({ lat: e.latlng.lat, lng: e.latlng.lng });
      });
    }, 50);
  }).catch(() => { if (status) { status.style.color = 'var(--red)'; status.textContent = 'The map could not load. Check your connection, or paste the coordinates.'; } });
}

async function asgSendConfirm() {
  if (!can('jobs') || !asgSend) return;
  const ticket = asgFindTicket(asgSend.sig);
  if (!ticket) { alert('That job is no longer on the list.'); return; }
  const v = id => (document.getElementById(id) || {}).value || '';
  const picked = [...document.querySelectorAll('input[name="asg-person"]:checked')].map(x => x.value);
  if (!picked.length) { alert('Choose at least one person'); return; }
  const siteCheck = !!(document.getElementById('f-asg-check') || {}).checked;
  let point = null;
  if (siteCheck) {
    point = asgParseCoords(v('f-asg-coords'));
    if (!point) { alert('Add the site point first, or switch the site check off for this job.'); return; }
    if (asgOutsideSA(point) && !confirm('That point is outside South Africa. Send anyway?')) return;
  }
  const taken = new Set(asgForTicket(ticket).map(a => a.workerUid));
  const chosen = asgPeople().people.filter(p => picked.indexOf(p.uid) !== -1 && !taken.has(p.uid));
  if (!chosen.length) { alert('Everyone you picked already has this job.'); return; }

  if (!ticket.jobKey) { ticket.jobKey = asgNewKey(); save(); }
  const projectName = ((store.projects || []).find(p => p.id === ticket.project) || {}).name || '';
  const docs = asgBuildDocs(ticket, chosen, {
    siteCheck, point, siteLabel: v('f-asg-label').trim(), note: v('f-asg-note').trim(),
    projectName, now: new Date().toISOString(), by: currentProfile.email,
  });
  const results = await Promise.allSettled(docs.map(d => db.collection(ASG_COLL).doc(asgDocId(d.jobKey, d.workerUid)).set(d)));
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length === results.length) {
    const e = failed[0].reason;
    alert('Nothing was sent (' + ((e && e.code) || (e && e.message) || 'unknown error') + '). Check your connection and try again.');
    return;
  }
  if (siteCheck && point && asgSend.ref && (document.getElementById('f-asg-save') || {}).checked) { asgRememberPoint(asgSend.ref, point); save(); }
  const idx = store.jobs.indexOf(ticket);
  closeModalDirect();
  if (failed.length) alert(`Sent to ${results.length - failed.length} of ${results.length}. The rest failed: open the job's workers list and send again.`);
  else toast(`Sent to ${results.length} ${results.length === 1 ? 'person' : 'people'} ✓`);
  if (typeof renderPage === 'function') renderPage(currentPage);
  if (idx !== -1) showTicketWorkers(idx);
}

// ── Owner: who has this job ─────────────────────────────────────────────────────
function asgTicketWorkersHtml(ticket) {
  const list = asgForTicket(ticket).slice().sort((a, b) => String(a.workerName).localeCompare(String(b.workerName)));
  if (!list.length) return '<div style="padding:10px 0;color:var(--text3);font-size:12px">Nobody has this job yet.</div>';
  return list.map(a => {
    const id = rlJs(a.id || asgDocId(a.jobKey, a.workerUid));
    const wa = asgWhatsAppUrl(a, location.origin + location.pathname);
    const when = a.respondedAt ? ` · ${wkEsc(asgDate(a.respondedAt))}` : '';
    const btns = [
      a.status === 'assigned' ? `<button class="action-btn" onclick="asgAcceptFor(${id})">Accept for them</button>` : '',
      a.status === 'declined' ? `<button class="action-btn" onclick="asgAskAgain(${id})">Ask again</button>` : '',
      wa && a.status !== 'declined' ? `<a class="action-btn" href="${wkEsc(wa)}" target="_blank" rel="noopener" style="text-decoration:none">WhatsApp</a>` : '',
      `<button class="action-btn danger" onclick="asgCancel(${id})">Cancel</button>`,
    ].join(' ');
    return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;gap:10px"><strong>${wkEsc(a.workerName)}</strong>
        <span style="font-family:var(--fm);font-size:10px;color:${asgStatusColor(a)}">${wkEsc(asgStatusText(a))}${when}</span></div>
      ${window.clkOwnerLine ? clkOwnerLine(a) : ''}
      ${a.status === 'declined' && a.declineReason ? `<div style="font-size:12px;color:var(--text2);margin-top:4px">“${wkEsc(a.declineReason)}”</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${btns}</div></div>`;
  }).join('');
}

function showTicketWorkers(i) {
  const t = store.jobs[i];
  if (!t) return;
  openModal('WORKERS ON THIS JOB', `<div style="font-size:13px;margin-bottom:6px"><strong>${wkEsc(t.task)}</strong></div>
    <div id="asg-tw-body" data-sig="${wkEsc(asgSig(t))}">${asgTicketWorkersHtml(t)}</div>
    <div class="form-actions"><button class="topbar-btn" onclick="closeModalDirect();showSendToWorkers(${i})">+ SEND TO MORE PEOPLE</button><button class="topbar-btn secondary" onclick="closeModalDirect()">CLOSE</button></div>`);
}
function asgRefreshTicketWorkers() {
  const body = document.getElementById('asg-tw-body');
  if (!body) return;
  const t = asgFindTicket(body.getAttribute('data-sig'));
  if (t) body.innerHTML = asgTicketWorkersHtml(t);
}
function asgFind(id) { return asgAll.find(a => a.id === id) || asgMine.find(a => a.id === id) || null; }
function asgWriteError(err) {
  return 'That did not save (' + ((err && err.code) || (err && err.message) || 'unknown error') + '). Check your connection and try again.';
}

async function asgAcceptFor(id) {
  const a = asgFind(id);
  if (!can('jobs') || !a || a.status !== 'assigned') return;
  const self = a.workerUid === asgOwnUid();
  if (!self && !confirm(`Accept this job for ${a.workerName}? Only do this if they agreed with you.`)) return;
  try {
    await db.collection(ASG_COLL).doc(id).update({ status: 'accepted', respondedAt: new Date().toISOString(), respondedBy: currentProfile.email, respondedVia: self ? 'self' : 'owner' });
  } catch (err) { alert(asgWriteError(err)); }
}
async function asgAskAgain(id) {
  const a = asgFind(id);
  if (!can('jobs') || !a || a.status !== 'declined') return;
  const del = firebase.firestore.FieldValue.delete();
  try {
    await db.collection(ASG_COLL).doc(id).update({ status: 'assigned', respondedAt: del, respondedBy: del, respondedVia: del, declineReason: del });
  } catch (err) { alert(asgWriteError(err)); }
}
async function asgCancel(id) {
  const a = asgFind(id);
  if (!can('jobs') || !a) return;
  if (!confirm(`Take this job away from ${a.workerName}?`)) return;
  try { await db.collection(ASG_COLL).doc(id).delete(); } catch (err) { alert(asgWriteError(err)); }
}

// ── The person it is for: My Jobs ───────────────────────────────────────────────
function asgCardHtml(a) {
  const id = rlJs(a.id);
  const p = a.siteCheck && typeof a.siteLat === 'number' && typeof a.siteLng === 'number' ? { lat: a.siteLat, lng: a.siteLng } : null;
  const site = a.siteLabel || p
    ? `<div style="font-size:12px;color:var(--text2);margin-top:6px">📍 ${wkEsc(a.siteLabel || 'Site')}${p ? ` · <a href="${wkEsc(asgDirectionsUrl(p))}" target="_blank" rel="noopener" style="color:var(--accent)">Directions</a>` : ''}</div>` : '';
  const actions = a.status === 'assigned'
    ? `<div style="display:flex;gap:10px;margin-top:12px"><button class="topbar-btn" onclick="asgAccept(${id})">ACCEPT</button><button class="topbar-btn secondary" onclick="asgDeclineAsk(${id})">DECLINE</button></div>`
    : a.status === 'accepted'
      ? (window.clkCardAction ? clkCardAction(a) : '')
      : `<div style="font-size:11px;color:var(--text3);margin-top:10px">You declined this job${a.declineReason ? ': “' + wkEsc(a.declineReason) + '”' : ''}.</div>`;
  return `<div class="card-item" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
      <div style="font-size:15px;font-weight:600">${wkEsc(a.jobTask)}</div>
      <span style="font-family:var(--fm);font-size:10px;color:${asgStatusColor(a)};white-space:nowrap">${wkEsc(asgStatusText(a))}</span></div>
    ${a.projectName ? `<div style="font-size:12px;color:var(--text3);margin-top:2px">${wkEsc(a.projectName)}</div>` : ''}
    ${a.due ? `<div style="font-family:var(--fm);font-size:11px;color:var(--text2);margin-top:6px">Due ${wkEsc(asgDate(a.due))}</div>` : ''}
    ${site}
    ${a.note ? `<div style="font-size:12px;line-height:1.5;margin-top:8px;padding:8px 10px;background:var(--surface2)">${wkEsc(a.note)}</div>` : ''}
    ${actions}</div>`;
}

function asgMyJobsHtml() {
  // The clock banner comes first and is shown in EVERY state: someone who is clocked in must always be able
  // to clock out, even while the job list is loading, failed to load, or the job itself was cancelled.
  const banner = window.clkBannerHtml ? clkBannerHtml() : '';
  if (asgMineError) return banner + `<div style="font-size:13px;color:var(--red);line-height:1.6;margin-top:10px">Your jobs could not be loaded (${wkEsc(asgMineError)}). Check your connection and reopen the app.</div>`;
  if (!asgMineReady) return banner + '<div style="font-size:13px;color:var(--text3);margin-top:10px">Loading your jobs…</div>';
  const hours = window.clkHoursHtml ? clkHoursHtml() : '';
  const byDue = (a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  const waiting = asgMine.filter(a => a.status === 'assigned').sort(byDue);
  const accepted = asgMine.filter(a => a.status === 'accepted').sort(byDue);
  const declined = asgMine.filter(a => a.status === 'declined').sort((a, b) => String(b.respondedAt || '').localeCompare(String(a.respondedAt || ''))).slice(0, 5);
  if (!waiting.length && !accepted.length && !declined.length) return banner + '<div style="font-size:13px;color:var(--text3);line-height:1.6;margin-top:10px">Nothing is assigned to you right now. When an owner sends you a job it appears here.</div>' + hours;
  const section = (title, arr) => arr.length ? `<div style="font-family:var(--fm);font-size:10px;letter-spacing:2px;color:var(--text3);text-transform:uppercase;margin:18px 0 8px">${title} (${arr.length})</div>${arr.map(asgCardHtml).join('')}` : '';
  return banner + section('Waiting for your answer', waiting) + section('Accepted', accepted) + section('Declined', declined) + hours;
}

async function asgAccept(id) {
  const a = asgMine.find(x => x.id === id);
  if (!a || a.status !== 'assigned') return;
  try {
    await db.collection(ASG_COLL).doc(id).update({ status: 'accepted', respondedAt: new Date().toISOString(), respondedBy: currentProfile.email, respondedVia: 'self' });
  } catch (err) { alert(asgWriteError(err)); }
}
function asgDeclineAsk(id) {
  const a = asgMine.find(x => x.id === id);
  if (!a || a.status !== 'assigned') return;
  openModal('DECLINE THIS JOB', `<div style="font-size:13px;margin-bottom:10px"><strong>${wkEsc(a.jobTask)}</strong></div>
    <div class="form-group full"><label>Why can you not do it? (the owner will see this)</label><textarea id="f-asg-reason" rows="3" maxlength="200"></textarea></div>
    <div class="form-actions"><button class="topbar-btn" onclick="asgDeclineSend(${rlJs(id)})">DECLINE JOB</button><button class="topbar-btn secondary" onclick="closeModalDirect()">BACK</button></div>`);
}
async function asgDeclineSend(id) {
  const a = asgMine.find(x => x.id === id);
  const reason = ((document.getElementById('f-asg-reason') || {}).value || '').trim();
  if (!a || a.status !== 'assigned') return;
  if (reason.length < 3) { alert('Please say why, in a few words.'); return; }
  try {
    await db.collection(ASG_COLL).doc(id).update({ status: 'declined', respondedAt: new Date().toISOString(), respondedBy: currentProfile.email, respondedVia: 'self', declineReason: reason.slice(0, 200) });
    closeModalDirect();
  } catch (err) { alert(asgWriteError(err)); }
}

// ── Live data ───────────────────────────────────────────────────────────────────
function asgDiag(err) { if (typeof syncDiagError === 'function') syncDiagError(ASG_COLL, err); }

function asgStopSync() {
  asgUnsubs.forEach(u => { try { u(); } catch (e) { /* already closed */ } });
  asgUnsubs = []; asgAll = []; asgMine = []; asgMineReady = false; asgMineError = ''; asgStarted = null;
}

// A worker listens to ONLY their own documents; the rules refuse anything wider.
function asgStartWorkerSync() {
  if (asgStarted === 'worker') return;
  asgStopSync(); asgStarted = 'worker';
  const uid = asgOwnUid();
  if (!uid) { updateSyncIndicator('offline'); return; }
  asgUnsubs.push(db.collection(ASG_COLL).where('workerUid', '==', uid).onSnapshot({ includeMetadataChanges: true }, qs => {
    asgMine = qs.docs.map(d => Object.assign({ id: d.id }, d.data()));
    asgMineReady = true; asgMineError = '';
    updateSyncIndicator(qs.metadata.fromCache ? 'offline' : 'synced');
    if (currentPage === 'myjobs') renderMyJobs();
  }, err => {
    asgMineError = (err && err.code) || (err && err.message) || 'unknown error';
    asgDiag(err); updateSyncIndicator('offline');
    if (currentPage === 'myjobs') renderMyJobs();
  }));
}

function asgStartOwnerSync() {
  if (asgStarted === 'owner') return;
  asgStopSync(); asgStarted = 'owner';
  asgUnsubs.push(db.collection(ASG_COLL).onSnapshot(qs => {
    asgAll = qs.docs.map(d => Object.assign({ id: d.id }, d.data()));
    const me = asgOwnUid();
    asgMine = asgAll.filter(a => a.workerUid === me);
    asgMineReady = true; asgMineError = '';
    if (currentPage === 'jobs' && typeof renderPage === 'function') renderPage('jobs');
    if (currentPage === 'myjobs') renderMyJobs();
    asgRefreshTicketWorkers();
  }, err => { asgDiag(err); }));
}

// ── Users screen: link an owner login to their crew record (platform admin only) ──
function asgLinkSuffix(u) {
  if (!u || u.role === 'worker' || u.crewId == null || u.crewId === '') return '';
  const c = (store.crew || []).find(x => wkCrewKey(x) === String(u.crewId));
  return ` · Crew: ${c ? c.name : 'record ' + u.crewId}`;
}
function asgLinkButton(u) {
  if (!currentProfile || currentProfile.platformAdmin !== true || u.role === 'worker' || u.active !== true) return '';
  return `<button class="action-btn" onclick="showLinkCrew(${rlJs(u.uid)})">${u.crewId ? 'Change crew link' : 'Link crew record'}</button>`;
}
function showLinkCrew(uid) {
  if (!currentProfile || currentProfile.platformAdmin !== true) { toast('Only the platform admin can link crew records'); return; }
  const u = rlUsers.find(x => x.uid === uid);
  if (!u || u.role === 'worker') return;
  const linked = new Set(rlUsers.filter(x => x.uid !== uid && x.active === true && x.crewId != null && x.crewId !== '').map(x => String(x.crewId)));
  const options = (store.crew || []).map(c => ({ c, key: wkCrewKey(c) })).filter(x => x.key && !linked.has(x.key))
    .map(x => `<option value="${wkEsc(x.key)}" ${String(u.crewId) === x.key ? 'selected' : ''}>${wkEsc(x.c.name)}${x.c.role ? ' · ' + wkEsc(x.c.role) : ''}</option>`).join('');
  if (!options) { alert('There is no free crew record to link.'); return; }
  openModal('LINK CREW RECORD', `<div style="font-size:13px;margin-bottom:10px">${wkEsc(u.name || u.email)} will receive jobs as this crew member and get their own My Jobs page.</div>
    <div class="form-group full"><label>Crew record</label><select id="f-asg-link">${options}</select></div>
    <div class="form-actions"><button class="topbar-btn" onclick="asgSaveLink(${rlJs(uid)})">LINK</button><button class="topbar-btn secondary" onclick="closeModalDirect()">CANCEL</button></div>`);
}
async function asgSaveLink(uid) {
  if (!currentProfile || currentProfile.platformAdmin !== true) return;
  const u = rlUsers.find(x => x.uid === uid);
  const key = (document.getElementById('f-asg-link') || {}).value || '';
  const crew = (store.crew || []).find(c => wkCrewKey(c) === key);
  if (!u || u.role === 'worker' || !crew) { alert('Choose a crew record'); return; }
  const clash = rlUsers.find(x => x.uid !== uid && x.active === true && String(x.crewId) === key);
  if (clash) { alert(`${crew.name} is already linked to ${clash.name || clash.email}.`); return; }
  try {
    await db.collection('users').doc(uid).update({ crewId: key });
    closeModalDirect(); toast('Crew record linked ✓'); renderUsers();
  } catch (err) { alert('Could not link (' + ((err && err.code) || (err && err.message)) + ').'); }
}
