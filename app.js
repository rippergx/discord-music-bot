const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

require('dotenv').config();
const http = require('http');
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
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
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

// Fungsi Pemutar Stream URL via FFmpeg Transcoder
function createStreamResource(streamUrl) {
  const ffmpeg = new prism.FFmpeg({
    args: [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', streamUrl,
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2'
    ]
  });

  ffmpeg.on('error', err => console.error('FFmpeg Stream Error:', err.message));

  return createAudioResource(ffmpeg, {
    inputType: StreamType.Raw,
    inlineVolume: true
  });
}

player.on(AudioPlayerStatus.Playing, () => {
  console.log('🎶 Audio Player: Sedang memutar suara.');
});

player.on(AudioPlayerStatus.Idle, () => {
  console.log('⏹️ Audio Player: Selesai / idle.');
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
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
      });

      currentConnection = connection;

      // Debugging suara agar terpantau di Deploy Logs Railway
      connection.on('stateChange', (oldState, newState) => {
        console.log(`📡 Voice State: ${oldState.status} -> ${newState.status}`);
      });
      connection.on('debug', msg => {
        console.log(`🔍 Voice Debug: ${msg}`);
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

      const resource = createStreamResource(station.url);
      player.play(resource);
      connection.subscribe(player);

      return message.reply(`📻 Sedang memutar siaran: **${station.name}** di channel **${voiceChannel.name}**! 🔊`);
    } catch (err) {
      console.error('Error saat koneksi radio:', err);
      if (currentConnection) {
        currentConnection.destroy();
        currentConnection = null;
      }
      return message.reply('⚠️ Terjadi error saat menghubungkan audio ke voice channel.');
    }
  }

  // 2. STOP (!stop)
  if (message.content === '!stop') {
    player.stop();
    if (currentConnection) {
      currentConnection.destroy();
      currentConnection = null;
    }
    return message.reply('⏹️ Musik dihentikan dan bot keluar dari Voice Channel.');
  }

  // 3. PAUSE / RESUME
  if (message.content === '!pause') {
    player.pause();
    return message.reply('⏸️ Musik dijeda.');
  }
  if (message.content === '!resume') {
    player.unpause();
    return message.reply('▶️ Melanjutkan musik.');
  }

  // 4. SETUP VERIFIKASI (Admin)
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
