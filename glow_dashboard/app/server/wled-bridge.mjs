/**
 * The WLED bridge: the server watches what each WLED strip is showing, so the screens don't have
 * to (user, 2026-10-24: "I want it to be a real render of what the lights are actually doing.
 * have this all done on the server not device so it saves the device resources").
 *
 * One live connection per strip, whatever the number of screens: `ws://<strip>/ws`, then
 * `{"lv":true}`, and WLED streams binary frames ('L', version, RGB triplets; version 2 is a matrix
 * with its width and height first) about every 40 ms. WLED keeps ONE live-view client per strip
 * and gives it to whoever asked last (`{"lv":false}` gives it to nobody), so this server is the
 * only holder: every screen's cards, sheets and strip cards get their LEDs from here, never from
 * the strip itself (user, 2026-10-25: "wled says live view in use else where is dumb", "the
 * updates of the button … for WLED seem to get stuck often and they're not smooth").
 *
 *   GET /__wled/stream?hosts=192.168.1.50,192.168.1.51&full=192.168.1.50   text/event-stream
 *     data: {"host":"192.168.1.50","leds":"ff0000ff8800…","count":120,"segs":[[0,60],[60,120]]}
 *     data: {"host":"192.168.1.50","full":"ff0000…","w":120,"h":1}
 *     data: {"host":"192.168.1.50","info":{"leds":{"count":120},"ver":"0.14.0",…},"seg":[{"id":0,…}]}
 *     data: {"host":"192.168.1.50","alive":1}
 *     data: {"host":"192.168.1.51","status":"unreachable"}
 *     event: ping
 *
 *   - `hosts`: a card's few colours. Each frame is boiled down to LEDS averaged colours, sent at
 *     most RATE times a second and only when they changed; a card cross-fades from one to the next.
 *   - `full`: every LED, for the details sheet's rail and the strip card (WLED's live view caps
 *     around 256 LEDs; a matrix keeps its width and height), at most FULL_RATE a second and only
 *     when it changed, plus "alive" once a second while nothing does; and WLED's own info and
 *     segments (LED count, matrix, live input, version, name, segment colours) when they change.
 *   - Both: the newest of everything at once on subscribe, and a status when frames stop: "busy"
 *     (connected, asked, still nothing: WLED's own page has the live view) or "unreachable"; and
 *     "refused" at once for an address it won't follow (not on the local network).
 *
 * Never stuck: silence means the slot was lost (another screen on an old build, WLED's own page
 * peeking, a sheet that let go with `{"lv":false}`), so after SILENT_MS without a frame the bridge
 * asks again, opens a new connection if that doesn't help, then keeps asking gently (REASK_MS);
 * a slot lost again soon after winning it back is asked for gently too, so it doesn't fight
 * WLED's own page. Unreachable strips back off up to a minute.
 *
 * One holder for the whole PC, too: several servers may run here at once (the dev server, a
 * stable build for the tablet, a measuring build), and two holders would take the slot from each
 * other. The first to follow a strip writes a small lock (`%TEMP%/panel-wled-holders/<strip>.json`:
 * its pid, port and instance); any other server follows that one's stream for the strip instead
 * of the strip itself (`&from=` names the asker, so a server never follows itself), and takes
 * over when it's gone (dead pid, no answer, not a bridge).
 *
 * Served by vite's dev and preview servers (vite.config.ts, wledBridge). A build copied into Home
 * Assistant has no bridge: the screens see a 404 and fall back (cards: Home Assistant's own colours;
 * the sheet: the strip directly). Strips are only ever read (never written), and only on the local
 * network.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Twelve averaged colours: a card blends 6 of them (12 on a wide one), like the HA integration. */
