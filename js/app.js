import * as DB from './db.js';
import * as Printer from './printer.js';
import * as Auth from './auth.js';
import { entryOps, exitOps, testOps, toEscPos, toHTML, esc, fmtRs, fmtTime, fmtDate, duration, ticketLabel } from './receipt.js';

// Vehicle categories with default rates (Rs). Rates can be changed in Settings.
export const CATS = [
  { id: 'bike', en: 'Motorcycle', ur: 'موٹر سائیکل', icon: '🏍️', rate: 20 },
  { id: 'bicycle', en: 'Bicycle', ur: 'سائیکل', icon: '🚲', rate: 10 },
  { id: 'rickshaw', en: 'Rickshaw', ur: 'رکشہ', icon: '🛺', rate: 30 },
  { id: 'car', en: 'Car', ur: 'کار', icon: '🚗', rate: 50 },
  { id: 'van', en: 'Van / Pickup', ur: 'وین / پک اپ', icon: '🚐', rate: 60 },
  { id: 'bus', en: 'Bus / Truck', ur: 'بس / ٹرک', icon: '🚌', rate: 100 },
  { id: 'other', en: 'Other', ur: 'دیگر', icon: '🅿️', rate: 20 },
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RANGES = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All']];
const SETTINGS_KEY = 'parkpk.settings';

const DEFAULTS = {
  lotName: 'Parking',
  address: '',
  footer: 'Thank you! Drive safely.',
  rates: Object.fromEntries(CATS.map((c) => [c.id, c.rate])),
  paper: 58,
  method: 'bluetooth',
  autoPrint: true,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const sum = (list, fn) => list.reduce((n, x) => n + (Number(fn(x)) || 0), 0);
const catOf = (id) => CATS.find((c) => c.id === id) || CATS[CATS.length - 1];
const rateOf = (id) => Number(settings.rates[id] ?? catOf(id).rate);

let settings = loadSettings();
let tickets = [];
let activeTab = 'park';
let draft = null;
let query = '';
let range = 'today';

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...DEFAULTS, ...saved, rates: { ...DEFAULTS.rates, ...(saved.rates || {}) } };
  } catch {
    return { ...DEFAULTS, rates: { ...DEFAULTS.rates } };
  }
}

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage full or blocked */ }
}

// ---------- Helpers ----------
function toast(msg, kind = 'ok', ms = 2800) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').classList.add('open');
}

function closeSheet() {
  $('#sheet').classList.remove('open');
}

function ask(message, okLabel) {
  return new Promise((resolve) => {
    openSheet(`<div class="ask"><p>${esc(message)}</p>
      <div class="sheet-actions"><button class="btn ghost" id="ask-no">Cancel</button>
      <button class="btn danger" id="ask-yes">${esc(okLabel)}</button></div></div>`);
    $('#ask-no').onclick = () => { closeSheet(); resolve(false); };
    $('#ask-yes').onclick = () => { closeSheet(); resolve(true); };
  });
}

// Sends receipt lines to the chosen method. Bluetooth failures fall back to the phone print dialog.
async function printOps(ops) {
  const { method, paper } = settings;
  if (method === 'rawbt') return Printer.viaRawBT(toEscPos(ops, paper));
  if (method === 'browser') return Printer.viaBrowser(toHTML(ops), paper);
  try {
    await Printer.printBytes(toEscPos(ops, paper));
  } catch (e) {
    toast(`${e.message} Opening phone print instead.`, 'warn', 4500);
    Printer.viaBrowser(toHTML(ops), paper);
  }
}

function normalizePlate(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, ' ').trim().slice(0, 12);
}

function vibrate() { navigator.vibrate?.(25); }

function renderBrand() {
  $('#brand-name').textContent = settings.lotName || 'Parking';
}

function updateChip() {
  const inside = tickets.filter((t) => t.status === 'in').length;
  const el = $('#inside-count');
  if (el.textContent !== String(inside)) {
    el.textContent = inside;
    const chip = $('#inside-chip');
    chip.classList.remove('bump');
    void chip.offsetWidth;
    chip.classList.add('bump');
  }
}

async function reload() {
  try { tickets = await DB.allTickets(); }
  catch (e) { toast(`Storage error: ${e.message}`, 'error', 6000); }
  updateChip();
  if (activeTab === 'exit') renderExit();
  if (activeTab === 'sales') renderSales();
}

