// --- CRASH GUARD (Mencegah bot mati saat terkena rate limit / error jaringan) ---
process.on('unhandledRejection', (reason) => {
  console.warn('⚠️ Unhandled Rejection (Auto-Prevent Crash):', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.warn('⚠️ Uncaught Exception (Auto-Prevent Crash):', err?.message || err);
});

const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

require('dotenv').config();
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const prism = require('prism-media');
const play = require('play-dl');
const yts = require('yt-search');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags
} = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType
} = require('@discordjs/voice');

// Helper untuk konversi Cookie (Mendukung Header String & Format JSON)
function parseCookieString(raw) {
  if (!raw) return '';
  raw = raw.trim();
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter(c => c && c.name && c.value)
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
      } else if (typeof parsed === 'object') {
        return Object.entries(parsed)
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');
      }
    } catch (e) {
      console.warn('⚠️ Gagal parse JSON cookie, menggunakan raw string.');
    }
  }
  return raw;
}

// Inisialisasi Engine YouTube Modern (@distube/ytdl-core)
let ytdlModule = null;
let ytInstance = null;
try {
  ytdlModule = require('@distube/ytdl-core');
  console.log('✅ Engine YouTube Modern (@distube/ytdl-core) berhasil dimuat!');
} catch (e) {
  console.log('ℹ️ @distube/ytdl-core belum terpasang di package.json.');
}

function getYouTubeInstance() {
  if (!ytdlModule) return null;
  if (!ytInstance) {
    const cookieVal = process.env.YOUTUBE_COOKIE ? parseCookieString(process.env.YOUTUBE_COOKIE) : undefined;
    ytInstance = new ytdlModule.Ytdl({
      cookie: cookieVal,
      lang: 'id',
      country: 'ID'
    });
  }
  return ytInstance;
}

// Inisialisasi SoundCloud
let scInitialized = false;
async function ensureSoundCloud() {
  if (scInitialized) return true;
  try {
    const clientID = await play.getFreeClientID();
    if (clientID) {
      await play.setToken({
        soundcloud: {
          client_id: clientID
        }
      });
      scInitialized = true;
      console.log('✅ Token SoundCloud aktif.');
      return true;
    }
  } catch (err) {
    console.warn('⚠️ Gagal memuat token SoundCloud:', err.message);
  }
  return false;
}
ensureSoundCloud();

// --- 2. WEB SERVER UNTUK HEALTHCHECK RAILWAY ---
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('🎵 Discord Multi-Server Music & Absensi Bot Online 24/7!');
}).listen(PORT, () => {
  console.log(`🚀 Web server running on port ${PORT}`);
});

// --- 3. DATABASE ABSENSI PERSISTEN (attendance.json) ---
const ATTENDANCE_FILE = path.join(__dirname, 'attendance.json');

