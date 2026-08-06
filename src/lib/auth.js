/**
 * Session tokens, signed with HMAC-SHA256 via WebCrypto.
 *
 * Format: base64url(JSON payload) + "." + base64url(signature)
 * Stateless, so there is no session table to keep clean.
 *
 * Two kinds of session exist:
 *   - player: issued to an in-game User Application, sent as `Authorization: Bearer <token>`
 *   - admin:  issued after a password login, sent as an HttpOnly cookie
 */

import { ApiError, parseCookies, unauthorized } from './http.js';

const PLAYER_TTL = 12 * 60 * 60; // 12h - a long game session
const ADMIN_TTL = 8 * 60 * 60;   // 8h
export const ADMIN_COOKIE = 'tt_admin';

const enc = new TextEncoder();

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  if (!secret) throw new ApiError(500, 'SESSION_SECRET is not configured');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function signToken(secret, payload, ttlSeconds) {
  const body = { ...payload, iat: nowSeconds(), exp: nowSeconds() + ttlSeconds };
  const head = b64urlEncode(enc.encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(head));
  return `${head}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyToken(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [head, sig] = token.split('.');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(sig), enc.encode(head));
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(head)));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp < nowSeconds()) return null;
  return payload;
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export const issuePlayerToken = (secret, payload) =>
  signToken(secret, { ...payload, kind: 'player' }, PLAYER_TTL);

export const issueAdminToken = (secret) => signToken(secret, { kind: 'admin' }, ADMIN_TTL);

/** Reads and validates the player session from the Authorization header. */
export async function requirePlayer(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? await verifyToken(env.SESSION_SECRET, token) : null;
  if (!payload || payload.kind !== 'player') {
    throw unauthorized('Your session expired. Close and reopen the app with F1.');
  }
  return payload;
}

/** Reads and validates the admin session cookie. */
export async function requireAdmin(request, env) {
  const token = parseCookies(request)[ADMIN_COOKIE];
  const payload = token ? await verifyToken(env.SESSION_SECRET, token) : null;
  if (!payload || payload.kind !== 'admin') throw unauthorized('Sign in to the admin panel');
  return payload;
}

export function adminCookie(token, secure) {
  const parts = [
    `${ADMIN_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${ADMIN_TTL}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearAdminCookie(secure) {
  const parts = [`${ADMIN_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Constant-time string compare, so a wrong password leaks no timing signal. */
export function timingSafeEqual(a, b) {
  const ab = enc.encode(String(a ?? ''));
  const bb = enc.encode(String(b ?? ''));
  // Compare lengths without early return by folding into the accumulator.
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
