// Discord YouTube music bot — private, self-hosted.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') }); // not the current directory
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const {
  Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActivityType, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags, ChannelType,
  escapeMarkdown,
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType,
} = require('@discordjs/voice');

// Timestamp every line: bot.log / bot.err are the only diagnostics.
for (const k of ['log', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => orig(new Date().toISOString(), ...a);
}

const LEAVE_MS = 5 * 60 * 1000;     // auto-leave after 5 min alone in the channel
const IDLE_MS = 60 * 1000;          // auto-leave after 1 min with nothing playing
const START_TIMEOUT_MS = 45_000;    // no audio at all by then -> the track failed
const RESOLVE_TIMEOUT_MS = 60_000;  // a single yt-dlp lookup may not take longer
const MAX_ADD = 200;                // most songs one /play or /addtoplaylist can add
const MAX_QUEUE = 1000;             // most songs a queue or saved playlist can hold
const MAX_FAILS = 3;                // this many failed tracks in a row -> leave
const ADMIN = PermissionFlagsBits.ManageChannels;
// Playback controls must come from the bot's voice channel (admins may always use them).
const CONTROL = new Set(['pause', 'resume', 'skip', 'next', 'jump', 'cut', 'remove', 'clear', 'shuffle', 'loop', 'stop']);

// Only YouTube links reach yt-dlp: the bot's PC must never fetch arbitrary (e.g. LAN) URLs.
const YT_HOST = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
// Every yt-dlp run: ignore stray config files, never use the "any website" extractor, and allow
// the bot's own Node as a YouTube JS-challenge solver (Deno is still preferred when installed).
const YTDLP_BASE = [
  '--ignore-config', '--use-extractors', 'default,-generic',
  '--js-runtimes', `node:${process.execPath}`,
];

// --- JSON persistence ---
// Missing -> fallback. Locked/unreadable -> throw (refuse to start rather than overwrite real data
// later; the watchdog retries). Corrupt -> set it aside for recovery and start empty.
function loadJson(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  try {
    const v = JSON.parse(text.replace(/^﻿/, ''));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    throw new Error('not a JSON object');
  } catch (e) {
    const bad = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, bad);
    console.error(`${path.basename(file)} was unreadable (${e.message}); moved it to ${path.basename(bad)} and started empty.`);
    return fallback;
  }
}
// Flushed temp file + rename: a crash or power cut leaves the old or the new file, never half of one.
function saveJson(file, data) {
  const json = JSON.stringify(data, null, 1);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, json, { flush: true });
    // ponytail: Windows refuses the rename while something else holds the file open; then write in place
    try { fs.renameSync(tmp, file); } catch { fs.writeFileSync(file, json, { flush: true }); fs.rmSync(tmp, { force: true }); }
    return true;
  } catch (e) { console.error(`saving ${path.basename(file)} failed:`, e.message); return false; }
}

const PLAYLISTS_FILE = path.join(__dirname, 'playlists.json');
const playlists = loadJson(PLAYLISTS_FILE, {}); // { guildId: { name: [track, ...] } }
const savePlaylists = () => saveJson(PLAYLISTS_FILE, playlists);

// config.json is written by the dashboard. keepAwake defaults ON so friends can listen while
// you're away with the PC on. Never fatal.
const CONFIG_FILE = path.join(__dirname, 'config.json');
const config = { keepAwake: true };
try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, ''))); }
catch (e) { if (e.code !== 'ENOENT') console.error('config.json ignored:', e.message); }

// Per-guild settings: { guildId: { channel: id, autoDelete: seconds } }.
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const guildSettings = loadJson(SETTINGS_FILE, {});
const saveSettings = () => saveJson(SETTINGS_FILE, guildSettings);
function gset(guildId) { return (guildSettings[guildId] ??= {}); }

// --- small helpers ---
const md = (t) => escapeMarkdown(String(t ?? ''), { maskedLink: true }); // titles/names in message text
const normName = (x) => String(x ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
function userError(message) { return Object.assign(new Error(message), { userFacing: true }); }

// yt-dlp's reason from its stderr: the first sentence of the ERROR line, with URLs removed
// (googlevideo links contain this PC's IP and the text is posted to Discord).
function ytdlpReason(text) {
  const m = String(text).match(/ERROR: (?:\[[^\]]+\] [\w-]+: )?([^\r\n]+)/);
  return m ? m[1].split('. ')[0].replace(/https?:\/\/\S+/g, '').trim().slice(0, 200) : '';
}

// Parse "1,2 3" into a unique list of positive integers.
function parseNumberList(input) {
  return [...new Set(String(input).split(/[\s,]+/).filter((x) => /^\d+$/.test(x)).map(Number))];
}

// Resolve a saved playlist by name or 1-based number; returns its key or null.
// Own-property checks only: names like "constructor" must not match Object built-ins.
function resolvePlaylistName(guildId, input) {
  const g = playlists[guildId];
  const names = g ? Object.keys(g) : [];
  if (!names.length) return null;
  const key = normName(input);
  if (Object.hasOwn(g, key)) return key;                                 // exact name wins
  const legacy = String(input ?? '').trim().toLowerCase();               // names saved before normalization
  if (Object.hasOwn(g, legacy)) return legacy;
  if (/^\d+$/.test(key)) return names[parseInt(key, 10) - 1] ?? null;    // otherwise a position
  return null;
}

// Join lines up to Discord's 2000-char limit, noting how many were left out.
function fitLines(lines, header = '', footer = '') {
  let out = header;
  let shown = 0;
  for (const l of lines) {
    if (out.length + l.length + footer.length + 40 > 1950) break;
    out += `${out ? '\n' : ''}${l}`;
    shown++;
  }
  if (shown < lines.length) out += `\n…and ${lines.length - shown} more`;
  return out + footer;
}

