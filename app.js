const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

require('dotenv').config();
const http = require('http');
const https = require('https');
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
  res.end('🎵 Discord Music & Radio Bot Online 24/7 on Railway!');
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

const player = createAudioPlayer();
let currentConnection = null;

// Daftar Channel Radio 24/7
const RADIO_STATIONS = {
  lofi: { name: 'Lofi Chill Beats 24/7', url: 'https://streams.ilovemusic.de/iloveradio17.mp3' },
  prambors: { name: 'Prambors FM', url: 'https://stream.zeno.fm/fvrx452618uvv' },
  genfm: { name: 'Gen FM Jakarta', url: 'https://stream.zeno.fm/7k94r6y1m4zuv' },
  hardrock: { name: 'Hard Rock FM', url: 'https://stream.zeno.fm/u2213718v8zuv' }
};

// Fungsi Ambil Stream Audio Langsung (Mendukung Redirect HTTP/HTTPS)
function fetchAudioStream(url, callback) {
  const lib = url.startsWith('https') ? https : http;
  lib.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  }, res => {
    // Tangani Redirect (301, 302, 307)
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      console.log(`🔀 Mengikuti redirect radio ke: ${res.headers.location}`);
      return fetchAudioStream(res.headers.location, callback);
    }
    if (res.statusCode !== 200) {
      console.error(`⚠️ Server radio merespon status code: ${res.statusCode}`);
      return;
    }
    callback(res);
  }).on('error', err => {
    console.error('❌ Error koneksi stream radio:', err.message);
  });
}

player.on(AudioPlayerStatus.Playing, () => {
  console.log('🎶 Audio Player: Sedang memutar suara ke Voice Channel!');
});

player.on(AudioPlayerStatus.Idle, () => {
  console.log('⏹️ Audio Player: Idle.');
});

player.on('error', error => {
  console.error('❌ Audio Player Error:', error.message);
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);
});

// --- PERINTAH DISCORD ---
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;

  // 1. PUTAR RADIO (!radio lofi)
  if (message.content.startsWith('!radio')) {
    const args = message.content.split(' ').slice(1);
    const stationKey = args[0] ? args[0].toLowerCase() : null;

    if (!stationKey || !RADIO_STATIONS[stationKey]) {
      const list = Object.entries(RADIO_STATIONS)
        .map(([k, v]) => `• \`!radio ${k}\` ➔ ${v.name}`)
        .join('\n');
      return message.reply(`📻 **Pilihan Channel Radio:**\n${list}\n\n*Contoh: Ketik \`!radio lofi\` saat berada di voice channel.*`);
    }

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply('⚠️ Kamu harus masuk ke salah satu Voice Channel terlebih dahulu!');
    }

    const station = RADIO_STATIONS[stationKey];
    try {
      // Bersihkan koneksi lama
      const existingConn = getVoiceConnection(message.guild.id);
      if (existingConn) {
        existingConn.destroy();
      }

      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
      });

      currentConnection = connection;
      connection.subscribe(player);

      connection.on('stateChange', (oldState, newState) => {
        console.log(`📡 Voice State: ${oldState.status} -> ${newState.status}`);
      });

      // Ambil stream live dan putar
      fetchAudioStream(station.url, stream => {
        const resource = createAudioResource(stream, {
          inputType: StreamType.Arbitrary,
          inlineVolume: true
        });

        if (resource.volume) {
          resource.volume.setVolume(0.8);
        }

        player.play(resource);
        console.log(`🔊 Berhasil menyalurkan audio ${station.name}!`);
      });

      return message.reply(`📻 Bergabung ke **${voiceChannel.name}** dan memutar **${station.name}**! 🔊`);
    } catch (err) {
      console.error('Error saat koneksi radio:', err);
      return message.reply('⚠️ Terjadi error saat menghubungkan audio.');
    }
  }

  // 2. PUTAR LINK MP3 / STREAM BEBAS (!play <url>)
  if (message.content.startsWith('!play')) {
    const args = message.content.split(' ').slice(1);
    const targetUrl = args[0];

    if (!targetUrl || !targetUrl.startsWith('http')) {
      return message.reply('⚠️ Gunakan format: `!play <URL_MP3>` atau gunakan `!radio` untuk radio.');
    }

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply('⚠️ Kamu harus masuk ke Voice Channel terlebih dahulu!');
    }

    try {
      const existingConn = getVoiceConnection(message.guild.id);
      if (existingConn) {
        existingConn.destroy();
      }

      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
      });

      currentConnection = connection;
      connection.subscribe(player);

      fetchAudioStream(targetUrl, stream => {
        const resource = createAudioResource(stream, {
          inputType: StreamType.Arbitrary,
          inlineVolume: true
        });
        player.play(resource);
      });

      return message.reply(`🎵 Memutar audio di **${voiceChannel.name}**! 🔊`);
    } catch (err) {
      console.error('Error audio:', err);
      return message.reply('⚠️ Terjadi error saat memutar audio.');
    }
  }

  // 3. STOP (!stop)
  if (message.content === '!stop') {
    player.stop();
    const conn = getVoiceConnection(message.guild.id);
    if (conn) {
      conn.destroy();
      currentConnection = null;
    }
    return message.reply('⏹️ Musik dihentikan dan bot keluar dari Voice Channel.');
  }

  // 4. PAUSE / RESUME
  if (message.content === '!pause') {
    player.pause();
    return message.reply('⏸️ Musik dijeda.');
  }
  if (message.content === '!resume') {
    player.unpause();
    return message.reply('▶️ Melanjutkan musik.');
  }

  // 5. SETUP VERIFIKASI (Admin)
  if (message.content === '!setup-verify') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('❌ Kamu harus Administrator untuk perintah ini.');
    }

    const embed = new EmbedBuilder()
      .setTitle('🛡️ Verifikasi Member')
      .setDescription('Selamat datang!\n\nKlik tombol **Verifikasi** di bawah untuk membuka seluruh akses channel.\n\n*Syarat: Umur akun minimal 30 hari.*')
      .setColor('#2b2d31')
      .setFooter({ text: 'Sistem Keamanan Server' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('btn_verify')
        .setLabel('Verifikasi')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅')
    );

    await message.channel.send({ embeds: [embed], components: [row] });
    return message.delete().catch(() => {});
  }
});

// INTERAKSI VERIFIKASI
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
      content: `❌ Umur akun kamu baru **${Math.floor(daysDiff)} hari**. Minimal 30 hari.`,
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
