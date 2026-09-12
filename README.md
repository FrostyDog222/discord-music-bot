# Discord Music Bot

Private, self-hosted YouTube music bot for you and your friends.

> 🎵 Your personal DJ — play any YouTube song or playlist in voice chat.
> Paste a link or just search.
>
> `/play` · `/queue` · `/nowplaying`
> `/next` · `/jump` · `/cut` · `/remove` · `/clear`
> `/shuffle` · `/loop` · `/volume`
> `/pause` · `/resume` · `/stop`
> `/save` · `/load` · `/playlists` (+ add / remove / delete)
>
> Type `/help` for everything. Join voice and hit `/play`. 🔊

## Commands

| Command | What it does |
|---------|--------------|
| `/play <url or search>` | Play a song, search term, or whole playlist (adds to the queue) |
| `/queue` (or `/list`) | Show what's lined up |
| `/nowplaying` | Show the current song (with duration + thumbnail) |
| `/next` (or `/skip`) | Skip to the next song |
| `/jump <n>` | Jump to a queue position, **keep** the songs before it (they play after) |
| `/cut <n>` | Jump to a position and **delete** everything before it |
| `/remove <n[,n...]>` | Remove one or more songs from the queue (e.g. `2,3,5`) |
| `/clear` | Clear the queue (the current song keeps playing) |
| `/shuffle` | Shuffle the upcoming songs |
| `/loop off\|song\|queue` | Repeat the current song, the whole queue, or off |
| `/volume <0-200>` | Set playback volume |
| `/pause` · `/resume` | Pause / resume playback |
| `/stop` | Clear the queue and leave the channel |
| `/save <name>` | Save the current queue as a playlist (asks to confirm; warns on overwrite) |
| `/load <name>` | Load a saved playlist into the queue |
| `/playlists` | List saved playlists (numbered) |
| `/showplaylist <name or #>` | View the songs in a saved playlist |
| `/addtoplaylist <name> [song]` | Add a song (or the current one) to a playlist |
| `/removefromplaylist <name> <n[,n...] or title>` | Remove song(s) from a playlist |
| `/deleteplaylist <name/# [,...]>` | Delete one or more saved playlists (asks to confirm) |
| `/deleteallplaylists` | Delete all saved playlists (asks to confirm) |
| `/help` | Show all commands in Discord |

The live queue lives in memory only (resets on restart). The bot **auto-leaves**
when it's alone in the channel (5 min) or when the queue finishes (1 min).

> **Where saved playlists live:** `/save` writes to a `playlists.json` file on
> the **PC running the bot** — locally only, not in the cloud and not synced.
> They stay across restarts, but if you move the bot to another PC they won't
> come along unless you copy `playlists.json` over. (Each Discord server has its
> own set of saved playlists.)

## Quick setup (new PC)

If you already have these files (e.g. cloned from GitHub), just double-click
**`First Time Setup.bat`**. It installs Node/ffmpeg/yt-dlp, installs the bot's
dependencies, asks for your bot TOKEN, and optionally sets up auto-start at
login.

First need a bot token? See **[DISCORD_SETUP.md](DISCORD_SETUP.md)**.

> **Works on multiple servers.** Invite the bot to any server and its commands
> register there automatically — each server gets its own separate queue.
> Get your bot's invite link from the dashboard (**Music Bot.bat → [6] Show
> invite link**), or it's printed in the console/`bot.log` when the bot starts.

> Only run ONE copy of the bot process at a time — it's the same bot account,
> so a second instance can't connect to voice. Stop it on the old PC first.

> Streaming uses yt-dlp (keeps up with YouTube changes). If a song ever fails,
> run `winget upgrade yt-dlp` (or the dashboard's "Update yt-dlp now").

## Manual setup (if you skip First Time Setup.bat)

### 1. Install prerequisites
- **Node.js 18+** — https://nodejs.org (LTS)
- **ffmpeg** — in PowerShell: `winget install ffmpeg`
- **yt-dlp** — in PowerShell: `winget install yt-dlp`

After installing ffmpeg / yt-dlp, **restart your terminal** so they're on PATH.

### 2. Create the bot
1. Go to https://discord.com/developers/applications → **New Application**
2. Left sidebar → **Bot** → **Reset Token** → copy the token
3. Same page → scroll to **Privileged Gateway Intents** — none needed, leave off
4. Left sidebar → **OAuth2** → **URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Connect`, `Speak`, `View Channels`, `Send Messages`
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
`/play <youtube url or search term>` in any text channel.

## Daily use

The bot **starts automatically when you log in** to Windows (a Scheduled Task
named "Discord Music Bot"). It runs in the background using ~80 MB RAM idle,
~0% CPU. You normally don't have to do anything.

### Control panel
Double-click **`Music Bot.bat`** for a menu: Start / Stop / Restart /
Update yt-dlp / Exit. Closing the menu leaves the bot running.

### Manual (terminal) alternative
```
cd Desktop\discord-music-bot
npm start
```

### Scheduled tasks that keep it healthy
- **Discord Music Bot** — starts the bot at login.
- **yt-dlp daily update** — updates yt-dlp at 5 AM so songs keep working.

## Troubleshooting

**YouTube songs stopped playing / "Something broke fetching that track"?**
YouTube changed something and yt-dlp needs updating. It updates itself daily,
but you can force it right now:

1. Double-click **`Music Bot.bat`**
2. Choose **[4] Update yt-dlp now**

(Same thing from a terminal: `winget upgrade yt-dlp`.) Then try `/play` again.

**Commands (`/play` etc.) not showing up?** Restart the bot — dashboard **[3]
Restart bot**. Slash commands re-register on startup.
