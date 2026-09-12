// Discord YouTube music bot — private, self-hosted.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActivityType, EmbedBuilder,
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState,
} = require('@discordjs/voice');

const LEAVE_MS = 5 * 60 * 1000; // auto-leave after 5 min alone in the channel
const IDLE_MS = 60 * 1000;      // auto-leave after 1 min with nothing playing

// --- saved playlists (persisted per guild) ---
const PLAYLISTS_FILE = path.join(__dirname, 'playlists.json');
let playlists = {};
try { playlists = JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8')); } catch { /* none yet */ }
function savePlaylists() {
  try { fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(playlists)); }
  catch (e) { console.error('playlist save failed:', e.message); }
}

// --- helpers ---
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
    .setTitle(track.title || 'Unknown').setURL(track.url || null);
  const dur = fmtDuration(track.duration);
  if (dur) e.addFields({ name: 'Duration', value: dur, inline: true });
  if (track.requestedBy) e.addFields({ name: 'Requested by', value: track.requestedBy, inline: true });
  if (track.thumbnail) e.setThumbnail(track.thumbnail);
  return e;
}

// Resolve a URL/search/playlist to an array of { title, url, duration, thumbnail }.
// A URL with a list= param returns the whole playlist; anything else, one track.
function resolveTracks(query) {
  const isUrl = /^https?:\/\//.test(query);
  const isPlaylist = isUrl && /[?&]list=/.test(query);
  const target = isUrl ? query : `ytsearch1:${query}`;
  const fmt = isPlaylist
    ? '%(title)s\t%(url)s\t%(duration)s\t%(thumbnail)s'
    : '%(title)s\t%(webpage_url)s\t%(duration)s\t%(thumbnail)s';
  const args = [isPlaylist ? '--flat-playlist' : '--no-playlist', '--print', fmt, target];
  return new Promise((resolve, reject) => {
    const p = spawn('yt-dlp', args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `yt-dlp exited ${code}`));
      const tracks = out.trim().split('\n').filter(Boolean).map((line) => {
        const [title, url, duration, thumbnail] = line.split('\t');
        return {
          title,
          url,
          duration: duration && duration !== 'NA' ? Number(duration) : null,
          thumbnail: thumbnail && thumbnail !== 'NA' ? thumbnail : null,
        };
      }).filter((t) => t.url);
      if (!tracks.length) return reject(new Error('No result'));
      resolve(tracks);
    });
  });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// Per-guild state.
const guilds = new Map();
function getState(guildId) {
  let s = guilds.get(guildId);
  if (!s) {
    s = {
      connection: null, player: null, queue: [], textChannel: null,
      suppressAnnounce: false, volume: 1, loop: 'off', resource: null,
      leaveTimer: null, idleTimer: null,
    };
    guilds.set(guildId, s);
  }
  return s;
}

async function playNext(guildId) {
  const s = getState(guildId);
  const next = s.queue[0];
  if (!next) return; // nothing queued; stay connected, idle
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; } // a song is starting
  // yt-dlp streams best audio to stdout; ffmpeg (via createAudioResource) transcodes.
  const yt = spawn('yt-dlp', ['-f', 'bestaudio', '--no-playlist', '-o', '-', next.url],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  yt.on('error', (e) => console.error('yt-dlp spawn error:', e.message));
  const resource = createAudioResource(yt.stdout, { inlineVolume: true });
  resource.volume?.setVolume(s.volume);
  s.resource = resource;
  s.player.play(resource);
}

function leaveGuild(guildId, reason) {
  const s = guilds.get(guildId);
  if (!s) return;
  if (s.leaveTimer) clearTimeout(s.leaveTimer);
  if (s.idleTimer) clearTimeout(s.idleTimer);
  try { s.player?.stop(); } catch { /* ignore */ }
  try { s.connection?.destroy(); } catch { /* ignore */ }
  if (reason) s.textChannel?.send(reason).catch(() => {});
  guilds.delete(guildId);
}

