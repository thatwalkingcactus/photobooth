const { WebSocketServer } = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Photobooth server running');
});

const wss = new WebSocketServer({ server });

const rooms = {};

wss.on('connection', (ws) => {
  console.log('Someone connected');

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);

    if (msg.type === 'join') {
      ws.room = msg.room;
      ws.name = msg.name;
      if (!rooms[msg.room]) rooms[msg.room] = [];
      rooms[msg.room].push(ws);
      console.log(`${msg.name} joined room: ${msg.room}`);

      // Tell them how many people are in the room
      ws.send(JSON.stringify({
        type: 'room_info',
        count: rooms[msg.room].length
      }));

      // Notify the other person
      broadcast(ws, { type: 'partner_joined' });
    } else {
      // Forward everything else to the other person
      broadcast(ws, msg);
    }
  });

  ws.on('close', () => {
    if (ws.room && rooms[ws.room]) {
      rooms[ws.room] = rooms[ws.room].filter(p => p !== ws);
      broadcast(ws, { type: 'partner_left' });
      console.log(`${ws.name} left room: ${ws.room}`);
    }
  });
});

function broadcast(sender, msg) {
  const peers = (rooms[sender.room] || []).filter(p => p !== sender);
  peers.forEach(p => p.send(JSON.stringify(msg)));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));