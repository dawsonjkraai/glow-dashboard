/**
 * The sign-in saved on the PC (user, 2026-10-25: "I want the token and dashboards all saved on the
 * server so no matter what device I open it up on I can have the dashboard").
 *
 * The dashboards already live in Home Assistant; what each screen kept for itself was its sign-in,
 * per address, so a new tablet, another port or a new IP for the PC meant signing in again. Here
 * the server keeps one sign-in (a long-lived token) in `panel/.ha-server.json` (git-ignored) and
 * every screen it serves connects through it, without ever seeing the token:
 *
 *   GET    /__ha/server       { available, configured, url, user, state, savedAt }  (never the token)
 *   POST   /__ha/server       { url, token, lan? }: checks it with Home Assistant, then keeps it
 *   DELETE /__ha/server       forgets it
 *   ws     /__ha/api/websocket  Home Assistant's websocket API, signed in by the server
 *
 * The socket relay signs in to Home Assistant itself, then plays Home Assistant's opening to the
 * screen (auth_required, then auth_ok whatever token the screen sends) and passes every message
 * through unchanged, both ways: home-assistant-js-websocket connects to it as to Home Assistant
 * ($lib/ha/server-sign-in.ts). Commands that mint, list or revoke credentials, or manage users,
 * are refused, so a guest's phone on the Wi-Fi can use the panel but can't walk off with a
 * token of its own.
 *
 * Only for the home network: screens must come from a private address that reached the PC on the
 * network Home Assistant is on (a laptop also plugged into a work network serves nobody there), ask
 * for the page by IP or localhost (no DNS-rebinding names), and open the socket from a page this
 * server served (Origin); when Home Assistant is on none of the PC's networks, only the PC itself
 * (fromHome). Home Assistant's address must be a local one (a private address or a local name), or
 * an internet one with its local address (below), so on another network the relay reaches nothing.
 *
 * An internet (https) Home Assistant address works too; the PC connects to it at home by its local
 * address. The screen that saves it also sends `lan`, Home Assistant's own private IPv4 (from its
 * `network` command, which needs an administrator). The PC never connects by the internet name: it
 * opens TLS to `lan`, on the address's port, and the certificate must be valid for the address's
 * name. Away from home that IP reaches nothing, or a device that can't show that certificate, and
 * the token is only sent once the certificate checked out (Upstream). Node's own WebSocket can't
 * connect to one address while checking another name, hence the small client below.
 *
 * Served by vite's dev and preview servers (vite.config.ts, haRelay) and by serve.mjs. A build
 * copied into Home Assistant has none: the screens see a 404 and sign in as before.
 *
 * Inside the Glow Dashboard add-on (GLOW_ADDON=1, on Home Assistant OS) nothing is saved: the
 * Supervisor gives the add-on a token for Home Assistant (SUPERVISOR_TOKEN, by
 * http://supervisor/core), and two kinds of screen reach it. Home Assistant's sidebar (ingress):
 * requests come from the Supervisor's ingress gateway, which only lets in a signed-in Home
 * Assistant user; the panel there signs in as that user ($lib/ha/connection.svelte.ts 'ingress')
 * and uses only the bridges here, never the relay. And the add-on's own port on the home network,
 * only when the household turned on "no sign-in" (GLOW_NO_SIGN_IN=1): the relay as on the PC, with
 * the Supervisor's token, refusing more (ADDON_BLOCKED: the Supervisor, add-ons, backups,
 * restarts, logs) since that token can manage the whole system.
 *
 * Tests: HOME_PANEL_SIGN_IN_FILE moves the saved sign-in to a scratch file, and HOME_PANEL_TEST_CA
 * (a PEM file) adds a test CA to the trusted roots. Without it, Node's own trusted roots.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { connect as netConnect, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { checkServerIdentity, connect as tlsConnect, rootCertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';

/** HOME_PANEL_SIGN_IN_FILE moves it (tests use a scratch file, never the household's). */
const STORE = process.env.HOME_PANEL_SIGN_IN_FILE || fileURLToPath(new URL('../.ha-server.json', import.meta.url));
const STATUS_PATH = '/__ha/server';
const SOCKET_PATH = '/__ha/api/websocket';
const OPEN_TIMEOUT_MS = 8_000;
/** Home Assistant caps an inbound message at 4 MiB. */
const MAX_IN = 4 * 1024 * 1024;
/** What Home Assistant sends can be bigger (a large house's states): a generous cap, against a runaway. */
const MAX_FROM_HA = 64 * 1024 * 1024;
const MAX_HEAD = 16 * 1024;
const CLOSE_WAIT_MS = 3_000;
const MAX_BODY = 16 * 1024;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---- Inside the Glow Dashboard add-on ----

export const ADDON = process.env.GLOW_ADDON === '1' && !!process.env.SUPERVISOR_TOKEN;
const NO_SIGN_IN = ADDON && process.env.GLOW_NO_SIGN_IN === '1';
/** Where the Supervisor's ingress requests come from (Home Assistant OS's internal network). */
const INGRESS_GATEWAY = '172.30.32.2';
const ADDON_TARGET = 'http://supervisor';

