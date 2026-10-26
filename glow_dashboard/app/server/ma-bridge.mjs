/**
 * Music Assistant's queue, through the PC (user, 2026-10-26: "I would like to be able to click into
 * playlists and select songs, as well as add them to que and manage que").
 *
 * Home Assistant's Music Assistant actions show a queue's size, its current song and the next one,
 * and nothing more: listing the queue, moving a song, taking one out or starting a playlist at a
 * chosen song needs Music Assistant's own API. That API wants a sign-in of its own, except through
 * Home Assistant's ingress (how HA's sidebar opens Music Assistant). The PC holds an administrator's
 * sign-in (ha-relay.mjs), so it opens an ingress session with it and calls Music Assistant's HTTP
 * API there. Nothing to set up, no second token.
 *
 *   POST /__ma/api   { command, args }  →  200 { result }  |  4xx/5xx { message }
 *
 * And a playlist's or album's songs a page at a time, which Music Assistant's API can't do (user,
 * 2026-10-26: "when loading big playlists it takes a while to load and some times it doesn't at
 * all … only load the fist few and then as you scroll down it loads more"): the PC asks Music
 * Assistant for the whole list once, keeps it (slimmed to what a row shows) and hands it out in pages.
 *
 *   { command: 'panel/tracks', args: { uri, offset, limit } }  →  { result: { items, total } }
 *
 * Only the queue commands in ALLOWED pass, and panel/tracks. Same rules as the relay: screens on the home network,
 * sent by the panel itself (homeScreen). Served by vite's dev and preview servers (vite.config.ts,
 * maBridge); a build copied into Home Assistant has none, and the panel falls back to what Home
 * Assistant's actions offer ($lib/audio/ma-api.ts).
 */
import { haCommands, haRequest, homeScreen } from './ha-relay.mjs';

const PATH = '/__ma/api';
const MAX_BODY = 64 * 1024;
/** A new ingress session after this long (the Supervisor lets an unused one lapse after about 15 minutes). */
const SESSION_MS = 10 * 60_000;

/** The commands screens may send: the queue, nothing that changes Music Assistant's setup or library. */
const ALLOWED = new Set([
  'player_queues/get',
  'player_queues/get_active_queue',
  'player_queues/items',
  'player_queues/play_index',
  'player_queues/move_item',
  'player_queues/move_item_end',
  'player_queues/delete_item',
  'player_queues/clear',
  'player_queues/play_media',
  'player_queues/shuffle',
  'player_queues/repeat',
]);

const failure = (status, message) => Object.assign(new Error(message), { status });
const sup = (endpoint, method = 'get') => ({ type: 'supervisor/api', endpoint, method });

// ---- The ingress session ----

/** { slug, entry } of the Music Assistant add-on, kept while it answers. */
let addon = null;
/** { cookie, at } */
let session = null;
/** The session being opened, shared by the calls that wait for it. */
let opening = null;

/** Music Assistant's add-on: a started one, the stable channel before beta and dev. */
async function findAddon() {
  const [res] = await haCommands([sup('/addons')]);
  const list = (Array.isArray(res?.addons) ? res.addons : Array.isArray(res) ? res : []).filter((a) => /(^|_)music_assistant(_beta|_dev)?$/.test(String(a?.slug ?? '')));
  const rank = (a) => (a.state === 'started' ? 0 : 10) + (/_beta$/.test(a.slug) ? 1 : /_dev$/.test(a.slug) ? 2 : 0);
  const pick = [...list].sort((a, b) => rank(a) - rank(b))[0];
  if (!pick) throw failure(503, "Music Assistant isn't a Home Assistant add-on here, so the PC can't reach its queue.");
  if (pick.state !== 'started') throw failure(503, "Music Assistant's add-on isn't running.");
  return pick.slug;
}

