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
const os = require('os');
const net = require('net');
const { execFile, spawn } = require('child_process');
const { PassThrough } = require('stream');
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
  MessageFlags,
  PermissionFlagsBits
} = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  entersState,
  demuxProbe, // FIX: sebelumnya dipakai di !radio tapi tidak di-import
  generateDependencyReport,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType
} = require('@discordjs/voice');

// FIX: Tampilkan laporan dependency voice saat start.
// Jika baris "Opus Libraries", "Encryption Libraries", atau "DAVE Protocol Libraries"
// berisi "not found", bot TIDAK akan mengeluarkan suara.
console.log('🔎 Voice Dependency Report:\n' + generateDependencyReport());

// --- Helper Cookie YouTube (Header String / JSON) -> array cookie untuk ytdl.createAgent ---
function parseCookieArray(raw) {
  if (!raw) return [];
  raw = raw.trim();
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(c => c && c.name && c.value !== undefined);
      }
      if (parsed && typeof parsed === 'object') {
        return Object.entries(parsed).map(([name, value]) => ({ name, value: String(value), domain: '.youtube.com' }));
      }
    } catch (e) {
      console.warn('⚠️ Gagal parse JSON cookie, mencoba format header string.');
    }
  }
  return raw
    .split(';')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      const i = p.indexOf('=');
      if (i <= 0) return null;
      return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: '.youtube.com' };
    })
    .filter(Boolean);
}

// --- Engine YouTube (@distube/ytdl-core) ---
// FIX: Kode lama memakai API `new ytdl.Ytdl()`, `ytdl.Client.Tv`, `ytdl.Quality.HighestAudio`
// yang TIDAK ADA di @distube/ytdl-core, sehingga YouTube selalu gagal diam-diam.
let ytdl = null;
try {
  const ytdlMod = require('@distube/ytdl-core');
  // v5 berformat ESM: require() mengembalikan namespace, fungsi utamanya ada di .default
  ytdl = typeof ytdlMod === 'function' ? ytdlMod : ytdlMod.default;
  if (typeof ytdl !== 'function' || typeof ytdl.getInfo !== 'function') {
    throw new Error('API @distube/ytdl-core tidak dikenali (pakai versi 4.x)');
  }
  console.log('✅ Engine YouTube (@distube/ytdl-core) berhasil dimuat!');
} catch (e) {
  ytdl = null;
  console.log('ℹ️ YouTube dinonaktifkan (fallback SoundCloud):', e.message);
}

let ytAgent = null; // null = belum dibuat, false = tanpa cookie
function getYtAgent() {
  if (!ytdl) return undefined;
  if (ytAgent !== null) return ytAgent || undefined;
  const cookies = parseCookieArray(process.env.YOUTUBE_COOKIE);
  try {
    ytAgent = cookies.length ? ytdl.createAgent(cookies) : false;
    if (ytAgent) console.log(`🍪 YouTube agent dengan ${cookies.length} cookie aktif.`);
  } catch (e) {
    console.warn('⚠️ Gagal membuat YouTube agent dari cookie:', e.message);
    ytAgent = false;
  }
  return ytAgent || undefined;
}

async function getYouTubeInfo(url) {
  const agent = getYtAgent();
  if (agent) {
    try {
      return await ytdl.getInfo(url, { agent });
    } catch (e) {
      console.warn('[YouTube Cookie Info Warning]:', e.message);
    }
  }
  try {
    return await ytdl.getInfo(url);
  } catch (e) {
    console.warn('[YouTube Anonymous Info Warning]:', e.message);
    throw e;
  }
}

function createYouTubeStream(url) {
  const agent = getYtAgent();
  // ytdl(url) mengambil info baru saat diputar, jadi URL format tidak kedaluwarsa walau lama di antrean
  return ytdl(url, {
    filter: 'audioonly',
    quality: 'highestaudio',
    highWaterMark: 1 << 25,
    dlChunkSize: 0,
    ...(agent ? { agent } : {})
  });
}

// ==========================================================
// ENGINE UTAMA: yt-dlp (paling aktif di-update, tahan perubahan YouTube)
// Binary standalone diunduh otomatis dari rilis resmi GitHub yt-dlp ke folder ./bin
// Bisa di-override dengan env YTDLP_PATH jika yt-dlp sudah terpasang di sistem.
// ==========================================================
const BIN_DIR = path.join(__dirname, 'bin');
const YTDLP_ASSET =
  process.platform === 'win32' ? 'yt-dlp.exe'
  : process.platform === 'darwin' ? 'yt-dlp_macos'
  : process.arch === 'arm64' ? 'yt-dlp_linux_aarch64'
  : 'yt-dlp_linux';
