require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { joinVoiceChannel } = require('@discordjs/voice');
const GuildMusicManager = require('./music/player');

const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const TRIGGER_TEXT = process.env.TRIGGER_TEXT || 'play_local';
const LOCAL_AUDIO = process.env.LOCAL_AUDIO || './audio/sample.mp3';
const TRIGGER_CHANNEL_ID = process.env.TRIGGER_CHANNEL_ID || '';
const TRIGGER_WORDS = (process.env.TRIGGER_WORDS || '僕,俺').split(',').map(s => s.trim()).filter(Boolean);
const BIGWAVE_AUDIO = process.env.BIGWAVE_AUDIO || './audio/bigwave.mp3';
const ARTIST_URL = 'https://www.youtube.com/@134Recordingsch/videos'; 

if (!TOKEN) {
  console.error('BOT_TOKEN is required in .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent]
});

const managers = new Map();

function getOrCreateManager(guildId, voiceChannel, textChannel) {
  let mgr = managers.get(guildId);
  if (mgr) {
      if (mgr.disconnectTimer) {
          clearTimeout(mgr.disconnectTimer);
          mgr.disconnectTimer = null;
      }
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

// メッセージ自動削除ヘルパー
async function replyAndAutoDelete(interaction, content, timeout = 10000) {
    try {
        const reply = await interaction.editReply(content);
        setTimeout(async () => {
            try { await interaction.deleteReply(); } catch(e) {}
        }, timeout);
        return reply;
    } catch(e) { console.error('AutoDelete failed', e); }
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
    { name: 'resume', description: 'Resume' },
    { 
        name: 'volume', 
        description: 'Set volume (0-100)', 
        options: [{ 
            name: 'level', 
            type: 4, 
            description: 'Volume percentage (0-100)', 
            required: true,
            minValue: 0,
            maxValue: 100
        }] 
    }
  ];

  if (GUILD_ID) {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) await guild.commands.set(commands);
  } else {
    await client.application.commands.set(commands);
  }
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
  // 選択メニューの処理
  if (interaction.isStringSelectMenu() && interaction.customId === 'select-search') {
      const mgr = managers.get(interaction.guildId);
      if (!mgr) return interaction.reply({ content: 'エラー: 再生環境が見つかりません', ephemeral: true });
      
      const selectedUrl = interaction.values[0];
      const selectedOption = interaction.message.components[0].components[0].options.find(o => o.value === selectedUrl);
      const title = selectedOption ? selectedOption.label : 'Selected Track';

      mgr.enqueueResource({ source: selectedUrl, title: title });
      
      // メニューを更新してから削除予約
      await interaction.update({ content: `キューに追加しました: **${title}**`, components: [] });
      setTimeout(async () => {
          try { await interaction.deleteReply(); } catch(e) {}
      }, 10000);
      return;
  }

  if (!interaction.isCommand()) return;
  try {
    const { commandName } = interaction;
    const member = interaction.member;

    if (!member.voice.channel) return interaction.reply({ content: 'VCに参加してください', ephemeral: true });

    const mgr = getOrCreateManager(interaction.guildId, member.voice.channel, interaction.channel);

    if (commandName === 'join') {
      await interaction.reply('参加しました');
      setTimeout(() => interaction.deleteReply(), 5000);
      return;
    }

    if (commandName === 'leave') {
      try { mgr.connection.destroy(); managers.delete(interaction.guildId); } catch(e){}
      await interaction.reply('退出しました');
      setTimeout(() => interaction.deleteReply(), 5000);
      return;
    }

    if (commandName === 'play') {
      const query = interaction.options.getString('query');
      await interaction.deferReply();
      try {
        const results = await mgr.search(query);
        if (results.length === 0) {
            return replyAndAutoDelete(interaction, '検索結果が見つかりませんでした。');
        }

        if (results.length === 1) {
            const track = results[0];
            mgr.enqueueResource(track);
            return replyAndAutoDelete(interaction, `キューに追加: ${track.title}`);
        }

        const options = results.map((r) => ({
            label: r.title.length > 100 ? r.title.substring(0, 97) + '...' : r.title,
            description: r.source,
            value: r.source,
        }));

        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('select-search').setPlaceholder('曲を選択').addOptions(options)
        );

        // 選択メニューはユーザー入力を待つため、ここでは自動削除しない（選択イベント側で処理）
        await interaction.editReply({ content: '候補を選択してください:', components: [row] });
      } catch (e) {
        return replyAndAutoDelete(interaction, `エラー: ${e.message}`);
      }
      return;
    }

    if (commandName === 'stop') {
      mgr.stop();
      await interaction.reply('停止しました');
      setTimeout(() => interaction.deleteReply(), 5000);
      return;
    }

    if (commandName === 'volume') {
        const level = interaction.options.getInteger('level');
        const newVol = mgr.changeVolume(level);
        await interaction.reply(`音量を **${newVol}** (約${Math.round(newVol/100*100)}%) に変更しました`);
        setTimeout(() => interaction.deleteReply(), 5000);
        return;
    }

    if (commandName === 'artist') {
      await interaction.deferReply();
      try {
        // メッセージを表示後、自動削除
        await interaction.editReply('湘南乃風ループを開始します...');
        await mgr.startArtistLoop(ARTIST_URL);
        setTimeout(() => interaction.deleteReply(), 10000);
      } catch (e) {
        return replyAndAutoDelete(interaction, '失敗しました');
      }
      return;
    }

    if (commandName === 'skip') { 
        mgr.skip(); 
        await interaction.reply('スキップしました'); 
        setTimeout(() => interaction.deleteReply(), 5000);
        return; 
    }
    if (commandName === 'pause') { 
        mgr.pause(); 
        await interaction.reply('一時停止しました'); 
        setTimeout(() => interaction.deleteReply(), 5000);
        return; 
    }
    if (commandName === 'resume') { 
        mgr.resume(); 
        await interaction.reply('再開しました'); 
        setTimeout(() => interaction.deleteReply(), 5000);
        return; 
    }

  } catch (err) {
    console.error('interactionCreate error', err);
    try {
      if (!interaction.replied) await interaction.reply({ content: 'エラーが発生しました', ephemeral: true });
    } catch (e) {}
  }
});

client.login(TOKEN);