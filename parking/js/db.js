// Local storage for parking tickets (IndexedDB). Everything stays on the phone or PC; no login needed.
const NAME = 'parkpk_lot';

let dbp = null;

export function openDB() {
  dbp ??= new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('This browser cannot store data (IndexedDB missing).'));
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('tickets', { keyPath: 'no' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error); };
  });
  return dbp;
}

const request = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const finished = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error || new Error('Save was cancelled. Please try again.'));
});

// Creates a ticket with the next number. The counter and the ticket are written in one transaction,
// so two saves can never get the same number and a failed save does not use a number up.
export async function addTicket(fields) {
  const db = await openDB();
  const tx = db.transaction(['tickets', 'meta'], 'readwrite');
  const last = await request(tx.objectStore('meta').get('seq'));
  const ticket = { ...fields, no: (last?.value ?? 0) + 1 };
  tx.objectStore('meta').put({ key: 'seq', value: ticket.no });
  tx.objectStore('tickets').add(ticket);
  await finished(tx);
  return ticket;
}

// Marks a ticket as left. `expectStatus` stops a vehicle being released twice.
export async function updateTicket(no, patch, expectStatus) {
  const db = await openDB();
  const tx = db.transaction('tickets', 'readwrite');
  const store = tx.objectStore('tickets');
  const current = await request(store.get(no));
  if (!current) throw new Error('Ticket not found.');
  if (expectStatus && current.status !== expectStatus) throw new Error('This vehicle has already left.');
  const next = { ...current, ...patch };
  store.put(next);
  await finished(tx);
  return next;
}

export async function allTickets() {
  const db = await openDB();
  return request(db.transaction('tickets').objectStore('tickets').getAll());
}

export async function clearAll() {
  const db = await openDB();
  const tx = db.transaction(['tickets', 'meta'], 'readwrite');
  tx.objectStore('tickets').clear();
  tx.objectStore('meta').clear();
  await finished(tx);
}