function fmtDuration(sec) {
  const n = Math.floor(Number(sec));
  if (!n || Number.isNaN(n)) return null;
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function nowPlayingEmbed(track, heading = 'Now playing') {
  const e = new EmbedBuilder().setColor(0x1db954).setAuthor({ name: heading })
    .setTitle(String(track.title || 'Unknown').slice(0, 256));
  if (/^https?:\/\//.test(track.url || '')) e.setURL(track.url);
  const dur = fmtDuration(track.duration);
  if (dur) e.addFields({ name: 'Duration', value: dur, inline: true });
  if (track.requestedBy) e.addFields({ name: 'Requested by', value: md(track.requestedBy).slice(0, 1024), inline: true });
  if (/^https?:\/\//.test(track.thumbnail || '')) e.setThumbnail(track.thumbnail);
  return e;
}

// Show a Yes/No prompt; resolve to the clicked button (or null on timeout).
async function askYesNo(interaction, content, danger = false) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('yes').setLabel('Yes')
      .setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('no').setLabel('No').setStyle(ButtonStyle.Secondary),
  );
  const res = await interaction.reply({ content, components: [row] });
  try {
    return await res.awaitMessageComponent({
      time: 30_000,
      filter: (i) => {
        if (i.user.id === interaction.user.id) return true;
        i.reply({ content: 'Only the person who ran the command can answer.', flags: MessageFlags.Ephemeral }).catch(() => {});
        return false;
      },
    }); // btn.customId is 'yes' or 'no'; the caller must btn.update(...)
  } catch {
    await interaction.editReply({ content: '⏱️ Timed out — nothing changed.', components: [] }).catch(() => {});
    return null;
  }
}

// yt-dlp.exe (winget) is a PyInstaller one-file build: the PID we spawn is a launcher and the
// real worker is its child, so a plain kill() orphans the worker. taskkill /T ends the whole tree.
function killTree(p) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  } else {
    try { p.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

// Resolve a YouTube link, playlist, or search term to [{ title, url, duration, thumbnail }].
function resolveTracks(query) {
  const q = String(query).trim();
  let target = `ytsearch1:${q}`;
  let isPlaylist = false;
  if (/^https?:\/\//i.test(q)) {
    let u = null;
    try { u = new URL(q); } catch { /* not a valid URL */ }
    if (!u || !YT_HOST.test(u.hostname)) return Promise.reject(userError('Only YouTube links are supported.'));
    target = u.href; // pass the normalized URL we checked, never the raw string
    // Only a real playlist page is a playlist. watch?v=X&list=... (a Mix/radio link, or a song
    // opened inside a playlist) plays just that song instead of queueing hundreds.
    isPlaylist = u.searchParams.has('list') && !u.searchParams.has('v') && !/youtu\.be$/i.test(u.hostname);
  }
  const args = [
    ...YTDLP_BASE, '--encoding', 'utf-8', // Windows pipes default to cp1252 and mangle non-Latin titles
    isPlaylist ? '--yes-playlist' : '--no-playlist', '--flat-playlist', '--playlist-items', `1:${MAX_ADD}`,
    '--print', '%(title)s\t%(webpage_url,url)s\t%(duration)s\t%(thumbnail,thumbnails.-1.url)s\t%(extractor_key)s',
    target,
  ];
  return new Promise((resolve, reject) => {
    const p = spawn('yt-dlp', args, { windowsHide: true });
    p.stdout.setEncoding('utf8'); // keeps multi-byte characters split across chunks intact
    p.stderr.setEncoding('utf8');
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      killTree(p);
      reject(userError('YouTube took too long to answer — try again.'));
    }, RESOLVE_TIMEOUT_MS);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; }); // must be drained or yt-dlp can block
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const why = ytdlpReason(err);
        return reject(why ? userError(why) : new Error(err.trim() || `yt-dlp exited ${code}`));
      }
      const tracks = out.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).map((line) => {
        const [title, url, duration, thumbnail, ie] = line.split('\t');
        return {
          title, url, ie,
          duration: duration && duration !== 'NA' ? Number(duration) : null,
          thumbnail: thumbnail && thumbnail !== 'NA' ? thumbnail : null,
        };
      })
        // channel tabs are playlists, not songs; unavailable playlist entries would only fail later
        .filter((t) => /^https?:\/\//.test(t.url || '') && t.ie !== 'YoutubeTab' && !/^\[(Private|Deleted) video\]$/.test(t.title))
        .slice(0, MAX_ADD)
        .map(({ ie, ...t }) => t);
      if (!tracks.length) return reject(userError('No results found.'));
      resolve(tracks);
    });
  });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  allowedMentions: { parse: [] }, // echoed titles/playlist names must never ping anyone
});

// Where the bot keeps its log: the configured channel, only if it still exists.
function logChannel(guildId) {
  const id = guildSettings[guildId]?.channel;
  return (id && client.channels.cache.get(id)) || null;
}
// Where announcements go: the log channel, else the channel the last command came from.
function announceChannel(guildId, s) { return logChannel(guildId) || s?.textChannel || null; }

// Send an announcement (now-playing / leave / failures). It persists in the log channel; if it
// lands in the command channel instead and /autodelete is on, it self-deletes after the delay.
function sendAnnounce(guildId, s, payload) {
  const log = logChannel(guildId);
  const ch = log || s?.textChannel;
  if (!ch) return;
  ch.send(payload).then((msg) => {
    if (log) return; // keep it — it's the log
    const secs = Number(guildSettings[guildId]?.autoDelete) || 0;
    if (secs > 0) setTimeout(() => msg.delete().catch(() => {}), secs * 1000);
  }).catch(() => {});
}
function announceNowPlaying(guildId, s, track) {
  sendAnnounce(guildId, s, { embeds: [nowPlayingEmbed(track)] });
}

// Reply to a command; with `mirror`, also write it to the log channel (actions yes, info no).
function respond(interaction, s, payload, mirror = true) {
  const body = typeof payload === 'string' ? { content: payload } : payload;
  const log = mirror ? logChannel(interaction.guildId) : null;
  if (log && log.id !== interaction.channelId) log.send(body).catch(() => {});
  else if (log) interaction.keepReply = true; // run inside the log channel: this reply IS the log entry
  if (interaction.deferred || interaction.replied) return interaction.editReply(body);
  return interaction.reply(body);
}

// Per-guild state.
const guilds = new Map();
function getState(guildId) {
  let s = guilds.get(guildId);
  if (!s) {
    s = {
      connection: null, player: null, queue: [], textChannel: null,
      suppressAnnounce: false, loop: 'off', fails: 0, resolving: 0,
      leaveTimer: null, idleTimer: null, procs: null,
      leaving: false, reconnecting: false, kicked: false,
    };
    guilds.set(guildId, s);
  }
  return s;
}

// Presence: show a currently playing song, else fall back to /help.
function refreshActivity() {
  if (!client.user) return;
  for (const st of guilds.values()) {
    if (st.queue.length) {
      return client.user.setActivity(String(st.queue[0].title || 'music').slice(0, 120), { type: ActivityType.Listening });
    }
  }
  client.user.setActivity('/help', { type: ActivityType.Listening });
}

// Stop the yt-dlp/ffmpeg processes feeding the current track.
function killProcs(s) {
  if (!s.procs) return;
  const [yt, ff] = s.procs;
  s.procs = null;
  yt.stdout?.destroy(); // the worker hits a broken pipe on its next write
  killTree(yt);
  try { ff.kill('SIGKILL'); } catch { /* already gone */ }
}

