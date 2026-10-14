// discord-listening — see README.md (same folder) for setup, commands, and the list of
// discord-rpc quirks this works around before touching the logic below
import { Client } from "@xhayper/discord-rpc";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, watchFile } from "node:fs";
import { homedir } from "node:os";
import readline from "node:readline";
import { promisify } from "node:util";
import path from "node:path";

const isWin = process.platform === "win32";
const OFF_FILE = `${homedir()}/.discord-listening-off`;
const HIDE_FILE = path.join(homedir(), "discord-listening", "hide.txt");
const NETFLIX_MAP = path.join(homedir(), "discord-listening", "netflix-map.json");
// discord ipc: unix sockets under XDG_RUNTIME_DIR on linux, named pipes on windows
const SOCKET_DIR = isWin ? "\\\\.\\pipe\\" : process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
if (!CLIENT_ID) {
  console.error("Set DISCORD_CLIENT_ID (Application ID from discord.com/developers/applications)");
  process.exit(1);
}

const PLATFORM_NAMES = {
  spotify: "Spotify",
  spotifast: "Spotify",
  firefox: "Firefox",
  librewolf: "LibreWolf",
  chromium: "Chromium",
  brave: "Brave",
  mpv: "mpv",
  vlc: "VLC",
  celluloid: "Celluloid",
  strawberry: "Strawberry",
  chrome: "Chrome",
  msedge: "Microsoft Edge",
  zunemusic: "Media Player",
  itunes: "iTunes",
  tidal: "Tidal",
};

const run = promisify(execFile);

// green-on-transparent logo (the official favicon is black-on-black on dark themes)
const SPOTIFY_ICON = "https://commons.wikimedia.org/wiki/Special:FilePath/Spotify_icon.svg?width=512"; // spotify + spotifast share it

// netflix drm hides show name/art; you maintain them per watch-id in netflix-map.json
// (copy the artwork url from netflix: right-click a poster -> copy image address)
function netflixInfo(id) {
  try {
    return JSON.parse(readFileSync(NETFLIX_MAP, "utf8"))[id] ?? null;
  } catch {
    return null;
  }
}

// discord square-crops large images — pad via wsrv.nl's fit=contain so nothing is cut off
// (public proxy, so discord's cloud can fetch it; black padding blends with dark themes)
function squareArt(url) {
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=512&h=512&fit=contain&cbg=000000`;
}

// prefer 16:9 thumbnail variants (hqdefault bakes in 4:3 letterbox bars; clean 16:9 + squareArt
const ytThumbCache = new Map();
async function ytThumb(id) {
  if (ytThumbCache.has(id)) return ytThumbCache.get(id);
  let url = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  for (const q of ["maxresdefault", "hq720"]) {
    try {
      const res = await fetch(`https://i.ytimg.com/vi/${id}/${q}.jpg`, { method: "HEAD" });
      if (res.ok) {
        url = `https://i.ytimg.com/vi/${id}/${q}.jpg`;
        break;
      }
    } catch {}
  }
  ytThumbCache.set(id, url);
  return url;
}

async function currentTrack(prevPlayer) {
  let players;
  if (isWin) {
    // smtc-poll.ps1 keeps `smtc` updated (one normalized snapshot per change)
    players = smtc.filter((p) => p.title);
    if (!players.length) return null;
  } else {
    let stdout;
    try {
      ({ stdout } = await run("playerctl", [
        "-a",
        "metadata",
        "--format",
        "{{playerName}}|{{title}}|{{artist}}|{{status}}|{{mpris:length}}|{{xesam:url}}|{{mpris:artUrl}}|{{xesam:album}}",
      ]));
    } catch {
      return null; // no players
    }
    players = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [player, title, artist, status, lengthUs, url, artUrl, album] = line.split("|");
        return { player, title, artist, status, lengthUs: parseFloat(lengthUs), url, artUrl, album };
      })
      .filter((p) => p.title);
  }
  if (!players.length) return null;
  // drop hidden players (hide.txt, one name per line)
  let hide = [];
  try {
    hide = readFileSync(HIDE_FILE, "utf8")
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith("#"));
  } catch {}
  const visible = players.filter((p) => !hide.includes(p.player.toLowerCase()));
  if (!visible.length) return null;
  // playing beats paused (so background firefox can't shadow active spotify)
  const pool = visible.filter((p) => p.status === "Playing");
  const candidates = pool.length ? pool : visible;
  // stickiness: if the player already showing is still playing, keep it — stops
  // flapping when firefox/plasma fight over multiple tabs
  const still = prevPlayer ? candidates.find((p) => p.player === prevPlayer) : null;
  // among equals prefer the richer entry (plasma-browser-integration beats bare firefox:
  // its url is the live tab url — firefox's media session url goes stale on netflix next-episode)
  const pick =
    still ??
    candidates.find((p) => p.artUrl) ??
    candidates.find((p) => p.player === "plasma-browser-integration") ??
    candidates[0];
  let position = NaN;
  if (isWin) {
    position = pick.position; // smtc snapshot includes it
  } else {
    try {
      position = parseFloat((await run("playerctl", ["--player", pick.player, "position"])).stdout.trim());
    } catch {}
  }
  return { ...pick, position };
}

