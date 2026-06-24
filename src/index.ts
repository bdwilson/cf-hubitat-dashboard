/**
 * Hubitat Dashboard Worker — entry point.
 *
 * Routes:
 *   GET    /              → dashboard.html (via Workers Assets binding)
 *   GET    /api/config    → public config (no token)
 *   GET    /api/config?include_secrets=1 → full config
 *   PUT    /api/config    → save config to KV
 *   DELETE /api/config    → wipe config
 *   *      /api/hub/*     → proxy to Hubitat, injecting access token
 *
 * Auth: Cloudflare Access in front of the Worker is the assumed perimeter.
 * The Worker reads CF-Access-Authenticated-User-Email for audit logging but
 * does not enforce it directly. If you remove Access, anyone with the URL
 * can read/write your config — be aware.
 */

import { handleConfig } from './handlers/config';
import { handleHubProxy } from './handlers/hub-proxy';
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Audit log — visible in `wrangler tail`
    const user =
      request.headers.get('CF-Access-Authenticated-User-Email') ??
      env.DEV_USER_EMAIL ??
      'anonymous';
    console.log(`${request.method} ${url.pathname} user=${user}`);

    try {
      // API routes
      if (url.pathname === '/api/config') {
        return await handleConfig(request, env);
      }
      if (url.pathname.startsWith('/api/hub/')) {
        return await handleHubProxy(request, env);
      }
      if (url.pathname.startsWith('/api/')) {
        return jsonError('not found', 404);
      }

      // Everything else: static assets (the dashboard HTML)
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error('Unhandled error', err);
      return jsonError(
        `internal error: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
