'use strict';
// Standalone data layer: everything is stored in this browser (localStorage). No server, no database, no accounts elsewhere.
// It implements the same api() routes the UI uses, so app.js is identical to the cloud versions.
class NetErr extends Error {}
const configured = true;
const DB_KEY = 'lcl_db', TEMPS = ['Hot', 'Warm', 'Cold'];
const SEED_TOPICS = ['Cyber Resiliency', 'FlashSystem.ai', 'IRE', 'Storage Insights'];
const nowIso = () => new Date().toISOString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const httpErr = (status, message) => { const e = new Error(message); e.status = status; return e; };
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function load() {
  try { const d = JSON.parse(localStorage.getItem(DB_KEY)); if (d && d.users) return d; } catch (e) { /* fall through */ }
  return { ver: 1, users: [], leads: [], topics: SEED_TOPICS.map((n) => ({ id: uid(), name: n, active: 1, created_at: nowIso() })) };
}
let db = load();
const save = () => { db.ver++; localStorage.setItem(DB_KEY, JSON.stringify(db)); };
window.addEventListener('storage', (e) => { if (e.key === DB_KEY) { db = load(); if (poll) poll.tick(); } });   // another tab changed the data

// One person per device: a local profile (name only). No passwords, no accounts, no server.
const hasToken = () => db.users.length > 0;
const pub = (u) => ({ id: u.id, username: u.username, name: u.name, role: 'admin' });
const me = () => { const u = db.users[0]; if (!u) throw httpErr(401, 'Not signed in'); return u; };
const firstRun = () => db.users.length === 0;
const leadOut = (l) => ({ ...l });
const listLeads = (limit) => db.leads.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)).slice(0, limit).map(leadOut);
const listTopics = (all) => db.topics.filter((t) => all || t.active).map((t) => ({ id: t.id, name: t.name, active: t.active ? 1 : 0 })).sort((a, b) => a.name.localeCompare(b.name));
function fields(b) {
  const t = TEMPS.find((x) => x.toLowerCase() === String(b.temperature || '').toLowerCase());
  return { name: clip(b.name, 200), company: clip(b.company, 200), notes: clip(b.notes, 4000), temperature: t,
    source: ['ocr', 'manual'].includes(b.source) ? b.source : 'manual' };
}
const needContent = (f) => { if (!f.temperature) throw httpErr(400, 'Select Hot, Warm or Cold'); if (!f.name && !f.company) throw httpErr(400, 'Enter at least a name or company'); };