async function open() {
  try {
    const slug = addon?.slug ?? (await findAddon());
    const [info, sess] = await haCommands([sup(`/addons/${slug}/info`), sup('/ingress/session', 'post')]);
    const entry = typeof info?.ingress_entry === 'string' && /^\/api\/hassio_ingress\/[\w-]+$/.test(info.ingress_entry) ? info.ingress_entry : null;
    if (!entry || typeof sess?.session !== 'string') throw failure(503, "Music Assistant's add-on doesn't open through Home Assistant here.");
    addon = { slug, entry };
    session = { cookie: `ingress_session=${sess.session}`, at: Date.now() };
    return session;
  } catch (err) {
    if (err.status) throw err;
    // Home Assistant's own refusals: the Supervisor API is for administrators.
    if (err.code === 'none') throw failure(503, 'No sign-in is saved on the PC. Save one in Settings › Connection.');
    if (err.code === 'unauthorized' || /admin|unauthori/i.test(err.message)) throw failure(503, "The sign-in saved on the PC isn't an administrator's, so it can't open Music Assistant.");
    if (err.code === 'rejected' || err.code === 'unreachable') throw failure(503, err.message);
    throw failure(502, `Home Assistant couldn't open Music Assistant: ${err.message}`);
  }
}

function current(force = false) {
  if (!force && session && Date.now() - session.at < SESSION_MS) return Promise.resolve(session);
  opening ??= open().finally(() => (opening = null));
  return opening;
}

// ---- Music Assistant ----

