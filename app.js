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
  entersState,
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
let ytCookieInstance = null;
let ytAnonymousInstance = null;

try {
  ytdlModule = require('@distube/ytdl-core');
  console.log('✅ Engine YouTube Modern (@distube/ytdl-core) berhasil dimuat!');
} catch (e) {
  console.log('ℹ️ @distube/ytdl-core belum terpasang di package.json.');
}

function getYouTubeInstance(withCookie = true) {
  if (!ytdlModule) return null;
  const rawCookie = process.env.YOUTUBE_COOKIE;
  const cookieStr = rawCookie ? parseCookieString(rawCookie) : '';

  const clientList = [
    ytdlModule.Client?.Tv || 'tv',
    ytdlModule.Client?.WebEmbedded || 'web_embedded',
    ytdlModule.Client?.Ios || 'ios',
    ytdlModule.Client?.Android || 'android',
    ytdlModule.Client?.VisionOS || 'visionos'
  ];

  if (withCookie && cookieStr) {
    if (!ytCookieInstance) {
      ytCookieInstance = new ytdlModule.Ytdl({
        cookie: cookieStr,
        clients: clientList,
        lang: 'id',
        country: 'ID'
      });
    }
    return ytCookieInstance;
  }

  if (!ytAnonymousInstance) {
    ytAnonymousInstance = new ytdlModule.Ytdl({
      clients: clientList,
      lang: 'id',
      country: 'ID'
    });
  }
  return ytAnonymousInstance;
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
    if (!fs.existsSync(ATTENDANCE_FILE)) {
      fs.writeFileSync(ATTENDANCE_FILE, JSON.stringify({}, null, 2), 'utf-8');
      return {};
    }
    const data = fs.readFileSync(ATTENDANCE_FILE, 'utf-8');
    return JSON.parse(data || '{}');
  } catch (err) {
    console.error('Gagal membaca attendance.json:', err.message);
    return {};
  }
}

function saveAttendance(data) {
  try {
    fs.writeFileSync(ATTENDANCE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Gagal menyimpan attendance.json:', err.message);
  }
}

function getWIBTime(date = new Date()) {
  const wibOffset = 7 * 60;
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const wibDate = new Date(utc + (wibOffset * 60000));

  const year = wibDate.getFullYear();
  const month = String(wibDate.getMonth() + 1).padStart(2, '0');
  const day = String(wibDate.getDate()).padStart(2, '0');
  const dateKey = `${year}-${month}-${day}`;

  const hours = String(wibDate.getHours()).padStart(2, '0');
  const minutes = String(wibDate.getMinutes()).padStart(2, '0');
  const seconds = String(wibDate.getSeconds()).padStart(2, '0');
  const timeFormatted = `${hours}:${minutes}:${seconds} WIB`;

  const namaHari = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'][wibDate.getDay()];
  const namaBulan = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
  ][wibDate.getMonth()];
  const dateFormatted = `${namaHari}, ${day} ${namaBulan} ${year}`;

  return { dateKey, timeFormatted, dateFormatted };
}

// Inisialisasi Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// --- 4. ENGINE SPOTIFY & SOUNDCLOUD FALLBACK DENGAN BYPASS BOT ---
async function searchOnlineTrack(query) {
  try {
    const spType = play.sp_validate(query);
    if (spType === 'track') {
      if (play.is_expired()) await play.refreshToken();
      const spData = await play.spotify(query);
      const searchTerms = `${spData.name} ${spData.artists.map(a => a.name).join(' ')}`;
      return await searchOnlineTrack(searchTerms);
    }
  } catch (err) {}

  // 1. ENGINE UTAMA: YOUTUBE DENGAN @distube/ytdl-core
  if (ytdlModule) {
    try {
      const searchRes = await yts(query);
      if (searchRes && searchRes.videos && searchRes.videos.length > 0) {
        const v = searchRes.videos[0];
        
        let info = null;
        let yt = getYouTubeInstance(true) || getYouTubeInstance(false);

        if (yt) {
          try {
            info = await yt.getInfo(v.url);
          } catch (cErr) {
            console.warn('[YouTube Info Warning]:', cErr.message);
            const anonYt = getYouTubeInstance(false);
            if (anonYt && anonYt !== yt) {
              try {
                info = await anonYt.getInfo(v.url);
              } catch (aErr) {}
            }
          }
        }

        if (info) {
          return {
            title: info.videoDetails?.title || v.title,
            url: v.url,
            info: info,
            duration: parseInt(info.videoDetails?.lengthSeconds, 10) || v.seconds || 0,
            type: 'online',
            sourceName: 'YouTube HD'
          };
        }
      }
    } catch (ytErr) {
      console.warn('[YouTube Modern Engine Warning]:', ytErr.message);
    }
  }

  // 2. FALLBACK KE SOUNDCLOUD
  await ensureSoundCloud();
  try {
    const scResults = await play.search(query, { limit: 5, source: { soundcloud: 'tracks' } });
    if (scResults && scResults.length > 0) {
      for (const t of scResults) {
        try {
          const durationSec = t.durationInSec || (t.durationInMs ? Math.floor(t.durationInMs / 1000) : 0);
          return {
            title: t.name || t.title,
            url: t.url,
            duration: durationSec,
            type: 'online',
            sourceName: 'SoundCloud'
          };
        } catch (streamErr) {}
      }
    }
  } catch (scErr) {
    console.warn('[SoundCloud Search Warning]:', scErr.message);
  }

  return null;
}

