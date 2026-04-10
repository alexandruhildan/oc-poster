const express = require('express');
const cron = require('node-cron');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_PAGE_ID = process.env.FB_PAGE_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(express.json());
app.use(express.static('public'));

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database('./posts.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    url      TEXT    NOT NULL,
    description TEXT,
    sched_date  TEXT NOT NULL,
    sched_time  TEXT NOT NULL,
    status   TEXT DEFAULT 'pending',
    fb_post_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS history (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    url      TEXT,
    description TEXT,
    sched_time  TEXT,
    posted_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    fb_post_id  TEXT
  );
`);

// ── Helpers ───────────────────────────────────────────────────────────────────
function nowInRomania() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Bucharest' }));
}

function todayStr() {
  const d = nowInRomania();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function currentTimeStr() {
  const d = nowInRomania();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// ── API: Queue ─────────────────────────────────────────────────────────────────
app.get('/api/queue', (req, res) => {
  const posts = db.prepare(
    "SELECT * FROM posts WHERE status='pending' ORDER BY sched_date ASC, sched_time ASC"
  ).all();
  res.json(posts);
});

app.get('/api/history', (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM history ORDER BY posted_at DESC LIMIT 30"
  ).all();
  res.json(rows);
});

// ── API: Generate description with AI ─────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL lipsă' });

  try {
    // Fetch article
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OCPoster/1.0)' },
      signal: AbortSignal.timeout(8000)
    });
    const html = await r.text();

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const h1Match = html.match(/<h1[^>]*>([^<]*)<\/h1>/i);
    const title = (titleMatch?.[1] || h1Match?.[1] || '')
      .replace(/\s*[-|–].*$/, '').trim();

    const bodyText = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1200);

    // Call Claude
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `Ești editor la ziarul Observator Constanța. Scrie o descriere scurtă și virală pentru Facebook.

Titlu articol: ${title}
Conținut: ${bodyText.slice(0, 600)}

Reguli stricte:
- Maxim 12 cuvinte
- Română
- Stârnește curiozitate sau emoție puternică (surpriză, indignare, interes)
- Fără ghilimele, fără link, fără hashtag-uri
- Stiluri bune: "Polița de mediu a dat amenzi usturatoare la Constanța", "Ce a pățit un șofer după ce a parcat ilegal în centru", "Scandal mare la Constanța: autoritățile iau măsuri drastice"

Răspunde NUMAI cu descrierea, nimic altceva.`
        }]
      })
    });

    const aiData = await aiRes.json();
    if (aiData.error) throw new Error(aiData.error.message);
    res.json({ description: aiData.content[0].text.trim() });
  } catch (e) {
    console.error('Generate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: Add post ──────────────────────────────────────────────────────────────
app.post('/api/add', (req, res) => {
  const { url, description, sched_date, sched_time } = req.body;
  if (!url || !sched_time) return res.status(400).json({ error: 'Date lipsă' });

  const date = sched_date || todayStr();
  const stmt = db.prepare(
    "INSERT INTO posts (url, description, sched_date, sched_time) VALUES (?, ?, ?, ?)"
  );
  const result = stmt.run(url, description, date, sched_time);
  res.json({ id: result.lastInsertRowid, url, description, sched_date: date, sched_time, status: 'pending' });
});

// ── API: Update post ───────────────────────────────────────────────────────────
app.put('/api/queue/:id', (req, res) => {
  const { description, sched_date, sched_time } = req.body;
  db.prepare(
    "UPDATE posts SET description=?, sched_date=?, sched_time=? WHERE id=?"
  ).run(description, sched_date, sched_time, req.params.id);
  res.json({ success: true });
});

// ── API: Delete post ───────────────────────────────────────────────────────────
app.delete('/api/queue/:id', (req, res) => {
  db.prepare("DELETE FROM posts WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// ── API: Post immediately ──────────────────────────────────────────────────────
app.post('/api/post-now/:id', async (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id=?").get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post negăsit' });
  try {
    const fbId = await postToFacebook(post);
    res.json({ success: true, fb_post_id: fbId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Facebook API ───────────────────────────────────────────────────────────────
async function postToFacebook(post) {
  const message = `${post.description}\n\n${post.url}`;
  const r = await fetch(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, access_token: FB_PAGE_TOKEN })
  });
  const data = await r.json();
  if (data.error) throw new Error(`FB Error: ${data.error.message}`);

  // Move to history
  db.prepare(
    "INSERT INTO history (url, description, sched_time, fb_post_id) VALUES (?, ?, ?, ?)"
  ).run(post.url, post.description, `${post.sched_date} ${post.sched_time}`, data.id);
  db.prepare("UPDATE posts SET status='posted', fb_post_id=? WHERE id=?").run(data.id, post.id);

  console.log(`✅ Posted: ${post.description} | ${post.url}`);
  return data.id;
}

// ── Cron: every minute ─────────────────────────────────────────────────────────
cron.schedule('* * * * *', () => {
  const today = todayStr();
  const time  = currentTimeStr();

  const posts = db.prepare(
    "SELECT * FROM posts WHERE status='pending' AND sched_date=? AND sched_time=?"
  ).all(today, time);

  for (const post of posts) {
    postToFacebook(post).catch(e =>
      console.error(`❌ Failed to post #${post.id}: ${e.message}`)
    );
  }
});

// ── Keep-alive endpoint (for uptime monitors) ──────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, time: currentTimeStr() }));

app.listen(PORT, () => {
  console.log(`🚀 OC Poster running on port ${PORT}`);
  console.log(`🕐 Romania time: ${currentTimeStr()}`);
});
