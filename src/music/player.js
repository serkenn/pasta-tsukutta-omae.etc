const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const play = require('play-dl');
const fs = require('fs');

class GuildMusicManager {
  constructor(voiceConnection) {
    this.connection = voiceConnection;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
    this.queue = [];
    this.current = null;
    this.player.on(AudioPlayerStatus.Idle, () => this._playNext());
    this.player.on('error', err => console.error('[Player Error]', err));
    this.connection.subscribe(this.player);
  }

  async enqueueQuery(query) {
    // search via play-dl
    const results = await play.search(query, { limit: 1 });
    if (!results || results.length === 0) throw new Error('No results');
    const info = results[0];
    this.queue.push({ source: info.url, title: info.title });
    if (!this.current) this._playNext();
  }

  enqueueResource(resource) {
    this.queue.push(resource);
    if (!this.current) this._playNext();
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
      if (next.localPath) {
        const stream = fs.createReadStream(next.localPath);
        resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, metadata: { title: next.title || next.localPath } });
      } else if (next.source) {
        const stream = await play.stream(next.source);
        resource = createAudioResource(stream.stream, { inputType: stream.type });
      } else {
        throw new Error('Unknown resource type');
      }
      this.player.play(resource);
    } catch (err) {
      console.error('Failed to play:', err);
      // continue to next
      setTimeout(() => this._playNext(), 1000);
    }
  }

  skip() {
    this.player.stop(true);
  }

  pause() { this.player.pause(); }
  resume() { this.player.unpause(); }
}

module.exports = GuildMusicManager;