// Deteksi Total Durasi File Audio Lokal via FFmpeg
function getAudioDuration(filePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) return resolve(0);
    const proc = new prism.FFmpeg({
      args: ['-i', filePath, '-f', 'null', '-']
    });

    let stderrData = '';
    proc.on('data', () => {});
    proc.process.stderr.on('data', chunk => {
      stderrData += chunk.toString();
    });

    proc.on('close', () => {
      const match = stderrData.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (match) {
        const hours = parseFloat(match[1]);
        const mins = parseFloat(match[2]);
        const secs = parseFloat(match[3]);
        resolve(hours * 3600 + mins * 60 + secs);
      } else {
        resolve(0);
      }
    });

    proc.on('error', () => resolve(0));
  });
}

// --- 5. PROGRESS BAR DAN FORMAT WAKTU ---
function createProgressBar(currentSeconds, totalSeconds, barSize = 18) {
  if (!totalSeconds || totalSeconds <= 0) {
    return '🔘▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬';
  }
  const ratio = Math.min(1, Math.max(0, currentSeconds / totalSeconds));
  const progressIndex = Math.floor(ratio * (barSize - 1));

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
      progressInterval: null,
      isTransitioning: false,
      isHandlingError: false
    };

    newPlayer.on(AudioPlayerStatus.Playing, () => {
      console.log(`[Server ${guildId}] 🔊 Audio Player: Sedang memutar suara!`);
      startProgressTicker(guildId);
    });

    newPlayer.on(AudioPlayerStatus.Buffering, () => {
      console.log(`[Server ${guildId}] ⏳ Audio Player: Sedang buffering...`);
    });

    newPlayer.on(AudioPlayerStatus.Idle, () => {
      console.log(`[Server ${guildId}] Lagu selesai, lanjut ke berikutnya...`);
      stopProgressTicker(guildId);
      if (mgr.isHandlingError) return;
      if (mgr.isLoopQueue && mgr.currentTrack && mgr.currentTrack.type === 'file') {
        mgr.musicQueue.push(mgr.currentTrack);
      }
      playNextSong(guildId);
    });

    newPlayer.on('error', async error => {
      console.error(`[Server ${guildId}] ❌ Audio Error:`, error.message);
      stopProgressTicker(guildId);
      if (mgr.isHandlingError) return;
      mgr.isHandlingError = true;

      if (mgr.currentTrack && mgr.currentTrack.sourceName === 'YouTube HD') {
        console.log(`[Server ${guildId}] 🔄 YouTube stream drop, mencoba fallback otomatis ke SoundCloud...`);
        try {
          const scResult = await play.search(mgr.currentTrack.title, { limit: 3, source: { soundcloud: 'tracks' } });
          for (const t of scResult) {
            try {
              const scStream = await play.stream_from_info(t);
              if (scStream && scStream.stream) {
                console.log(`[Server ${guildId}] ✅ Berhasil beralih ke SoundCloud: "${t.name || t.title}"`);
                mgr.currentTrack.title = t.name || t.title;
                mgr.currentTrack.url = t.url;
                mgr.currentTrack.sourceName = 'SoundCloud';
                scStream.stream.on('error', err => console.warn('SoundCloud stream error:', err.message));
                const resource = createAudioResource(scStream.stream, { inputType: StreamType.Arbitrary, inlineVolume: false });
                mgr.player.play(resource);
                await sendPlayerCard(guildId, mgr.currentTrack, false);
                mgr.isHandlingError = false;
                return;
              }
            } catch (e) {}
          }
        } catch (scErr) {}
      }

      setTimeout(() => {
        mgr.isHandlingError = false;
        playNextSong(guildId);
      }, 500);
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

    connection.on(VoiceConnectionStatus.Ready, () => {
      console.log(`[Server ${guildId}] 🔊 Voice Connection READY! Mengikat audio player...`);
      connection.subscribe(mgr.player);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000)
        ]);
      } catch (e) {
        connection.destroy();
      }
    });
  }
  connection.subscribe(mgr.player);
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
    const m = parseInt(parts[0], 10);
    const s = parseInt(parts[1], 10);
    if (!isNaN(m) && !isNaN(s)) return m * 60 + s;
  } else if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const s = parseInt(parts[2], 10);
    if (!isNaN(h) && !isNaN(m) && !isNaN(s)) return h * 3600 + m * 60 + s;
  } else if (!isNaN(parseInt(timeStr, 10))) {
    return parseInt(timeStr, 10);
  }
  return null;
}

