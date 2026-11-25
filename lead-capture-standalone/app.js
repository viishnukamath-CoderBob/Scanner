'use strict';
// ===== helpers =====
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('lc_' + k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem('lc_' + k, JSON.stringify(v)),
  del: (k) => localStorage.removeItem('lc_' + k),
};
let toastT;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = ''), 2600);
}
const abs = (p) => new URL(p, document.baseURI).href;
const fmtTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

// ===== state =====
const state = { user: null, topics: [], topicId: store.get('topic', null), tab: 'scan', leads: [], live: false,
  scan: { phase: 'scan', data: null }, filter: { q: '', topic: '', temperature: '', mine: false } };
// ===== boot =====
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
(async function boot() {
  if (!hasToken()) { renderLogin(); return; }
  try { state.user = await api('/me'); await afterLogin(); } catch (e) { renderLogin(); }
})();

async function afterLogin() {
  store.set('user', state.user);
  await loadTopics();
  startLive();
  flushQueue();
  renderShell();
}
async function loadTopics() {
  try { state.topics = await api('/topics'); store.set('topics', state.topics); } catch { state.topics = store.get('topics', []); }
  if (state.topicId && !state.topics.some((t) => t.id === state.topicId)) { state.topicId = null; store.del('topic'); }
}

// ===== name screen (once per device; no accounts, no passwords) =====
function renderLogin() {
  const cur = state.user ? state.user.name : '';
  app.innerHTML = `<div class="login"><img class="logo" src="icon.svg" alt=""><h1>Lead Capture</h1>
    <form class="card" id="lf"><label for="u">Your name</label><input id="u" autocomplete="name" value="${esc(cur)}" required maxlength="80">
    <p class="muted">Saved on this phone and added to every lead you capture. Leads stay on this device &mdash; use Export Excel to save them.</p>
    <p class="err" id="le"></p><button class="btn block" id="lb">Start</button></form></div>`;
  $('#u').focus();
  $('#lf').onsubmit = async (e) => {
    e.preventDefault(); const b = $('#lb'); b.disabled = true; $('#le').textContent = '';
    try { state.user = await api('/login', { method: 'POST', body: { name: $('#u').value } }); await afterLogin(); }
    catch (err) { $('#le').textContent = err.message; b.disabled = false; }
  };
}

// ===== shell =====
function renderShell() {
  const topic = state.topics.find((t) => t.id === state.topicId);
  app.innerHTML = `<header class="top"><span class="live ${state.live ? 'on' : ''}" id="live" title="Live sync"></span>
    <h1>Lead Capture</h1>${topic ? `<button class="chip" id="chTopic">${esc(topic.name)}</button>` : ''}
    <button class="chip" id="chUser">${esc(state.user.name)}</button></header>
    <main id="main"></main>
    <nav class="tabs"><button data-tab="scan">Scan</button><button data-tab="leads">Leads</button><button data-tab="admin">Dashboard</button></nav>`;
  document.querySelectorAll('nav.tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  const ct = $('#chTopic'); if (ct) ct.onclick = changeTopic;
  $('#chUser').onclick = () => { stopCamera(); stopSync(); renderLogin(); };
  setTab(state.tab, true);
}
function changeTopic() { stopCamera(); state.topicId = null; store.del('topic'); state.scan = { phase: 'scan', data: null }; state.tab = 'scan'; renderShell(); }
function setTab(tab, force) {
  if (tab !== 'scan') stopCamera();
  state.tab = tab;
  document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'scan') renderScan();
  else if (tab === 'leads') renderLeads();
  else renderAdmin();
}
function setLive(on) { state.live = on; const el = $('#live'); if (el) el.classList.toggle('on', on); }

