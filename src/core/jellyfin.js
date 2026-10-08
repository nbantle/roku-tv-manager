// Minimal Jellyfin server client: what's playing on each TV, search the
// library, and tell a TV's Jellyfin app to play something.
//
// Needs the server address (e.g. http://192.168.1.10:8096) and an API key
// (Jellyfin Dashboard > API Keys).

import http from 'node:http';
import https from 'node:https';

export class JellyfinError extends Error {}

const PLAYABLE_TYPES = 'Playlist,Movie,Episode,Video,MusicVideo,Series,Season,BoxSet,Folder,MusicAlbum,Audio';

/** "::ffff:192.168.1.50", "192.168.1.50:51234" -> "192.168.1.50" */
export function hostOf(endpoint) {
  if (!endpoint) return '';
  let h = String(endpoint).trim().replace(/^::ffff:/i, '');
  const v4WithPort = h.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4WithPort) h = v4WithPort[1];
  return h.replace(/^\[|\]$/g, '');
}

/** The Jellyfin session belonging to the TV at `host` (most recently active first). */
export function sessionForHost(sessions, host) {
  return (sessions || [])
    .filter((s) => hostOf(s.RemoteEndPoint) === host && s.SupportsRemoteControl !== false)
    .sort((a, b) => String(b.LastActivityDate || '').localeCompare(String(a.LastActivityDate || '')))[0] ?? null;
}

/** {title, paused} for what a session is playing, or null. */
export function nowPlaying(session) {
  const item = session?.NowPlayingItem;
  if (!item) return null;
  const title = item.SeriesName ? `${item.SeriesName} – ${item.Name}` : item.Name;
  return { title, paused: !!session.PlayState?.IsPaused };
}

export class JellyfinClient {
  constructor(url, apiKey, timeoutMs = 5000) {
    this.base = new URL(url.endsWith('/') ? url : url + '/');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.userId = null;
  }

  request(method, path, query = {}) {
    const url = new URL(path.replace(/^\//, ''), this.base);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(url, {
        method,
        timeout: this.timeoutMs,
        headers: {
          Accept: 'application/json',
          'X-Emby-Token': this.apiKey,
          Authorization: `MediaBrowser Client="Roku TV Manager", Device="Roku TV Manager", DeviceId="roku-tv-manager", Version="1", Token="${this.apiKey}"`,
          ...(method === 'POST' ? { 'Content-Length': 0 } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 401 || res.statusCode === 403) return reject(new JellyfinError('Jellyfin didn’t accept the API key.'));
          if (res.statusCode >= 400) return reject(new JellyfinError(`Jellyfin returned HTTP ${res.statusCode} for ${url.pathname}`));
          if (!text) return resolve(null);
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new JellyfinError('That address answered, but it doesn’t look like a Jellyfin server.'));
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (e) => reject(new JellyfinError(`Couldn’t reach Jellyfin at ${this.base.origin}: ${e.code || e.message}`)));
      req.end();
    });
  }

  async info() {
    const i = await this.request('GET', '/System/Info');
    return { name: i?.ServerName ?? 'Jellyfin', version: i?.Version ?? '' };
  }

  sessions() {
    return this.request('GET', '/Sessions');
  }

  async adminUserId() {
    if (this.userId) return this.userId;
    const users = (await this.request('GET', '/Users')) || [];
    const user = users.find((u) => u.Policy?.IsAdministrator) ?? users[0];
    this.userId = user?.Id ?? null;
    return this.userId;
  }

  async search(term) {
    const r = await this.request('GET', '/Items', {
      searchTerm: term,
      Recursive: true,
      IncludeItemTypes: PLAYABLE_TYPES,
      Limit: 40,
      userId: await this.adminUserId().catch(() => null),
    });
    return (r?.Items || []).map((i) => ({
      id: i.Id,
      name: i.SeriesName && i.Type === 'Episode' ? `${i.SeriesName} – ${i.Name}` : i.Name,
      type: i.Type,
      year: i.ProductionYear ?? null,
    }));
  }

  play(sessionId, itemId) {
    return this.request('POST', `/Sessions/${encodeURIComponent(sessionId)}/Playing`, { playCommand: 'PlayNow', itemIds: itemId });
  }
}