const LEDS = 12;
/** Card colours a second at most: each cross-fades into the next, so 8 reads as a glide. */
const RATE = 8;
/** Full frames a second at most, for a rail that draws every LED. */
const FULL_RATE = 15;
/** A full subscriber hears "alive" this often while nothing changes (its rail keeps the real LEDs). */
const ALIVE_MS = 800;
const WATCH_MS = 500;
const IDLE_CLOSE_MS = 15_000;
const OPEN_TIMEOUT_MS = 4_000;
/** WLED sends a frame every ~40 ms while the live view is ours: this long without one, it isn't. */
const SILENT_MS = 8_000;
/** After asking again, frames should be back this soon; if not, the screens hear and it tries anew. */
const ASK_WAIT_MS = 4_000;
/** Asking again while the strip stays silent, or someone keeps taking the slot back: gently. */
const REASK_MS = 25_000;
/** Lost again this soon after winning it back: someone (WLED's own page) wants it. */
const CONTEST_MS = 120_000;
const PING_MS = 15_000;
/** A screen that stopped reading (a dead connection) is let go before its backlog grows. */
const MAX_BACKLOG = 1 << 20;
/** Following another server: this long without a word (it pings every 15 s), it's gone. */
const FOLLOW_QUIET_MS = 40_000;

// ---- One holder per strip for the whole PC ----

/** This server (a restarted dev server is a new one, in the same process). */
const ME = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
/** The port this server answers on, learnt from its first request. */
let myPort = 0;
const HOLDERS = path.join(tmpdir(), 'panel-wled-holders');
const lockOf = (host) => path.join(HOLDERS, `${host.replace(/[^a-z0-9.-]/gi, '_')}.json`);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function readLock(host) {
  try {
    return JSON.parse(readFileSync(lockOf(host), 'utf8'));
  } catch {
    return null;
  }
}

/** The lock files: who on this PC holds each strip's live view. */
export const fileHolders = {
  /** Hold the strip (null), or the other server that does ({ pid, port, id }). */
  claim(host) {
    const me = JSON.stringify({ pid: process.pid, port: myPort, id: ME });
    try {
      mkdirSync(HOLDERS, { recursive: true });
      writeFileSync(lockOf(host), me, { flag: 'wx' });
      return null;
    } catch (e) {
      if (e?.code !== 'EEXIST') return null; // no lock to be had: hold it ourselves
    }
    const other = readLock(host);
    if (other && other.id !== ME && other.port && alive(other.pid)) return other;
    this.take(host);
    return null;
  },
  /** The holder named is gone: this server holds the strip now. */
  take(host) {
    try {
      writeFileSync(lockOf(host), JSON.stringify({ pid: process.pid, port: myPort, id: ME }));
    } catch {
      /* hold it anyway */
    }
  },
  /** Done with the strip: the lock goes, if it is still ours. */
  release(host) {
    if (readLock(host)?.id !== ME) return;
    try {
      unlinkSync(lockOf(host));
    } catch {
      /* gone already */
    }
  },
};

/** Private-network addresses and .local names only: the bridge never reaches the internet. */
export function cleanHost(raw) {
  const h = String(raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!h || h.length > 80) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d{1,5})?$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const priv = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    return priv ? h : null;
  }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.local(?::\d{1,5})?$/.test(h) ? h : null;
}

const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');

/** Averages a frame's RGB triplets down to at most LEDS colours, as one hex string. */
export function boil(data) {
  const n = Math.floor(data.length / 3);
  if (!n) return '';
  const k = Math.min(LEDS, n);
  let out = '';
  for (let i = 0; i < k; i++) {
    const a = Math.floor((i * n) / k);
    const z = Math.max(a + 1, Math.floor(((i + 1) * n) / k));
    let r = 0;
    let g = 0;
    let b = 0;
    for (let j = a; j < z; j++) {
      r += data[j * 3];
      g += data[j * 3 + 1];
      b += data[j * 3 + 2];
    }
    const c = z - a;
    out += hex2(r / c) + hex2(g / c) + hex2(b / c);
  }
  return out;
}