/** More that screens on the no-sign-in port can't do with the Supervisor's token. */
const ADDON_BLOCKED = [/^(supervisor|hassio|backup)\//, /^config_entries\/(delete|disable|update|ignore_flow|flow|options|subentries)\b/, /^config\/core\/update$/, /^(repairs|system_log|logger)\//];
const ADDON_SERVICES = { hassio: null, backup: null, recorder: null, system_log: null, logger: null, homeassistant: /^(restart|stop|set_location|reload_.*|save_persistent_states)$/ };

export function refusedInAddon(msg) {
  if (ADDON_BLOCKED.some((re) => re.test(msg.type))) return true;
  if (msg.type !== 'call_service' || typeof msg.domain !== 'string' || !(msg.domain in ADDON_SERVICES)) return false;
  const only = ADDON_SERVICES[msg.domain];
  return !only || only.test(String(msg.service ?? ''));
}

/** Home Assistant's own port and scheme (the Supervisor's /core/info): for requests to it, and the address screens get. */
let coreInfo = null;
async function core() {
  if (coreInfo && Date.now() - coreInfo.at < 10 * 60_000) return coreInfo;
  try {
    const res = await fetch('http://supervisor/core/info', { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` }, signal: AbortSignal.timeout(5_000) });
    const body = await res.json();
    coreInfo = { port: Number(body?.data?.port) || 8123, ssl: !!body?.data?.ssl, at: Date.now() };
  } catch {
    // Asked again in a minute.
    coreInfo = { port: 8123, ssl: false, at: Date.now() - 9 * 60_000 };
  }
  return coreInfo;
}

const fromIngress = (req) => ADDON && String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '') === INGRESS_GATEWAY;
/** A screen on the add-on's own port, on the home network, with "no sign-in" on. */
const lanScreen = (req) => NO_SIGN_IN && !fromIngress(req) && localClient(req.socket?.remoteAddress) && plainHost(req.headers.host);

/**
 * A screen may use this server's bridges without Origin (the album-art cache: an <img> sends none):
 * on the PC, one on the home network; in the add-on, the sidebar's or the no-sign-in port's.
 */
export function screenOk(req) {
  return ADDON ? fromIngress(req) || lanScreen(req) : localClient(req.socket?.remoteAddress) && plainHost(req.headers.host);
}

/** Never through the PC: making, listing or revoking credentials, and managing users. */
const BLOCKED = [/^auth\/(long_lived_access_token|refresh_tokens|delete_refresh_token|delete_all_refresh_tokens|refresh_token_set_expiry)$/, /^config\/auth(_provider)?\//];

const NOT_SAVED = 'No sign-in is saved on the PC. Sign in on this screen, or save one on the PC from Settings › Connection on a screen that is signed in.';
const TURNED_DOWN = 'Home Assistant turned down the sign-in saved on the PC (the token was deleted or has expired). Save a new one from Settings › Connection on a signed-in screen.';
const NOT_AN_ADDRESS = "That isn't a Home Assistant address.";
const NEEDS_LAN =
  'The PC only keeps a sign-in it can use on your home network: a local address (like 192.168.1.10:8123 or homeassistant.local), or an internet (https) address together with Home Assistant’s local one, which only a screen signed in as an administrator can read.';
const NEEDS_HTTPS = 'For an internet address the PC needs https: it checks Home Assistant’s certificate before it sends the sign-in.';
const LAN_UNREACHABLE = "Couldn't reach Home Assistant at its local address. Check that the PC is on the home network.";

// ---- Addresses ----

const privateV4 = (a, b) => a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
const privateV6 = (h) => h === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);

/** A device on the home network, or this PC. */
export function localClient(addr) {
  const a = String(addr ?? '').toLowerCase().replace(/^::ffff:/, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  return v4 ? privateV4(Number(v4[1]), Number(v4[2])) : privateV6(a);
}

/** The Host a page was asked for, as vite allows it: an IP, localhost or *.localhost. */
export function plainHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/:\d{1,5}$/, '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^\[[0-9a-f:.]+\]$/.test(h) || h === 'localhost' || h.endsWith('.localhost');
}

/** An http(s) address as a URL (a bare host is taken as http), or null. */
function parseUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 200) return null;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
  } catch {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
}

/** A private address, localhost or a local name: an address only the home network has. */
function isLocal(u) {
  const h = u.hostname.toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) return privateV4(Number(v4[1]), Number(v4[2]));
  if (h.startsWith('[')) return privateV6(h.slice(1, -1));
  return h === 'localhost' || !h.includes('.') || /\.(local|lan|home|internal|localhost|home\.arpa)$/.test(h);
}

/** Home Assistant on the home network, as an origin: a private address, localhost or a local name. Else null. */
export function homeUrl(raw) {
  const u = parseUrl(raw);
  return u && isLocal(u) ? u.origin : null;
}

/** Home Assistant's own address on the home network, as a screen sends `lan`: a private IPv4 (127.x: on this PC). Else null. */
export function lanIp(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m || m.slice(1).some((o) => Number(o) > 255 || (o.length > 1 && o.startsWith('0')))) return null;
  return privateV4(Number(m[1]), Number(m[2])) ? s : null;
}

/**
 * What the PC may keep a sign-in for: { url, lan? }, or { refused } with the reason in words.
 * - A local address as before, without `lan` (any sent is dropped): the address already names the
 *   home network, and connecting by it follows Home Assistant if its IP changes.
 * - An internet address only with `lan` and only over https: the PC then connects to `lan` and
 *   checks the certificate against the address's name (upstreamFor, Upstream). Plain http there
 *   would hand the token to whatever answers at that private address on whichever network the
 *   laptop is on.
 */
export function signInFor(rawUrl, rawLan) {
  const u = parseUrl(rawUrl);
  if (!u) return { refused: NOT_AN_ADDRESS };
  if (isLocal(u)) return { url: u.origin };
  const lan = lanIp(rawLan);
  if (!lan) return { refused: NEEDS_LAN };
  if (u.protocol !== 'https:') return { refused: NEEDS_HTTPS };
  return { url: u.origin, lan };
}

/**
 * Where the PC opens Home Assistant's socket for a sign-in: { host, port, secure, name, hostHeader }.
 * With `lan`, that IP and never the internet name, on the address's port and scheme; over TLS the
 * certificate is checked against `name` (the address's host) either way.
 */
export function upstreamFor({ url, lan }) {
  // The add-on reaches Home Assistant's socket through the Supervisor.
  if (ADDON && url === ADDON_TARGET) return { host: 'supervisor', port: 80, secure: false, name: 'supervisor', hostHeader: 'supervisor', path: '/core/websocket' };
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const name = u.hostname.replace(/^\[|\]$/g, '');
  return { host: lan ?? name, port: Number(u.port) || (secure ? 443 : 80), secure, name, hostHeader: u.host };
}

const v4num = (ip) => ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
/** Two IPv4 addresses on the same network under this netmask. */
export const sameNet = (a, b, mask) => (v4num(a) & v4num(mask)) >>> 0 === (v4num(b) & v4num(mask)) >>> 0;
const bare = (addr) => String(addr ?? '').replace(/^::ffff:/, '');
const isV4 = (ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);

let homeCache = { key: '', at: 0, nets: [] };

/**
 * The PC's own networks that Home Assistant is on, as [{ address, netmask }]: [] when it is on none
 * of them (reached through a router, on this PC, or not reachable at all). Home Assistant's IP is
 * `lan` when there is one (the internet name is never looked up), else the local address's host.
 * Looked up at most once a minute.
 */
async function homeNets(target) {
  const key = `${target.url} ${target.lan ?? ''}`;
  if (homeCache.key === key && Date.now() - homeCache.at < 60_000) return homeCache.nets;
  let ip = target.lan ?? null;
  if (!ip) {
    try {
      const host = new URL(target.url).hostname.replace(/^\[|\]$/g, '');
      ip = isV4(host) ? host : (await lookup(host, { family: 4 })).address;
    } catch {
      /* unresolvable: no home network known */
    }
  }
  const nets = [];
  if (ip && !ip.startsWith('127.')) {
    for (const list of Object.values(networkInterfaces())) {
      for (const n of list ?? []) if (n.family === 'IPv4' && !n.internal && sameNet(n.address, ip, n.netmask)) nets.push({ address: n.address, netmask: n.netmask });
    }
  }
  homeCache = { key, at: Date.now(), nets };
  return nets;
}

/** A request that reached the PC on this PC address came in on one of these networks (the network Home Assistant is on). None known: no. */
export const arrivedOn = (localAddress, nets) => isV4(localAddress) && nets.some((n) => sameNet(localAddress, n.address, n.netmask));

/**
 * The request may use the sign-in for this Home Assistant (`target`: { url, lan? }, the saved one
 * or the one being saved): from the PC itself, or from a private address that reached the PC on
 * the network Home Assistant is on, so on a laptop that is also on another network, a work
 * network say, nobody there can use the house's sign-in.
 *
 * When Home Assistant is on none of the PC's networks, only the PC itself. This used to fall back
 * to any private address, and it doesn't any more, not even for a local address. "Home Assistant
 * is on none of my networks" is what being away from home looks like: the laptop at work, in a
 * café or a hotel, with node allowed in on public networks. A fallback opens the relay to exactly
 * the networks it must refuse, and all that is left between them and the house is that the
 * private address happens not to route there; for a plain-http local address, a device that does
 * answer at it would be handed the token in the clear. The cost: with Home Assistant on another
 * subnet than the PC at home (a separate VLAN, a router between them) or on the PC itself, other
 * screens get a 403 and sign in on their own, as they do without this server.
 */
async function fromHome(req, target) {
  const remote = bare(req.socket.remoteAddress);
  if (!localClient(remote)) return false;
  if (remote.startsWith('127.') || remote === '::1') return true;
  if (!target) return true;
  return arrivedOn(bare(req.socket.localAddress), await homeNets(target));
}

/** The socket or request came from a page this server served. Browsers always send Origin on a socket, and on a POST or DELETE. */
function sameOrigin(req) {
  try {
    return new URL(String(req.headers.origin)).host === req.headers.host;
  } catch {
    return false;
  }
}

// ---- The saved sign-in ----

/** { url, lan?, token, user, version, savedAt }, or null. Checked again like a save, so an edited file can't point the PC at an internet name. */
function load() {
  if (ADDON) return { url: ADDON_TARGET, token: process.env.SUPERVISOR_TOKEN, user: 'Home Assistant (the add-on)', savedAt: null };
  try {
    const s = JSON.parse(readFileSync(STORE, 'utf8'));
    if (!s || typeof s.url !== 'string' || typeof s.token !== 'string' || !s.token) return null;
    const t = signInFor(s.url, s.lan);
    return t.refused ? null : { ...s, url: t.url, lan: t.lan };
  } catch {
    return null;
  }
}

const fingerprint = (token) => createHash('sha256').update(token).digest('hex');

/** How the last use of the saved sign-in went: 'ok', 'rejected' or 'unreachable' (null: not tried yet). */
let outcome = null;
/**
 * The token Home Assistant last turned down. It isn't tried again until a new one is saved: repeated
 * bad sign-ins from the PC could get its address banned by Home Assistant.
 */
let rejected = null;

function status() {
  const s = load();
  return {
    available: true,
    configured: !!s,
    url: s?.url ?? null,
    user: s?.user ?? null,
    savedAt: s?.savedAt ?? null,
    state: !s ? 'none' : rejected === fingerprint(s.token) ? 'rejected' : (outcome ?? 'unknown'),
  };
}

// ---- Home Assistant's side ----

const failure = (code, message) => Object.assign(new Error(message), { code });

/**
 * Open Home Assistant's socket for a sign-in ({ url, lan? }) and sign in. Resolves { ws, version };
 * rejects with code 'rejected' or 'unreachable'.
 */
function signIn(target, token) {
  return new Promise((resolve, reject) => {
    const to = upstreamFor(target);
    const unreachable = target.lan ? LAN_UNREACHABLE : `Couldn't reach Home Assistant at ${target.url}. Check the address, and that the PC is on the home network.`;
    let ws;
    try {
      ws = new Upstream(to);
    } catch {
      reject(failure('unreachable', unreachable));
      return;
    }
    const done = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onFail);
      ws.removeEventListener('close', onFail);
    };
    const onFail = () => {
      done();
      const cert = `The certificate ${target.lan ? "at Home Assistant's local address" : `at ${target.url}`} isn't valid for ${to.name}, so the PC didn't send the sign-in.`;
      reject(failure('unreachable', ws.badCertificate ? cert : unreachable));
    };
    const onMessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      else if (msg.type === 'auth_ok') {
        done();
        resolve({ ws, version: String(msg.ha_version ?? '') });
      } else if (msg.type === 'auth_invalid') {
        done();
        ws.close();
        reject(failure('rejected', 'Home Assistant turned down this token. Copy it again from your Home Assistant profile (Security tab).'));
      }
    };
    const timer = setTimeout(() => {
      onFail();
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }, OPEN_TIMEOUT_MS);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onFail);
    ws.addEventListener('close', onFail);
  });
}

