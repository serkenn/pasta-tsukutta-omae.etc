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
// 湘南乃風 公式チャンネルのリリース（またはVideos）URL
// const ARTIST_URL = 'https://www.youtube.com/@134Recordingsch/releases'; // Releasesだと取得できない場合があるのでvideos推奨
const ARTIST_URL = 'https://www.youtube.com/@134Recordingsch/videos'; 

if (!TOKEN) {
  console.error('BOT_TOKEN is required in .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent]
});

const managers = new Map();

// テキストチャンネル情報を受け取るように引数を追加
function getOrCreateManager(guildId, voiceChannel, textChannel) {
  let mgr = managers.get(guildId);
  if (mgr) {
      if (mgr.disconnectTimer) {
          clearTimeout(mgr.disconnectTimer);
          mgr.disconnectTimer = null;
      }
      // コマンド実行のたびに最新のテキストチャンネルをセットする（返信先を更新するため）
      if (textChannel) mgr.setTextChannel(textChannel);
      return mgr;
  }
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });
  mgr = new GuildMusicManager(connection);
  if (textChannel) mgr.setTextChannel(textChannel);
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
    { name: 'artist', description: 'Start artist loop (湘南乃風 Official Channel)' },
    { name: 'skip', description: 'Skip current track' },
    { name: 'pause', description: 'Pause' },
    { name: 'resume', description: 'Resume' }
  ];

  if (GUILD_ID) {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) await guild.commands.set(commands);
  } else {
    await client.application.commands.set(commands);
  }

  process.on('unhandledRejection', (reason, p) => console.error('Unhandled Rejection at:', p, 'reason:', reason));
  process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
});

client.on('voiceStateUpdate', (oldState, newState) => {
    const guildId = oldState.guild.id || newState.guild.id;
    const mgr = managers.get(guildId);
    if (!mgr || !mgr.connection || mgr.connection.state.status === 'destroyed') return;

    const botChannelId = mgr.connection.joinConfig.channelId;
    if (oldState.channelId === botChannelId || newState.channelId === botChannelId) {
        const channel = oldState.guild.channels.cache.get(botChannelId);
        if (channel && channel.members) {
            const humans = channel.members.filter(m => !m.user.bot).size;
            if (humans === 0) {
                if (!mgr.disconnectTimer) {
                    mgr.disconnectTimer = setTimeout(() => {
                        try {
                            mgr.stop();
                            mgr.connection.destroy();
                            managers.delete(guildId);
                        } catch (e) {}
                    }, 30_000); 
                }
            } else {
                if (mgr.disconnectTimer) {
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

    if (!member.voice.channel) return interaction.reply({ content: 'VCに参加してください', ephemeral: true });

    // ここで textChannel (interaction.channel) を渡す
    const mgr = getOrCreateManager(interaction.guildId, member.voice.channel, interaction.channel);

    if (commandName === 'join') {
      return interaction.reply('参加しました');
    }

    if (commandName === 'leave') {
      try { mgr.connection.destroy(); managers.delete(interaction.guildId); } catch(e){}
      return interaction.reply('退出しました');
    }

    if (commandName === 'play') {
      const query = interaction.options.getString('query');
      await interaction.deferReply();
      try {
        await mgr.enqueueQuery(query);
        return interaction.editReply(`キューに追加: ${query}`);
      } catch (e) {
        return interaction.editReply(`再生に失敗しました: ${e.message}`);
      }
    }

    if (commandName === 'stop') {
      mgr.stop();
      return interaction.reply('再生を停止し、キューをクリアしました');
    }

    if (commandName === 'artist') {
      await interaction.deferReply();
      try {
        // 大量のループ処理を削除し、マネージャー側のメソッドを呼ぶだけに修正
        interaction.editReply('湘南乃風リストを取得してループ再生を開始します...（初回ロードに数秒かかります）');
        await mgr.startArtistLoop(ARTIST_URL);
        // 完了メッセージは startArtistLoop 完了後に出すか、上記メッセージで代用
      } catch (e) {
        console.error('artist command error', e);
        return interaction.followUp({ content: 'ループ開始に失敗しました', ephemeral: true });
      }
    }

    if (commandName === 'skip') { mgr.skip(); return interaction.reply('スキップしました'); }
    if (commandName === 'pause') { mgr.pause(); return interaction.reply('一時停止しました'); }
    if (commandName === 'resume') { mgr.resume(); return interaction.reply('再開しました'); }

  } catch (err) {
    console.error('interactionCreate error', err);
    try {
      if (!interaction.replied) await interaction.reply({ content: 'エラーが発生しました', ephemeral: true });
    } catch (e) {}
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const content = message.content || '';
  const isInTargetChannel = !TRIGGER_CHANNEL_ID || message.channel.id === TRIGGER_CHANNEL_ID;
  const hasTriggerWord = TRIGGER_WORDS.some(w => w && content.includes(w));

  // Mention
  if (message.mentions.has(client.user)) {
    if (!message.member.voice.channel) return message.reply('VCに参加してください');
    const mgr = getOrCreateManager(message.guildId, message.member.voice.channel, message.channel);
    mgr.enqueueResource({ localPath: LOCAL_AUDIO, title: 'local_audio' });
    return message.reply('ローカル音源を再生します');
  }

  // Bigwave
  if (isInTargetChannel && hasTriggerWord) {
    if (!message.member.voice.channel) return message.reply('VCに参加してください');
    const mgr = getOrCreateManager(message.guildId, message.member.voice.channel, message.channel);
    const fs = require('fs');
    const bigPath = fs.existsSync(BIGWAVE_AUDIO) ? BIGWAVE_AUDIO : LOCAL_AUDIO;
    mgr.forcePlayResource({ localPath: bigPath, title: 'bigwave' });
    return message.reply('bigwave を再生します');
  }

  // Legacy Trigger
  if (message.content.includes(TRIGGER_TEXT)) {
    if (!message.member.voice.channel) return message.reply('VCに参加してください');
    const mgr = getOrCreateManager(message.guildId, message.member.voice.channel, message.channel);
    mgr.enqueueResource({ localPath: LOCAL_AUDIO, title: 'local_audio' });
    return message.reply('トリガ音源を再生します');
  }
});

client.login(TOKEN);