const YTDLP_BIN = process.env.YTDLP_PATH || path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const YTDLP_SOURCE = 'YouTube (yt-dlp)';

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('Terlalu banyak redirect'));
    https.get(url, { headers: { 'User-Agent': 'discord-music-bot' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadFile(new URL(res.headers.location, url).toString(), dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        fs.renameSync(tmp, dest);
        resolve();
      }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

let ytdlpReady = null;
function ensureYtDlp() {
  if (!ytdlpReady) {
    ytdlpReady = (async () => {
      if (!fs.existsSync(YTDLP_BIN)) {
        if (process.env.YTDLP_PATH) throw new Error(`YTDLP_PATH tidak ditemukan: ${YTDLP_BIN}`);
        fs.mkdirSync(BIN_DIR, { recursive: true });
        console.log(`⬇️ Mengunduh yt-dlp (${YTDLP_ASSET})...`);
        await downloadFile(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`, YTDLP_BIN);
        if (process.platform !== 'win32') fs.chmodSync(YTDLP_BIN, 0o755);
      }
      const version = await new Promise((resolve, reject) => {
        execFile(YTDLP_BIN, ['--version'], { timeout: 30000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
      });
      console.log(`✅ yt-dlp siap (versi ${version}).`);
      return true;
    })().catch(err => {
      console.warn('⚠️ Gagal menyiapkan yt-dlp:', err.message);
      ytdlpReady = null; // coba lagi di permintaan berikutnya
      return false;
    });
  }
  return ytdlpReady;
}
ensureYtDlp();

// ==========================================================
// CLOUDFLARE WARP (PROXY GRATIS)
// wgcf      -> mendaftar akun WARP gratis & membuat profil WireGuard
// wireproxy -> menjalankan WireGuard tanpa root sebagai proxy SOCKS5 lokal
// yt-dlp lalu diarahkan lewat socks5://127.0.0.1:40000 agar YouTube tidak melihat IP Railway.
// Aktif otomatis. Matikan dengan env USE_WARP=false. Dilewati jika YTDLP_PROXY diisi.
// ==========================================================
const WARP_DIR = path.join(BIN_DIR, 'warp');
const WARP_SOCKS_PORT = parseInt(process.env.WARP_PORT, 10) || 40000;
const WGCF_VERSION = '2.3.1';
const WIREPROXY_VERSION = '1.1.3';
const GO_OS = process.platform === 'win32' ? 'windows' : process.platform; // linux / darwin / windows
const GO_ARCH = { x64: 'amd64', arm64: 'arm64', ia32: '386' }[process.arch] || process.arch;
const EXE = process.platform === 'win32' ? '.exe' : '';
const WGCF_BIN = path.join(WARP_DIR, 'wgcf' + EXE);
const WIREPROXY_BIN = path.join(WARP_DIR, 'wireproxy' + EXE);
const WARP_ENABLED = !process.env.YTDLP_PROXY && !/^(0|false|no|off)$/i.test(process.env.USE_WARP || '');

let warpProxyUrl = null;
let warpReady = null;
let wireproxyProc = null;

function runCmd(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 60000, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(lastErrorLine(stderr) || lastErrorLine(stdout) || err.message));
      resolve(stdout);
    });
  });
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) return reject(new Error(`port ${port} tidak terbuka`));
        setTimeout(tryConnect, 500);
      });
    };
    tryConnect();
  });
}

async function startWireproxy(configPath) {
  const proc = spawn(WIREPROXY_BIN, ['-c', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  wireproxyProc = proc;
  let logText = '';
  const collect = d => {
    logText = (logText + d).slice(-4000);
  };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);
  proc.on('error', err => console.warn('[WARP] wireproxy gagal dijalankan:', err.message));
  proc.on('close', code => {
    if (wireproxyProc !== proc) return;
    wireproxyProc = null;
    warpProxyUrl = null;
    console.warn(`[WARP] wireproxy berhenti (kode ${code}): ${lastErrorLine(logText)}. Restart dalam 10 detik...`);
    setTimeout(() => {
      startWireproxy(configPath).catch(e => console.warn('[WARP] Restart gagal:', e.message));
    }, 10000);
  });

  await waitForPort(WARP_SOCKS_PORT, 20000);
  warpProxyUrl = `socks5://127.0.0.1:${WARP_SOCKS_PORT}`;
}

function ensureWarp() {
  if (!WARP_ENABLED) return Promise.resolve(false);
  if (!warpReady) {
    warpReady = (async () => {
      fs.mkdirSync(WARP_DIR, { recursive: true });

      if (!fs.existsSync(WGCF_BIN)) {
        console.log('⬇️ [WARP] Mengunduh wgcf...');
        await downloadFile(
          `https://github.com/ViRb3/wgcf/releases/download/v${WGCF_VERSION}/wgcf_${WGCF_VERSION}_${GO_OS}_${GO_ARCH}${EXE}`,
          WGCF_BIN
        );
        if (!EXE) fs.chmodSync(WGCF_BIN, 0o755);
      }

      if (!fs.existsSync(WIREPROXY_BIN)) {
        console.log('⬇️ [WARP] Mengunduh wireproxy...');
        const tgz = path.join(WARP_DIR, 'wireproxy.tar.gz');
        await downloadFile(
          `https://github.com/windtf/wireproxy/releases/download/v${WIREPROXY_VERSION}/wireproxy_${GO_OS}_${GO_ARCH}.tar.gz`,
          tgz
        );
        await runCmd('tar', ['-xzf', tgz, '-C', WARP_DIR]);
        fs.unlinkSync(tgz);
        if (!fs.existsSync(WIREPROXY_BIN)) throw new Error('binary wireproxy tidak ditemukan setelah ekstrak');
        if (!EXE) fs.chmodSync(WIREPROXY_BIN, 0o755);
      }

      // Daftar akun WARP gratis (sekali per container) & buat profil WireGuard
      const accountFile = path.join(WARP_DIR, 'wgcf-account.toml');
      const profileFile = path.join(WARP_DIR, 'wgcf-profile.conf');
      if (!fs.existsSync(accountFile)) {
        console.log('📝 [WARP] Mendaftarkan akun WARP gratis...');
        await runCmd(WGCF_BIN, ['register', '--accept-tos'], { cwd: WARP_DIR });
      }
      if (!fs.existsSync(profileFile)) {
        await runCmd(WGCF_BIN, ['generate'], { cwd: WARP_DIR });
      }

      const wireproxyConf = path.join(WARP_DIR, 'wireproxy.conf');
      fs.writeFileSync(
        wireproxyConf,
        `WGConfig = ${profileFile.replace(/\\/g, '/')}\n\n[Socks5]\nBindAddress = 127.0.0.1:${WARP_SOCKS_PORT}\n`,
        'utf8'
      );

      await startWireproxy(wireproxyConf);
      console.log(`✅ [WARP] Cloudflare WARP aktif di ${warpProxyUrl}, yt-dlp memakai IP Cloudflare.`);
      return true;
    })().catch(err => {
      console.warn('⚠️ [WARP] Gagal menyiapkan WARP, yt-dlp memakai koneksi langsung:', err.message);
      if (wireproxyProc) {
        const p = wireproxyProc;
        wireproxyProc = null;
        p.kill();
      }
      setTimeout(() => {
        warpReady = null; // coba lagi 5 menit kemudian
      }, 5 * 60 * 1000);
      return false;
    });
  }
  return warpReady;
}
ensureWarp();

process.on('exit', () => {
  if (wireproxyProc) wireproxyProc.kill();
});

// Konversi YOUTUBE_COOKIE -> file cookie format Netscape untuk yt-dlp
let ytDlpCookieFile; // undefined = belum dibuat, null = tidak ada cookie
function getYtDlpCookieFile() {
  if (ytDlpCookieFile !== undefined) return ytDlpCookieFile;
  const cookies = parseCookieArray(process.env.YOUTUBE_COOKIE);
  if (!cookies.length) return (ytDlpCookieFile = null);
  const defaultExp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const domain = c.domain || '.youtube.com';
    const exp = Number(c.expirationDate ?? c.expires);
    lines.push([
      domain,
      domain.startsWith('.') ? 'TRUE' : 'FALSE',
      c.path || '/',
      c.secure === false ? 'FALSE' : 'TRUE',
      Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : defaultExp,
      c.name,
      c.value
    ].join('\t'));
  }
  const file = path.join(os.tmpdir(), 'yt-cookies.txt');
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  console.log(`🍪 yt-dlp memakai ${cookies.length} cookie YouTube.`);
  return (ytDlpCookieFile = file);
}

function ytDlpBaseArgs() {
  // yt-dlp butuh JS runtime untuk memecahkan proteksi YouTube; pakai Node yang sedang menjalankan bot
  const args = ['--no-playlist', '--no-warnings', '--js-runtimes', `node:${process.execPath}`];
  const cookieFile = getYtDlpCookieFile();
  if (cookieFile) args.push('--cookies', cookieFile);
  // Opsional: proxy residensial agar IP server tidak ditandai bot oleh YouTube
  // contoh: http://user:pass@host:port atau socks5://user:pass@host:port
  // Jika tidak diisi, otomatis memakai Cloudflare WARP (jika aktif)
  const proxy = process.env.YTDLP_PROXY || warpProxyUrl;
  if (proxy) args.push('--proxy', proxy);
  return args;
}

function lastErrorLine(text) {
  const lines = String(text || '').trim().split('\n').filter(Boolean);
  return (lines.filter(l => l.includes('ERROR')).pop() || lines.pop() || '').replace(/^ERROR:\s*/, '').trim();
}

function runYtDlpJson(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP_BIN, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error(lastErrorLine(stderr) || err.message));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error('Output yt-dlp tidak valid'));
      }
    });
  });
}