function loadAttendance() {
  try {
    if (fs.existsSync(ATTENDANCE_FILE)) {
      return JSON.parse(fs.readFileSync(ATTENDANCE_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error saat membaca attendance.json:', err.message);
  }
  return {};
}

function saveAttendance(data) {
  try {
    fs.writeFileSync(ATTENDANCE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saat menyimpan attendance.json:', err.message);
  }
}

function getWIBTime(dateObj = new Date()) {
  const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(dateObj);
  const dateFormatted = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(dateObj);

  const rawTime = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(dateObj);
  const timeFormatted = rawTime.replace(/\./g, ':') + ' WIB';

  return { dateKey, dateFormatted, timeFormatted };
}

// --- 4. DISCORD CLIENT ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// --- 5. ENGINE PENCARIAN MUSIK ONLINE ---
async function searchOnlineTrack(query) {
  // Cek jika input adalah link Spotify
  try {
    const spCheck = await play.validate(query);
    if (spCheck === 'sp_track') {
      if (play.is_expired()) await play.refreshToken();
      const spData = await play.spotify(query);
      const searchTerms = `${spData.name} ${spData.artists.map(a => a.name).join(' ')}`;
      return await searchOnlineTrack(searchTerms);
    }
  } catch (err) {}

  // 1. ENGINE UTAMA: YOUTUBE DENGAN @distube/ytdl-core (100% BEBAS BLOKIR & KUALITAS TINGGI)
  if (ytdlModule) {
    try {
      const searchRes = await yts(query);
      if (searchRes && searchRes.videos && searchRes.videos.length > 0) {
        const v = searchRes.videos[0];
        const yt = getYouTubeInstance();
        const info = await yt.getInfo(v.url);
        const stream = yt.download(info, {
          quality: ytdlModule.Quality.HighestAudio,
          filter: { hasAudio: true, hasVideo: false }
        });

        return {
          title: info.videoDetails.title || v.title,
          url: v.url,
          duration: parseInt(info.videoDetails.lengthSeconds, 10) || v.seconds || 0,
          type: 'online',
          sourceName: 'YouTube HD',
          cachedStream: { stream, type: StreamType.Arbitrary }
        };
      }
    } catch (ytErr) {
      console.warn('[YouTube Modern Engine Warning]:', ytErr.message);
    }
  }

  // 2. FALLBACK KE SOUNDCLOUD (HANYA 1 REQUEST AGAR TIDAK KENA 429 RATE-LIMIT)
  await ensureSoundCloud();
  try {
    const scResults = await play.search(query, { limit: 1, source: { soundcloud: 'tracks' } });
    if (scResults && scResults.length > 0) {
      const t = scResults[0];
      const stream = await play.stream_from_info(t);
      if (stream && stream.stream) {
        const durationSec = t.durationInSec || (t.durationInMs ? Math.floor(t.durationInMs / 1000) : 0);
        return {
          title: t.name || t.title,
          url: t.url,
          duration: durationSec,
          type: 'online',
          sourceName: 'SoundCloud',
          cachedStream: stream
        };
      }
    }
  } catch (scErr) {
    console.warn('[SoundCloud Search Warning]:', scErr.message);
  }

  return null;
}

// Deteksi Total Durasi File Audio Lokal via FFmpeg
function getAudioDuration(filePath) {
  return new Promise(resolve => {
    if (!filePath || !fs.existsSync(filePath)) return resolve(0);
    execFile(ffmpegPath, ['-i', filePath], (err, stdout, stderr) => {
      const match = (stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(\.\d+)?)/);
      if (match) {
        const hours = parseInt(match[1], 10);
        const mins = parseInt(match[2], 10);
        const secs = parseFloat(match[3]);
        const total = Math.floor(hours * 3600 + mins * 60 + secs);
        return resolve(total);
      }
      resolve(0);
    });
  });
}

// Progress Bar Realtime
function createProgressBar(currentSec, totalSec, barSize = 16) {
  if (!totalSec || totalSec <= 0) {
    return '🔘▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ 24/7';
  }
  const clampedCurrent = Math.min(currentSec, totalSec);
  const percent = Math.min(1, Math.max(0, clampedCurrent / totalSec));
  const progressIndex = Math.min(barSize - 1, Math.floor(percent * barSize));

  let bar = '';
  for (let i = 0; i < barSize; i++) {
    if (i === progressIndex) {
      bar += '🔘';
    } else {
      bar += '▬';
    }
  }
  return bar;
}

// --- 6. SISTEM MULTI-SERVER MUSIC PLAYER ---
const guildManagers = new Map();

function getGuildManager(guildId) {
  let mgr = guildManagers.get(guildId);
  if (!mgr) {
    const newPlayer = createAudioPlayer();
    mgr = {
      player: newPlayer,
      musicQueue: [],
      currentTrack: null,
      isLoopQueue: true,
      activeTextChannel: null,
      lastPlayerMessage: null,
      progressInterval: null
    };

    newPlayer.on(AudioPlayerStatus.Idle, () => {
      console.log(`[Server ${guildId}] Lagu selesai, lanjut ke berikutnya...`);
      stopProgressTicker(guildId);
      if (mgr.isLoopQueue && mgr.currentTrack && mgr.currentTrack.type === 'file') {
        mgr.musicQueue.push(mgr.currentTrack);
      }
      playNextSong(guildId);
    });

    newPlayer.on('error', error => {
      console.error(`[Server ${guildId}] Audio Error:`, error.message);
      stopProgressTicker(guildId);
      playNextSong(guildId);
    });

    guildManagers.set(guildId, mgr);
  }
  return mgr;
}

function startProgressTicker(guildId) {
  const mgr = getGuildManager(guildId);
  stopProgressTicker(guildId);

  mgr.progressInterval = setInterval(async () => {
    if (!mgr.currentTrack || !mgr.lastPlayerMessage || !mgr.activeTextChannel) {
      stopProgressTicker(guildId);
      return;
    }

    if (mgr.player.state.status === AudioPlayerStatus.Playing) {
      try {
        const embed = buildPlayerEmbed(mgr, mgr.currentTrack, false);
        const rows = buildPlayerButtons(mgr, false);
        await mgr.lastPlayerMessage.edit({ embeds: [embed], components: rows });
      } catch (err) {
        if (err.code === 10008) {
          stopProgressTicker(guildId);
          mgr.lastPlayerMessage = null;
        }
      }
    }
  }, 5000);
}

function stopProgressTicker(guildId) {
  const mgr = guildManagers.get(guildId);
  if (mgr && mgr.progressInterval) {
    clearInterval(mgr.progressInterval);
    mgr.progressInterval = null;
  }
}

const MUSIC_DIR = path.join(__dirname, 'Music');

function connectVoice(message, voiceChannel) {
  const guildId = message.guild.id;
  const mgr = getGuildManager(guildId);
  mgr.activeTextChannel = message.channel;

  let connection = getVoiceConnection(guildId);
  if (!connection) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: true
    });
    connection.subscribe(mgr.player);
  }
  return connection;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function parseTimeToSeconds(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.trim().split(':');
  if (parts.length === 2) {
    const mins = parseInt(parts[0], 10);
    const secs = parseInt(parts[1], 10);
    if (!isNaN(mins) && !isNaN(secs)) return mins * 60 + secs;
  } else if (parts.length === 1) {
    const secs = parseInt(parts[0], 10);
    if (!isNaN(secs)) return secs;
  }
  return null;
}

function getCurrentPlaybackSeconds(mgr) {
  if (!mgr || !mgr.currentTrack || !mgr.currentTrack.startedAt) return 0;
  if (mgr.currentTrack.pausedAt) {
    const elapsed = (mgr.currentTrack.pausedAt - mgr.currentTrack.startedAt) / 1000;
    return Math.max(0, (mgr.currentTrack.seekOffset || 0) + elapsed);
  }
  const elapsed = (Date.now() - mgr.currentTrack.startedAt) / 1000;
  return Math.max(0, (mgr.currentTrack.seekOffset || 0) + elapsed);
}

function getPlaylists() {
  if (!fs.existsSync(MUSIC_DIR)) return [];
  const entries = fs.readdirSync(MUSIC_DIR, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(d => {
    const folderPath = path.join(MUSIC_DIR, d.name);
    const songs = fs.readdirSync(folderPath).filter(f => f.endsWith('.mp3') || f.endsWith('.wav') || f.endsWith('.ogg'));
    return { name: d.name, path: folderPath, songs: songs };
  });
}

function findSingleSong(query) {
  if (!fs.existsSync(MUSIC_DIR)) return null;
  const q = query.toLowerCase();
  const rootFiles = fs.readdirSync(MUSIC_DIR).filter(f => f.endsWith('.mp3') || f.endsWith('.wav') || f.endsWith('.ogg'));
  let match = rootFiles.find(f => f.toLowerCase() === q || f.toLowerCase() === `${q}.mp3` || f.toLowerCase().includes(q));
  if (match) return { title: match, path: path.join(MUSIC_DIR, match) };

  const playlists = getPlaylists();
  for (const p of playlists) {
    let pMatch = p.songs.find(f => f.toLowerCase() === q || f.toLowerCase() === `${q}.mp3` || f.toLowerCase().includes(q));
    if (pMatch) {
      return { title: `${pMatch} (${p.name})`, path: path.join(p.path, pMatch) };
    }
  }
  return null;
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

const RADIO_STATIONS = {
  lofi: { name: 'Lofi Chill Beats 24/7', url: 'https://streams.ilovemusic.de/iloveradio17.mp3' },
  prambors: { name: 'Prambors FM', url: 'https://stream.zeno.fm/fvrx452618uvv' },
  genfm: { name: 'Gen FM Jakarta', url: 'https://stream.zeno.fm/7k94r6y1m4zuv' },
  hardrock: { name: 'Hard Rock FM', url: 'https://stream.zeno.fm/u2213718v8zuv' }
};

function fetchAudioStream(url, callback) {
  const lib = url.startsWith('https') ? https : http;
  lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      return fetchAudioStream(res.headers.location, callback);
    }
    callback(res);
  }).on('error', err => console.error('Stream Error:', err.message));
}

