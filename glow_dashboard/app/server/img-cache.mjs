/**
 * Album art kept on the PC (user, 2026-10-26: "playlist images should be cached on the server so
 * they load way faster"). The tablet asks the PC for a picture by its address; the first time the
 * PC fetches it from the internet (Spotify's CDN and the like) or from Music Assistant's image
 * proxy, keeps it on disk, and from then on serves it over the home network at once, with a long
 * cache life, so the screen's own cache keeps it too.
 *
 *   GET /__img?u=<the picture's address, encoded>   the picture (image/*), or 4xx/5xx
 *
 * Only pictures: from the music services' image hosts in IMAGE_HOSTS (https), or Music Assistant's
 * `/imageproxy` on the home network, image types only, 5 MB at most, so it is no open proxy. Kept in
 * `panel/.img-cache/` (git-ignored), trimmed to the newest MAX_BYTES. Screens on the home network
 * only (the relay's rules, without Origin: an <img> sends none).
 *
 * Served by vite's dev and preview servers (vite.config.ts, imgCache). A build copied into Home
 * Assistant has none, and the panel loads the pictures directly ($lib/audio/library.ts artUrl).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { screenOk } from './ha-relay.mjs';

const PATH = '/__img';
/** On the PC beside the panel; in the add-on, its own storage (GLOW_DATA, /data). */
const DIR = process.env.GLOW_DATA ? `${process.env.GLOW_DATA.replace(/[\\/]$/, '')}/img-cache/` : fileURLToPath(new URL('../.img-cache/', import.meta.url));
const MAX_BYTES = 400 * 1024 * 1024;
const MAX_ONE = 5 * 1024 * 1024;
const TIMEOUT_MS = 12_000;

/** The music services' picture hosts (and their subdomains). */
const IMAGE_HOSTS = [
  'scdn.co',
  'spotifycdn.com',
  'mzstatic.com',
  'dzcdn.net',
  'resources.tidal.com',
  'ytimg.com',
  'googleusercontent.com',
  'coverartarchive.org',
  'archive.org',
  'fanart.tv',
  'lastfm.freetls.fastly.net',
  'sndcdn.com',
  'theaudiodb.com',
];

const privateV4 = (h) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

/** The picture's address, when it is one this cache may fetch; else null. */
export function cacheable(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'https:' && IMAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return u.href;
  // Music Assistant's own image proxy (local files, radio logos) on the home network.
  if ((u.protocol === 'http:' || u.protocol === 'https:') && privateV4(host) && u.pathname.startsWith('/imageproxy')) return u.href;
  return null;
}

const keyOf = (url) => createHash('sha1').update(url).digest('hex');
/** Fetches under way, so a picture asked for twice at once is fetched once. */
const inFlight = new Map();
let trimming = false;

async function fromDisk(key) {
  try {
    const [body, meta] = await Promise.all([readFile(`${DIR}${key}.bin`), readFile(`${DIR}${key}.json`, 'utf8')]);
    return { body, type: JSON.parse(meta).type };
  } catch {
    return null;
  }
}

async function fetchOne(url, key) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    const type = String(res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!res.ok || !/^image\//.test(type)) throw Object.assign(new Error('not a picture'), { status: res.ok ? 415 : 502 });
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_ONE) throw Object.assign(new Error('too big'), { status: 413 });
    await mkdir(DIR, { recursive: true });
    await Promise.all([writeFile(`${DIR}${key}.bin`, body), writeFile(`${DIR}${key}.json`, JSON.stringify({ url, type }))]);
    void trim();
    return { body, type };
  } finally {
    clearTimeout(timer);
  }
}

/** Keep the folder under MAX_BYTES: the pictures used longest ago go first. */
async function trim() {
  if (trimming) return;
  trimming = true;
  try {
    const names = (await readdir(DIR)).filter((n) => n.endsWith('.bin'));
    const files = await Promise.all(names.map(async (n) => ({ n, s: await stat(`${DIR}${n}`).catch(() => null) })));
    let total = files.reduce((t, f) => t + (f.s?.size ?? 0), 0);
    if (total <= MAX_BYTES) return;
    files.sort((a, b) => (a.s?.atimeMs ?? 0) - (b.s?.atimeMs ?? 0));
    for (const f of files) {
      if (total <= MAX_BYTES * 0.9) break;
      total -= f.s?.size ?? 0;
      const key = f.n.slice(0, -4);
      await Promise.all([unlink(`${DIR}${key}.bin`).catch(() => {}), unlink(`${DIR}${key}.json`).catch(() => {})]);
    }
  } catch {
    /* nothing kept yet */
  } finally {
    trimming = false;
  }
}

/** Connect middleware for /__img. */
export function imgCache(req, res, next) {
  if ((req.url ?? '').split('?')[0] !== PATH) return next();
  void (async () => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      return res.end();
    }
    if (!screenOk(req)) {
      res.statusCode = 403;
      return res.end();
    }
    const url = cacheable(new URL(req.url, 'http://panel').searchParams.get('u'));
    if (!url) {
      res.statusCode = 400;
      return res.end();
    }
    const key = keyOf(url);
    try {
      let pic = await fromDisk(key);
      if (!pic) {
        let p = inFlight.get(key);
        if (!p) {
          p = fetchOne(url, key).finally(() => inFlight.delete(key));
          inFlight.set(key, p);
        }
        pic = await p;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', pic.type);
      res.setHeader('Content-Length', pic.body.length);
      // A picture's address never changes what it shows: keep it.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.end(req.method === 'HEAD' ? undefined : pic.body);
    } catch (err) {
      res.statusCode = err?.status ?? 502;
      res.end();
    }
  })();
}