const YTDLP_SC_SOURCE = 'SoundCloud (yt-dlp)';

// --- Cooldown YouTube ---
// Saat YouTube menandai IP server sebagai bot, terus-menerus mencoba justru membuat blokir makin lama.
// Jadi YouTube dijeda sementara dan bot langsung memakai SoundCloud.
const YT_BLOCK_COOLDOWN_MS = (parseInt(process.env.YT_COOLDOWN_MINUTES, 10) || 15) * 60 * 1000;
let ytBlockedUntil = 0;

function isYouTubeBlocked() {
  return Date.now() < ytBlockedUntil;
}

function markYouTubeBlockedIfNeeded(message) {
  if (/confirm you.?re not a bot|sign in to confirm|HTTP Error 429|too many requests/i.test(String(message))) {
    ytBlockedUntil = Date.now() + YT_BLOCK_COOLDOWN_MS;
    console.warn(`⛔ YouTube mendeteksi bot. YouTube dijeda ${YT_BLOCK_COOLDOWN_MS / 60000} menit, memakai SoundCloud.`);
    return true;
  }
  return false;
}

function ytBlockedRemainingText() {
  return `${Math.ceil((ytBlockedUntil - Date.now()) / 60000)} menit`;
}

function isPreviewOnly(entry) {
  // Lagu SoundCloud Go+ hanya memberi cuplikan 30 detik
  const fmt = String(entry.format_id || entry.format || '');
  return /preview|snipped/i.test(fmt);
}

async function searchYtDlp(query, { prefix = 'ytsearch1', sourceName = YTDLP_SOURCE } = {}) {
  const isUrl = /^https?:\/\//i.test(query);
  const target = isUrl ? query : `${prefix}:${query}`;
  // -J dengan -f memastikan format audio benar-benar bisa diputar (bukan hanya hasil pencarian)
  const data = await runYtDlpJson([...ytDlpBaseArgs(), '-f', 'bestaudio/best', '-J', target]);
  const entries = Array.isArray(data.entries) ? data.entries.filter(Boolean) : [data];
  const entry = entries.find(e => !isPreviewOnly(e)) || entries[0];
  if (!entry) throw new Error('Tidak ada hasil');
  return {
    title: entry.title || query,
    url: entry.webpage_url || entry.original_url || `https://www.youtube.com/watch?v=${entry.id}`,
    duration: Math.floor(entry.duration || 0),
    type: 'online',
    sourceName
  };
}

