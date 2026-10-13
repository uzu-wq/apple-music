const ALLOW_PREVIEW = true;
const DEFAULT_COUNTRY = 'US';
const BASE = 'https://itunes.apple.com';
const STOREFRONTS = ['US', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'SE', 'HR', 'RS', 'BA', 'CA', 'AU', 'BR', 'JP', 'KR'];
const SEARCH_TTL_MS = 60 * 1000;
const STREAM_TTL_MS = 30 * 60 * 1000;

let currentCountry = DEFAULT_COUNTRY;
const trackMeta = {};
const trackCountry = {};
const albumCountry = {};
const searchCache = {};
const streamCache = {};
const inflight = {};

function toStr(v) {
    return v === undefined || v === null ? '' : String(v);
}

function readSetting(ctx, name) {
    const s = (ctx && ctx.settings) || {};
    let v = s[name];
    if (v && typeof v === 'object' && 'value' in v) v = v.value;
    return v === undefined || v === null ? null : String(v);
}

function applyCtx(ctx) {
    const v = readSetting(ctx, 'storefront');
    if (!v) return;
    const u = v.toUpperCase();
    if (STOREFRONTS.indexOf(u) >= 0) currentCountry = u;
}

function safeUrl(u) {
    if (typeof u !== 'string') return '';
    const m = u.match(/^https:\/\/([^\/?#]+)/i);
    if (!m) return '';
    const h = m[1].toLowerCase();
    if (h === 'apple.com' || h.endsWith('.apple.com') || h.endsWith('.mzstatic.com')) return u;
    return '';
}

function artwork(u, size) {
    const s = safeUrl(u);
    if (!s) return '';
    return s.replace(/\/\d+x\d+[a-z-]*\.(jpg|png)(?=$|\?)/i, '/' + size + 'x' + size + 'bb.$1');
}

function clampLimit(limit, fallback) {
    const n = parseInt(limit, 10);
    if (!n || n < 1) return fallback;
    return Math.min(n, 50);
}

function cleanId(id) {
    if (id && typeof id === 'object') {
        id = id.id !== undefined ? id.id : id.trackId !== undefined ? id.trackId : id.collectionId;
    }
    const s = toStr(id).replace(/[^0-9]/g, '');
    if (!s) throw new Error('Invalid Apple Music ID: ' + toStr(id));
    return s;
}

function buildQuery(params) {
    const parts = [];
    Object.keys(params).forEach(function (k) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
        }
    });
    return parts.join('&');
}

async function fetchOnce(url) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, 12000) : null;
    try {
        const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
        if (!res.ok) throw new Error('Apple API HTTP ' + res.status);
        const text = await res.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error('Apple API returned invalid JSON');
        }
        return data;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function api(path, params, country) {
    const url = BASE + path + '?' + buildQuery(Object.assign({ country: country }, params));
    try {
        return await fetchOnce(url);
    } catch (first) {
        await new Promise(function (r) { setTimeout(r, 400); });
        try {
            return await fetchOnce(url);
        } catch (second) {
            throw new Error('Apple request failed: ' + (second && second.message ? second.message : 'unknown error'));
        }
    }
}

function logError(where, e) {
    try {
        console.log('[apple-music-catalog] ' + where + ': ' + (e && e.message ? e.message : e));
    } catch (x) {}
}

function isSong(r) {
    return r && r.wrapperType === 'track' && r.kind === 'song' && r.trackId;
}

function mapTrack(r, albumOverride) {
    const cover = artwork(r.artworkUrl100 || (albumOverride && albumOverride.cover), 600);
    return {
        id: toStr(r.trackId),
        title: toStr(r.trackName) || 'Unknown',
        artist: toStr(r.artistName) || 'Unknown',
        album: toStr(r.collectionName || (albumOverride && albumOverride.title)),
        duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : 0,
        albumCover: cover,
        format: 'm4a',
        explicit: r.trackExplicitness === 'explicit',
        audioQuality: 'AAC Preview (30s)',
        releaseDate: toStr(r.releaseDate),
        trackNumber: r.trackNumber || 0,
        discNumber: r.discNumber || 1,
        albumId: toStr(r.collectionId),
        artistId: toStr(r.artistId),
        genre: toStr(r.primaryGenreName),
        url: safeUrl(r.trackViewUrl),
        previewUrl: safeUrl(r.previewUrl)
    };
}

