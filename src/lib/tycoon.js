/**
 * Client for the Transport Tycoon game API.
 * Docs: https://dash.tycoon.community/wiki/index.php/API
 *
 * Two transports, tried in order:
 *
 *   1. The cfx.re proxy over HTTPS/443 - a plain fetch(). Fast when it is up,
 *      but the servers.json notice warns it "may not always be available".
 *   2. The server's direct address on port 30120/30121/30123. A deployed Worker
 *      silently drops non-standard ports on fetch(), so this goes over a raw TCP
 *      socket from `cloudflare:sockets` and speaks HTTP/1.1 by hand.
 *
 * Responses are cached in D1 so we spend as few API charges as possible - every
 * call except /alive and /charges.json burns one charge from your private key.
 */

import { connect } from 'cloudflare:sockets';

const SERVERS = {
  main: { cfxId: 'tycoon-2epova', host: 'server.tycoon.community', port: 30120, prefix: 'status' },
  beta: { cfxId: 'tycoon-njyvop', host: 'server.tycoon.community', port: 30121, prefix: 'status' },
  lite: { cfxId: 'tycoon-dgpvx3', host: 'server.tycoon.community', port: 30123, prefix: 'sessionmanager' },
};

export function serverConfig(env) {
  return SERVERS[(env.TYCOON_SERVER || 'main').toLowerCase()] || SERVERS.main;
}

/* ------------------------------------------------------------------ cache */

async function cacheGet(env, key) {
  const row = await env.DB.prepare('SELECT value, expires_at FROM api_cache WHERE key = ?')
    .bind(key)
    .first();
  if (!row || row.expires_at < Math.floor(Date.now() / 1000)) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function cachePut(env, key, value, ttlSeconds) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  await env.DB.prepare(
    'INSERT INTO api_cache (key, value, expires_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at'
  )
    .bind(key, JSON.stringify(value), expires)
    .run();
}

/* -------------------------------------------------------------- transports */

async function viaProxy(env, path, headers, signal) {
  const { cfxId, prefix } = serverConfig(env);
  const url = `https://${cfxId}.users.cfx.re/${prefix}/${path}`;
  const res = await fetch(url, { headers, signal, cf: { cacheTtl: 0 } });
  return { status: res.status, headers: res.headers, text: await res.text(), via: 'proxy' };
}

/**
 * HTTP/1.1 GET over a raw TCP socket, because fetch() cannot reach port 30120.
 *
 * The game server answers with `Transfer-Encoding: chunked`, and chunk sizes are
 * counted in bytes - so all framing happens on the Uint8Array and only the
 * finished body is decoded. Decoding first would mis-slice any player name
 * containing a multi-byte character.
 */
async function viaSocket(env, path, headers, timeoutMs = 8000) {
  const { host, port, prefix } = serverConfig(env);
  const socket = connect({ hostname: host, port });

  const lines = [
    `GET /${prefix}/${path} HTTP/1.1`,
    `Host: ${host}:${port}`,
    'Connection: close',
    'Accept: application/json, text/plain, */*',
    'User-Agent: tt-loans/1.0',
  ];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  const request = lines.join('\r\n') + '\r\n\r\n';

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    socket.close().catch(() => {});
  }, timeoutMs);

  try {
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode(request));
    writer.releaseLock();

    const result = await readHttpResponse(socket.readable, () => timedOut);
    return { ...result, via: 'direct' };
  } finally {
    clearTimeout(timer);
    await socket.close().catch(() => {});
  }
}

const MAX_BODY = 4 * 1024 * 1024;

async function readHttpResponse(readable, isTimedOut) {
  const reader = readable.getReader();
  let buf = new Uint8Array(0);
  let head = null;
  let bodyStart = -1;
  let eof = false;

  for (;;) {
    if (!head) {
      const split = indexOfCRLFCRLF(buf);
      if (split >= 0) {
        head = parseHead(buf.subarray(0, split));
        bodyStart = split + 4;
      }
    }
    if (head) {
      const body = finishBody(head, buf.subarray(bodyStart), eof);
      if (body) return { status: head.status, headers: head.headers, text: decode(body) };
    }
    if (eof) break;
    if (isTimedOut()) throw new Error('Game server timed out');

    const { value, done } = await reader.read();
    if (done) {
      eof = true;
      continue;
    }
    buf = concat(buf, value);
    if (buf.length > MAX_BODY) throw new Error('Response from game server was too large');
  }

  if (!head) throw new Error('Malformed HTTP response from game server');
  return { status: head.status, headers: head.headers, text: decode(buf.subarray(bodyStart)) };
}

/**
 * Returns the complete body bytes, or null when more data is still needed.
 * `atEof` means the connection closed, which itself terminates an unframed body.
 */
function finishBody(head, body, atEof) {
  if (head.status === 204 || head.status === 304) return new Uint8Array(0);

  if (head.chunked) {
    const dechunked = dechunkBytes(body);
    if (dechunked) return dechunked;
    return atEof ? new Uint8Array(0) : null;
  }
  if (head.contentLength !== null) {
    return body.length >= head.contentLength ? body.subarray(0, head.contentLength) : null;
  }
  return atEof ? body : null; // framed by connection close
}

function parseHead(bytes) {
  const lines = decode(bytes).split('\r\n');
  const status = Number(lines[0].split(' ')[1]) || 0;
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const lengthHeader = headers.get('content-length');
  return {
    status,
    headers,
    chunked: (headers.get('transfer-encoding') || '').toLowerCase().includes('chunked'),
    contentLength: lengthHeader === null ? null : Number(lengthHeader),
  };
}