// onFail(pesanError) dipanggil jika yt-dlp gagal SEBELUM mengirim audio sama sekali.
// Dipanggil sebelum stream ditutup, sehingga event Idle bisa ditahan untuk fallback.
function createYtDlpStream(url, { onFail } = {}) {
  const out = new PassThrough({ highWaterMark: 1 << 25 });
  const proc = spawn(YTDLP_BIN, [...ytDlpBaseArgs(), '-f', 'bestaudio/best', '--quiet', '-o', '-', url], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let errText = '';
  let gotData = false;
  proc.stderr.on('data', d => {
    errText = (errText + d).slice(-4000);
  });
  proc.stdout.once('data', () => {
    gotData = true;
  });
  proc.stdout.pipe(out, { end: false });
  proc.on('error', err => {
    errText += `\n${err.message}`;
    console.warn('[yt-dlp] gagal dijalankan:', err.message);
  });
  proc.on('close', code => {
    if (code) {
      const msg = lastErrorLine(errText) || `kode keluar ${code}`;
      console.warn(`[yt-dlp] keluar dengan kode ${code}:`, msg);
      if (!gotData && onFail) {
        try {
          onFail(msg);
        } catch (e) {}
      }
    }
    out.end();
  });
  // Saat lagu di-skip/stop, stream ditutup -> matikan proses yt-dlp
  out.on('close', () => {
    if (proc.exitCode === null) proc.kill();
  });
  return out;
}

// Membungkus stream apa pun dengan FFmpeg + seek (-ss), output PCM mentah untuk Discord
function createSeekedResource(inputStream, seconds) {
  const transcoder = new prism.FFmpeg({
    args: [
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-ss', String(Math.max(0, Math.floor(seconds))),
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2'
    ]
  });
  inputStream.on('error', err => console.warn('Seek input stream error:', err.message));
  transcoder.on('error', err => console.warn('Seek ffmpeg error:', err.message));
  return createAudioResource(inputStream.pipe(transcoder), { inputType: StreamType.Raw });
}

// Inisialisasi SoundCloud
let scInitialized = false;
async function ensureSoundCloud() {
  if (scInitialized) return true;
  try {
    const clientID = await play.getFreeClientID();
    if (clientID) {
      await play.setToken({ soundcloud: { client_id: clientID } });
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

// --- 5. ENGINE PENCARIAN MUSIK ONLINE (YOUTUBE + SOUNDCLOUD FALLBACK) ---
// `errors` diisi alasan kegagalan tiap engine agar bisa ditampilkan ke user
async function searchOnlineTrack(query, errors = []) {
  // Cek jika input adalah link Spotify
  try {
    const spCheck = await play.validate(query);
    if (spCheck === 'sp_track') {
      if (play.is_expired()) await play.refreshToken();
      const spData = await play.spotify(query);
      const searchTerms = `${spData.name} ${spData.artists.map(a => a.name).join(' ')}`;
      return await searchOnlineTrack(searchTerms, errors);
    }
  } catch (err) {}

  const hasYtDlp = await ensureYtDlp();
  await ensureWarp(); // tunggu WARP siap (jika aktif) agar request pertama sudah lewat proxy
  if (hasYtDlp) {
    const isUrl = /^https?:\/\//i.test(query);
    const isSoundCloudUrl = isUrl && /soundcloud\.com/i.test(query);

    // 1. YouTube via yt-dlp (dilewati jika sedang cooldown)
    if (!isSoundCloudUrl) {
      if (isYouTubeBlocked()) {
        errors.push(`YouTube: dijeda ${ytBlockedRemainingText()} lagi karena terdeteksi bot`);
      } else {
        try {
          return await searchYtDlp(query, { prefix: 'ytsearch1', sourceName: YTDLP_SOURCE });
        } catch (e) {
          console.warn('[yt-dlp YouTube Warning]:', e.message);
          markYouTubeBlockedIfNeeded(e.message);
          errors.push(`YouTube: ${e.message}`);
        }
      }
    }

    // 2. SoundCloud via yt-dlp (mendukung stream HLS, tidak kena 404 seperti play-dl)
    if (!isUrl || isSoundCloudUrl) {
      try {
        return await searchYtDlp(query, { prefix: 'scsearch3', sourceName: YTDLP_SC_SOURCE });
      } catch (e) {
        console.warn('[yt-dlp SoundCloud Warning]:', e.message);
        errors.push(`SoundCloud: ${e.message}`);
      }
    }

    // yt-dlp tersedia: ytdl-core & play-dl tidak dicoba lagi
    // (keduanya sudah usang dan hanya menambah request yang memperparah blokir)
    return null;
  }

  errors.push('yt-dlp: binary gagal diunduh/dijalankan (lihat log)');

  // 3. CADANGAN TERAKHIR (hanya jika yt-dlp tidak tersedia): @distube/ytdl-core
  if (ytdl) {
    try {
      let videoUrl = null;
      let fallbackTitle = query;
      let fallbackSeconds = 0;

      if (ytdl.validateURL(query)) {
        videoUrl = query;
      } else {
        const searchRes = await yts(query);
        const v = searchRes?.videos?.[0];
        if (v) {
          videoUrl = v.url;
          fallbackTitle = v.title;
          fallbackSeconds = v.seconds || 0;
        }
      }

      if (videoUrl) {
        const info = await getYouTubeInfo(videoUrl);
        if (info) {
          return {
            title: info.videoDetails?.title || fallbackTitle,
            url: videoUrl,
            duration: parseInt(info.videoDetails?.lengthSeconds, 10) || fallbackSeconds,
            type: 'online',
            sourceName: 'YouTube HD'
          };
        }
      }
      errors.push('ytdl-core: video tidak ditemukan');
    } catch (ytErr) {
      console.warn('[YouTube Engine Warning]:', ytErr.message);
      errors.push(`ytdl-core: ${ytErr.message}`);
    }
  }

  // 3. FALLBACK KE SOUNDCLOUD (validasi stream agar tidak terkena Go+ 404)
  if (!(await ensureSoundCloud())) {
    errors.push('SoundCloud: gagal mendapatkan client ID');
    return null;
  }
  try {
    const scResults = await play.search(query, { limit: 5, source: { soundcloud: 'tracks' } });
    if (!scResults || scResults.length === 0) errors.push('SoundCloud: tidak ada hasil');
    let lastScError = null;
    for (const t of scResults || []) {
      const testStream = await play.stream(t.url).catch(e => {
        lastScError = e;
        return null;
      });
      if (!testStream || !testStream.stream) continue;
      // Tutup stream tes; stream baru dibuat saat lagu benar-benar diputar
      testStream.stream.destroy?.();

      const durationSec = t.durationInSec || (t.durationInMs ? Math.floor(t.durationInMs / 1000) : 0);
      return {
        title: t.name || t.title,
        url: t.url,
        duration: durationSec,
        type: 'online',
        sourceName: 'SoundCloud'
      };
    }
    if (scResults && scResults.length > 0) {
      const reason = lastScError ? lastScError.message : 'stream kosong';
      console.warn(`[SoundCloud Stream Warning]: ${scResults.length} hasil tidak bisa di-stream:`, reason);
      errors.push(`SoundCloud: ${scResults.length} hasil tidak bisa di-stream (${reason})`);
    }
  } catch (scErr) {
    console.warn('[SoundCloud Search Warning]:', scErr.message);
    errors.push(`SoundCloud: ${scErr.message}`);
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
        return resolve(Math.floor(hours * 3600 + mins * 60 + secs));
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
    bar += i === progressIndex ? '🔘' : '▬';
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
      isHandlingError: false,
      destroyed: false
    };

    // Log setiap perubahan state agar mudah debug di Railway
    newPlayer.on('stateChange', (oldS, newS) => {
      console.log(`[Server ${guildId}] Player: ${oldS.status} -> ${newS.status}`);
    });

    newPlayer.on(AudioPlayerStatus.Playing, () => {
      startProgressTicker(guildId);
    });

    newPlayer.on(AudioPlayerStatus.Idle, () => {
      stopProgressTicker(guildId);
      if (mgr.destroyed || mgr.isHandlingError) return;
      if (mgr.isLoopQueue && mgr.currentTrack && mgr.currentTrack.type === 'file') {
        mgr.musicQueue.push(mgr.currentTrack);
      }
      playNextSong(guildId);
    });

    newPlayer.on('error', async error => {
      console.error(`[Server ${guildId}] ❌ Audio Error:`, error.message);
      stopProgressTicker(guildId);
      if (mgr.destroyed || mgr.isHandlingError) return;
      mgr.isHandlingError = true;

      if (mgr.currentTrack && mgr.currentTrack.sourceName === 'YouTube HD') {
        console.log(`[Server ${guildId}] 🔄 YouTube stream drop, mencoba fallback ke SoundCloud...`);
        try {
          await ensureSoundCloud();
          const scResult = await play.search(mgr.currentTrack.title, { limit: 3, source: { soundcloud: 'tracks' } });
          for (const t of scResult) {
            try {
              const scStream = await play.stream_from_info(t);
              if (scStream && scStream.stream) {
                console.log(`[Server ${guildId}] ✅ Beralih ke SoundCloud: "${t.name || t.title}"`);
                mgr.currentTrack.title = t.name || t.title;
                mgr.currentTrack.url = t.url;
                mgr.currentTrack.sourceName = 'SoundCloud';
                mgr.currentTrack.startedAt = Date.now();
                mgr.currentTrack.seekOffset = 0;
                scStream.stream.on('error', err => console.warn('SoundCloud stream error:', err.message));
                const resource = createAudioResource(scStream.stream, { inputType: scStream.type ?? StreamType.Arbitrary });
                mgr.isHandlingError = false;
                mgr.player.play(resource);
                await sendPlayerCard(guildId, mgr.currentTrack, false);
                return;
              }
            } catch (e) {}
          }
        } catch (scErr) {}
      }

      mgr.isHandlingError = false;
      playNextSong(guildId);
    });

    guildManagers.set(guildId, mgr);
  }
  return mgr;
}

function destroyGuildManager(guildId) {
  const mgr = guildManagers.get(guildId);
  if (!mgr) return;
  mgr.destroyed = true;
  stopProgressTicker(guildId);
  mgr.musicQueue = [];
  mgr.currentTrack = null;
  mgr.player.stop(true);
  guildManagers.delete(guildId);
}

function startProgressTicker(guildId) {
  const mgr = guildManagers.get(guildId);
  if (!mgr) return;
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

// FIX: cek izin Connect & Speak sebelum join
function checkVoicePermissions(voiceChannel) {
  const me = voiceChannel.guild.members.me;
  const perms = me ? voiceChannel.permissionsFor(me) : null;
  if (!perms) return 'Tidak bisa membaca izin bot di voice channel ini.';
  if (!perms.has(PermissionFlagsBits.Connect)) return `Bot tidak punya izin **Connect** di <#${voiceChannel.id}>.`;
  if (!perms.has(PermissionFlagsBits.Speak)) return `Bot tidak punya izin **Speak** di <#${voiceChannel.id}>.`;
  return null;
}

// FIX: Sekarang async dan MENUNGGU koneksi voice benar-benar "Ready" sebelum audio diputar.
// Jika koneksi gagal (biasanya karena library enkripsi/DAVE belum terpasang), akan muncul error yang jelas.
async function connectVoice(message, voiceChannel) {
  const guildId = message.guild.id;
  const mgr = getGuildManager(guildId);
  mgr.activeTextChannel = message.channel;

  const permError = checkVoicePermissions(voiceChannel);
  if (permError) throw new Error(permError);

  let connection = getVoiceConnection(guildId);
  if (connection && connection.state.status === VoiceConnectionStatus.Destroyed) {
    connection = null;
  }

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    connection.on('stateChange', (oldS, newS) => {
      console.log(`[Server ${guildId}] Voice: ${oldS.status} -> ${newS.status}`);
    });

    connection.on('error', err => {
      console.error(`[Server ${guildId}] Voice connection error:`, err.message);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000)
        ]);
      } catch (e) {
        connection.destroy();
        destroyGuildManager(guildId);
      }
    });
  }

  connection.subscribe(mgr.player);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (e) {
    connection.destroy();
    throw new Error(
      'Gagal tersambung ke voice channel dalam 20 detik. Cek log "Voice Dependency Report" ' +
      '(opus / sodium / DAVE harus "found") dan pastikan @discordjs/voice versi terbaru.'
    );
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
  const match = rootFiles.find(f => f.toLowerCase() === q || f.toLowerCase() === `${q}.mp3` || f.toLowerCase().includes(q));
  if (match) return { title: match, path: path.join(MUSIC_DIR, match) };

  for (const p of getPlaylists()) {
    const pMatch = p.songs.find(f => f.toLowerCase() === q || f.toLowerCase() === `${q}.mp3` || f.toLowerCase().includes(q));
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

// FIX: versi Promise + cek status HTTP (sebelumnya error stream radio hilang begitu saja)
function fetchAudioStream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Terlalu banyak redirect'));
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchAudioStream(next, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      resolve(res);
    }).on('error', reject);
  });
}