function getCurrentPlaybackSeconds(mgr) {
  if (!mgr || !mgr.currentTrack) return 0;
  if (mgr.currentTrack.pausedAt) {
    return mgr.currentTrack.seekOffset + ((mgr.currentTrack.pausedAt - mgr.currentTrack.startedAt) / 1000);
  }
  return mgr.currentTrack.seekOffset + ((Date.now() - mgr.currentTrack.startedAt) / 1000);
}

function getPlaylists() {
  if (!fs.existsSync(MUSIC_DIR)) return [];
  const entries = fs.readdirSync(MUSIC_DIR, { withFileTypes: true });
  const playlists = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const pPath = path.join(MUSIC_DIR, entry.name);
      const files = fs.readdirSync(pPath).filter(f => f.endsWith('.mp3') || f.endsWith('.wav') || f.endsWith('.ogg'));
      playlists.push({ name: entry.name, path: pPath, songs: files });
    }
  }
  return playlists;
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

  const conn = getVoiceConnection(guildId);
  if (conn) conn.subscribe(mgr.player);

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
      inputType: StreamType.Raw
    });
    mgr.player.play(resource);
  } else if (mgr.currentTrack.type === 'online') {
    try {
      if (mgr.currentTrack.sourceName === 'YouTube HD' && ytdlModule) {
        const yt = getYouTubeInstance(true) || getYouTubeInstance(false);
        const downloadTarget = mgr.currentTrack.info || mgr.currentTrack.url;
        const rawStream = yt.download(downloadTarget, {
          quality: ytdlModule.Quality.HighestAudio,
          filter: 'audioonly',
          begin: `${Math.floor(targetSeconds)}s`,
          highWaterMark: 1 << 25
        });
        rawStream.on('error', err => console.warn('Seek stream error:', err.message));
        const resource = createAudioResource(rawStream, { inputType: StreamType.Arbitrary, inlineVolume: false });
        mgr.player.play(resource);
      } else {
        const stream = await play.stream(mgr.currentTrack.url, { seek: targetSeconds });
        stream.stream.on('error', err => console.warn('Seek stream error:', err.message));
        const resource = createAudioResource(stream.stream, { inputType: StreamType.Arbitrary, inlineVolume: false });
        mgr.player.play(resource);
      }
    } catch (err) {
      console.error('Seek online error:', err.message);
    }
  }

  await sendPlayerCard(guildId, mgr.currentTrack, false);
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
    queueListText = mgr.musicQueue.slice(0, 5).map((s, idx) => `**${idx + 1}.** \`${s.title}\``).join('\n');
    if (mgr.musicQueue.length > 5) {
      queueListText += `\n_...dan ${mgr.musicQueue.length - 5} lagu lainnya._`;
    }
  }

  const loopStatus = mgr.isLoopQueue ? '🟢 AKTIF' : '⚪ NONAKTIF';
  const playerState = isPaused ? '⏸️ DIJEDA (PAUSED)' : '▶️ SEDANG MEMUTAR';
  const sourceLabel = track.sourceName || (track.type === 'file' ? 'Lokal (Server)' : 'Live Radio');

  return new EmbedBuilder()
    .setColor(isPaused ? '#FEE75C' : '#57F287')
    .setAuthor({ name: 'MUSIC PLAYER CONTROLLER' })
    .setTitle(`🎶 ${track.title}`)
    .setDescription(
      `📌 **Status:** ${playerState}\n` +
      `📡 **Sumber:** \`${sourceLabel}\`\n\n` +
      `${timeSection}\n\n` +
      `🔁 **Mode Loop Antrean:** \`${loopStatus}\`\n\n` +
      `📋 **Antrean Berikutnya:**\n${queueListText}`
    )
    .setFooter({ text: 'Gunakan tombol kontrol interaktif di bawah ini untuk mengatur lagu.' })
    .setTimestamp();
}

