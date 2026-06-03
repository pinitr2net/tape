require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
const ENDPOINT_ID = process.env.ENDPOINT_ID;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pages (
      id         SERIAL PRIMARY KEY,
      slug       TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS recordings (
      id             SERIAL PRIMARY KEY,
      page_id        INTEGER REFERENCES pages(id) ON DELETE CASCADE,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      audio_url      TEXT,
      audio_key      TEXT,
      mime_type      TEXT,
      raw_text       TEXT,
      corrected_text TEXT,
      system_prompt  TEXT
    );
  `);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const jobRecordings = new Map();

// Serve page.html for /p/:slug routes
app.get('/p/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'page.html'));
});

// --- Pages API ---

app.get('/api/pages', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, slug, created_at FROM pages ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pages', async (req, res) => {
  const { slug } = req.body;
  if (!slug?.trim()) return res.status(400).json({ error: 'שם הדף נדרש' });
  try {
    const result = await pool.query(
      'INSERT INTO pages (slug) VALUES ($1) RETURNING *',
      [slug.trim()]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'שם הדף כבר קיים' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pages/:slug', async (req, res) => {
  try {
    const pageResult = await pool.query('SELECT * FROM pages WHERE slug = $1', [req.params.slug]);
    if (!pageResult.rows.length) return res.status(404).json({ error: 'דף לא נמצא' });
    const page = pageResult.rows[0];
    const recResult = await pool.query(
      'SELECT id, created_at, audio_url, mime_type, raw_text, corrected_text, system_prompt FROM recordings WHERE page_id = $1 ORDER BY created_at DESC',
      [page.id]
    );
    res.json({ ...page, recordings: recResult.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/pages/:slug', async (req, res) => {
  try {
    const pageResult = await pool.query('SELECT * FROM pages WHERE slug = $1', [req.params.slug]);
    if (!pageResult.rows.length) return res.status(404).json({ error: 'דף לא נמצא' });
    const page = pageResult.rows[0];
    const recResult = await pool.query(
      'SELECT audio_key FROM recordings WHERE page_id = $1 AND audio_key IS NOT NULL',
      [page.id]
    );
    await Promise.all(recResult.rows.map(r =>
      s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r.audio_key })).catch(() => {})
    ));
    await pool.query('DELETE FROM pages WHERE id = $1', [page.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Recordings API ---

app.delete('/api/recordings/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT audio_key FROM recordings WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'הקלטה לא נמצאה' });
    const { audio_key } = result.rows[0];
    if (audio_key) {
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: audio_key })).catch(() => {});
    }
    await pool.query('DELETE FROM recordings WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Transcription ---

app.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
  const { pageSlug } = req.body;
  if (!pageSlug) return res.status(400).json({ error: 'pageSlug required' });

  try {
    const pageResult = await pool.query('SELECT id FROM pages WHERE slug = $1', [pageSlug]);
    if (!pageResult.rows.length) return res.status(404).json({ error: 'דף לא נמצא' });
    const pageId = pageResult.rows[0].id;

    const ext = path.extname(req.file.originalname) || '.webm';
    const key = crypto.randomUUID() + ext;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'audio/webm',
    }));
    const audioUrl = `${R2_PUBLIC_URL}/${key}`;
    console.log('Uploaded to R2:', audioUrl);

    const recResult = await pool.query(
      'INSERT INTO recordings (page_id, audio_url, audio_key, mime_type) VALUES ($1, $2, $3, $4) RETURNING id',
      [pageId, audioUrl, key, req.file.mimetype]
    );
    const recordingId = recResult.rows[0].id;

    const runpodRes = await axios.post(
      `https://api.runpod.ai/v2/${ENDPOINT_ID}/run`,
      {
        input: {
          model: 'ivrit-ai/whisper-large-v3-turbo-ct2',
          transcribe_args: { url: audioUrl, language: 'he', verbose: false },
        },
      },
      {
        headers: { Authorization: `Bearer ${RUNPOD_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );

    const jobId = runpodRes.data?.id;
    if (!jobId) {
      return res.status(500).json({ error: 'No job ID from RunPod', raw: runpodRes.data });
    }

    jobRecordings.set(jobId, recordingId);
    res.json({ jobId, recordingId });
  } catch (err) {
    console.error('Error in /transcribe:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

app.get('/status/:jobId', async (req, res) => {
  const { jobId } = req.params;

  try {
    const statusRes = await axios.get(
      `https://api.runpod.ai/v2/${ENDPOINT_ID}/status/${jobId}`,
      {
        headers: { Authorization: `Bearer ${RUNPOD_API_KEY}` },
        timeout: 15000,
      }
    );

    const data = statusRes.data;
    console.log('RunPod status:', data.status);

    if (data.status === 'FAILED') {
      console.error('RunPod FAILED:', JSON.stringify(data));
      jobRecordings.delete(jobId);
      return res.status(500).json({ error: data.error || 'RunPod job failed' });
    }

    if (data.status !== 'COMPLETED') {
      return res.json({ status: data.status });
    }

    const output = data.output;
    const parsed = typeof output === 'string' ? JSON.parse(output) : output;
    const segments = parsed?.[0]?.result?.flat() ?? [];
    const text = segments.length > 0
      ? segments.map(s => s.text).join('')
      : JSON.stringify(parsed);

    const recordingId = jobRecordings.get(jobId);
    jobRecordings.delete(jobId);

    if (recordingId) {
      await pool.query('UPDATE recordings SET raw_text = $1 WHERE id = $2', [text, recordingId]);
    }

    res.json({ status: 'COMPLETED', text, recordingId });
  } catch (err) {
    console.error('Error polling status:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

const DEFAULT_SYSTEM_PROMPT = 'אתה עוזר לתקן שיבושי תמלול של דיבור לטקסט בעברית. תקן שגיאות כתיב, חלוקת מילים שגויה ושיבושי הקלטה. החזר רק את הטקסט המתוקן, ללא הסברים.';

app.post('/correct', async (req, res) => {
  const { text, systemPrompt, recordingId } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt || DEFAULT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    });
    const corrected = response.content.find(b => b.type === 'text')?.text ?? '';

    if (recordingId) {
      await pool.query(
        'UPDATE recordings SET corrected_text = $1, system_prompt = $2 WHERE id = $3',
        [corrected, systemPrompt || DEFAULT_SYSTEM_PROMPT, recordingId]
      );
    }

    res.json({ corrected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Tape server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('DB init failed:', err.message);
    process.exit(1);
  });