/** A live-view frame: its RGB bytes and its shape (a strip is n × 1; version 2 gives a matrix's). */
export function parseFrame(b) {
  if (!b || b.length < 5 || b[0] !== 0x4c) return null;
  if (b[1] === 2) {
    const data = b.subarray(4);
    const w = b[2];
    const h = b[3];
    const n = Math.floor(data.length / 3);
    return w > 0 && h > 0 && w * h <= n ? { data: data.subarray(0, w * h * 3), w, h } : { data, w: n, h: 1 };
  }
  const data = b.subarray(2);
  return { data, w: Math.floor(data.length / 3), h: 1 };
}

/** Bytes as hex, for a full frame. */
export const hexOf = (data) => Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('hex');

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** What the details sheet reads from WLED's info (wled-live.svelte.ts, readInfo). */
function pickInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const leds = info.leds ?? {};
  return { leds: { count: leds.count, matrix: leds.matrix }, live: info.live, lip: info.lip, ver: info.ver, name: info.name };
}

/** …and from each segment (readSegs). */
const pickSeg = (s) => (s && typeof s === 'object' ? { id: s.id, start: s.start, stop: s.stop, n: s.n, col: s.col } : null);

/**
 * One strip, followed for every screen that shows it: straight from the strip, or through the
 * server on this PC that holds it. `connect` opens the strip's websocket, `holders` keeps the
 * locks, `fetch` reads another server's stream (stand-ins in tests).
 */
export class Link {
  constructor(host, { connect = (url) => new WebSocket(url), holders = fileHolders, fetch = globalThis.fetch } = {}) {
    this.host = host;
    this.connect = connect;
    this.holders = holders;
    this.fetch = fetch;
    /** 'strip' (holds the live view) or 'follow' (relays the server that does). */
    this.mode = 'strip';
    this.upstream = null;
    /** Following: the newest messages, for a screen that subscribes. */
    this.cardText = '';
    this.fullText = '';
    /** Screens that show its few colours (cards), and screens that draw every LED (a sheet, a strip card). */
    this.cards = new Set();
    this.fulls = new Set();
    this.ws = null;
    /** 'connecting' (never live yet), 'live', 'busy' (connected, no frames), 'unreachable'. */
    this.status = 'connecting';
    this.leds = '';
    this.count = 0;
    this.segs = null;
    /** The newest frame, its shape, and the info message for full subscribers. */
    this.raw = null;
    this.w = 0;
    this.h = 1;
    this.info = null;
    this.seg = null;
    this.infoMsg = '';
    this.bornAt = Date.now();
    this.frameAt = 0;
    this.openedAt = 0;
    this.askedAt = 0;
    /** When frames came back after asking again (a slot lost soon after is contested). */
    this.wonAt = -Infinity;
    /** Asks and new connections in the current silence. */
    this.tries = 0;
    this.cardDirty = false;
    this.fullDirty = false;
    this.cardAt = 0;
    this.fullAt = 0;
    this.cardTimer = null;
    this.fullTimer = null;
    this.closeTimer = null;
    this.retryTimer = null;
    this.watchTimer = null;
    this.backoff = 2_000;
  }

  has() {
    return this.cards.size > 0 || this.fulls.size > 0;
  }

  all() {
    return new Set([...this.cards, ...this.fulls]);
  }

  add(sub, card = true, full = false) {
    clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (card) this.cards.add(sub);
    if (full) this.fulls.add(sub);
    if (!this.watchTimer) this.watchTimer = setInterval(() => this.watch(), WATCH_MS);
    if (!this.ws && !this.upstream && !this.retryTimer) this.open();
    this.latest(sub, card, full);
  }

  remove(sub) {
    this.cards.delete(sub);
    this.fulls.delete(sub);
    if (this.has()) return;
    clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.closeTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
  }

  /** A new subscriber gets the newest of everything at once (nothing older than a silence). */
  latest(sub, card, full) {
    const following = this.mode === 'follow';
    if (this.status === 'live' && Date.now() - this.frameAt < SILENT_MS) {
      if (card && (following ? this.cardText : this.leds)) sub.send(following ? this.cardText : this.cardMessage());
      if (full && (following ? this.fullText : this.raw)) sub.send(following ? this.fullText : this.fullMessage());
    } else if (this.status === 'busy' || this.status === 'unreachable') sub.send(this.statusMessage());
    if (full && this.infoMsg) sub.send(this.infoMsg);
  }