function buildPlayerButtons(mgr, isPaused = false) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_player_playpause').setEmoji(isPaused ? '▶️' : '⏸️').setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_player_rewind10').setLabel('-10s').setStyle(ButtonStyle.Secondary).setEmoji('⏪'),
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

  if (mgr.lastPlayerMessage) {
    try {
      await mgr.lastPlayerMessage.edit({ embeds: [embed], components: rows });
      return;
    } catch (err) {
      mgr.lastPlayerMessage = null;
    }
  }

  try {
    mgr.lastPlayerMessage = await mgr.activeTextChannel.send({ embeds: [embed], components: rows });
  } catch (err) {
    console.error(`[Server ${guildId}] Gagal kirim player card:`, err.message);
  }
}

async function playNextSong(guildId) {
  const mgr = getGuildManager(guildId);
  if (mgr.isTransitioning) return;
  mgr.isTransitioning = true;

  try {
    stopProgressTicker(guildId);

    if (mgr.musicQueue.length === 0) {
      mgr.currentTrack = null;
      if (mgr.lastPlayerMessage) {
        const finishedEmbed = new EmbedBuilder()
          .setColor('#2b2d31')
          .setTitle('⏹️ Pemutaran Selesai')
          .setDescription('Semua antrean lagu telah habis.');
        await mgr.lastPlayerMessage.edit({ embeds: [finishedEmbed], components: [] }).catch(() => {});
        mgr.lastPlayerMessage = null;
      }
      return;
    }

    mgr.currentTrack = mgr.musicQueue.shift();
    mgr.currentTrack.startedAt = Date.now();
    mgr.currentTrack.pausedAt = null;
    mgr.currentTrack.seekOffset = 0;

    // Pastikan koneksi voice tersambung ke player
    const conn = getVoiceConnection(guildId);
    if (conn) {
      conn.subscribe(mgr.player);
    }

    if (mgr.currentTrack.type === 'file') {
      if (!mgr.currentTrack.duration) {
        mgr.currentTrack.duration = await getAudioDuration(mgr.currentTrack.path);
      }
      const fileStream = fs.createReadStream(mgr.currentTrack.path);
      fileStream.on('error', err => console.warn('File stream error:', err.message));
      const resource = createAudioResource(fileStream, { inputType: StreamType.Arbitrary, inlineVolume: false });
      mgr.player.play(resource);
      await sendPlayerCard(guildId, mgr.currentTrack, false);
    } else if (mgr.currentTrack.type === 'online') {
      try {
        let rawStream = null;
        if (mgr.currentTrack.sourceName === 'YouTube HD' && ytdlModule) {
          const yt = getYouTubeInstance(true) || getYouTubeInstance(false);
          const downloadTarget = mgr.currentTrack.info || mgr.currentTrack.url;
          rawStream = yt.download(downloadTarget, {
            quality: ytdlModule.Quality.HighestAudio,
            filter: 'audioonly',
            highWaterMark: 1 << 25
          });
          rawStream.on('error', err => {
            console.warn(`[Server ${guildId}] YouTube stream chunk warning:`, err.message);
          });
        } else {
          const scData = await play.stream(mgr.currentTrack.url);
          rawStream = scData.stream;
          rawStream.on('error', err => {
            console.warn(`[Server ${guildId}] SoundCloud stream warning:`, err.message);
          });
        }

        // Gunakan StreamType.Arbitrary agar FFmpeg secara otomatis mendemux dan mengalirkan suara jernih ke Discord Voice
        const resource = createAudioResource(rawStream, {
          inputType: StreamType.Arbitrary,
          inlineVolume: false
        });

        mgr.player.play(resource);
        await sendPlayerCard(guildId, mgr.currentTrack, false);
      } catch (err) {
        console.error(`[Server ${guildId}] Error streaming online track:`, err.message);
        if (mgr.activeTextChannel) {
          mgr.activeTextChannel.send(`⚠️ Gagal memutar **${mgr.currentTrack.title}**: ${err.message}`).catch(() => {});
        }
        playNextSong(guildId);
      }
    } else if (mgr.currentTrack.type === 'stream') {
      mgr.currentTrack.duration = 0;
      fetchAudioStream(mgr.currentTrack.url, async stream => {
        stream.on('error', err => console.warn('Radio stream error:', err.message));
        const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: false });
        mgr.player.play(resource);
      });
      await sendPlayerCard(guildId, mgr.currentTrack, false);
    }
  } finally {
    setTimeout(() => {
      mgr.isTransitioning = false;
    }, 500);
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

  // Perintah Setup Verifikasi
  if (message.content === '!setup-verify') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('❌ Kamu harus memiliki izin Administrator untuk menggunakan perintah ini.');
    }
    const verifyEmbed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🛡️ Verifikasi Member Server')
      .setDescription(
        'Selamat datang di server!\n\n' +
        'Untuk mendapatkan akses penuh ke channel server, silakan klik tombol **"Verifikasi Sekarang"** di bawah ini.\n\n' +
        '⚠️ **Syarat:** Umur akun Discord kamu minimal harus **30 hari** demi keamanan komunitas.'
      )
      .setFooter({ text: 'Sistem Keamanan Otomatis' });

    const verifyRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('btn_verify')
        .setLabel('Verifikasi Sekarang')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅')
    );

    return message.channel.send({ embeds: [verifyEmbed], components: [verifyRow] });
  }

  // --- FITUR ABSENSI MEMBER PERSISTEN ---
  if (message.content === '!absen') {
    await message.delete().catch(() => {});

    const allData = loadAttendance();
    if (!allData[guildId]) allData[guildId] = {};

    const { dateKey, timeFormatted, dateFormatted } = getWIBTime();
    if (!allData[guildId][dateKey]) allData[guildId][dateKey] = [];

    const todayList = allData[guildId][dateKey];
    const existing = todayList.find(r => r.userId === message.author.id);

    if (existing) {
      const alreadyEmbed = new EmbedBuilder()
        .setColor('#FFA500')
        .setAuthor({
          name: message.author.username,
          iconURL: message.author.displayAvatarURL({ dynamic: true })
        })
        .setTitle('⚠️ Kamu Sudah Mengisi Absen Hari Ini!')
        .setDescription(
          `Halo <@${message.author.id}>, kamu sudah tercatat hadir sebelumnya:\n\n` +
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

    const sortedList = [...list].sort((a, b) => a.timestamp - b.timestamp);
    const lines = sortedList.map((r, i) => {
      return `**${i + 1}.** \`${r.time}\` • **${r.displayName}** (<@${r.userId}>)`;
    });

    const reportEmbed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle(`📋 Rekap Kehadiran Presensi: ${targetDateLabel}`)
      .setDescription(
        `Berikut daftar member yang telah absen:\n\n` +
        lines.join('\n') + '\n\n' +
        `📊 **Total Kehadiran:** \`${sortedList.length} orang\``
      )
      .setFooter({ text: `Server: ${message.guild.name}` })
      .setTimestamp();

    return message.channel.send({ embeds: [reportEmbed] });
  }

  // --- PERINTAH LIVE STREAM RADIO ---
  if (message.content.startsWith('!radio')) {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('❌ Kamu harus bergabung ke Voice Channel terlebih dahulu!');

    const args = message.content.split(' ').slice(1);
    const stationKey = args[0] ? args[0].toLowerCase() : 'lofi';
    const station = RADIO_STATIONS[stationKey];

    if (!station) {
      const list = Object.keys(RADIO_STATIONS).map(k => `• \`!radio ${k}\` : ${RADIO_STATIONS[k].name}`).join('\n');
      return message.reply(`📻 **Stasiun radio tidak ditemukan!**\n\nPilihan yang tersedia:\n${list}`);
    }

    connectVoice(message, voiceChannel);
    mgr.musicQueue = [];
    mgr.currentTrack = {
      title: station.name,
      url: station.url,
      type: 'stream',
      sourceName: 'Live Radio 24/7'
    };

    fetchAudioStream(station.url, stream => {
      stream.on('error', err => console.warn('Radio stream error:', err.message));
      const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: false });
      mgr.player.play(resource);
    });

    await sendPlayerCard(guildId, mgr.currentTrack, false);
    return message.reply(`📻 **Menghubungkan ke ${station.name}...**`);
  }

  // --- PERINTAH PLAYLIST & SINGLE TRACK LOKAL ---
  if (message.content.startsWith('!playlist')) {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('❌ Kamu harus bergabung ke Voice Channel terlebih dahulu!');

    const args = message.content.split(' ').slice(1);
    const playlists = getPlaylists();

    if (args.length === 0) {
      if (playlists.length === 0) return message.reply('📂 Belum ada folder playlist di dalam folder `Music`.');
      const list = playlists.map(p => `• 📁 **${p.name}** (${p.songs.length} lagu)`).join('\n');
      return message.reply(`📋 **Daftar Playlist Tersedia:**\n${list}\n\nKetik \`!playlist <nama_folder>\` untuk memutar!`);
    }

    const playlistName = args.join(' ').toLowerCase();
    const selected = playlists.find(p => p.name.toLowerCase() === playlistName || p.name.toLowerCase().includes(playlistName));
    if (!selected) return message.reply(`❌ Playlist **"${args.join(' ')}"** tidak ditemukan!`);
    if (selected.songs.length === 0) return message.reply(`⚠️ Playlist **${selected.name}** kosong!`);

    connectVoice(message, voiceChannel);
    mgr.musicQueue = selected.songs.map(song => ({
      title: `${song} (${selected.name})`,
      path: path.join(selected.path, song),
      type: 'file'
    }));

    message.reply(`📁 Memuat playlist **${selected.name}** (${selected.songs.length} lagu). Memulai pemutaran...`);
    playNextSong(guildId);
    return;
  }

  // --- PERINTAH PLAY (LOKAL & ONLINE DENGAN BYPASS BOT) ---
  if (message.content.startsWith('!play')) {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('❌ Kamu harus bergabung ke Voice Channel terlebih dahulu!');

    const query = message.content.substring(5).trim();
    if (!query) {
      if (mgr.player.state.status === AudioPlayerStatus.Paused) {
        if (mgr.currentTrack && mgr.currentTrack.pausedAt) {
          mgr.currentTrack.startedAt += (Date.now() - mgr.currentTrack.pausedAt);
          mgr.currentTrack.pausedAt = null;
        }
        mgr.player.unpause();
        startProgressTicker(guildId);
        if (mgr.currentTrack) sendPlayerCard(guildId, mgr.currentTrack, false);
        return message.reply('▶️ Pemutaran dilanjutkan.');
      }
      return message.reply('💡 Masukkan judul lagu atau link! Contoh: `!play Manyao Mandarin`');
    }

    // 1. CARI PLAYLIST LOKAL JIKA COCOK
    const playlists = getPlaylists();
    const playlistMatch = playlists.find(p => p.name.toLowerCase() === query.toLowerCase());
    if (playlistMatch) {
      connectVoice(message, voiceChannel);
      mgr.musicQueue = playlistMatch.songs.map(song => ({
        title: `${song} (${playlistMatch.name})`,
        path: path.join(playlistMatch.path, song),
        type: 'file'
      }));
      message.reply(`📁 Memuat playlist **${playlistMatch.name}** (${playlistMatch.songs.length} lagu).`);
      playNextSong(guildId);
      return;
    }

    // 2. CARI FILE MUSIK LOKAL
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
      return searchMsg.edit(
        `❌ Tidak ditemukan lagu yang dapat diputar untuk **"${query}"**.\n` +
        `💡 *Tips: Coba gunakan kata kunci artis/judul lain atau putar lagu lokal/radio!*`
      );
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
      text += mgr.musicQueue.map((s, idx) => `**${idx + 1}.** \`${s.title}\``).join('\n');
    }
    return message.reply(text);
  }

  if (message.content === '!shuffle') {
    if (mgr.musicQueue.length === 0) return message.reply('⚠️ Tidak ada antrean lagu untuk diacak.');
    shuffleArray(mgr.musicQueue);
    if (mgr.currentTrack) sendPlayerCard(guildId, mgr.currentTrack, false);
    return message.reply('🔀 **Antrean berhasil diacak!**');
  }

  if (message.content === '!loop') {
    mgr.isLoopQueue = !mgr.isLoopQueue;
    if (mgr.currentTrack) sendPlayerCard(guildId, mgr.currentTrack, false);
    return message.reply(`🔁 Mode Loop Antrean: **${mgr.isLoopQueue ? 'AKTIF' : 'NONAKTIF'}**`);
  }

  if (message.content.startsWith('!seek')) {
    const args = message.content.split(' ').slice(1);
    if (!args[0]) return message.reply('⚠️ Masukkan target durasi! Contoh: `!seek 1:30` atau `!seek 90`');

    const targetSeconds = parseTimeToSeconds(args[0]);
    if (targetSeconds === null) return message.reply('❌ Format waktu salah! Gunakan format `MM:SS` (contoh `!seek 2:15`)');

    if (!mgr.currentTrack) return message.reply('⚠️ Tidak ada lagu yang sedang diputar.');
    const success = await executeSeek(guildId, targetSeconds);
    if (success) {
      return message.reply(`⏩ Melompat ke **${formatTime(targetSeconds)}**.`);
    } else {
      return message.reply('❌ Fitur seek tidak didukung pada live radio.');
    }
  }

  if (message.content === '!skip') {
    if (!mgr.currentTrack) return message.reply('⚠️ Tidak ada lagu yang sedang diputar.');
    message.reply('⏭️ Melompati lagu saat ini...');
    mgr.player.stop();
    return;
  }

  if (message.content === '!pause') {
    if (mgr.player.state.status === AudioPlayerStatus.Playing) {
      mgr.player.pause();
      if (mgr.currentTrack) mgr.currentTrack.pausedAt = Date.now();
      stopProgressTicker(guildId);
      if (mgr.currentTrack) sendPlayerCard(guildId, mgr.currentTrack, true);
      return message.reply('⏸️ Musik dijeda.');
    }
    return message.reply('⚠️ Musik tidak sedang diputar.');
  }

  if (message.content === '!resume') {
    if (mgr.player.state.status === AudioPlayerStatus.Paused) {
      if (mgr.currentTrack && mgr.currentTrack.pausedAt) {
        mgr.currentTrack.startedAt += (Date.now() - mgr.currentTrack.pausedAt);
        mgr.currentTrack.pausedAt = null;
      }
      mgr.player.unpause();
      if (mgr.currentTrack) sendPlayerCard(guildId, mgr.currentTrack, false);
      startProgressTicker(guildId);
      return message.reply('▶️ Musik dilanjutkan.');
    }
    return message.reply('⚠️ Musik tidak sedang dijeda.');
  }

  if (message.content === '!stop') {
    stopProgressTicker(guildId);
    mgr.musicQueue = [];
    mgr.currentTrack = null;
    mgr.player.stop();
    if (mgr.lastPlayerMessage) {
      const stoppedEmbed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('⏹️ Pemutar Musik Dimatikan')
        .setDescription('Musik dihentikan.');
      mgr.lastPlayerMessage.edit({ embeds: [stoppedEmbed], components: [] }).catch(() => {});
      mgr.lastPlayerMessage = null;
    }
    return message.reply('⏹️ Musik dihentikan dan antrean dibersihkan.');
  }

  if (message.content === '!dc' || message.content === '!leave') {
    stopProgressTicker(guildId);
    mgr.musicQueue = [];
    mgr.currentTrack = null;
    mgr.player.stop();
    const conn = getVoiceConnection(guildId);
    if (conn) conn.destroy();
    if (mgr.lastPlayerMessage) {
      mgr.lastPlayerMessage.delete().catch(() => {});
      mgr.lastPlayerMessage = null;
    }
    guildManagers.delete(guildId);
    return message.reply('👋 Berhasil keluar dari voice channel dan mereset player.');
  }

  if (message.content === '!ping') {
    return message.reply(`🏓 Pong! Latensi Bot: **${client.ws.ping}ms**`);
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
