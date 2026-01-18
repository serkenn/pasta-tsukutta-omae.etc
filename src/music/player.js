const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const play = require('play-dl');
const fs = require('fs');
const { spawn } = require('child_process');

class GuildMusicManager {
  constructor(voiceConnection) {
    this.connection = voiceConnection;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
    this.queue = [];
    this.current = null;
    this.disconnectTimer = null; // 自動退室用のタイマー保持用

    this.player.on(AudioPlayerStatus.Idle, () => this._playNext());
    this.player.on(AudioPlayerStatus.Playing, () => console.log('[Player] status=Playing'));
    this.player.on('error', err => console.error('[Player Error]', err));
    this.connection.subscribe(this.player);
    try { console.log(`[GuildMusicManager] created for guild ${voiceConnection.joinConfig.guildId}`); } catch (e) { console.log('[GuildMusicManager] created'); }
  }

  async enqueueQuery(query) {
    const ok = await this.findAndEnqueuePlayable(query);
    if (!ok) throw new Error('No playable source found for query');
  }

  async findAndEnqueuePlayable(query) {
    try {
        const results = await play.search(query, { limit: 6 });
        if (!results || results.length === 0) return false;
        for (const info of results) {
          let sourceUrl = info.url || info.link || null;
          if (!sourceUrl && info.id) sourceUrl = `https://www.youtube.com/watch?v=${info.id}`;
          if (!sourceUrl) continue;
          
          console.log('[findAndEnqueuePlayable] enqueuing', { title: info.title, sourceUrl });
          this.enqueueResource({ source: sourceUrl, title: info.title || query });
          return true;
        }
    } catch (e) {
        console.warn('[findAndEnqueuePlayable] search failed', e);
    }
    return false;
  }

  async fillArtist(artistName, desiredCount = 10) {
    const seen = new Set(this.queue.map(q => q.title));
    let added = 0;
    try {
        const results = await play.search(artistName, { limit: 30 });
        for (const info of results) {
          if (added >= desiredCount) break;
          const title = info.title || '';
          if (seen.has(title)) continue;
          const sourceUrl = info.url || (info.id ? `https://www.youtube.com/watch?v=${info.id}` : null);
          if (!sourceUrl) continue;
          
          this.enqueueResource({ source: sourceUrl, title });
          seen.add(title);
          added++;
        }
    } catch (e) {
        console.warn('[fillArtist] search failed', e);
    }
    console.log('[fillArtist] added', added, 'tracks for', artistName);
    return added;
  }

  startArtistLoop(artistName) {
    this.artistName = artistName;
    if (this.artistRefillInterval) clearInterval(this.artistRefillInterval);
    this.fillArtist(artistName, 15).catch(e => console.error('startArtistLoop initial fill failed', e));
    this.artistRefillInterval = setInterval(() => {
      try {
        if (this.queue.filter(q => q.source).length < 6) {
          this.fillArtist(artistName, 10).catch(e => console.error('artist refill failed', e));
        }
      } catch (e) { console.error('artist loop interval error', e); }
    }, 10_000);
  }

  stopArtistLoop() {
    this.artistName = null;
    if (this.artistRefillInterval) { clearInterval(this.artistRefillInterval); this.artistRefillInterval = null; }
  }

  enqueueResource(resource) {
    resource.attempts = resource.attempts || 0;
    if (resource.localPath && !fs.existsSync(resource.localPath)) {
        console.error('[enqueueResource] localPath does not exist:', resource.localPath);
        return;
    }
    console.log('[enqueueResource] pushing to queue', { title: resource.title, source: resource.source });
    this.queue.push(resource);
    if (!this.current) this._playNext();
  }

  forcePlayResource(resource) {
    if (resource.localPath && !fs.existsSync(resource.localPath)) {
        console.error('[forcePlayResource] localPath does not exist:', resource.localPath);
        return;
    }
    console.log('[forcePlayResource] forcing playback:', resource.title);
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
      // 音量調整を有効にするオプション (YouTube用、ローカル用共通)
      const resourceOptions = { 
          inputType: StreamType.Arbitrary, 
          inlineVolume: true, // これにより volume.setVolume が使えるようになります
          metadata: { title: next.title || next.localPath } 
      };

      if (next.localPath) {
        console.log('[playNext] playing local file', next.localPath);
        const stream = fs.createReadStream(next.localPath);
        resource = createAudioResource(stream, resourceOptions);
      } else if (next.source) {
        console.log('[playNext] streaming source via yt-dlp', next.source);
        const ytDlpProcess = spawn('yt-dlp', [
            '-f', 'bestaudio', // 最高音質
            '--no-playlist',
            '--buffer-size', '16K', // バッファサイズを指定してストリームを安定化
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
        // 音量を40%に設定
        if (resource.volume) {
            resource.volume.setVolume(0.4); 
        }
        this.player.play(resource);
      }
    } catch (err) {
      console.error('Failed to play:', err, 'resource:', next);
      setTimeout(() => this._playNext(), 1000);
    }
  }

  skip() {
    this.player.stop(true);
  }

  stop() {
    this.stopArtistLoop();
    this.queue = [];
    this.player.stop(true);
  }

  pause() { this.player.pause(); }
  resume() { this.player.unpause(); }
}

module.exports = GuildMusicManager;