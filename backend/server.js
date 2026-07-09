const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'strips.json');

function loadStrips() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveStrips(strips) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(strips));
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

  if (req.url === '/strips' && req.method === 'GET') {
    sendJSON(res, 200, loadStrips());
    return;
  }

  if (req.url === '/strips' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { dataUrl } = JSON.parse(body);
        if (!dataUrl) { sendJSON(res, 400, { error: 'missing dataUrl' }); return; }
        const strips = loadStrips();
        const entry = { id: crypto.randomUUID(), dataUrl, timestamp: Date.now() };
        strips.unshift(entry);
        saveStrips(strips);
        sendJSON(res, 200, entry);
      } catch (e) {
        sendJSON(res, 400, { error: 'invalid body' });
      }
    });
    return;
  }

  if (req.url.startsWith('/strips/') && req.method === 'DELETE') {
    const id = req.url.split('/strips/')[1];
    const strips = loadStrips().filter(s => s.id !== id);
    saveStrips(strips);
    sendJSON(res, 200, { deleted: id });
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