function modal(html, mount) {
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;background:rgba(10,20,35,.55);z-index:40;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:16px';
  o.innerHTML = `<div class="card" style="max-width:520px;width:100%;margin:auto">${html}</div>`;
  document.body.appendChild(o);
  o.addEventListener('mousedown', (e) => { if (e.target === o) o.remove(); });
  mount(o, () => o.remove());
  return o;
}
// ===== near-real-time sync (polls a version counter; full data only when something changed) =====
let seenLeads = null, topicsSig = '';
function startLive() {
  seenLeads = null;
  startSync({
    onStatus: setLive,
    onData: (r) => {
      const prev = seenLeads;
      state.leads = r.leads; seenLeads = new Set(r.leads.map((l) => l.id));
      if (prev && state.tab !== 'scan') {
        const fresh = r.leads.find((l) => !prev.has(l.id) && l.user_id !== state.user.id);
        if (fresh) toast(`New ${fresh.temperature} lead: ${fresh.name || fresh.company}`);
      }
      const sig = JSON.stringify(r.topics);
      const topicsChanged = sig !== topicsSig; topicsSig = sig;
      if (topicsChanged) {
        state.topics = r.topics; store.set('topics', r.topics.filter((t) => t.active !== 0));
        if (state.topicId && !state.topics.some((t) => t.id === state.topicId && t.active !== 0)) { state.topicId = null; store.del('topic'); }
      }
      if (state.tab === 'leads') paintLeads();
      else if (state.tab === 'admin') { loadAdminStats(); if (topicsChanged) paintTopics(); }
      else if (state.tab === 'scan' && topicsChanged && !state.topicId) renderScan();
    },
  });
}

// ===== offline queue =====
const getQ = () => store.get('queue', []);
let flushing = false;
async function flushQueue() {
  if (flushing) return; flushing = true;
  try {
    let q = getQ();
    while (q.length) {
      try { await api('/leads', { method: 'POST', body: q[0] }); }
      catch (e) { if (e instanceof NetErr) break; /* permanent failure: drop */ }
      q = getQ().slice(1); store.set('queue', q);
      updatePending();
    }
  } finally { flushing = false; updatePending(); }
}
function updatePending() { const el = $('#pending'); if (el) { const n = getQ().length; el.style.display = n ? '' : 'none'; el.textContent = `${n} lead(s) saved on this device, waiting to sync…`; } }
window.addEventListener('online', flushQueue);
setInterval(() => { if (state.user && getQ().length) flushQueue(); }, 15000);