function playNext(guildId) {
  const s = guilds.get(guildId);
  if (!s || s.leaving || !s.player) return;
  const next = s.queue[0];
  if (!next) return; // nothing queued; stay connected, idle
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; } // a song is starting
  killProcs(s); // stop whatever was playing before

  // yt-dlp streams the audio; ffmpeg decodes ANY container/length and outputs Ogg Opus at
  // Discord's exact format (48 kHz stereo), passed straight through (StreamType.OggOpus): no
  // JavaScript re-encoding, so playback stays correct-speed and cheap under heavy CPU load.
  // --http-chunk-size uses short ranged requests instead of one long-lived connection, which
  // YouTube invalidates mid-stream on long tracks. Retries recover transient fragment drops.
  const yt = spawn('yt-dlp', [
    ...YTDLP_BASE, '-f', 'bestaudio/best', '--no-playlist', '--no-progress',
    '--retries', '10', '--fragment-retries', '10', '--http-chunk-size', '10M',
    '-o', '-', next.url,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const ff = spawn('ffmpeg', [
    '-i', 'pipe:0', '-loglevel', 'error', '-vn',
    '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-f', 'opus', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  // Why THIS track failed; lives on the resource so a later track can't overwrite it.
  const meta = { track: next, err: '', ffErr: '' };
  let tail = '';
  yt.stderr.setEncoding('utf8');
  yt.stderr.on('data', (d) => { tail = (tail + d).slice(-4000); meta.err = ytdlpReason(tail) || meta.err; });
  ff.stderr.setEncoding('utf8');
  ff.stderr.on('data', (d) => { meta.ffErr = (meta.ffErr + d).slice(-500); });
  yt.on('error', (e) => { meta.err ||= `yt-dlp could not start (${e.code})`; console.error('yt-dlp spawn error:', e.message); });
  ff.on('error', (e) => { meta.err ||= `ffmpeg could not start (${e.code})`; console.error('ffmpeg spawn error:', e.message); });
  yt.stdout.on('error', () => {}); // ignore EPIPE when a track is skipped
  ff.stdin.on('error', () => {});
  yt.stdout.pipe(ff.stdin);
  const procs = [yt, ff];
  s.procs = procs;

  const res = createAudioResource(ff.stdout, { inputType: StreamType.OggOpus, metadata: meta });
  s.player.play(res);
  // No audio at all within START_TIMEOUT_MS (e.g. yt-dlp stuck retrying): end it; onIdle reports it.
  setTimeout(() => {
    if (!res.started && s.procs === procs) { meta.err ||= 'timed out waiting for audio'; killProcs(s); }
  }, START_TIMEOUT_MS).unref();
  refreshActivity(); // show the current song as the bot's status
}

// The player went Idle: a song ended, failed, or a command stopped it.
function onIdle(s, guildId, oldState) {
  if (s.leaving || guilds.get(guildId) !== s) return; // torn down or replaced session
  const suppress = s.suppressAnnounce; // set only by skip/jump/cut
  s.suppressAnnounce = false;
  // Ended with ~no audio and no command stopped it = the stream failed (removed/private/age-locked
  // video, YouTube bot-check, outdated yt-dlp, no network). Never loop a failed track.
  const res = oldState?.resource;
  const failed = !suppress && (res?.playbackDuration ?? 0) < 2000;
  s.fails = failed ? s.fails + 1 : 0;
  if (failed) {
    const { track = s.queue[0] || {}, err = '', ffErr = '' } = res?.metadata || {};
    console.error('Could not play', track.url, '-', err || 'no audio', ffErr ? `| ffmpeg: ${ffErr.trim().split('\n').pop()}` : '');
    sendAnnounce(guildId, s, `⚠️ Couldn't play **${md(track.title)}**${err ? ` — ${md(err)}` : ''}. Skipping.`);
    if (s.fails >= MAX_FAILS) {
      return leaveGuild(guildId, `⚠️ ${MAX_FAILS} songs in a row failed to load — YouTube may be blocking downloads right now. Try again later, or use "Update yt-dlp now" in the dashboard.`);
    }
  }
  if (!suppress && !failed && s.loop === 'song' && s.queue.length) return playNext(guildId);
  const finished = s.queue.shift();
  if (!suppress && !failed && s.loop === 'queue' && finished) s.queue.push(finished);
  if (!s.queue.length) {
    killProcs(s); // nothing more to play — release the stream processes
    refreshActivity(); // back to /help (unless another server is playing)
    scheduleIdleLeave(s, guildId); // leave if nothing new is added soon
    return;
  }
  playNext(guildId);
  if (!suppress) announceNowPlaying(guildId, s, s.queue[0]);
}

// Move past the current song right away, even while it is paused or still loading.
function skipCurrent(s, guildId) {
  s.suppressAnnounce = true;
  if (!s.player || !s.player.stop(true)) onIdle(s, guildId, null); // player was already idle
}

// Leave soon if nothing is playing (queue finished, or a play failed after joining).
function scheduleIdleLeave(s, guildId, reason = '👋 Left — the queue finished.') {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => leaveGuild(guildId, reason), IDLE_MS);
}

function leaveGuild(guildId, reason) {
  const s = guilds.get(guildId);
  if (!s) return;
  s.leaving = true; // stale handlers and the reconnect logic must not touch this session again
  guilds.delete(guildId);
  clearTimeout(s.leaveTimer);
  clearTimeout(s.idleTimer);
  s.queue = [];
  killProcs(s);
  try { s.player?.stop(true); } catch { /* ignore */ }
  try { if (s.connection && s.connection.state.status !== VoiceConnectionStatus.Destroyed) s.connection.destroy(); } catch { /* ignore */ }
  if (reason) sendAnnounce(guildId, s, reason);
  refreshActivity(); // back to /help (unless another server is playing)
}

// Resilience for the voice connection: a network blip is retried on the same connection (the song
// resumes where it stopped); a moderator's Disconnect is respected.
function attachConnectionHandlers(s, guildId) {
  const conn = s.connection;
  conn.on('error', (e) => console.error('[voice error]', e.message));
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    if (s.leaving || s.reconnecting) return;
    s.reconnecting = true;
    try {
      try { // moved to another channel, or the library is already reconnecting by itself
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        return;
      } catch { /* a real drop */ }
      for (let i = 0; i < 6 && !s.leaving; i++) {
        // Not the member cache: a gateway re-identify clears it, and that drop should be rejoined.
        if (s.kicked) return leaveGuild(guildId, '👋 Left — I was disconnected from the voice channel.');
        conn.rejoin(); // re-sends the join for joinConfig.channelId; the player stays subscribed
        try { await entersState(conn, VoiceConnectionStatus.Ready, 10_000); return; } catch { /* gateway still down; retry */ }
      }
      if (!s.leaving) leaveGuild(guildId, '⚠️ Lost the voice connection and couldn\'t reconnect. Run /play to start again.');
    } finally { s.reconnecting = false; }
  });
}

