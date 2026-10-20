// Sign-in against the eposwala login API: POST {AUTH_API_BASE}/login.
// The account is bound on the server to one device (deviceId). After a successful online login the session
// { token, expiresAt, username } is kept in localStorage and the app works offline until expiresAt.
// Passwords are never stored.
export const AUTH_API_BASE = 'https://eposwala.com/api';
export const SUPPORT_PHONE = '0302-8863131';

const SESSION_KEY = 'parkpk.session';
const DEVICE_KEY = 'parkpk.deviceId';

const ERRORS = {
  missing_fields: 'Enter your username and password.',
  invalid_credentials: 'Wrong username or password.',
  device_mismatch: `This account is already active on another phone. Call ${SUPPORT_PHONE} for help.`,
  account_disabled: `This account has been disabled. Call ${SUPPORT_PHONE} for help.`,
};
const GENERIC = 'Login failed. Try again.';

let current = null;

// Stable per-browser id. The server binds the account to it, so it must not change.
function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}

const isValid = (s) => !!(s && typeof s.token === 'string' && s.token && typeof s.username === 'string' && Number(s.expiresAt) > Date.now());

// Returns { user } if a valid session exists, otherwise { user: null, reason? }.
export function restoreSession() {
  const s = readSession();
  if (!s) return { user: null };
  if (!isValid(s)) {
    localStorage.removeItem(SESSION_KEY);
    current = null;
    return { user: null, reason: 'Your session has expired. Connect to the internet and sign in again.' };
  }
  current = { username: s.username };
  return { user: current };
}

export const user = () => current;

// True once the signed-in session has run out (checked while the app is open).
export const sessionExpired = () => !!current && !isValid(readSession());

export async function login(username, password) {
  username = String(username ?? '').trim();
  password = String(password ?? '');
  if (!username || !password) throw new Error(ERRORS.missing_fields);
  if (!navigator.onLine) throw new Error('Internet connection is required to sign in.');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(`${AUTH_API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, deviceId: deviceId() }),
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } catch {
    throw new Error('Could not reach the login server. Check your internet connection and try again.');
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(ERRORS[data?.error] || GENERIC);

  const session = { token: data?.token, expiresAt: Number(data?.expiresAt), username: data?.username };
  if (!isValid(session)) throw new Error(GENERIC);
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  current = { username: session.username };
  return current;
}

// The API has no logout endpoint, so this only clears the local session. The device binding stays on the server.
export function logout() {
  localStorage.removeItem(SESSION_KEY);
  current = null;
}
