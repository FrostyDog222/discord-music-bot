// Discord YouTube music bot — private, self-hosted.
// Commands: /play /pause /resume /skip /stop /queue
require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActivityType,
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState,
} = require('@discordjs/voice');
const { spawn } = require('node:child_process');

// Resolve a URL/search/playlist to an array of { title, url } via yt-dlp.
// A URL with a list= param returns the whole playlist; anything else, one track.
function resolveTracks(query) {
  const isUrl = /^https?:\/\//.test(query);
  const isPlaylist = isUrl && /[?&]list=/.test(query);
  const target = isUrl ? query : `ytsearch1:${query}`;
  const args = isPlaylist
    ? ['--flat-playlist', '--print', '%(title)s\t%(url)s', target]
    : ['--no-playlist', '--print', '%(title)s\t%(webpage_url)s', target];
  return new Promise((resolve, reject) => {
    const p = spawn('yt-dlp', args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `yt-dlp exited ${code}`));
      const tracks = out.trim().split('\n').filter(Boolean)
        .map((line) => { const [title, url] = line.split('\t'); return { title, url }; })
        .filter((t) => t.url);
      if (!tracks.length) return reject(new Error('No result'));
      resolve(tracks);
    });
  });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Per-guild state: { connection, player, queue: [{title, url, requestedBy}] }
const guilds = new Map();

function getState(guildId) {
  let s = guilds.get(guildId);
  if (!s) {
    s = { connection: null, player: null, queue: [] };
    guilds.set(guildId, s);
  }
  return s;
}

async function playNext(guildId) {
  const s = getState(guildId);
  const next = s.queue[0];
  if (!next) return; // nothing queued; stay connected, idle
  // yt-dlp streams best audio to stdout; ffmpeg (via createAudioResource) transcodes.
  const yt = spawn('yt-dlp', ['-f', 'bestaudio', '--no-playlist', '-o', '-', next.url],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  yt.on('error', (e) => console.error('yt-dlp spawn error:', e.message));
  const resource = createAudioResource(yt.stdout);
  s.player.play(resource);
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

    s.player.on(AudioPlayerStatus.Idle, () => {
      s.queue.shift();          // current song done
      if (s.queue.length) playNext(interaction.guildId);
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
  new SlashCommandBuilder().setName('play').setDescription('Play a YouTube URL or search term')
    .addStringOption((o) => o.setName('query').setDescription('URL or search').setRequired(true)),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip current song'),
  new SlashCommandBuilder().setName('next').setDescription('Skip to the next song in the queue'),
  new SlashCommandBuilder().setName('jump').setDescription('Jump to a queue position (number from /queue)')
    .addIntegerOption((o) => o.setName('position').setDescription('Position number, e.g. 3').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('stop').setDescription('Stop and leave the channel'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the queue'),
  new SlashCommandBuilder().setName('list').setDescription('Show the queue'),
  new SlashCommandBuilder().setName('help').setDescription('Show all commands'),
].map((c) => c.toJSON());

client.once('ready', async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  // Guild-scoped = instant registration (global takes ~1h).
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
    { body: commands },
  );
  client.user.setActivity('/help', { type: ActivityType.Listening });
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const s = getState(interaction.guildId);
  const cmd = interaction.commandName;

  if (cmd === 'play') {
    await interaction.deferReply();
    if (!(await ensureConnection(interaction, s))) return;
    const query = interaction.options.getString('query');
    try {
      const tracks = await resolveTracks(query);
      const startNow = s.queue.length === 0;
      const by = interaction.user.username;
      s.queue.push(...tracks.map((t) => ({ title: t.title, url: t.url, requestedBy: by })));
      if (startNow) await playNext(interaction.guildId);
      if (tracks.length === 1) {
        await interaction.editReply(startNow
          ? `▶️ Playing **${tracks[0].title}**`
          : `➕ Queued **${tracks[0].title}** (position ${s.queue.length})`);
      } else {
        await interaction.editReply(`➕ Added **${tracks.length}** songs from the playlist.${startNow ? ` Now playing **${tracks[0].title}**` : ''}`);
      }
    } catch (e) {
      console.error(e);
      await interaction.editReply('Something broke fetching that track.');
    }
    return;
  }

  if (cmd === 'pause') {
    s.player?.pause();
    return interaction.reply('⏸️ Paused.');
  }
  if (cmd === 'resume') {
    s.player?.unpause();
    return interaction.reply('▶️ Resumed.');
  }
  if (cmd === 'skip' || cmd === 'next') {
    if (!s.queue.length) return interaction.reply('Nothing to skip.');
    const upcoming = s.queue[1]; // becomes current after the stop -> Idle shift
    s.player?.stop(); // triggers Idle -> playNext
    return interaction.reply(upcoming
      ? `⏭️ Skipped — now playing **${upcoming.title}**`
      : '⏭️ Skipped — queue is empty.');
  }
  if (cmd === 'jump') {
    const pos = interaction.options.getInteger('position');
    if (pos < 1 || pos >= s.queue.length) {
      return interaction.reply('No song at that position — check /queue.');
    }
    const [track] = s.queue.splice(pos, 1); // pull the target out
    s.queue.splice(1, 0, track);            // move it to play right after the current one
    s.player?.stop();                       // Idle shifts current -> target plays next
    return interaction.reply(`⏭️ Playing **${track.title}** next — the rest stays queued.`);
  }
  if (cmd === 'stop') {
    s.queue = [];
    s.player?.stop();
    s.connection?.destroy();
    guilds.delete(interaction.guildId);
    return interaction.reply('⏹️ Stopped and left.');
  }
  if (cmd === 'queue' || cmd === 'list') {
    if (!s.queue.length) return interaction.reply('Queue is empty.');
    const list = s.queue
      .map((t, i) => `${i === 0 ? '▶️' : `${i}.`} ${t.title} — *${t.requestedBy}*`)
      .join('\n');
    return interaction.reply(list.slice(0, 1900));
  }
  if (cmd === 'help') {
    return interaction.reply([
      '**🎵 Music bot commands**',
      '`/play <url or search>` — play a song or add it to the queue',
      '`/queue` or `/list` — show the queue',
      '`/next` or `/skip` — skip to the next song',
      '`/jump <number>` — jump to a queue position (see /queue)',
      '`/pause` — pause playback',
      '`/resume` — resume playback',
      '`/stop` — stop and leave the channel',
      '`/help` — show this message',
    ].join('\n'));
  }
});

client.on('error', (e) => console.error('Client error:', e.message));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e?.message || e));

client.login(process.env.TOKEN);