async function playRadioStream(mgr, url) {
  const stream = await fetchAudioStream(url);
  stream.on('error', err => console.warn('Radio stream error:', err.message));
  let resource;
  try {
    const probed = await demuxProbe(stream);
    resource = createAudioResource(probed.stream, { inputType: probed.type });
  } catch {
    resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
  }
  mgr.player.play(resource);
}

async function executeSeek(guildId, targetSeconds) {
  const mgr = guildManagers.get(guildId);
  if (!mgr || !mgr.currentTrack || mgr.currentTrack.type === 'stream') return false;

  mgr.currentTrack.seekOffset = Math.max(0, targetSeconds);
  mgr.currentTrack.startedAt = Date.now();
  mgr.currentTrack.pausedAt = null;

  const conn = getVoiceConnection(guildId);
  if (conn) conn.subscribe(mgr.player);

  try {
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
      mgr.player.play(createAudioResource(ffmpeg, { inputType: StreamType.Raw }));
    } else if (mgr.currentTrack.type === 'online') {
      let source;
      if (mgr.currentTrack.sourceName === YTDLP_SOURCE || mgr.currentTrack.sourceName === YTDLP_SC_SOURCE) {
        source = createYtDlpStream(mgr.currentTrack.url);
      } else if (mgr.currentTrack.sourceName === 'YouTube HD' && ytdl) {
        source = createYouTubeStream(mgr.currentTrack.url);
      } else {
        await ensureSoundCloud();
        source = (await play.stream(mgr.currentTrack.url)).stream;
      }
      // FIX: seek lewat FFmpeg (opsi `begin` ytdl tidak berfungsi untuk video biasa)
      mgr.player.play(createSeekedResource(source, mgr.currentTrack.seekOffset));
    }
  } catch (err) {
    console.error('Seek error:', err.message);
    return false;
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
    const remainingPos = formatTime(Math.max(0, totalSec - currentSec));
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
    .setAuthor({ name: PLAYER_CARD_AUTHOR })
    .setTitle(`🎶 ${track.title}`.slice(0, 256))
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
  const mgr = guildManagers.get(guildId);
  if (!mgr || !mgr.activeTextChannel || !track) return;
  const embed = buildPlayerEmbed(mgr, track, isPaused);
  const rows = buildPlayerButtons(mgr, isPaused);

  // Edit di tempat hanya jika card masih menjadi pesan PALING BAWAH di channel
  if (mgr.lastPlayerMessage && isPlayerCardAtBottom(mgr)) {
    try {
      await mgr.lastPlayerMessage.edit({ embeds: [embed], components: rows });
      return;
    } catch (err) {
      mgr.lastPlayerMessage = null;
    }
  }

  // Card sudah tertimpa pesan lain (atau belum ada) -> kirim ulang di bawah
  await repostPlayerCard(guildId, { embeds: [embed], components: rows });
}

// ==========================================================
// PLAYER CARD SELALU DI BAWAH
// Setiap ada pesan baru di channel player, card lama dihapus & dikirim ulang
// ==========================================================
const PLAYER_CARD_AUTHOR = 'MUSIC PLAYER CONTROLLER';
const REPOST_DELAY_MS = 1500; // debounce agar tidak spam saat chat ramai

function isPlayerCardAtBottom(mgr) {
  return (
    mgr.lastPlayerMessage &&
    mgr.activeTextChannel &&
    mgr.lastPlayerMessage.channelId === mgr.activeTextChannel.id &&
    mgr.activeTextChannel.lastMessageId === mgr.lastPlayerMessage.id
  );
}

