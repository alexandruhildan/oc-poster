const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_PAGE_ID = process.env.FB_PAGE_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DB_FILE = './data.json';

app.use(express.json());
app.use(express.static('public'));

// Serve index.html at root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── JSON "database" ────────────────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { posts: [], history: [], nextId: 1 };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { posts: [], history: [], nextId: 1 }; }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ── Helpers ────────────────────────────────────────────────────────────────────
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
  const db = loadDB();
  const pending = db.posts.filter(p => p.status === 'pending')
    .sort((a, b) => (a.sched_date + a.sched_time).localeCompare(b.sched_date + b.sched_time));
  res.json(pending);
});

app.get('/api/history', (req, res) => {
  const db = loadDB();
  res.json((db.history || []).slice(-30).reverse());
});

// ── API: Generate AI description ───────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL lipsă' });
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OCPoster/1.0)' },
      signal: AbortSignal.timeout(8000)
    });
    const html = await r.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const h1Match = html.match(/<h1[^>]*>([^<]*)<\/h1>/i);
    const title = (titleMatch?.[1] || h1Match?.[1] || '').replace(/\s*[-|–].*$/, '').trim();
    const bodyText = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 1200);

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
- Stârnește curiozitate sau emoție puternică
- Fără ghilimele, fără link, fără hashtag-uri
- Exemple: "Polița de mediu a dat amenzi usturatoare la Constanța", "Scandal mare: autoritățile iau măsuri drastice"

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
  const db = loadDB();
  const post = {
    id: db.nextId++,
    url, description,
    sched_date: sched_date || todayStr(),
    sched_time,
    status: 'pending',
    created_at: new Date().toISOString()
  };
  db.posts.push(post);
  saveDB(db);
  res.json(post);
});

// ── API: Update post ───────────────────────────────────────────────────────────
app.put('/api/queue/:id', (req, res) => {
  const db = loadDB();
  const post = db.posts.find(p => p.id === parseInt(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post negăsit' });
  const { description, sched_date, sched_time } = req.body;
  if (description !== undefined) post.description = description;
  if (sched_date !== undefined) post.sched_date = sched_date;
  if (sched_time !== undefined) post.sched_time = sched_time;
  saveDB(db);
  res.json({ success: true });
});

// ── API: Delete post ───────────────────────────────────────────────────────────
app.delete('/api/queue/:id', (req, res) => {
  const db = loadDB();
  db.posts = db.posts.filter(p => p.id !== parseInt(req.params.id));
  saveDB(db);
  res.json({ success: true });
});

// ── API: Post immediately ──────────────────────────────────────────────────────
app.post('/api/post-now/:id', async (req, res) => {
  const db = loadDB();
  const post = db.posts.find(p => p.id === parseInt(req.params.id));
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
  
  const r = await fetch(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: post.description, link: post.url, access_token: FB_PAGE_TOKEN })
  });
  const data = await r.json();
  if (data.error) throw new Error(`FB: ${data.error.message}`);

  const db = loadDB();
  const postIdx = db.posts.findIndex(p => p.id === post.id);
  if (postIdx !== -1) {
    db.posts[postIdx].status = 'posted';
    db.posts[postIdx].fb_post_id = data.id;
  }
  if (!db.history) db.history = [];
  db.history.push({
    url: post.url,
    description: post.description,
    sched_time: `${post.sched_date} ${post.sched_time}`,
    fb_post_id: data.id,
    posted_at: new Date().toISOString()
  });
  saveDB(db);
  console.log(`✅ Posted: ${post.description}`);
  return data.id;
}

// ── Cron: every minute ─────────────────────────────────────────────────────────
cron.schedule('* * * * *', () => {
  const today = todayStr();
  const time = currentTimeStr();
  const db = loadDB();
  const toPost = db.posts.filter(p => p.status === 'pending' && p.sched_date === today && p.sched_time === time);
  for (const post of toPost) {
    postToFacebook(post).catch(e => console.error(`❌ Failed #${post.id}: ${e.message}`));
  }
});



// ── API: Get Facebook scheduled posts ─────────────────────────────────────────
app.get('/api/fb-scheduled', async (req, res) => {
  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/scheduled_posts?fields=message,scheduled_publish_time,permalink_url&access_token=${FB_PAGE_TOKEN}`
    );
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    
    const posts = (data.data || []).map(p => ({
      id: p.id,
      message: p.message || '',
      scheduled_time: new Date(p.scheduled_publish_time * 1000).toISOString(),
      permalink_url: p.permalink_url || '',
      source: 'facebook'
    }));
    res.json(posts);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Auth ───────────────────────────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  const { pin } = req.body;
  const correctPin = process.env.APP_PIN || '1234';
  res.json({ ok: pin === correctPin });
});

// ── Keep-alive ─────────────────────────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, time: currentTimeStr(), today: todayStr() }));

app.listen(PORT, () => {
  console.log(`🚀 OC Poster on port ${PORT}`);
  console.log(`🕐 Romania time: ${currentTimeStr()}`);
});