/** Who a signed-in socket acts for: { name, isAdmin }. */
function currentUser(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure('unreachable', "Home Assistant didn't answer.")), OPEN_TIMEOUT_MS);
    const onMessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== 1 || msg.type !== 'result') return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (msg.success) resolve({ name: String(msg.result?.name ?? 'Home Assistant user'), isAdmin: !!msg.result?.is_admin });
      else reject(failure('unreachable', msg.error?.message ?? "Couldn't read the user."));
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id: 1, type: 'auth/current_user' }));
  });
}

let testRoots = null;

/** Node's own trusted roots (undefined), or those plus the tests' CA (HOME_PANEL_TEST_CA, a PEM file). */
function trustedRoots() {
  const file = process.env.HOME_PANEL_TEST_CA;
  if (!file) return undefined;
  testRoots ??= [...rootCertificates, readFileSync(file, 'utf8')];
  return testRoots;
}

/** A TLS failure on the certificate itself (wrong name, untrusted, expired), as Node codes it. */
const certificateError = (err) => /CERT|SELF_SIGNED|ALTNAME|UNABLE_TO_(GET|VERIFY)/.test(String(err?.code ?? ''));

// ---- Home Assistant's side: a WebSocket client, just enough of RFC 6455 for text messages ----

/**
 * Home Assistant's socket, opened by the PC over net or tls to upstreamFor's host, so the TLS name
 * check can be against another name than the address it connects to. Shaped like a browser
 * WebSocket where the relay uses it: send(), close(), readyState, and 'message' ({ data }),
 * 'error' and 'close' ({ code }) listeners. Text messages only (binary ones are dropped, as the
 * relay always did). Over TLS nothing is written until the certificate checked out, so a device
 * that can't show Home Assistant's certificate never sees the upgrade request, let alone the token.
 */
