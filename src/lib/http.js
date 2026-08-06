/** Small helpers for JSON responses and request parsing. */

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/** Thrown anywhere in a route to produce a clean JSON error. */
export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const bad = (msg, extra) => new ApiError(400, msg, extra);
export const unauthorized = (msg = 'Not signed in') => new ApiError(401, msg);
export const forbidden = (msg = 'Not allowed') => new ApiError(403, msg);
export const notFound = (msg = 'Not found') => new ApiError(404, msg);
export const conflict = (msg) => new ApiError(409, msg);

export async function readJson(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw bad('Expected a JSON body');
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') throw bad('Expected a JSON object');
    return body;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw bad('Body was not valid JSON');
  }
}

/** Whole positive integer, no decimals, within [min, max]. */
export function intField(body, field, { min = 0, max = Number.MAX_SAFE_INTEGER, required = true } = {}) {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw bad(`Missing "${field}"`);
    return null;
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[\s,_]/g, ''));
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw bad(`"${field}" must be a whole number`);
  if (n < min) throw bad(`"${field}" must be at least ${min}`);
  if (n > max) throw bad(`"${field}" must not be more than ${max}`);
  return n;
}

export function strField(body, field, { max = 500, required = false } = {}) {
  const raw = body[field];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    if (required) throw bad(`Missing "${field}"`);
    return null;
  }
  const s = String(raw).trim();
  if (s.length > max) throw bad(`"${field}" must be ${max} characters or fewer`);
  return s;
}

export function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