// one client per discord-ipc socket: real Discord and equibop's arRPC each get their own
function socketPaths() {
  try {
    return readdirSync(SOCKET_DIR)
      .filter((f) => /^discord-ipc-\d+$/.test(f))
      .sort()
      .map((f) => path.join(SOCKET_DIR, f));
  } catch {
    return [];
  }
}

let clients = []; // { rpc, path, connected }
let socketKey = "";

function buildClients() {
  const paths = socketPaths();
  const key = paths.join(",");
  if (key === socketKey) return;
  socketKey = key;
  for (const c of clients) c.rpc.destroy?.().catch(() => {});
  clients = paths.map((p) => ({
    path: p,
    connected: false,
    lastKey: undefined, // undefined = must set on next tick (fresh/reconnected client)
    rpc: new Client({
      clientId: CLIENT_ID,
      transport: { type: "ipc", pathList: [{ platform: [process.platform], format: () => p }] },
    }),
  }));
  console.log("watching sockets:", paths.map((p) => path.basename(p)).join(" "));
}

let anchor = { key: "", pos: 0, at: 0 }; // where the song position was when we last set presence
let lastPick = null; // player currently shown, for stickiness across ticks

async function tick() {
  buildClients();

  const off = existsSync(OFF_FILE);
  const t = off ? null : await currentTrack(lastPick);
  // "off" sentinel so off/on transitions always count as a change
  // status in key so play/pause counts as a change
  // status + episode length in key so play/pause and netflix episode changes count as changes
  const key = off
    ? "off"
    : t
      ? `${t.player}|${t.title}|${t.artist}|${t.status}|${t.lengthUs}`
      : "";

  // seek detection: player position far from where the presence clock should be -> re-set timestamps
  if (t?.status === "Playing" && Number.isFinite(t.position) && anchor.key === key) {
    const expected = anchor.pos + (Date.now() - anchor.at) / 1000;
    if (Math.abs(t.position - expected) > 3)
      for (const c of clients) c.lastKey = ""; // force re-set everywhere
  }

  for (const c of clients) {
    if (!c.connected) {
      try {
        await c.rpc.login();
        c.connected = true;
        console.log(`connected: ${path.basename(c.path)}`);
      } catch {
        c.rpc.destroy?.().catch(() => {}); // clears the rejected cached connectionPromise, or login() fails forever
        c.rpc.removeAllListeners?.("connected"); // failed logins leak once("connected") listeners each tick
        c.connected = false;
        continue; // that client's app isn't up yet, retry next tick
      }
    }
    if (c.lastKey === key) continue;
    try {
      if (!t) {
        await c.rpc.user?.clearActivity();
      } else {
        // clear first: discord merges omitted fields into the previous activity, so a
        // clean wipe is the only way stale artist/art/timestamps can't leak across players
        await c.rpc.user?.clearActivity();
        if (t.status !== "Playing") {
          // pause: clear only — re-setting re-inherits the running bar (observed)
          if (path.basename(c.path) === "discord-ipc-0") console.log("paused -> cleared");
          c.lastKey = key; // remember the paused key, or the resumed Playing key would look "unchanged"
          continue;
        }
        // youtube videos: WATCHING type, public thumbnail as cover, "youtube" badge
        // netflix: drm hides the show name/art — "Watching Netflix" + logo asset + bar
        const yt = t.url?.match(/youtube\.com\/watch\?v=([\w-]+)/);
        const nf = t.url?.match(/netflix\.com\/watch\/(\d+)/);
        const activity = {
          type: yt || nf ? 3 : 2, // WATCHING for video, LISTENING otherwise
          details: t.title,
          instance: false,
          assets: {},
        };
        if (t.artist) activity.state = `by ${t.artist}`;
        const nfInfo = nf ? netflixInfo(nf[1]) : null;
        if (nfInfo?.title) activity.details = nfInfo.title;
        if (nfInfo?.subtitle) activity.state = nfInfo.subtitle;
        if (yt) activity.assets.large_image = squareArt(await ytThumb(yt[1]));
        else if (nf) {
          if (nfInfo?.art) activity.assets.large_image = squareArt(nfInfo.art);
          else activity.assets.large_image = "netflix"; // uploaded logo asset as fallback
        } else if (t.artUrl?.startsWith("http")) activity.assets.large_image = squareArt(t.artUrl); // file:// art unreachable by discord's cloud proxy
        else if (isWin)
          // smtc exposes no public art url — fall back to the uploaded player asset
          // (missing assets silently don't render, so an unuploaded name is harmless)
          activity.assets.large_image = t.player.toLowerCase();
        if (t.album) activity.assets.large_text = `album: ${t.album}`;
        // small icon per player: upload assets named exactly like the key
        // (e.g. "spotify", "firefox", "youtube", "netflix"); missing ones just don't render
        if (yt) {
          activity.assets.small_image = "youtube";
          activity.assets.small_text = "on YouTube";
        } else if (nf) {
          activity.assets.small_image = "netflix";
          activity.assets.small_text = "on Netflix";
        } else if (t.player) {
          // hosted logo: app assets would need a manual upload and unknown keys silently don't render
          activity.assets.small_image =
            { spotify: SPOTIFY_ICON, spotifast: SPOTIFY_ICON }[t.player.toLowerCase()] ?? t.player.toLowerCase();
          activity.assets.small_text = PLATFORM_NAMES[t.player] ?? t.player;
        }
        if (Object.keys(activity.assets).length === 0) delete activity.assets;
        if (t.status === "Playing" && t.position >= 0) {
          activity.timestamps = {};
          const start = Math.floor(Date.now() / 1000 - t.position);
          activity.timestamps.start = start;
          if (Number.isFinite(t.lengthUs) && t.lengthUs > 0)
            activity.timestamps.end = start + Math.floor(t.lengthUs / 1e6);
        }
        await c.rpc.request("SET_ACTIVITY", { pid: process.pid, activity });
        if (path.basename(c.path) === "discord-ipc-0") {
          console.log(`setting: ${t.player} ${activity.details} ${t.status ?? ""} icon=${activity.assets?.small_image ?? "none"}`);
          if (nf && !nfInfo)
            console.log(`netflix watch id ${nf[1]} not mapped — add it to netflix-map.json for show name/art`);
        }
      }
    } catch (e) {
      console.error("set failed:", e?.code ?? "", e?.message ?? String(e), e?.stack?.split("\n")[1] ?? "");
      c.rpc.destroy?.().catch(() => {}); // also resets the client so next login() really reconnects
      c.connected = false; // that app died, retry next tick
    }
    c.lastKey = key;
  }
  if (t) {
    anchor = { key, pos: t.position, at: Date.now() };
    lastPick = t.player;
  } else lastPick = null;
}

