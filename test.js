// Self-checks for bot.js helpers. `npm test` (offline) or `node test.js --live` (also asks YouTube).
// Loading bot.js does not start the bot; it only reads playlists/settings (never writes them).
const assert = require('node:assert/strict');
const bot = require('./bot.js');

const {
  parseNumberList, fmtDuration, normName, resolvePlaylistName, ytdlpReason, fitLines,
  nowPlayingEmbed, md, playlists, commands, resolveTracks, wantsPlaylist,
} = bot;

(async () => {
  // Which links queue a whole playlist
  const pl = (u) => wantsPlaylist(new URL(u));
  assert.equal(pl('https://www.youtube.com/playlist?list=PLabc'), true);
  assert.equal(pl('https://www.youtube.com/watch?v=abc&list=PLabc'), true, 'a song opened inside a playlist queues the playlist');
  assert.equal(pl('https://youtu.be/abc?list=PLabc'), true);
  assert.equal(pl('https://music.youtube.com/watch?v=abc&list=OLAK5uy_abc'), true);
  assert.equal(pl('https://www.youtube.com/watch?v=abc&list=RDabc'), false, 'Mixes are endless');
  assert.equal(pl('https://www.youtube.com/watch?v=abc&list=WL'), false);
  assert.equal(pl('https://www.youtube.com/watch?v=abc'), false);
  assert.equal(pl('https://www.youtube.com/watch?v=abc&list='), false);
  assert.equal(pl('https://www.youtube.com/shorts/abc'), false);
  assert.equal(pl('https://www.youtube.com/watch?v=abc&t=42s&si=xyz'), false);

  // parseNumberList
  assert.deepEqual(parseNumberList('2,3,5'), [2, 3, 5]);
  assert.deepEqual(parseNumberList('2 2  3'), [2, 3]);
  assert.deepEqual(parseNumberList('a,1,-2,3x,4'), [1, 4]);
  assert.deepEqual(parseNumberList(''), []);

  // fmtDuration
  assert.equal(fmtDuration(798), '13:18');
  assert.equal(fmtDuration(3661), '1:01:01');
  assert.equal(fmtDuration(5), '0:05');
  for (const v of [0, 'NA', null, undefined]) assert.equal(fmtDuration(v), null);

  // normName
  assert.equal(normName('  My   Rock '), 'my rock');
  assert.equal(normName('Șțăî'), 'șțăî');

  // resolvePlaylistName: own properties only, numbers are positions, legacy names still found
  const G = 'test-guild';
  playlists[G] = { 'road trip': [{}], rock: [{}], 'old  spaced': [{}] };
  try {
    assert.equal(resolvePlaylistName(G, 'Road   Trip'), 'road trip');
    assert.equal(resolvePlaylistName(G, '1'), 'road trip');
    assert.equal(resolvePlaylistName(G, '2'), 'rock');
    assert.equal(resolvePlaylistName(G, '9'), null);
    assert.equal(resolvePlaylistName(G, 'old  spaced'), 'old  spaced');
    for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '']) {
      assert.equal(resolvePlaylistName(G, bad), null, bad);
    }
    assert.equal(resolvePlaylistName('no-such-guild', 'rock'), null);
  } finally { delete playlists[G]; }

  // ytdlpReason: first sentence, no URLs
  assert.equal(ytdlpReason('ERROR: [youtube] aaaaaaaaaaa: Video unavailable. This video has been removed'), 'Video unavailable');
  assert.equal(ytdlpReason('WARNING: x\nERROR: [youtube] 07FYdnEawAQ: Sign in to confirm your age. Use --cookies https://x.y/z'), 'Sign in to confirm your age');
  assert.equal(ytdlpReason('ERROR: Unable to download https://rr1.googlevideo.com/abc?ip=1.2.3.4 now'), 'Unable to download  now');
  assert.equal(ytdlpReason('no error here'), '');

  // fitLines never exceeds Discord's 2000-char limit and says what it left out
  const many = Array.from({ length: 500 }, (_, i) => `${i + 1}. a fairly long song title number ${i}`);
  const fitted = fitLines(many, '**Queue**');
  assert.ok(fitted.length <= 2000, `fitLines length ${fitted.length}`);
  assert.match(fitted, /…and \d+ more$/);
  assert.equal(fitLines(['a', 'b'], 'H'), 'H\na\nb');

  // nowPlayingEmbed survives hostile input
  const e = nowPlayingEmbed({ title: 'x'.repeat(300), url: 'not a url', thumbnail: 'nope', requestedBy: 'cool_guy_' }).toJSON();
  assert.equal(e.title.length, 256);
  assert.equal(e.url, undefined);
  assert.equal(e.thumbnail, undefined);

  // markdown in titles is escaped for message text
  assert.equal(md('*bold* _it_'), '\\*bold\\* \\_it\\_');

  // Only YouTube links reach yt-dlp (no LAN / arbitrary-site fetches)
  for (const bad of ['http://192.168.1.1/', 'https://www.youtube.com@192.168.1.1/', 'https://evil.com/?youtube.com', 'http://localhost:8080/x']) {
    await assert.rejects(resolveTracks(bad), (err) => err.userFacing && /Only YouTube links/.test(err.message), bad);
  }

  // Slash command definitions
  const names = commands.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'duplicate command names');
  const admin = ['deleteplaylist', 'deleteallplaylists', 'setchannel', 'resetchannel', 'createchannel', 'autodelete'];
  for (const n of admin) assert.ok(commands.find((c) => c.name === n).default_member_permissions, `${n} must be admin-only`);
  for (const c of commands) assert.ok(c.description.length <= 100, `${c.name} description too long`);

  if (process.argv.includes('--live')) {
    // Real lookups (a few YouTube requests): search works and non-Latin titles survive the pipe.
    const [search] = await resolveTracks('lofi hip hop');
    assert.match(search.url, /^https:\/\/www\.youtube\.com\/watch\?v=/);
    const [hit] = await resolveTracks('https://www.youtube.com/watch?v=9bZkp7q19f0'); // title contains 강남스타일
    assert.match(hit.title, /강남스타일/, `Korean title lost: ${hit.title}`);
    const mix = await resolveTracks('https://www.youtube.com/watch?v=HI6gMkfRjE0&list=RDHI6gMkfRjE0');
    assert.equal(mix.length, 1, 'a Mix link must queue just the song');
    console.log('live checks passed:', hit.title);
  }

  console.log('all checks passed');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