// Assumes interaction is already deferred; replies via editReply.
async function ensureConnection(interaction, s) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) {
    await interaction.editReply('Join a voice channel first.');
    return false;
  }
  if (!s.connection) {
    s.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
    s.player = createAudioPlayer();
    s.connection.subscribe(s.player);
    s.connection.on('error', (e) => console.error('[voice error]', e.message));

    s.player.on(AudioPlayerStatus.Idle, async () => {
      const suppress = s.suppressAnnounce; // consume: only commands set this
      s.suppressAnnounce = false;
      // Natural end with song-loop: replay the same song.
      if (!suppress && s.loop === 'song' && s.queue.length) {
        await playNext(interaction.guildId);
        return;
      }
      const finished = s.queue.shift();
      if (!suppress && s.loop === 'queue' && finished) s.queue.push(finished);
      if (!s.queue.length) {
        // Queue done — leave if nothing new is added soon.
        s.idleTimer = setTimeout(
          () => leaveGuild(interaction.guildId, '👋 Left — the queue finished.'), IDLE_MS);
        return;
      }
      await playNext(interaction.guildId);
      if (!suppress) {
        s.textChannel?.send({ embeds: [nowPlayingEmbed(s.queue[0])] }).catch(() => {});
      }
    });
    s.player.on('error', (e) => {
      console.error('Player error:', e.message);
      s.queue.shift();
      if (s.queue.length) playNext(interaction.guildId);
    });

    try {
      await entersState(s.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      s.connection.destroy();
      s.connection = null;
      await interaction.editReply('Could not connect to voice.');
      return false;
    }
  }
  return true;
}

