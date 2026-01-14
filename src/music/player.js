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
    this.player.on(AudioPlayerStatus.Playing, () => console.log('[Player] status=Playing'));
    this.player.on('error', err => console.error('[Player Error]', err));
    this.connection.subscribe(this.player);
    try { console.log(`[GuildMusicManager] created for guild ${voiceConnection.joinConfig.guildId}`); } catch (e) { console.log('[GuildMusicManager] created'); }
  }

  async enqueueQuery(query) {
    // simple enqueue helper that defers to finding a playable candidate
    const ok = await this.findAndEnqueuePlayable(query);
    if (!ok) throw new Error('No playable source found for query');
  }

  // Try to find a playable stream from search results for a query and enqueue it.
  async findAndEnqueuePlayable(query) {
    const results = await play.search(query, { limit: 6 });
    if (!results || results.length === 0) return false;
    for (const info of results) {
      let sourceUrl = info.url || info.link || null;
      if (!sourceUrl && info.id) sourceUrl = `https://www.youtube.com/watch?v=${info.id}`;
      if (!sourceUrl) continue;

      try {
        // quick check if play.stream works
        const streamObj = await play.stream(sourceUrl).catch(() => null);
        if (streamObj && streamObj.stream) {
          console.log('[findAndEnqueuePlayable] enqueuing', { title: info.title, sourceUrl });
          this.enqueueResource({ source: sourceUrl, title: info.title || query });
          return true;
        }
      } catch (e) {
        console.warn('[findAndEnqueuePlayable] candidate failed', sourceUrl, e && e.message ? e.message : e);
        continue;
      }
    }
    return false;
  }

  // Artist loop support: will keep queue populated with artist tracks
  async fillArtist(artistName, desiredCount = 10) {
    const seen = new Set(this.queue.map(q => q.title));
    let added = 0;
    // search broad results for the artist
    const results = await play.search(artistName, { limit: 30 });
    for (const info of results) {
      if (added >= desiredCount) break;
      const title = info.title || '';
      if (seen.has(title)) continue;
      const sourceUrl = info.url || (info.id ? `https://www.youtube.com/watch?v=${info.id}` : null);
      if (!sourceUrl) continue;
      try {
        const streamObj = await play.stream(sourceUrl).catch(() => null);
        if (streamObj && streamObj.stream) {
          this.enqueueResource({ source: sourceUrl, title });
          seen.add(title);
          added++;
        }
      } catch (e) {
        console.warn('[fillArtist] skipping candidate', sourceUrl, e && e.message ? e.message : e);
        continue;
      }
    }
    console.log('[fillArtist] added', added, 'tracks for', artistName);
    return added;
  }

  startArtistLoop(artistName) {
    this.artistName = artistName;
    if (this.artistRefillInterval) clearInterval(this.artistRefillInterval);
    // initial fill
    this.fillArtist(artistName, 15).catch(e => console.error('startArtistLoop initial fill failed', e));
    // background refill when queue drops below threshold
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
    // initialize attempts for retry logic
    resource.attempts = resource.attempts || 0;
    if (resource.localPath) {
      if (!fs.existsSync(resource.localPath)) {
        console.error('[enqueueResource] localPath does not exist:', resource.localPath);
        return;
      }
      console.log('[enqueueResource] enqueue local resource', resource.localPath);
    } else if (resource.source) {
      console.log('[enqueueResource] enqueue source resource', resource.source);
    }

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
        console.log('[playNext] attempting to stream local file via play-dl', next.localPath);
        try {
          const streamObj = await play.stream(next.localPath);
          if (!streamObj || !streamObj.stream) throw new Error('No stream returned for local file');
          resource = createAudioResource(streamObj.stream, { inputType: streamObj.type, metadata: { title: next.title || next.localPath } });
          console.log('[playNext] playing local file via play-dl', next.localPath);
        } catch (e) {
          console.warn('[playNext] play.stream(local) failed, falling back to fs stream', e && e.message ? e.message : e);
          const stream = fs.createReadStream(next.localPath);
          resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, metadata: { title: next.title || next.localPath } });
          console.log('[playNext] playing local file via fs fallback', next.localPath);
        }
        try { console.log('[playNext] voiceConnection state', this.connection.state && this.connection.state.status, 'player state', this.player.state.status); } catch(e){}
      } else if (next.source) {
        // Retry guard
        next.attempts = (next.attempts || 0) + 1;
        if (next.attempts > 3) {
          console.error('[playNext] too many attempts, skipping resource', next);
          // proceed to next
          setTimeout(() => this._playNext(), 50);
          return;
        }

        console.log('[playNext] streaming source', next.source, 'attempt', next.attempts);

        // Try to resolve video info first (more robust) and fallback to direct stream
        try {
          let info;
          if (typeof next.source === 'string' && next.source.startsWith('http')) {
            try {
              info = await play.video_info(next.source);
              console.log('[playNext] got video_info');
            } catch (e) {
              console.warn('[playNext] video_info failed, will try direct stream', e.message);
            }
          }

          let streamObj;
          if (info && info?.url) {
            streamObj = await play.stream(info.url);
          } else {
            streamObj = await play.stream(next.source);
          }

          if (!streamObj || !streamObj.stream) throw new Error('No stream returned');
          resource = createAudioResource(streamObj.stream, { inputType: streamObj.type });
        } catch (e) {
          console.error('[playNext] stream attempt failed:', e && e.message ? e.message : e, 'resource:', next);

          // Special-case: play-dl sometimes throws Invalid URL with input 'undefined' (internal missing field)
          if (e && e.code === 'ERR_INVALID_URL' && e.input === 'undefined') {
            console.error('[playNext] fatal Invalid URL (undefined) from play-dl, skipping resource:', next.source, next.title);
            // do not re-enqueue - skip this resource
            setTimeout(() => this._playNext(), 50);
            return;
          }

          // Re-enqueue with updated attempts to try again later
          this.queue.push(next);
          setTimeout(() => this._playNext(), 500);
          return;
        }
      } else {
        console.error('Unknown resource type or missing source', next);
        throw new Error('Unknown resource type');
      }
      this.player.play(resource);
    } catch (err) {
      console.error('Failed to play:', err, 'resource:', next);
      // continue to next after short delay
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