async function handle(method, p, q, b) {
  const key = method + ' ' + p.replace(/^(\/leads|\/admin\/users|\/admin\/topics)\/([^/]+)$/, (_, base) => base + '/:id'), id = (p.match(/^\/(?:leads|admin\/users|admin\/topics)\/([^/]+)$/) || [])[1];
  if (key === 'POST /login') {
    const name = clip(b.name, 80); if (!name) throw httpErr(400, 'Please enter your name');
    let u = db.users[0];
    if (u) { u.name = name; db.leads.forEach((l) => { if (l.user_id === u.id) l.captured_by = name; }); }
    else { u = { id: uid(), username: 'me', name, role: 'admin', active: 1, created_at: nowIso() }; db.users.push(u); }
    save(); return pub(u);
  }
  const user = me(), admin = () => { if (user.role !== 'admin') throw httpErr(403, 'Admin only'); };
  switch (key) {
    case 'GET /me': return pub(user);
    case 'POST /logout': return { ok: true };
    case 'GET /sync': return String(q.ver) === String(db.ver) ? { changed: false, ver: db.ver } : { changed: true, ver: db.ver, leads: listLeads(1000), topics: listTopics(user.role === 'admin') };
    case 'GET /topics': return listTopics(q.all === '1' && user.role === 'admin');
    case 'GET /leads': return listLeads(Math.min(Number(q.limit) || 1000, 10000));
    case 'POST /leads': {
      const f = fields(b); needContent(f); const cid = clip(b.client_id, 80);
      if (cid) { const dup = db.leads.find((l) => l.client_id === cid); if (dup) return leadOut(dup); }
      const t = db.topics.find((x) => x.id === String(b.topic_id || '') && x.active); if (!t) throw httpErr(400, 'Select a valid demo topic');
      const ts = nowIso(), l = { id: uid(), client_id: cid, created_at: ts, updated_at: ts, topic_id: t.id, topic: t.name, temperature: f.temperature, name: f.name, company: f.company, notes: f.notes, captured_by: user.name, user_id: user.id, source: f.source };
      db.leads.push(l); save(); return leadOut(l);
    }
    case 'PUT /leads/:id': {
      const l = db.leads.find((x) => x.id === id); if (!l) throw httpErr(404, 'Not found');
      if (l.user_id !== user.id && user.role !== 'admin') throw httpErr(403, 'Not your lead');
      const f = fields({ ...l, ...b, source: l.source }); needContent(f);
      if (b.topic_id && b.topic_id !== l.topic_id) { const t = db.topics.find((x) => x.id === b.topic_id); if (!t) throw httpErr(400, 'Invalid topic'); l.topic_id = t.id; l.topic = t.name; }
      Object.assign(l, { name: f.name, company: f.company, notes: f.notes, temperature: f.temperature, updated_at: nowIso() });
      save(); return leadOut(l);
    }
    case 'DELETE /leads/:id': {
      const l = db.leads.find((x) => x.id === id); if (!l) throw httpErr(404, 'Not found');
      if (l.user_id !== user.id && user.role !== 'admin') throw httpErr(403, 'Not your lead');
      db.leads = db.leads.filter((x) => x !== l); save(); return { ok: true };
    }
    case 'POST /admin/topics': {
      admin(); const name = clip(b.name, 120); if (!name) throw httpErr(400, 'Name required');
      if (db.topics.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw httpErr(409, 'Topic already exists');
      db.topics.push({ id: uid(), name, active: 1, created_at: nowIso() }); save(); return { ok: true };
    }
    case 'PUT /admin/topics/:id': {
      admin(); const t = db.topics.find((x) => x.id === id); if (!t) throw httpErr(404, 'Not found');
      const name = b.name !== undefined ? clip(b.name, 120) : t.name; if (!name) throw httpErr(400, 'Name required');
      if (db.topics.some((x) => x !== t && x.name.toLowerCase() === name.toLowerCase())) throw httpErr(409, 'Topic already exists');
      if (name !== t.name) db.leads.forEach((l) => { if (l.topic_id === t.id) l.topic = name; });
      t.name = name; if (b.active !== undefined) t.active = b.active ? 1 : 0; save(); return { ok: true };
    }
    case 'GET /admin/stats': {
      admin(); const cnt = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
      const byT = cnt(db.leads, (l) => l.temperature), byTop = cnt(db.leads, (l) => l.topic_id), hot = cnt(db.leads.filter((l) => l.temperature === 'Hot'), (l) => l.topic_id), byU = cnt(db.leads, (l) => l.user_id);
      return { total: db.leads.length, byTemp: Object.keys(byT).map((k) => ({ k, n: byT[k] })),
        byTopic: db.topics.map((t) => ({ k: t.name, n: byTop[t.id] || 0, hot: hot[t.id] || 0 })).sort((a, b) => b.n - a.n), byUser: db.users.map((u) => ({ k: u.name, n: byU[u.id] || 0 })).sort((a, b) => b.n - a.n) };
    }
    default: throw httpErr(404, 'Not found');
  }
}
async function api(path, opts = {}) {
  const [p, qs] = path.split('?');
  const out = await handle(opts.method || 'GET', p, Object.fromEntries(new URLSearchParams(qs || '')), opts.body || {}).catch((e) => {
    throw e;
  });
  return JSON.parse(JSON.stringify(out));
}

// ---- live refresh: re-render when this device's data changes (also across tabs) ----
let poll = null;
function startSync(h) {
  stopSync();
  const st = (poll = { ver: '', dead: false });
  st.tick = async () => { if (st.dead) return; try { const r = await api('/sync?ver=' + encodeURIComponent(st.ver)); h.onStatus(true); if (r.changed) { st.ver = r.ver; h.onData(r); } } catch (e) { /* signed out */ } };
  st.tick();
}
function stopSync() { if (poll) { poll.dead = true; poll = null; } }
function syncNow() { if (poll) poll.tick(); }

// ---- Excel export, generated in the browser from the live data ----
async function exportXlsx() {
  if (!window.ExcelJS) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/exceljs.min.js'; s.onload = res; s.onerror = () => rej(new Error('Excel library failed to load')); document.head.appendChild(s); });
  const [leads, topics] = await Promise.all([api('/leads?limit=10000'), api('/topics?all=1')]);
  const TEMPS = ['Hot', 'Warm', 'Cold'];
  const wb = new ExcelJS.Workbook(); wb.creator = 'Lead Capture';
  const ws = wb.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Captured At (UTC)', key: 'created_at', width: 22 }, { header: 'Demo Topic', key: 'topic', width: 24 }, { header: 'Temperature', key: 'temperature', width: 13 },
    { header: 'Name', key: 'name', width: 24 }, { header: 'Company', key: 'company', width: 26 },
    { header: 'Notes', key: 'notes', width: 50 },
    { header: 'Captured By', key: 'captured_by', width: 20 }, { header: 'Source', key: 'source', width: 10 },
  ];
  const fill = { Hot: 'FFF8B4B4', Warm: 'FFFFE0A3', Cold: 'FFBBD7F5' };
  const safe = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v); // block spreadsheet formula injection
  for (const l of leads) {
    const row = ws.addRow({ ...Object.fromEntries(Object.entries(l).map(([k, v]) => [k, safe(v)])), created_at: String(l.created_at).replace('T', ' ').slice(0, 19) });
    row.getCell('temperature').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill[l.temperature] } };
    row.getCell('notes').alignment = { wrapText: true, vertical: 'top' };
  }
  const hd = ws.getRow(1); hd.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hd.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } }; ws.autoFilter = { from: 'A1', to: 'H1' };
  const sum = wb.addWorksheet('Summary'); sum.addRow(['Demo Topic', 'Total', 'Hot', 'Warm', 'Cold']).font = { bold: true };
  for (const t of topics) { const ls = leads.filter((l) => l.topic_id === t.id); sum.addRow([t.name, ls.length, ...TEMPS.map((x) => ls.filter((l) => l.temperature === x).length)]); }
  sum.addRow(['All topics', leads.length, ...TEMPS.map((x) => leads.filter((l) => l.temperature === x).length)]).font = { bold: true };
  sum.columns.forEach((c, i) => (c.width = i ? 10 : 28));
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = `leads-${new Date().toISOString().slice(0, 10)}.xlsx`; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return leads.length;
}
