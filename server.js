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
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Track Mappings ──────────────────────────────────────────────────────────
// JSON mappings are deprecated in favor of SQLite (spotify_mappings table)
// to support hundreds of thousands of tracks.

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
    try {
        const dbPath = path.resolve(__dirname, 'keys.db');
        if (!fs.existsSync(dbPath)) {
            return res.status(500).json({ error: 'keys.db not found' });
        }
        
        const db = new Database(dbPath, { readonly: true });
        const catalog = db.prepare(`
            SELECT sm.spotify_id as spotifyId, ac.title, ac.album, ac.artist, sm.asin
            FROM spotify_mappings sm
            LEFT JOIN asin_cache ac ON sm.asin = ac.asin
        `).all();
        db.close();
        
        res.json({ tracks: catalog, total: catalog.length });
    } catch (e) {
        res.status(500).json({ error: 'Database error', details: e.message });
    }
});

// Get track info (Amazon CDN URL + Decryption Key)
app.get('/track/:spotifyId/info', (req, res) => {
    const { spotifyId } = req.params;

    try {
        const dbPath = path.resolve(__dirname, 'keys.db');
        if (!fs.existsSync(dbPath)) {
            return res.status(500).json({ error: 'keys.db not found' });
        }
        
        const db = new Database(dbPath, { readonly: true });
        
        // 1. Lookup ASIN from Spotify ID
        const mapRow = db.prepare('SELECT asin FROM spotify_mappings WHERE spotify_id = ?').get(spotifyId);
        if (!mapRow) {
            db.close();
            return res.status(404).json({ error: 'Track not mapped to ASIN', spotifyId });
        }
        const asin = mapRow.asin;

        // 2. Fetch Keys & URL
        const row = db.prepare('SELECT url, keys_json FROM keys WHERE asin = ?').get(asin);
        
        // 3. Fetch metadata
        const metaRow = db.prepare('SELECT title, artist, album FROM asin_cache WHERE asin = ?').get(asin);
        db.close();

        if (!row) {
            return res.status(404).json({ error: 'ASIN not found in keys.db', asin });
        }

        const keysArray = JSON.parse(row.keys_json);
        const keyHex = keysArray.length > 0 ? keysArray[0].k : null;

        if (!keyHex) {
            return res.status(500).json({ error: 'No decryption key found for ASIN', asin });
        }

        res.json({
            spotifyId,
            asin,
            title: metaRow ? metaRow.title : '',
            artist: metaRow ? metaRow.artist : '',
            album: metaRow ? metaRow.album : '',
            url: row.url,
            keyHex: keyHex,
            format: 'flac-raw' // Expected by the Android native decryptor
        });
        console.log(`[Custify] 🔑 Served key for ${spotifyId} -> ${asin}`);
    } catch (e) {
        console.error('[Custify] Database error:', e.message);
        res.status(500).json({ error: 'Database error', details: e.message });
    }
});

// Add a new track mapping via POST
app.post('/track', (req, res) => {
    const { spotifyId, asin } = req.body;
    if (!spotifyId || !asin) {
        return res.status(400).json({ error: 'spotifyId and asin are required' });
    }

    try {
        const dbPath = path.resolve(__dirname, 'keys.db');
        const db = new Database(dbPath);
        db.prepare('CREATE TABLE IF NOT EXISTS spotify_mappings (spotify_id TEXT PRIMARY KEY, asin TEXT NOT NULL)').run();
        db.prepare('INSERT OR REPLACE INTO spotify_mappings (spotify_id, asin) VALUES (?, ?)').run(spotifyId, asin);
        db.close();
        res.json({ message: 'Track mapped successfully', spotifyId, asin });
    } catch (e) {
        res.status(500).json({ error: 'Database error', details: e.message });
    }
});

// ─── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║              🎵  CUSTIFY MOCK SERVER  🎵               ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Server running on: http://0.0.0.0:${PORT}               ║`);
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  Endpoints:                                             ║');
    console.log('║    GET  /health              → Server health check      ║');
    console.log('║    GET  /catalog             → List all track mappings  ║');
    console.log('║    GET  /track/:id/info      → Returns Amazon URL + Key ║');
    console.log('║    POST /track               → Add new mapping          ║');
    console.log('║    POST /track               → Add new mapping          ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
});
