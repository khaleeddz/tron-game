const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- إعدادات اللعبة ----------
const COLS = 28;
const ROWS = 46;
const TICK_MS = 130; // سرعة الحركة (كل كم مللي ثانية تتحرك القطع خطوة)
const MAX_PLAYERS = 4;

const COLORS = [
  { name: 'red', hex: '#ff3b30' },
  { name: 'green', hex: '#34c759' },
  { name: 'blue', hex: '#0a84ff' },
  { name: 'yellow', hex: '#ffcc00' }
];

const START_POSITIONS = [
  { x: 3, y: 3, dir: 'right' },
  { x: COLS - 4, y: 3, dir: 'left' },
  { x: 3, y: ROWS - 4, dir: 'right' },
  { x: COLS - 4, y: ROWS - 4, dir: 'left' }
];

const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

// rooms[code] = { code, hostId, players: Map(socketId -> player), grid, state, loop, order:[] }
const rooms = {};

function genRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 7).toUpperCase();
  } while (rooms[code]);
  return code;
}

function createRoom(hostId, hostName) {
  const code = genRoomCode();
  const room = {
    code,
    hostId,
    players: new Map(),
    order: [],
    state: 'lobby', // lobby | playing | ended
    grid: null,
    loop: null
  };
  addPlayer(room, hostId, hostName);
  rooms[code] = room;
  return room;
}

function availableColors(room) {
  const used = new Set([...room.players.values()].map(p => p.colorIndex));
  const free = [];
  for (let i = 0; i < COLORS.length; i++) if (!used.has(i)) free.push(i);
  return free;
}

function addPlayer(room, id, name) {
  const free = availableColors(room);
  const colorIndex = free[Math.floor(Math.random() * free.length)];
  const player = {
    id,
    name: (name || 'لاعب').substring(0, 16),
    colorIndex,
    alive: true,
    score: 0,
    dir: null,
    nextDir: null,
    body: [] // مصفوفة الخلايا التي يشغلها اللاعب حاليا (الرأس آخر عنصر)
  };
  room.players.set(id, player);
  room.order.push(id);
  return player;
}

function publicRoomState(room) {
  return {
    code: room.code,
    state: room.state,
    hostId: room.hostId,
    players: room.order
      .filter(id => room.players.has(id))
      .map(id => {
        const p = room.players.get(id);
        return {
          id: p.id,
          name: p.name,
          color: COLORS[p.colorIndex].hex,
          alive: p.alive,
          score: p.score
        };
      })
  };
}

function startGame(room) {
  room.state = 'playing';
  room.grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(-1));

  const ids = [...room.players.keys()];
  ids.forEach((id, idx) => {
    const p = room.players.get(id);
    const pos = START_POSITIONS[idx % START_POSITIONS.length];
    p.alive = true;
    p.dir = pos.dir;
    p.nextDir = pos.dir;
    p.body = [{ x: pos.x, y: pos.y }];
    room.grid[pos.y][pos.x] = p.colorIndex;
  });

  io.to(room.code).emit('game-started', publicRoomState(room));

  room.loop = setInterval(() => tick(room), TICK_MS);
}

