# 🎵 Discord Music Bot

A **private, self-hosted** Discord bot that plays YouTube audio in your voice
channels — for you and your friends. Paste a link or search a name, and it
joins, plays, and manages a full queue. No subscription, no sketchy public
bots, and nothing leaves your PC: **you run it, you own it.**

Built with **discord.js** + **@discordjs/voice**, streaming through **yt-dlp**
and **ffmpeg** (the tools that keep up with YouTube's changes). It works across
multiple servers at once and — on Windows — starts with your PC, heals itself,
and keeps yt-dlp updated automatically.

> 🎵 Your personal DJ — play any YouTube song or playlist in voice chat.
> Paste a link or just search. Type `/help` for everything, join voice, and
> hit `/play`. 🔊

## ✨ Features

- **Play anything from YouTube** — a link, a search term, or a playlist — including hours-long podcasts/streams (transcoded on the fly, always at the correct speed, any language's titles shown correctly)
- **Full queue control** — skip, jump, cut, remove (single or batch `2,3,5`), clear, shuffle
- **Loop** a song or the whole queue
- **Rich "now playing"** cards with duration + thumbnail
- **Saved playlists** — save the queue, reload it later, view/add/remove songs, with Yes/No confirmations
- **Clear errors** — a video that can't play (removed, private, age-restricted…) is skipped with the reason shown, never retried in a loop
- **Live status** — the bot's presence shows the current song (falls back to `/help` when idle)
- **Dedicated log channel** — route now-playing + activity to a channel (`/setchannel` or `/createchannel`) to keep the main chat clean
- **Tidy chat** — `/autodelete` clears the bot's command replies after N seconds
- **Multi-server** — one bot serves every server it's in, each with its own queue
- **Runs itself (Windows)** — auto-starts at login, a watchdog restarts it if it ever stops, yt-dlp updates daily, and it leaves voice when idle or alone
- **Self-healing voice** — a network drop is retried and the song resumes where it stopped; a moderator's *Disconnect* is respected
- **Safe by default** — only YouTube links are accepted (nobody can make your PC fetch other sites or your home network), mentions in titles never ping, destructive commands are admin-only
- **Private** — self-hosted; your token and saved playlists never leave your machine

## ⚡ Get started

**Already have the files** (cloned or downloaded)? Double-click
**`First Time Setup.bat`**, paste your bot token when asked, and you're set —
it installs everything and can enable auto-start. Then start it from
**`Music Bot.bat`**.

**Need a bot token first?** Follow **[DISCORD_SETUP.md](DISCORD_SETUP.md)** (about 5 minutes).

**Requirements** — Node.js 22.12+, ffmpeg, yt-dlp (and Deno, which yt-dlp uses
for YouTube). On Windows, `First Time Setup.bat` installs all of them for you;
the manual steps are further down.

## Commands

| Command | What it does |
|---------|--------------|
| `/play <link or search>` | Play a YouTube link, playlist, or search term (adds to the queue; up to 200 songs per playlist) |
| `/queue` (or `/list`) | Show what's lined up |
| `/nowplaying` | Show the current song (with duration + thumbnail) |
| `/next` (or `/skip`) | Skip to the next song |
| `/jump <n>` | Jump to a queue position, **keep** the songs before it (they play after) |
| `/cut <n>` | Jump to a position and **delete** everything before it |
| `/remove <n[,n...]>` | Remove one or more songs from the queue (e.g. `2,3,5`) |
| `/clear` | Clear the queue (the current song keeps playing) |
| `/shuffle` | Shuffle the upcoming songs |
| `/loop off\|song\|queue` | Repeat the current song, the whole queue, or off |
| `/pause` · `/resume` | Pause / resume playback |
| `/stop` | Clear the queue and leave the channel |
| `/save <name>` | Save the current queue as a playlist (asks to confirm; warns on overwrite) |
| `/load <name or #>` | Load a saved playlist into the queue |
| `/playlists` | List saved playlists (numbered) |
| `/showplaylist <name or #>` | View the songs in a saved playlist |
| `/addtoplaylist <name> [song]` | Add a song (or the current one) to a playlist |
| `/removefromplaylist <name> <n[,n...] or title>` | Remove song(s) from a playlist |
| `/deleteplaylist <name/# [,...]>` | **Admin.** Delete one or more saved playlists (asks to confirm) |
| `/deleteallplaylists` | **Admin.** Delete all saved playlists (asks to confirm) |
| `/setchannel [channel]` | **Admin.** Post now-playing/announcements in the chosen channel (default: current) |
| `/resetchannel` | **Admin.** Go back to posting wherever the command is used |
| `/createchannel [name]` | **Admin.** Bot creates a channel and posts there (needs Manage Channels on the bot) |
| `/autodelete <seconds\|off>` | **Admin.** Auto-delete the bot's command replies after N seconds (max 840), or `off` |
| `/help` | Show all commands in Discord |

**Admin** = members with **Manage Channels**. A server admin can change who may
use any command in *Server Settings → Integrations → your bot*.

**Playback controls** (pause, resume, skip, jump, cut, remove, clear, shuffle,
loop, stop) work only for people in the bot's voice channel (admins always), so
nobody outside the call can wreck the session.

The live queue lives in memory only (resets on restart). The bot **auto-leaves**
when it's alone in the channel (5 min) or when the queue finishes (1 min).

> **Links:** any playlist link adds the playlist (up to 200 songs) — both a
> playlist page (`youtube.com/playlist?list=…`) and a song opened inside one
> (`watch?v=…&list=…`), which starts the queue at that song. A plain song link,
> a YouTube **Mix**/radio (`list=RD…`) or Watch later/Liked plays just that one
> song. Only YouTube links are accepted.

> **Keeping chat clean:** commands work in any channel. Set a log channel with
> `/setchannel` (or `/createchannel`) to keep a persistent now-playing/activity
> log there. Separately, `/autodelete <seconds|off>` is the on/off switch for
> the command channel: give it a number of seconds and the bot's messages there
> clear after the delay; set it to **`off`** and they stay. The log channel
> keeps its copy either way.

> **Volume:** set it per-listener in Discord — right-click the bot in the voice
> channel and drag the **User Volume** slider. It's local to each person, so
> everyone picks their own level.

> **Where saved playlists live:** `/save` writes to a `playlists.json` file on
> the **PC running the bot** — locally only, not in the cloud and not synced.
> They stay across restarts, but if you move the bot to another PC they won't
> come along unless you copy `playlists.json` over. (Each Discord server has its
> own set of saved playlists.) Saves are crash-safe; if the file is ever
> damaged, the bot sets it aside as `playlists.json.corrupt-…` instead of
> overwriting it.

## Quick setup (new PC)

If you already have these files (e.g. cloned from GitHub), just double-click
**`First Time Setup.bat`**. It installs Node/ffmpeg/yt-dlp/Deno, installs the
bot's dependencies, asks for your bot TOKEN (hidden while you paste), and
optionally sets up auto-start at login. It stops with a clear message if
anything fails.

First need a bot token? See **[DISCORD_SETUP.md](DISCORD_SETUP.md)**.

> **Works on multiple servers.** Invite the bot to any server and its commands
> register there automatically — each server gets its own separate queue.
> Get your bot's invite link from the dashboard (**Music Bot.bat → [7] Show
> invite link**), or it's printed in `bot.log` when the bot starts.

> **One copy per bot.** A second copy of the same bot refuses to start (it would
> answer every command twice). To move the bot to another PC, stop it on the
> old one first.

## Manual setup (if you skip First Time Setup.bat)

### 1. Install prerequisites
- **Node.js 22.12+** — https://nodejs.org (LTS)
- **ffmpeg** — in PowerShell: `winget install ffmpeg`
- **yt-dlp** — in PowerShell: `winget install yt-dlp`, then `yt-dlp --update-to nightly`
- **Deno** — in PowerShell: `winget install DenoLand.Deno` (yt-dlp uses it for YouTube)

After installing, **restart your terminal** so they're on PATH.

### 2. Create the bot
1. Go to https://discord.com/developers/applications → **New Application**
2. Left sidebar → **Bot** → **Reset Token** → copy the token
3. Same page → scroll to **Privileged Gateway Intents** — none needed, leave off
4. Left sidebar → **OAuth2** → **URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Connect`, `Speak`, `View Channels`, `Send Messages` (+ `Manage Channels` for `/createchannel`)
   - Copy the generated URL, open it, invite the bot to your server

### 3. Configure
1. Copy `.env.example` to `.env`
2. Paste your **TOKEN**

### 4. Install & run
```
cd Desktop\discord-music-bot
npm install
npm start
```

Leave that terminal running while you use the bot. Join a voice channel, then type
`/play <youtube link or search term>` in any text channel.

`npm test` runs the bot's self-checks (`node test.js --live` also asks YouTube).

## Daily use

If you **enabled auto-start** (during `First Time Setup.bat`, or via the
dashboard's **[5] Toggle auto-start & keep-alive**), the bot launches on its own
each time you log in to Windows — via a Scheduled Task named "Discord Music
Bot". If you didn't, start it yourself from **`Music Bot.bat`** (or `npm start`).

Either way, the bot only runs while **this PC is on** (it's not in the cloud).
Resource use is light: about **80 MB RAM and ~0% CPU when idle**, rising to
roughly **170 MB and a few % of one CPU core while a song is actually playing**
(the extra is the short-lived yt-dlp + ffmpeg that stream each track).

> **Sleep:** by default, while the bot runs it keeps the PC awake so playback
> isn't interrupted — handy if friends want music while you're away with the PC
> on (the monitor can still turn off; only *system* sleep is held). Toggle it
> anytime with **Music Bot.bat → [6] Toggle keep-PC-awake**; when off, the PC
> sleeps normally. The setting is stored in `config.json`.

> **Windows Update restarts:** after an automatic update restart, Windows sits at
> the sign-in screen and the bot waits until someone signs in. To have it come
> back on its own, turn on *Settings → Accounts → Sign-in options → "Use my
> sign-in info to automatically finish setting up after an update"*.

### Control panel
Double-click **`Music Bot.bat`** for a menu: Start / Stop / Restart / Update
yt-dlp / auto-start & keep-alive / keep-PC-awake / invite link / **recent
errors** / Exit. Closing the menu leaves the bot running. If Start fails, it
shows you the error instead of pretending it worked.

### Manual (terminal) alternative
```
cd Desktop\discord-music-bot
npm start
```

### Scheduled tasks that keep it healthy
- **Discord Music Bot** — a **watchdog**: starts the bot at login **and every 5
  minutes restarts it if it isn't running**, so it self-heals from any crash or
  unexpected exit. It won't fight you: stopping the bot from the dashboard keeps
  it stopped until you press Start (or until the next reboot).
- **yt-dlp daily update** — updates yt-dlp at 5 AM straight from yt-dlp's own
  nightly channel (the fastest to get YouTube fixes), retrying if the network
  isn't up yet.

### Logs
- `bot.log` / `bot.err` — the current run (every line is timestamped)
- `bot.log.prev` / `bot.err.prev` — the previous run, so a crash's reason survives the restart
- `watchdog.log` — every time the watchdog had to (re)start the bot

## Troubleshooting

**"⚠️ Couldn't play … — reason"?** The bot tells you why and moves on:
- *This video is unavailable / Private video* — the video is gone or private.
- *Sign in to confirm your age* — age-restricted videos can't be played.
- *Sign in to confirm you're not a bot* — YouTube is rate-limiting your internet
  connection. Wait a while, and update yt-dlp (below).
If **3 songs in a row** fail, the bot leaves the channel instead of hammering
YouTube — usually a sign yt-dlp needs updating.

**YouTube songs stopped playing?** YouTube changed something and yt-dlp needs
updating. It updates itself daily, but you can force it right now:

1. Double-click **`Music Bot.bat`**
2. Choose **[4] Update yt-dlp now**

(Same thing from a terminal: `yt-dlp --update-to nightly`.) Then try `/play` again.

**The bot seems offline or stopped?** Open **Music Bot.bat → [8] Show recent
errors** to see what happened, then **[1] Start**. The watchdog also restarts it
within 5 minutes on its own.

**Commands (`/play` etc.) not showing up?** Restart the bot — dashboard **[3]
Restart bot**. Slash commands re-register on startup.

**Moved or renamed the bot's folder?** Open the dashboard and turn **[5]
auto-start** off and on again so the scheduled task points at the new folder.
