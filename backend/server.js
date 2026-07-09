const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function supabaseHeaders() {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'public',
    'Content-Profile': 'public'
  };
}

async function uploadImage(base64DataUrl) {
  const base64 = base64DataUrl.split(',')[1];
  const buffer = Buffer.from(base64, 'base64');
  const filename = `${crypto.randomUUID()}.png`;

  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/strips/${filename}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'image/png',
      'x-upsert': 'false'
    },
    body: buffer
  });

  if (!res.ok) throw new Error(`Storage upload failed: ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/strips/${filename}`;
}

async function insertStrip(imageUrl, createdAt) {
  const body = createdAt
    ? { image_url: imageUrl, created_at: createdAt }
    : { image_url: imageUrl };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/strips`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`DB insert failed: ${await res.text()}`);
  const rows = await res.json();
  return rows[0];
}

async function fetchStrips() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/strips?select=id,image_url,created_at&order=created_at.desc`, {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Accept': 'application/json'
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB fetch failed: ${text}`);
  return JSON.parse(text);
}

async function deleteStrip(id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/strips?id=eq.${id}&select=image_url`, {
    headers: supabaseHeaders()
  });
  const rows = await res.json();
  if (rows.length) {
    const filename = rows[0].image_url.split('/strips/')[1];
    await fetch(`${SUPABASE_URL}/storage/v1/object/strips/${filename}`, {
      method: 'DELETE',
      headers: supabaseHeaders()
    });
  }
  await fetch(`${SUPABASE_URL}/rest/v1/strips?id=eq.${id}`, {
    method: 'DELETE',
    headers: supabaseHeaders()
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.url === '/debug' && req.method === 'GET') {
    sendJSON(res, 200, {
      hasUrl: !!SUPABASE_URL,
      hasKey: !!SUPABASE_KEY,
      urlStart: SUPABASE_URL ? SUPABASE_URL.substring(0, 30) : 'missing'
    });
    return;
  }

  if (req.url === '/strips' && req.method === 'GET') {
    fetchStrips()
      .then(strips => sendJSON(res, 200, strips.map(s => ({
        id: s.id,
        dataUrl: s.image_url,
        timestamp: new Date(s.created_at).getTime()
      }))))
      .catch(e => { console.error(e); sendJSON(res, 500, { error: e.message }); });
    return;
  }

  if (req.url === '/strips' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { dataUrl, createdAt } = JSON.parse(body);
        if (!dataUrl) { sendJSON(res, 400, { error: 'missing dataUrl' }); return; }
        const imageUrl = await uploadImage(dataUrl);
        const strip = await insertStrip(imageUrl, createdAt || null);
        sendJSON(res, 200, {
          id: strip.id,
          dataUrl: imageUrl,
          timestamp: new Date(strip.created_at).getTime()
        });
      } catch (e) {
        console.error(e);
        sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }

  if (req.url.startsWith('/strips/') && req.method === 'DELETE') {
    const id = req.url.split('/strips/')[1];
    deleteStrip(id)
      .then(() => sendJSON(res, 200, { deleted: id }))
      .catch(e => { console.error(e); sendJSON(res, 500, { error: e.message }); });
    return;
  }

  // Bulk export — returns all strips with full image data as base64
  if (req.url === '/strips/export' && req.method === 'GET') {
    fetchStrips()
      .then(async strips => {
        // Fetch each image and convert to base64 for portability
        const withData = await Promise.all(strips.map(async s => {
          try {
            const imgRes = await fetch(s.image_url);
            const buf = await imgRes.arrayBuffer();
            const b64 = Buffer.from(buf).toString('base64');
            return {
              id: s.id,
              dataUrl: `data:image/png;base64,${b64}`,
              timestamp: new Date(s.created_at).getTime(),
              created_at: s.created_at
            };
          } catch {
            return {
              id: s.id,
              dataUrl: s.image_url,
              timestamp: new Date(s.created_at).getTime(),
              created_at: s.created_at
            };
          }
        }));
        sendJSON(res, 200, { version: 1, exported_at: new Date().toISOString(), strips: withData });
      })
      .catch(e => { console.error(e); sendJSON(res, 500, { error: e.message }); });
    return;
  }

  // Bulk import — accepts the export JSON and re-uploads everything
  if (req.url === '/strips/import' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { strips } = JSON.parse(body);
        if (!Array.isArray(strips)) { sendJSON(res, 400, { error: 'invalid format' }); return; }
        // Import in reverse so newest ends up on top after created_at ordering
        const results = [];
        for (const s of [...strips].reverse()) {
          const imageUrl = await uploadImage(s.dataUrl);
          const inserted = await insertStrip(imageUrl, s.created_at || new Date(s.timestamp).toISOString());
          results.push(inserted.id);
        }
        sendJSON(res, 200, { imported: results.length });
      } catch (e) {
        console.error(e);
        sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }

  res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
  res.end('Photobooth server running');
});

const wss = new WebSocketServer({ server });
const rooms = {};

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'sync') {
      ws.send(JSON.stringify({ type: 'sync_reply', t0: msg.t0, serverTime: Date.now() }));
      return;
    }

    if (msg.type === 'join') {
      ws.room = msg.room;
      ws.name = msg.name;
      if (!rooms[msg.room]) rooms[msg.room] = [];
      rooms[msg.room].push(ws);

      const idx = rooms[msg.room].indexOf(ws);
      ws.role = idx === 0 ? 'left' : 'right';

      ws.send(JSON.stringify({
        type: 'room_info',
        count: rooms[msg.room].length,
        role: ws.role
      }));

      broadcast(ws, { type: 'partner_joined', name: msg.name, role: ws.role });
      return;
    }

    broadcast(ws, msg);
  });

  ws.on('close', () => {
    if (ws.room && rooms[ws.room]) {
      rooms[ws.room] = rooms[ws.room].filter(p => p !== ws);
      broadcast(ws, { type: 'partner_left' });
    }
  });
});

function broadcast(sender, msg) {
  const peers = (rooms[sender.room] || []).filter(p => p !== sender);
  peers.forEach(p => p.send(JSON.stringify(msg)));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));