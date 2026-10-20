// Receipt content is described once as a list of lines, then drawn as HTML (phone print dialog)
// or encoded as ESC/POS bytes (Bluetooth / RawBT thermal printers).
const pad2 = (n) => String(n).padStart(2, '0');

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmtRs = (n) => `Rs ${Number(n || 0).toLocaleString('en-US')}`;
export const ticketLabel = (no) => `#${String(no).padStart(4, '0')}`;
export const fmtDate = (ms) => { const d = new Date(ms); return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`; };
export const fmtTime = (ms) => {
  const d = new Date(ms);
  const h = d.getHours();
  return `${h % 12 || 12}:${pad2(d.getMinutes())} ${h >= 12 ? 'PM' : 'AM'}`;
};
export const duration = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
};

// Entry receipt, handed to the customer when the vehicle is parked.
export function entryOps(t, s, catName) {
  return [
    { c: s.lotName, big: true, bold: true },
    ...(s.address ? [{ c: s.address }] : []),
    { hr: true },
    { c: 'PARKING TICKET', bold: true },
    { lr: ['Ticket no', ticketLabel(t.no)], bold: true },
    { lr: ['Date', fmtDate(t.inAt)] },
    { lr: ['Time in', fmtTime(t.inAt)] },
    { lr: ['Vehicle', catName] },
    { lr: ['Number', t.vehicleNo || '-'] },
    { hr: true },
    { lr: ['FEE PAID', fmtRs(t.fee)], bold: true },
    { hr: true },
    { c: 'Keep this receipt safe.' },
    { c: 'Show it when you collect your vehicle.' },
    ...(s.footer ? [{ c: s.footer }] : []),
  ];
}

// Exit slip, printed when the vehicle is released.
export function exitOps(t, s, catName) {
  return [
    { c: s.lotName, big: true, bold: true },
    { hr: true },
    { c: 'VEHICLE RELEASED', bold: true },
    { lr: ['Ticket no', ticketLabel(t.no)] },
    { lr: ['Vehicle', catName] },
    { lr: ['Number', t.vehicleNo || '-'] },
    { lr: ['Time in', `${fmtDate(t.inAt)} ${fmtTime(t.inAt)}`] },
    { lr: ['Time out', `${fmtDate(t.outAt)} ${fmtTime(t.outAt)}`] },
    { lr: ['Parked for', duration(t.outAt - t.inAt)] },
    { hr: true },
    { lr: ['Fee paid', fmtRs(t.fee)], bold: true },
    { hr: true },
    { c: 'Thank you! Drive safely.' },
  ];
}

export function testOps(s, paper, printerLabel) {
  return [
    { c: 'TEST PRINT', big: true, bold: true },
    { c: s.lotName },
    { hr: true },
    { lr: ['Paper', `${paper} mm`] },
    { lr: ['Printer', printerLabel] },
    { hr: true },
    { c: 'Printer is working.', bold: true },
  ];
}

const wrap = (text, width) => {
  const lines = [];
  let cur = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if ((cur + ' ' + word).trim().length > width) {
      if (cur) lines.push(cur);
      cur = word.slice(0, width);
    } else cur = (cur + ' ' + word).trim();
  }
  if (cur || !lines.length) lines.push(cur);
  return lines;
};

const row = (l, r, width) => {
  const space = width - l.length - r.length;
  return space >= 1 ? l + ' '.repeat(space) + r : `${l.slice(0, Math.max(0, width - r.length - 1))} ${r}`;
};

// ESC/POS bytes. Non-ASCII characters print as "?" (thermal printers have no Urdu font here).
export function toEscPos(ops, paper = 58) {
  const cols = Number(paper) === 80 ? 48 : 32;
  const out = [0x1b, 0x40]; // initialise printer
  const put = (s) => { for (const ch of String(s)) { const c = ch.charCodeAt(0); out.push(c < 128 ? c : 0x3f); } };
  const line = (s) => { put(s); out.push(0x0a); };
  for (const op of ops) {
    if (op.hr) { line('-'.repeat(cols)); continue; }
    const width = op.big ? Math.floor(cols / 2) : cols;
    out.push(0x1b, 0x61, op.lr ? 0 : 1); // align left for label/value rows, centre for text
    out.push(0x1b, 0x45, op.bold ? 1 : 0); // bold
    out.push(0x1d, 0x21, op.big ? 0x11 : 0x00); // double width and height
    if (op.lr) line(row(op.lr[0], op.lr[1], width));
    else for (const l of wrap(op.c, width)) line(l);
    out.push(0x1d, 0x21, 0x00, 0x1b, 0x45, 0x00);
  }
  out.push(0x1b, 0x61, 0x00, 0x1b, 0x64, 0x04); // left align, feed 4 lines
  out.push(0x1d, 0x56, 0x42, 0x00); // partial cut (ignored by printers without a cutter)
  return new Uint8Array(out);
}

export function toHTML(ops) {
  return `<div class="rcpt">${ops.map((op) => {
    if (op.hr) return '<div class="rhr"></div>';
    if (op.lr) return `<div class="rlr${op.bold ? ' b' : ''}"><span>${esc(op.lr[0])}</span><span>${esc(op.lr[1])}</span></div>`;
    return `<div class="rc${op.big ? ' big' : ''}${op.bold ? ' b' : ''}">${esc(op.c)}</div>`;
  }).join('')}</div>`;
}
