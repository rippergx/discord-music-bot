const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

require('dotenv').config();
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const prism = require('prism-media');
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
  res.end('🎵 Discord Music Player with Queue Display Online 24/7!');
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
let lastPlayerMessage = null;
let isLoopQueue = true;

// Direktori Musik
const MUSIC_DIR = path.join(__dirname, 'Music');
if (!fs.existsSync(MUSIC_DIR)) {
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
}

// Format Waktu
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function parseTimeToSeconds(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function getCurrentPlaybackSeconds() {
  if (!currentTrack || !currentTrack.startedAt) return 0;
  const elapsed = (Date.now() - currentTrack.startedAt) / 1000;
  return Math.max(0, (currentTrack.seekOffset || 0) + elapsed);
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

// 3. Acak Lagu (Shuffle)
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

// Stream Fetcher untuk Radio / URL
function fetchAudioStream(url, callback) {
  const lib = url.startsWith('https') ? https : http;
  lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      return fetchAudioStream(res.headers.location, callback);
    }
    callback(res);
  }).on('error', err => console.error('Stream Error:', err.message));
}

// FUNGSI SEEK KE DETIK TERTENTU
function executeSeek(targetSeconds) {
  if (!currentTrack || currentTrack.type !== 'file') return false;

  currentTrack.seekOffset = Math.max(0, targetSeconds);
  currentTrack.startedAt = Date.now();

  const ffmpeg = new prism.FFmpeg({
    args: [
      '-ss', String(currentTrack.seekOffset),
      '-i', currentTrack.path,
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

  player.play(resource);
  sendPlayerCard(currentTrack, false);
  return true;
}

// --- TAMPILAN MODERN MUSIC PLAYER CARD DENGAN DAFTAR ANTREAN ---
function buildPlayerEmbed(track, isPaused = false) {
  const currentPos = formatTime(getCurrentPlaybackSeconds());

  // Format Daftar Antrean Lagu Berikutnya (Up Next)
  let queueListText = '';
  if (musicQueue.length === 0) {
    queueListText = '_Tidak ada lagu di antrean._';
  } else {
    const previewCount = 4; // Tampilkan 4 judul lagu berikutnya
    const upcoming = musicQueue.slice(0, previewCount);
    queueListText = upcoming.map((song, idx) => `**${idx + 1}.** 🎵 \`${song.title}\``).join('\n');
    if (musicQueue.length > previewCount) {
      queueListText += `\n*...dan +${musicQueue.length - previewCount} lagu lainnya di antrean.*`;
    }
  }

  return new EmbedBuilder()
    .setColor('#5865F2')
    .setAuthor({
      name: 'MUSIC PLAYER CONTROLLER',
      iconURL: client.user.displayAvatarURL()
    })
    .setTitle(`🎶 ${track.title}`)
    .setDescription(
      `⏱️ Posisi: \`${currentPos}\` ${track.type === 'file' ? '(Gunakan !seek untuk melompat)' : '(Live Stream)'}\n` +
      `🔘▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ 24/7\n\n` +
      `**Status:** ${isPaused ? '⏸️ Dijeda' : '▶️ Sedang Berputar'}\n` +
      `**Mode Loop:** ${isLoopQueue ? '🔁 Aktif (Berulang)' : '➡️ Sekali Putar'}\n\n` +
      `📋 **LAGU BERIKUTNYA (UP NEXT):**\n${queueListText}`
    )
    .setFooter({ text: 'Klik tombol di bawah atau ketik !seek <menit:detik>' });
}

function buildPlayerButtons(isPaused = false) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_player_rewind10').setLabel('-10s').setStyle(ButtonStyle.Secondary).setEmoji('⏪'),
    new ButtonBuilder().setCustomId('btn_player_playpause').setEmoji(isPaused ? '▶️' : '⏸️').setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_player_forward10').setLabel('+10s').setStyle(ButtonStyle.Secondary).setEmoji('⏩'),
    new ButtonBuilder().setCustomId('btn_player_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_player_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_player_shuffle').setEmoji('🔀').setLabel('Shuffle').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_player_loop').setEmoji('🔁').setLabel('Loop').setStyle(isLoopQueue ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );

  return [row1, row2];
}

async function sendPlayerCard(track, isPaused = false) {
  if (!activeTextChannel) return;
  const embed = buildPlayerEmbed(track, isPaused);
  const rows = buildPlayerButtons(isPaused);

  try {
    if (lastPlayerMessage) {
      await lastPlayerMessage.delete().catch(() => {});
    }
    lastPlayerMessage = await activeTextChannel.send({ embeds: [embed], components: rows });
  } catch (err) {
    console.error('Error kirim player card:', err);
  }
}

// Memutar Lagu Berikutnya di Antrean
function playNextSong() {
  if (musicQueue.length === 0) {
    currentTrack = null;
    if (lastPlayerMessage) {
      const finishedEmbed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle('⏹️ Pemutaran Selesai')
        .setDescription('Semua antrean lagu telah habis.');
      lastPlayerMessage.edit({ embeds: [finishedEmbed], components: [] }).catch(() => {});
      lastPlayerMessage = null;
    }
    return;
  }

  currentTrack = musicQueue.shift();
  currentTrack.startedAt = Date.now();
  currentTrack.seekOffset = 0;

  if (currentTrack.type === 'file') {
    const resource = createAudioResource(fs.createReadStream(currentTrack.path), {
      inputType: StreamType.Arbitrary,
      inlineVolume: true
    });
    if (resource.volume) resource.volume.setVolume(0.8);
    player.play(resource);
    sendPlayerCard(currentTrack, false);
  } else if (currentTrack.type === 'stream') {
    fetchAudioStream(currentTrack.url, stream => {
      const resource = createAudioResource(stream, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true
      });
      player.play(resource);
    });
    sendPlayerCard(currentTrack, false);
  }
}

player.on(AudioPlayerStatus.Idle, () => {
  if (isLoopQueue && currentTrack && currentTrack.type === 'file') {
    musicQueue.push(currentTrack);
  }
  playNextSong();
});

player.on('error', error => {
  console.error('❌ Audio Player Error:', error.message);
  playNextSong();
});

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
    return message.reply(`🎧 **Panduan Musik Player:**\n\n` +
      `📁 **PLAYLIST & LAGU:**\n` +
      `• \`!playlists\` : Lihat semua kategori playlist folder\n` +
      `• \`!playlist <nama>\` : Lihat lagu di dalam satu playlist\n` +
      `• \`!play <nama playlist>\` : Putar seluruh lagu di playlist berurutan\n` +
      `• \`!play <nama lagu>\` : Putar 1 lagu tertentu\n\n` +
      `⏩ **SEEK & NAVIGASI:**\n` +
      `• \`!seek <mm:ss>\` : Melompat langsung ke menit tertentu (contoh: \`!seek 01:30\`)\n` +
      `• \`!forward <detik>\` | \`!rewind <detik>\` : Maju / mundur waktu\n\n` +
      `📻 **RADIO LIVE:**\n` +
      `• \`!radio\` : Lihat daftar channel radio live (contoh: \`!radio lofi\`)\n\n` +
      `🎛️ **KONTROL TOMBOL:**\n` +
      `Gunakan tombol interaktif di bawah Player Card untuk Play, Pause, Skip, Rewind, Shuffle, dan Loop!`);
  }

  // 2. SEEK KE POSISI TERTENTU (!seek 01:30)
  if (message.content.startsWith('!seek')) {
    const arg = message.content.split(' ')[1];
    if (!arg) return message.reply('⚠️ Format: `!seek <menit:detik>` (contoh: `!seek 01:30`).');
    if (!currentTrack || currentTrack.type !== 'file') return message.reply('⚠️ Tidak ada lagu dari folder yang sedang diputar.');

    const targetSeconds = parseTimeToSeconds(arg);
    if (targetSeconds === null || targetSeconds < 0) return message.reply('⚠️ Format waktu tidak valid! Contoh: `!seek 02:45`.');

    executeSeek(targetSeconds);
    return message.reply(`⏩ Melompat ke menit **${formatTime(targetSeconds)}**! 🔊`);
  }

  // 3. PUTAR RADIO (!radio)
  if (message.content.startsWith('!radio')) {
    const args = message.content.split(' ').slice(1);
    const stationKey = args[0] ? args[0].toLowerCase() : null;

    if (!stationKey || !RADIO_STATIONS[stationKey]) {
      const list = Object.entries(RADIO_STATIONS).map(([k, v]) => `• \`!radio ${k}\` ➔ **${v.name}**`).join('\n');
      return message.reply(`📻 **Pilihan Channel Radio Live 24/7:**\n${list}\n\n*Contoh: \`!radio lofi\`*`);
    }

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('⚠️ Kamu harus masuk ke Voice Channel terlebih dahulu!');

    const station = RADIO_STATIONS[stationKey];
    connectVoice(message, voiceChannel);

    musicQueue = [];
    currentTrack = { title: `Siaran Radio: ${station.name}`, url: station.url, type: 'stream' };

    fetchAudioStream(station.url, stream => {
      const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
      if (resource.volume) resource.volume.setVolume(0.8);
      player.play(resource);
    });

    sendPlayerCard(currentTrack, false);
    return;
  }

  // 4. LIHAT PLAYLIST (!playlists)
  if (message.content === '!playlists') {
    const playlists = getPlaylists();
    if (playlists.length === 0) return message.reply('📂 Belum ada folder playlist di `Music`.');
    const list = playlists.map((p, i) => `${i + 1}. 📁 **${p.name}** — ${p.songs.length} lagu (\`!play ${p.name}\`)`).join('\n');
    return message.reply(`📂 **Daftar Playlist Tersedia:**\n${list}\n\n*Ketik \`!play <nama playlist>\` untuk memutar!*`);
  }

  // 5. LIHAT LAGU DI SATU PLAYLIST (!playlist <nama>)
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

  // 6. PUTAR LAGU / PLAYLIST (!play <nama>)
  if (message.content.startsWith('!play')) {
    const query = message.content.split(' ').slice(1).join(' ').trim();
    if (!query) return message.reply('⚠️ Gunakan: `!play <nama playlist>` atau `!play <nama lagu>`.');

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('⚠️ Kamu harus masuk ke Voice Channel terlebih dahulu!');

    connectVoice(message, voiceChannel);

    // Cek nama playlist (folder)
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

      message.reply(`📁 Berhasil memuat **${matchedPlaylist.songs.length} lagu** dari playlist **${matchedPlaylist.name}**! 🎶`);
      if (wasEmpty) {
        playNextSong();
      } else if (currentTrack) {
        sendPlayerCard(currentTrack, false); // Update tampilan antrean langsung
      }
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
        message.reply(`➕ Menambahkan **${singleSong.title}** ke antrean.`);
        if (currentTrack) sendPlayerCard(currentTrack, false); // Update tampilan antrean langsung
      }
      return;
    }

    return message.reply(`❌ Tidak ditemukan lagu atau playlist **"${query}"**.`);
  }

  // 7. QUEUE LENGKAP (!queue)
  if (message.content === '!queue') {
    if (!currentTrack && musicQueue.length === 0) return message.reply('📭 Antrean musik saat ini kosong.');

    let text = `🎶 **Sedang Diputar:** \`${currentTrack ? currentTrack.title : 'Tidak ada'}\`\n\n📋 **Daftar Antrean Lengkap:**\n`;
    if (musicQueue.length === 0) {
      text += '*Tidak ada lagu lagi di antrean.*';
    } else {
      text += musicQueue.slice(0, 15).map((s, i) => `${i + 1}. \`${s.title}\``).join('\n');
      if (musicQueue.length > 15) {
        text += `\n*...dan ${musicQueue.length - 15} lagu lainnya.*`;
      }
    }
    return message.reply(text);
  }

  // 8. VERIFIKASI (Admin)
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

