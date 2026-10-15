import path from 'node:path';
import { promises as fsp } from 'node:fs';
/**
 * adsbdb.com enrichment proxy: callsign → route (airline + origin/destination
 * airports) and hex → aircraft type/registration. Free community API — cached
 * aggressively: ONE upstream request per new key ever (404s negative-cached),
 * persisted to disk so restarts don't re-hammer it. Adapted from skylight
 * (MIT) server/src/enrich/routes.ts.
 */
export function adsbdbProxy() {
  const TTL_MS = 24 * 3600_000;
  const CACHE_PATH = path.join(process.cwd(), '.gev-cache', 'adsbdb.json');
  let cache = { routes: {}, aircraft: {} };
  let dirty = false;
  let loaded = false;
  const inflight = new Map();

  async function loadOnce() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      cache = { routes: parsed.routes ?? {}, aircraft: parsed.aircraft ?? {} };
    } catch {
      /* first run */
    }
    setInterval(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        await fsp.mkdir(path.dirname(CACHE_PATH), { recursive: true });
        await fsp.writeFile(CACHE_PATH, JSON.stringify(cache), 'utf8');
      } catch {
        dirty = true;
      } // retry next tick
    }, 15_000).unref?.();
  }

  const fresh = (e) => e && Date.now() - e.at < TTL_MS;

  function parseRoute(json) {
    const fr = json?.response?.flightroute;
    if (!fr?.origin || !fr?.destination) return null;
    const airport = (a) => ({
      code: a.iata_code || a.icao_code || '',
      icao: a.icao_code || '',
      name: a.municipality || a.name || '',
      lat: Number.isFinite(a.latitude) ? a.latitude : null,
      lon: Number.isFinite(a.longitude) ? a.longitude : null,
    });
    return {
      airline: fr.airline?.name || null,
      origin: airport(fr.origin),
      destination: airport(fr.destination),
      // Intermediate (fuel / layover) stops, in order, when the route data lists any.
      stops: fr.midpoint ? [airport(fr.midpoint)] : [],
      v: 2,
    };
  }

  /**
   * hexdb.io lists some multi-stop routes ("YSSY-WSSS-EGLL") that adsbdb gives as one leg.
   * Used only when its first and last airports match adsbdb's, to add the stops between.
   */
  const hexAirports = new Map();
  async function hexdbStops(callsign, route) {
    try {
      const res = await fetch(
        `https://hexdb.io/callsign-route?callsign=${encodeURIComponent(callsign)}`,
        { signal: AbortSignal.timeout(6000) },
      );
      if (!res.ok) return [];
      const codes = (await res.text())
        .trim()
        .split('-')
        .filter((c) => /^[A-Z0-9]{3,4}$/.test(c));
      if (codes.length < 3) return [];
      if (
        codes[0] !== route.origin.icao ||
        codes.at(-1) !== route.destination.icao
      )
        return [];
      const stops = [];
      for (const icao of codes.slice(1, -1)) {
        let a = hexAirports.get(icao);
        if (!a) {
          const r = await fetch(
            `https://hexdb.io/api/v1/airport/icao/${icao}`,
            {
              signal: AbortSignal.timeout(6000),
            },
          );
          const j = r.ok ? await r.json() : null;
          if (!Number.isFinite(j?.latitude)) return [];
          a = {
            code: j.iata || icao,
            icao,
            name: j.region_name || j.airport || '',
            lat: j.latitude,
            lon: j.longitude,
          };
          hexAirports.set(icao, a);
        }
        stops.push(a);
      }
      return stops;
    } catch {
      return [];
    }
  }

  function parseAircraft(json) {
    const a = json?.response?.aircraft;
    if (!a) return null;
    return {
      typeCode: a.icao_type || null, // ICAO designator, e.g. "B738" — feeds classifyAircraft
      typeName:
        a.manufacturer && a.type
          ? `${a.manufacturer} ${a.type}`
          : a.type || null,
      registration: a.registration || null,
    };
  }

  function lookup(kind, key) {
    const store = kind === 'route' ? cache.routes : cache.aircraft;
    // Route entries from before stops were recorded (v < 2) are looked up again.
    if (
      fresh(store[key]) &&
      (kind !== 'route' || !store[key].data || store[key].data.v === 2)
    )
      return Promise.resolve(store[key].data);
    const ik = `${kind}:${key}`;
    if (!inflight.has(ik)) {
      inflight.set(
        ik,
        (async () => {
          try {
            const url =
              kind === 'route'
                ? `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(key)}`
                : `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
              const data =
                kind === 'route'
                  ? parseRoute(await res.json())
                  : parseAircraft(await res.json());
              if (kind === 'route' && data && !data.stops.length)
                data.stops = await hexdbStops(key, data);
              store[key] = { at: Date.now(), data }; // data may be null — negative cache
              dirty = true;
              return data;
            }
            if (res.status === 404) {
              store[key] = { at: Date.now(), data: null }; // known-missing — cache the miss
              dirty = true;
            }
            // other statuses: leave uncached so we retry later
            return fresh(store[key]) ? store[key].data : null;
          } catch {
            return fresh(store[key]) ? store[key].data : null; // network error → stale if any
          } finally {
            inflight.delete(ik);
          }
        })(),
      );
    }
    return inflight.get(ik);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/adsbdb', async (req, res) => {
      await loadOnce();
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      try {
        const [, kind, rawKey] = String(req.url || '')
          .split('?')[0]
          .split('/');
        if (kind === 'route') {
          const cs = String(rawKey || '').toUpperCase();
          if (!/^[A-Z0-9]{2,8}$/.test(cs))
            return send(400, { error: 'invalid callsign' });
          const data = await lookup('route', cs);
          return send(200, data ? { found: true, ...data } : { found: false });
        }
        if (kind === 'type') {
          const hex = String(rawKey || '').toLowerCase();
          if (!/^[0-9a-f]{6}$/.test(hex))
            return send(400, { error: 'invalid hex' });
          const data = await lookup('aircraft', hex);
          return send(200, data ? { found: true, ...data } : { found: false });
        }
        return send(404, { error: 'unknown endpoint' });
      } catch (err) {
        console.error('[adsbdb-proxy] request failed');
        return send(500, { error: 'adsbdb proxy error' });
      }
    });
  };
  return {
    name: 'adsbdb-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