// Make sure the bot is in the caller's voice channel. Assumes the interaction is deferred.
async function ensureConnection(interaction, s) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) {
    await interaction.editReply('Join a voice channel first.');
    return false;
  }
  const guildId = interaction.guildId;
  const stale = () => guilds.get(guildId) !== s; // /stop (or an auto-leave) ended this session meanwhile
  if (stale()) {
    await interaction.editReply('Playback was just stopped — run the command again.');
    return false;
  }
  const canUse = (ch) => ch.joinable && ch.permissionsFor(client.user)?.has(PermissionFlagsBits.Speak);
  if (s.connection) {
    const botCh = s.connection.joinConfig.channelId;
    if (botCh !== channel.id) {
      const cur = interaction.guild.channels.cache.get(botCh);
      if (cur?.members.some((m) => !m.user.bot)) {
        await interaction.editReply(`I'm already playing in <#${botCh}> — join that channel.`);
        return false;
      }
      if (!canUse(channel)) {
        await interaction.editReply(`I can't join or speak in <#${channel.id}> — check my Connect/Speak permissions there (or it's full).`);
        return false;
      }
      // Nobody is listening where I am: move the existing connection to the caller's channel.
      joinVoiceChannel({ channelId: channel.id, guildId, adapterCreator: channel.guild.voiceAdapterCreator });
    }
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; } // someone wants music again
    return true;
  }
  if (!canUse(channel)) {
    await interaction.editReply(`I can't join or speak in <#${channel.id}> — check my Connect/Speak permissions there (or it's full).`);
    return false;
  }
  s.connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
  });
  // Tolerate up to 15 s of stalled audio (slow download) instead of ending the song after 100 ms.
  s.player = createAudioPlayer({ behaviors: { maxMissedFrames: 750 } });
  s.connection.subscribe(s.player);
  attachConnectionHandlers(s, guildId);
  s.player.on(AudioPlayerStatus.Idle, (oldState) => onIdle(s, guildId, oldState));
  // An 'error' is always followed by Idle, which advances the queue; don't advance twice here.
  s.player.on('error', (e) => { if (!s.leaving) console.error('Player error:', e.message); });

  try {
    await entersState(s.connection, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    if (!stale()) leaveGuild(guildId); // never tear down a newer session
    await interaction.editReply(stale() ? 'Playback was just stopped — run the command again.' : 'Could not connect to voice.');
    return false;
  }
  if (stale()) {
    await interaction.editReply('Playback was just stopped — run the command again.');
    return false;
  }
  return true;
}

// Add songs to a guild's queue (capped); start playing if it was empty. Returns what was added.
function enqueue(s, guildId, tracks, requestedBy) {
  const add = tracks.slice(0, Math.max(0, MAX_QUEUE - s.queue.length));
  const startNow = s.queue.length === 0 && add.length > 0;
  s.queue.push(...add.map((t) => ({
    title: t.title, url: t.url, duration: t.duration ?? null, thumbnail: t.thumbnail ?? null, requestedBy,
  })));
  if (startNow) { s.fails = 0; playNext(guildId); }
  return { add, startNow };
}