function mapAlbum(r) {
    const cover = artwork(r.artworkUrl100, 600);
    return {
        id: toStr(r.collectionId),
        title: toStr(r.collectionName) || 'Unknown',
        artist: toStr(r.artistName) || 'Unknown',
        artistId: toStr(r.artistId),
        cover: cover,
        year: r.releaseDate ? toStr(r.releaseDate).slice(0, 4) : '',
        releaseDate: toStr(r.releaseDate),
        trackCount: r.trackCount || 0,
        genre: toStr(r.primaryGenreName),
        explicit: r.collectionExplicitness === 'explicit',
        copyright: toStr(r.copyright),
        url: safeUrl(r.collectionViewUrl)
    };
}

function sortTracks(tracks) {
    return tracks.slice().sort(function (a, b) {
        if (a.discNumber !== b.discNumber) return a.discNumber - b.discNumber;
        return a.trackNumber - b.trackNumber;
    });
}

function rememberTracks(tracks, country) {
    for (let i = 0; i < tracks.length; i++) {
        trackMeta[tracks[i].id] = tracks[i];
        trackCountry[tracks[i].id] = country;
    }
}

function rememberAlbums(albums, country) {
    for (let i = 0; i < albums.length; i++) {
        albumCountry[albums[i].id] = country;
    }
}

function noStream(id, reason) {
    logError('stream', reason);
    const key = toStr(id);
    const meta = trackMeta[key];
    const track = meta ? Object.assign({}, meta, { audioQuality: 'HIGH' }) : { id: key, audioQuality: 'HIGH' };
    return { streamUrl: null, track: track };
}

async function searchTracks(query, limit, ctx) {
    try {
        applyCtx(ctx);
        const country = currentCountry;
        const q = toStr(query).trim();
        if (!q) return { tracks: [], total: 0 };
        const lim = clampLimit(limit, 25);
        const key = country + '|' + q.toLowerCase() + '|' + lim;
        const hit = searchCache[key];
        if (hit && Date.now() - hit.ts < SEARCH_TTL_MS) return hit.value;
        const data = await api('/search', { term: q, media: 'music', entity: 'song', limit: lim }, country);
        const results = Array.isArray(data.results) ? data.results : [];
        const tracks = results.filter(isSong).map(function (r) { return mapTrack(r); });
        rememberTracks(tracks, country);
        const value = { tracks: tracks, total: tracks.length };
        searchCache[key] = { value: value, ts: Date.now() };
        return value;
    } catch (e) {
        logError('searchTracks', e);
        return { tracks: [], total: 0 };
    }
}

async function searchAlbums(query, limit, ctx) {
    try {
        applyCtx(ctx);
        const country = currentCountry;
        const q = toStr(query).trim();
        if (!q) return { albums: [], total: 0 };
        const lim = clampLimit(limit, 25);
        const key = 'album|' + country + '|' + q.toLowerCase() + '|' + lim;
        const hit = searchCache[key];
        if (hit && Date.now() - hit.ts < SEARCH_TTL_MS) return hit.value;
        const data = await api('/search', { term: q, media: 'music', entity: 'album', limit: lim }, country);
        const results = Array.isArray(data.results) ? data.results : [];
        const albums = results
            .filter(function (r) { return r && r.wrapperType === 'collection' && r.collectionId; })
            .map(mapAlbum);
        rememberAlbums(albums, country);
        const value = { albums: albums, total: albums.length };
        searchCache[key] = { value: value, ts: Date.now() };
        return value;
    } catch (e) {
        logError('searchAlbums', e);
        return { albums: [], total: 0 };
    }
}

async function resolveStream(trackId, country) {
    const data = await api('/lookup', { id: trackId, entity: 'song' }, country);
    const results = Array.isArray(data.results) ? data.results : [];
    const song = results.filter(isSong)[0];
    if (!song) return { error: 'track not found' };
    const previewUrl = safeUrl(song.previewUrl);
    if (!previewUrl) return { error: 'no preview available' };
    const fresh = mapTrack(song);
    fresh.quality = fresh.audioQuality;
    fresh.isPreview = true;
    fresh.previewDurationSeconds = 30;
    const track = Object.assign({}, trackMeta[trackId] || {}, fresh);
    return {
        result: {
            streamUrl: previewUrl,
            streamType: 'direct',
            mimeType: 'audio/mp4',
            track: track
        }
    };
}

