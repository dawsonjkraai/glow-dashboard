/**
 * The panel's own web server, without Vite: a built panel (the `dist` folder) and the services
 * Vite's dev and preview servers give it on the PC (vite.config.ts): the saved sign-in and its
 * socket relay (ha-relay.mjs), live WLED colours (wled-bridge.mjs), Music Assistant's queue and
 * pages of songs (ma-bridge.mjs) and album art kept on disk (img-cache.mjs). Plain Node (24), no
 * packages: the Glow Dashboard add-on runs it, and it can stand in for `vite preview` on the PC.
 *
 *   node server/serve.mjs --dir ../.stable-build --port 5190 [--host 0.0.0.0] [--lan-port 8199]
 *
 * The files: index.html and version.json are never cached (a new build reaches every screen on its
 * next load; see haBootstrap in vite.config.ts), the content-hashed files in assets/ are cached for
 * a year, and text is gzipped (once per file, kept in memory).
 */
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { attachRelay, serverSignIn } from './ha-relay.mjs';
import { imgCache } from './img-cache.mjs';
import { maApi } from './ma-bridge.mjs';
import { wledStream } from './wled-bridge.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
const TEXT = /^(text\/|application\/(json|manifest\+json)|image\/svg\+xml)/;
/** Never kept by a browser: the page and the file that says which build it is. */
const NO_CACHE = new Set(['index.html', 'version.json']);

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (m) out[m[1]] = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
  }
  return out;
}

/** gzip of a text file, by path and modification time. */
const zipped = new Map();

function gz(file, mtimeMs) {
  const key = `${file}:${mtimeMs}`;
  let body = zipped.get(key);
  if (!body) {
    body = gzipSync(readFileSync(file), { level: 6 });
    zipped.set(key, body);
    if (zipped.size > 400) zipped.delete(zipped.keys().next().value);
  }
  return body;
}

/** The built panel's files, from `root`. */
export function staticFiles(root) {
  const base = resolve(root);
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      return res.end();
    }
    let path;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://panel').pathname);
    } catch {
      res.statusCode = 400;
      return res.end();
    }
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(base, `.${path}`);
    if (file !== base && !file.startsWith(base + sep)) {
      res.statusCode = 403;
      return res.end();
    }
    let st;
    try {
      st = statSync(file);
    } catch {
      st = null;
    }
    if (!st?.isFile()) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('Not found');
    }
    const name = file.slice(base.length + 1).replaceAll(sep, '/');
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', NO_CACHE.has(name) ? 'no-cache' : name.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
    const modified = new Date(Math.floor(st.mtimeMs / 1000) * 1000);
    res.setHeader('Last-Modified', modified.toUTCString());
    const since = Date.parse(String(req.headers['if-modified-since'] ?? ''));
    if (!Number.isNaN(since) && since >= modified.getTime()) {
      res.statusCode = 304;
      return res.end();
    }
    res.setHeader('Vary', 'Accept-Encoding');
    if (TEXT.test(type) && st.size > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      const body = gz(file, st.mtimeMs);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', body.length);
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    res.setHeader('Content-Length', st.size);
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  };
}

/** The services, then the files: each passes on what isn't its own. */
export function panelServer(root) {
  const chain = [serverSignIn, wledStream, maApi, imgCache];
  const files = staticFiles(root);
  const server = createServer((req, res) => {
    let i = 0;
    const next = () => {
      const handler = chain[i++];
      if (handler) handler(req, res, next);
      else files(req, res);
    };
    try {
      next();
    } catch {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  });
  attachRelay(server);
  // The relay answers its own path; nothing else upgrades here.
  server.on('upgrade', (req, socket) => {
    if ((req.url ?? '').split('?')[0] !== '/__ha/api/websocket') socket.destroy();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const a = args(process.argv.slice(2));
  const dir = a.dir ?? 'dist';
  const port = Number(a.port ?? 8099);
  const host = a.host ?? '0.0.0.0';
  try {
    statSync(resolve(dir, 'index.html'));
  } catch {
    console.error(`No built panel in ${resolve(dir)} (index.html is missing).`);
    process.exit(1);
  }
  panelServer(dir).listen(port, host, () => console.log(`Glow Dashboard: ${resolve(dir)} on http://${host}:${port}`));
  // The add-on's second door: its own port for wall tablets on the home network (Home
  // Assistant's sidebar comes in on the first). Who may use what is decided per request (ha-relay.mjs).
  const lanPort = a['lan-port'] ? Number(a['lan-port']) : null;
  if (lanPort) panelServer(dir).listen(lanPort, host, () => console.log(`Glow Dashboard: wall tablets on port ${lanPort}`));
}