tick();
setInterval(tick, 2_000); // spotify skips don't emit mpris change events, so poll for track changes; SETs only fire on change, so no rate-limit risk

// windows: smtc-poll.ps1 is both the poll and the instant event source (emits per change)
let smtc = []; // latest ps snapshot, normalized to the same shape as the playerctl parse
function startSmtc() {
  const child = spawn("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(import.meta.dirname, "smtc-poll.ps1"),
  ]);
  child.stderr.resume(); // drain
  readline
    .createInterface({ input: child.stdout })
    .on("line", (line) => {
      if (!line.trim()) return;
      try {
        smtc = JSON.parse(line).map((s) => ({
          player: s.app,
          title: s.title,
          artist: s.artist,
          status: s.status,
          lengthUs: s.length * 1e6, // smtc seconds -> mpris microseconds, same as the linux parse
          url: null, // smtc exposes no tab url: no youtube/netflix handling on windows
          artUrl: null, // smtc art is a stream, not a public url discord can proxy
          album: s.album,
          position: s.position,
        }));
      } catch {}
      tick();
    });
  child.on("exit", () => setTimeout(startSmtc, 1000)); // died -> respawn
}

if (isWin) startSmtc();
else {
  // instant reaction: playerctl --follow emits an event the moment any player changes state
  function startFollow() {
    const child = spawn("playerctl", [
      "-a",
      "metadata",
      "--follow",
      "--format",
      "{{playerName}}|{{status}}",
    ]);
    child.stderr.resume(); // drain
    readline
      .createInterface({ input: child.stdout })
      .on("line", (line) => line.trim() && tick());
    child.on("exit", () => setTimeout(startFollow, 1000)); // died -> respawn
  }
  startFollow();
}

// toggle (off-file) refreshes instantly on every platform instead of waiting for the next sweep —
// this is what makes toggle.bat feel instant on windows, where there's no SIGUSR2
watchFile(OFF_FILE, { interval: 1000 }, () => {
  for (const c of clients) c.lastKey = ""; // force re-set everywhere
  tick();
});

// toggle pokes us to refresh instantly instead of waiting for the next poll (linux only; the
// windows toggle just touches the off-file, which the watcher above picks up)
if (!isWin)
  process.on("SIGUSR2", () => {
    for (const c of clients) c.lastKey = ""; // force re-set everywhere
    tick();
  });