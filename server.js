const express = require('express');
const WebSocket = require('ws');
const randomColor = require('randomcolor');
const path = require('path');
const config = require('./config');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files (client.html, style.css)
app.use(express.static(path.join(__dirname)));

// Room structure: { roomName: Set of clients }
const rooms = {};
// User color map: { name: color }
const userColors = {};

// Track last activity for clients and rooms
const clientActivity = new Map(); // ws -> timestamp
const roomActivity = {}; // roomName -> timestamp
const roomCountdowns = {}; // roomName -> countdown timer refs
const clientCountdowns = new Map(); // ws -> countdown timer refs

function updateClientActivity(ws) {
  clientActivity.set(ws, Date.now());
}
function updateRoomActivity(room) {
  roomActivity[room] = Date.now();
}

function sendRoomWarning(room, seconds) {
  if (rooms[room]) {
    rooms[room].forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ info: `Room '${room}' will close in ${seconds} seconds due to inactivity.` }));
      }
    });
  }
}

function closeRoom(room) {
  if (rooms[room]) {
    rooms[room].forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ info: `Room '${room}' is now closed due to inactivity.` }));
        client.rooms.delete(room);
      }
    });
    delete rooms[room];
    delete roomActivity[room];
    if (roomCountdowns[room]) {
      roomCountdowns[room].forEach(ref => clearTimeout(ref));
      delete roomCountdowns[room];
    }
  }
}

function scheduleRoomCountdown(room) {
  if (roomCountdowns[room]) return; // Already scheduled
  roomCountdowns[room] = [];
  // 60s, 30s, 10s, 5s warnings
  [60, 30, 10, 5].forEach(seconds => {
    const ref = setTimeout(() => {
      if (rooms[room]) sendRoomWarning(room, seconds);
    }, (300 + 60 - seconds) * 1000); // 5min - seconds
    roomCountdowns[room].push(ref);
  });
  // Final close after 5min
  const closeRef = setTimeout(() => {
    closeRoom(room);
  }, 360 * 1000); // 6min (5min + 60s warning)
  roomCountdowns[room].push(closeRef);
}

function sendClientWarning(ws, seconds) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ info: `You will be disconnected in ${seconds} seconds due to inactivity.` }));
  }
}

function scheduleClientCountdown(ws) {
  if (clientCountdowns.has(ws)) return; // Already scheduled
  const refs = [];
  [60, 30, 10, 5].forEach(seconds => {
    const ref = setTimeout(() => {
      sendClientWarning(ws, seconds);
    }, (config.CLIENT_INACTIVITY_MS + 60 * 1000 - seconds * 1000));
    refs.push(ref);
  });
  // Final disconnect after 1min + 60s warning
  const disconnectRef = setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ info: 'You have been disconnected due to inactivity.' }));
      ws.close();
    }
    clientCountdowns.delete(ws);
    clientActivity.delete(ws);
  }, config.CLIENT_INACTIVITY_MS + 60 * 1000);
  refs.push(disconnectRef);
  clientCountdowns.set(ws, refs);
}

function cancelClientCountdown(ws) {
  if (clientCountdowns.has(ws)) {
    clientCountdowns.get(ws).forEach(ref => clearTimeout(ref));
    clientCountdowns.delete(ws);
  }
}

setInterval(() => {
  // Check client inactivity
  for (const [ws, last] of clientActivity.entries()) {
    if (Date.now() - last > config.CLIENT_INACTIVITY_MS) {
      scheduleClientCountdown(ws);
    } else {
      cancelClientCountdown(ws);
    }
  }
  // Check room inactivity
  for (const room in rooms) {
    if (rooms[room].size === 0) continue;
    const last = roomActivity[room] || Date.now();
    if (Date.now() - last > config.ROOM_INACTIVITY_MS) {
      scheduleRoomCountdown(room);
    } else if (roomCountdowns[room]) {
      // If activity resumes, cancel countdowns
      roomCountdowns[room].forEach(ref => clearTimeout(ref));
      delete roomCountdowns[room];
    }
  }
}, 10 * 1000); // Check every 10s

wss.on('connection', (ws) => {
  ws.rooms = new Set();
  ws.userName = null;
  updateClientActivity(ws);

  ws.on('message', (message) => {
    updateClientActivity(ws);
    cancelClientCountdown(ws);
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
      updateRoomActivity(room);
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
      updateRoomActivity(room);
    } else if (action === 'message' && room && text) {
      if (rooms[room]) {
        const color = userColors[ws.userName] || '#0d6efd';
        const time = new Date().toISOString();
        rooms[room].forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ room, text, name: ws.userName, color, time }));
          }
        });
      }
      updateRoomActivity(room);
    } else {
      ws.send(JSON.stringify({ error: 'Invalid action or missing parameters', errorType: 'invalidAction' }));
    }
  });

  ws.on('close', () => {
    clientActivity.delete(ws);
    cancelClientCountdown(ws);
    ws.rooms.forEach(room => {
      if (rooms[room]) rooms[room].delete(ws);
      updateRoomActivity(room);
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Express/WebSocket chat server running on port ${PORT}`);
});
