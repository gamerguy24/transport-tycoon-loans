/**
 * tt-loans - a loan service for the Transport Tycoon FiveM server.
 *
 *   /        in-game User Application (load it with F1 in game)
 *   /admin   approval panel for the lender
 *   /api/*   JSON API, handled here
 *
 * Static files live in ./public and are served by Cloudflare's asset host.
 */

import { ApiError, json } from './lib/http.js';
import * as player from './routes/player.js';
import * as admin from './routes/admin.js';

/** [method, path pattern, handler]. `:name` captures a path segment. */
const ROUTES = [
  ['GET', '/api/config', player.getPublicConfig],
  ['POST', '/api/session', player.createSession],
  ['GET', '/api/me', player.getMe],
  ['GET', '/api/quote', player.getQuote],
  ['POST', '/api/applications', player.createApplication],
  ['POST', '/api/applications/:id/cancel', player.cancelApplication],

  ['POST', '/api/admin/login', admin.login],
  ['POST', '/api/admin/logout', admin.logout],
  ['GET', '/api/admin/session', admin.session],
  ['GET', '/api/admin/overview', admin.overview],
  ['GET', '/api/admin/diagnostics', admin.diagnostics],
  ['GET', '/api/admin/applications', admin.listApplications],
  ['GET', '/api/admin/applications/:id', admin.getApplication],
  ['POST', '/api/admin/applications/:id/approve', admin.approveApplication],
  ['POST', '/api/admin/applications/:id/reject', admin.rejectApplication],
  ['GET', '/api/admin/loans', admin.listLoans],
  ['GET', '/api/admin/loans/:id', admin.getLoan],
  ['POST', '/api/admin/loans/:id/payout', admin.payoutLoan],
  ['POST', '/api/admin/loans/:id/repayment', admin.addRepayment],
  ['POST', '/api/admin/loans/:id/status', admin.setLoanStatus],
  ['GET', '/api/admin/players/:id/wealth', admin.playerWealth],
  ['POST', '/api/admin/players/:id/block', admin.setPlayerBlock],
  ['GET', '/api/admin/settings', admin.getAdminSettings],
  ['PUT', '/api/admin/settings', admin.updateAdminSettings],
  ['GET', '/api/admin/audit', admin.auditLog],
];

const COMPILED = ROUTES.map(([method, pattern, handler]) => ({
  method,
  handler,
  keys: pattern.split('/').filter(Boolean).map((seg) => (seg.startsWith(':') ? seg.slice(1) : null)),
  segments: pattern.split('/').filter(Boolean),
}));

function match(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const route of COMPILED) {
    if (route.segments.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const key = route.keys[i];
      if (key) params[key] = decodeURIComponent(parts[i]);
      else if (route.segments[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (route.method !== method) return { methodMismatch: true };
    return { handler: route.handler, params };
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      // The in-game app is same-origin with this Worker, so no CORS is needed.
      // A preflight only ever shows up if someone points another page at the API.
      if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

      const hit = match(request.method, url.pathname);
      if (!hit) return json({ error: 'Unknown endpoint' }, 404);
      if (hit.methodMismatch) return json({ error: 'Method not allowed' }, 405);

      try {
        return await hit.handler(request, env, hit.params, ctx);
      } catch (err) {
        if (err instanceof ApiError) {
          return json({ error: err.message, ...err.extra }, err.status);
        }
        console.error('Unhandled error', url.pathname, err?.stack || err);
        return json({ error: 'Something broke on our end. Try again.' }, 500);
      }
    }

    // Anything that is not an asset falls back to the player app.
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      if (res.status !== 404) return res;
      return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    }
    return new Response('Not found', { status: 404 });
  },
};