async function executeSeek(guildId, targetSeconds) {
  const mgr = getGuildManager(guildId);
  if (!mgr || !mgr.currentTrack || mgr.currentTrack.type === 'stream') return false;

  mgr.currentTrack.seekOffset = Math.max(0, targetSeconds);
  mgr.currentTrack.startedAt = Date.now();
  mgr.currentTrack.pausedAt = null;

  if (mgr.currentTrack.type === 'file') {
    const ffmpeg = new prism.FFmpeg({
      args: [
        '-ss', String(mgr.currentTrack.seekOffset),
        '-i', mgr.currentTrack.path,
        '-analyzeduration', '0',
        '-loglevel', '0',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2'
      ]
    });

    const resource = createAudioResource(ffmpeg, {
      inputType: StreamType.Raw,
      inlineVolume: true
    });
    if (resource.volume) resource.volume.setVolume(0.8);
    mgr.player.play(resource);
  } else if (mgr.currentTrack.type === 'online') {
    try {
      const stream = await play.stream(mgr.currentTrack.url, { seek: targetSeconds });
      const resource = createAudioResource(stream.stream, {
        inputType: stream.type,
        inlineVolume: true
      });
      if (resource.volume) resource.volume.setVolume(0.8);
      mgr.player.play(resource);
    } catch (err) {
      console.error('Seek online error:', err.message);
    }
  }

  await sendPlayerCard(guildId, mgr.currentTrack, false);
  startProgressTicker(guildId);
  return true;
}

