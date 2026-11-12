const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

require('dotenv').config();
const http = require('http');
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
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType
} = require('@discordjs/voice');

// --- WEB SERVER (AGAR RAILWAY HEALTHCHECK HIJAU & ONLINE 24/7) ---
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('🎵 Discord Music & Verification Bot is Online 24/7 on Railway!');
}).listen(PORT, () => {
  console.log(`🚀 Web server listening on port ${PORT}`);
});

// --- DISCORD CLIENT SETUP ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// Audio Player tunggal
const player = createAudioPlayer();
let currentConnection = null;

// Daftar Channel Radio Siap Putar
const RADIO_STATIONS = {
  prambors: { name: 'Prambors FM', url: 'https://stream.zeno.fm/fvrx452618uvv' },
  genfm: { name: 'Gen FM Jakarta', url: 'https://stream.zeno.fm/7k94r6y1m4zuv' },
  lofi: { name: 'Lofi Chill Beats', url: 'https://streams.ilovemusic.de/iloveradio17.mp3' },
  hardrock: { name: 'Hard Rock FM', url: 'https://stream.zeno.fm/u2213718v8zuv' }
};

player.on(AudioPlayerStatus.Playing, () => {
  console.log('🎶 Audio Player: Sedang memutar audio.');
});

player.on(AudioPlayerStatus.Idle, () => {
  console.log('⏹️ Audio Player: Pemutaran selesai / idle.');
});

player.on('error', error => {
  console.error('❌ Audio Player Error:', error.message);
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);
});

// --- COMMAND HANDLER ---
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;

  // 1. SETUP VERIFIKASI (Admin)
  if (message.content === '!setup-verify') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('❌ Kamu harus menjadi Administrator untuk menjalankan perintah ini.');
    }

    const embed = new EmbedBuilder()
      .setTitle('🛡️ Verifikasi Member')
      .setDescription('Selamat datang di server kami!\n\nUntuk mendapatkan akses penuh ke seluruh channel, silakan klik tombol **Verifikasi** di bawah.\n\n*Catatan: Akun Discord kamu harus berusia minimal 30 hari.*')
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

  // 2. PUTAR RADIO (!radio atau !radio prambors)
  if (message.content.startsWith('!radio')) {
    const args = message.content.split(' ').slice(1);
    const stationKey = args[0] ? args[0].toLowerCase() : null;

    if (!stationKey || !RADIO_STATIONS[stationKey]) {
      const list = Object.entries(RADIO_STATIONS)
        .map(([k, v]) => `• \`!radio ${k}\` ➔ ${v.name}`)
        .join('\n');
      return message.reply(`📻 **Pilihan Channel Radio:**\n${list}\n\n*Ketik perintah di atas saat kamu sedang berada di voice channel.*`);
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
      });

      currentConnection = connection;
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

      const resource = createAudioResource(station.url, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true
      });

      player.play(resource);
      connection.subscribe(player);

      return message.reply(`📻 Sedang memutar siaran: **${station.name}** di channel **${voiceChannel.name}**!`);
    } catch (err) {
      console.error('Error saat koneksi radio:', err);
      return message.reply('⚠️ Terjadi error saat menghubungkan audio ke voice channel.');
    }
  }

  // 3. PUTAR URL STREAM/MP3 (!play <url>)
  if (message.content.startsWith('!play')) {
    const args = message.content.split(' ').slice(1);
    const target = args[0];

    if (!target) {
      return message.reply('⚠️ Gunakan format: `!play <URL_MP3_STREAM>` atau gunakan `!radio` untuk siaran radio.');
    }

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply('⚠️ Kamu harus masuk ke salah satu Voice Channel terlebih dahulu!');
    }

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });

      currentConnection = connection;
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

      const resource = createAudioResource(target, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true
      });

      player.play(resource);
      connection.subscribe(player);

      return message.reply(`🎵 Memutar audio di channel **${voiceChannel.name}**!`);
    } catch (err) {
      console.error('Error saat koneksi audio:', err);
      return message.reply('⚠️ Terjadi error saat memutar audio. Pastikan link stream audio valid.');
    }
  }

  // 4. STOP & LEAVE (!stop)
  if (message.content === '!stop') {
    player.stop();
    if (currentConnection) {
      currentConnection.destroy();
      currentConnection = null;
    }
    return message.reply('⏹️ Musik dihentikan dan bot keluar dari Voice Channel.');
  }

  // 5. PAUSE & RESUME
  if (message.content === '!pause') {
    player.pause();
    return message.reply('⏸️ Musik dijeda.');
  }
  if (message.content === '!resume') {
    player.unpause();
    return message.reply('▶️ Melanjutkan musik.');
  }

  // 6. HELP
  if (message.content === '!help') {
    return message.reply(`🎧 **Daftar Perintah Bot:**\n` +
      `• \`!radio\` : Lihat daftar siaran radio yang tersedia\n` +
      `• \`!radio <nama>\` : Putar siaran radio (contoh: \`!radio prambors\`)\n` +
      `• \`!play <url>\` : Putar stream MP3 dari URL langsung\n` +
      `• \`!pause\` / \`!resume\` : Jeda atau lanjutkan musik\n` +
      `• \`!stop\` : Hentikan musik & keluar dari voice channel\n` +
      `• \`!setup-verify\` : Kirim panel verifikasi akun (khusus Admin)`);
  }
});

// --- INTERACTION BUTTON VERIFIKASI ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() || interaction.customId !== 'btn_verify') return;

  const roleId = process.env.VERIFIED_ROLE_ID;
  if (!roleId) {
    return interaction.reply({ content: '⚠️ ID Role verifikasi belum diatur di server bot.', ephemeral: true });
  }

  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) {
    return interaction.reply({ content: '⚠️ Role verifikasi tidak ditemukan.', ephemeral: true });
  }

  if (interaction.member.roles.cache.has(roleId)) {
    return interaction.reply({ content: 'ℹ️ Kamu sudah terverifikasi sebelumnya!', ephemeral: true });
  }

  // Cek umur akun minimal 30 hari
  const now = Date.now();
  const createdTimestamp = interaction.user.createdTimestamp;
  const daysDiff = (now - createdTimestamp) / (1000 * 60 * 60 * 24);

  if (daysDiff < 30) {
    return interaction.reply({
      content: `❌ Umur akun Discord kamu baru **${Math.floor(daysDiff)} hari**. Server ini mewajibkan akun berumur minimal **30 hari**.`,
      ephemeral: true
    });
  }

  try {
    await interaction.member.roles.add(role);
    return interaction.reply({
      content: '🎉 Selamat! Akun kamu berhasil diverifikasi dan akses channel telah dibuka.',
      ephemeral: true
    });
  } catch (error) {
    console.error('Gagal beri role:', error);
    return interaction.reply({
      content: '⚠️ Terjadi kesalahan saat memberikan role. Pastikan posisi role bot berada di atas role member.',
      ephemeral: true
    });
  }
});

// Login Bot
client.login(process.env.DISCORD_TOKEN);
