const ALLOW_PREVIEW = true;
const COUNTRY = 'US';
const BASE = 'https://itunes.apple.com';

function toStr(v) {
    return v === undefined || v === null ? '' : String(v);
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

async function api(path, params) {
    const url = BASE + path + '?' + buildQuery(Object.assign({ country: COUNTRY }, params));
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

function isSong(r) {
    return r && r.wrapperType === 'track' && r.kind === 'song' && r.trackId;
}

function mapTrack(r, albumOverride) {
    const cover = artwork(r.artworkUrl100 || (albumOverride && albumOverride.cover), 600);
    return {
        id: toStr(r.trackId),
        title: toStr(r.trackName),
        artist: toStr(r.artistName),
        album: toStr(r.collectionName || (albumOverride && albumOverride.title)),
        duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : 0,
        albumCover: cover,
        cover: cover,
        releaseDate: toStr(r.releaseDate),
        trackNumber: r.trackNumber || 0,
        discNumber: r.discNumber || 1,
        trackCount: r.trackCount || 0,
        albumId: toStr(r.collectionId),
        artistId: toStr(r.artistId),
        genre: toStr(r.primaryGenreName),
        explicit: r.trackExplicitness === 'explicit',
        url: safeUrl(r.trackViewUrl),
        previewUrl: safeUrl(r.previewUrl)
    };
}

function mapAlbum(r) {
    const cover = artwork(r.artworkUrl100, 600);
    return {
        id: toStr(r.collectionId),
        title: toStr(r.collectionName),
        name: toStr(r.collectionName),
        artist: toStr(r.artistName),
        artistId: toStr(r.artistId),
        cover: cover,
        albumCover: cover,
        releaseDate: toStr(r.releaseDate),
        year: r.releaseDate ? toStr(r.releaseDate).slice(0, 4) : '',
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

const MODULE = {
    id: 'apple-music-catalog',
    name: 'Apple Music Catalog',
    version: '2.0.0',
    labels: ['METADATA', 'PREVIEW'],

    searchTracks: async function (query, limit) {
        const q = toStr(query).trim();
        if (!q) return { tracks: [], total: 0 };
        const data = await api('/search', {
            term: q,
            media: 'music',
            entity: 'song',
            limit: clampLimit(limit, 25)
        });
        const results = Array.isArray(data.results) ? data.results : [];
        const tracks = results.filter(isSong).map(function (r) { return mapTrack(r); });
        return { tracks: tracks, total: tracks.length };
    },

    searchAlbums: async function (query, limit) {
        const q = toStr(query).trim();
        if (!q) return { albums: [], total: 0 };
        const data = await api('/search', {
            term: q,
            media: 'music',
            entity: 'album',
            limit: clampLimit(limit, 25)
        });
        const results = Array.isArray(data.results) ? data.results : [];
        const albums = results
            .filter(function (r) { return r && r.wrapperType === 'collection' && r.collectionId; })
            .map(mapAlbum);
        return { albums: albums, total: albums.length };
    },

    getTrackStreamUrl: async function (id, quality) {
        const trackId = cleanId(id);
        if (!ALLOW_PREVIEW) {
            throw new Error('Full-length Apple Music playback is not available through public APIs');
        }
        const data = await api('/lookup', { id: trackId, entity: 'song' });
        const results = Array.isArray(data.results) ? data.results : [];
        const song = results.filter(isSong)[0];
        if (!song) throw new Error('Track not found: ' + trackId);
        const previewUrl = safeUrl(song.previewUrl);
        if (!previewUrl) throw new Error('No preview available for track: ' + trackId);
        const track = mapTrack(song);
        track.audioQuality = 'LOW';
        track.isPreview = true;
        track.previewDurationSeconds = 30;
        return { streamUrl: previewUrl, track: track };
    },

    getAlbum: async function (id) {
        const albumId = cleanId(id);
        const data = await api('/lookup', { id: albumId, entity: 'song', limit: 200 });
        const results = Array.isArray(data.results) ? data.results : [];
        const collection = results.filter(function (r) {
            return r && r.wrapperType === 'collection';
        })[0];
        if (!collection) throw new Error('Album not found: ' + albumId);
        const album = mapAlbum(collection);
        const tracks = sortTracks(
            results.filter(isSong).map(function (r) { return mapTrack(r, album); })
        );
        album.trackCount = tracks.length || album.trackCount;
        return { album: album, tracks: tracks };
    },

    getArtist: async function (id) {
        const artistId = cleanId(id);
        const info = await api('/lookup', { id: artistId, entity: 'album', limit: 200 });
        const rows = Array.isArray(info.results) ? info.results : [];
        const artistRow = rows.filter(function (r) { return r && r.wrapperType === 'artist'; })[0];
        if (!artistRow) throw new Error('Artist not found: ' + artistId);
        const albums = rows
            .filter(function (r) { return r && r.wrapperType === 'collection' && r.collectionId; })
            .map(mapAlbum);
        let tracks = [];
        try {
            const top = await api('/lookup', { id: artistId, entity: 'song', limit: 25 });
            const topRows = Array.isArray(top.results) ? top.results : [];
            tracks = topRows.filter(isSong).map(function (r) { return mapTrack(r); });
        } catch (e) {
            tracks = [];
        }
        return {
            artist: {
                id: toStr(artistRow.artistId),
                name: toStr(artistRow.artistName),
                genre: toStr(artistRow.primaryGenreName),
                url: safeUrl(artistRow.artistLinkUrl),
                picture: albums.length ? albums[0].cover : ''
            },
            albums: albums,
            tracks: tracks
        };
    }
};

return MODULE;
