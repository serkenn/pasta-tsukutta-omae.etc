const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const fs = require('fs');
const { spawn } = require('child_process');

class GuildMusicManager {
  constructor(voiceConnection) {
    this.connection = voiceConnection;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
    this.queue = [];
    this.current = null;
    this.textChannel = null;
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

  async enqueueQuery(query) {
    const ok = await this.findAndEnqueuePlayable(query);
    if (!ok) throw new Error('No playable source found for query');
  }

  // yt-dlp を使って URL または 検索ワードから動画情報を取得する
  async findAndEnqueuePlayable(query) {
    console.log('[findAndEnqueuePlayable] processing:', query);
    return new Promise((resolve) => {
        // --default-search ytsearch1 により、URLならそのURLを、単語なら検索してトップ1件を取得します
        // --print でタイトルとURLだけを取得（動画はダウンロードしない）
        const yt = spawn('yt-dlp', [
            '--default-search', 'ytsearch1',
            '--print', '%(title)s__SEPARATOR__%(webpage_url)s',
            '--no-playlist',
            query
        ]);

        let data = '';
        yt.stdout.on('data', chunk => { data += chunk; });
        
        yt.on('close', code => {
            if (code !== 0 || !data.trim()) {
                console.warn('[findAndEnqueuePlayable] yt-dlp failed or found nothing. code:', code);
                resolve(false);
                return;
            }
            
            // 出力例: "Video Title__SEPARATOR__https://youtube.com/..."
            const lines = data.split('\n').filter(Boolean);
            if (lines.length === 0) {
                resolve(false);
                return;
            }

            const [title, url] = lines[0].split('__SEPARATOR__');
            if (!url) {
                resolve(false);
                return;
            }

            this.enqueueResource({ source: url, title: title || query });
            resolve(true);
        });
    });
  }

  // 指定URL（チャンネル）から動画リストを取得
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
            if (code !== 0) {
                console.error('[loadArtistTracks] yt-dlp failed with code', code);
                resolve(0);
                return;
            }
            const lines = data.split('\n').filter(Boolean);
            this.artistPool = lines.map(line => {
                const [url, title] = line.split('__SEPARATOR__');
                return { source: url, title: title || 'Unknown Title' };
            });
            
            // シャッフル
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

  enqueueResource(resource) {
    if (resource.localPath && !fs.existsSync(resource.localPath)) return;
    this.queue.push(resource);
    if (!this.current) this._playNext();
  }

  forcePlayResource(resource) {
    this.queue.unshift(resource);
    this.player.stop();
  }

  async _playNext() {
    if (this.queue.length === 0) {
      this.current = null;
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
        // 【修正】音量を 0.1 (10%) に設定
        if (resource.volume) resource.volume.setVolume(0.1);
        
        this.player.play(resource);

        if (this.textChannel && next.source) {
            this.textChannel.send(`🎵 **Now Playing**\n**${next.title}**\n${next.source}`).catch(e => console.error('Failed to send playing msg', e));
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