# Discord Music Bot

Private, self-hosted YouTube music bot for you and your friends.
Commands: `/play` `/pause` `/resume` `/skip` `/next` `/stop` `/queue`

> Note: streaming YouTube goes against YouTube's ToS and Google occasionally
> breaks the extractor. For private use it's fine; if playback suddenly stops
> working, run `npm update play-dl` (or `npm i play-dl@latest`).

## One-time setup

### 1. Install prerequisites
- **Node.js 18+** — https://nodejs.org (LTS)
- **ffmpeg** — in PowerShell: `winget install ffmpeg`
- **yt-dlp** — in PowerShell: `winget install yt-dlp`

After installing ffmpeg / yt-dlp, **restart your terminal** so they're on PATH.

> Streaming uses yt-dlp (keeps up with YouTube changes). If a song ever fails,
> update it: `winget upgrade yt-dlp`

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