/** Null until the terminating zero-length chunk has arrived. */
function dechunkBytes(body) {
  const parts = [];
  let pos = 0;
  for (;;) {
    const eol = indexOfCRLF(body, pos);
    if (eol < 0) return null;
    const size = parseInt(decode(body.subarray(pos, eol)).split(';')[0], 16);
    if (!Number.isFinite(size)) return null;
    if (size === 0) return concatAll(parts);

    const start = eol + 2;
    if (body.length < start + size + 2) return null;
    parts.push(body.subarray(start, start + size));
    pos = start + size + 2;
  }
}

const decode = (bytes) => new TextDecoder().decode(bytes);

function indexOfCRLF(bytes, from) {
  for (let i = from; i < bytes.length - 1; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
  }
  return -1;
}

function indexOfCRLFCRLF(bytes) {
  for (let i = 0; i < bytes.length - 3; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatAll(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/* --------------------------------------------------------------- requests */

/**
 * GET a Tycoon API path.
 * @param {object} opts
 * @param {boolean} opts.privateKey  send X-Tycoon-Key (costs one charge)
 * @param {string}  opts.publicKey   send X-Tycoon-Public-Key (a player's pkey)
 * @param {number}  opts.ttl         seconds to cache a successful response
 */
export async function tycoonGet(env, path, opts = {}) {
  const { privateKey = false, publicKey = null, ttl = 0 } = opts;
  const cacheKey = `tycoon:${env.TYCOON_SERVER || 'main'}:${path}:${publicKey || ''}`;

  if (ttl > 0) {
    const hit = await cacheGet(env, cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  const headers = {};
  if (privateKey) {
    if (!env.TYCOON_API_KEY) throw new Error('TYCOON_API_KEY secret is not set');
    headers['X-Tycoon-Key'] = env.TYCOON_API_KEY;
  }
  if (publicKey) headers['X-Tycoon-Public-Key'] = publicKey;

  const errors = [];
  for (const attempt of [viaProxy, viaSocket]) {
    let res;
    try {
      res = await attempt(env, path, headers);
    } catch (err) {
      errors.push(`${attempt.name}: ${err.message}`);
      continue;
    }

    if (res.status === 204) return { ok: true, status: 204, data: null, via: res.via };
    if (res.status >= 500 || res.status === 0) {
      errors.push(`${attempt.name}: HTTP ${res.status}`);
      continue; // server-side wobble, worth trying the other transport
    }

    const out = {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      via: res.via,
      charges: numberOrNull(res.headers.get('X-Tycoon-Charges')),
      data: null,
      raw: res.text,
    };
    if (out.ok) {
      try {
        out.data = JSON.parse(res.text);
      } catch {
        out.data = res.text; // /economy.csv and friends
      }
      if (ttl > 0) await cachePut(env, cacheKey, { ...out, raw: undefined }, ttl);
    } else {
      out.error = describeStatus(res.status);
    }
    return out;
  }

  const err = new Error(`Tycoon API unreachable (${errors.join(' | ')})`);
  err.unreachable = true;
  throw err;
}

function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function describeStatus(status) {
  switch (status) {
    case 400: return 'Bad request to the Tycoon API';
    case 401: return 'Tycoon API needs a private key (401)';
    case 402: return 'Your private key is out of charges. Refill with /api private refill';
    case 403: return 'Tycoon API rejected the key (403)';
    case 404: return 'Not found on the Tycoon API (404)';
    default:  return `Tycoon API returned HTTP ${status}`;
  }
}

/* ------------------------------------------------------------- convenience */

/**
 * Online players. Free - no key, no charge. Shape: {"players":[[name, source, user_id], ...]}
 * Cached for 45s; this is the identity check on every login, so it must stay cheap.
 */
export async function getOnlinePlayers(env) {
  const res = await tycoonGet(env, 'players.json', { ttl: 45 });
  const list = res?.data?.players;
  if (!Array.isArray(list)) return new Map();
  const byId = new Map();
  for (const entry of list) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    byId.set(Number(entry[2]), { name: String(entry[0]), source: Number(entry[1]) });
  }
  return byId;
}

/**
 * Remaining charges on the private key. Free - does not consume a charge.
 * The endpoint answers with a bare array, e.g. `[450]`.
 */
export async function getCharges(env) {
  const res = await tycoonGet(env, 'charges.json', { privateKey: true, ttl: 30 });
  const remaining = Array.isArray(res.data)
    ? numberOrNull(res.data[0])
    : numberOrNull(res.data?.charges ?? res.charges);
  return { ...res, remaining };
}

/**
 * Wallet / bank / loan for a player. Costs one charge and only works while the
 * player is online. Cached for 2 minutes.
 */
export async function getWealth(env, userId, publicKey = null) {
  return tycoonGet(env, `wealth/${encodeURIComponent(userId)}`, {
    privateKey: true,
    publicKey,
    ttl: 120,
  });
}

/** Reports which transport is currently working - surfaced on the admin panel. */
export async function diagnose(env) {
  const out = { server: env.TYCOON_SERVER || 'main', proxy: null, direct: null };
  for (const [label, fn] of [['proxy', viaProxy], ['direct', viaSocket]]) {
    const started = Date.now();
    try {
      const res = await fn(env, 'alive', {});
      out[label] = { ok: res.status === 204 || res.status === 200, status: res.status, ms: Date.now() - started };
    } catch (err) {
      out[label] = { ok: false, error: err.message, ms: Date.now() - started };
    }
  }
  return out;
}