// --- INTERAKSI TOMBOL CONTROLLER ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  // Verifikasi Member
  if (interaction.customId === 'btn_verify') {
    const roleId = process.env.VERIFIED_ROLE_ID;
    if (!roleId) return interaction.reply({ content: '⚠️ ID Role belum diatur.', ephemeral: true });
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) return interaction.reply({ content: '⚠️ Role tidak ditemukan.', ephemeral: true });
    if (interaction.member.roles.cache.has(roleId)) {
      return interaction.reply({ content: 'ℹ️ Kamu sudah terverifikasi!', ephemeral: true });
    }

    const daysDiff = (Date.now() - interaction.user.createdTimestamp) / (1000 * 60 * 60 * 24);
    if (daysDiff < 30) {
      return interaction.reply({ content: `❌ Umur akun baru **${Math.floor(daysDiff)} hari**. Minimal 30 hari.`, ephemeral: true });
    }

    try {
      await interaction.member.roles.add(role);
      return interaction.reply({ content: '🎉 Berhasil diverifikasi!', ephemeral: true });
    } catch (err) {
      return interaction.reply({ content: '⚠️ Gagal memberi role.', ephemeral: true });
    }
  }

  // Tombol Musik
  if (interaction.customId.startsWith('btn_player_')) {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: '⚠️ Kamu harus berada di Voice Channel!', ephemeral: true });
    }

    // REWIND 10s
    if (interaction.customId === 'btn_player_rewind10') {
      if (!currentTrack || currentTrack.type !== 'file') return interaction.reply({ content: '⚠️ Tidak bisa rewind pada siaran radio.', ephemeral: true });
      const newPos = Math.max(0, getCurrentPlaybackSeconds() - 10);
      executeSeek(newPos);
      return interaction.reply({ content: `⏪ Mundur ke **${formatTime(newPos)}**`, ephemeral: true });
    }

    // FORWARD 10s
    if (interaction.customId === 'btn_player_forward10') {
      if (!currentTrack || currentTrack.type !== 'file') return interaction.reply({ content: '⚠️ Tidak bisa forward pada siaran radio.', ephemeral: true });
      const newPos = getCurrentPlaybackSeconds() + 10;
      executeSeek(newPos);
      return interaction.reply({ content: `⏩ Maju ke **${formatTime(newPos)}**`, ephemeral: true });
    }

    // PLAY / PAUSE
    if (interaction.customId === 'btn_player_playpause') {
      if (!currentTrack) return interaction.reply({ content: '⚠️ Tidak ada lagu berputar.', ephemeral: true });
      if (player.state.status === AudioPlayerStatus.Playing) {
        player.pause();
        const embed = buildPlayerEmbed(currentTrack, true);
        const rows = buildPlayerButtons(true);
        await interaction.update({ embeds: [embed], components: rows });
      } else {
        player.unpause();
        const embed = buildPlayerEmbed(currentTrack, false);
        const rows = buildPlayerButtons(false);
        await interaction.update({ embeds: [embed], components: rows });
      }
      return;
    }

    // SKIP
    if (interaction.customId === 'btn_player_skip') {
      if (!currentTrack) return interaction.reply({ content: '⚠️ Tidak ada lagu untuk di-skip.', ephemeral: true });
      await interaction.reply({ content: `⏭️ **${interaction.user.username}** melewati lagu.`, ephemeral: false });
      player.stop();
      return;
    }

    // SHUFFLE
    if (interaction.customId === 'btn_player_shuffle') {
      if (musicQueue.length <= 1) return interaction.reply({ content: '⚠️ Butuh minimal 2 lagu untuk shuffle.', ephemeral: true });
      shuffleArray(musicQueue);
      if (currentTrack) {
        const embed = buildPlayerEmbed(currentTrack, false);
        const rows = buildPlayerButtons(false);
        await interaction.update({ embeds: [embed], components: rows });
      }
      return interaction.reply({ content: '🔀 **Antrean berhasil diacak! Urutan lagu diperbarui di Player Card.**', ephemeral: true });
    }

    // LOOP
    if (interaction.customId === 'btn_player_loop') {
      isLoopQueue = !isLoopQueue;
      if (currentTrack) {
        const embed = buildPlayerEmbed(currentTrack, false);
        const rows = buildPlayerButtons(false);
        await interaction.update({ embeds: [embed], components: rows });
      }
      return interaction.reply({ content: `🔁 Mode Loop sekarang: **${isLoopQueue ? 'AKTIF' : 'NONAKTIF'}**`, ephemeral: true });
    }

    // STOP
    if (interaction.customId === 'btn_player_stop') {
      musicQueue = [];
      currentTrack = null;
      player.stop();
      const conn = getVoiceConnection(interaction.guild.id);
      if (conn) conn.destroy();

      const stoppedEmbed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('⏹️ Pemutar Musik Dimatikan')
        .setDescription(`Musik dihentikan oleh **${interaction.user.username}**.`);

      await interaction.update({ embeds: [stoppedEmbed], components: [] });
      lastPlayerMessage = null;
      return;
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
