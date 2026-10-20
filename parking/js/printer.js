// Receipt printing: Bluetooth thermal printers (Web Bluetooth, Chrome/Edge), RawBT (Android app) and the phone print dialog.
const KEY = 'parkpk.printer';

// Known ESC/POS Bluetooth LE service/characteristic pairs. Each service must also be listed as optional, or the browser refuses it.
const CHANNELS = [
  ['000018f0-0000-1000-8000-00805f9b34fb', '00002af1-0000-1000-8000-00805f9b34fb'],
  ['e7810a71-73ae-499d-8c15-faa9aef0c3f2', 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f'],
  ['49535343-fe7d-4ae5-8fa9-9fafd205e455', '49535343-8841-43f4-a8d4-ecbe34729bb3'],
  ['0000ff00-0000-1000-8000-00805f9b34fb', '0000ff02-0000-1000-8000-00805f9b34fb'],
  ['0000ae30-0000-1000-8000-00805f9b34fb', '0000ae01-0000-1000-8000-00805f9b34fb'],
  ['0000ffe0-0000-1000-8000-00805f9b34fb', '0000ffe1-0000-1000-8000-00805f9b34fb'],
  ['0000fee7-0000-1000-8000-00805f9b34fb', '0000fec7-0000-1000-8000-00805f9b34fb'],
];
const SERVICES = [...new Set(CHANNELS.map(([svc]) => svc))];
const CHUNK = 20; // small chunks work on cheap printers with tiny buffers

let device = null;
let characteristic = null;
let queue = Promise.resolve(); // print jobs run one after another

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const supported = () => !!navigator.bluetooth && window.isSecureContext;
export const isConnected = () => !!(device?.gatt?.connected && characteristic);
export const printerName = () => (isConnected() ? device.name || 'Bluetooth printer' : '');

async function findWritable(server) {
  for (const [svcId, chId] of CHANNELS) {
    try {
      const ch = await (await server.getPrimaryService(svcId)).getCharacteristic(chId);
      if (ch.properties.write || ch.properties.writeWithoutResponse) return ch;
    } catch { /* this printer does not have that service */ }
  }
  const services = await server.getPrimaryServices().catch(() => []);
  for (const svc of services) {
    const chars = await svc.getCharacteristics().catch(() => []);
    const ch = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
    if (ch) return ch;
  }
  throw new Error('No print channel found. Is this an ESC/POS Bluetooth printer?');
}

async function attach(dev) {
  device = dev;
  dev.addEventListener('gattserverdisconnected', () => { characteristic = null; });
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const server = dev.gatt.connected ? dev.gatt : await dev.gatt.connect();
      characteristic = await findWritable(server);
      localStorage.setItem(KEY, dev.id);
      return;
    } catch (e) {
      lastErr = e;
      await wait(400 * (i + 1));
    }
  }
  throw lastErr;
}

// Must be called from a tap: the browser shows its own device picker.
export async function connect() {
  if (!supported()) throw new Error('Bluetooth needs Chrome or Edge over HTTPS (not available on iPhone).');
  let dev;
  try {
    dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
  } catch (e) {
    if (e.name === 'NotFoundError') throw new Error('No printer selected.');
    throw new Error(`Bluetooth error: ${e.message}`);
  }
  await attach(dev);
  return printerName();
}

// Re-use a printer the browser already has permission for, without the picker.
async function ensureConnected() {
  if (isConnected()) return;
  if (!device && navigator.bluetooth?.getDevices) {
    const id = localStorage.getItem(KEY);
    const known = (await navigator.bluetooth.getDevices().catch(() => [])).find((d) => d.id === id);
    if (known) device = known;
  }
  if (device) { try { await attach(device); } catch { /* handled below */ } }
  if (!isConnected()) throw new Error('Printer is not connected. Tap "Connect Bluetooth" in Settings.');
}

async function send(bytes) {
  const c = characteristic;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const part = bytes.slice(i, i + CHUNK);
    if (c.properties.write) await c.writeValueWithResponse(part);
    else { await c.writeValueWithoutResponse(part); await wait(15); }
  }
}

export function printBytes(bytes) {
  const job = queue.then(async () => {
    await ensureConnected();
    try { await send(bytes); }
    catch { characteristic = null; throw new Error('Printer connection dropped. Check that it is on and nearby.'); }
  });
  queue = job.catch(() => {});
  return job;
}

// RawBT (Android): hands the ESC/POS bytes to the RawBT app, which prints them over classic Bluetooth.
export function viaRawBT(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  location.href = `intent:base64,${btoa(bin)}#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;`;
}

// Phone print dialog: works with any printer the phone can print to.
export function viaBrowser(html, paper) {
  const area = document.getElementById('print-area');
  area.innerHTML = html;
  area.style.setProperty('--paper', `${Number(paper) - 6}mm`);
  let style = document.getElementById('print-size');
  if (!style) {
    style = document.createElement('style');
    style.id = 'print-size';
    document.head.append(style);
  }
  style.textContent = `@page { size: ${paper}mm auto; margin: 2mm; }`;
  window.addEventListener('afterprint', () => { area.innerHTML = ''; }, { once: true });
  setTimeout(() => window.print(), 60);
}
