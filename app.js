const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

require('dotenv').config();
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
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

// --- WEB SERVER (RAILWAY HEALTHCHECK) ---
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('🎵 Discord Music Bot Online 24/7 on Railway!');
}).listen(PORT, () => {
  console.log(`🚀 Web server running on port ${PORT}`);
});

// --- DISCORD CLIENT ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// Audio Player & Antrean (Queue)
const player = createAudioPlayer();
let musicQueue = [];
let currentTrack = null;
let activeTextChannel = null;

// Pengaturan Loop & Shuffle
let isLoopQueue = true; // Default ON agar playlist memutar ulang terus menerus

// Direktori Musik
const MUSIC_DIR = path.join(__dirname, 'Music');
if (!fs.existsSync(MUSIC_DIR)) {
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
}

// 1. Ambil Semua Playlist Folder
function getPlaylists() {
  if (!fs.existsSync(MUSIC_DIR)) return [];
  const entries = fs.readdirSync(MUSIC_DIR, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(d => {
    const folderPath = path.join(MUSIC_DIR, d.name);
    const songs = fs.readdirSync(folderPath).filter(f => f.endsWith('.mp3') || f.endsWith('.wav') || f.endsWith('.ogg'));
    return { name: d.name, path: folderPath, songs: songs };
  });
}

// 2. Cari Lagu Tertentu
function findSingleSong(query) {
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

// 3. Fungsi Acak Lagu (Shuffle)
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

// 4. Daftar Radio Live 24/7
const RADIO_STATIONS = {
  lofi: { name: 'Lofi Chill Beats 24/7', url: 'https://streams.ilovemusic.de/iloveradio17.mp3' },
  prambors: { name: 'Prambors FM', url: 'https://stream.zeno.fm/fvrx452618uvv' },
  genfm: { name: 'Gen FM Jakarta', url: 'https://stream.zeno.fm/7k94r6y1m4zuv' },
  hardrock: { name: 'Hard Rock FM', url: 'https://stream.zeno.fm/u2213718v8zuv' }
};

// Stream Fetcher untuk Radio / URL (Mendukung Redirect HTTP 302)
function fetchAudioStream(url, callback) {
  const lib = url.startsWith('https') ? https : http;
  lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      return fetchAudioStream(res.headers.location, callback);
    }
    callback(res);
  }).on('error', err => console.error('Stream Error:', err.message));
}

// Fungsi Memutar Lagu Berikutnya di Antrean
function playNextSong() {
  if (musicQueue.length === 0) {
    currentTrack = null;
    return;
  }

  currentTrack = musicQueue.shift();

  if (currentTrack.type === 'file') {
    const resource = createAudioResource(fs.createReadStream(currentTrack.path), {
      inputType: StreamType.Arbitrary,
      inlineVolume: true
    });
    if (resource.volume) resource.volume.setVolume(0.8);
    player.play(resource);

    if (activeTextChannel) {
      activeTextChannel.send(`🎶 Sekarang memutar: **${currentTrack.title}** 🔊`).catch(() => {});
    }
  } else if (currentTrack.type === 'stream') {
    fetchAudioStream(currentTrack.url, stream => {
      const resource = createAudioResource(stream, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true
      });
      player.play(resource);
    });
    if (activeTextChannel) {
      activeTextChannel.send(`📻 Sekarang memutar siaran: **${currentTrack.title}** 🔊`).catch(() => {});
    }
  }
}

// Otomatis putar lagu berikutnya saat lagu selesai
player.on(AudioPlayerStatus.Idle, () => {
  // Jika mode Loop aktif dan tadi memutar file lagu, masukkan kembali ke ujung antrean
  if (isLoopQueue && currentTrack && currentTrack.type === 'file') {
    musicQueue.push(currentTrack);
  }
  playNextSong();
});

player.on('error', error => {
  console.error('❌ Audio Player Error:', error.message);
  playNextSong();
});