// ---------- Tabs ----------
function showTab(name) {
  activeTab = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  window.scrollTo({ top: 0 });
  if (name === 'exit') renderExit();
  if (name === 'sales') renderSales();
  if (name === 'settings') renderSettings();
}

// ---------- Park: choose vehicle, enter number and fee, save & print ----------
function renderCategories() {
  $('#cat-grid').innerHTML = CATS.map((c, i) => `
    <button class="cat-card" style="--i:${i}" data-cat="${c.id}">
      <div class="ico">${c.icon}</div>
      <div class="en">${esc(c.en)}</div>
      <span class="ur">${esc(c.ur)}</span>
      <span class="rate">Rs ${rateOf(c.id)}</span>
    </button>`).join('');
}

function showStep(name) {
  $$('.step').forEach((s) => s.classList.toggle('active', s.id === `step-${name}`));
}

function pickCategory(id) {
  const c = catOf(id);
  draft = { cat: c.id };
  $('#hero').innerHTML = `<span class="hero-ico">${c.icon}</span>
    <div><div class="hero-en">${esc(c.en)}</div><div class="ur">${esc(c.ur)}</div></div>`;
  $('#plate-input').value = '';
  $('#fee-input').value = rateOf(c.id);
  showStep('details');
}

function wirePark() {
  $('#cat-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.cat-card');
    if (card) { vibrate(); pickCategory(card.dataset.cat); }
  });
  $('#btn-back').onclick = () => showStep('category');

  const plate = $('#plate-input');
  plate.addEventListener('input', () => { plate.value = plate.value.toUpperCase(); });

  const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'C'];
  $('#keypad').innerHTML = KEYS.map((k) => `<button class="key" data-k="${k}">${k}</button>`).join('');
  $('#keypad').addEventListener('click', (e) => {
    const key = e.target.closest('.key');
    if (!key) return;
    vibrate();
    const k = key.dataset.k;
    if (k === '⌫') plate.value = plate.value.slice(0, -1);
    else if (k === 'C') plate.value = '';
    else if (plate.value.length < 12) plate.value += k;
  });

  $$('[data-fee]').forEach((b) => {
    b.onclick = () => {
      const f = $('#fee-input');
      f.value = Math.max(0, (Number(f.value) || 0) + Number(b.dataset.fee));
    };
  });

  $('#btn-save').onclick = saveEntry;
}

async function saveEntry() {
  if (!draft) return;
  const btn = $('#btn-save');
  btn.disabled = true;
  try {
    const cat = catOf(draft.cat);
    const ticket = await DB.addTicket({
      cat: cat.id,
      vehicleNo: normalizePlate($('#plate-input').value),
      fee: Math.max(0, Math.round(Number($('#fee-input').value) || 0)),
      inAt: Date.now(),
      outAt: null,
      status: 'in',
    });
    draft = null;
    showStep('category');
    vibrate();
    if (settings.autoPrint) await printOps(entryOps(ticket, settings, cat.en));
    showSuccess(ticket, cat);
    await reload();
  } catch (e) {
    toast(e.message, 'error', 5000);
  } finally {
    btn.disabled = false;
  }
}

function showSuccess(t, cat) {
  openSheet(`
    <div class="success">
      <svg class="check-svg" viewBox="0 0 52 52" aria-hidden="true">
        <circle class="ring" cx="26" cy="26" r="24"/><path class="tick" d="M15 27 l7 7 l15 -16"/>
      </svg>
      <h2>Ticket ${ticketLabel(t.no)}</h2>
      <p class="muted">${cat.icon} ${esc(cat.en)}${t.vehicleNo ? ` · <b>${esc(t.vehicleNo)}</b>` : ''}</p>
      <div class="big-fee">${fmtRs(t.fee)}</div>
      <div class="sheet-actions">
        <button class="btn ghost" id="btn-reprint">🖨️ Print again</button>
        <button class="btn primary" id="btn-next">➕ Next vehicle</button>
      </div>
    </div>`);
  $('#btn-reprint').onclick = () => printOps(entryOps(t, settings, cat.en));
  $('#btn-next').onclick = closeSheet;
}

// ---------- Exit: find a receipt or a vehicle inside, verify, release ----------
function wireExit() {
  $('#search').addEventListener('input', (e) => { query = e.target.value; renderExit(); });
  $('#exit-list').addEventListener('click', (e) => {
    const card = e.target.closest('.card-item');
    if (card) openExit(Number(card.dataset.no));
  });
}