class Upstream {
  /** @param {ReturnType<typeof upstreamFor>} to */
  constructor(to) {
    /** 0 connecting, 1 open, 2 closing, 3 closed. */
    this.readyState = 0;
    /** The TLS handshake failed on the certificate. */
    this.badCertificate = false;
    this.key = randomBytes(16).toString('base64');
    /** @type {Record<'message' | 'error' | 'close', Set<(ev: any) => void>>} */
    this.listeners = { message: new Set(), error: new Set(), close: new Set() };
    /** Bytes received and not read yet, and how many it takes to read on. */
    this.chunks = [];
    this.size = 0;
    this.need = 1;
    /** The fragments of a message in progress, and its opcode (0: none). */
    this.parts = [];
    this.partsLen = 0;
    this.op = 0;
    this.code = 1006;
    this.errored = false;
    /** Nothing more to read: Home Assistant's close arrived, or the connection failed. */
    this.over = false;
    this.connected = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.timer = undefined;
    const socket = to.secure
      ? tlsConnect({
          host: to.host,
          port: to.port,
          // SNI can't carry an IP (RFC 6066); the certificate is checked against the name either way.
          servername: isIP(to.name) ? undefined : to.name,
          checkServerIdentity: (_host, cert) => checkServerIdentity(to.name, cert),
          rejectUnauthorized: true,
          ca: trustedRoots(),
        })
      : netConnect({ host: to.host, port: to.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    socket.once('connect', () => (this.connected = true));
    socket.once(to.secure ? 'secureConnect' : 'connect', () => {
      socket.write(`GET ${to.path ?? '/api/websocket'} HTTP/1.1\r\nHost: ${to.hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.on('data', (d) => this.data(d));
    socket.on('error', (err) => {
      if (to.secure && this.connected && this.readyState === 0 && certificateError(err)) this.badCertificate = true;
      this.fail();
    });
    socket.on('close', () => this.finish());
  }

  addEventListener(type, fn) {
    this.listeners[type]?.add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners[type]?.delete(fn);
  }

  emit(type, ev) {
    for (const fn of [...this.listeners[type]]) {
      try {
        fn(ev);
      } catch (err) {
        console.error('[ha-relay]', err);
      }
    }
  }

  data(d) {
    if (this.over) return;
    this.chunks.push(d);
    this.size += d.length;
    if (this.size < this.need) return;
    /** @type {Buffer | null} */
    let b = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
    if (this.readyState === 0) b = this.head(b);
    if (b && this.readyState !== 0) b = this.frames(b);
    this.chunks = b?.length ? [b] : [];
    this.size = b?.length ?? 0;
  }

  /** Home Assistant's answer to the upgrade: 101 with the Sec-WebSocket-Accept for our key. Returns what follows it. */
  head(b) {
    const end = b.indexOf('\r\n\r\n');
    if (end < 0) {
      if (b.length > MAX_HEAD) return this.fail();
      this.need = b.length + 1;
      return b;
    }
    const [status = '', ...lines] = b.subarray(0, end).toString('latin1').split('\r\n');
    const h = new Map();
    for (const line of lines) {
      const i = line.indexOf(':');
      if (i > 0) h.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
    }
    const accept = createHash('sha1').update(this.key + GUID).digest('base64');
    const upgraded =
      /^HTTP\/1\.1 101\b/.test(status) &&
      String(h.get('upgrade')).toLowerCase() === 'websocket' &&
      /\bupgrade\b/i.test(String(h.get('connection'))) &&
      h.get('sec-websocket-accept') === accept &&
      // None were asked for.
      !h.has('sec-websocket-extensions') &&
      !h.has('sec-websocket-protocol');
    if (!upgraded) return this.fail();
    this.readyState = 1;
    this.need = 2;
    return b.subarray(end + 4);
  }

  /** Read whole frames off the front of b. Returns the rest, or null once closed or failed. */
  frames(b) {
    for (;;) {
      if (this.over) return null;
      if (b.length < 2) {
        this.need = 2;
        return b;
      }
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      let len = b[1] & 0x7f;
      let off = 2;
      // No extension was agreed (RSV bits), and a server never masks.
      if (b[0] & 0x70 || b[1] & 0x80) return this.fail(1002);
      if (len === 126) {
        if (b.length < 4) {
          this.need = 4;
          return b;
        }
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) {
          this.need = 10;
          return b;
        }
        len = b.readUInt32BE(2) * 2 ** 32 + b.readUInt32BE(6);
        off = 10;
      }
      if (op >= 0x8 && (!fin || len > 125)) return this.fail(1002);
      if (this.partsLen + len > MAX_FROM_HA) return this.fail(1009);
      if (b.length < off + len) {
        this.need = off + len;
        return b;
      }
      const data = b.subarray(off, off + len);
      b = b.subarray(off + len);
      if (op === 0x8) return this.closing(data);
      if (op === 0x9) {
        if (this.readyState === 1) this.frame(0xa, data);
        continue;
      }
      if (op === 0xa) continue;
      // A continuation needs a message in progress; a new message needs the last one finished.
      if (op > 0x2 || (op === 0x0 ? !this.op : this.op)) return this.fail(1002);
      if (op !== 0x0) this.op = op;
      this.parts.push(data);
      this.partsLen += len;
      if (!fin) continue;
      const text = this.op === 0x1 ? (this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts)).toString('utf8') : null;
      this.parts = [];
      this.partsLen = 0;
      this.op = 0;
      if (text !== null) this.emit('message', { type: 'message', data: text });
    }
  }

  frame(op, payload) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    const off = len < 126 ? 2 : len < 65536 ? 4 : 10;
    const out = Buffer.allocUnsafe(off + 4 + len);
    out[0] = 0x80 | op;
    if (len < 126) out[1] = 0x80 | len;
    else if (len < 65536) {
      out[1] = 0x80 | 126;
      out.writeUInt16BE(len, 2);
    } else {
      out[1] = 0x80 | 127;
      out.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
      out.writeUInt32BE(len >>> 0, 6);
    }
    // A client masks every frame, with a fresh key.
    const mask = randomBytes(4);
    mask.copy(out, off);
    for (let i = 0; i < len; i++) out[off + 4 + i] = payload[i] ^ mask[i & 3];
    this.socket.write(out);
  }

  send(text) {
    if (this.readyState === 1) this.frame(0x1, Buffer.from(String(text), 'utf8'));
  }

  close(code = 1000) {
    if (this.readyState === 0) {
      this.over = true;
      this.socket.destroy();
      return;
    }
    if (this.readyState !== 1) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    this.frame(0x8, p);
    this.readyState = 2;
    this.code = code;
    this.hangUpSoon();
  }

  /** Home Assistant closed: answer with a close of our own unless we sent one first, then hang up. */
  closing(data) {
    this.over = true;
    this.code = data.length >= 2 ? data.readUInt16BE(0) : 1005;
    if (this.readyState === 1) this.frame(0x8, data.subarray(0, 2));
    this.readyState = 2;
    this.socket.end();
    this.hangUpSoon();
    return null;
  }

  hangUpSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.socket.destroy(), CLOSE_WAIT_MS);
    this.timer.unref?.();
  }

  /** Give up on the connection (a socket error, or Home Assistant broke the protocol): 'error', then 'close', as a browser's WebSocket does. */
  fail(code) {
    if (this.readyState === 3) return null;
    if (code && this.readyState === 1) {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code);
      this.frame(0x8, p);
    }
    this.over = true;
    if (this.readyState < 2) this.readyState = 2;
    if (!this.errored) {
      this.errored = true;
      this.emit('error', { type: 'error' });
    }
    this.socket.destroy();
    return null;
  }

  finish() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.over = true;
    clearTimeout(this.timer);
    this.emit('close', { type: 'close', code: this.code });
  }
}

// ---- The screen's side: a WebSocket server, just enough of RFC 6455 for text messages ----

class Peer {
  /** @param {import('node:net').Socket} socket */
  constructor(socket, head) {
    this.socket = socket;
    this.buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.parts = [];
    this.partsLen = 0;
    this.op = 0;
    this.closed = false;
    this.gone = false;
    /** @type {((text: string) => void) | null} */
    this.onText = null;
    /** @type {(() => void) | null} */
    this.onClose = null;
    socket.setNoDelay(true);
    socket.on('data', (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      this.read();
    });
    socket.on('close', () => this.end());
    socket.on('error', () => {
      socket.destroy();
      this.end();
    });
  }

  read() {
    for (;;) {
      const b = this.buf;
      if (this.closed || b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      let len = b[1] & 0x7f;
      let off = 2;
      if ((b[1] & 0x80) === 0) return this.close(1002); // a browser always masks
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = b.readUInt32BE(2) * 2 ** 32 + b.readUInt32BE(6);
        off = 10;
      }
      if (len > MAX_IN) return this.close(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 0x8) return this.close(1000);
      if (op === 0x9) {
        this.frame(0xa, data);
        continue;
      }
      if (op === 0xa) continue;
      if (op > 0x2) return this.close(1002);
      if (op !== 0) {
        this.op = op;
        this.parts = [];
        this.partsLen = 0;
      }
      this.parts.push(data);
      this.partsLen += len;
      if (this.partsLen > MAX_IN) return this.close(1009);
      if (!fin) continue;
      const all = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
      this.parts = [];
      this.partsLen = 0;
      if (this.op === 0x1) this.onText?.(all.toString('utf8'));
    }
  }

  frame(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.alloc(2);
      head[1] = len;
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[1] = 127;
      head.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
      head.writeUInt32BE(len >>> 0, 6);
    }
    head[0] = 0x80 | op;
    this.socket.cork();
    this.socket.write(head);
    this.socket.write(payload);
    this.socket.uncork();
  }

  send(text) {
    this.frame(0x1, Buffer.from(text, 'utf8'));
  }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    this.frame(0x8, p);
    this.closed = true;
    this.socket.end();
    this.end();
  }

  end() {
    this.closed = true;
    if (this.gone) return;
    this.gone = true;
    this.onClose?.();
  }
}

function refuse(socket, code, text) {
  socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Finish the WebSocket handshake. False (and the socket closed) when it isn't one. */
function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    refuse(socket, 400, 'Bad Request');
    return false;
  }
  const answer = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${answer}\r\n\r\n`);
  return true;
}

/** One screen's socket: sign in to Home Assistant, play its opening to the screen, then pass messages through. */
async function relay(socket, head) {
  const peer = new Peer(socket, head);
  /** @type {Upstream | null} */
  let up = null;
  // home-assistant-js-websocket sends its auth as soon as the socket opens, before Home Assistant's
  // (here: our) auth_required: keep what comes early and answer it once the opening is played.
  const early = [];
  peer.onText = (text) => early.push(text);
  peer.onClose = () => {
    try {
      up?.close();
    } catch {
      /* already gone */
    }
  };

  /** Home Assistant's opening, as the screen's library expects it: auth_required, its auth, then the answer. */
  const opening = (version, refusal) => {
    peer.send(JSON.stringify({ type: 'auth_required', ha_version: version }));
    peer.onText = (text) => {
      let msg = null;
      try {
        msg = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      if (msg?.type !== 'auth') return peer.close(1002);
      if (refusal) {
        peer.send(JSON.stringify({ type: 'auth_invalid', message: refusal }));
        peer.close(1000);
        return;
      }
      peer.send(JSON.stringify({ type: 'auth_ok', ha_version: version }));
      pipe();
    };
    for (const text of early.splice(0)) peer.onText?.(text);
  };

  const pipe = () => {
    const ha = /** @type {Upstream} */ (up);
    peer.onText = (text) => {
      let msg = null;
      try {
        msg = JSON.parse(text);
      } catch {
        /* Home Assistant answers malformed messages itself */
      }
      if (typeof msg?.type === 'string' && (BLOCKED.some((re) => re.test(msg.type)) || (ADDON && refusedInAddon(msg)))) {
        peer.send(JSON.stringify({ id: msg.id, type: 'result', success: false, error: { code: 'unauthorized', message: 'Not available to screens connected through the PC.' } }));
        return;
      }
      if (ha.readyState === 1) ha.send(text);
    };
    ha.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') peer.send(ev.data);
    });
    ha.addEventListener('close', () => peer.close(1001));
    ha.addEventListener('error', () => peer.close(1011));
  };

  const saved = load();
  if (!saved) return opening('', NOT_SAVED);
  if (rejected === fingerprint(saved.token)) return opening('', TURNED_DOWN);
  try {
    const r = await signIn(saved, saved.token);
    up = r.ws;
    outcome = 'ok';
    if (peer.gone) {
      up.close();
      return;
    }
    opening(r.version, null);
  } catch (err) {
    if (err.code === 'rejected') {
      rejected = fingerprint(saved.token);
      outcome = 'rejected';
      if (!peer.gone) opening('', TURNED_DOWN);
      return;
    }
    outcome = 'unreachable';
    // Closed before Home Assistant's opening: the screen's library takes it as "can't reach" and retries.
    peer.close(1011);
  }
}

// ---- For the PC's other bridges (ma-bridge.mjs) ----

/** A request from a screen on the home network, sent by the panel itself (the relay's own rules). */
export async function homeScreen(req) {
  if (ADDON) return fromIngress(req) || (lanScreen(req) && sameOrigin(req));
  return localClient(req.socket.remoteAddress) && plainHost(req.headers.host) && sameOrigin(req) && (await fromHome(req, load()));
}

/**
 * Commands to Home Assistant with the sign-in saved on the PC, in order, on one socket that closes
 * after. Resolves their results; rejects with code 'none', 'rejected' or 'unreachable', or with
 * Home Assistant's own error (its code) for the first one it turns down. The token never leaves
 * this module.
 */
export async function haCommands(messages, timeoutMs = 10_000) {
  const saved = load();
  if (!saved) throw failure('none', NOT_SAVED);
  if (rejected === fingerprint(saved.token)) throw failure('rejected', TURNED_DOWN);
  let ws;
  try {
    ws = (await signIn(saved, saved.token)).ws;
    outcome = 'ok';
  } catch (err) {
    if (err.code === 'rejected') rejected = fingerprint(saved.token);
    outcome = err.code === 'rejected' ? 'rejected' : 'unreachable';
    throw err;
  }
  try {
    const out = [];
    let id = 1;
    for (const m of messages) out.push(await ask(ws, { ...m, id: id++ }, timeoutMs));
    return out;
  } finally {
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }
}

/** One command on a signed-in socket: its result, or Home Assistant's error. */
function ask(ws, msg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
    };
    const timer = setTimeout(() => {
      done();
      reject(failure('unreachable', "Home Assistant didn't answer."));
    }, timeoutMs);
    const onClose = () => {
      done();
      reject(failure('unreachable', 'Home Assistant closed the connection.'));
    };
    const onMessage = (ev) => {
      let r;
      try {
        r = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (r.id !== msg.id || r.type !== 'result') return;
      done();
      if (r.success) resolve(r.result);
      else reject(failure(r.error?.code ?? 'failed', r.error?.message ?? 'Home Assistant turned that down.'));
    };
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.send(JSON.stringify(msg));
  });
}

const MAX_RESPONSE = 8 * 1024 * 1024;
/** Kept-alive connections for haRequest (Music Assistant's calls come in bursts). */
const agent = new HttpsAgent({ keepAlive: true, maxSockets: 4 });

/**
 * An HTTP request from the PC to Home Assistant, by the socket's route: to `lan` when there is one,
 * the certificate checked against the address's name. It adds no sign-in: the caller brings what
 * the path needs (an ingress session's cookie). Resolves { status, headers, body } (body: a string).
 */
export async function haRequest(path, { method = 'GET', headers = {}, body = null, timeoutMs = 15_000, maxBytes = MAX_RESPONSE } = {}) {
  const saved = load();
  if (!saved) throw failure('none', NOT_SAVED);
  // The add-on: Home Assistant on its own host, by its internal name (its certificate, if it has
  // one, is for the household's address, so it isn't checked on this private network).
  const c = ADDON ? await core() : null;
  const to = c ? { host: 'homeassistant', port: c.port, secure: c.ssl, name: 'homeassistant', hostHeader: `homeassistant:${c.port}`, internal: true } : upstreamFor(saved);
  return new Promise((resolve, reject) => {
    const head = { Host: to.hostHeader, ...headers, ...(body != null ? { 'Content-Length': Buffer.byteLength(body) } : {}) };
    const tls = to.internal
      ? to.secure
        ? { rejectUnauthorized: false }
        : {}
      : to.secure
      ? {
          agent,
          servername: isIP(to.name) ? undefined : to.name,
          checkServerIdentity: (_host, cert) => checkServerIdentity(to.name, cert),
          rejectUnauthorized: true,
          ca: trustedRoots(),
        }
      : {};
    const req = (to.secure ? httpsRequest : httpRequest)({ host: to.host, port: to.port, path, method, headers: head, timeout: timeoutMs, ...tls }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) res.destroy(failure('unreachable', 'That answer was too big.'));
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(failure('unreachable', "Home Assistant didn't answer.")));
    req.on('error', (err) => reject(err.code === 'unreachable' ? err : failure('unreachable', certificateError(err) ? `The certificate isn't valid for ${to.name}.` : LAN_UNREACHABLE)));
    if (body != null) req.write(body);
    req.end();
  });
}

// ---- Wiring ----

function reply(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => (size > MAX_BODY ? reject(new Error('too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

async function save(req, res) {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return reply(res, 415, { message: 'Send JSON.' });
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return reply(res, 400, { message: "That wasn't a sign-in." });
  }
  // { url } for a local address, { url, lan } for an internet one (signInFor).
  const target = signInFor(body?.url, body?.lan);
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (target.refused) return reply(res, 400, { message: target.refused });
  if (!(await fromHome(req, target))) return reply(res, 403, { message: 'Only a screen on the same network as Home Assistant can save it.' });
  if (token.length < 20 || token.length > 4096) return reply(res, 400, { message: "That doesn't look like a long-lived access token." });
  let ws = null;
  try {
    const r = await signIn(target, token);
    ws = r.ws;
    const user = await currentUser(ws);
    const kept = { url: target.url, ...(target.lan ? { lan: target.lan } : {}), token, user, version: r.version, savedAt: new Date().toISOString() };
    writeFileSync(STORE, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
    rejected = null;
    outcome = 'ok';
    reply(res, 200, status());
  } catch (err) {
    reply(res, 400, { message: err.message || "Couldn't save the sign-in." });
  } finally {
    ws?.close();
  }
}

/** Connect middleware for /__ha/server. */
export function serverSignIn(req, res, next) {
  if ((req.url ?? '').split('?')[0] !== STATUS_PATH) return next();
  if (ADDON) {
    if (!fromIngress(req) && !lanScreen(req)) return reply(res, 403, { message: 'Only from Home Assistant, or a screen on the home network with “no sign-in” on.' });
    if (req.method !== 'GET') return reply(res, 405, { message: 'The add-on keeps no sign-in: Home Assistant gives it one.' });
    return void addonStatus(req).then((s) => reply(res, 200, s));
  }
  if (!localClient(req.socket.remoteAddress) || !plainHost(req.headers.host)) return reply(res, 403, { message: 'Only screens on the home network.' });
  if (req.method === 'POST') {
    if (!sameOrigin(req)) return reply(res, 403, { message: 'Only from the panel itself.' });
    return void save(req, res);
  }
  void (async () => {
    if (!(await fromHome(req, load()))) return reply(res, 403, { message: 'Only screens on the same network as Home Assistant.' });
    if (req.method === 'GET') return reply(res, 200, status());
    if (!sameOrigin(req)) return reply(res, 403, { message: 'Only from the panel itself.' });
    if (req.method !== 'DELETE') return reply(res, 405, { message: 'Not here.' });
    try {
      unlinkSync(STORE);
    } catch {
      /* nothing saved */
    }
    rejected = null;
    outcome = null;
    reply(res, 200, status());
  })();
}

/**
 * What the add-on tells a screen: the sidebar's sign in as their own Home Assistant user (nothing to
 * connect through here, the bridges are there); the no-sign-in port's connect through the relay,
 * with Home Assistant at the address they reached the add-on by (for pictures).
 */
async function addonStatus(req) {
  if (!lanScreen(req)) return { available: true, addon: true, configured: false, url: null, user: null, savedAt: null, state: 'none' };
  const c = await core();
  const host = String(req.headers.host ?? '').replace(/:\d{1,5}$/, '');
  return { available: true, addon: true, configured: true, url: `${c.ssl ? 'https' : 'http'}://${host}:${c.port}`, user: 'Home Assistant', savedAt: null, state: rejected ? 'rejected' : (outcome ?? 'unknown') };
}

const attached = new WeakSet();

/** Answer screens' sockets on /__ha/api/websocket. Every other upgrade (vite's own) is left alone. */
export function attachRelay(httpServer) {
  if (!httpServer || attached.has(httpServer)) return;
  attached.add(httpServer);
  httpServer.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== SOCKET_PATH) return;
    // The add-on: only the no-sign-in port (the sidebar's screens sign in as their own user).
    if (ADDON) {
      if (!lanScreen(req) || !sameOrigin(req)) return refuse(socket, 403, 'Forbidden');
      if (accept(req, socket)) void relay(socket, head);
      return;
    }
    if (!localClient(req.socket.remoteAddress) || !plainHost(req.headers.host) || !sameOrigin(req)) return refuse(socket, 403, 'Forbidden');
    void fromHome(req, load()).then((ok) => {
      if (!ok) refuse(socket, 403, 'Forbidden');
      else if (accept(req, socket)) void relay(socket, head);
    });
  });
}