/** One command on Music Assistant's HTTP API; a lapsed session or a moved add-on is opened again once. */
export async function maCall(command, args = {}, retry = true, timeoutMs = 15_000, maxBytes = undefined) {
  const s = await current();
  const r = await haRequest(`${addon.entry}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: s.cookie },
    body: JSON.stringify({ command, args }),
    timeoutMs,
    ...(maxBytes ? { maxBytes } : {}),
  });
  if (r.status === 401 || r.status === 403 || r.status === 404 || r.status === 502 || r.status === 503) {
    // The session lapsed (401), or the add-on restarted (502/503) or was reinstalled (404).
    if (r.status !== 401 && r.status !== 403) addon = null;
    session = null;
    if (retry) return maCall(command, args, false, timeoutMs, maxBytes);
    throw failure(503, r.status === 401 || r.status === 403 ? 'Home Assistant turned down the session for Music Assistant.' : "Music Assistant isn't answering.");
  }
  let body = null;
  try {
    body = r.body ? JSON.parse(r.body) : null;
  } catch {
    body = r.body;
  }
  if (r.status !== 200) {
    const text = typeof body === 'string' ? body : (body?.details ?? body?.error ?? body?.message ?? '');
    throw failure(400, `Music Assistant: ${String(text || `error ${r.status}`).slice(0, 240)}`);
  }
  return body;
}

// ---- A playlist's songs, a page at a time ----

/** At most this many songs in one page. */
const PAGE_MAX = 200;
/** A list this fresh is handed out as it is; older (up to KEEP_MS) is handed out while it is fetched again. */
const FRESH_MS = 10 * 60_000;
const KEEP_MS = 24 * 60 * 60_000;
/** Lists kept, the ones opened longest ago go first. */
const KEEP_LISTS = 40;
/** Music Assistant fetches a big playlist from the music service page by page: give it time, and room (its Track is a few kB). */
const LIST_TIMEOUT_MS = 120_000;
const LIST_MAX_BYTES = 64 * 1024 * 1024;
/** uri → { at, items, loading } */
const lists = new Map();

/** A picture the screens can load: the music services' own (https), not Music Assistant's local files. */
function pictureOf(t) {
  const all = [...(t?.metadata?.images ?? []), t?.image, t?.album?.image, ...(t?.album?.metadata?.images ?? [])].filter((i) => i && typeof i.path === 'string');
  const pick = all.find((i) => i.remotely_accessible && i.type === 'thumb') ?? all.find((i) => i.remotely_accessible);
  return pick && /^https:\/\//.test(pick.path) ? pick.path : null;
}

/** What a song's row shows, from Music Assistant's Track. */
function slim(t) {
  if (!t || typeof t.uri !== 'string' || typeof t.name !== 'string') return null;
  const artists = (Array.isArray(t.artists) ? t.artists : []).map((a) => a?.name).filter((n) => typeof n === 'string' && n);
  return {
    uri: t.uri,
    name: t.version ? `${t.name} (${t.version})` : t.name,
    artists: artists.length ? artists.join(', ') : null,
    album: typeof t.album?.name === 'string' ? t.album.name : null,
    image: pictureOf(t),
    duration: typeof t.duration === 'number' && t.duration > 0 ? t.duration : null,
    available: t.is_playable !== false && t.available !== false,
  };
}

async function fetchList(uri) {
  const m = /^([\w-]+):\/\/(playlist|album)\/(.+)$/.exec(uri);
  if (!m) throw failure(400, "That isn't a Music Assistant playlist or album.");
  const [, provider, type, id] = m;
  const command = type === 'album' ? 'music/albums/album_tracks' : 'music/playlists/playlist_tracks';
  const res = await maCall(command, { item_id: id, provider_instance_id_or_domain: provider }, true, LIST_TIMEOUT_MS, LIST_MAX_BYTES);
  const raw = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : null;
  // An answer in another shape: say so (the screen then takes the list through Home Assistant).
  if (!raw) throw failure(502, "Music Assistant's answer for the songs wasn't a list.");
  return raw.map(slim).filter(Boolean);
}

/** The list's songs: kept, or fetched (once, however many screens ask). */
function songsOf(uri) {
  const now = Date.now();
  const e = lists.get(uri);
  if (e) {
    // Most recently opened last.
    lists.delete(uri);
    lists.set(uri, e);
  }
  const load = () => {
    const entry = lists.get(uri) ?? { at: 0, items: null, loading: null };
    entry.loading ??= fetchList(uri)
      .then((items) => {
        entry.items = items;
        entry.at = Date.now();
        return items;
      })
      .finally(() => (entry.loading = null));
    lists.set(uri, entry);
    while (lists.size > KEEP_LISTS) lists.delete(lists.keys().next().value);
    return entry.loading;
  };
  if (e?.items && now - e.at < FRESH_MS) return Promise.resolve(e.items);
  if (e?.items && now - e.at < KEEP_MS) {
    // Older: as it was, and fetched again for next time.
    void load().catch(() => {});
    return Promise.resolve(e.items);
  }
  return e?.loading ?? load();
}

async function tracksPage(args) {
  const uri = typeof args.uri === 'string' ? args.uri : '';
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(args.limit) || 50)));
  const items = await songsOf(uri);
  return { items: items.slice(offset, offset + limit), total: items.length };
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

/** Connect middleware for /__ma/api. */
export function maApi(req, res, next) {
  if ((req.url ?? '').split('?')[0] !== PATH) return next();
  void (async () => {
    if (req.method !== 'POST') return reply(res, 405, { message: 'Not here.' });
    if (!(await homeScreen(req))) return reply(res, 403, { message: 'Only screens on the same network as Home Assistant.' });
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return reply(res, 415, { message: 'Send JSON.' });
    let msg;
    try {
      msg = JSON.parse(await readBody(req));
    } catch {
      return reply(res, 400, { message: "That wasn't a command." });
    }
    const command = typeof msg?.command === 'string' ? msg.command : '';
    const args = msg?.args && typeof msg.args === 'object' && !Array.isArray(msg.args) ? msg.args : {};
    if (command !== 'panel/tracks' && !ALLOWED.has(command)) return reply(res, 403, { message: `${command || 'That'} isn't available to screens.` });
    try {
      reply(res, 200, { result: command === 'panel/tracks' ? await tracksPage(args) : await maCall(command, args) });
    } catch (err) {
      reply(res, err.status ?? 502, { message: err.message || "Music Assistant didn't answer." });
    }
  })();
}