function matches(t, q) {
  const numeric = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : null;
  const plateQ = q.replace(/[\s-]/g, '');
  return (numeric !== null && t.no === numeric)
    || (plateQ !== '' && t.vehicleNo.replace(/[\s-]/g, '').includes(plateQ));
}

function renderExit() {
  const q = query.trim().toUpperCase();
  const newestFirst = (a, b) => b.inAt - a.inAt;
  let list;
  if (!q) {
    list = tickets.filter((t) => t.status === 'in').sort(newestFirst);
    $('#list-title').textContent = `Inside now · ${list.length}`;
  } else {
    list = tickets.filter((t) => matches(t, q)).sort(newestFirst).slice(0, 50);
    $('#list-title').textContent = `Found · ${list.length}`;
  }
  $('#exit-list').innerHTML = list.length
    ? list.map(exitCard).join('')
    : q
      ? '<div class="empty"><span>🔍</span><p>No receipt found</p><small>Check the ticket number, or ask the driver for the vehicle number.</small></div>'
      : '<div class="empty"><span>🎉</span><p>No vehicles inside</p><small>Every vehicle has been released.</small></div>';
}

function exitCard(t, i) {
  const cat = catOf(t.cat);
  const plate = t.vehicleNo ? esc(t.vehicleNo) : '<span class="muted">No number</span>';
  const end = t.outAt ?? Date.now();
  return `
    <button class="card-item" data-no="${t.no}" style="animation-delay:${Math.min(i, 8) * 50}ms">
      <div class="ci-ico">${cat.icon}</div>
      <div class="ci-main">
        <div class="ci-plate">${plate}</div>
        <div class="ci-sub">${ticketLabel(t.no)} · ${esc(cat.en)} · ${fmtTime(t.inAt)} · ${duration(end - t.inAt)}</div>
      </div>
      <div class="ci-right">
        <div class="ci-fee">${fmtRs(t.fee)}</div>
        <span class="badge ${t.status}">${t.status === 'in' ? 'INSIDE' : 'LEFT'}</span>
      </div>
    </button>`;
}

function openExit(no) {
  const t = tickets.find((x) => x.no === no);
  if (!t) return;
  const cat = catOf(t.cat);
  const inside = t.status === 'in';
  openSheet(`
    <div class="verify">
      <div class="verify-head">
        <span>${cat.icon}</span>
        <div>
          <div class="muted">${ticketLabel(t.no)} · ${esc(cat.en)}</div>
          <div class="verify-plate">${t.vehicleNo ? esc(t.vehicleNo) : 'No number'}</div>
        </div>
      </div>
      <div class="kv">
        <div><span>Time in</span><b>${fmtDate(t.inAt)} ${fmtTime(t.inAt)}</b></div>
        <div><span>Parked for</span><b>${duration((t.outAt ?? Date.now()) - t.inAt)}</b></div>
        <div><span>Fee paid</span><b>${fmtRs(t.fee)}</b></div>
      </div>
      ${inside
        ? `<p class="hint">Check that the vehicle number matches before you release it.</p>
           <button class="btn primary big" id="btn-release">✅ Release vehicle & print slip</button>`
        : `<div class="notice">Already left at ${fmtTime(t.outAt)}</div>`}
    </div>`);
  $('#btn-release')?.addEventListener('click', () => releaseVehicle(no));
}

async function releaseVehicle(no) {
  const btn = $('#btn-release');
  btn.disabled = true;
  try {
    const t = await DB.updateTicket(no, { status: 'out', outAt: Date.now() }, 'in');
    tickets = tickets.map((x) => (x.no === no ? t : x));
    closeSheet();
    vibrate();
    toast(`${ticketLabel(no)} released ✅`, 'ok');
    updateChip();
    renderExit();
    if (settings.autoPrint) await printOps(exitOps(t, settings, catOf(t.cat).en));
  } catch (e) {
    toast(e.message, 'error', 4500);
    btn.disabled = false;
  }
}

// ---------- Sales ----------
function rangeStart(r) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (r === '7d') d.setDate(d.getDate() - 6);
  else if (r === '30d') d.setDate(d.getDate() - 29);
  else if (r === 'all') return 0;
  return d.getTime();
}

const short = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

