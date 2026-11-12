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
  res.end('🎵 Discord Multi-Server Music Bot Online 24/7!');
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

// --- SISTEM MULTI-SERVER (SETIAP SERVER MEMILIKI PLAYER & ANTREAN SENDIRI) ---
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
      lastPlayerMessage: null
    };

    // Otomatis putar lagu berikutnya saat lagu selesai di server ini
    newPlayer.on(AudioPlayerStatus.Idle, () => {
      console.log(`[Server ${guildId}] Lagu selesai, lanjut lagu berikutnya...`);
      if (mgr.isLoopQueue && mgr.currentTrack && mgr.currentTrack.type === 'file') {
        mgr.musicQueue.push(mgr.currentTrack);
      }
      playNextSong(guildId);
    });

    newPlayer.on('error', error => {
      console.error(`[Server ${guildId}] Audio Error:`, error.message);
      playNextSong(guildId);
    });

    guildManagers.set(guildId, mgr);
  }
  return mgr;
}

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

function getCurrentPlaybackSeconds(mgr) {
  if (!mgr || !mgr.currentTrack || !mgr.currentTrack.startedAt) return 0;
  const elapsed = (Date.now() - mgr.currentTrack.startedAt) / 1000;
  return Math.max(0, (mgr.currentTrack.seekOffset || 0) + elapsed);
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
function executeSeek(guildId, targetSeconds) {
  const mgr = getGuildManager(guildId);
  if (!mgr || !mgr.currentTrack || mgr.currentTrack.type !== 'file') return false;

  mgr.currentTrack.seekOffset = Math.max(0, targetSeconds);
  mgr.currentTrack.startedAt = Date.now();

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
  sendPlayerCard(guildId, mgr.currentTrack, false);
  return true;
}

// --- TAMPILAN CONTROLLER CARD (PER SERVER) ---
function buildPlayerEmbed(mgr, track, isPaused = false) {
  const currentPos = formatTime(getCurrentPlaybackSeconds(mgr));

  let queueListText = '';
  if (mgr.musicQueue.length === 0) {
    queueListText = '_Tidak ada lagu di antrean._';
  } else {
    const previewCount = 4;
    const upcoming = mgr.musicQueue.slice(0, previewCount);
    queueListText = upcoming.map((song, idx) => `**${idx + 1}.** 🎵 \`${song.title}\``).join('\n');
    if (mgr.musicQueue.length > previewCount) {
      queueListText += `\n*...dan +${mgr.musicQueue.length - previewCount} lagu lainnya di antrean.*`;
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
    console.error('Error kirim player card:', err);
  }
}

// Memutar Lagu Berikutnya di Antrean Server Tertentu
function playNextSong(guildId) {
  const mgr = getGuildManager(guildId);
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
  mgr.currentTrack.seekOffset = 0;

  if (mgr.currentTrack.type === 'file') {
    const resource = createAudioResource(fs.createReadStream(mgr.currentTrack.path), {
      inputType: StreamType.Arbitrary,
      inlineVolume: true
    });
    if (resource.volume) resource.volume.setVolume(0.8);
    mgr.player.play(resource);
    sendPlayerCard(guildId, mgr.currentTrack, false);
  } else if (mgr.currentTrack.type === 'stream') {
    fetchAudioStream(mgr.currentTrack.url, stream => {
      const resource = createAudioResource(stream, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true
      });
      mgr.player.play(resource);
    });
    sendPlayerCard(guildId, mgr.currentTrack, false);
  }
}

function connectVoice(message, voiceChannel) {
  const mgr = getGuildManager(message.guild.id);
  mgr.activeTextChannel = message.channel;

  let connection = getVoiceConnection(message.guild.id);
  if (!connection) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });
    connection.subscribe(mgr.player);
  }
  return connection;
}

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}! Multi-Server Ready.`);
});

// --- COMMAND HANDLER ---
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  const guildId = message.guild.id;
  const mgr = getGuildManager(guildId);

  // 1. HELP (!help)
  if (message.content === '!help') {
    return message.reply(`🎧 **Panduan Musik Player (Multi-Server):**\n\n` +
      `📁 **PLAYLIST & LAGU:**\n` +
      `• \`!playlists\` : Lihat semua kategori playlist folder\n` +
      `• \`!playlist <nama>\` : Lihat lagu di dalam satu playlist\n` +
      `• \`!play <nama playlist>\` : Putar seluruh lagu di playlist berurutan\n` +
      `• \`!play <nama lagu>\` : Putar 1 lagu tertentu\n\n` +
      `⏩ **SEEK & NAVIGASI:**\n` +
      `• \`!seek <mm:ss>\` : Melompat ke menit tertentu (contoh: \`!seek 01:30\`)\n` +
      `• \`!forward <detik>\` | \`!rewind <detik>\` : Maju / mundur waktu\n\n` +
      `📻 **RADIO LIVE:**\n` +
      `• \`!radio\` : Lihat daftar channel radio live\n` +
      `• \`!radio <nama>\` : Putar radio live (contoh: \`!radio lofi\`)\n\n` +
      `🎛️ **KONTROL TOMBOL:**\n` +
      `Gunakan tombol interaktif di bawah Player Card untuk Play, Pause, Skip, Rewind, Shuffle, dan Loop!`);
  }

  // 2. SEEK KE POSISI TERTENTU (!seek 01:30)
  if (message.content.startsWith('!seek')) {
    const arg = message.content.split(' ')[1];
    if (!arg) return message.reply('⚠️ Format: `!seek <menit:detik>` (contoh: `!seek 01:30`).');
    if (!mgr.currentTrack || mgr.currentTrack.type !== 'file') return message.reply('⚠️ Tidak ada lagu dari folder yang sedang diputar.');

    const targetSeconds = parseTimeToSeconds(arg);
    if (targetSeconds === null || targetSeconds < 0) return message.reply('⚠️ Format waktu tidak valid! Contoh: `!seek 02:45`.');

    executeSeek(guildId, targetSeconds);
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

    mgr.musicQueue = [];
    mgr.currentTrack = { title: `Siaran Radio: ${station.name}`, url: station.url, type: 'stream' };

    fetchAudioStream(station.url, stream => {
      const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
      if (resource.volume) resource.volume.setVolume(0.8);
      mgr.player.play(resource);
    });

    sendPlayerCard(guildId, mgr.currentTrack, false);
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

    // Cek lagu tunggal
    const singleSong = findSingleSong(query);
    if (singleSong) {
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

    return message.reply(`❌ Tidak ditemukan lagu atau playlist **"${query}"**.`);
  }

  // 7. QUEUE LENGKAP (!queue)
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

// --- INTERAKSI TOMBOL CONTROLLER (PER SERVER) ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const guildId = interaction.guild.id;
  const mgr = getGuildManager(guildId);

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

  // Tombol Musik (Khusus Server Ini Saja)
  if (interaction.customId.startsWith('btn_player_')) {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: '⚠️ Kamu harus berada di Voice Channel!', ephemeral: true });
    }

    // REWIND 10s
    if (interaction.customId === 'btn_player_rewind10') {
      if (!mgr.currentTrack || mgr.currentTrack.type !== 'file') return interaction.reply({ content: '⚠️ Tidak bisa rewind pada siaran radio.', ephemeral: true });
      const newPos = Math.max(0, getCurrentPlaybackSeconds(mgr) - 10);
      executeSeek(guildId, newPos);
      return interaction.reply({ content: `⏪ Mundur ke **${formatTime(newPos)}**`, ephemeral: true });
    }

    // FORWARD 10s
    if (interaction.customId === 'btn_player_forward10') {
      if (!mgr.currentTrack || mgr.currentTrack.type !== 'file') return interaction.reply({ content: '⚠️ Tidak bisa forward pada siaran radio.', ephemeral: true });
      const newPos = getCurrentPlaybackSeconds(mgr) + 10;
      executeSeek(guildId, newPos);
      return interaction.reply({ content: `⏩ Maju ke **${formatTime(newPos)}**`, ephemeral: true });
    }

    // PLAY / PAUSE
    if (interaction.customId === 'btn_player_playpause') {
      if (!mgr.currentTrack) return interaction.reply({ content: '⚠️ Tidak ada lagu berputar.', ephemeral: true });
      if (mgr.player.state.status === AudioPlayerStatus.Playing) {
        mgr.player.pause();
        const embed = buildPlayerEmbed(mgr, mgr.currentTrack, true);
        const rows = buildPlayerButtons(mgr, true);
        await interaction.update({ embeds: [embed], components: rows });
      } else {
        mgr.player.unpause();
        const embed = buildPlayerEmbed(mgr, mgr.currentTrack, false);
        const rows = buildPlayerButtons(mgr, false);
        await interaction.update({ embeds: [embed], components: rows });
      }
      return;
    }

    // SKIP
    if (interaction.customId === 'btn_player_skip') {
      if (!mgr.currentTrack) return interaction.reply({ content: '⚠️ Tidak ada lagu untuk di-skip.', ephemeral: true });
      await interaction.reply({ content: `⏭️ **${interaction.user.username}** melewati lagu.`, ephemeral: false });
      mgr.player.stop();
      return;
    }

    // SHUFFLE
    if (interaction.customId === 'btn_player_shuffle') {
      if (mgr.musicQueue.length <= 1) return interaction.reply({ content: '⚠️ Butuh minimal 2 lagu untuk shuffle.', ephemeral: true });
      shuffleArray(mgr.musicQueue);
      if (mgr.currentTrack) {
        const embed = buildPlayerEmbed(mgr, mgr.currentTrack, false);
        const rows = buildPlayerButtons(mgr, false);
        await interaction.update({ embeds: [embed], components: rows });
      }
      return interaction.reply({ content: '🔀 **Antrean di server ini berhasil diacak!**', ephemeral: true });
    }

    // LOOP
    if (interaction.customId === 'btn_player_loop') {
      mgr.isLoopQueue = !mgr.isLoopQueue;
      if (mgr.currentTrack) {
        const embed = buildPlayerEmbed(mgr, mgr.currentTrack, false);
        const rows = buildPlayerButtons(mgr, false);
        await interaction.update({ embeds: [embed], components: rows });
      }
      return interaction.reply({ content: `🔁 Mode Loop di server ini: **${mgr.isLoopQueue ? 'AKTIF' : 'NONAKTIF'}**`, ephemeral: true });
    }

    // STOP
    if (interaction.customId === 'btn_player_stop') {
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

client.login(process.env.DISCORD_TOKEN);