async function repostPlayerCard(guildId, payload = null) {
  const mgr = guildManagers.get(guildId);
  if (!mgr || !mgr.currentTrack || !mgr.activeTextChannel) return;
  if (mgr.isReposting) {
    mgr.repostPending = true; // ulangi setelah repost yang sedang berjalan selesai
    return;
  }
  mgr.isReposting = true;
  try {
    if (!payload) {
      const isPaused = mgr.player.state.status === AudioPlayerStatus.Paused;
      payload = {
        embeds: [buildPlayerEmbed(mgr, mgr.currentTrack, isPaused)],
        components: buildPlayerButtons(mgr, isPaused)
      };
    }
    const oldCard = mgr.lastPlayerMessage;
    // Kirim dulu yang baru, baru hapus yang lama -> card tidak pernah hilang
    mgr.lastPlayerMessage = await mgr.activeTextChannel.send(payload);
    if (oldCard) oldCard.delete().catch(() => {});
  } catch (err) {
    console.error(`[Server ${guildId}] Gagal kirim player card:`, err.message);
  } finally {
    mgr.isReposting = false;
    if (mgr.repostPending) {
      mgr.repostPending = false;
      if (!isPlayerCardAtBottom(mgr)) schedulePlayerCardRepost(guildId);
    }
  }
}

function schedulePlayerCardRepost(guildId) {
  const mgr = guildManagers.get(guildId);
  if (!mgr) return;
  clearTimeout(mgr.repostTimer);
  mgr.repostTimer = setTimeout(() => {
    const m = guildManagers.get(guildId);
    if (m && m.currentTrack && m.lastPlayerMessage && !isPlayerCardAtBottom(m)) {
      repostPlayerCard(guildId);
    }
  }, REPOST_DELAY_MS);
}

// Dipanggil saat yt-dlp gagal memutar lagu yang sudah di antrean
// (mis. YouTube baru memblokir setelah lagu ditambahkan) -> otomatis pindah ke SoundCloud
function handleYtDlpPlaybackFail(guildId, track, msg) {
  const mgr = guildManagers.get(guildId);
  if (!mgr || mgr.destroyed || mgr.currentTrack !== track) return;

  if (track.sourceName !== YTDLP_SOURCE) {
    // Sudah SoundCloud dan tetap gagal: biarkan Idle lanjut ke lagu berikutnya
    mgr.activeTextChannel?.send(`⚠️ Gagal memutar **${track.title}**: ${msg.slice(0, 300)}`).catch(() => {});
    return;
  }

  markYouTubeBlockedIfNeeded(msg);
  mgr.isHandlingError = true; // tahan event Idle selama mencari pengganti

  (async () => {
    try {
      const sc = await searchYtDlp(track.title, { prefix: 'scsearch3', sourceName: YTDLP_SC_SOURCE });
      if (mgr.destroyed || mgr.currentTrack !== track) {
        mgr.isHandlingError = false;
        return;
      }
      Object.assign(track, {
        title: sc.title,
        url: sc.url,
        duration: sc.duration,
        sourceName: sc.sourceName,
        startedAt: Date.now(),
        pausedAt: null,
        seekOffset: 0
      });
      const scStream = createYtDlpStream(track.url, {
        onFail: m => handleYtDlpPlaybackFail(guildId, track, m)
      });
      mgr.isHandlingError = false;
      mgr.player.play(createAudioResource(scStream, { inputType: StreamType.Arbitrary }));
      mgr.activeTextChannel?.send(`🔄 YouTube sedang memblokir bot, beralih ke SoundCloud: **${sc.title}**`).catch(() => {});
      await sendPlayerCard(guildId, track, false);
    } catch (e) {
      console.warn(`[Server ${guildId}] Fallback SoundCloud gagal:`, e.message);
      mgr.activeTextChannel?.send(`⚠️ Gagal memutar **${track.title}** dari YouTube maupun SoundCloud.`).catch(() => {});
      mgr.isHandlingError = false;
      if (!mgr.destroyed && mgr.currentTrack === track) playNextSong(guildId);
    }
  })();
}

async function playNextSong(guildId) {
  const mgr = guildManagers.get(guildId);
  if (!mgr || mgr.destroyed) return;
  if (mgr.isTransitioning) return;
  mgr.isTransitioning = true;

  let failedTrack = null;

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

    const conn = getVoiceConnection(guildId);
    if (conn) conn.subscribe(mgr.player);

    try {
      if (mgr.currentTrack.type === 'file') {
        if (!mgr.currentTrack.duration) {
          mgr.currentTrack.duration = await getAudioDuration(mgr.currentTrack.path);
        }
        const fileStream = fs.createReadStream(mgr.currentTrack.path);
        fileStream.on('error', err => console.warn('File stream error:', err.message));
        mgr.player.play(createAudioResource(fileStream, { inputType: StreamType.Arbitrary }));
      } else if (mgr.currentTrack.type === 'online') {
        let resource;
        if (mgr.currentTrack.sourceName === YTDLP_SOURCE || mgr.currentTrack.sourceName === YTDLP_SC_SOURCE) {
          const track = mgr.currentTrack;
          const dlpStream = createYtDlpStream(track.url, {
            onFail: msg => handleYtDlpPlaybackFail(guildId, track, msg)
          });
          dlpStream.on('error', err => console.warn(`[Server ${guildId}] yt-dlp stream warning:`, err.message));
          resource = createAudioResource(dlpStream, { inputType: StreamType.Arbitrary });
        } else if (mgr.currentTrack.sourceName === 'YouTube HD' && ytdl) {
          const ytStream = createYouTubeStream(mgr.currentTrack.url);
          ytStream.on('error', err => console.warn(`[Server ${guildId}] YouTube stream warning:`, err.message));
          resource = createAudioResource(ytStream, { inputType: StreamType.Arbitrary });
        } else {
          await ensureSoundCloud();
          const scData = await play.stream(mgr.currentTrack.url);
          scData.stream.on('error', err => console.warn(`[Server ${guildId}] SoundCloud stream warning:`, err.message));
          resource = createAudioResource(scData.stream, { inputType: scData.type ?? StreamType.Arbitrary });
        }
        mgr.player.play(resource);
      } else if (mgr.currentTrack.type === 'stream') {
        mgr.currentTrack.duration = 0;
        await playRadioStream(mgr, mgr.currentTrack.url);
      }

      await sendPlayerCard(guildId, mgr.currentTrack, false);
    } catch (err) {
      console.error(`[Server ${guildId}] Error memutar track:`, err.message);
      failedTrack = mgr.currentTrack;
      if (mgr.activeTextChannel) {
        mgr.activeTextChannel.send(`⚠️ Gagal memutar **${failedTrack.title}**: ${err.message}`).catch(() => {});
      }
    }
  } finally {
    // FIX: reset langsung (sebelumnya pakai setTimeout 500ms, sehingga jika lagu gagal cepat,
    // event Idle diabaikan dan bot diam selamanya)
    mgr.isTransitioning = false;
  }

  // FIX: sebelumnya playNextSong dipanggil rekursif saat isTransitioning masih true -> tidak pernah jalan
  if (failedTrack) setImmediate(() => playNextSong(guildId));
}