// ===== nametag text parsing =====
// Badge layout (top → bottom): UBS Forums logo / "Powered by IBM" / "IBM FlashSystem –" / "INDIA REVEAL" /
// Firstname / Lastname / ── divider ── / Company Name
const HEADER_KEYS = ['ubsforums', 'forums', 'presents', 'poweredby', 'flashsystem', 'indiareveal', 'reveal', 'indiare'];
const squash = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
const cleanLine = (s) => s.replace(/[|_~=«»<>\[\]{}\\\/*#^`"“”]/g, ' ').replace(/[^\p{L}\p{N}&.,'’()+\- ]/gu, ' ').replace(/\s+/g, ' ').replace(/^[\s.,'’\-–]+|[\s,'’\-–]+$/g, '').trim();
const titleCase = (s) => (s === s.toUpperCase() && /[A-Z]{3,}/.test(s) ? s.toLowerCase().replace(/(^|[\s'’(-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) : s);

// lines: [{text, conf, top, bottom}]  (pixel coordinates in the OCR image)
function parseNametag(lines) {
  const out = { name: '', company: '' };
  let L = lines.map((l) => ({ ...l, text: cleanLine(l.text) })).filter((l) => l.text).sort((a, b) => a.top - b.top);
  // 1) drop everything at/above the last event-header line
  let cut = -1;
  L.forEach((l, i) => { const q = squash(l.text); if (q.length >= 5 && HEADER_KEYS.some((k) => q.includes(k))) cut = i; });
  if (cut >= 0) L = L.slice(cut + 1);
  // 2) drop noise (logo fragments, low confidence, too short)
  L = L.filter((l) => /\p{L}{2,}/u.test(l.text) && l.conf >= 35 && (l.bottom - l.top) > 8);
  if (!L.length) return out;
  const hmax = Math.max(...L.map((l) => l.bottom - l.top));
  L = L.filter((l) => l.bottom - l.top >= hmax * 0.4);
  // 3) split name | company at the largest vertical gap (the divider rule sits there)
  let split;
  if (L.length === 1) split = 1;
  else if (L.length === 2) split = 1;
  else {
    let best = -1, bi = 1;
    for (let i = 1; i < L.length; i++) { const g = L[i].top - L[i - 1].bottom; if (g > best) { best = g; bi = i; } }
    split = Math.min(bi, 2);                      // name is at most 2 lines (first + last)
  }
  out.name = titleCase(L.slice(0, split).map((l) => l.text).join(' '));
  out.company = titleCase(L.slice(split, split + 2).map((l) => l.text).join(' '));
  return out;
}

// ===== camera + OCR scanning =====
let stream = null, scanning = false, scanToken = 0, ocrWorker = null, ocrLoading = null, lastSaved = { key: '', t: 0 };
const canvas = document.createElement('canvas'); const cctx = canvas.getContext('2d', { willReadFrequently: true });

async function startCamera(video, setMsg) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setMsg(window.isSecureContext ? 'Camera is not supported in this browser.' : 'Camera requires HTTPS. Open the secure (https://) URL.', true); return false;
  }
  try {
    if (!stream || !stream.active) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    }
    video.srcObject = stream; video.setAttribute('playsinline', ''); video.muted = true;
    await video.play().catch(() => {});
    return true;
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    setMsg(denied ? 'Camera permission denied. Allow camera access in your browser settings (lock icon in the address bar), then tap Retry.'
      : e && e.name === 'NotFoundError' ? 'No camera found on this device.' : 'Could not start the camera: ' + (e && e.message || e), true);
    return false;
  }
}
function stopCamera() {
  scanning = false; scanToken++;
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else if (state.user && state.tab === 'scan' && state.scan.phase === 'scan' && state.topicId) renderScan();
});

function getOcr() {
  if (ocrWorker) return Promise.resolve(ocrWorker);
  if (ocrLoading) return ocrLoading;
  ocrLoading = (async () => {
    if (!window.Tesseract) {
      await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/tesseract/tesseract.min.js'; s.onload = res; s.onerror = () => rej(new Error('Text reader failed to load')); document.head.appendChild(s); });
    }
    const w = await Tesseract.createWorker('eng', 1, { workerPath: abs('vendor/tesseract/worker.min.js'), corePath: abs('vendor/tesseract-core'), langPath: abs('vendor/tesseract-lang'), gzip: true });
    await w.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
    ocrWorker = w; return w;
  })().catch((e) => { ocrLoading = null; throw e; });
  return ocrLoading;
}

// Crop the video to the on-screen guide frame, upscale, convert to high-contrast dark-on-light grayscale.
function grabFrame(video, box, frame) {
  const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return null;
  const b = box.getBoundingClientRect(), f = frame.getBoundingClientRect();
  const s = Math.max(b.width / vw, b.height / vh);                // object-fit: cover mapping
  const ox = (vw * s - b.width) / 2, oy = (vh * s - b.height) / 2;
  let sx = (f.left - b.left + ox) / s, sy = (f.top - b.top + oy) / s, sw = f.width / s, sh = f.height / s;
  sx = Math.max(0, sx); sy = Math.max(0, sy); sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
  const k = Math.min(3, 1100 / sw);
  canvas.width = Math.round(sw * k); canvas.height = Math.round(sh * k);
  cctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const img = cctx.getImageData(0, 0, canvas.width, canvas.height), d = img.data, n = d.length / 4;
  const g = new Uint8ClampedArray(n); const hist = new Uint32Array(256); let sum = 0;
  for (let i = 0; i < n; i++) { const v = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8; g[i] = v; hist[v]++; sum += v; }
  const invert = sum / n < 128;                                    // light text on dark badge → flip
  let acc = 0, lo = 0, hi = 255; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.02) { lo = v; break; } }
  acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.02) { hi = v; break; } }
  const range = Math.max(30, hi - lo);
  for (let i = 0; i < n; i++) { let v = Math.max(0, Math.min(255, ((g[i] - lo) * 255) / range)); if (invert) v = 255 - v; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  cctx.putImageData(img, 0, 0);
  return canvas;
}
async function readNametag(video, box, frame) {
  const c = grabFrame(video, box, frame); if (!c) return null;
  const w = await getOcr();
  const { data } = await w.recognize(c, {}, { blocks: true, text: true });
  const lines = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || [])
    lines.push({ text: l.text || '', conf: l.confidence ?? 0, top: l.bbox.y0, bottom: l.bbox.y1 });
  return { parsed: parseNametag(lines), text: data.text || '', img: c.toDataURL('image/jpeg', 0.6) };
}

// ===== scan tab =====
function renderScan() {
  const main = $('#main');
  if (!state.topicId) { stopCamera(); return renderTopicPicker(main); }
  if (state.scan.phase === 'review') { stopCamera(); return renderReview(main); }
  const topic = state.topics.find((t) => t.id === state.topicId);
  main.innerHTML = `<div id="pending" class="pending" style="display:none"></div>
    <div class="card"><div class="scanbox" id="sbox"><video id="vid" autoplay playsinline muted></video><div class="frame" id="frm"></div><div class="ph" id="ph">Starting camera…</div><div class="msg" id="smsg">Fit the nametag inside the frame</div></div>
    <div class="row" style="margin-top:12px"><button class="btn grow" id="cap">Capture now</button><button class="btn sec grow" id="man">Enter manually</button></div>
    <div class="row" style="margin-top:10px;justify-content:space-between"><span class="muted">Topic: <b>${esc(topic ? topic.name : '')}</b></span><button class="btn sec sm" id="chg">&larr; Change topic</button></div></div>`;
  updatePending();
  stopCamera(); const token = ++scanToken;
  const video = $('#vid'), box = $('#sbox'), frame = $('#frm'), msg = $('#smsg'), ph = $('#ph'), capBtn = $('#cap');
  const setMsg = (t, bad) => { msg.textContent = t; if (bad) { ph.style.display = 'flex'; ph.innerHTML = `<div>${esc(t)}<br><br><button class="btn sec sm" id="retry">Retry</button></div>`; $('#retry').onclick = renderScan; msg.style.display = 'none'; } };
  const alive = () => token === scanToken;
  const accept = (r, forced) => {
    scanning = false; navigator.vibrate && navigator.vibrate(60);
    state.scan = { phase: 'review', data: r.parsed, raw: r.text, source: 'ocr', img: r.img, forced };
    renderScan();
  };
  let busy = false;
  async function captureNow() {
    if (busy || !stream) return; busy = true; capBtn.disabled = true; capBtn.innerHTML = '<span class="spin"></span> Reading…';
    try {
      const r = await readNametag(video, box, frame);
      if (!alive()) return;
      if (r) return accept(r, true);
      toast('Camera not ready', true);
    } catch (e) { toast(e.message || 'Could not read text', true); }
    busy = false; if (alive()) { capBtn.disabled = false; capBtn.textContent = 'Capture now'; }
  }
  capBtn.onclick = captureNow;
  $('#chg').onclick = changeTopic;
  $('#man').onclick = () => { stopCamera(); state.scan = { phase: 'review', data: { name: '', company: '' }, raw: '', source: 'manual' }; renderScan(); };

  getOcr().then(() => alive() && !busy && setMsg('Fit the nametag inside the frame')).catch((e) => alive() && setMsg(e.message, true));
  if (!ocrWorker) setMsg('Loading text reader (first time only)…');
  startCamera(video, setMsg).then(async (ok) => {
    if (!ok || !alive()) return;
    ph.style.display = 'none'; scanning = true;
    let prev = '';
    while (alive() && scanning) {
      await new Promise((r) => setTimeout(r, 250));
      if (!alive() || !scanning || busy || document.hidden || video.readyState < 2) continue;
      busy = true;
      try {
        const r = await readNametag(video, box, frame);
        if (!alive() || !scanning) { busy = false; return; }
        const p = r && r.parsed, key = p ? squash(p.name) : '';
        if (p && p.name && p.company && /\p{L}{2}/u.test(p.name)) {
          if (key === lastSaved.key.split('|')[0] && Date.now() - lastSaved.t < 20000) { msg.textContent = 'Already captured — show the next nametag'; prev = ''; }
          else if (key === prev) { busy = false; return accept(r, false); }   // same result twice in a row = confident
          else { prev = key; msg.textContent = 'Reading… hold steady'; }
        } else { prev = ''; msg.textContent = 'Fit the nametag inside the frame'; }
      } catch (e) { if (alive()) msg.textContent = e.message || 'Reader error'; }
      busy = false;
    }
  });
}
function renderTopicPicker(main) {
  main.innerHTML = `<div class="card"><h2>Select your demo topic / booth</h2><p class="muted">Leads you capture will be tagged with this topic.</p>
    <div class="topics">${state.topics.filter((t) => Number(t.active)).map((t) => `<button class="topic" data-id="${esc(t.id)}">${esc(t.name)}</button>`).join('') || '<p class="muted">No topics available. Ask an admin to add one.</p>'}</div></div>`;
  main.querySelectorAll('.topic').forEach((b) => (b.onclick = () => { state.topicId = b.dataset.id; store.set('topic', b.dataset.id); renderShell(); }));
}

// ===== lead form (review + edit) =====
function leadFormHTML(d, { topicSelect, temp, notes } = {}) {
  const f = (id, label, val, attrs = '') => `<div><label for="f_${id}">${label}</label><input id="f_${id}" value="${esc(val)}" ${attrs}></div>`;
  return `${topicSelect ? `<label for="f_topic">Demo topic</label><select id="f_topic">${state.topics.map((t) => `<option value="${esc(t.id)}" ${t.id === topicSelect ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : ''}
    <div class="grid2">${f('name', 'Name', d.name, 'autocomplete="off"')}${f('company', 'Company', d.company, 'autocomplete="off"')}
    </div>
    <label>Lead temperature</label><div class="temps" id="temps">${['Hot', 'Warm', 'Cold'].map((t) => `<button type="button" data-t="${t}" class="${temp === t ? 'on' : ''}">${t}</button>`).join('')}</div>
    <label for="f_notes">Notes</label><textarea id="f_notes" placeholder="Interests, follow-up actions…">${esc(notes || '')}</textarea>`;
}
function bindTemps(root, get, set) { root.querySelectorAll('#temps button').forEach((b) => (b.onclick = () => { set(b.dataset.t); root.querySelectorAll('#temps button').forEach((x) => x.classList.toggle('on', x === b)); })); }
const readForm = (root) => ({ name: $('#f_name', root).value.trim(), company: $('#f_company', root).value.trim(), notes: $('#f_notes', root).value.trim() });

function renderReview(main) {
  const { data, raw, source, img } = state.scan; let temp = '';
  const dup = data.name && state.leads.find((l) => l.topic_id === state.topicId && squash(l.name) === squash(data.name) && squash(l.company) === squash(data.company));
  const empty = !data.name && !data.company;
  main.innerHTML = `<div class="card"><h2>Review lead</h2>
    ${source === 'manual' ? '' : empty ? `<p class="err">Couldn't read the nametag clearly — please type the name and company below, or go back and retry.</p>` : `<p class="muted">Read from the nametag. Please check the name and company and correct if needed.</p>`}
    ${img ? `<img src="${img}" alt="Captured nametag" style="width:100%;max-height:200px;object-fit:contain;background:#fff;border:1px solid var(--line);border-radius:10px;margin:6px 0">` : ''}
    ${dup ? `<p class="pending">Already captured for this topic (${esc(dup.captured_by)}, ${esc(fmtTime(dup.created_at))}).</p>` : ''}
    ${raw && source === 'ocr' ? `<details style="margin:8px 0"><summary class="muted">Raw text read</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;background:#f2f5f9;padding:8px;border-radius:8px">${esc(raw.slice(0, 1000))}</pre></details>` : ''}
    ${leadFormHTML(data, {})}<p class="err" id="fe"></p>
    <div class="row" style="margin-top:12px"><button class="btn sec" id="cancel">Discard</button><button class="btn grow" id="save">Save lead &amp; scan next</button></div></div>`;
  bindTemps(main, () => temp, (t) => (temp = t));
  if (empty || source === 'manual') $('#f_name').focus();
  $('#cancel').onclick = () => { lastSaved = { key: squash(data.name) + '|' + squash(data.company), t: Date.now() }; state.scan = { phase: 'scan', data: null }; renderScan(); };
  $('#save').onclick = async () => {
    const v = readForm(main), err = $('#fe');
    if (!temp) { err.textContent = 'Select Hot, Warm or Cold.'; return; }
    if (!v.name && !v.company) { err.textContent = 'Enter at least a name or company.'; return; }
    const body = { ...v, temperature: temp, topic_id: state.topicId, source, raw_text: raw || '', client_id: uuid() };
    const btn = $('#save'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Saving…';
    try { const lead = await api('/leads', { method: 'POST', body }); if (!state.leads.some((l) => l.id === lead.id)) state.leads.unshift(lead); toast('Lead saved ✓'); syncNow(); }
    catch (e) {
      if (e instanceof NetErr) { store.set('queue', [...getQ(), body]); toast('Offline — saved on device, will sync'); }
      else { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Save lead & scan next'; return; }
    }
    lastSaved = { key: squash(v.name) + '|' + squash(v.company), t: Date.now() };
    state.scan = { phase: 'scan', data: null }; renderScan();
  };
}

// ===== excel export (used by the Leads tab for every user, and by the Admin tab) =====
async function doExport(btn) { btn.disabled = true; const t = btn.textContent; btn.innerHTML = '<span class="spin"></span> Preparing…'; try { const n = await exportXlsx(); toast(`Exported ${n} lead${n === 1 ? '' : 's'}`); } catch (e) { toast(e.message || 'Export failed', true); } btn.disabled = false; btn.textContent = t; }

// ===== leads tab =====
function renderLeads() {
  const F = state.filter;
  $('#main').innerHTML = `<div class="card"><div class="row"><input class="grow" id="q" type="search" placeholder="Search name, company, notes" value="${esc(F.q)}">
    <select id="ft" class="grow"><option value="">All topics</option>${state.topics.map((t) => `<option value="${esc(t.id)}" ${F.topic === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    <select id="fh" class="grow"><option value="">All temps</option>${['Hot', 'Warm', 'Cold'].map((t) => `<option ${F.temperature === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <label class="sw" style="margin:0"><input type="checkbox" id="fm" style="width:auto" ${F.mine ? 'checked' : ''}> Mine only</label><button class="btn sec" id="xlL">Export Excel</button></div></div>
    <div id="pending" class="pending" style="display:none"></div><div class="card" id="ll"></div>`;
  $('#q').oninput = (e) => { F.q = e.target.value; paintLeads(); };
  $('#ft').onchange = (e) => { F.topic = e.target.value; paintLeads(); };
  $('#fh').onchange = (e) => { F.temperature = e.target.value; paintLeads(); };
  $('#fm').onchange = (e) => { F.mine = e.target.checked; paintLeads(); };
  $('#xlL').onclick = () => doExport($('#xlL'));
  updatePending(); paintLeads();
}
function filtered() {
  const F = state.filter, q = F.q.toLowerCase();
  return state.leads.filter((l) => (!F.topic || l.topic_id === F.topic) && (!F.temperature || l.temperature === F.temperature) && (!F.mine || l.user_id === state.user.id) &&
    (!q || [l.name, l.company, l.notes].some((x) => (x || '').toLowerCase().includes(q))));
}
function leadRow(l) {
  const can = true;
  return `<div class="lead"><span class="badge ${l.temperature}">${l.temperature}</span><div class="info"><div class="nm">${esc(l.name || l.company || '(no name)')}</div>
    <div class="sub">${esc(l.company)}</div>
    ${l.notes ? `<div class="nt">${esc(l.notes)}</div>` : ''}<div class="sub" style="margin-top:4px"><span class="tag">${esc(l.topic)}</span>${esc(l.captured_by)} · ${esc(fmtTime(l.created_at))}</div></div>
    ${can ? `<button class="btn sec sm" data-edit="${esc(l.id)}">Edit</button>` : ''}</div>`;
}
function paintLeads() {
  const el = $('#ll'); if (!el) return; const list = filtered();
  el.innerHTML = `<h2>${list.length} lead${list.length === 1 ? '' : 's'}</h2>${list.slice(0, 300).map(leadRow).join('') || '<p class="muted">No leads yet.</p>'}`;
  el.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editLead(b.dataset.edit)));
}
function editLead(id) {
  const l = state.leads.find((x) => x.id === id); if (!l) return; let temp = l.temperature;
  modal(`<h2>Edit lead</h2>${leadFormHTML(l, { topicSelect: l.topic_id, temp, notes: l.notes })}<p class="err" id="fe"></p>
    <div class="row" style="margin-top:12px"><button class="btn danger" id="del">Delete</button><button class="btn sec" id="cx">Cancel</button><button class="btn grow" id="sv">Save</button></div>`, (o, close) => {
    bindTemps(o, () => temp, (t) => (temp = t));
    $('#cx', o).onclick = close;
    $('#sv', o).onclick = async () => {
      try { const u = await api('/leads/' + id, { method: 'PUT', body: { ...readForm(o), temperature: temp, topic_id: $('#f_topic', o).value } }); const i = state.leads.findIndex((x) => x.id === id); if (i >= 0) state.leads[i] = u; toast('Updated'); close(); paintLeads(); }
      catch (e) { $('#fe', o).textContent = e.message; }
    };
    $('#del', o).onclick = async () => {
      if (!confirm('Delete this lead permanently?')) return;
      try { await api('/leads/' + id, { method: 'DELETE' }); state.leads = state.leads.filter((x) => x.id !== id); toast('Deleted'); close(); paintLeads(); }
      catch (e) { $('#fe', o).textContent = e.message; }
    };
  });
}

// ===== admin tab =====
async function renderAdmin() {
  const main = $('#main');
  main.innerHTML = `<div class="card"><div class="row"><h2 style="margin:0;flex:1">Dashboard</h2><button class="btn" id="xl">Export Excel (.xlsx)</button></div></div>
    <div id="stats"></div>
    <div class="card"><h2>Demo topics</h2><div id="tl"></div><div class="row" style="margin-top:10px"><input class="grow" id="nt" placeholder="New topic name"><button class="btn" id="at">Add topic</button></div></div>
`;
  $('#xl').onclick = async () => { const b = $('#xl'); b.disabled = true; const t = b.textContent; b.innerHTML = '<span class="spin"></span> Preparing…'; try { const n = await exportXlsx(); toast(`Exported ${n} lead${n === 1 ? '' : 's'}`); } catch (e) { toast(e.message || 'Export failed', true); } b.disabled = false; b.textContent = t; };
  $('#at').onclick = async () => {
    const name = $('#nt').value.trim(); if (!name) return;
    try { await api('/admin/topics', { method: 'POST', body: { name } }); $('#nt').value = ''; await loadTopics(); paintTopics(); toast('Topic added'); } catch (e) { toast(e.message, true); }
  };
  await loadTopics(true); paintTopics(); loadAdminStats();
}
async function loadTopics(all) {
  try { state.topics = await api('/topics' + (all && state.tab === 'admin' ? '?all=1' : '')); store.set('topics', state.topics.filter((t) => t.active !== 0)); } catch { state.topics = store.get('topics', []); }
  if (state.topicId && !state.topics.some((t) => t.id === state.topicId && t.active !== 0)) { state.topicId = null; store.del('topic'); }
}
function paintTopics() {
  const el = $('#tl'); if (!el) return;
  el.innerHTML = state.topics.map((t) => `<div class="row" style="padding:6px 0;border-top:1px solid var(--line)"><span class="grow" style="${Number(t.active) ? '' : 'opacity:.5;text-decoration:line-through'}">${esc(t.name)}</span>
    <button class="btn sec sm" data-ren="${esc(t.id)}">Rename</button><button class="btn sec sm" data-tog="${esc(t.id)}">${Number(t.active) ? 'Disable' : 'Enable'}</button></div>`).join('');
  el.querySelectorAll('[data-ren]').forEach((b) => (b.onclick = async () => { const t = state.topics.find((x) => x.id === b.dataset.ren); const name = prompt('Rename topic', t.name); if (!name) return; try { await api('/admin/topics/' + t.id, { method: 'PUT', body: { name } }); await loadTopics(true); paintTopics(); } catch (e) { toast(e.message, true); } }));
  el.querySelectorAll('[data-tog]').forEach((b) => (b.onclick = async () => { const t = state.topics.find((x) => x.id === b.dataset.tog); try { await api('/admin/topics/' + t.id, { method: 'PUT', body: { active: !Number(t.active) } }); await loadTopics(true); paintTopics(); } catch (e) { toast(e.message, true); } }));
}
async function loadAdminStats() {
  try {
    const s = await api('/admin/stats'); const el = $('#stats'); if (!el) return;
    const t = (k) => (s.byTemp.find((x) => x.k === k) || { n: 0 }).n; const max = Math.max(1, ...s.byTopic.map((x) => x.n));
    const bars = (rows, hot) => rows.map((r) => `<div class="row" style="justify-content:space-between"><span>${esc(r.k)}</span><b>${r.n}${hot ? ` <span class="muted">(${r.hot} hot)</span>` : ''}</b></div><div class="bar"><i style="width:${(r.n / max) * 100}%"></i></div>`).join('') || '<p class="muted">No data</p>';
    el.innerHTML = `<div class="stats"><div class="stat"><span class="muted">Total leads</span><b>${s.total}</b></div><div class="stat"><span class="muted" style="color:var(--hot)">Hot</span><b>${t('Hot')}</b></div>
      <div class="stat"><span class="muted" style="color:var(--warm)">Warm</span><b>${t('Warm')}</b></div><div class="stat"><span class="muted" style="color:var(--cold)">Cold</span><b>${t('Cold')}</b></div></div>
      <div class="grid2"><div class="card"><h2>By topic</h2>${bars(s.byTopic, true)}</div><div class="card"><h2>By team member</h2>${bars(s.byUser.filter((u) => u.n))}</div></div>`;
  } catch {}
}
