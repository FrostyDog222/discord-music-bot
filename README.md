# Discord Music Bot

Private, self-hosted YouTube music bot for you and your friends.
Commands: `/play` `/queue` (`/list`) `/next` (`/skip`) `/jump` `/pause` `/resume` `/stop` `/help`

Plays single songs, search terms, or whole playlists.

## Quick setup (new PC)

If you already have these files (e.g. cloned from GitHub), just double-click
**`First Time Setup.bat`**. It installs Node/ffmpeg/yt-dlp, installs the bot's
dependencies, asks for your bot TOKEN + server ID, and optionally sets up
auto-start at login. Then create the bot in Discord (below) if you haven't.

> Only run ONE copy of the bot at a time — it's the same bot account, so a
> second instance can't connect to voice. Stop it on the old PC first.

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
3. Get your **GUILD_ID**: Discord → Settings → Advanced → enable Developer Mode,
   then right-click your server icon → **Copy Server ID** → paste it

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

If a song ever fails anyway: open the control panel → **Update yt-dlp now**.
