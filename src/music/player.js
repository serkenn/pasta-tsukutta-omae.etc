const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
// play-dl は検索に使わないため削除可能ですが、既存互換のために残すか、完全に yt-dlp に移行します
const play = require('play-dl'); 
const fs = require('fs');
const { spawn } = require('child_process');

class GuildMusicManager {
  constructor(voiceConnection) {
    this.connection = voiceConnection;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
    this.queue = [];
    this.current = null;
    this.textChannel = null; // 通知を送るチャンネル
    this.disconnectTimer = null;
    this.artistPool = []; // アーティストモード用の曲リストキャッシュ

    this.player.on(AudioPlayerStatus.Idle, () => this._playNext());
    this.player.on('error', err => console.error('[Player Error]', err));
    this.connection.subscribe(this.player);
    console.log(`[GuildMusicManager] created for guild ${voiceConnection.joinConfig.guildId}`);
  }

  // 通知先のテキストチャンネルをセット
  setTextChannel(channel) {
    this.textChannel = channel;
  }

  async enqueueQuery(query) {
    // 通常の検索再生（既存維持）
    const ok = await this.findAndEnqueuePlayable(query);
    if (!ok) throw new Error('No playable source found for query');
  }

  async findAndEnqueuePlayable(query) {
    try {
        // 通常検索も play-dl が不安定なら yt-dlp --get-id 等に置き換えるべきですが
        // 今回はアーティストループの修正を優先します。
        const results = await play.search(query, { limit: 1 });
        if (!results || results.length === 0) return false;
        
        const info = results[0];
        let sourceUrl = info.url || (info.id ? `https://www.youtube.com/watch?v=${info.id}` : null);
        if (!sourceUrl) return false;

        this.enqueueResource({ source: sourceUrl, title: info.title || query });
        return true;
    } catch (e) {
        console.warn('[findAndEnqueuePlayable] search failed', e);
    }
    return false;
  }

  // 指定URL（チャンネル）から動画リストを取得してプールに貯める
  async loadArtistTracks(channelUrl) {
    console.log('[loadArtistTracks] Fetching list from:', channelUrl);
    return new Promise((resolve) => {
        // yt-dlp でフラットプレイリストとして高速に全件取得
        const yt = spawn('yt-dlp', [
            '--flat-playlist',
            '--print', '%(url)s__SEPARATOR__%(title)s', // URLとタイトルを区切り文字で出力
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
            
            // シャッフル (Fisher-Yates)
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
    
    // プールから取り出してキューに入れる（プールが空になったら再利用するか、ループ終了などの制御が可能）
    // ここではプールを消費せずにランダムに取り出す、または順次取り出す実装にします
    // シンプルにプールをローテーションさせてキューに追加します
    for (let i = 0; i < count; i++) {
        const track = this.artistPool.shift(); // 先頭を取得
        if (track) {
            this.enqueueResource(track);
            this.artistPool.push(track); // 末尾に戻す（無限ループ用）
        }
    }
  }

  async startArtistLoop(channelUrl) {
    this.stopArtistLoop();
    // 初回ロード
    await this.loadArtistTracks(channelUrl);
    if (this.artistPool.length === 0) return;

    // 最初に5曲ほどキューに入れる
    this.fillFromPool(5);

    // 定期的にキューを補充するタイマー
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

        // エラーハンドリング: プロセス起動エラーのみキャッチ
        ytDlpProcess.on('error', err => {
            console.error('[playNext] yt-dlp spawn error:', err);
            setTimeout(() => this._playNext(), 1000);
        });

        resource = createAudioResource(ytDlpProcess.stdout, resourceOptions);
      }

      if (resource) {
        if (resource.volume) resource.volume.setVolume(0.4);
        
        this.player.play(resource);

        // 【追加】再生成功メッセージの送信
        // 実際に音が鳴り始めたタイミングに近いここで送信
        if (this.textChannel && next.source) { // ローカル音源のときは通知しない設定（必要なら条件変更）
            this.textChannel.send(`🎵 **Now Playing**\n**${next.title}**\n${next.source}`).catch(e => console.error('Failed to send playing msg', e));
        }
      }
    } catch (err) {
      // エラー時はログを出すだけで、チャットには流さない
      console.error('Failed to play:', err.message);
      // 次の曲へ
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