function buildPlayerEmbed(mgr, track, isPaused = false) {
  const currentSec = Math.floor(getCurrentPlaybackSeconds(mgr));
  const totalSec = track.duration || 0;
  const currentPos = formatTime(currentSec);

  let timeSection = '';
  if (totalSec > 0) {
    const totalPos = formatTime(totalSec);
    const remainingSec = Math.max(0, totalSec - currentSec);
    const remainingPos = formatTime(remainingSec);
    const percent = Math.min(100, Math.floor((currentSec / totalSec) * 100));

    timeSection =
      `⏱️ Posisi: \`${currentPos}\` / \`${totalPos}\` (Sisa: \`-${remainingPos}\`)\n` +
      `${createProgressBar(currentSec, totalSec)} \`${percent}%\``;
  } else {
    timeSection =
      `⏱️ Waktu Berputar: \`${currentPos}\` (Live Stream 24/7)\n` +
      `🔘▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ 24/7`;
  }

  let queueListText = '';
  if (mgr.musicQueue.length === 0) {
    queueListText = '_Tidak ada lagu di antrean._';
  } else {
    const previewCount = 4;
    const upcoming = mgr.musicQueue.slice(0, previewCount);
    queueListText = upcoming.map((song, idx) => `**${idx + 1}.** 🎵 \`${song.title}\``).join('\n');
    if (mgr.musicQueue.length > previewCount) {
      queueListText += `\n*...dan +${mgr.musicQueue.length - previewCount} lagu lainnya.*`;
    }
  }

  return new EmbedBuilder()
    .setColor('#5865F2')
    .setAuthor({
      name: `MUSIC PLAYER CONTROLLER ${track.sourceName ? `• ${track.sourceName}` : ''}`,
      iconURL: client.user ? client.user.displayAvatarURL() : undefined
    })
    .setTitle(`🎶 ${track.title}`)
    .setDescription(
      `${timeSection}\n\n` +
      `**Status:** ${isPaused ? '⏸️ Dijeda' : '▶️ Sedang Berputar'}\n` +
      `**Mode Loop:** ${mgr.isLoopQueue ? '🔁 Aktif (Berulang)' : '➡️ Sekali Putar'}\n\n` +
      `📋 **LAGU BERIKUTNYA (UP NEXT):**\n${queueListText}`
    )
    .setFooter({ text: 'Gunakan tombol kontrol atau ketik !seek <menit:detik>' });
}

function buildPlayerButtons(mgr, isPaused = false) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_player_rewind10').setLabel('-10s').setStyle(ButtonStyle.Secondary).setEmoji('⏪'),
    new ButtonBuilder().setCustomId('btn_player_playpause').setEmoji(isPaused ? '▶️' : '⏸️').setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_player_forward10').setLabel('+10s').setStyle(ButtonStyle.Secondary).setEmoji('⏩'),
    new ButtonBuilder().setCustomId('btn_player_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_player_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_player_shuffle').setEmoji('🔀').setLabel('Shuffle').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_player_loop').setEmoji('🔁').setLabel('Loop').setStyle(mgr.isLoopQueue ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );

  return [row1, row2];
}

async function sendPlayerCard(guildId, track, isPaused = false) {
  const mgr = getGuildManager(guildId);
  if (!mgr.activeTextChannel) return;
  const embed = buildPlayerEmbed(mgr, track, isPaused);
  const rows = buildPlayerButtons(mgr, isPaused);

  try {
    if (mgr.lastPlayerMessage) {
      await mgr.lastPlayerMessage.delete().catch(() => {});
    }
    mgr.lastPlayerMessage = await mgr.activeTextChannel.send({ embeds: [embed], components: rows });
  } catch (err) {
    console.error(`[Server ${guildId}] Gagal kirim player card:`, err.message);
  }
}

async function playNextSong(guildId) {
  const mgr = getGuildManager(guildId);
  stopProgressTicker(guildId);

  if (mgr.musicQueue.length === 0) {
    mgr.currentTrack = null;
    if (mgr.lastPlayerMessage) {
      const finishedEmbed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle('⏹️ Pemutaran Selesai')
        .setDescription('Semua antrean lagu telah habis.');
      mgr.lastPlayerMessage.edit({ embeds: [finishedEmbed], components: [] }).catch(() => {});
      mgr.lastPlayerMessage = null;
    }
    return;
  }

  mgr.currentTrack = mgr.musicQueue.shift();
  mgr.currentTrack.startedAt = Date.now();
  mgr.currentTrack.pausedAt = null;
  mgr.currentTrack.seekOffset = 0;

  if (mgr.currentTrack.type === 'file') {
    if (!mgr.currentTrack.duration) {
      mgr.currentTrack.duration = await getAudioDuration(mgr.currentTrack.path);
    }
    const resource = createAudioResource(fs.createReadStream(mgr.currentTrack.path), {
      inputType: StreamType.Arbitrary,
      inlineVolume: true
    });
    if (resource.volume) resource.volume.setVolume(0.8);
    mgr.player.play(resource);
    await sendPlayerCard(guildId, mgr.currentTrack, false);
    startProgressTicker(guildId);
  } else if (mgr.currentTrack.type === 'online') {
    try {
      let streamData = mgr.currentTrack.cachedStream;
      if (!streamData) {
        streamData = await play.stream(mgr.currentTrack.url);
      }
      mgr.currentTrack.cachedStream = null;

      const resource = createAudioResource(streamData.stream, {
        inputType: streamData.type || StreamType.Arbitrary,
        inlineVolume: true
      });
      if (resource.volume) resource.volume.setVolume(0.8);
      mgr.player.play(resource);
      await sendPlayerCard(guildId, mgr.currentTrack, false);
      startProgressTicker(guildId);
    } catch (err) {
      console.error(`[Server ${guildId}] Error streaming online track:`, err.message);
      if (mgr.activeTextChannel) {
        mgr.activeTextChannel.send(`⚠️ Gagal memutar **${mgr.currentTrack.title}**: ${err.message}`);
      }
      playNextSong(guildId);
    }
  } else if (mgr.currentTrack.type === 'stream') {
    mgr.currentTrack.duration = 0;
    fetchAudioStream(mgr.currentTrack.url, stream => {
      const resource = createAudioResource(stream, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true
      });
      if (resource.volume) resource.volume.setVolume(0.8);
      mgr.player.play(resource);
    });
    await sendPlayerCard(guildId, mgr.currentTrack, false);
    startProgressTicker(guildId);
  }
}