  cardMessage() {
    return JSON.stringify({ host: this.host, leds: this.leds, count: this.count, segs: this.segs });
  }

  fullMessage() {
    return JSON.stringify({ host: this.host, full: hexOf(this.raw), w: this.w, h: this.h });
  }

  statusMessage() {
    return JSON.stringify({ host: this.host, status: this.status });
  }

  send(subs, msg) {
    for (const s of subs) s.send(msg);
  }

  open() {
    this.retryTimer = null;
    // Another server on this PC holds it: follow that one, so the strip has one holder.
    const other = this.holders.claim(this.host);
    if (other) return this.follow(other);
    this.mode = 'strip';
    let ws;
    try {
      ws = this.connect(`ws://${this.host}/ws`);
    } catch {
      return this.fail();
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.openedAt = Date.now();
    const timeout = setTimeout(() => {
      if (ws.readyState !== 1) ws.close();
    }, OPEN_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(timeout);
      if (this.ws !== ws) return;
      this.backoff = 2_000;
      this.openedAt = Date.now();
      this.ask();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      if (typeof ev.data === 'string') return this.json(ev.data);
      const f = parseFrame(new Uint8Array(ev.data));
      if (f) this.frame(f);
    };
    ws.onclose = () => {
      clearTimeout(timeout);
      if (this.ws !== ws) return;
      this.ws = null;
      this.fail();
    };
    ws.onerror = () => {};
  }

  ask() {
    try {
      this.ws?.send('{"lv":true}');
    } catch {
      /* closing: its close starts a new one */
    }
    this.askedAt = Date.now();
  }

  /** A new connection in place of one that may have died without closing; its open asks. */
  reopen() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* gone */
      }
    }
    this.open();
  }

  /**
   * Relays the server on this PC that holds the strip: its stream for this strip (cards and full,
   * whatever this server's screens want: it's all on the loopback), message for message. When it
   * ends, this server follows again or, if that server is gone (never answered as a bridge), takes
   * the strip over.
   */
  follow(other) {
    this.mode = 'follow';
    const ac = new AbortController();
    this.upstream = ac;
    const h = encodeURIComponent(this.host);
    const url = `http://localhost:${other.port}/__wled/stream?hosts=${h}&full=${h}&from=${encodeURIComponent(ME)}`;
    let heard = Date.now();
    const check = setInterval(() => {
      if (Date.now() - heard > FOLLOW_QUIET_MS) ac.abort();
    }, 10_000);
    let answered = false;
    void (async () => {
      try {
        const r = await this.fetch(url, { signal: ac.signal });
        if (!r.ok || !r.body || !String(r.headers?.get?.('content-type') ?? '').startsWith('text/event-stream')) return;
        answered = true;
        const dec = new TextDecoder();
        let buf = '';
        for await (const chunk of r.body) {
          heard = Date.now();
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of block.split('\n')) if (line.startsWith('data: ')) this.relay(line.slice(6));
          }
        }
      } catch {
        /* refused, reset, or aborted */
      } finally {
        clearInterval(check);
        if (this.upstream === ac) {
          this.upstream = null;
          if (!answered) this.holders.take(this.host);
          if (this.has()) this.retryTimer = setTimeout(() => this.open(), answered ? 1_000 : 0);
        }
      }
    })();
  }

  relay(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m?.host !== this.host) return;
    const now = Date.now();
    if (typeof m.leds === 'string') {
      this.cardText = text;
      this.status = 'live';
      this.frameAt = now;
      this.send(this.cards, text);
    } else if (typeof m.full === 'string') {
      this.fullText = text;
      this.status = 'live';
      this.frameAt = now;
      this.send(this.fulls, text);
    } else if (m.alive) {
      this.frameAt = now;
      this.send(this.fulls, text);
    } else if ('info' in m || 'seg' in m) {
      this.infoMsg = text;
      this.send(this.fulls, text);
    } else if (typeof m.status === 'string') {
      this.status = m.status;
      this.send(this.all(), text);
    }
  }

  /** WLED sends its state as JSON on connect and on changes: the segments, the LED count, its info. */
  json(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return; /* a pong, or something else */
    }
    const info = m?.info;
    const seg = m?.state?.seg;
    const count = Number(info?.leds?.count);
    if (Number.isFinite(count) && count > 0 && count !== this.count) {
      this.count = count;
      this.cardDirty = true;
    }
    if (Array.isArray(seg)) {
      const segs = seg.filter((s) => s && typeof s.start === 'number' && typeof s.stop === 'number').map((s) => [s.start, s.stop]);
      if (JSON.stringify(segs) !== JSON.stringify(this.segs)) {
        this.segs = segs;
        this.cardDirty = true;
      }
      this.seg = seg.map(pickSeg).filter(Boolean);
    }
    if (info) this.info = pickInfo(info);
    if (!info && !Array.isArray(seg)) return;
    const msg = JSON.stringify({ host: this.host, info: this.info, seg: this.seg });
    if (msg !== this.infoMsg) {
      this.infoMsg = msg;
      this.send(this.fulls, msg);
    }
    if (this.cardDirty && this.status === 'live' && this.cards.size) this.schedule(true);
  }

  frame({ data, w, h }) {
    const now = Date.now();
    if (this.tries) {
      this.tries = 0;
      this.wonAt = now;
    }
    this.frameAt = now;
    if (this.status !== 'live') {
      // Back (or here at last): every screen hears, even what it had before the silence.
      this.status = 'live';
      this.cardDirty = true;
      this.fullDirty = true;
    }
    const leds = boil(data);
    if (leds && leds !== this.leds) {
      this.leds = leds;
      this.cardDirty = true;
    }
    if (!this.raw || w !== this.w || h !== this.h || !same(data, this.raw)) {
      this.raw = data;
      this.w = w;
      this.h = h;
      this.fullDirty = true;
    }
    if (this.cardDirty && this.cards.size) this.schedule(true);
    if (this.fullDirty && this.fulls.size) this.schedule(false);
  }

  /** Sends the newest when the rate allows (never more often, and the newest at the time of sending). */
  schedule(card) {
    if (card ? this.cardTimer : this.fullTimer) return;
    const gap = 1000 / (card ? RATE : FULL_RATE);
    const wait = Math.max(0, gap - (Date.now() - (card ? this.cardAt : this.fullAt)));
    const t = setTimeout(() => {
      if (card) {
        this.cardTimer = null;
        if (!this.cardDirty || this.status !== 'live') return;
        this.cardDirty = false;
        this.cardAt = Date.now();
        this.send(this.cards, this.cardMessage());
      } else {
        this.fullTimer = null;
        if (!this.fullDirty || this.status !== 'live' || !this.raw) return;
        this.fullDirty = false;
        this.fullAt = Date.now();
        this.send(this.fulls, this.fullMessage());
      }
    }, wait);
    if (card) this.cardTimer = t;
    else this.fullTimer = t;
  }

  /** Twice a second while anyone watches: "alive" for the rails, and what to do about a silence. */
  watch() {
    // Following: the server that holds the strip does all this (and its "alive" is relayed).
    if (this.mode === 'follow') return;
    const now = Date.now();
    if (this.status === 'live' && this.fulls.size && !this.fullTimer && now - this.fullAt >= ALIVE_MS) {
      this.fullAt = now;
      this.send(this.fulls, JSON.stringify({ host: this.host, alive: 1 }));
    }
    const open = this.ws?.readyState === 1;
    // Frames stopped (or never came) and asking didn't bring them: say so, so cards go back to
    // Home Assistant's colour and a sheet to its simulation, rather than freezing on the last frame.
    const quiet = now - (this.frameAt || this.bornAt) >= SILENT_MS + ASK_WAIT_MS;
    if (quiet && (this.status === 'live' || (this.status === 'connecting' && open))) {
      this.status = open ? 'busy' : 'unreachable';
      this.send(this.all(), this.statusMessage());
    }
    if (!open) return;
    if (this.tries === 0) {
      const contested = this.frameAt - this.wonAt < CONTEST_MS;
      if (now - Math.max(this.frameAt, this.openedAt) < (contested ? REASK_MS : SILENT_MS)) return;
      this.tries = 1;
      return this.ask();
    }
    if (now - this.askedAt < (this.tries === 1 ? ASK_WAIT_MS : REASK_MS)) return;
    this.tries++;
    // Asking didn't help: perhaps the connection died without closing. Every other try is a new one.
    if (this.tries % 2 === 0) this.reopen();
    else this.ask();
  }

  fail() {
    this.tries = 0;
    if (!this.has()) return;
    // Never got going (or was already silent): say so now. A strip that was live keeps its colours
    // on the screens until the watch gives up on it, so a reboot or a blip doesn't flash them.
    if (this.status === 'connecting' || this.status === 'busy') {
      this.status = 'unreachable';
      this.send(this.all(), this.statusMessage());
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.has()) this.open();
    }, this.backoff);
    this.backoff = Math.min(60_000, this.backoff * 2);
  }

  close() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.cardTimer);
    clearTimeout(this.fullTimer);
    clearInterval(this.watchTimer);
    this.retryTimer = this.cardTimer = this.fullTimer = this.watchTimer = null;
    const up = this.upstream;
    this.upstream = null;
    up?.abort();
    this.holders.release(this.host);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        // Let go of the live slot only while it is ours: whoever has it now (WLED's own page) keeps it.
        if (ws.readyState === 1 && Date.now() - this.frameAt < 2_000) ws.send('{"lv":false}');
        ws.close();
      } catch {
        /* gone */
      }
    }
    if (links.get(this.host) === this) links.delete(this.host);
  }
}

