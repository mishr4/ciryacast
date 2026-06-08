const { Client, GatewayIntentBits, ChannelType, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const fetch = require('node-fetch');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.DirectMessages],
});

const player = createAudioPlayer();
let connection = null;
let currentStation = null;

const RADIO_ONE_ID = process.env.RADIO_ONE_STATION_ID || '605617ec-9fa6-4e84-be47-cbdab6550229';
const API_URL = process.env.API_URL || 'http://localhost:3000';

client.once('ready', () => {
  console.log(`🎙️  Discord bot logged in as ${client.user.tag}`);
  client.user.setActivity('🎵 Radio One', { type: 'LISTENING' });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    if (commandName === 'play') {
      await handlePlay(interaction);
    } else if (commandName === 'stop') {
      await handleStop(interaction);
    } else if (commandName === 'now') {
      await handleNowPlaying(interaction);
    }
  } catch (error) {
    console.error(`Error handling /${commandName}:`, error);
    await interaction.reply({
      content: '❌ Something went wrong!',
      ephemeral: true,
    });
  }
});

async function handlePlay(interaction) {
  await interaction.deferReply();

  // Check if user is in a voice channel
  if (!interaction.member.voice.channel) {
    return interaction.editReply('❌ You need to be in a voice channel first!');
  }

  const voiceChannel = interaction.member.voice.channel;

  try {
    // Join voice channel
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    // Handle connection status changes
    connection.on(VoiceConnectionStatus.Ready, () => {
      console.log('✓ Voice connection ready');
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.log('Voice connection disconnected');
      player.stop();
      connection = null;
      currentStation = null;
    });

    connection.on('error', (error) => {
      console.error('Voice connection error:', error);
    });

    // Get station info
    const stationRes = await fetch(`${API_URL}/api/stations/${RADIO_ONE_ID}`);
    const station = await stationRes.json();

    // Create audio resource
    const streamUrl = `${API_URL}/listen/${RADIO_ONE_ID}/radio.mp3`;
    const resource = createAudioResource(streamUrl, {
      inlineVolume: true,
    });

    // Set volume to 50%
    resource.volume.setVolume(0.5);

    // Play
    player.play(resource);
    connection.subscribe(player);

    currentStation = station;

    // Send embed
    const embed = new EmbedBuilder()
      .setColor('#7C4DFF')
      .setTitle('🎙️ Now Playing')
      .setDescription(`**${station.name}**\n${station.description || 'Radio One'}`)
      .setThumbnail(station.logo_url || null)
      .addFields(
        { name: 'Status', value: 'Connected ✓', inline: true },
        { name: 'Listeners', value: `${station.listeners || 0}`, inline: true }
      )
      .setFooter({ text: 'Use /now to see what\'s playing' });

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Play error:', error);
    await interaction.editReply('❌ Failed to join voice channel or stream');
  }
}

async function handleStop(interaction) {
  if (!connection) {
    return interaction.reply({
      content: '❌ Not connected to a voice channel',
      ephemeral: true,
    });
  }

  player.stop();
  connection.destroy();
  connection = null;
  currentStation = null;

  await interaction.reply('⏹️ Stopped playback and disconnected');
}

async function handleNowPlaying(interaction) {
  if (!currentStation) {
    return interaction.reply({
      content: '❌ Not currently playing anything',
      ephemeral: true,
    });
  }

  try {
    const res = await fetch(`${API_URL}/api/nowplaying/${RADIO_ONE_ID}`);
    const data = await res.json();
    const np = data.now_playing;

    const embed = new EmbedBuilder()
      .setColor('#FF48BC')
      .setTitle('🎵 Now Playing on Radio One')
      .setThumbnail(np?.artwork_url || currentStation.logo_url)
      .addFields(
        { name: 'Song', value: np?.title || 'Unknown', inline: false },
        { name: 'Artist', value: np?.artist || 'Unknown', inline: false },
        { name: 'Duration', value: `${Math.floor((np?.elapsed || 0) / 60)}:${String((np?.elapsed || 0) % 60).padStart(2, '0')} / ${Math.floor((np?.duration || 0) / 60)}:${String((np?.duration || 0) % 60).padStart(2, '0')}`, inline: true },
        { name: 'Listeners', value: `${data.listeners?.current || 0}`, inline: true }
      )
      .setFooter({ text: 'CiryaCast Radio One' });

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Now playing error:', error);
    await interaction.reply('❌ Failed to fetch current track info');
  }
}

// Register slash commands
client.once('ready', async () => {
  const commands = [
    {
      name: 'play',
      description: 'Play Cirya Radio One in your voice channel',
    },
    {
      name: 'stop',
      description: 'Stop playback and disconnect',
    },
    {
      name: 'now',
      description: 'See what\'s currently playing',
    },
  ];

  try {
    await client.application.commands.set(commands);
    console.log('✓ Slash commands registered');
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ DISCORD_TOKEN environment variable not set');
  process.exit(1);
}

client.login(token);