function renderSales() {
  $('#range-chips').innerHTML = RANGES.map(([k, l]) =>
    `<button class="chip-btn ${k === range ? 'on' : ''}" data-r="${k}">${l}</button>`).join('');

  const rows = tickets.filter((t) => t.inAt >= rangeStart(range));
  const income = sum(rows, (t) => t.fee);
  const avg = rows.length ? Math.round(income / rows.length) : 0;
  const inside = tickets.filter((t) => t.status === 'in').length;
  const kpis = [
    ['💰', fmtRs(income), 'Income'],
    ['🚗', rows.length, 'Vehicles'],
    ['🅿️', inside, 'Inside now'],
    ['🧮', fmtRs(avg), 'Average fee'],
  ];
  $('#kpis').innerHTML = kpis.map(([icon, val, label], i) => `
    <div class="kpi" style="--i:${i}">
      <div class="k-ico">${icon}</div><div class="k-val">${val}</div><div class="k-lbl">${label}</div>
    </div>`).join('');

  const perCat = CATS.map((c, i) => {
    const list = rows.filter((t) => t.cat === c.id);
    return { c, i, n: list.length, sum: sum(list, (t) => t.fee) };
  });
  const maxCat = Math.max(1, ...perCat.map((x) => x.sum));
  $('#cat-stats').innerHTML = perCat.map((x) => `
    <div class="cstat">
      <div class="cstat-top"><span>${x.c.icon} ${esc(x.c.en)}</span><b>${x.n} · ${fmtRs(x.sum)}</b></div>
      <div class="cbar"><div style="--w:${((x.sum / maxCat) * 100).toFixed(1)}%;--d:${x.i * 80}ms"></div></div>
    </div>`).join('');

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const start = d.getTime();
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    days.push({ label: DAYS[d.getDay()], sum: sum(tickets.filter((t) => t.inAt >= start && t.inAt < end.getTime()), (t) => t.fee) });
  }
  const maxDay = Math.max(1, ...days.map((d) => d.sum));
  $('#chart').innerHTML = days.map((d, i) => `
    <div class="col">
      <div class="bar" style="--h:${Math.max(3, (d.sum / maxDay) * 100).toFixed(1)}%;--d:${i * 90}ms">
        ${d.sum ? `<span>${short(d.sum)}</span>` : ''}
      </div>
      <small>${d.label}</small>
    </div>`).join('');

  const recent = rows.slice().sort((a, b) => b.inAt - a.inAt).slice(0, 15);
  $('#recent').innerHTML = recent.length
    ? recent.map(exitCard).join('')
    : '<div class="empty"><span>📭</span><p>No entries in this period</p></div>';
}

