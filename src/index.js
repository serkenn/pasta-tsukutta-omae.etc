require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const { joinVoiceChannel } = require('@discordjs/voice');
const GuildMusicManager = require('./music/player');

const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const TRIGGER_TEXT = process.env.TRIGGER_TEXT || 'play_local';
const LOCAL_AUDIO = process.env.LOCAL_AUDIO || './audio/sample.mp3';
const TRIGGER_CHANNEL_ID = process.env.TRIGGER_CHANNEL_ID || '';
const TRIGGER_WORDS = (process.env.TRIGGER_WORDS || '僕,俺').split(',').map(s => s.trim()).filter(Boolean);
const BIGWAVE_AUDIO = process.env.BIGWAVE_AUDIO || './audio/bigwave.mp3';
const ARTIST_NAME = process.env.ARTIST_NAME || '湘南乃風';

if (!TOKEN) {
  console.error('BOT_TOKEN is required in .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent]
});

// keep a map of guildId -> manager
const managers = new Map();

function getOrCreateManager(guildId, voiceChannel) {
  if (managers.has(guildId)) return managers.get(guildId);
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });
  const mgr = new GuildMusicManager(connection);
  managers.set(guildId, mgr);
  return mgr;
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // register simple commands to guild for dev
  const commands = [
    { name: 'join', description: 'Join your voice channel' },
    { name: 'leave', description: 'Leave voice channel' },
    { name: 'play', description: 'Play a query or URL', options: [{ name: 'query', type: 3, description: 'Search query or URL', required: true }] },
    { name: 'stop', description: 'Stop playback and clear queue' },
    { name: 'artist', description: 'Start artist loop (forced to 湘南乃風)' },
    { name: 'skip', description: 'Skip current track' },
    { name: 'pause', description: 'Pause' },
    { name: 'resume', description: 'Resume' }
  ];

  if (GUILD_ID) {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) await guild.commands.set(commands);
    else console.warn('GUILD_ID set but guild not in cache on startup');
  } else {
    await client.application.commands.set(commands); // global (may take time)
  }

  // global error handlers to avoid process crash on unhandled rejections
  process.on('unhandledRejection', (reason, p) => {
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
  });
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  try {
    const { commandName } = interaction;
    const member = interaction.member;

    if (commandName === 'join') {
      if (!member.voice.channel) return interaction.reply({ content: 'VCに参加してください', ephemeral: true });
      getOrCreateManager(interaction.guildId, member.voice.channel);
      return interaction.reply('参加しました');
    }

    if (commandName === 'leave') {
      const mgr = managers.get(interaction.guildId);
      if (mgr) {
        try { mgr.connection.destroy(); managers.delete(interaction.guildId); }
        catch(e){}
      }
      return interaction.reply('退出しました');
    }

    if (commandName === 'play') {
      const query = interaction.options.getString('query');
      if (!member.voice.channel) return interaction.reply({ content: 'VCに参加してください', ephemeral: true });
      await interaction.deferReply();
      const mgr = getOrCreateManager(interaction.guildId, member.voice.channel);
      try {
        await mgr.enqueueQuery(query);
        return interaction.editReply(`キューに追加: ${query}`);
      } catch (e) {
        console.error('play command error', e);
        return interaction.editReply(`再生に失敗しました: ${e.message}`);
      }
    }

    if (commandName === 'stop') {
      const mgr = managers.get(interaction.guildId);
      if (mgr) {
        mgr.stop(); // 追加した stop() メソッドを呼ぶ
        return interaction.reply('再生を停止し、キューをクリアしました');
      }
      return interaction.reply({ content: '再生中の曲がありません', ephemeral: true });
    }

    if (commandName === 'artist') {
      if (!member.voice.channel) return interaction.reply({ content: 'VCに参加してください', ephemeral: true });
      await interaction.deferReply();
      const mgr = getOrCreateManager(interaction.guildId, member.voice.channel);
      const seed = [
        '湘南乃風 波音',
        '湘南乃風 純恋歌',
        '湘南乃風 睡蓮',
        '湘南乃風 睡蓮',
        '湘南乃風 僕の見ている風景'
      ];
      try {
        for (let i = 0; i < 10; i++) {
          for (const q of seed) {
            await mgr.enqueueQuery(q).catch(e => console.error('artist enqueue error', e));
          }
        }
        return interaction.editReply('湘南乃風ループを開始しました（湘南乃風のみ流れます）');
      } catch (e) {
        console.error('artist command error', e);
        return interaction.editReply('湘南乃風ループ開始に失敗しました');
      }
    }

    if (commandName === 'skip') {
      const mgr = managers.get(interaction.guildId);
      if (mgr) { mgr.skip(); return interaction.reply('スキップしました'); }
      return interaction.reply({ content: '再生中の曲がありません', ephemeral: true });
    }

    if (commandName === 'pause') {
      const mgr = managers.get(interaction.guildId);
      if (mgr) { mgr.pause(); return interaction.reply('一時停止しました'); }
      return interaction.reply({ content: '再生中の曲がありません', ephemeral: true });
    }

    if (commandName === 'resume') {
      const mgr = managers.get(interaction.guildId);
      if (mgr) { mgr.resume(); return interaction.reply('再開しました'); }
      return interaction.reply({ content: '再生中の曲がありません', ephemeral: true });
    }
  } catch (err) {
    console.error('interactionCreate error', err);
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: '内部エラーが発生しました', ephemeral: true });
      else await interaction.reply({ content: '内部エラーが発生しました', ephemeral: true });
    } catch (e) { console.error('failed to notify interaction error', e); }
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  console.log(`[messageCreate] guild=${message.guildId} channel=${message.channel.id} author=${message.author.tag}`);
  const content = message.content || '';
  const isInTargetChannel = !TRIGGER_CHANNEL_ID || message.channel.id === TRIGGER_CHANNEL_ID;
  const hasTriggerWord = TRIGGER_WORDS.some(w => w && content.includes(w));
  const memberVoiceId = message.member && message.member.voice ? message.member.voice.channelId : null;
  console.log(`[messageCreate] isInTargetChannel=${isInTargetChannel} hasTriggerWord=${hasTriggerWord} memberVoiceId=${memberVoiceId}`);

  // Mention handling: if bot is mentioned, respond and optionally play
  if (message.mentions.has(client.user)) {
    if (!message.member.voice.channel) return message.reply('VCに参加してください (メンションに反応するにはVC参加が必要です)');
    const mgr = getOrCreateManager(message.guildId, message.member.voice.channel);
    console.log('[messageCreate] mention -> enqueue local audio', { local: LOCAL_AUDIO });
    // Play local audio when mentioned
    mgr.enqueueResource({ localPath: LOCAL_AUDIO, title: 'local_audio' });
    return message.reply('ローカル音源を再生します');
  }

  // Bigwave trigger: plays BIGWAVE_AUDIO when a trigger word (e.g., 僕 or 俺) appears in a configured channel (or anywhere if not set)
  if (isInTargetChannel && hasTriggerWord) {
    if (!message.member.voice.channel) return message.reply('VCに参加してください');
    const mgr = getOrCreateManager(message.guildId, message.member.voice.channel);
    const fs = require('fs');
    const bigPath = fs.existsSync(BIGWAVE_AUDIO) ? BIGWAVE_AUDIO : LOCAL_AUDIO;
    console.log('[messageCreate] bigwave trigger: ', { bigPath, exists: fs.existsSync(bigPath), memberVoiceId });
    mgr.forcePlayResource({ localPath: bigPath, title: 'bigwave' });
    return message.reply('bigwave を再生します');
  }

  // Legacy text trigger for local audio
  if (message.content.includes(TRIGGER_TEXT)) {
    if (!message.member.voice.channel) return message.reply('VCに参加してください');
    const mgr = getOrCreateManager(message.guildId, message.member.voice.channel);
    console.log('[messageCreate] trigger text -> enqueue local audio', { local: LOCAL_AUDIO });
    mgr.enqueueResource({ localPath: LOCAL_AUDIO, title: 'local_audio' });
    return message.reply('トリガ音源を再生します');
  }
});

client.login(TOKEN);
