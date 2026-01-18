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
  if (managers.has(guildId)) {
      const mgr = managers.get(guildId);
      // 再参加時に自動退室タイマーが動いていたら解除
      if (mgr.disconnectTimer) {
          clearTimeout(mgr.disconnectTimer);
          mgr.disconnectTimer = null;
      }
      return mgr;
  }
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
    await client.application.commands.set(commands);
  }

  process.on('unhandledRejection', (reason, p) => {
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
  });
});

// 自動退室の実装
client.on('voiceStateUpdate', (oldState, newState) => {
    const guildId = oldState.guild.id || newState.guild.id;
    const mgr = managers.get(guildId);
    
    // Botが接続していない、または接続が切れている場合は無視
    if (!mgr || !mgr.connection || mgr.connection.state.status === 'destroyed') return;

    // 現在BotがいるチャンネルIDを取得
    const botChannelId = mgr.connection.joinConfig.channelId;

    // 変化があったチャンネルがBotのいるチャンネルかどうか
    if (oldState.channelId === botChannelId || newState.channelId === botChannelId) {
        const channel = oldState.guild.channels.cache.get(botChannelId);
        if (channel && channel.members) {
            // Bot以外のメンバー（人間）の数をカウント
            const humans = channel.members.filter(m => !m.user.bot).size;
            
            if (humans === 0) {
                // 誰もいなくなったらタイマーセット (30秒後)
                if (!mgr.disconnectTimer) {
                    console.log(`[AutoDisconnect] Channel empty in ${guildId}, leaving in 30s...`);
                    mgr.disconnectTimer = setTimeout(() => {
                        console.log(`[AutoDisconnect] Leaving guild ${guildId} due to inactivity`);
                        try {
                            mgr.stop(); // 再生停止
                            mgr.connection.destroy(); // 切断
                            managers.delete(guildId); // マネージャー削除
                        } catch (e) {
                            console.error('[AutoDisconnect] Error:', e);
                        }
                    }, 30_000); 
                }
            } else {
                // 人がいるならタイマー解除
                if (mgr.disconnectTimer) {
                    console.log(`[AutoDisconnect] Humans returned, timer cancelled.`);
                    clearTimeout(mgr.disconnectTimer);
                    mgr.disconnectTimer = null;
                }
            }
        }
    }
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
        mgr.stop();
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

  // Mention handling
  if (message.mentions.has(client.user)) {
    if (!message.member.voice.channel) return message.reply('VCに参加してください (メンションに反応するにはVC参加が必要です)');
    const mgr = getOrCreateManager(message.guildId, message.member.voice.channel);
    console.log('[messageCreate] mention -> enqueue local audio', { local: LOCAL_AUDIO });
    mgr.enqueueResource({ localPath: LOCAL_AUDIO, title: 'local_audio' });
    return message.reply('ローカル音源を再生します');
  }

  // Bigwave trigger
  if (isInTargetChannel && hasTriggerWord) {
    if (!message.member.voice.channel) return message.reply('VCに参加してください');
    const mgr = getOrCreateManager(message.guildId, message.member.voice.channel);
    const fs = require('fs');
    const bigPath = fs.existsSync(BIGWAVE_AUDIO) ? BIGWAVE_AUDIO : LOCAL_AUDIO;
    console.log('[messageCreate] bigwave trigger: ', { bigPath, exists: fs.existsSync(bigPath), memberVoiceId });
    mgr.forcePlayResource({ localPath: bigPath, title: 'bigwave' });
    return message.reply('bigwave を再生します');
  }

  // Legacy text trigger
  if (message.content.includes(TRIGGER_TEXT)) {
    if (!message.member.voice.channel) return message.reply('VCに参加してください');
    const mgr = getOrCreateManager(message.guildId, message.member.voice.channel);
    console.log('[messageCreate] trigger text -> enqueue local audio', { local: LOCAL_AUDIO });
    mgr.enqueueResource({ localPath: LOCAL_AUDIO, title: 'local_audio' });
    return message.reply('トリガ音源を再生します');
  }
});

client.login(TOKEN);