async function getTrackStreamUrl(id, quality, ctx) {
    let trackId;
    try {
        trackId = cleanId(id);
    } catch (e) {
        return noStream(id, e.message);
    }
    if (!ALLOW_PREVIEW) return noStream(trackId, 'preview playback disabled');
    try {
        applyCtx(ctx);
        const country = trackCountry[trackId] || currentCountry;
        const key = trackId + '|' + country;
        const hit = streamCache[key];
        if (hit && Date.now() - hit.ts < STREAM_TTL_MS) return hit.value;
        if (!inflight[key]) inflight[key] = resolveStream(trackId, country);
        let out;
        try {
            out = await inflight[key];
        } finally {
            delete inflight[key];
        }
        if (!out || !out.result) return noStream(trackId, out && out.error ? out.error : 'unresolved');
        streamCache[key] = { value: out.result, ts: Date.now() };
        return out.result;
    } catch (e) {
        return noStream(trackId, e.message);
    }
}

async function getAlbum(id, ctx) {
    try {
        applyCtx(ctx);
        const albumId = cleanId(id);
        const country = albumCountry[albumId] || currentCountry;
        const data = await api('/lookup', { id: albumId, entity: 'song', limit: 200 }, country);
        const results = Array.isArray(data.results) ? data.results : [];
        const collection = results.filter(function (r) {
            return r && r.wrapperType === 'collection';
        })[0];
        if (!collection) return { album: null, tracks: [] };
        const album = mapAlbum(collection);
        const tracks = sortTracks(
            results.filter(isSong).map(function (r) { return mapTrack(r, album); })
        );
        if (tracks.length) album.trackCount = tracks.length;
        rememberTracks(tracks, country);
        albumCountry[albumId] = country;
        return { album: album, tracks: tracks };
    } catch (e) {
        logError('getAlbum', e);
        return { album: null, tracks: [] };
    }
}

async function getArtist(id, ctx) {
    try {
        applyCtx(ctx);
        const country = currentCountry;
        const artistId = cleanId(id);
        const info = await api('/lookup', { id: artistId, entity: 'album', limit: 200 }, country);
        const rows = Array.isArray(info.results) ? info.results : [];
        const artistRow = rows.filter(function (r) { return r && r.wrapperType === 'artist'; })[0];
        if (!artistRow) return { artist: null, tracks: [], albums: [] };
        const albums = rows
            .filter(function (r) { return r && r.wrapperType === 'collection' && r.collectionId; })
            .map(mapAlbum);
        rememberAlbums(albums, country);
        let tracks = [];
        try {
            const top = await api('/lookup', { id: artistId, entity: 'song', limit: 25 }, country);
            const topRows = Array.isArray(top.results) ? top.results : [];
            tracks = topRows.filter(isSong).map(function (r) { return mapTrack(r); });
            rememberTracks(tracks, country);
        } catch (e) {
            tracks = [];
        }
        return {
            artist: {
                id: toStr(artistRow.artistId),
                name: toStr(artistRow.artistName) || 'Unknown',
                cover: albums.length ? albums[0].cover : '',
                genre: toStr(artistRow.primaryGenreName),
                bio: null,
                url: safeUrl(artistRow.artistLinkUrl)
            },
            tracks: tracks,
            albums: albums
        };
    } catch (e) {
        logError('getArtist', e);
        return { artist: null, tracks: [], albums: [] };
    }
}

return {
    id: 'apple-music-catalog',
    name: 'Apple Music Catalog',
    version: '2.2.0',
    labels: ['METADATA', 'PREVIEW'],
    settings: {
        storefront: {
            type: 'selector',
            label: 'Storefront',
            description: 'Which Apple Music country catalog to search. Availability and previews vary by country.',
            options: STOREFRONTS.map(function (c) { return { label: c, value: c }; }),
            defaultValue: DEFAULT_COUNTRY
        }
    },
    searchTracks: searchTracks,
    searchAlbums: searchAlbums,
    getTrackStreamUrl: getTrackStreamUrl,
    getAlbum: getAlbum,
    getArtist: getArtist
};