// --- 7. EVENT LISTENERS DISCORD ---
client.once('clientReady', () => {
  console.log(`✅ [LOGIN SUKSES] Logged in as ${client.user.tag}!`);
  console.log(`📡 Multi-Server aktif di ${client.guilds.cache.size} server.`);
});

client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  const guildId = message.guild.id;
  const mgr = getGuildManager(guildId);

  // ==========================================
  // FITUR ABSENSI MEMBER (!absen & !logabsen)
  // ==========================================
  if (message.content === '!absen') {
    await message.delete().catch(() => {});

    const { dateKey, dateFormatted, timeFormatted } = getWIBTime();
    const allData = loadAttendance();

    if (!allData[guildId]) allData[guildId] = {};
    if (!allData[guildId][dateKey]) allData[guildId][dateKey] = [];

    const todayList = allData[guildId][dateKey];
    const existing = todayList.find(item => item.userId === message.author.id);
    if (existing) {
      const alreadyEmbed = new EmbedBuilder()
        .setColor('#FEE75C')
        .setTitle('⚠️ Kamu Sudah Absen Hari Ini!')
        .setDescription(
          `Halo <@${message.author.id}>, kamu sudah tercatat absen pada:\n` +
          `📅 **Tanggal:** ${dateFormatted}\n` +
          `⏰ **Waktu:** ${existing.time}`
        )
        .setFooter({ text: 'Absensi hanya bisa dilakukan 1x per hari.' });
      return message.channel.send({ embeds: [alreadyEmbed] });
    }

    const attendanceRecord = {
      userId: message.author.id,
      displayName: message.member?.displayName || message.author.username,
      tag: message.author.tag,
      time: timeFormatted,
      timestamp: Date.now()
    };

    todayList.push(attendanceRecord);
    saveAttendance(allData);

    const successEmbed = new EmbedBuilder()
      .setColor('#57F287')
      .setAuthor({
        name: 'PRESENSI / ABSENSI BERHASIL',
        iconURL: message.author.displayAvatarURL({ dynamic: true })
      })
      .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
      .setTitle(`✅ Kehadiran Terverifikasi: ${attendanceRecord.displayName}`)
      .setDescription(
        `Terima kasih telah hadir di server hari ini!\n\n` +
        `👤 **Nama Member:** <@${message.author.id}> (\`${message.author.username}\`)\n` +
        `📅 **Tanggal:** ${dateFormatted}\n` +
        `⏰ **Waktu Hadir:** \`${timeFormatted}\`\n` +
        `📊 **Total Hadir Hari Ini:** \`${todayList.length} orang\``
      )
      .setFooter({
        text: `Sistem Presensi • Server: ${message.guild.name}`,
        iconURL: message.guild.iconURL() || undefined
      })
      .setTimestamp();

    return message.channel.send({ embeds: [successEmbed] });
  }

  if (message.content.startsWith('!logabsen')) {
    await message.delete().catch(() => {});

    const args = message.content.split(' ').slice(1);
    const subParam = args[0] ? args[0].toLowerCase() : null;
    const allData = loadAttendance();
    const guildData = allData[guildId] || {};

    let targetDateKey = null;
    let targetDateLabel = '';

    if (!subParam) {
      const nowWIB = getWIBTime();
      targetDateKey = nowWIB.dateKey;
      targetDateLabel = `Hari Ini (${nowWIB.dateFormatted})`;
    } else if (subParam === 'kemarin') {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yWIB = getWIBTime(yesterday);
      targetDateKey = yWIB.dateKey;
      targetDateLabel = `Kemarin (${yWIB.dateFormatted})`;
    } else if (subParam === 'riwayat') {
      const availableDates = Object.keys(guildData).sort().reverse();
      if (availableDates.length === 0) {
        return message.channel.send('📭 Belum ada riwayat absensi yang tersimpan di server ini.');
      }
      const historySummary = availableDates.slice(0, 7).map(d => {
        const count = guildData[d].length;
        return `• 📅 \`${d}\` ➔ **${count} member hadir**`;
      }).join('\n');

      const historyEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🗓️ Riwayat Tanggal Absensi (7 Hari Terakhir)')
        .setDescription(
          `${historySummary}\n\n` +
          `*💡 Ketik \`!logabsen YYYY-MM-DD\` (contoh: \`!logabsen 2026-11-13\`) untuk melihat rincian nama di tanggal tersebut.*`
        )
        .setFooter({ text: `Server: ${message.guild.name}` });
      return message.channel.send({ embeds: [historyEmbed] });
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(subParam)) {
      targetDateKey = subParam;
      targetDateLabel = `Tanggal ${subParam}`;
    } else {
      return message.channel.send(
        '⚠️ Format perintah tidak dikenal!\n' +
        '💡 **Contoh penggunaan:**\n' +
        '• `!logabsen` : Lihat yang hadir hari ini\n' +
        '• `!logabsen kemarin` : Lihat yang hadir kemarin\n' +
        '• `!logabsen riwayat` : Lihat ringkasan tanggal absensi\n' +
        '• `!logabsen 2026-11-13` : Lihat tanggal spesifik'
      );
    }

    const list = guildData[targetDateKey] || [];
    if (list.length === 0) {
      const emptyEmbed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle(`📋 Rekap Presensi: ${targetDateLabel}`)
        .setDescription(`Belum ada member yang melakukan absensi pada tanggal ini.\nKetik \`!absen\` untuk mencatat kehadiran!`)
        .setFooter({ text: `Server: ${message.guild.name}` });
      return message.channel.send({ embeds: [emptyEmbed] });
    }

    const attendeeLines = list.map((item, idx) => {
      return `**${idx + 1}.** <@${item.userId}> (\`${item.displayName}\`) • ⏰ \`${item.time}\``;
    });

    const logEmbed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`📋 Daftar Kehadiran: ${targetDateLabel}`)
      .setDescription(
        `Total Hadir: **${list.length} member**\n\n` +
        attendeeLines.slice(0, 30).join('\n') +
        (attendeeLines.length > 30 ? `\n*...dan ${attendeeLines.length - 30} member lainnya.*` : '')
      )
      .setFooter({
        text: `Server: ${message.guild.name} • Total: ${list.length} Orang`,
        iconURL: message.guild.iconURL() || undefined
      })
      .setTimestamp();

    return message.channel.send({ embeds: [logEmbed] });
  }

  // ==========================================
  // COMMAND: !help
  // ==========================================
  if (message.content === '!help') {
    return message.reply(
      `🎧 **PANDUAN PERINTAH BOT MUSIK & ABSENSI** 🎧\n\n` +
      `🎵 **PEMUTAR MUSIK:**\n` +
      `• \`!play <judul / link>\` : Cari & putar lagu dari YouTube / SoundCloud / Lokal\n` +
      `• \`!seek <menit:detik>\` : Lompat ke menit tertentu (contoh: \`!seek 1:30\` atau \`!seek 90\`)\n` +
      `• \`!queue\` : Lihat daftar antrean lagu saat ini\n` +
      `• \`!radio <stasiun>\` : Putar siaran radio live 24/7 (contoh: \`!radio lofi\`)\n` +
      `• \`!playlists\` : Lihat daftar folder lagu lokal di server\n\n` +
      `📋 **SISTEM ABSENSI (WIB):**\n` +
      `• \`!absen\` : Catat kehadiran kamu hari ini (chat otomatis dibersihkan)\n` +
      `• \`!logabsen\` : Lihat daftar yang sudah hadir hari ini\n` +
      `• \`!logabsen kemarin\` : Lihat daftar yang hadir kemarin\n` +
      `• \`!logabsen riwayat\` : Lihat rekap kehadiran 7 hari terakhir\n` +
      `• \`!logabsen YYYY-MM-DD\` : Lihat kehadiran pada tanggal tertentu\n\n` +
      `🛡️ **ADMIN:**\n` +
      `• \`!setup-verify\` : Pasang tombol verifikasi otomatis member baru`
    );
  }

  if (message.content.startsWith('!seek')) {
    const args = message.content.split(' ').slice(1);
    if (!args[0]) return message.reply('⚠️ Masukkan waktu tujuan! Contoh: `!seek 1:30` atau `!seek 90`');

    const targetSeconds = parseTimeToSeconds(args[0]);
    if (targetSeconds === null || targetSeconds < 0) {
      return message.reply('⚠️ Format waktu tidak valid! Gunakan format `menit:detik` (contoh: `1:30`) atau detik (`90`).');
    }

    if (!mgr.currentTrack) return message.reply('⚠️ Tidak ada lagu yang sedang diputar.');
    if (mgr.currentTrack.type === 'stream') return message.reply('⚠️ Radio stream 24/7 tidak mendukung seek/lompat waktu.');

    await executeSeek(guildId, targetSeconds);
    return message.reply(`⏩ Melompat ke menit **${formatTime(targetSeconds)}**! 🔊`);
  }

  if (message.content.startsWith('!radio')) {
    const args = message.content.split(' ').slice(1);
    const stationKey = args[0] ? args[0].toLowerCase() : null;

    if (!stationKey || !RADIO_STATIONS[stationKey]) {
      const list = Object.entries(RADIO_STATIONS).map(([k, v]) => `• \`!radio ${k}\` ➔ **${v.name}**`).join('\n');
      return message.reply(`📻 **Pilihan Channel Radio Live 24/7:**\n${list}\n\n*Contoh: Ketik \`!radio lofi\` saat berada di voice channel!*`);
    }

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) return message.reply('⚠️ Kamu harus masuk ke Voice Channel terlebih dahulu!');

    const station = RADIO_STATIONS[stationKey];
    connectVoice(message, voiceChannel);

    mgr.musicQueue = [];
    mgr.currentTrack = { title: `Siaran Radio: ${station.name}`, url: station.url, type: 'stream', duration: 0 };

    fetchAudioStream(station.url, stream => {
      const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
      if (resource.volume) resource.volume.setVolume(0.8);
      mgr.player.play(resource);
    });

    await sendPlayerCard(guildId, mgr.currentTrack, false);
    startProgressTicker(guildId);
    return;
  }

  if (message.content === '!playlists') {
    const playlists = getPlaylists();
    if (playlists.length === 0) return message.reply('📂 Belum ada folder playlist di `Music`. Ketik `!radio lofi` untuk mendengarkan radio live!');
    const list = playlists.map((p, i) => `${i + 1}. 📁 **${p.name}** — ${p.songs.length} lagu (\`!play ${p.name}\`)`).join('\n');
    return message.reply(`📂 **Daftar Playlist Tersedia:**\n${list}\n\n*Ketik \`!play <nama playlist>\` untuk memutar!*`);
  }

  // ==========================================
  // COMMAND: !play (ONLINE SEARCH + FOLDER LOCAL)
  // ==========================================
  if (message.content.startsWith('!play')) {
    const query = message.content.split(' ').slice(1).join(' ').trim();
    if (!query) {
      return message.reply('⚠️ Masukkan judul lagu atau link!\n💡 *Contoh: `!play sial mahalini` atau `!radio lofi`*');
    }

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) return message.reply('⚠️ Kamu harus masuk ke Voice Channel terlebih dahulu!');

    // 1. Cek Folder Playlist Lokal
    const playlists = getPlaylists();
    const matchedPlaylist = playlists.find(p => p.name.toLowerCase() === query.toLowerCase());
    if (matchedPlaylist) {
      if (matchedPlaylist.songs.length === 0) return message.reply(`⚠️ Playlist **${matchedPlaylist.name}** kosong.`);

      connectVoice(message, voiceChannel);
      const wasEmpty = mgr.musicQueue.length === 0 && !mgr.currentTrack;
      for (const song of matchedPlaylist.songs) {
        mgr.musicQueue.push({
          title: song,
          path: path.join(matchedPlaylist.path, song),
          type: 'file'
        });
      }

      message.reply(`📁 Berhasil memuat **${matchedPlaylist.songs.length} lagu** dari playlist **${matchedPlaylist.name}**! 🎶`);
      if (wasEmpty) {
        playNextSong(guildId);
      } else if (mgr.currentTrack) {
        sendPlayerCard(guildId, mgr.currentTrack, false);
      }
      return;
    }

    // 2. Cek File Lagu Lokal
    const singleSong = findSingleSong(query);
    if (singleSong) {
      connectVoice(message, voiceChannel);
      const wasEmpty = mgr.musicQueue.length === 0 && !mgr.currentTrack;
      mgr.musicQueue.push({ title: singleSong.title, path: singleSong.path, type: 'file' });

      if (wasEmpty) {
        playNextSong(guildId);
      } else {
        message.reply(`➕ Menambahkan **${singleSong.title}** ke antrean.`);
        if (mgr.currentTrack) sendPlayerCard(guildId, mgr.currentTrack, false);
      }
      return;
    }

    // 3. PENCARIAN ONLINE DENGAN BYPASS BOT & AUTO-FALLBACK
    const searchMsg = await message.reply(`🔍 Mencari lagu **"${query}"**...`);
    const onlineTrack = await searchOnlineTrack(query);

    if (!onlineTrack) {
      return searchMsg.edit(`❌ Tidak ditemukan lagu yang dapat diputar untuk **"${query}"**.\n💡 *Coba ketik judul lebih spesifik atau putar lagu lokal dari folder \`Music\`!*`);
    }

    connectVoice(message, voiceChannel);
    const wasEmpty = mgr.musicQueue.length === 0 && !mgr.currentTrack;
    mgr.musicQueue.push(onlineTrack);

    if (wasEmpty) {
      await searchMsg.delete().catch(() => {});
      playNextSong(guildId);
    } else {
      await searchMsg.edit(`➕ Berhasil menambahkan [**${onlineTrack.title}**] ke antrean! (Sumber: ${onlineTrack.sourceName})`);
      if (mgr.currentTrack) sendPlayerCard(guildId, mgr.currentTrack, false);
    }
    return;
  }

  if (message.content === '!queue') {
    if (!mgr.currentTrack && mgr.musicQueue.length === 0) return message.reply('📭 Antrean musik saat ini kosong.');

    let text = `🎶 **Sedang Diputar:** \`${mgr.currentTrack ? mgr.currentTrack.title : 'Tidak ada'}\`\n\n📋 **Daftar Antrean Lengkap:**\n`;
    if (mgr.musicQueue.length === 0) {
      text += '*Tidak ada lagu lagi di antrean.*';
    } else {
      text += mgr.musicQueue.slice(0, 15).map((s, i) => `${i + 1}. \`${s.title}\``).join('\n');
      if (mgr.musicQueue.length > 15) {
        text += `\n*...dan ${mgr.musicQueue.length - 15} lagu lainnya.*`;
      }
    }
    return message.reply(text);
  }

  if (message.content === '!setup-verify') {
    if (!message.member?.permissions.has('Administrator')) return message.reply('❌ Khusus Admin.');
    const embed = new EmbedBuilder()
      .setTitle('🛡️ Verifikasi Member')
      .setDescription('Selamat datang!\nKlik tombol **Verifikasi** di bawah untuk membuka akses channel.\n*Syarat: Umur akun minimal 30 hari.*')
      .setColor('#2b2d31')
      .setFooter({ text: 'Sistem Keamanan Server' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn_verify').setLabel('Verifikasi').setStyle(ButtonStyle.Success).setEmoji('✅')
    );

    return message.channel.send({ embeds: [embed], components: [row] });
  }
});

