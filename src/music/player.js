const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const fs = require('fs');
const { spawn } = require('child_process');

class GuildMusicManager {
  constructor(voiceConnection) {
    this.connection = voiceConnection;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
    this.queue = [];
    this.current = null;
    this.currentResource = null; // 現在再生中のリソースを保持（音量変更用）
    this.volume = 0.1; // デフォルト音量 (10%)
    
    this.textChannel = null;
    this.lastPlayingMessage = null;
    this.disconnectTimer = null;
    this.artistPool = [];

    this.player.on(AudioPlayerStatus.Idle, () => this._playNext());
    this.player.on('error', err => console.error('[Player Error]', err));
    this.connection.subscribe(this.player);
    console.log(`[GuildMusicManager] created for guild ${voiceConnection.joinConfig.guildId}`);
  }

  setTextChannel(channel) {
    this.textChannel = channel;
  }

  // 音量変更メソッド (0-100)
  changeVolume(level) {
    // 範囲制限
    const vol = Math.max(0, Math.min(100, level));
    this.volume = vol / 100; // 0.0 - 1.0 に変換

    // 再生中のリソースがあれば即座に適用
    if (this.currentResource && this.currentResource.volume) {
        this.currentResource.volume.setVolume(this.volume);
    }
    return vol;
  }

  // 検索処理
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
                if (title && url) {
                    results.push({ title, source: url });
                }
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
          inputType: StreamType.Arbitrary, 
          inlineVolume: true, 
          metadata: { title: next.title } 
      };

      if (next.localPath) {
        const stream = fs.createReadStream(next.localPath);
        resource = createAudioResource(stream, resourceOptions);
      } else if (next.source) {
        console.log('[playNext] attempting:', next.title);
        
        const ytDlpProcess = spawn('yt-dlp', [
            '-f', 'bestaudio',
            '--no-playlist',
            '--buffer-size', '16K',
            '-o', '-',
            '-q',
            next.source
        ]);

        ytDlpProcess.on('error', err => {
            console.error('[playNext] yt-dlp spawn error:', err);
            setTimeout(() => this._playNext(), 1000);
        });

        resource = createAudioResource(ytDlpProcess.stdout, resourceOptions);
      }

      if (resource) {
        // 設定された音量を適用
        if (resource.volume) resource.volume.setVolume(this.volume);
        
        this.currentResource = resource; // リソースを保持
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