const links = new Map();

/** Connect middleware for /__wled/stream (dev and preview servers). */
export function wledStream(req, res, next) {
  if (!req.url || !req.url.startsWith('/__wled/stream')) return next();
  const url = new URL(req.url, 'http://bridge');
  if (req.socket?.localPort) myPort = req.socket.localPort;
  // This server asking itself (the holder it was told of was an earlier copy of it): not a bridge
  // to follow, so it holds the strip itself.
  if (url.searchParams.get('from') === ME) {
    res.writeHead(409);
    return void res.end();
  }
  const refused = new Set();
  const list = (key) =>
    new Set(
      (url.searchParams.get(key) ?? '')
        .split(',')
        .filter((raw) => raw.trim())
        .map((raw) => cleanHost(raw) ?? void refused.add(raw.trim().toLowerCase().slice(0, 80)))
        .filter(Boolean),
    );
  const cards = list('hosts');
  const full = list('full');
  const hosts = [...new Set([...cards, ...full])].slice(0, 32);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  // A screen that loses the stream (this server restarting) is back within a couple of seconds.
  res.write('retry: 2000\n\n');
  const sub = {
    send: (msg) => {
      if (res.writableLength > MAX_BACKLOG) return void res.destroy();
      res.write(`data: ${msg}\n\n`);
    },
  };
  // Not on the local network (or not an address at all): the screen reaches it some other way.
  for (const host of refused) sub.send(JSON.stringify({ host, status: 'refused' }));
  const mine = hosts.map((h) => {
    let link = links.get(h);
    if (!link) links.set(h, (link = new Link(h)));
    link.add(sub, cards.has(h), full.has(h));
    return link;
  });
  // A named event, so the screen can tell a quiet stream from a dead one (comments never reach it).
  const ping = setInterval(() => res.write('event: ping\ndata: 1\n\n'), PING_MS);
  req.on('close', () => {
    clearInterval(ping);
    for (const link of mine) link.remove(sub);
  });
}
