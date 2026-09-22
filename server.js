/**
 * Custify Mock Audio Server
 * 
 * Serves audio files mapped to Spotify track IDs.
 * The Android interceptor hits this server to fetch audio when a track plays.
 * 
 * API:
 *   GET /track/:spotifyId          → streams the audio file for that track ID
 *   GET /track/:spotifyId/info     → returns JSON metadata (duration, format, etc.)
 *   GET /health                    → health check
 *   GET /catalog                   → list all available track mappings
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Track Mappings ──────────────────────────────────────────────────────────
// Maps Spotify track IDs to local audio file paths (relative to music/ dir)
// Format: { "spotifyTrackId": "Artist/Album/filename.flac" }

const MUSIC_DIR = path.resolve(__dirname, 'music');
const MAPPINGS_FILE = path.resolve(__dirname, 'track_mappings.json');

let trackMappings = {};

function loadMappings() {
    try {
        if (fs.existsSync(MAPPINGS_FILE)) {
            trackMappings = JSON.parse(fs.readFileSync(MAPPINGS_FILE, 'utf-8'));
            console.log(`[Custify] Loaded ${Object.keys(trackMappings).length} track mapping(s)`);
        } else {
            console.log('[Custify] No track_mappings.json found, creating default...');
            trackMappings = {};
            saveMappings();
        }
    } catch (err) {
        console.error('[Custify] Error loading mappings:', err.message);
    }
}

function saveMappings() {
    fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(trackMappings, null, 2));
}

// ─── Auto-discover mappings from spotify-id.txt ──────────────────────────────
function loadFromSpotifyIdFile() {
    const idFile = path.resolve(__dirname, '..', 'spotify-id.txt');
    if (!fs.existsSync(idFile)) return;

    const lines = fs.readFileSync(idFile, 'utf-8').trim().split('\n');
    let newMappings = 0;

    for (const line of lines) {
        // Format: "70LcF31zb1H0PyJoS1Sx1r -  Creep(E), Pablo Honey, Radiohead"
        const match = line.match(/^(\S+)\s*-\s*(.+),\s*(.+),\s*(.+)$/);
        if (!match) continue;

        const [, trackId, trackName, album, artist] = match;
        const cleanTrack = trackName.trim();
        const cleanAlbum = album.trim();
        const cleanArtist = artist.trim();

        // Skip if already mapped
        if (trackMappings[trackId]) continue;

        // Try to find the audio file in music/ directory
        const artistDir = path.join(MUSIC_DIR, cleanArtist);
        const albumDir = path.join(artistDir, cleanAlbum);

        if (fs.existsSync(albumDir)) {
            const files = fs.readdirSync(albumDir);
            // Find a file that matches the track name (fuzzy)
            const audioFile = files.find(f => {
                const ext = path.extname(f).toLowerCase();
                if (!['.flac', '.mp3', '.wav', '.aac', '.ogg', '.m4a'].includes(ext)) return false;
                const baseName = f.toLowerCase();
                // Match against track name (strip explicit markers, numbers, etc.)
                const searchTerms = cleanTrack
                    .replace(/\(E\)/gi, '')
                    .replace(/\[Explicit\]/gi, '')
                    .trim()
                    .toLowerCase()
                    .split(/\s+/);
                return searchTerms.every(term => baseName.includes(term));
            });

            if (audioFile) {
                const relativePath = path.join(cleanArtist, cleanAlbum, audioFile).replace(/\\/g, '/');
                trackMappings[trackId] = {
                    file: relativePath,
                    title: cleanTrack,
                    album: cleanAlbum,
                    artist: cleanArtist
                };
                newMappings++;
                console.log(`[Custify] Auto-mapped: ${trackId} → ${relativePath}`);
            } else {
                console.warn(`[Custify] No audio file found for "${cleanTrack}" in ${albumDir}`);
            }
        } else {
            console.warn(`[Custify] Album directory not found: ${albumDir}`);
        }
    }

    if (newMappings > 0) {
        saveMappings();
        console.log(`[Custify] Auto-discovered ${newMappings} new mapping(s)`);
    }
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        server: 'custify-mock',
        tracks: Object.keys(trackMappings).length,
        timestamp: Date.now()
    });
});

// List all track mappings
app.get('/catalog', (req, res) => {
    const catalog = Object.entries(trackMappings).map(([id, info]) => ({
        spotifyId: id,
        title: info.title || path.basename(info.file || info, path.extname(info.file || info)),
        album: info.album || 'Unknown',
        artist: info.artist || 'Unknown',
        file: info.file || info
    }));
    res.json({ tracks: catalog, total: catalog.length });
});

// Get track info (metadata without streaming)
app.get('/track/:spotifyId/info', (req, res) => {
    const { spotifyId } = req.params;
    const mapping = trackMappings[spotifyId];

    if (!mapping) {
        return res.status(404).json({ error: 'Track not found', spotifyId });
    }

    const filePath = path.join(MUSIC_DIR, mapping.file || mapping);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Audio file missing', spotifyId, expectedPath: filePath });
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();

    const mimeTypes = {
        '.flac': 'audio/flac',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.aac': 'audio/aac',
        '.ogg': 'audio/ogg',
        '.m4a': 'audio/mp4'
    };

    res.json({
        spotifyId,
        title: mapping.title || '',
        album: mapping.album || '',
        artist: mapping.artist || '',
        format: ext.replace('.', ''),
        mimeType: mimeTypes[ext] || 'application/octet-stream',
        fileSize: stat.size,
        file: mapping.file || mapping
    });
});

// Stream audio file for a track
app.get('/track/:spotifyId', (req, res) => {
    const { spotifyId } = req.params;
    const mapping = trackMappings[spotifyId];

    if (!mapping) {
        console.warn(`[Custify] ❌ Track not found: ${spotifyId}`);
        return res.status(404).json({ error: 'Track not found', spotifyId });
    }

    const filePath = path.join(MUSIC_DIR, mapping.file || mapping);
    if (!fs.existsSync(filePath)) {
        console.warn(`[Custify] ❌ File missing: ${filePath}`);
        return res.status(404).json({ error: 'Audio file missing', spotifyId });
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();

    const mimeTypes = {
        '.flac': 'audio/flac',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.aac': 'audio/aac',
        '.ogg': 'audio/ogg',
        '.m4a': 'audio/mp4'
    };

    // Support range requests (for seeking)
    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': mimeTypes[ext] || 'application/octet-stream'
        });

        fs.createReadStream(filePath, { start, end }).pipe(res);
        console.log(`[Custify] ✅ Streaming (range ${start}-${end}): ${mapping.title || spotifyId}`);
    } else {
        res.writeHead(200, {
            'Content-Length': stat.size,
            'Content-Type': mimeTypes[ext] || 'application/octet-stream',
            'Accept-Ranges': 'bytes',
            'X-Custify-Track': spotifyId,
            'X-Custify-Title': encodeURIComponent(mapping.title || ''),
            'X-Custify-Artist': encodeURIComponent(mapping.artist || '')
        });

        fs.createReadStream(filePath).pipe(res);
        console.log(`[Custify] ✅ Streaming full: ${mapping.title || spotifyId} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
    }
});

// Add a new track mapping via POST
app.post('/track', (req, res) => {
    const { spotifyId, file, title, album, artist } = req.body;
    if (!spotifyId || !file) {
        return res.status(400).json({ error: 'spotifyId and file are required' });
    }

    const filePath = path.join(MUSIC_DIR, file);
    if (!fs.existsSync(filePath)) {
        return res.status(400).json({ error: `File not found: ${file}` });
    }

    trackMappings[spotifyId] = { file, title: title || '', album: album || '', artist: artist || '' };
    saveMappings();

    res.json({ message: 'Track mapped successfully', spotifyId, file });
});

// ─── Start Server ────────────────────────────────────────────────────────────
loadMappings();
loadFromSpotifyIdFile();

app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║              🎵  CUSTIFY MOCK SERVER  🎵               ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Server running on: http://0.0.0.0:${PORT}               ║`);
    console.log(`║  Tracks loaded:     ${String(Object.keys(trackMappings).length).padEnd(35)}║`);
    console.log(`║  Music directory:   ${MUSIC_DIR.substring(0, 35).padEnd(35)}║`);
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  Endpoints:                                             ║');
    console.log('║    GET  /health              → Server health check      ║');
    console.log('║    GET  /catalog             → List all track mappings  ║');
    console.log('║    GET  /track/:id           → Stream audio file        ║');
    console.log('║    GET  /track/:id/info      → Track metadata           ║');
    console.log('║    POST /track               → Add new mapping          ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    
    // Print loaded mappings
    for (const [id, info] of Object.entries(trackMappings)) {
        console.log(`  📀 ${id} → ${info.artist} - ${info.title}`);
    }
    console.log('');
});