const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Play a song, search term, or playlist')
    .addStringOption((o) => o.setName('query').setDescription('URL or search').setRequired(true)),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip current song'),
  new SlashCommandBuilder().setName('next').setDescription('Skip to the next song in the queue'),
  new SlashCommandBuilder().setName('jump').setDescription('Jump to a queue position (keeps the rest)')
    .addIntegerOption((o) => o.setName('position').setDescription('Position number, e.g. 3').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('cut').setDescription('Jump to a position and delete everything before it')
    .addIntegerOption((o) => o.setName('position').setDescription('Position number, e.g. 3').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('remove').setDescription('Remove one song from the queue')
    .addIntegerOption((o) => o.setName('position').setDescription('Position number from /queue').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('clear').setDescription('Clear the queue (keeps the current song)'),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming songs'),
  new SlashCommandBuilder().setName('loop').setDescription('Set loop mode')
    .addStringOption((o) => o.setName('mode').setDescription('off / song / queue').setRequired(true)
      .addChoices({ name: 'off', value: 'off' }, { name: 'song', value: 'song' }, { name: 'queue', value: 'queue' })),
  new SlashCommandBuilder().setName('volume').setDescription('Set the volume (0-200%)')
    .addIntegerOption((o) => o.setName('percent').setDescription('0-200').setRequired(true).setMinValue(0).setMaxValue(200)),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop and leave the channel'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the queue'),
  new SlashCommandBuilder().setName('list').setDescription('Show the queue'),
  new SlashCommandBuilder().setName('save').setDescription('Save the current queue as a playlist')
    .addStringOption((o) => o.setName('name').setDescription('Playlist name').setRequired(true)),
  new SlashCommandBuilder().setName('load').setDescription('Load a saved playlist into the queue')
    .addStringOption((o) => o.setName('name').setDescription('Playlist name').setRequired(true)),
  new SlashCommandBuilder().setName('playlists').setDescription('List your saved playlists'),
  new SlashCommandBuilder().setName('deleteplaylist').setDescription('Delete a saved playlist')
    .addStringOption((o) => o.setName('name').setDescription('Name or number from /playlists').setRequired(true)),
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

client.once('ready', async () => {
  for (const [id] of client.guilds.cache) await registerCommands(id);
  client.user.setActivity('/help', { type: ActivityType.Listening });
  console.log(`Logged in as ${client.user.tag} (${client.guilds.cache.size} server(s))`);
  const invite = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=3148800&scope=bot+applications.commands`;
  console.log(`Invite link: ${invite}`);
});

client.on('guildCreate', (guild) => registerCommands(guild.id));

// Auto-leave when the bot is alone in the voice channel.
client.on('voiceStateUpdate', (oldState, newState) => {
  const guild = oldState.guild || newState.guild;
  const s = guilds.get(guild.id);
  if (!s || !s.connection) return;
  const channel = guild.channels.cache.get(s.connection.joinConfig.channelId);
  if (!channel) return;
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

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const s = getState(interaction.guildId);
  const cmd = interaction.commandName;
  s.textChannel = interaction.channel; // post auto-advance messages here

  if (cmd === 'play') {
    await interaction.deferReply();
    if (!(await ensureConnection(interaction, s))) return;
    const query = interaction.options.getString('query');
    try {
      const tracks = await resolveTracks(query);
      const startNow = s.queue.length === 0;
      const by = interaction.user.username;
      s.queue.push(...tracks.map((t) => ({ ...t, requestedBy: by })));
      if (startNow) await playNext(interaction.guildId);
      if (tracks.length === 1) {
        if (startNow) return interaction.editReply({ embeds: [nowPlayingEmbed(tracks[0])] });
        return interaction.editReply(`➕ Queued **${tracks[0].title}** (position ${s.queue.length})`);
      }
      return interaction.editReply(`➕ Added **${tracks.length}** songs from the playlist.${startNow ? ` Now playing **${tracks[0].title}**` : ''}`);
    } catch (e) {
      console.error(e);
      return interaction.editReply('Something broke fetching that track.');
    }
  }

  if (cmd === 'load') {
    await interaction.deferReply();
    if (!(await ensureConnection(interaction, s))) return;
    const name = interaction.options.getString('name').toLowerCase();
    const saved = playlists[interaction.guildId]?.[name];
    if (!saved || !saved.length) return interaction.editReply(`No saved playlist named **${name}**. See /playlists.`);
    const startNow = s.queue.length === 0;
    const by = interaction.user.username;
    s.queue.push(...saved.map((t) => ({ ...t, requestedBy: by })));
    if (startNow) await playNext(interaction.guildId);
    return interaction.editReply(`📂 Loaded **${saved.length}** songs from **${name}**.${startNow ? ` Now playing **${saved[0].title}**` : ''}`);
  }

  if (cmd === 'pause') { s.player?.pause(); return interaction.reply('⏸️ Paused.'); }
  if (cmd === 'resume') { s.player?.unpause(); return interaction.reply('▶️ Resumed.'); }

  if (cmd === 'skip' || cmd === 'next') {
    if (!s.queue.length) return interaction.reply('Nothing to skip.');
    const upcoming = s.queue[1];
    s.suppressAnnounce = true;
    s.player?.stop();
    return interaction.reply(upcoming
      ? `⏭️ Skipped — now playing **${upcoming.title}**`
      : '⏭️ Skipped — queue is empty.');
  }
  if (cmd === 'jump') {
    const pos = interaction.options.getInteger('position');
    if (pos < 1 || pos >= s.queue.length) return interaction.reply('No song at that position — check /queue.');
    const [track] = s.queue.splice(pos, 1);
    s.queue.splice(1, 0, track);
    s.suppressAnnounce = true;
    s.player?.stop();
    return interaction.reply(`⏭️ Playing **${track.title}** next — the rest stays queued.`);
  }
  if (cmd === 'cut') {
    const pos = interaction.options.getInteger('position');
    if (pos < 1 || pos >= s.queue.length) return interaction.reply('No song at that position — check /queue.');
    s.queue.splice(1, pos - 1);
    const target = s.queue[1].title;
    s.suppressAnnounce = true;
    s.player?.stop();
    return interaction.reply(`✂️ Cut to **${target}** — earlier songs removed.`);
  }
  if (cmd === 'remove') {
    const pos = interaction.options.getInteger('position');
    if (pos < 1 || pos >= s.queue.length) return interaction.reply('No song at that position — check /queue.');
    const [removed] = s.queue.splice(pos, 1);
    return interaction.reply(`🗑️ Removed **${removed.title}** from the queue.`);
  }
  if (cmd === 'clear') {
    const n = Math.max(0, s.queue.length - 1);
    s.queue = s.queue.slice(0, 1); // keep the current song
    return interaction.reply(`🧹 Cleared ${n} song(s). The current song keeps playing.`);
  }
  if (cmd === 'shuffle') {
    if (s.queue.length <= 2) return interaction.reply('Not enough songs to shuffle.');
    const rest = s.queue.slice(1);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    s.queue = [s.queue[0], ...rest];
    return interaction.reply(`🔀 Shuffled ${rest.length} upcoming songs.`);
  }
  if (cmd === 'loop') {
    s.loop = interaction.options.getString('mode');
    const label = { off: 'off', song: 'current song 🔂', queue: 'whole queue 🔁' }[s.loop];
    return interaction.reply(`Loop set to **${label}**.`);
  }
  if (cmd === 'volume') {
    const v = interaction.options.getInteger('percent');
    s.volume = v / 100;
    s.resource?.volume?.setVolume(s.volume);
    return interaction.reply(`🔊 Volume set to **${v}%**.`);
  }
  if (cmd === 'nowplaying') {
    const cur = s.queue[0];
    if (!cur) return interaction.reply('Nothing is playing.');
    return interaction.reply({ embeds: [nowPlayingEmbed(cur)] });
  }
  if (cmd === 'stop') {
    leaveGuild(interaction.guildId);
    return interaction.reply('⏹️ Stopped and left.');
  }
  if (cmd === 'queue' || cmd === 'list') {
    if (!s.queue.length) return interaction.reply('Queue is empty.');
    const loopNote = s.loop !== 'off' ? `  (loop: ${s.loop})` : '';
    const list = s.queue
      .map((t, i) => `${i === 0 ? '▶️' : `${i}.`} ${t.title} — *${t.requestedBy}*`)
      .join('\n');
    return interaction.reply((list + loopNote).slice(0, 1900));
  }
  if (cmd === 'save') {
    const name = interaction.options.getString('name').toLowerCase();
    if (!s.queue.length) return interaction.reply('Queue is empty — nothing to save.');
    (playlists[interaction.guildId] ??= {})[name] = s.queue.map((t) => ({
      title: t.title, url: t.url, duration: t.duration ?? null, thumbnail: t.thumbnail ?? null,
    }));
    savePlaylists();
    return interaction.reply(`💾 Saved **${s.queue.length}** songs as playlist **${name}**.`);
  }
  if (cmd === 'playlists') {
    const g = playlists[interaction.guildId] || {};
    const names = Object.keys(g);
    if (!names.length) return interaction.reply('No saved playlists yet. Save one with `/save <name>`.');
    return interaction.reply('📚 **Saved playlists:**\n' + names.map((n, i) => `${i + 1}. ${n} (${g[n].length} songs)`).join('\n'));
  }
  if (cmd === 'deleteplaylist') {
    const g = playlists[interaction.guildId];
    const names = g ? Object.keys(g) : [];
    if (!names.length) return interaction.reply('No saved playlists. See /playlists.');
    const input = interaction.options.getString('name').trim();
    let name;
    if (/^\d+$/.test(input)) {
      const idx = parseInt(input, 10) - 1;
      if (idx < 0 || idx >= names.length) return interaction.reply(`No playlist #${input}. See /playlists.`);
      name = names[idx];
    } else {
      name = input.toLowerCase();
    }
    if (!g[name]) return interaction.reply(`No saved playlist **${input}**. See /playlists.`);
    delete g[name];
    savePlaylists();
    return interaction.reply(`🗑️ Deleted saved playlist **${name}**.`);
  }
  if (cmd === 'help') {
    return interaction.reply([
      '**🎵 Music bot commands**',
      '`/play <url or search>` — play a song, search, or playlist',
      '`/queue` (`/list`) — show the queue · `/nowplaying` — current song',
      '`/next` (`/skip`) — skip · `/jump <n>` — jump (keep rest) · `/cut <n>` — jump & delete before',
      '`/remove <n>` — remove one song · `/clear` — clear the queue',
      '`/shuffle` — shuffle upcoming · `/loop off|song|queue` — repeat',
      '`/volume <0-200>` — set volume',
      '`/pause` · `/resume` · `/stop` — leave the channel',
      '`/save <name>` · `/load <name>` · `/playlists` · `/deleteplaylist <name>` — saved playlists',
      '`/help` — this message',
    ].join('\n'));
  }
});

client.on('error', (e) => console.error('Client error:', e.message));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e?.message || e));

client.login(process.env.TOKEN);
