const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const fs = require('fs');
const { spawn } = require('child_process');

class GuildMusicManager {
  constructor(voiceConnection) {
    this.connection = voiceConnection;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
    this.queue = [];
    this.current = null;
    this.currentResource = null;
    this.volume = 0.5; // 初期音量を50%に変更 (聞こえない問題対策)
    
    this.textChannel = null;
    this.lastPlayingMessage = null;
    this.artistPool = [];
    this.disconnectTimer = null;

    this.player.on(AudioPlayerStatus.Idle, () => this._playNext());
    this.player.on('error', err => console.error('[Player Error]', err));
    this.connection.subscribe(this.player);
    console.log(`[GuildMusicManager] created for guild ${voiceConnection.joinConfig.guildId}`);
  }

  setTextChannel(channel) {
    this.textChannel = channel;
  }

  changeVolume(level) {
    const vol = Math.max(0, Math.min(100, level));
    this.volume = vol / 100;
    if (this.currentResource && this.currentResource.volume) {
        this.currentResource.volume.setVolume(this.volume);
    }
    return vol;
  }

  // URL取得ヘルパー (yt-dlp --get-url)
  async getStreamUrl(sourceUrl) {
    return new Promise((resolve) => {
        const yt = spawn('yt-dlp', [
            '-f', 'bestaudio', // 最高音質
            '--get-url',       // 動画データではなくURLを取得
            sourceUrl
        ]);
        let data = '';
        yt.stdout.on('data', chunk => { data += chunk; });
        yt.on('close', code => {
            if (code !== 0 || !data.trim()) {
                console.error('[getStreamUrl] failed to get URL');
                resolve(null);
            } else {
                // 複数行返ってくる場合があるので最初の1行を使う
                resolve(data.split('\n')[0].trim());
            }
        });
    });
  }

  async search(query) {
    if (query.startsWith('http://') || query.startsWith('https://')) {
        return await this.getUrlInfo(query);
    }
    return new Promise((resolve) => {
        const yt = spawn('yt-dlp', [
            '--default-search', 'ytsearch5',
            '--print', '%(title)s__SEPARATOR__%(webpage_url)s',
            '--no-playlist',
            query
        ]);
        let data = '';
        yt.stdout.on('data', chunk => { data += chunk; });
        yt.on('close', () => {
            if (!data.trim()) { return resolve([]); }
            const results = [];
            const lines = data.split('\n').filter(Boolean);
            for (const line of lines) {
                const [title, url] = line.split('__SEPARATOR__');
                if (title && url) results.push({ title, source: url });
            }
            resolve(results);
        });
    });
  }

  async getUrlInfo(url) {
    return new Promise((resolve) => {
        const yt = spawn('yt-dlp', [
            '--print', '%(title)s__SEPARATOR__%(webpage_url)s',
            '--no-playlist',
            url
        ]);
        let data = '';
        yt.stdout.on('data', chunk => { data += chunk; });
        yt.on('close', () => {
            if (!data.trim()) return resolve([]);
            const lines = data.split('\n').filter(Boolean);
            const [title, source] = lines[0].split('__SEPARATOR__');
            resolve([{ title: title || 'Unknown', source: source || url }]);
        });
    });
  }

  enqueueResource(resource) {
    if (resource.localPath && !fs.existsSync(resource.localPath)) return;
    this.queue.push(resource);
    if (!this.current) this._playNext();
  }

  async loadArtistTracks(channelUrl) {
    console.log('[loadArtistTracks] Fetching list from:', channelUrl);
    return new Promise((resolve) => {
        const yt = spawn('yt-dlp', [
            '--flat-playlist',
            '--print', '%(url)s__SEPARATOR__%(title)s',
            channelUrl
        ]);
        let data = '';
        yt.stdout.on('data', chunk => { data += chunk; });
        yt.on('close', code => {
            if (code !== 0) { resolve(0); return; }
            const lines = data.split('\n').filter(Boolean);
            this.artistPool = lines.map(line => {
                const [url, title] = line.split('__SEPARATOR__');
                return { source: url, title: title || 'Unknown Title' };
            });
            for (let i = this.artistPool.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [this.artistPool[i], this.artistPool[j]] = [this.artistPool[j], this.artistPool[i]];
            }
            console.log(`[loadArtistTracks] Loaded ${this.artistPool.length} tracks.`);
            resolve(this.artistPool.length);
        });
    });
  }

  async fillFromPool(count = 5) {
    if (this.artistPool.length === 0) return;
    for (let i = 0; i < count; i++) {
        const track = this.artistPool.shift();
        if (track) {
            this.enqueueResource(track);
            this.artistPool.push(track);
        }
    }
  }

  async startArtistLoop(channelUrl) {
    this.stopArtistLoop();
    await this.loadArtistTracks(channelUrl);
    if (this.artistPool.length === 0) return;
    this.fillFromPool(5);
    this.artistRefillInterval = setInterval(() => {
        if (this.queue.length < 3) {
            this.fillFromPool(5);
        }
    }, 10000);
  }

  stopArtistLoop() {
    if (this.artistRefillInterval) {
        clearInterval(this.artistRefillInterval);
        this.artistRefillInterval = null;
    }
    this.artistPool = [];
  }

  forcePlayResource(resource) {
    this.queue.unshift(resource);
    this.player.stop();
  }

  async _playNext() {
    // 前回のNow Playingメッセージを確実に削除
    if (this.lastPlayingMessage) {
        try { await this.lastPlayingMessage.delete(); } catch(e) {}
        this.lastPlayingMessage = null;
    }

    if (this.queue.length === 0) {
      this.current = null;
      this.currentResource = null;
      return;
    }
    const next = this.queue.shift();
    this.current = next;

    try {
      let resource;
      const resourceOptions = { 
          inlineVolume: true, 
          metadata: { title: next.title } 
      };

      if (next.localPath) {
        console.log('[playNext] playing local file', next.localPath);
        const stream = fs.createReadStream(next.localPath);
        resource = createAudioResource(stream, { ...resourceOptions, inputType: StreamType.Arbitrary });
      } else if (next.source) {
        console.log('[playNext] fetching URL for:', next.title);
        // 【修正】 yt-dlp で直接の音声URLを取得してから再生する (安定性向上)
        const streamUrl = await this.getStreamUrl(next.source);
        if (!streamUrl) throw new Error('Failed to get stream URL');

        // URLを渡して createAudioResource (FFmpegが内部で処理)
        resource = createAudioResource(streamUrl, resourceOptions);
      }

      if (resource) {
        if (resource.volume) resource.volume.setVolume(this.volume);
        this.currentResource = resource;
        this.player.play(resource);

        if (this.textChannel && next.source) {
            this.lastPlayingMessage = await this.textChannel.send(`🎵 **Now Playing** (Vol: ${Math.round(this.volume * 100)}%)\n**${next.title}**\n${next.source}`).catch(e => console.error('Failed to send playing msg', e));
        }
      }
    } catch (err) {
      console.error('Failed to play:', err.message);
      setTimeout(() => this._playNext(), 2000);
    }
  }

  skip() { this.player.stop(true); }
  stop() {
    this.stopArtistLoop();
    this.queue = [];
    this.player.stop(true);
  }
  pause() { this.player.pause(); }
  resume() { this.player.unpause(); }
}

module.exports = GuildMusicManager;