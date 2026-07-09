const { WebSocketServer } = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200);
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