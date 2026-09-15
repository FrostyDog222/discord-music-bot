# Discord Setup — creating the bot & inviting it

Do this once, on the Discord side, to get your **bot token** (the value that
goes in `.env`) and invite the bot. Takes about 5 minutes.

> The bot works on **any server you invite it to** — commands register
> automatically per server, each with its own queue. To add it to more servers,
> just repeat step 3 (the invite) for each one.

---

## 1. Create the application

1. Go to https://discord.com/developers/applications
2. Click **New Application** (top right), give it a name, **Create**.

## 2. Turn it into a bot & get the TOKEN

1. Left sidebar → **Bot**.
2. Click **Reset Token** → confirm → **Copy** the token.
   - ⚠️ Treat it like a password. Don't paste it in chats or commit it.
     If it leaks, just Reset Token again.
3. (Optional but recommended) Scroll down and turn **Public Bot** OFF so only
   you can add it.
4. You do **not** need any Privileged Gateway Intents for this bot.

> This token is the `TOKEN=` value in your `.env`.

## 3. Invite the bot to your server

**Easiest — use your bot's ready-made invite link** (permissions baked in, so
whoever opens it is automatically prompted to grant exactly what the bot needs
— View Channels, Send Messages, Connect, Speak, and Manage Channels for the
optional `/createchannel`). Get your link from:

- the dashboard: **Music Bot.bat → [6] Show invite link**, or
- the console / `bot.log` when the bot starts (it prints "Invite link: ...").

It looks like this (with **your** Application ID filled in):

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&permissions=3148816&scope=bot+applications.commands
```

Open it → pick a server → **Authorize** (solve the captcha if shown). Discord
shows the required permissions pre-checked and creates the bot's role with them.
Repeat for each server you want the bot in.

> To add it to servers **other people** own, turn **Public Bot** ON on the Bot
> tab first (otherwise only you can add it).

> The bot only asks for what it needs (View Channels, Send Messages, Connect,
> Speak) — no admin. If a **voice channel is private** (locked to certain
> roles), the bot can't join it until you give its role access: Server Settings
> → that channel → Permissions → add the bot's role (or the bot itself) with
> **View Channel** + **Connect** + **Speak**.

<details>
<summary>Or build the link manually (OAuth2 URL Generator)</summary>

1. Left sidebar → **OAuth2** → **OAuth2 URL Generator**.
2. Scopes: `bot`, `applications.commands`.
3. Bot Permissions: **View Channels**, **Send Messages**, **Connect**, **Speak**,
   and **Manage Channels** (optional — only for `/createchannel`).
4. Copy the generated URL at the bottom, open it, authorize.
</details>

The bot now appears in your server (greyed out / offline until you run it).

## 4. Put your token in `.env`

Copy `.env.example` to `.env` and fill in:

```
TOKEN=your-bot-token
```

(If you use **First Time Setup.bat**, it asks for the token and writes `.env`
for you — you can skip this step.)

That's all the bot needs — no server ID required. It figures out which servers
it's in on its own.

---

## Changing the bot's name

- The **Application name** (General Information page) is just a label — it does
  NOT change what shows in the server.
- What shows in the server is the **Username** on the **Bot** tab. Change it
  there and Save. Note: limited to **2 changes per hour**, and Discord caches
  it, so it can take up to ~an hour (press Ctrl+R to refresh).
- For an instant, per-server change instead: right-click the bot in the member
  list → **Change Nickname**.

## Commands stopped showing up?

Slash commands are registered when the bot starts, and Discord removes them if
the bot is kicked. If `/play` etc. disappear, just restart the bot (it
re-registers on startup).