const nameOpt = (o, desc) => o.setName('name').setDescription(desc).setRequired(true).setMaxLength(50);
const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Play a YouTube link or playlist, or search by name')
    .addStringOption((o) => o.setName('query').setDescription('YouTube link or search').setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip current song'),
  new SlashCommandBuilder().setName('next').setDescription('Skip to the next song in the queue'),
  new SlashCommandBuilder().setName('jump').setDescription('Jump to a queue position (keeps the rest)')
    .addIntegerOption((o) => o.setName('position').setDescription('Position number, e.g. 3').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('cut').setDescription('Jump to a position and delete everything before it')
    .addIntegerOption((o) => o.setName('position').setDescription('Position number, e.g. 3').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('remove').setDescription('Remove song(s) from the queue')
    .addStringOption((o) => o.setName('positions').setDescription('Position(s) from /queue, e.g. 2 or 2,3,5').setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder().setName('clear').setDescription('Clear the queue (keeps the current song)'),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming songs'),
  new SlashCommandBuilder().setName('loop').setDescription('Set loop mode')
    .addStringOption((o) => o.setName('mode').setDescription('off / song / queue').setRequired(true)
      .addChoices({ name: 'off', value: 'off' }, { name: 'song', value: 'song' }, { name: 'queue', value: 'queue' })),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop and leave the channel'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the queue'),
  new SlashCommandBuilder().setName('list').setDescription('Show the queue'),
  new SlashCommandBuilder().setName('save').setDescription('Save the current queue as a playlist')
    .addStringOption((o) => nameOpt(o, 'Playlist name')),
  new SlashCommandBuilder().setName('load').setDescription('Load a saved playlist into the queue')
    .addStringOption((o) => nameOpt(o, 'Playlist name or number')),
  new SlashCommandBuilder().setName('playlists').setDescription('List your saved playlists'),
  new SlashCommandBuilder().setName('showplaylist').setDescription('Show the songs in a saved playlist')
    .addStringOption((o) => nameOpt(o, 'Playlist name or number')),
  new SlashCommandBuilder().setName('removefromplaylist').setDescription('Remove song(s) from a saved playlist')
    .addStringOption((o) => o.setName('playlist').setDescription('Playlist name or number').setRequired(true).setMaxLength(50))
    .addStringOption((o) => o.setName('song').setDescription('Song number(s) e.g. 1,3 (from /showplaylist) or part of a title').setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder().setName('addtoplaylist').setDescription('Add a song to a saved playlist')
    .addStringOption((o) => nameOpt(o, 'Playlist name or number'))
    .addStringOption((o) => o.setName('song').setDescription('YouTube link or search (defaults to the current song)').setRequired(false).setMaxLength(500)),
  new SlashCommandBuilder().setName('deleteplaylist').setDescription('Delete saved playlist(s)')
    .addStringOption((o) => o.setName('name').setDescription('Name(s) or number(s), e.g. rock or 1,3').setRequired(true).setMaxLength(200))
    .setDefaultMemberPermissions(ADMIN),
  new SlashCommandBuilder().setName('deleteallplaylists').setDescription('Delete ALL saved playlists on this server')
    .setDefaultMemberPermissions(ADMIN),
  new SlashCommandBuilder().setName('setchannel').setDescription('Choose the channel for now-playing/announcements')
    .addChannelOption((o) => o.setName('channel').setDescription('Channel (default: the current one)')
      .addChannelTypes(ChannelType.GuildText).setRequired(false))
    .setDefaultMemberPermissions(ADMIN),
  new SlashCommandBuilder().setName('resetchannel').setDescription('Post announcements wherever commands are used (default)')
    .setDefaultMemberPermissions(ADMIN),
  new SlashCommandBuilder().setName('createchannel').setDescription('Create a channel for the bot and post announcements there')
    .addStringOption((o) => o.setName('name').setDescription('Channel name (default: music-bot)').setRequired(false).setMaxLength(90))
    .setDefaultMemberPermissions(ADMIN),
  new SlashCommandBuilder().setName('autodelete').setDescription('Auto-delete the bot\'s command replies after N seconds, or off')
    .addStringOption((o) => o.setName('value').setDescription('Seconds, e.g. 30 (or "off"; max 840)').setRequired(true).setMaxLength(10))
    .setDefaultMemberPermissions(ADMIN),
  new SlashCommandBuilder().setName('help').setDescription('Show all commands'),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
// Guild-scoped registration = instant. Register on every server the bot is in.
async function registerCommands(guildId) {
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
  } catch (e) {
    console.error(`Command registration failed for guild ${guildId}:`, e.message);
  }
}

client.once(Events.ClientReady, async () => {
  for (const [id] of client.guilds.cache) await registerCommands(id);
  refreshActivity();
  console.log(`Logged in as ${client.user.tag} (${client.guilds.cache.size} server(s))`);
  const invite = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=3148816&scope=bot+applications.commands`;
  console.log(`Invite link: ${invite}`);
});
// Presence is not re-sent after a gateway re-identify; restore it every time a shard is ready.
client.on(Events.ShardReady, () => refreshActivity());
client.on(Events.ShardDisconnect, (e) => console.error('Gateway disconnected:', e?.code ?? ''));
client.on(Events.ShardError, (e) => console.error('Gateway error:', e.message));

client.on(Events.GuildCreate, (guild) => registerCommands(guild.id));
// Removed from a server: stop its stream processes and forget its session.
client.on(Events.GuildDelete, (guild) => leaveGuild(guild.id));
// The log channel was deleted: forget it so replies don't get doubled or lost.
client.on(Events.ChannelDelete, (ch) => {
  const g = guildSettings[ch.guildId];
  if (g?.channel === ch.id) { delete g.channel; saveSettings(); }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  const s = guilds.get(guild.id);
  if (!s || !s.connection || s.leaving) return;
  // The bot itself was disconnected (a moderator's Disconnect, a kick, or its channel was deleted):
  // leave instead of fighting it. Our own rejoin always happens while the connection is Signalling.
  if (newState.id === client.user.id) {
    s.kicked = !newState.channelId; // read by the reconnect loop
    if (s.kicked && s.connection.state.status !== VoiceConnectionStatus.Signalling) {
      return leaveGuild(guild.id, '👋 Left — I was disconnected from the voice channel.');
    }
  }
  const channel = guild.channels.cache.get(s.connection.joinConfig.channelId);
  if (!channel) return leaveGuild(guild.id, '👋 Left — my voice channel was removed.');
  // Auto-leave when the bot is alone in the voice channel.
  const humans = channel.members.filter((m) => !m.user.bot).size;
  if (humans === 0) {
    if (!s.leaveTimer) {
      s.leaveTimer = setTimeout(() => leaveGuild(guild.id, '👋 Left — the voice channel was empty.'), LEAVE_MS);
    }
  } else if (s.leaveTimer) {
    clearTimeout(s.leaveTimer);
    s.leaveTimer = null;
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  const gid = interaction.guildId;
  const s = getState(gid);
  const cmd = interaction.commandName;

  // Playback controls only from the bot's voice channel, so nobody outside it can wreck the session.
  const botCh = s.connection?.joinConfig.channelId;
  if (CONTROL.has(cmd) && botCh && interaction.member?.voice?.channelId !== botCh
      && !interaction.memberPermissions?.has(ADMIN)) {
    return interaction.reply({ content: `Join <#${botCh}> to control playback.`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  if (interaction.channel) s.textChannel = interaction.channel; // post auto-advance messages here

  const run = async () => {
  if (cmd === 'play') {
    await interaction.deferReply();
    if (!(await ensureConnection(interaction, s))) return;
    if (s.resolving >= 3) return interaction.editReply('Still fetching earlier requests — try again in a moment.');
    s.resolving++;
    let tracks;
    try {
      tracks = await resolveTracks(interaction.options.getString('query'));
    } catch (e) {
      if (!e.userFacing) console.error('Lookup failed:', e.message);
      // If the bot joined but nothing is queued, don't sit idle forever.
      if (guilds.get(gid) === s && !s.queue.length && s.connection) scheduleIdleLeave(s, gid, '👋 Left — nothing to play.');
      return interaction.editReply(e.userFacing ? `❌ Couldn't load that: ${md(e.message)}` : '❌ Something went wrong fetching that — try again.');
    } finally { s.resolving--; }
    if (guilds.get(gid) !== s || s.leaving) return interaction.editReply('Playback was stopped meanwhile — run /play again.');
    const { add, startNow } = enqueue(s, gid, tracks, interaction.user.username);
    if (!add.length) return interaction.editReply(`The queue is full (${MAX_QUEUE} songs).`);
    const dedicated = Boolean(logChannel(gid));
    if (startNow && dedicated) announceNowPlaying(gid, s, s.queue[0]); // embed to the set channel
    if (tracks.length === 1) {
      if (startNow && !dedicated) return interaction.editReply({ embeds: [nowPlayingEmbed(s.queue[0])] });
      return interaction.editReply(startNow
        ? `▶️ Playing **${md(add[0].title)}**`
        : `➕ Queued **${md(add[0].title)}** (position ${s.queue.length - 1})`);
    }
    const capped = add.length < tracks.length ? ` (queue limit reached — ${tracks.length - add.length} left out)`
      : tracks.length >= MAX_ADD ? ` (first ${MAX_ADD} only)` : '';
    return interaction.editReply(`➕ Added **${add.length}** songs from the playlist${capped}.${startNow ? ` Now playing **${md(add[0].title)}**` : ''}`);
  }

  if (cmd === 'load') {
    // Check the name before joining, so a typo doesn't leave the bot sitting in voice.
    const name = resolvePlaylistName(gid, interaction.options.getString('name'));
    const saved = name ? playlists[gid][name] : null;
    if (!Array.isArray(saved) || !saved.length) return respond(interaction, s, 'No saved playlist by that name/number. See /playlists.', false);
    await interaction.deferReply();
    if (!(await ensureConnection(interaction, s))) return;
    const { add, startNow } = enqueue(s, gid, saved, interaction.user.username);
    if (!add.length) return interaction.editReply(`The queue is full (${MAX_QUEUE} songs).`);
    if (startNow && logChannel(gid)) announceNowPlaying(gid, s, s.queue[0]);
    return interaction.editReply(`📂 Loaded **${add.length}** songs from **${md(name)}**.${startNow ? ` Now playing **${md(add[0].title)}**` : ''}`);
  }

  if (cmd === 'pause') {
    if (!s.player?.pause()) return respond(interaction, s, 'Nothing is playing right now.', false);
    return respond(interaction, s, '⏸️ Paused.');
  }
  if (cmd === 'resume') {
    if (!s.player?.unpause()) return respond(interaction, s, 'Nothing is paused.', false);
    return respond(interaction, s, '▶️ Resumed.');
  }

  if (cmd === 'skip' || cmd === 'next') {
    if (!s.queue.length) return respond(interaction, s, 'Nothing to skip.', false);
    if (s.loop === 'queue') s.queue.push(s.queue[0]); // queue-loop: skipping keeps it in the rotation
    const upcoming = s.queue[1];
    skipCurrent(s, gid);
    return respond(interaction, s, upcoming
      ? `⏭️ Skipped — now playing **${md(upcoming.title)}**`
      : '⏭️ Skipped — queue is empty.');
  }
  if (cmd === 'jump') {
    const pos = interaction.options.getInteger('position');
    if (pos < 1 || pos >= s.queue.length) return respond(interaction, s, 'No song at that position — check /queue.', false);
    if (s.loop === 'queue') s.queue.push(s.queue[0]);
    const [track] = s.queue.splice(pos, 1);
    s.queue.splice(1, 0, track);
    skipCurrent(s, gid);
    return respond(interaction, s, `⏭️ Playing **${md(track.title)}** next — the rest stays queued.`);
  }
  if (cmd === 'cut') {
    const pos = interaction.options.getInteger('position');
    if (pos < 1 || pos >= s.queue.length) return respond(interaction, s, 'No song at that position — check /queue.', false);
    s.queue.splice(1, pos - 1);
    const target = s.queue[1].title;
    skipCurrent(s, gid);
    return respond(interaction, s, `✂️ Cut to **${md(target)}** — earlier songs removed.`);
  }
  if (cmd === 'remove') {
    const nums = parseNumberList(interaction.options.getString('positions'));
    const idxs = nums.filter((n) => n >= 1 && n < s.queue.length).sort((a, b) => b - a);
    if (!idxs.length) return respond(interaction, s, 'No valid positions — check /queue (can\'t remove the current song).', false);
    const removed = idxs.map((i) => s.queue.splice(i, 1)[0]).reverse();
    return respond(interaction, s, fitLines(removed.map((t) => `• ${md(t.title)}`), `🗑️ Removed ${removed.length} song(s):`));
  }
  if (cmd === 'clear') {
    if (s.queue.length <= 1) return respond(interaction, s, 'The queue is already empty.', false);
    const n = s.queue.length - 1;
    s.queue = s.queue.slice(0, 1); // keep the current song
    return respond(interaction, s, `🧹 Cleared ${n} song(s). The current song keeps playing.`);
  }
  if (cmd === 'shuffle') {
    if (s.queue.length <= 2) return respond(interaction, s, 'Not enough songs to shuffle.', false);
    const rest = s.queue.slice(1);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    s.queue = [s.queue[0], ...rest];
    return respond(interaction, s, `🔀 Shuffled ${rest.length} upcoming songs.`);
  }
  if (cmd === 'loop') {
    s.loop = interaction.options.getString('mode');
    const label = { off: 'off', song: 'current song 🔂', queue: 'whole queue 🔁' }[s.loop];
    return respond(interaction, s, `Loop set to **${label}**.`);
  }
  if (cmd === 'nowplaying') {
    const cur = s.queue[0];
    if (!cur) return respond(interaction, s, 'Nothing is playing.', false);
    return respond(interaction, s, { embeds: [nowPlayingEmbed(cur)] }, false);
  }
  if (cmd === 'stop') {
    const wasConnected = Boolean(s.connection);
    leaveGuild(gid);
    return respond(interaction, s, wasConnected ? '⏹️ Stopped and left.' : 'I\'m not playing anything.', wasConnected);
  }
  if (cmd === 'queue' || cmd === 'list') {
    if (!s.queue.length) return respond(interaction, s, 'Queue is empty.', false);
    const loopNote = s.loop !== 'off' ? ` · loop: ${s.loop}` : '';
    const lines = s.queue.map((t, i) => `${i === 0 ? '▶️' : `${i}.`} ${md(t.title)} — *${md(t.requestedBy)}*`);
    return respond(interaction, s, fitLines(lines, `**Queue** (${s.queue.length} song${s.queue.length === 1 ? '' : 's'}${loopNote})`), false);
  }
  if (cmd === 'save') {
    const name = normName(interaction.options.getString('name'));
    if (!name) return respond(interaction, s, 'Give the playlist a name.', false);
    if (/^\d+$/.test(name)) return respond(interaction, s, 'Playlist names can\'t be only numbers (that clashes with position numbers) — add some letters.', false);
    if (name === '__proto__') return respond(interaction, s, 'That name isn\'t allowed — pick another.', false);
    if (!s.queue.length) return respond(interaction, s, 'Queue is empty — nothing to save.', false);
    const exists = Object.hasOwn(playlists[gid] ?? {}, name);
    // Snapshot now: the queue can change (or empty) while the question is open.
    const snap = s.queue.slice(0, MAX_QUEUE).map((t) => ({
      title: t.title, url: t.url, duration: t.duration ?? null, thumbnail: t.thumbnail ?? null,
    }));
    const btn = await askYesNo(interaction,
      `Save the current queue (**${snap.length}** songs) as **${md(name)}**?${exists ? '\n⚠️ A playlist with that name already exists — this will overwrite it.' : ''}`,
      exists);
    if (!btn) return;
    if (btn.customId === 'no') return btn.update({ content: 'Cancelled — nothing saved.', components: [] });
    (playlists[gid] ??= {})[name] = snap;
    const ok = savePlaylists();
    return btn.update({
      content: ok ? `💾 Saved **${snap.length}** songs as playlist **${md(name)}**.` : '⚠️ Couldn\'t write the playlist file — check the bot\'s logs.',
      components: [],
    });
  }
  if (cmd === 'playlists') {
    const g = playlists[gid] || {};
    const names = Object.keys(g);
    if (!names.length) return respond(interaction, s, 'No saved playlists yet. Save one with `/save <name>`.', false);
    return respond(interaction, s, fitLines(names.map((n, i) => `${i + 1}. ${md(n)} (${g[n].length} songs)`), '📚 **Saved playlists:**'), false);
  }
  if (cmd === 'showplaylist') {
    const name = resolvePlaylistName(gid, interaction.options.getString('name'));
    if (!name) return respond(interaction, s, 'No such playlist. See /playlists.', false);
    const songs = playlists[gid][name];
    return respond(interaction, s, fitLines(songs.map((t, i) => `${i + 1}. ${md(t.title)}`), `📃 **${md(name)}** (${songs.length} songs)`), false);
  }
  if (cmd === 'removefromplaylist') {
    const name = resolvePlaylistName(gid, interaction.options.getString('playlist'));
    if (!name) return interaction.reply('No such playlist. See /playlists.');
    const songs = playlists[gid][name];
    const songInput = interaction.options.getString('song').trim();
    if (!songInput) return interaction.reply('Give a song number or part of its title.');
    // Number mode only for a pure list of numbers, so a title like "Mambo No 5" is searched by name.
    const nums = /^[\d\s,]+$/.test(songInput) ? parseNumberList(songInput) : [];
    let removed;
    if (nums.length) {
      const idxs = nums.map((n) => n - 1).filter((i) => i >= 0 && i < songs.length).sort((a, b) => b - a);
      if (!idxs.length) return interaction.reply(`No valid song numbers in **${md(name)}**. Try /showplaylist ${md(name)}.`);
      removed = idxs.map((i) => songs.splice(i, 1)[0]).reverse();
    } else {
      const idx = songs.findIndex((t) => String(t.title).toLowerCase().includes(songInput.toLowerCase()));
      if (idx < 0) return interaction.reply(`Couldn't find that song in **${md(name)}**. Try /showplaylist ${md(name)}.`);
      removed = [songs.splice(idx, 1)[0]];
    }
    let note;
    if (songs.length === 0) { delete playlists[gid][name]; note = 'Playlist is now empty and was removed.'; }
    else note = `(${songs.length} left)`;
    savePlaylists();
    return interaction.reply(fitLines(removed.map((t) => `• ${md(t.title)}`), `🗑️ Removed ${removed.length} song(s) from **${md(name)}**:`, `\n${note}`));
  }
  if (cmd === 'deleteplaylist') {
    const g = playlists[gid];
    if (!g || !Object.keys(g).length) return interaction.reply('No saved playlists. See /playlists.');
    // Try the whole input as one name first ("road trip"), then as a list ("rock, chill" / "1 3").
    const raw = interaction.options.getString('name').trim();
    const whole = resolvePlaylistName(gid, raw);
    const parts = whole ? [raw] : raw.split(raw.includes(',') ? ',' : /\s+/);
    const targets = [...new Set(parts.map((t) => resolvePlaylistName(gid, t)).filter(Boolean))];
    if (!targets.length) return interaction.reply('No matching playlists — see /playlists.');
    const list = md(targets.join(', ')).slice(0, 1500);
    const btn = await askYesNo(interaction, `⚠️ Delete ${targets.length} saved playlist(s): **${list}**?\nThis can't be undone.`, true);
    if (!btn) return;
    if (btn.customId === 'no') return btn.update({ content: 'Cancelled — nothing deleted.', components: [] });
    targets.forEach((n) => delete g[n]);
    savePlaylists();
    return btn.update({ content: `🗑️ Deleted: **${list}**.`, components: [] });
  }
  if (cmd === 'deleteallplaylists') {
    const count = Object.keys(playlists[gid] || {}).length;
    if (!count) return interaction.reply('No saved playlists to delete.');
    const btn = await askYesNo(interaction,
      `⚠️ **Delete ALL ${count} saved playlist(s) on this server?**\nThis cannot be undone.`, true);
    if (!btn) return;
    if (btn.customId === 'no') return btn.update({ content: 'Cancelled — nothing deleted.', components: [] });
    delete playlists[gid];
    savePlaylists();
    return btn.update({ content: `🗑️ Deleted all **${count}** saved playlist(s).`, components: [] });
  }
  if (cmd === 'addtoplaylist') {
    const name = resolvePlaylistName(gid, interaction.options.getString('name'));
    if (!name) return interaction.reply('No such playlist — create one with /save first, or see /playlists.');
    const song = interaction.options.getString('song');
    let toAdd;
    if (song) {
      await interaction.deferReply();
      try {
        toAdd = await resolveTracks(song);
      } catch (e) {
        if (!e.userFacing) console.error('Lookup failed:', e.message);
        return interaction.editReply(e.userFacing ? `❌ Couldn't load that: ${md(e.message)}` : '❌ Could not find that song.');
      }
    } else {
      const cur = s.queue[0];
      if (!cur) return interaction.reply('Nothing is playing — give a song, or play one first.');
      toAdd = [cur];
    }
    const list = playlists[gid]?.[name]; // re-read: it may have been deleted during the lookup
    const say = (m) => (song ? interaction.editReply(m) : interaction.reply(m));
    if (!Array.isArray(list)) return say('That playlist was deleted meanwhile.');
    const room = MAX_QUEUE - list.length;
    if (room <= 0) return say(`**${md(name)}** is full (${MAX_QUEUE} songs).`);
    const added = toAdd.slice(0, room).map((t) => ({
      title: t.title, url: t.url, duration: t.duration ?? null, thumbnail: t.thumbnail ?? null,
    }));
    list.push(...added);
    savePlaylists();
    return say(added.length === 1
      ? `➕ Added **${md(added[0].title)}** to **${md(name)}** (now ${list.length} songs).`
      : `➕ Added **${added.length}** songs to **${md(name)}** (now ${list.length} songs).`);
  }
  if (cmd === 'setchannel') {
    if (!interaction.memberPermissions?.has(ADMIN)) {
      return interaction.reply({ content: 'You need the **Manage Channels** permission to set this.', flags: MessageFlags.Ephemeral });
    }
    const target = interaction.options.getChannel('channel') || interaction.channel;
    if (!target) return interaction.reply({ content: 'Pick a channel with the `channel` option.', flags: MessageFlags.Ephemeral });
    gset(gid).channel = target.id;
    saveSettings();
    const canSend = target.permissionsFor?.(client.user)?.has(PermissionFlagsBits.SendMessages);
    return interaction.reply(`✅ I'll post the log in <#${target.id}> from now on. Commands work in any channel; use /autodelete to auto-clear my replies from the command channel.${canSend ? '' : '\n⚠️ Heads up: I may not have permission to send messages there — give me access to that channel.'}`);
  }
  if (cmd === 'resetchannel') {
    if (!interaction.memberPermissions?.has(ADMIN)) {
      return interaction.reply({ content: 'You need the **Manage Channels** permission to change this.', flags: MessageFlags.Ephemeral });
    }
    delete gset(gid).channel;
    saveSettings();
    return interaction.reply('✅ Announcements will now go to wherever the command is used (default).');
  }
  if (cmd === 'createchannel') {
    if (!interaction.memberPermissions?.has(ADMIN)) {
      return interaction.reply({ content: 'You need the **Manage Channels** permission to do this.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply();
    const name = (interaction.options.getString('name') || 'music-bot').slice(0, 90);
    try {
      const ch = await interaction.guild.channels.create({ name, reason: 'Music bot announcements channel' });
      gset(gid).channel = ch.id;
      saveSettings();
      return interaction.editReply(`✅ Created <#${ch.id}> — I'll post now-playing and announcements there.`);
    } catch (e) {
      console.error('createchannel failed:', e.message);
      return interaction.editReply('I couldn\'t create a channel — I need the **Manage Channels** permission. Re-invite me with the updated link (dashboard → **Show invite link**) or give my role Manage Channels, then try again. Or make a channel yourself and run **/setchannel** in it.');
    }
  }
  if (cmd === 'autodelete') {
    if (!interaction.memberPermissions?.has(ADMIN)) {
      return interaction.reply({ content: 'You need the **Manage Channels** permission to change this.', flags: MessageFlags.Ephemeral });
    }
    const raw = interaction.options.getString('value').trim().toLowerCase();
    let secs;
    if (['off', 'none', 'no', 'false', '0'].includes(raw)) secs = 0;
    else if (/^\d+$/.test(raw)) secs = Math.min(Number(raw), 840); // replies can only be deleted within ~15 min
    else return interaction.reply({ content: 'Give a whole number of seconds (e.g. `30`) or `off`.', flags: MessageFlags.Ephemeral });
    const g = gset(gid);
    if (secs > 0) g.autoDelete = secs; else delete g.autoDelete;
    saveSettings();
    return interaction.reply(secs > 0
      ? `🧹 I'll auto-delete my command replies after **${secs}s**. (Posts in the log channel stay.)`
      : '🧹 Auto-delete turned **off** — my command replies will stay.');
  }
  if (cmd === 'help') {
    return respond(interaction, s, [
      '**🎵 Music bot — commands**',
      '',
      '__Playback__ (controls work from the bot\'s voice channel)',
      '`/play <link or search>` — play a YouTube link or playlist, or search by name',
      '`/pause` — pause the current song',
      '`/resume` — resume playback',
      '`/skip` (or `/next`) — skip to the next song',
      '`/nowplaying` — show what\'s playing now (with duration + thumbnail)',
      '`/stop` — stop, clear the queue, and leave the voice channel',
      '',
      '__Queue__',
      '`/queue` (or `/list`) — show the current queue',
      '`/jump <n>` — jump to song #n, keeping the ones before it',
      '`/cut <n>` — jump to song #n and delete everything before it',
      '`/remove <n[,n...]>` — remove one or more songs, e.g. `2,3,5`',
      '`/clear` — clear the queue (the current song keeps playing)',
      '`/shuffle` — shuffle the upcoming songs',
      '`/loop off|song|queue` — repeat the current song, the whole queue, or off',
      '',
      '__Saved playlists__',
      '`/save <name>` — save the current queue as a playlist',
      '`/load <name|#>` — load a saved playlist into the queue',
      '`/playlists` — list your saved playlists (numbered)',
      '`/showplaylist <name|#>` — show the songs in a playlist',
      '`/addtoplaylist <name> [song]` — add a song (or the current one) to a playlist',
      '`/removefromplaylist <name> <n[,n...]|title>` — remove song(s) from a playlist',
      '',
      '__Admin (needs Manage Channels)__',
      '`/deleteplaylist <name/# [,...]>` — delete one or more playlists',
      '`/deleteallplaylists` — delete every saved playlist',
      '`/setchannel [channel]` — post now-playing/log to a channel (default: current)',
      '`/resetchannel` — go back to replying where the command is used',
      '`/createchannel [name]` — create a channel and use it for the log',
      '`/autodelete <seconds|off>` — auto-delete command replies after N sec (max 840)',
      '',
      '`/help` — show this message · Volume: right-click the bot → User Volume',
    ].join('\n'), false);
  }
  };

  try {
    await run();
  } catch (e) {
    console.error(`Command /${cmd} failed:`, e);
    try {
      if (interaction.deferred) await interaction.editReply('⚠️ Something went wrong with that command.');
      else if (!interaction.replied) await interaction.reply('⚠️ Something went wrong with that command.');
    } catch { /* nothing more we can do */ }
  }

  // /autodelete is the on/off switch: on -> remove the reply from the command channel after the
  // delay; off -> it stays. (The log channel keeps its own copy.) Timed from when the command was
  // used, because Discord only lets a reply be deleted for ~15 min after that.
  const secs = Number(guildSettings[gid]?.autoDelete) || 0;
  if (secs > 0 && !interaction.keepReply) {
    const wait = Math.min(secs * 1000, 14.5 * 60_000 - (Date.now() - interaction.createdTimestamp));
    setTimeout(() => interaction.deleteReply().catch(() => {}), Math.max(0, wait));
  }
});

client.on(Events.Error, (e) => console.error('Client error:', e.message));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e?.stack || e?.message || e));
process.on('uncaughtException', (e) => { console.error('Fatal:', e?.stack || e); process.exit(1); }); // the watchdog restarts us

// Windows: keep the PC awake while the bot runs, so sleep doesn't pause playback.
// The helper watches this process and exits (releasing the request) when the bot stops.
// Encoded command avoids quoting issues with the embedded C# signature.
function startKeepAwake() {
  const cmd = `$p=${process.pid};$s='[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint e);';$api=Add-Type -MemberDefinition $s -Name Pw -Namespace Win32 -PassThru;while(Get-Process -Id $p -ErrorAction SilentlyContinue){[void]$api::SetThreadExecutionState(2147483649);Start-Sleep -Seconds 50}`;
  try {
    const encoded = Buffer.from(cmd, 'utf16le').toString('base64');
    // NOTE: not detached — a detached+ignored child dies instantly on Windows here.
    const ka = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { stdio: 'ignore', windowsHide: true });
    ka.unref();
  } catch (e) { console.error('keep-awake failed:', e.message); }
}

// Retry login while the network comes up (e.g. right after sign-in); a bad token is final.
function login() {
  client.login(process.env.TOKEN).catch((e) => {
    console.error('Login failed:', e.message);
    if (e.code === 'TokenInvalid') process.exit(1);
    setTimeout(login, 15_000);
  });
}

function start() {
  if (!process.env.TOKEN) {
    console.error('No TOKEN in .env — run "First Time Setup.bat" or add TOKEN=... to .env');
    process.exit(1);
  }
  if (process.platform === 'win32' && config.keepAwake) startKeepAwake();
  // One copy per bot: a second one would answer every command twice and overwrite playlists.json
  // from stale memory. The OS frees the pipe name the moment this process dies.
  const appId = Buffer.from(process.env.TOKEN.split('.')[0], 'base64').toString().replace(/\D/g, '') || 'bot';
  net.createServer()
    .on('error', (e) => {
      if (e.code === 'EADDRINUSE') { console.error('Another copy of the bot is already running — exiting.'); process.exit(1); }
      console.error('Instance lock unavailable (' + e.message + ') — starting anyway.');
      login();
    })
    .listen(`\\\\.\\pipe\\discord-music-bot-${appId}`, login)
    .unref();
}

// `node bot.js` runs the bot; `require('./bot.js')` (test.js) only loads the helpers.
if (require.main === module) start();
module.exports = {
  resolveTracks, resolvePlaylistName, parseNumberList, normName, fitLines, ytdlpReason, fmtDuration,
  nowPlayingEmbed, md, playlists, commands, killTree, YTDLP_BASE,
};