// Gabung Voice Channel
function connectVoice(message, voiceChannel) {
  activeTextChannel = message.channel;
  let connection = getVoiceConnection(message.guild.id);
  if (!connection) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });
    connection.subscribe(player);
  }
  return connection;
}

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);
});

// --- COMMAND HANDLER ---
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;

  // 1. HELP (!help)
  if (message.content === '!help') {
    return message.reply(`🎧 **Daftar Perintah Lengkap Bot:**\n\n` +
      `📻 **RADIO LIVE:**\n` +
      `• \`!radio\` : Lihat daftar channel radio live\n` +
      `• \`!radio <nama>\` : Putar siaran radio live\n\n` +
      `📁 **PLAYLIST & LAGU FOLDER:**\n` +
      `• \`!playlists\` : Lihat semua kategori playlist folder\n` +
      `• \`!playlist <nama>\` : Lihat lagu di dalam satu playlist\n` +
      `• \`!play <nama playlist>\` : Putar seluruh lagu di playlist secara berurutan\n` +
      `• \`!play <nama lagu>\` : Putar 1 lagu tertentu\n\n` +
      `🎛️ **KONTROL PUTAR (LOOP & SHUFFLE):**\n` +
      `• \`!loop\` : Mengaktifkan/menonaktifkan mode Ulang (Loop Playlist)\n` +
      `• \`!shuffle\` : Mengacak urutan lagu di antrean playlist\n` +
      `• \`!queue\` : Lihat daftar antrean lagu berikutnya\n` +
      `• \`!skip\` : Lewati lagu yang sedang diputar\n` +
      `• \`!pause\` / \`!resume\` : Jeda atau lanjutkan audio\n` +
      `• \`!stop\` : Hentikan audio & bot keluar dari voice\n\n` +
      `🛡️ **ADMIN:**\n` +
      `• \`!setup-verify\` : Kirim panel verifikasi member`);
  }

  // 2. TOGGLE LOOP (!loop)
  if (message.content === '!loop') {
    isLoopQueue = !isLoopQueue;
    return message.reply(`🔂 Mode Loop Playlist sekarang: **${isLoopQueue ? 'AKTIF (Berulang terus menerus)' : 'NONAKTIF (Berhenti jika lagu habis)'}**`);
  }

  // 3. SHUFFLE ANTREAN (!shuffle)
  if (message.content === '!shuffle') {
    if (musicQueue.length <= 1) {
      return message.reply('⚠️ Butuh minimal 2 lagu di antrean untuk diacak.');
    }
    shuffleArray(musicQueue);
    return message.reply(`🔀 **${musicQueue.length} lagu di antrean berhasil diacak (Shuffle)!** Ketik \`!queue\` untuk melihat urutan baru.`);
  }

  // 4. PUTAR RADIO (!radio)
  if (message.content.startsWith('!radio')) {
    const args = message.content.split(' ').slice(1);
    const stationKey = args[0] ? args[0].toLowerCase() : null;

    if (!stationKey || !RADIO_STATIONS[stationKey]) {
      const list = Object.entries(RADIO_STATIONS)
        .map(([k, v]) => `• \`!radio ${k}\` ➔ **${v.name}**`)
        .join('\n');
      return message.reply(`📻 **Pilihan Channel Radio Live 24/7:**\n${list}\n\n*Contoh: \`!radio lofi\`*`);
    }

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('⚠️ Kamu harus masuk ke Voice Channel terlebih dahulu!');

    const station = RADIO_STATIONS[stationKey];
    connectVoice(message, voiceChannel);

    musicQueue = [];
    currentTrack = { title: station.name, url: station.url, type: 'stream' };

    fetchAudioStream(station.url, stream => {
      const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
      if (resource.volume) resource.volume.setVolume(0.8);
      player.play(resource);
    });

    return message.reply(`📻 Bergabung ke **${voiceChannel.name}** dan memutar **${station.name}**! 🔊`);
  }

  // 5. LIHAT PLAYLIST (!playlists)
  if (message.content === '!playlists') {
    const playlists = getPlaylists();
    if (playlists.length === 0) {
      return message.reply('📂 Belum ada folder playlist di `Music`. Buat folder di GitHub (misal: `Music/Pop/`).');
    }
    const list = playlists.map((p, i) => `${i + 1}. 📁 **${p.name}** — ${p.songs.length} lagu (\`!play ${p.name}\`)`).join('\n');
    return message.reply(`📂 **Daftar Playlist Tersedia:**\n${list}\n\n*Ketik \`!play <nama playlist>\` untuk memutar!*`);
  }

  // 6. LIHAT LAGU DI SATU PLAYLIST (!playlist <nama>)
  if (message.content.startsWith('!playlist')) {
    const playlistName = message.content.split(' ').slice(1).join(' ').trim();
    if (!playlistName) return message.reply('⚠️ Ketik: `!playlist <nama playlist>` (contoh: `!playlist Pop`).');

    const playlists = getPlaylists();
    const p = playlists.find(x => x.name.toLowerCase() === playlistName.toLowerCase());
    if (!p) return message.reply(`❌ Playlist **${playlistName}** tidak ditemukan.`);
    if (p.songs.length === 0) return message.reply(`📂 Playlist **${p.name}** masih kosong.`);

    const list = p.songs.map((s, i) => `${i + 1}. 🎵 \`${s}\``).join('\n');
    return message.reply(`📂 **Lagu di Playlist "${p.name}":**\n${list}\n\n*Putar semua lagu dengan: \`!play ${p.name}\`*`);
  }

  // 7. PUTAR LAGU / PLAYLIST (!play <nama>)
  if (message.content.startsWith('!play')) {
    const query = message.content.split(' ').slice(1).join(' ').trim();
    if (!query) return message.reply('⚠️ Gunakan: `!play <nama playlist>` atau `!play <nama lagu>`.');

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('⚠️ Kamu harus masuk ke Voice Channel terlebih dahulu!');

    connectVoice(message, voiceChannel);

    // Cek apakah nama playlist (folder)
    const playlists = getPlaylists();
    const matchedPlaylist = playlists.find(p => p.name.toLowerCase() === query.toLowerCase());

    if (matchedPlaylist) {
      if (matchedPlaylist.songs.length === 0) return message.reply(`⚠️ Playlist **${matchedPlaylist.name}** kosong.`);

      const wasEmpty = musicQueue.length === 0 && !currentTrack;
      for (const song of matchedPlaylist.songs) {
        musicQueue.push({
          title: song,
          path: path.join(matchedPlaylist.path, song),
          type: 'file'
        });
      }

      message.reply(`📁 Menambahkan **${matchedPlaylist.songs.length} lagu** dari playlist **${matchedPlaylist.name}** ke antrean! (Loop: ${isLoopQueue ? 'ON' : 'OFF'}) 🎶`);
      if (wasEmpty) playNextSong();
      return;
    }

    // Cek apakah Link URL
    if (query.startsWith('http://') || query.startsWith('https://')) {
      const wasEmpty = musicQueue.length === 0 && !currentTrack;
      musicQueue.push({ title: 'Web Audio Stream', url: query, type: 'stream' });
      message.reply('🔗 Audio stream ditambahkan ke antrean.');
      if (wasEmpty) playNextSong();
      return;
    }

    // Cek lagu tunggal
    const singleSong = findSingleSong(query);
    if (singleSong) {
      const wasEmpty = musicQueue.length === 0 && !currentTrack;
      musicQueue.push({ title: singleSong.title, path: singleSong.path, type: 'file' });

      if (wasEmpty) {
        playNextSong();
      } else {
        message.reply(`➕ Menambahkan **${singleSong.title}** ke antrean (#${musicQueue.length}).`);
      }
      return;
    }

    return message.reply(`❌ Tidak ditemukan lagu atau playlist **"${query}"**.`);
  }

  // 8. SKIP (!skip)
  if (message.content === '!skip') {
    if (!currentTrack) return message.reply('⚠️ Tidak ada lagu yang sedang diputar.');
    message.reply(`⏭️ Melewati **${currentTrack.title}**...`);
    player.stop();
    return;
  }

  // 9. QUEUE (!queue)
  if (message.content === '!queue') {
    if (!currentTrack && musicQueue.length === 0) return message.reply('📭 Antrean musik saat ini kosong.');

    let text = `🎶 **Sedang Diputar:** \`${currentTrack ? currentTrack.title : 'Tidak ada'}\`\n🔂 **Mode Loop:** \`${isLoopQueue ? 'AKTIF' : 'NONAKTIF'}\`\n\n📋 **Antrean Berikutnya:**\n`;
    if (musicQueue.length === 0) {
      text += '*Tidak ada lagu lagi di antrean.*';
    } else {
      text += musicQueue.slice(0, 10).map((s, i) => `${i + 1}. \`${s.title}\``).join('\n');
      if (musicQueue.length > 10) {
        text += `\n*...dan ${musicQueue.length - 10} lagu lainnya.*`;
      }
    }
    return message.reply(text);
  }

  // 10. STOP (!stop)
  if (message.content === '!stop') {
    musicQueue = [];
    currentTrack = null;
    player.stop();
    const conn = getVoiceConnection(message.guild.id);
    if (conn) conn.destroy();
    return message.reply('⏹️ Musik dihentikan, antrean dikosongkan, dan bot keluar dari Voice Channel.');
  }

  // 11. PAUSE / RESUME
  if (message.content === '!pause') {
    player.pause();
    return message.reply('⏸️ Musik dijeda.');
  }
  if (message.content === '!resume') {
    player.unpause();
    return message.reply('▶️ Melanjutkan musik.');
  }

  // 12. VERIFIKASI (Admin)
  if (message.content === '!setup-verify') {
    if (!message.member.permissions.has('Administrator')) return message.reply('❌ Khusus Admin.');
    const embed = new EmbedBuilder()
      .setTitle('🛡️ Verifikasi Member')
      .setDescription('Selamat datang!\nKlik tombol **Verifikasi** di bawah untuk membuka akses channel.\n*Syarat: Umur akun minimal 30 hari.*')
      .setColor('#2b2d31')
      .setFooter({ text: 'Sistem Keamanan Server' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn_verify').setLabel('Verifikasi').setStyle(ButtonStyle.Success).setEmoji('✅')
    );
    await message.channel.send({ embeds: [embed], components: [row] });
    return message.delete().catch(() => {});
  }
});

// INTERAKSI TOMBOL VERIFIKASI
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() || interaction.customId !== 'btn_verify') return;
  const roleId = process.env.VERIFIED_ROLE_ID;
  if (!roleId) return interaction.reply({ content: '⚠️ ID Role verifikasi belum diatur.', ephemeral: true });
  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) return interaction.reply({ content: '⚠️ Role tidak ditemukan.', ephemeral: true });
  if (interaction.member.roles.cache.has(roleId)) {
    return interaction.reply({ content: 'ℹ️ Kamu sudah terverifikasi!', ephemeral: true });
  }

  const daysDiff = (Date.now() - interaction.user.createdTimestamp) / (1000 * 60 * 60 * 24);
  if (daysDiff < 30) {
    return interaction.reply({
      content: `❌ Umur akun baru **${Math.floor(daysDiff)} hari**. Minimal 30 hari.`,
      ephemeral: true
    });
  }

  try {
    await interaction.member.roles.add(role);
    return interaction.reply({ content: '🎉 Berhasil diverifikasi!', ephemeral: true });
  } catch (error) {
    return interaction.reply({ content: '⚠️ Gagal memberi role. Cek posisi role bot.', ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);