// --- 7. EVENT LISTENERS DISCORD ---
client.once('clientReady', () => {
  console.log(`✅ [LOGIN SUKSES] Logged in as ${client.user.tag}!`);
  console.log(`📡 Multi-Server aktif di ${client.guilds.cache.size} server.`);
});

// Pantau SEMUA pesan (termasuk balasan bot sendiri) di channel player
// agar player card dipindah ke paling bawah
client.on('messageCreate', message => {
  if (!message.guild) return;
  const mgr = guildManagers.get(message.guild.id);
  if (!mgr || !mgr.currentTrack || !mgr.lastPlayerMessage || !mgr.activeTextChannel) return;
  if (message.channelId !== mgr.activeTextChannel.id) return;
  if (message.id === mgr.lastPlayerMessage.id) return;
  // Abaikan player card itu sendiri (event bisa datang sebelum send() selesai)
  if (message.author.id === client.user.id && message.embeds[0]?.author?.name === PLAYER_CARD_AUTHOR) return;
  schedulePlayerCardRepost(message.guild.id);
});

client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  const guildId = message.guild.id;

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
        iconURL: message.author.displayAvatarURL()
      })
      .setThumbnail(message.author.displayAvatarURL({ size: 256 }))
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
      const yWIB = getWIBTime(new Date(Date.now() - 24 * 60 * 60 * 1000));
      targetDateKey = yWIB.dateKey;
      targetDateLabel = `Kemarin (${yWIB.dateFormatted})`;
    } else if (subParam === 'riwayat') {
      const availableDates = Object.keys(guildData).sort().reverse();
      if (availableDates.length === 0) {
        return message.channel.send('📭 Belum ada riwayat absensi yang tersimpan di server ini.');
      }
      const historySummary = availableDates.slice(0, 7).map(d => {
        return `• 📅 \`${d}\` ➔ **${guildData[d].length} member hadir**`;
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

    const reportEmbed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`📋 Rekap Presensi: ${targetDateLabel}`)
      .setDescription(
        `Berikut daftar member yang hadir:\n\n` +
        attendeeLines.join('\n') +
        `\n\n📊 **Total Kehadiran:** \`${list.length} member\``
      )
      .setFooter({
        text: `Sistem Presensi • Server: ${message.guild.name}`,
        iconURL: message.guild.iconURL() || undefined
      })
      .setTimestamp();

    return message.channel.send({ embeds: [reportEmbed] });
  }

  // ==========================================
  // COMMAND: RADIO LIVE 24/7 (!radio)
  // ==========================================
  if (message.content.startsWith('!radio')) {
    const stationKey = message.content.split(' ')[1]?.toLowerCase();
    if (!stationKey || !RADIO_STATIONS[stationKey]) {
      const list = Object.keys(RADIO_STATIONS).map(k => `• \`!radio ${k}\` ➔ ${RADIO_STATIONS[k].name}`).join('\n');
      return message.reply(`📻 **Pilihan Stasiun Radio 24/7:**\n${list}\n\n*Contoh: Ketik \`!radio lofi\` untuk mendengarkan!*`);
    }

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) return message.reply('⚠️ Kamu harus masuk ke Voice Channel terlebih dahulu!');

    try {
      await connectVoice(message, voiceChannel);
    } catch (err) {
      return message.reply(`❌ ${err.message}`);
    }

    const mgr = getGuildManager(guildId);
    const station = RADIO_STATIONS[stationKey];
    mgr.musicQueue = [];
    mgr.currentTrack = {
      title: station.name,
      url: station.url,
      type: 'stream',
      duration: 0,
      startedAt: Date.now(),
      seekOffset: 0
    };

    try {
      await playRadioStream(mgr, station.url);
    } catch (err) {
      mgr.currentTrack = null;
      return message.reply(`❌ Gagal membuka stream radio **${station.name}**: ${err.message}`);
    }

    await sendPlayerCard(guildId, mgr.currentTrack, false);
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
  if (message.content === '!play' || message.content.startsWith('!play ')) {
    const query = message.content.split(' ').slice(1).join(' ').trim();
    if (!query) {
      return message.reply('⚠️ Masukkan judul lagu atau link!\n💡 *Contoh: `!play sial mahalini` atau `!radio lofi`*');
    }

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) return message.reply('⚠️ Kamu harus masuk ke Voice Channel terlebih dahulu!');

    const mgr = getGuildManager(guildId);

    // 1. Cek Folder Playlist Lokal
    const matchedPlaylist = getPlaylists().find(p => p.name.toLowerCase() === query.toLowerCase());
    if (matchedPlaylist) {
      if (matchedPlaylist.songs.length === 0) return message.reply(`⚠️ Playlist **${matchedPlaylist.name}** kosong.`);

      try {
        await connectVoice(message, voiceChannel);
      } catch (err) {
        return message.reply(`❌ ${err.message}`);
      }

      const wasEmpty = mgr.musicQueue.length === 0 && !mgr.currentTrack;
      for (const song of matchedPlaylist.songs) {
        mgr.musicQueue.push({ title: song, path: path.join(matchedPlaylist.path, song), type: 'file' });
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
      try {
        await connectVoice(message, voiceChannel);
      } catch (err) {
        return message.reply(`❌ ${err.message}`);
      }

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

    // 3. PENCARIAN ONLINE
    const searchMsg = await message.reply(`🔍 Mencari lagu **"${query}"**...`);
    const searchErrors = [];
    const onlineTrack = await searchOnlineTrack(query, searchErrors);

    if (!onlineTrack) {
      const reasons = searchErrors.map(e => `• ${e.slice(0, 180)}`).join('\n').slice(0, 1500);
      return searchMsg.edit(
        `❌ Tidak ditemukan lagu yang dapat diputar untuk **"${query}"**.\n` +
        (reasons ? `\`\`\`\n${reasons}\n\`\`\`` : '') +
        `💡 *Tips: Perbarui YOUTUBE_COOKIE di Railway menggunakan jendela Incognito (tanpa klik logout).*`
      );
    }

    try {
      await connectVoice(message, voiceChannel);
    } catch (err) {
      return searchMsg.edit(`❌ ${err.message}`);
    }

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
    const mgr = guildManagers.get(guildId);
    if (!mgr || (!mgr.currentTrack && mgr.musicQueue.length === 0)) return message.reply('📭 Antrean musik saat ini kosong.');

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
    if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('❌ Khusus Admin.');
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

  if (message.content === '!help') {
    const helpEmbed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('📖 Buku Panduan & Daftar Perintah Bot')
      .setDescription(
        'Berikut daftar perintah yang dapat kamu gunakan di server:\n\n' +
        '🎵 **Fitur Pemutar Musik:**\n' +
        '• `!play <judul/link>` : Putar lagu langsung dari YouTube / SoundCloud\n' +
        '• `!playlists` : Lihat daftar album / folder musik lokal\n' +
        '• `!radio <lofi/prambors/genfm/hardrock>` : Putar stasiun radio live 24/7\n' +
        '• `!queue` : Lihat daftar antrean lagu saat ini\n' +
        '• `!seek <menit:detik>` : Geser pemutaran lagu (contoh: `!seek 1:30`)\n' +
        '• `!dc` : Hentikan lagu dan keluarkan bot dari voice channel\n\n' +
        '📋 **Fitur Presensi / Absensi:**\n' +
        '• `!absen` : Catat kehadiran kamu hari ini (1x per hari)\n' +
        '• `!logabsen` : Lihat rekap presensi hari ini\n' +
        '• `!logabsen kemarin` : Rekap presensi kemarin\n' +
        '• `!logabsen riwayat` : Rekap tanggal 7 hari terakhir\n\n' +
        '🛡️ **Fitur Administrasi:**\n' +
        '• `!setup-verify` : Buat panel tombol verifikasi member otomatis\n' +
        '• `!ping` : Cek latensi dan kestabilan bot'
      )
      .setFooter({ text: 'Bot Musik & Absensi Multi-Server' });
    return message.reply({ embeds: [helpEmbed] });
  }

  if (message.content.startsWith('!seek')) {
    const targetSec = parseTimeToSeconds(message.content.split(' ')[1]);
    if (targetSec === null) {
      return message.reply('⚠️ Format waktu tidak valid! Gunakan format `mm:ss` (contoh: `!seek 1:30` atau `!seek 45`).');
    }
    const success = await executeSeek(guildId, targetSec);
    if (!success) {
      return message.reply('⚠️ Gagal seek. Pastikan ada lagu yang sedang diputar (fitur seek tidak berlaku untuk radio 24/7).');
    }
    return message.reply(`⏩ Waktu lagu berhasil digeser ke **${formatTime(targetSec)}**.`);
  }

  if (message.content === '!dc' || message.content === '!leave') {
    const mgr = guildManagers.get(guildId);
    if (mgr?.lastPlayerMessage) {
      mgr.lastPlayerMessage.delete().catch(() => {});
      mgr.lastPlayerMessage = null;
    }
    destroyGuildManager(guildId);
    const conn = getVoiceConnection(guildId);
    if (conn) conn.destroy();
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
    }
    return interaction.reply({
      content: `✅ Umur akun valid (**${Math.floor(accountAgeDays)} hari**). Role "Verified" / "Member" belum dibuat di server ini oleh Admin.`,
      flags: MessageFlags.Ephemeral
    });
  }

  // Tombol Player Controller
  if (interaction.customId.startsWith('btn_player_')) {
    const mgr = guildManagers.get(guildId);
    if (!mgr || !mgr.currentTrack) {
      return interaction.reply({ content: '⚠️ Tidak ada lagu yang sedang diputar saat ini.', flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId === 'btn_player_playpause') {
      if (mgr.player.state.status === AudioPlayerStatus.Playing) {
        mgr.player.pause();
        mgr.currentTrack.pausedAt = Date.now();
        stopProgressTicker(guildId);
        await interaction.update({ embeds: [buildPlayerEmbed(mgr, mgr.currentTrack, true)], components: buildPlayerButtons(mgr, true) });
      } else if (mgr.player.state.status === AudioPlayerStatus.Paused) {
        if (mgr.currentTrack.pausedAt) {
          mgr.currentTrack.startedAt += (Date.now() - mgr.currentTrack.pausedAt);
          mgr.currentTrack.pausedAt = null;
        }
        mgr.player.unpause();
        await interaction.update({ embeds: [buildPlayerEmbed(mgr, mgr.currentTrack, false)], components: buildPlayerButtons(mgr, false) });
        startProgressTicker(guildId);
      } else {
        await interaction.reply({ content: '⚠️ Status player tidak dapat diubah.', flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.customId === 'btn_player_rewind10' || interaction.customId === 'btn_player_forward10') {
      const isForward = interaction.customId === 'btn_player_forward10';
      const current = getCurrentPlaybackSeconds(mgr);
      const target = isForward ? current + 10 : Math.max(0, current - 10);
      // Balas dulu (batas waktu interaksi 3 detik), seek bisa lebih lama
      await interaction.reply({
        content: `${isForward ? '⏩ Maju' : '⏪ Mundur'} 10 detik (sekarang: **${formatTime(target)}**).`,
        flags: MessageFlags.Ephemeral
      });
      await executeSeek(guildId, target);
      return;
    }

    if (interaction.customId === 'btn_player_skip') {
      await interaction.reply({ content: '⏭️ Melanjutkan ke lagu berikutnya...', flags: MessageFlags.Ephemeral });
      mgr.player.stop();
      return;
    }

    // FIX: sebelumnya update() lalu reply() -> error "already acknowledged"
    if (interaction.customId === 'btn_player_shuffle') {
      shuffleArray(mgr.musicQueue);
      await interaction.update({ embeds: [buildPlayerEmbed(mgr, mgr.currentTrack, false)], components: buildPlayerButtons(mgr, false) });
      return interaction.followUp({ content: '🔀 **Antrean di server ini berhasil diacak!**', flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId === 'btn_player_loop') {
      mgr.isLoopQueue = !mgr.isLoopQueue;
      await interaction.update({ embeds: [buildPlayerEmbed(mgr, mgr.currentTrack, false)], components: buildPlayerButtons(mgr, false) });
      return interaction.followUp({ content: `🔁 Mode Loop di server ini: **${mgr.isLoopQueue ? 'AKTIF' : 'NONAKTIF'}**`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId === 'btn_player_stop') {
      destroyGuildManager(guildId);
      const conn = getVoiceConnection(guildId);
      if (conn) conn.destroy();

      const stoppedEmbed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('⏹️ Pemutar Musik Dimatikan')
        .setDescription(`Musik dihentikan oleh **${interaction.user.username}**.`);

      await interaction.update({ embeds: [stoppedEmbed], components: [] });
      return;
    }
  }
});

// --- 9. LOGIN BOT ---
console.log('🤖 Menghubungkan bot ke Discord...');
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ GAGAL LOGIN KE DISCORD! Periksa DISCORD_TOKEN atau Privileged Intents:', err.message);
});
