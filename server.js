const express = require('express');
const WebSocket = require('ws');
const randomColor = require('randomcolor');
const path = require('path');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files (client.html, style.css)
app.use(express.static(path.join(__dirname)));

// Room structure: { roomName: Set of clients }
const rooms = {};
// User color map: { name: color }
const userColors = {};

wss.on('connection', (ws) => {
  ws.rooms = new Set();
  ws.userName = null;

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      ws.send(JSON.stringify({ error: 'Invalid JSON', errorType: 'invalidJson' }));
      return;
    }

    const { action, room, text, name } = data;

    if (action === 'join' && room && name) {
      // Remove duplicate room name check
      // Check for duplicate name in the room
      const nameExists = Array.from(rooms[room] || []).some(client => client.userName === name);
      if (nameExists) {
        ws.send(JSON.stringify({ error: `Name '${name}' is already taken in room '${room}'. Please choose another name.`, errorType: 'duplicateName' }));
        return;
      }
      ws.userName = name;
      if (!userColors[name]) {
        userColors[name] = randomColor();
      }
      if (!rooms[room]) rooms[room] = new Set();
      rooms[room].add(ws);
      ws.rooms.add(room);
      // Notify all users in the room
      rooms[room].forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ info: `${name} joined room ${room}`, name, color: userColors[name] }));
        }
      });
    } else if (action === 'leave' && room) {
      if (rooms[room]) rooms[room].delete(ws);
      ws.rooms.delete(room);
      // Notify all users in the room
      if (userColors[ws.userName]) {
        rooms[room]?.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ info: `${ws.userName} left room ${room}`, name: ws.userName, color: userColors[ws.userName] }));
          }
        });
      }
    } else if (action === 'message' && room && text) {
      if (rooms[room]) {
        const color = userColors[ws.userName] || '#0d6efd';
        rooms[room].forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ room, text, name: ws.userName, color }));
          }
        });
      }
    } else {
      ws.send(JSON.stringify({ error: 'Invalid action or missing parameters', errorType: 'invalidAction' }));
    }
  });

  ws.on('close', () => {
    ws.rooms.forEach(room => {
      if (rooms[room]) rooms[room].delete(ws);
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Express/WebSocket chat server running on port ${PORT}`);
});
