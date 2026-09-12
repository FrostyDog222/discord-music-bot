# Discord Setup — creating the bot & inviting it

Do this once, on the Discord side, to get your **bot token** and **server ID**
(the two values that go in `.env`). Takes about 5 minutes.

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

1. Left sidebar → **OAuth2** → **OAuth2 URL Generator**.
2. Under **Scopes**, check:
   - `bot`
   - `applications.commands`
3. A **Bot Permissions** box appears. Check:
   - **View Channels**
   - **Send Messages**
   - **Connect**
   - **Speak**
4. Scroll to the bottom, **Copy** the generated URL.
5. Paste it in a browser → pick your server → **Authorize** (solve the captcha
   if shown).

The bot now appears in your server (greyed out / offline until you run it).

> Shortcut: an invite link with the right permissions looks like
> `https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&permissions=3148800&scope=bot+applications.commands`
> (replace `YOUR_APP_ID` with the Application ID from the **General
> Information** page).

## 4. Get your server ID (GUILD_ID)

1. In the Discord app: **Settings → Advanced → enable Developer Mode**.
2. Right-click your **server icon** (left bar) → **Copy Server ID**.

> This is the `GUILD_ID=` value in your `.env`.

## 5. Put both values in `.env`

Copy `.env.example` to `.env` and fill in:

```
TOKEN=your-bot-token
GUILD_ID=your-server-id
```

(If you use **First Time Setup.bat**, it asks for these and writes `.env` for
you — you can skip this step.)

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