function tick(room) {
  const players = [...room.players.values()];
  const alivePlayers = players.filter(p => p.alive);

  if (alivePlayers.length === 0) {
    return endGame(room, null);
  }

  // تطبيق الاتجاه التالي (يمنع الرجوع 180 درجة)
  for (const p of alivePlayers) {
    if (p.nextDir && p.nextDir !== OPPOSITE[p.dir]) {
      p.dir = p.nextDir;
    }
  }

  const moves = {};
  for (const p of alivePlayers) {
    const head = p.body[p.body.length - 1];
    const d = DIRS[p.dir];
    const nx = head.x + d.x;
    const ny = head.y + d.y;
    moves[p.id] = { nx, ny };
  }

  // فحص التصادم: بالحائط أو بأي أثر ملون أو برأس لاعب آخر بنفس الخطوة
  const headTargets = {};
  for (const id in moves) {
    const { nx, ny } = moves[id];
    headTargets[`${nx},${ny}`] = (headTargets[`${nx},${ny}`] || 0) + 1;
  }

  for (const p of alivePlayers) {
    const { nx, ny } = moves[p.id];
    let dead = false;
    if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) dead = true;
    else if (room.grid[ny][nx] !== -1) dead = true;
    else if (headTargets[`${nx},${ny}`] > 1) dead = true; // اصطدام رأسي مباشر بين لاعبين

    if (dead) {
      p.alive = false;
    } else {
      p.body.push({ x: nx, y: ny });
      room.grid[ny][nx] = p.colorIndex;
    }
  }

  // حساب النقاط (النسبة المئوية من الخلايا الملونة لكل لاعب)
  const counts = new Array(COLORS.length).fill(0);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const v = room.grid[y][x];
      if (v !== -1) counts[v]++;
    }
  }
  const totalColored = counts.reduce((a, b) => a + b, 0) || 1;
  for (const p of players) {
    p.score = Math.round((counts[p.colorIndex] / totalColored) * 100);
  }

  const stillAlive = players.filter(p => p.alive);
  const totalCells = COLS * ROWS;
  const boardFull = totalColored >= totalCells;

  io.to(room.code).emit('tick', {
    grid: room.grid,
    players: players.map(p => ({
      id: p.id,
      alive: p.alive,
      score: p.score,
      head: p.body.length ? p.body[p.body.length - 1] : null
    }))
  });

  if (stillAlive.length <= 1 || boardFull) {
    let winner = null;
    if (stillAlive.length === 1) winner = stillAlive[0];
    else {
      winner = players.reduce((a, b) => (b.score > (a ? a.score : -1) ? b : a), null);
    }
    endGame(room, winner);
  }
}

function endGame(room, winner) {
  clearInterval(room.loop);
  room.loop = null;
  room.state = 'ended';
  io.to(room.code).emit('game-over', {
    winner: winner ? { id: winner.id, name: winner.name, color: COLORS[winner.colorIndex].hex, score: winner.score } : null,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: COLORS[p.colorIndex].hex, score: p.score, alive: p.alive
    }))
  });
}

function removePlayer(room, id) {
  room.players.delete(id);
  room.order = room.order.filter(x => x !== id);
  if (room.hostId === id) {
    room.hostId = room.order[0] || null;
  }
  if (room.players.size === 0) {
    if (room.loop) clearInterval(room.loop);
    delete rooms[room.code];
    return null;
  }
  return room;
}

io.on('connection', (socket) => {
  socket.on('create-room', ({ name }) => {
    const room = createRoom(socket.id, name);
    socket.join(room.code);
    socket.data.room = room.code;
    socket.emit('room-created', publicRoomState(room));
  });

  socket.on('join-room', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return socket.emit('error-msg', 'الغرفة غير موجودة');
    if (room.state !== 'lobby') return socket.emit('error-msg', 'اللعبة بدأت بالفعل');
    if (room.players.size >= MAX_PLAYERS) return socket.emit('error-msg', 'الغرفة ممتلئة (4 لاعبين كحد أقصى)');

    addPlayer(room, socket.id, name);
    socket.join(room.code);
    socket.data.room = room.code;
    io.to(room.code).emit('room-update', publicRoomState(room));
  });

  socket.on('start-game', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error-msg', 'فقط منشئ الغرفة يمكنه بدء اللعبة');
    if (room.players.size < 2) return socket.emit('error-msg', 'يلزم لاعبان على الأقل');
    startGame(room);
  });

  socket.on('direction', (dir) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || room.state !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    if (DIRS[dir]) p.nextDir = dir;
  });

  socket.on('play-again', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;
    if (room.hostId !== socket.id) return;
    room.state = 'lobby';
    io.to(room.code).emit('room-update', publicRoomState(room));
  });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;
    const wasHost = room.hostId === socket.id;
    const updated = removePlayer(room, socket.id);
    if (updated) {
      io.to(updated.code).emit('room-update', publicRoomState(updated));
      if (wasHost) io.to(updated.code).emit('error-msg', 'تم تعيين مضيف جديد للغرفة');
    }
  });
});

app.get('/health', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
