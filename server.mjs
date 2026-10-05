import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { APIError, createService } from './service.mjs';
export function createServer(service) {
  let active = 0, windowStart = 0, count = 0;
  return http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    // Explicit loopback and Mac LAN allowlist; browser origins remain blocked.
    const isRender = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);
if (!isRender) {
  if (!/^(localhost|127\.0\.0\.1|192\.168\.1\.54):\d+$/.test(req.headers.host ?? '') || req.headers.origin) {
    return send(403, { error: 'forbidden' });
  }
}    if (req.method !== 'GET') return send(405, { error: 'method' });
    if (Date.now() - windowStart > 60000) { windowStart = Date.now(); count = 0; }
    if (++count > 90 || active >= 4) return send(429, { error: 'rate_limit' });
    active++;
    try {
      const url = new URL(req.url, 'http://localhost');
      let body;
      if (url.pathname === '/health') body = { status: 'ready', mode: 'local-development', version: '1.1.4' };
      else if (url.pathname === '/v1/jobs') body = await service.search(url.searchParams);
      else if (url.pathname.startsWith('/v1/jobs/')) body = await service.detail(decodeURIComponent(url.pathname.slice(9)));
      else if (url.pathname === '/v1/cities') body = await service.cities(url.searchParams.get('q') ?? '');
      else throw new APIError(404, 'not_found');
      send(200, body);
    } catch (error) {
      // Never return upstream response bodies, credential-bearing requests or stack traces.
      send(error instanceof APIError ? error.status : 503, { error: error instanceof APIError ? error.code : 'unavailable' });
    } finally { active--; }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const clientID = process.env.FT_CLIENT_ID, clientSecret = process.env.FT_CLIENT_SECRET;
  delete process.env.FT_CLIENT_ID; delete process.env.FT_CLIENT_SECRET;
  if (!clientID || !clientSecret) { console.error('Lipsesc identificatoarele. Pornește prin start.command.'); process.exit(1); }
  const server = createServer(createService({ clientID, clientSecret }));
  server.requestTimeout = 20000;
  const port = Number(process.env.PORT || 8787);
server.listen(port, '0.0.0.0', () => {
  console.log(`AJOB: serviciul France Travail este pornit pe portul ${port}.`);
});  server.on('error', () => { console.error('Nu pot porni serviciul local. Verifică dacă este deja deschis pe portul 8787.'); process.exit(1); });
}
