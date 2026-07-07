// ══════════════════════════════════════════════════════
// AI FEATURES — Describe Project, Scan Invoice, Blueprint AI
// Split out from the main app script to keep core.js under the
// mobile-performance ceiling. Loads AFTER core.js — relies on
// core.js globals (store, save, toast, fmt, dt, openModal, etc.)
// being already defined in shared script scope.
// ══════════════════════════════════════════════════════

// ── DESCRIBE PROJECT → BOM ──
let describeResult = null;

function renderDescribe() {
  const examples = [
    ['🧱','Boundary Wall','Build a 1.8m high facebrick boundary wall, 30 meters long, with a coping finish on top'],
    ['🔲','Floor Tiling','Tile a 35m² open-plan lounge and dining area with 600x600 porcelain tiles, including grout and adhesive'],
    ['🎨','Painting','Paint the interior of a 3-bedroom house — walls and ceilings — approximately 220m² total surface area, two coats'],
    ['☀️','Solar','Supply and install a 5kW solar system: 10x 550W panels, 5kW hybrid inverter, 10kWh lithium battery, cabling and mounting'],
    ['🚪','Motorized Gate','Manufacture and install a double-leaf motorized sliding gate, 5m wide, 1.8m high galvanized steel, with remote and intercom'],
    ['🏠','Paving','Lay 60m² of 60x60 concrete paving on a prepared base, including sand bedding and edge restraints'],
  ];
  const el = document.getElementById('desc-examples');
  if (el) {
    el.innerHTML = examples.map(([e, l, t]) => {
      const safe = t.replace(/'/g, "\\'");
      return `<div onclick="document.getElementById('desc-text').value='${safe}';document.getElementById('desc-type').value=''" style="display:flex;align-items:center;gap:10px;padding:8px 10px;cursor:pointer;border-radius:2px;transition:background .15s;margin-bottom:4px;" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='transparent'">
        <span style="font-size:18px">${e}</span>
        <div><div style="font-size:12px;font-weight:600;color:var(--text)">${l}</div><div style="font-size:11px;color:var(--text3);margin-top:1px">${t.substring(0,60)}...</div></div>
      </div>`;
    }).join('');
  }
}

async function runDescribe() {
  const text = (document.getElementById('desc-text').value || '').trim();
  if (!text) { toast('Please describe your project first'); return; }

  const btn = document.getElementById('desc-btn');
  btn.disabled = true;
  document.getElementById('desc-shimmer').style.display = 'block';
  btn.textContent = '  GENERATING BOM...';

  const type    = document.getElementById('desc-type').value;
  const region  = document.getElementById('desc-region').value;
  const quality = document.getElementById('desc-quality').value;
  const notes   = (document.getElementById('desc-notes').value || '').trim();

  const qualityNote = { budget:'Use economy/budget materials and standard labour rates', mid:'Use mid-range materials and standard labour rates', premium:'Use premium materials and skilled labour rates' }[quality];

  const currentDateStr = new Date().toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
  const systemPrompt = `You are an expert South African quantity surveyor and construction estimator specialising in residential and light commercial projects. You take plain-language project descriptions and produce detailed, accurate Bills of Materials with realistic South African pricing and real supplier names.

Return ONLY a valid JSON object — no preamble, no markdown fences:
{
  "projectTitle": "Short descriptive title",
  "projectDescription": "One clear paragraph summarising scope",
  "region": "${region}",
  "quality": "${quality}",
  "estimatedDuration": 8,
  "bom": [
    {
      "item": "Exact product name as sold in SA",
      "category": "Concrete",
      "supplier": "Builders Warehouse",
      "alternativeSupplier": "Makro",
      "qty": 120,
      "unit": "Each",
      "unitCost": 8.50,
      "lineTotal": 1020.00,
      "notes": "10% wastage included"
    }
  ],
  "labour": [
    {
      "trade": "Bricklayer",
      "days": 5,
      "workers": 2,
      "ratePerDay": 650,
      "lineTotal": 6500,
      "notes": "Includes foreman"
    }
  ],
  "assumptions": [
    "All materials priced at ${region} rates for ${currentDateStr}",
    "Site is accessible by delivery vehicle"
  ],
  "warnings": []
}

RULES:
- Region: ${region}, South Africa — use current local pricing (${currentDateStr})
- Quality: ${quality} — ${qualityNote}
- Every BOM item must have a real, specific South African supplier (e.g. Builders Warehouse, Makro, Leroy Merlin, Tile City, Cashbuild, Plumblink, Voltex, SolarWorld SA, Radiant, etc.)
- Include alternativeSupplier where available
- Add 10-15% wastage to material quantities
- BOM: 6-20 items covering all materials needed from start to finish
- Labour: 2-6 trade categories with realistic SA day rates
- category must be one of: Concrete, Brickwork, Timber, Roofing, Electrical, Plumbing, Paint, Tiling, Steel, Solar, Gates, Paving, Insulation, Other
- Be specific with product names (e.g. "IBR 0.47mm Roof Sheet" not just "roof sheet")
- Return ONLY the JSON object`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Project description: ${text}${notes ? '\n\nAdditional notes: ' + notes : ''}${type ? '\nProject type hint: ' + type.replace(/_/g,' ') : ''}` }]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`API error ${resp.status}: ${errText.slice(0,200)}`);
    }

    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || 'API returned error');

    let raw = data.content.map(b => b.text || '').join('');
    raw = raw.replace(/```json|```/g, '').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s === -1 || e === -1) throw new Error('No valid JSON in response');
    describeResult = JSON.parse(raw.slice(s, e + 1));
    renderDescribeResults(describeResult);

  } catch(err) {
    console.error('Describe error:', err);
    toast('Error: ' + err.message);
  }

  btn.disabled = false;
  document.getElementById('desc-shimmer').style.display = 'none';
  btn.textContent = 'GENERATE BOM';
}

function renderDescribeResults(r) {
  document.getElementById('desc-placeholder').style.display = 'none';
  document.getElementById('desc-results').style.display = 'block';

  const matTotal = (r.bom||[]).reduce((s,i) => s + (i.lineTotal || i.qty * i.unitCost || 0), 0);
  const labourTotal = (r.labour||[]).reduce((s,l) => s + (l.lineTotal || l.days * l.workers * l.ratePerDay || 0), 0);
  const grandTotal = matTotal + labourTotal;

  document.getElementById('desc-summary-title').textContent = r.projectTitle || 'Project BOM';
  document.getElementById('desc-summary-desc').textContent = r.projectDescription || '';
  document.getElementById('desc-total').textContent = fmt(grandTotal);
  document.getElementById('desc-mat-total').textContent = fmt(matTotal);
  document.getElementById('desc-labour-total').textContent = fmt(labourTotal);

  const catColors = { Concrete:'badge-gray', Brickwork:'badge-gray', Timber:'badge-yellow', Roofing:'badge-blue', Electrical:'badge-yellow', Plumbing:'badge-green', Paint:'badge-purple', Tiling:'badge-purple', Steel:'badge-blue', Solar:'badge-yellow', Gates:'badge-gray', Paving:'badge-gray', Insulation:'badge-blue', Other:'badge-gray' };

  document.getElementById('desc-bom-body').innerHTML = (r.bom||[]).map((item, i) => `
    <tr style="border-bottom:1px solid var(--border);${i%2===0?'background:var(--surface2)':''}">
      <td style="padding:8px 10px;">
        <div style="font-size:12px;font-weight:600;color:var(--text)">${item.item}</div>
        ${item.notes ? `<div style="font-size:10px;color:var(--text3);margin-top:1px">${item.notes}</div>` : ''}
        <span class="badge ${catColors[item.category]||'badge-gray'}" style="font-size:8px;margin-top:3px">${item.category}</span>
      </td>
      <td style="padding:8px 10px;">
        <div style="font-size:11px;color:var(--text2)">${item.supplier}</div>
        ${item.alternativeSupplier ? `<div style="font-size:10px;color:var(--text3)">or ${item.alternativeSupplier}</div>` : ''}
      </td>
      <td style="padding:8px 8px;text-align:right;font-family:var(--fm);font-size:11px">${item.qty}</td>
      <td style="padding:8px 8px;text-align:right;font-family:var(--fm);font-size:11px;color:var(--text3)">${item.unit}</td>
      <td style="padding:8px 8px;text-align:right;font-family:var(--fm);font-size:11px;color:var(--text2)">${fmt(item.unitCost)}</td>
      <td style="padding:8px 8px;text-align:right;font-family:var(--fm);font-size:12px;color:var(--accent);font-weight:600">${fmt(item.lineTotal || item.qty * item.unitCost)}</td>
    </tr>`).join('');

  document.getElementById('desc-labour-body').innerHTML = (r.labour||[]).map((l, i) => {
    const total = l.lineTotal || l.days * l.workers * l.ratePerDay;
    return `<tr style="border-bottom:1px solid var(--border);${i%2===0?'background:var(--surface2)':''}">
      <td style="padding:8px 10px;font-size:12px;font-weight:600">${l.trade}${l.notes ? `<div style="font-size:10px;color:var(--text3);font-weight:400">${l.notes}</div>` : ''}</td>
      <td style="padding:8px 8px;text-align:right;font-family:var(--fm);font-size:11px">${l.days}</td>
      <td style="padding:8px 8px;text-align:right;font-family:var(--fm);font-size:11px">${l.workers}</td>
      <td style="padding:8px 8px;text-align:right;font-family:var(--fm);font-size:11px;color:var(--text2)">${fmt(l.ratePerDay)}</td>
      <td style="padding:8px 8px;text-align:right;font-family:var(--fm);font-size:12px;color:var(--green);font-weight:600">${fmt(total)}</td>
    </tr>`;
  }).join('');

  const notesEl = document.getElementById('desc-notes-out');
  const allNotes = [...(r.assumptions||[]), ...(r.warnings||[])];
  if (allNotes.length > 0) {
    notesEl.style.display = 'block';
    notesEl.innerHTML = '<div style="font-family:var(--fm);font-size:9px;letter-spacing:2px;color:var(--purple);text-transform:uppercase;margin-bottom:6px;">Assumptions & Notes</div>' +
      allNotes.map(n => `<div style="margin-bottom:3px">◈ ${n}</div>`).join('');
  }

  document.querySelector('.content').scrollTop = 0;
  toast('BOM generated — ' + (r.bom||[]).length + ' items ✓');
}

function saveBomAsQuote() {
  if (!describeResult) return;
  const matTotal = (describeResult.bom||[]).reduce((s,i) => s + (i.lineTotal || i.qty * i.unitCost || 0), 0);
  const labourTotal = (describeResult.labour||[]).reduce((s,l) => s + (l.lineTotal || l.days * l.workers * l.ratePerDay || 0), 0);
  const total = matTotal + labourTotal;
  const id = 'QUO-' + new Date().getFullYear() + '-' + String(store.quotes.length + 1).padStart(3,'0');
  store.quotes.unshift({
    id, client: 'New Client',
    desc: describeResult.projectTitle || 'Project Quote',
    amount: Math.round(total),
    date: new Date().toISOString().split('T')[0],
    valid: new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0],
    status: 'pending'
  });
  save();
  store.activity.unshift({ text: `Quote ${id} created from BOM: ${describeResult.projectTitle}`, time: 'Just now', type: 'green' });
  save();
  toast('Saved as quote ' + id + ' ✓');
  setTimeout(() => navigate('quotes'), 1000);
}

function addBomToInventory() {
  if (!describeResult) return;
  let added = 0, updated = 0;
  (describeResult.bom||[]).forEach(item => {
    const existing = store.materials.find(m => m.name.toLowerCase() === item.item.toLowerCase());
    if (existing) {
      existing.cost = item.unitCost;
      existing.supplier = item.supplier;
      updated++;
    } else {
      store.materials.push({
        id: Date.now() + Math.random(),
        name: item.item,
        cat: item.category || 'Other',
        unit: item.unit,
        stock: 0,
        min: Math.max(1, Math.floor(item.qty * 0.1)),
        cost: item.unitCost,
        supplier: item.supplier
      });
      added++;
    }
  });
  save();
  toast(`✓ ${added} items added, ${updated} updated in inventory`);
  setTimeout(() => navigate('materials'), 1200);
}


let scanBase64 = null;
let scanData = null;

function handleScanFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    scanBase64 = ev.target.result;
    document.getElementById('scan-preview-img').src = scanBase64;
    document.getElementById('scan-upload-zone').style.display = 'none';
    document.getElementById('scan-preview-wrap').style.display = 'block';
    document.getElementById('scan-options').style.display = 'block';
    // Populate project dropdown
    const sel = document.getElementById('scan-project');
    sel.innerHTML = '<option value="-">— General Stock —</option>' +
      store.projects.filter(p=>p.status==='active').map(p=>`<option value="${p.id}">${p.id} — ${p.name}</option>`).join('');
    // Enable scan button
    const btn = document.getElementById('scan-btn');
    btn.disabled = false;
    btn.style.background = 'var(--green)';
    btn.style.color = '#fff';
    btn.style.cursor = 'pointer';
    btn.style.borderColor = 'var(--green)';
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

async function runInvoiceScan() {
  if (!scanBase64) return;
  const btn = document.getElementById('scan-btn');
  btn.disabled = true;
  btn.style.opacity = '0.7';
  document.getElementById('scan-btn-shimmer').style.display = 'block';
  document.getElementById('scan-anim-grid').style.display = 'block';
  document.getElementById('scan-anim-line').style.display = 'block';

  const systemPrompt = `You are an expert OCR and invoice parsing AI. You read supplier invoices — printed, handwritten, or photographed — and extract all line items accurately.

Return ONLY a valid JSON object, no preamble, no markdown:
{
  "confidence": 88,
  "supplier": "Builders Warehouse",
  "invoiceDate": "2025-05-07",
  "invoiceRef": "INV-123456",
  "invoiceTotal": 4850.00,
  "items": [
    {
      "name": "Portland Cement 50kg",
      "category": "Concrete",
      "qty": 10,
      "unit": "Bag",
      "unitPrice": 98.00,
      "lineTotal": 980.00
    }
  ]
}

Rules:
- Extract EVERY line item visible on the invoice
- category must be one of: Concrete, Timber, Roofing, Electrical, Plumbing, Paint, Tiling, Tools, Other
- If qty or price is unclear, make your best estimate and lower confidence
- invoiceDate in YYYY-MM-DD format, or today's date if not readable
- invoiceRef: the invoice/receipt number, or "N/A" if not visible
- Return ONLY the JSON object`;

  try {
    const mediaType = scanBase64.split(';')[0].split(':')[1] || 'image/jpeg';
    const b64 = scanBase64.split(',')[1];
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
            { type: 'text', text: 'Please read this supplier invoice and extract all line items into the JSON format specified.' }
          ]
        }]
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('API error ' + resp.status + ': ' + errText.slice(0,200));
    }
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);
    let raw = data.content.map(b=>b.text||'').join('');
    raw = raw.replace(/```json|```/g,'').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s!==-1 && e!==-1) raw = raw.slice(s, e+1);
    scanData = JSON.parse(raw);
    renderScanResults(scanData);
  } catch(err) {
    console.error('Scan error:', err);
    document.getElementById('scan-placeholder').style.display = 'none';
    document.getElementById('scan-results').style.display = 'block';
    document.getElementById('scan-results').innerHTML = `
      <div style="background:rgba(224,82,82,.1);border:1px solid rgba(224,82,82,.3);padding:20px;margin-bottom:10px;">
        <div style="font-family:var(--fm);font-size:10px;letter-spacing:2px;color:var(--red);text-transform:uppercase;margin-bottom:8px;">⚠ Scan Failed</div>
        <div style="font-size:13px;color:var(--text2);line-height:1.7;margin-bottom:10px;">${err.message}</div>
        <div style="font-family:var(--fm);font-size:10px;color:var(--text3);line-height:1.8;">
          Common fixes:<br>
          · Use this inside Claude.ai — not as a downloaded local file<br>
          · Check your internet connection<br>
          · Make sure the image is clear and not too large<br>
          · Try a JPG or PNG under 5MB
        </div>
      </div>
      <button onclick="resetScanner()" style="width:100%;background:var(--surface2);color:var(--text2);border:1px solid var(--border);padding:10px;font-family:var(--fm);font-size:11px;letter-spacing:1px;cursor:pointer;">TRY AGAIN</button>`;
  }
  btn.disabled = false;
  btn.style.opacity = '1';
  document.getElementById('scan-btn-shimmer').style.display = 'none';
  document.getElementById('scan-anim-grid').style.display = 'none';
  document.getElementById('scan-anim-line').style.display = 'none';
}

function renderScanResults(d) {
  document.getElementById('scan-placeholder').style.display = 'none';
  document.getElementById('scan-results').style.display = 'block';
  document.getElementById('scan-supplier-name').textContent = d.supplier || 'Unknown Supplier';
  document.getElementById('scan-invoice-total').textContent = fmt(d.invoiceTotal || 0);
  document.getElementById('scan-invoice-date').textContent = dt(d.invoiceDate) || 'N/A';
  document.getElementById('scan-invoice-ref').textContent = d.invoiceRef || 'N/A';
  document.getElementById('scan-item-count').textContent = (d.items||[]).length + ' items';
  const conf = d.confidence || 70;
  const confColor = conf >= 80 ? 'var(--green)' : conf >= 60 ? 'var(--accent)' : 'var(--red)';
  document.getElementById('scan-conf-fill').style.width = conf + '%';
  document.getElementById('scan-conf-fill').style.background = confColor;
  document.getElementById('scan-conf-pct').textContent = conf + '%';
  document.getElementById('scan-conf-pct').style.color = confColor;

  const catBadge = cat => {
    const m = { Concrete:'badge-gray', Timber:'badge-yellow', Roofing:'badge-blue', Electrical:'badge-yellow', Plumbing:'badge-green', Paint:'badge-purple', Tiling:'badge-purple', Tools:'badge-gray', Other:'badge-gray' };
    return `<span class="badge ${m[cat]||'badge-gray'}" style="font-size:8px">${cat}</span>`;
  };

  document.getElementById('scan-items-body').innerHTML = (d.items||[]).map((item, i) => `
    <tr style="border-bottom:1px solid var(--border)">
      <td style="padding:7px 8px"><input type="checkbox" id="scan-chk-${i}" checked style="accent-color:var(--green);width:14px;height:14px;cursor:pointer"></td>
      <td style="padding:7px 8px;font-size:12px;max-width:160px">${item.name}</td>
      <td style="padding:7px 8px">${catBadge(item.category)}</td>
      <td style="padding:7px 8px;text-align:right;font-family:var(--fm);font-size:11px">${item.qty} ${item.unit}</td>
      <td style="padding:7px 8px;text-align:right;font-family:var(--fm);font-size:11px;color:var(--text2)">${fmt(item.unitPrice)}</td>
      <td style="padding:7px 8px;text-align:right;font-family:var(--fm);font-size:11px;color:var(--accent)">${fmt(item.lineTotal)}</td>
    </tr>`).join('');
  toast('Invoice scanned — ' + (d.items||[]).length + ' items found ✓');
}

function importScannedItems() {
  if (!scanData) return;
  const dest = document.getElementById('scan-dest').value;
  const project = document.getElementById('scan-project').value;
  const supplier = scanData.supplier || 'Unknown Supplier';
  const today = new Date().toISOString().split('T')[0];
  let imported = 0;

  (scanData.items||[]).forEach((item, i) => {
    const chk = document.getElementById('scan-chk-' + i);
    if (!chk || !chk.checked) return;

    // Add to / update inventory
    if (dest === 'both' || dest === 'inventory') {
      const existing = store.materials.find(m => m.name.toLowerCase() === item.name.toLowerCase());
      if (existing) {
        existing.stock += item.qty;
        existing.cost = item.unitPrice;
      } else {
        store.materials.push({
          id: store.materials.length + 1,
          name: item.name,
          cat: item.category,
          unit: item.unit,
          stock: item.qty,
          min: Math.max(1, Math.floor(item.qty * 0.2)),
          cost: item.unitPrice,
          supplier
        });
      }
    }

    // Log as expense
    if (dest === 'both' || dest === 'expenses') {
      store.expenses.unshift({
        id: store.expenses.length + 1,
        date: scanData.invoiceDate || today,
        desc: item.name + (scanData.invoiceRef !== 'N/A' ? ` (${scanData.invoiceRef})` : ''),
        cat: 'Materials',
        project,
        supplier,
        amount: item.lineTotal
      });
    }
    imported++;
  });

  // Add activity log entry
  save();
  store.activity.unshift({
    text: `Supplier invoice scanned — ${imported} items imported from ${supplier} (${fmt(scanData.invoiceTotal)})`,
    time: 'Just now',
    type: 'green'
  });

  toast(`✓ ${imported} items imported from ${supplier}`);
  setTimeout(() => {
    if (dest === 'inventory' || dest === 'both') navigate('materials');
    else navigate('expenses');
  }, 1200);
}

function resetScanner() {
  scanBase64 = null; scanData = null;
  document.getElementById('scan-upload-zone').style.display = '';
  document.getElementById('scan-preview-wrap').style.display = 'none';
  document.getElementById('scan-options').style.display = 'none';
  document.getElementById('scan-results').style.display = 'none';
  document.getElementById('scan-placeholder').style.display = '';
  document.getElementById('scan-file-input').value = '';
  const btn = document.getElementById('scan-btn');
  btn.disabled = true;
  btn.style.background = 'var(--surface2)';
  btn.style.color = 'var(--text3)';
  btn.style.cursor = 'not-allowed';
  btn.style.borderColor = 'var(--border)';
}

// ══════════════════════════════════════════════════════
// ── BLUEPRINT & PHOTO ANALYZER — merged from standalone blueprint-analyzer.html, 1 July 2026 ──
// ══════════════════════════════════════════════════════
let bpUploadedPhotos = []; // { file, base64, name }
let bpCurrentMode = 'blueprint'; // 'blueprint' | 'photo'
let bpAnalysisResult = null;

function bpSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function renderBlueprint() {
  // Stateless page — nothing to populate from store on entry.
}

function bpSetMode(mode) {
  bpCurrentMode = mode;
  document.getElementById('bp-mode-blueprint').classList.toggle('active', mode === 'blueprint');
  document.getElementById('bp-mode-photo').classList.toggle('active', mode === 'photo');
  document.getElementById('bp-photo-hints').style.display = mode === 'photo' ? '' : 'none';

  const uploadTitle = document.getElementById('bp-upload-title');
  const uploadSub   = document.getElementById('bp-upload-sub');
  const uploadIcon  = document.getElementById('bp-upload-icon');

  if (mode === 'photo') {
    uploadTitle.textContent = 'DROP SITE PHOTOS HERE';
    uploadSub.innerHTML = 'Upload multiple photos of the structure<br>Exterior · Interior · Roof · Damage · Close-ups';
    uploadIcon.textContent = '◉';
    document.getElementById('bp-file-input').setAttribute('multiple', '');
  } else {
    uploadTitle.textContent = 'DROP BLUEPRINT HERE';
    uploadSub.innerHTML = 'Tap to take a photo or select files<br>Floor plans · Elevations · Site plans · Sketches';
    uploadIcon.textContent = '⊞';
  }
  bpClearPhotos();
}

function bpHandleFileSelect(e) {
  const files = Array.from(e.target.files);
  if (files.length) bpLoadFiles(files);
  e.target.value = '';
}
function bpAddMorePhotos(e) {
  const files = Array.from(e.target.files);
  if (files.length) bpLoadFiles(files);
  e.target.value = '';
}
function bpLoadFiles(files) {
  files.forEach(file => {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      bpUploadedPhotos.push({ file, base64: ev.target.result, name: file.name });
      bpRenderPhotoGrid();
    };
    reader.readAsDataURL(file);
  });
}

function bpRenderPhotoGrid() {
  const count = bpUploadedPhotos.length;
  if (count === 0) {
    document.getElementById('bp-photo-grid-wrapper').style.display = 'none';
    document.getElementById('bp-upload-zone').style.display = '';
    document.getElementById('bp-preview').style.display = 'none';
    return;
  }
  if (bpCurrentMode === 'photo') {
    document.getElementById('bp-upload-zone').style.display = 'none';
    document.getElementById('bp-preview').style.display = 'none';
    document.getElementById('bp-photo-grid-wrapper').style.display = 'block';
    document.getElementById('bp-photo-count-label').textContent = count + ' photo' + (count > 1 ? 's' : '') + ' loaded';
    document.getElementById('bp-photo-grid').innerHTML = bpUploadedPhotos.map((p, i) => `
      <div class="bp-photo-thumb">
        <img src="${p.base64}" alt="${p.name}">
        <button class="bp-photo-remove" onclick="bpRemovePhoto(${i})">✕</button>
        <div class="bp-photo-num">${i + 1}</div>
      </div>`).join('');
  } else {
    document.getElementById('bp-upload-zone').style.display = 'none';
    document.getElementById('bp-photo-grid-wrapper').style.display = 'none';
    document.getElementById('bp-preview').style.display = 'block';
    document.getElementById('bp-preview-img').src = bpUploadedPhotos[0].base64;
  }
  toast(count + ' image' + (count > 1 ? 's' : '') + ' loaded');
}

function bpRemovePhoto(i) {
  bpUploadedPhotos.splice(i, 1);
  bpRenderPhotoGrid();
  if (bpUploadedPhotos.length === 0) {
    document.getElementById('bp-upload-zone').style.display = '';
    document.getElementById('bp-photo-grid-wrapper').style.display = 'none';
  }
}

function bpClearPhotos() {
  bpUploadedPhotos = [];
  document.getElementById('bp-upload-zone').style.display = '';
  document.getElementById('bp-photo-grid-wrapper').style.display = 'none';
  document.getElementById('bp-preview').style.display = 'none';
}

async function bpRunAnalysis() {
  if (bpUploadedPhotos.length === 0) { toast('Please upload at least one image first'); return; }

  const btn = document.getElementById('bp-analyze-btn');
  btn.disabled = true;
  document.getElementById('bp-shimmer').style.display = 'block';

  const isPhotoMode = bpCurrentMode === 'photo';
  if (!isPhotoMode) {
    document.getElementById('bp-scan-grid').classList.add('active');
    document.getElementById('bp-scan-line').classList.add('active');
  }

  const overlay  = document.getElementById('bp-loading-overlay');
  overlay.classList.add('active');
  const steps    = 6;
  const stepEl   = n => document.getElementById('bp-step-' + n);
  const progress = document.getElementById('bp-loading-progress');

  stepEl(1).querySelector('span').textContent = isPhotoMode ? `Sending ${bpUploadedPhotos.length} photo(s) to Claude Vision AI` : 'Sending blueprint to Claude Vision AI';
  stepEl(2).querySelector('span').textContent = isPhotoMode ? 'Identifying structure, materials & finishes' : 'Detecting dimensions & room elements';

  for (let i = 1; i <= steps; i++) {
    stepEl(i).classList.add('active');
    progress.style.width = ((i / steps) * 85) + '%';
    await bpSleep(isPhotoMode ? 500 : 600);
  }

  const cfg = {
    type: document.getElementById('bp-cfg-type').value,
    region: document.getElementById('bp-cfg-region').value,
    quality: document.getElementById('bp-cfg-quality').value,
    labour: document.getElementById('bp-cfg-labour').value,
    scale: document.getElementById('bp-cfg-scale').value,
    area: document.getElementById('bp-cfg-area').value,
    notes: document.getElementById('bp-cfg-notes').value,
  };
  const labourRates = { low:{min:300,max:400}, mid:{min:500,max:700}, high:{min:700,max:1000} };
  const qualityMultiplier = { budget:0.75, mid:1.0, premium:1.4, luxury:2.0 };

  const photoModeInstructions = isPhotoMode ? `
You are analyzing ${bpUploadedPhotos.length} SITE PHOTOGRAPH(S) of an actual structure (not a drawing).
From these photos, identify:
- The type of structure and its approximate size
- Existing materials visible: roofing, wall cladding, windows, doors, flooring, ceilings, fixtures
- Condition of existing materials (new, fair, deteriorating, damaged)
- What work is needed based on visible condition or the project type selected
- Any visible damage, damp, structural issues, or items requiring replacement
- Estimate quantities from photo proportions, standard construction sizes, and context clues
Set confidence based on photo quality and how clearly materials/scope can be determined (typically 55–80% for photos vs drawings).
` : `
You are analyzing an ARCHITECTURAL DRAWING, floor plan, or blueprint.
Detect room layouts, dimensions, structural elements, and derive accurate quantities from the drawing.
Set confidence based on drawing clarity and detail (typically 70–90% for clear drawings).
`;

  const systemPrompt = `You are an expert South African quantity surveyor and construction estimator with 20+ years experience. You analyze both architectural drawings AND site photographs to produce detailed Bills of Materials (BOM) and construction cost estimates.
${photoModeInstructions}
Return ONLY a valid JSON object — no preamble, no markdown fences, just raw JSON:
{
  "confidence": 72,
  "inputType": "${isPhotoMode ? 'site_photos' : 'blueprint'}",
  "photoCount": ${bpUploadedPhotos.length},
  "detectedArea": 55,
  "detectedRooms": ["lounge", "kitchen", "2 bedrooms", "bathroom"],
  "projectDescription": "Detailed paragraph of what you observe across all images",
  "estimatedDuration": 14,
  "observations": [
    {"icon": "◈", "text": "Specific observation from images"},
    {"icon": "⊟", "text": "Material or condition noted"}
  ],
  "bom": [
    { "item": "Concrete Blocks (230x110x75mm)", "category": "Concrete", "qty": 850, "unit": "Each", "unitCost": 7.50, "notes": "For new boundary wall, estimated from photo" }
  ],
  "labour": [
    { "trade": "Bricklayer", "days": 8, "workers": 2, "ratePerDay": 600, "notes": "Blockwork construction" }
  ],
  "risks": [
    {"icon": "⚠", "text": "Risk or assumption based on limited photo visibility"},
    {"icon": "⊕", "text": "Recommended site visit for accurate measurement"}
  ],
  "contingency": ${isPhotoMode ? 15 : 10}
}
RULES:
- Region: ${cfg.region.replace('_',' ')} — use current ZAR pricing
- Quality: ${cfg.quality} (${Math.round(qualityMultiplier[cfg.quality]*100)}% of standard rates)
- Labour: ${cfg.labour} (R${labourRates[cfg.labour].min}–R${labourRates[cfg.labour].max}/day)
- Project type: ${cfg.type.replace('_',' ')}
${cfg.area ? `- Client stated area: ${cfg.area}m²` : '- Estimate area from images'}
${cfg.notes ? `- Client notes: ${cfg.notes}` : ''}
- Add 10% waste to all material quantities
- BOM: 8–18 line items across all relevant categories
- Labour: 4–8 trade types
- Categories: Concrete | Timber | Roofing | Electrical | Plumbing | Finishes | Labour | Other
- Company is NOT VAT registered — never mention or include VAT in any figure
${isPhotoMode ? '- Increase contingency to 15% due to photo-based estimation uncertainty\n- Note in risks that a site measurement visit is recommended for final pricing' : ''}
- Return ONLY the JSON object.`;

  try {
    const imageBlocks = bpUploadedPhotos.map(p => ({
      type: 'image',
      source: { type: 'base64', media_type: p.file.type.startsWith('image/') ? p.file.type : 'image/jpeg', data: p.base64.split(',')[1] }
    }));
    const textBlock = {
      type: 'text',
      text: isPhotoMode
        ? `These are ${bpUploadedPhotos.length} site photo(s) of a structure. Please analyze all images together and produce the Bill of Materials and cost estimate JSON. Project type: ${cfg.type.replace('_',' ')}. Quality: ${cfg.quality}. Region: ${cfg.region}.`
        : `Please analyze this blueprint/drawing and produce the Bill of Materials and cost estimate JSON. Project type: ${cfg.type.replace('_',' ')}. Quality: ${cfg.quality}. Region: ${cfg.region}.`
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4000, system: systemPrompt, messages: [{ role: 'user', content: [...imageBlocks, textBlock] }] })
    });
    if (!response.ok) { const errText = await response.text(); throw new Error(`API error ${response.status}: ${errText.slice(0,300)}`); }
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'API returned error');
    const rawText = data.content.map(b => b.text || '').join('');
    let jsonStr = rawText.replace(/```json|```/g, '').trim();
    const start = jsonStr.indexOf('{'), end = jsonStr.lastIndexOf('}');
    if (start !== -1 && end !== -1) jsonStr = jsonStr.slice(start, end + 1);
    bpAnalysisResult = JSON.parse(jsonStr);

    progress.style.width = '100%';
    for (let i = 1; i <= steps; i++) { stepEl(i).classList.remove('active'); stepEl(i).classList.add('done'); }
    await bpSleep(600);
    overlay.classList.remove('active');
    bpRenderResults(bpAnalysisResult);
  } catch (err) {
    overlay.classList.remove('active');
    console.error('Blueprint analysis error:', err);
    document.getElementById('bp-placeholder').style.display = 'none';
    const container = document.getElementById('bp-results');
    container.style.display = 'block';
    container.innerHTML = `<div style="background:rgba(224,82,82,.1);border:1px solid rgba(224,82,82,.3);padding:20px;margin-bottom:10px;">
      <div style="font-family:var(--fm);font-size:10px;letter-spacing:2px;color:var(--red);text-transform:uppercase;margin-bottom:8px;">⚠ Analysis Failed</div>
      <div style="font-size:13px;color:var(--text2);line-height:1.7;margin-bottom:10px;">${err.message}</div>
      <div style="font-family:var(--fm);font-size:10px;color:var(--text3);line-height:1.8;">Common fixes:<br>· Check your internet connection<br>· Try a smaller or clearer image<br>· Compress very large images first</div>
    </div>
    <button onclick="location.reload()" style="width:100%;background:var(--surface2);color:var(--text2);border:1px solid var(--border);padding:10px;font-family:var(--fm);font-size:11px;letter-spacing:1px;cursor:pointer;">RELOAD &amp; TRY AGAIN</button>`;
  }

  btn.disabled = false;
  document.getElementById('bp-shimmer').style.display = 'none';
  if (!isPhotoMode) {
    document.getElementById('bp-scan-grid').classList.remove('active');
    document.getElementById('bp-scan-line').classList.remove('active');
  }
}

function bpTotals(r) {
  const matTotal    = (r.bom || []).reduce((s, i) => s + (i.qty * i.unitCost), 0);
  const labourTotal = (r.labour || []).reduce((s, l) => s + (l.days * l.workers * l.ratePerDay), 0);
  const subtotal    = matTotal + labourTotal;
  const contingency = subtotal * ((r.contingency || 0) / 100);
  const grand       = subtotal + contingency;
  return { matTotal, labourTotal, subtotal, contingency, grand };
}

function bpRenderResults(r) {
  document.getElementById('bp-placeholder').style.display = 'none';
  document.getElementById('bp-results').style.display = 'block';

  const { matTotal, labourTotal, subtotal, contingency, grand } = bpTotals(r);

  document.getElementById('bp-res-total').textContent = fmt(grand);
  document.getElementById('bp-res-range').textContent = `Range: ${fmt(grand * 0.88)} – ${fmt(grand * 1.12)}`;
  document.getElementById('bp-res-area').textContent = (r.detectedArea || '?') + 'm²';
  document.getElementById('bp-res-rate').textContent = r.detectedArea ? fmt(Math.round(grand / r.detectedArea)) + '/m²' : 'area not detected';
  document.getElementById('bp-res-duration').textContent = r.estimatedDuration || '?';

  const conf = r.confidence || 70;
  const confColor = conf >= 80 ? 'var(--green)' : conf >= 60 ? 'var(--accent)' : 'var(--red)';
  document.getElementById('bp-conf-fill').style.width = conf + '%';
  document.getElementById('bp-conf-fill').style.background = confColor;
  document.getElementById('bp-conf-pct').textContent = conf + '%';
  document.getElementById('bp-conf-pct').style.color = confColor;

  document.getElementById('bp-observations-list').innerHTML = (r.observations || []).map(o =>
    `<div class="bp-obs-item"><span>${o.icon}</span><span>${o.text}</span></div>`
  ).join('') || '<div class="bp-obs-item"><span>◈</span><span>Blueprint analyzed successfully.</span></div>';

  document.getElementById('bp-bom-body').innerHTML = (r.bom || []).map((item, i) => {
    const total = item.qty * item.unitCost;
    return `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:6px 8px;">
        <input class="bp-editable" value="${item.item}" onchange="bpUpdateBomItem(${i},'item',this.value)">
        ${item.notes ? `<div style="font-family:var(--fm);font-size:9px;color:var(--text3);padding-left:4px;margin-top:2px">${item.notes}</div>` : ''}
      </td>
      <td style="padding:6px 8px;"><span class="badge bp-badge-cat-${item.category}">${item.category}</span></td>
      <td style="padding:6px 8px;text-align:right;"><input class="bp-editable bp-editable-num" type="number" value="${item.qty}" onchange="bpUpdateBomItem(${i},'qty',+this.value)"></td>
      <td style="padding:6px 8px;text-align:right;font-family:var(--fm);font-size:11px;color:var(--text3);">${item.unit}</td>
      <td style="padding:6px 8px;text-align:right;"><input class="bp-editable bp-editable-num" type="number" value="${item.unitCost}" onchange="bpUpdateBomItem(${i},'unitCost',+this.value)"></td>
      <td style="padding:6px 8px;text-align:right;font-family:var(--fm);font-size:12px;color:var(--accent);font-weight:600;" id="bp-bom-line-${i}">${fmt(total)}</td>
    </tr>`;
  }).join('');
  document.getElementById('bp-bom-total').textContent = fmt(matTotal);

  document.getElementById('bp-labour-body').innerHTML = (r.labour || []).map((l, i) => {
    const total = l.days * l.workers * l.ratePerDay;
    return `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:6px 8px;">
        <input class="bp-editable" value="${l.trade}" onchange="bpUpdateLabourItem(${i},'trade',this.value)">
        ${l.notes ? `<div style="font-family:var(--fm);font-size:9px;color:var(--text3);padding-left:4px;margin-top:2px">${l.notes}</div>` : ''}
      </td>
      <td style="padding:6px 8px;text-align:right;"><input class="bp-editable bp-editable-num" type="number" value="${l.days}" onchange="bpUpdateLabourItem(${i},'days',+this.value)"></td>
      <td style="padding:6px 8px;text-align:right;font-family:var(--fm);font-size:11px;">${l.workers}</td>
      <td style="padding:6px 8px;text-align:right;font-family:var(--fm);font-size:11px;color:var(--text2);">${fmt(l.ratePerDay)}</td>
      <td style="padding:6px 8px;text-align:right;font-family:var(--fm);font-size:12px;color:var(--green);font-weight:600;" id="bp-labour-line-${i}">${fmt(total)}</td>
    </tr>`;
  }).join('');
  document.getElementById('bp-labour-total').textContent = fmt(labourTotal);

  bpRenderEstimateRows(r);

  document.getElementById('bp-risks-list').innerHTML = (r.risks || []).map(risk =>
    `<div class="bp-obs-item"><span>${risk.icon}</span><span>${risk.text}</span></div>`
  ).join('') || '<div class="bp-obs-item"><span>⊕</span><span>No major risks identified.</span></div>';

  document.querySelector('.content').scrollTop = 0;
  toast('Analysis complete — ' + (r.bom||[]).length + ' items ✓');
}

function bpRenderEstimateRows(r) {
  const { matTotal, labourTotal, subtotal, contingency, grand } = bpTotals(r);
  document.getElementById('bp-estimate-rows').innerHTML = `
    <div class="bp-estimate-row"><span class="label">Materials</span><span class="amount">${fmt(matTotal)}</span></div>
    <div class="bp-estimate-row"><span class="label">Labour</span><span class="amount">${fmt(labourTotal)}</span></div>
    <div class="bp-estimate-row"><span class="label">Subtotal</span><span class="amount">${fmt(subtotal)}</span></div>
    <div class="bp-estimate-row"><span class="label">Contingency (${r.contingency||0}%)</span><span class="amount">${fmt(contingency)}</span></div>
    <div class="bp-estimate-row"><span class="label">VAT</span><span class="amount">Not Registered</span></div>
    <div class="bp-estimate-row total"><span class="label">TOTAL PROJECT ESTIMATE</span><span class="amount">${fmt(grand)}</span></div>`;
}

function bpUpdateBomItem(i, field, value) {
  bpAnalysisResult.bom[i][field] = value;
  const item = bpAnalysisResult.bom[i];
  const el = document.getElementById('bp-bom-line-' + i);
  if (el) el.textContent = fmt(item.qty * item.unitCost);
  bpRefreshTotals();
}
function bpUpdateLabourItem(i, field, value) {
  bpAnalysisResult.labour[i][field] = value;
  const l = bpAnalysisResult.labour[i];
  const el = document.getElementById('bp-labour-line-' + i);
  if (el) el.textContent = fmt(l.days * l.workers * l.ratePerDay);
  bpRefreshTotals();
}
function bpRefreshTotals() {
  const { matTotal, labourTotal, grand } = bpTotals(bpAnalysisResult);
  document.getElementById('bp-bom-total').textContent = fmt(matTotal);
  document.getElementById('bp-labour-total').textContent = fmt(labourTotal);
  document.getElementById('bp-res-total').textContent = fmt(grand);
  bpRenderEstimateRows(bpAnalysisResult);
}

// ── Save straight into the ERP — the actual reason for merging this into the dashboard ──
function bpSaveAsQuote() {
  if (!bpAnalysisResult) return;
  const r = bpAnalysisResult;
  const { subtotal, contingency, grand } = bpTotals(r);

  const lines = [
    ...(r.bom || []).map(item => ({ desc: item.item, qty: item.qty, unit: item.unit, cost: item.unitCost, markup: 0, clientPrice: item.unitCost, lineTotal: Math.round(item.qty * item.unitCost * 100) / 100 })),
    ...(r.labour || []).map(l => ({ desc: l.trade + ' labour', qty: l.days * l.workers, unit: 'day', cost: l.ratePerDay, markup: 0, clientPrice: l.ratePerDay, lineTotal: Math.round(l.days * l.workers * l.ratePerDay * 100) / 100 })),
  ];

  const id = 'QUO-' + new Date().getFullYear() + '-' + String(store.quotes.length + 1).padStart(3,'0');
  store.quotes.unshift({
    id, client: 'New Client',
    desc: r.projectDescription ? r.projectDescription.slice(0,120) : 'Blueprint-generated quote',
    amount: Math.round(grand),
    date: new Date().toISOString().split('T')[0],
    valid: new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0],
    status: 'pending', version: 1,
    lines, subtotal: Math.round(subtotal*100)/100, contingency: Math.round(contingency*100)/100, contingencyPct: r.contingency || 0,
  });
  store.activity.unshift({ text: `Quote ${id} created from Blueprint AI analysis (${(r.bom||[]).length} materials, ${(r.labour||[]).length} trades)`, time: 'Just now', type: 'green' });
  save();
  toast('Saved as quote ' + id + ' ✓');
  setTimeout(() => navigate('quotes'), 1000);
}

function bpAddToInventory() {
  if (!bpAnalysisResult) return;
  let added = 0, updated = 0;
  (bpAnalysisResult.bom || []).forEach(item => {
    const existing = store.materials.find(m => m.name.toLowerCase() === item.item.toLowerCase());
    if (existing) { existing.cost = item.unitCost; updated++; }
    else {
      store.materials.push({ id: Date.now() + Math.random(), name: item.item, cat: item.category || 'Other', unit: item.unit, stock: 0, min: Math.max(1, Math.floor(item.qty * 0.1)), cost: item.unitCost, supplier: '' });
      added++;
    }
  });
  save();
  store.activity.unshift({ text: `Blueprint AI BOM imported to inventory — ${added} added, ${updated} updated`, time: 'Just now', type: 'green' });
  save();
  toast(`✓ ${added} items added, ${updated} updated in inventory`);
  setTimeout(() => navigate('materials'), 1200);
}