// --- 8. INTERACTION BUTTON CONTROLLER ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const guildId = interaction.guildId;
  const mgr = getGuildManager(guildId);

  // Verifikasi Member Baru
  if (interaction.customId === 'btn_verify') {
    const member = interaction.member;
    const accountAgeDays = (Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24);

    if (accountAgeDays < 30) {
      return interaction.reply({
        content: `❌ Umur akun kamu baru **${Math.floor(accountAgeDays)} hari**. Minimal 30 hari untuk dapat diverifikasi demi keamanan server.`,
        flags: MessageFlags.Ephemeral
      });
    }

    const verifiedRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === 'verified' || r.name.toLowerCase() === 'member');
    if (verifiedRole) {
      await member.roles.add(verifiedRole).catch(console.error);
      return interaction.reply({
        content: `✅ Akun kamu berusia **${Math.floor(accountAgeDays)} hari**. Verifikasi berhasil! Role **${verifiedRole.name}** telah diberikan.`,
        flags: MessageFlags.Ephemeral
      });
    } else {
      return interaction.reply({
        content: `✅ Umur akun valid (**${Math.floor(accountAgeDays)} hari**). Role "Verified" / "Member" belum dibuat di server ini oleh Admin.`,
        flags: MessageFlags.Ephemeral
      });
    }
  }

  // Tombol Player Controller
  if (interaction.customId.startsWith('btn_player_')) {
    if (!mgr.currentTrack) {
      return interaction.reply({ content: '⚠️ Tidak ada lagu yang sedang diputar saat ini.', flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId === 'btn_player_playpause') {
      if (mgr.player.state.status === AudioPlayerStatus.Playing) {
        mgr.player.pause();
        mgr.currentTrack.pausedAt = Date.now();
        stopProgressTicker(guildId);

        const embed = buildPlayerEmbed(mgr, mgr.currentTrack, true);
        const rows = buildPlayerButtons(mgr, true);
        await interaction.update({ embeds: [embed], components: rows });
      } else if (mgr.player.state.status === AudioPlayerStatus.Paused) {
        if (mgr.currentTrack.pausedAt) {
          mgr.currentTrack.startedAt += (Date.now() - mgr.currentTrack.pausedAt);
          mgr.currentTrack.pausedAt = null;
        }
        mgr.player.unpause();

        const embed = buildPlayerEmbed(mgr, mgr.currentTrack, false);
        const rows = buildPlayerButtons(mgr, false);
        await interaction.update({ embeds: [embed], components: rows });
        startProgressTicker(guildId);
      } else {
        await interaction.reply({ content: '⚠️ Status player tidak dapat diubah.', flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.customId === 'btn_player_rewind10') {
      const current = getCurrentPlaybackSeconds(mgr);
      const target = Math.max(0, current - 10);
      await executeSeek(guildId, target);
      return interaction.reply({ content: `⏪ Mundur 10 detik (sekarang: **${formatTime(target)}**).`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId === 'btn_player_forward10') {
      const current = getCurrentPlaybackSeconds(mgr);
      const target = current + 10;
      await executeSeek(guildId, target);
      return interaction.reply({ content: `⏩ Maju 10 detik (sekarang: **${formatTime(target)}**).`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId === 'btn_player_skip') {
      await interaction.reply({ content: '⏭️ Melanjutkan ke lagu berikutnya...', flags: MessageFlags.Ephemeral });
      mgr.player.stop();
      return;
    }

    if (interaction.customId === 'btn_player_shuffle') {
      shuffleArray(mgr.musicQueue);
      if (mgr.currentTrack) {
        const embed = buildPlayerEmbed(mgr, mgr.currentTrack, false);
        const rows = buildPlayerButtons(mgr, false);
        await interaction.update({ embeds: [embed], components: rows });
      }
      return interaction.reply({ content: '🔀 **Antrean di server ini berhasil diacak!**', flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId === 'btn_player_loop') {
      mgr.isLoopQueue = !mgr.isLoopQueue;
      if (mgr.currentTrack) {
        const embed = buildPlayerEmbed(mgr, mgr.currentTrack, false);
        const rows = buildPlayerButtons(mgr, false);
        await interaction.update({ embeds: [embed], components: rows });
      }
      return interaction.reply({ content: `🔁 Mode Loop di server ini: **${mgr.isLoopQueue ? 'AKTIF' : 'NONAKTIF'}**`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId === 'btn_player_stop') {
      stopProgressTicker(guildId);
      mgr.musicQueue = [];
      mgr.currentTrack = null;
      mgr.player.stop();
      const conn = getVoiceConnection(guildId);
      if (conn) conn.destroy();

      const stoppedEmbed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('⏹️ Pemutar Musik Dimatikan')
        .setDescription(`Musik dihentikan oleh **${interaction.user.username}**.`);

      await interaction.update({ embeds: [stoppedEmbed], components: [] });
      mgr.lastPlayerMessage = null;
      guildManagers.delete(guildId);
      return;
    }
  }
});

// --- 9. LOGIN BOT ---
console.log('🤖 Menghubungkan bot ke Discord...');
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ GAGAL LOGIN KE DISCORD! Periksa DISCORD_TOKEN atau Privileged Intents:', err.message);
});