function wireSales() {
  $('#range-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]');
    if (!b) return;
    range = b.dataset.r;
    renderSales();
  });
  $('#recent').addEventListener('click', (e) => {
    const card = e.target.closest('.card-item');
    if (card) openExit(Number(card.dataset.no));
  });
  $('#btn-export').onclick = exportCSV;
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCSV() {
  if (!tickets.length) return toast('Nothing to export yet.', 'warn');
  const header = ['Ticket', 'Category', 'Vehicle number', 'Date in', 'Time in', 'Time out', 'Duration', 'Fee (Rs)', 'Status'];
  const lines = tickets.slice().sort((a, b) => a.no - b.no).map((t) => {
    const cat = catOf(t.cat).en;
    const out = t.outAt ? `${fmtDate(t.outAt)} ${fmtTime(t.outAt)}` : '';
    return [ticketLabel(t.no), cat, t.vehicleNo, fmtDate(t.inAt), fmtTime(t.inAt), out,
      duration((t.outAt ?? Date.now()) - t.inAt), t.fee, t.status === 'in' ? 'Inside' : 'Left'];
  });
  const csv = [header, ...lines].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const stamp = new Date().toISOString().slice(0, 10);
  download(`parking-${stamp}.csv`, new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  toast('CSV downloaded');
}

// ---------- Settings ----------
function renderSettings() {
  $('#set-lot').value = settings.lotName;
  $('#set-address').value = settings.address;
  $('#set-footer').value = settings.footer;
  $('#set-paper').value = String(settings.paper);
  $('#set-method').value = settings.method;
  $('#set-autoprint').checked = !!settings.autoPrint;
  $('#rates').innerHTML = CATS.map((c) => `
    <label class="rate-row"><span>${c.icon} ${esc(c.en)}</span>
      <input type="number" inputmode="numeric" min="0" data-rate="${c.id}" value="${rateOf(c.id)}"></label>`).join('');
  $('#printer-status').textContent = Printer.isConnected()
    ? `Connected: ${Printer.printerName()}`
    : Printer.supported()
      ? 'No Bluetooth printer connected.'
      : 'Bluetooth is not available in this browser. Use Chrome on Android or Windows, or choose RawBT or Phone print.';
}

function wireSettings() {
  $('#set-lot').addEventListener('input', (e) => { saveSettings({ lotName: e.target.value.trim() || 'Parking' }); renderBrand(); });
  $('#set-address').addEventListener('input', (e) => saveSettings({ address: e.target.value.trim() }));
  $('#set-footer').addEventListener('input', (e) => saveSettings({ footer: e.target.value.trim() }));
  $('#set-paper').addEventListener('change', (e) => saveSettings({ paper: Number(e.target.value) }));
  $('#set-method').addEventListener('change', (e) => saveSettings({ method: e.target.value }));
  $('#set-autoprint').addEventListener('change', (e) => saveSettings({ autoPrint: e.target.checked }));
  $('#rates').addEventListener('change', (e) => {
    const input = e.target.closest('[data-rate]');
    if (!input) return;
    const rates = { ...settings.rates, [input.dataset.rate]: Math.max(0, Math.round(Number(input.value) || 0)) };
    saveSettings({ rates });
    renderCategories();
    toast('Rate saved');
  });

  $('#btn-connect').onclick = async () => {
    try {
      const name = await Printer.connect();
      toast(`Printer connected: ${name}`);
    } catch (e) {
      toast(e.message, 'error', 5000);
    }
    renderSettings();
  };

  $('#btn-test').onclick = () => printOps(testOps(settings, settings.paper, Printer.printerName() || settings.method));

  $('#btn-backup').onclick = () => {
    const data = { app: 'parkpk', exportedAt: new Date().toISOString(), settings, tickets };
    download(`parking-backup-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  };

  $('#btn-erase').onclick = async () => {
    if (!await ask('Erase ALL tickets and sales history? This cannot be undone. Download a backup first.', 'Erase')) return;
    try {
      await DB.clearAll();
      tickets = [];
      updateChip();
      renderSettings();
      toast('All data erased', 'warn');
    } catch (e) {
      toast(e.message, 'error', 5000);
    }
  };
}

// ---------- Sign in ----------
function showLogin(message = '') {
  closeSheet();
  document.body.classList.add('locked');
  $('#login-password').value = '';
  $('#login-error').textContent = message;
  $('#login-username').focus({ preventScroll: true });
}

async function enterApp() {
  document.body.classList.remove('locked');
  $('#account-name').textContent = Auth.user()?.username || '-';
  $('#login-error').textContent = '';
  await reload();
  showTab(activeTab);
}

function wireLogin() {
  const submit = async () => {
    const btn = $('#btn-login');
    btn.disabled = true;
    $('#login-error').textContent = '';
    try {
      await Auth.login($('#login-username').value, $('#login-password').value);
      toast(`Welcome, ${Auth.user().username}`);
      await enterApp();
    } catch (e) {
      $('#login-error').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  };
  $('#btn-login').onclick = submit;
  $('#login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  $('#login-username').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-password').focus(); });

  $('#btn-signout').onclick = async () => {
    if (!await ask('Sign out of this phone? Saved tickets stay on this device.', 'Sign out')) return;
    Auth.logout();
    showLogin();
    toast('Signed out');
  };
}

// The session runs out after the API's expiresAt. Check it while the app is open and when it returns to the foreground.
function watchSession() {
  if (!document.body.classList.contains('locked') && Auth.sessionExpired()) {
    showLogin('Your session has expired. Connect to the internet and sign in again.');
  }
}

// ---------- Boot ----------
function wireTabs() {
  $$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
}

async function boot() {
  renderBrand();
  renderCategories();
  wireTabs();
  wirePark();
  wireExit();
  wireSales();
  wireSettings();
  wireLogin();
  setInterval(() => { if (activeTab === 'exit') renderExit(); }, 30000);
  setInterval(watchSession, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) watchSession(); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  const { user, reason } = Auth.restoreSession();
  if (user) await enterApp();
  else showLogin(reason || '');
}

boot();
