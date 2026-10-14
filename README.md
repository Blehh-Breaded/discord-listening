# discord-listening

Shows what you're listening/watching on Discord (and Equibop) — no usernames shared anywhere.
Track title, artist, album, cover art, platform badge, and a progress bar synced to the player.

## How it works (one paragraph)

`index.js` watches all MPRIS players via `playerctl` — an event stream (`--follow`, instant) plus a
2s sweep (Spotify skips don't emit change events). It picks the *playing* player, sends track/artist/
album/art/timestamps over Discord's local RPC to **every** `discord-ipc-*` socket it finds
(real Discord + Equibop's arRPC). Pause = presence cleared; resume = back. Everything updates only
on change, so rate limits are never an issue.

## Files

| file | purpose |
|---|---|
| `index.js` | the whole script (single file) |
| `toggle.sh` | instantly toggles the presence on/off (bind to a KDE shortcut) — linux |
| `toggle.bat` | same for Windows (applies within 2s) |
| `smtc-poll.ps1` | Windows-only helper: PowerShell reading Windows' SMTC media sessions (replaces playerctl) |
| `hide.txt` | player names to hide, one per line (`playerctl -l` on linux; SMTC app names on Windows, e.g. `spotify`, `chrome`) |
| `netflix-map.json` | netflix watch-ID → show title/art (DRM hides it otherwise) — linux only (needs the tab URL) |
| `package.json` | deps: @xhayper/discord-rpc |

## Commands

```bash
# status / logs (see every update and errors)
journalctl --user -u discord-listening.service -f

# restart after editing index.js
systemctl --user restart discord-listening.service

# manual toggle (same as keybind)
~/discord-listening/toggle.sh

# list players / check metadata by hand
playerctl -l
playerctl -a metadata --format '{{playerName}} | {{title}} | {{artist}} | {{status}} | {{xesam:url}}'

# skip/pause/play for testing
playerctl -p spotify next
```

## One-time setup (if rebuilding this on a new machine)

1. `cd ~/discord-listening && npm install`
2. Create an app at https://discord.com/developers/applications → copy the **Application ID**
3. systemd user service `~/.config/systemd/user/discord-listening.service`:
   ```ini
   [Service]
   ExecStart=/usr/bin/node /home/cornbread/discord-listening/index.js
   Environment=DISCORD_CLIENT_ID=<your app id>
   Restart=on-failure
   [Install]
   WantedBy=graphical-session.target
   ```
   then: `systemctl --user daemon-reload && systemctl --user enable --now discord-listening.service`
4. Upload Rich Presence Art Assets in the dev portal, named exactly:
   `spotify`, `firefox`, `youtube`, `netflix` (square PNG, ≥512×512).
   **After uploading assets, restart the Discord client — it caches them.**
5. KDE shortcut → command: `/home/cornbread/discord-listening/toggle.sh`

## Windows setup

Works on both platforms from the same script — on Windows it reads players from **SMTC**
(System Media Transport Controls, built into Windows) via `smtc-poll.ps1` instead of playerctl.
Spotify, Chrome, Edge, Firefox, Brave, VLC, iTunes, Tidal, the Media Player app all report to SMTC.

1. Install [Node.js](https://nodejs.org), clone this repo to `%USERPROFILE%\discord-listening`, then `npm install` in it
2. Create an app at https://discord.com/developers/applications → copy the **Application ID**
3. Upload Rich Presence Art Assets, named exactly like the app: `spotify`, `chrome`, `msedge`, …
   (square PNG, ≥512×512) — these are the little player badges. Restart the Discord client after uploading.
4. Create `start.bat` next to `index.js`:
   ```bat
   @echo off
   set DISCORD_CLIENT_ID=<your app id>
   node "%~dp0index.js"
   ```
   Run it while Discord is open. To autostart: press Win+R → `shell:startup` → put a shortcut to `start.bat` there.
5. Toggle on/off: double-click `toggle.bat` (applies within 2s — no signal plumbing on Windows)

Windows differences: no cover art (SMTC gives art as an opaque stream, not a URL Discord can proxy),
no YouTube/Netflix titles or thumbnails (needs the browser tab URL, which SMTC doesn't expose),
and `netflix-map.json` is unused there. Linux shows those extras.

## Netflix

DRM hides show name/art even from your own browser, and Netflix's API bot-blocks scripts —
so the show name/art come from `netflix-map.json`, one entry per watch-ID:

```json
{
  "80179831": {
    "title": "JoJo's Bizarre Adventure",
    "subtitle": "optional second line",
    "art": "https://...poster-url..."
  }
}
```

- The ID is the number in `netflix.com/watch/<ID>`. The journal prints unmapped IDs automatically:
  `netflix watch id ... not mapped` — copy it from there.
- Poster URL: right-click any netflix.com poster → Copy Image Address (or any public image).
- One entry per *episode ID*; `title`/`subtitle`/`art` are all optional (empty art → netflix logo).
- Edits apply on the next tick — no restart.

## Quirks learned the hard way (do not re-fight these)

- **Discord merges presence updates** — omitted fields keep their old values, and nulls are
  *rejected* by the validator. The script wipes (`clearActivity`) then re-sets on every change.
- **Pause must be clear-only.** Re-setting after a clear re-inherits the running progress bar.
- **Spotify doesn't emit MPRIS events on track skip** — that's why the 2s sweep exists alongside
  `--follow`.
- **New dev-portal assets need a Discord client restart** to show up.
- **`file://` artwork** (plasma browser integration) can't be used — Discord's cloud proxy can't
  reach your disk. YouTube is solved via public `i.ytimg.com` thumbnails (16:9 variants preferred).
- Player picking: playing beats paused; sticky (the shown player stays until it pauses) so
  firefox/plasma tabs don't fight.