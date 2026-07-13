const socket = io();

const COLS = 28, ROWS = 46;

const screens = {
  home: document.getElementById('screen-home'),
  lobby: document.getElementById('screen-lobby'),
  game: document.getElementById('screen-game'),
  over: document.getElementById('screen-over')
};
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

const nameInput = document.getElementById('name-input');
const codeInput = document.getElementById('code-input');
const homeError = document.getElementById('home-error');
const lobbyError = document.getElementById('lobby-error');

let myId = null;
let currentRoom = null;
let currentPlayers = [];

// ---------- تحميل كود الغرفة من رابط المشاركة ----------
const urlParams = new URLSearchParams(location.search);
if (urlParams.get('room')) {
  codeInput.value = urlParams.get('room').toUpperCase();
}

// استرجاع اسم محفوظ
nameInput.value = localStorage.getItem('tron_name') || '';

document.getElementById('btn-create').onclick = () => {
  const name = nameInput.value.trim() || 'مضيف';
  localStorage.setItem('tron_name', name);
  socket.emit('create-room', { name });
};

document.getElementById('btn-join').onclick = () => {
  const name = nameInput.value.trim() || 'لاعب';
  const code = codeInput.value.trim().toUpperCase();
  localStorage.setItem('tron_name', name);
  if (!code) { homeError.textContent = 'أدخل كود الغرفة أولاً'; return; }
  homeError.textContent = '';
  socket.emit('join-room', { code, name });
};

document.getElementById('btn-copy').onclick = () => {
  const link = `${location.origin}${location.pathname}?room=${currentRoom}`;
  navigator.clipboard.writeText(link).then(() => {
    const btn = document.getElementById('btn-copy');
    const old = btn.textContent;
    btn.textContent = 'تم النسخ ✓';
    setTimeout(() => (btn.textContent = old), 1500);
  }).catch(() => alert(link));
};

document.getElementById('btn-start').onclick = () => {
  socket.emit('start-game');
};

document.getElementById('btn-again').onclick = () => {
  socket.emit('play-again');
};

socket.on('connect', () => { myId = socket.id; });

socket.on('error-msg', (msg) => {
  homeError.textContent = msg;
  lobbyError.textContent = msg;
});

socket.on('room-created', renderLobby);
socket.on('room-update', renderLobby);

function renderLobby(state) {
  currentRoom = state.code;
  currentPlayers = state.players;
  document.getElementById('room-code-display').textContent = state.code;
  const list = document.getElementById('players-list');
  list.innerHTML = '';
  state.players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `<span class="dot" style="background:${p.color}"></span>
      <span>${p.name}${p.id === myId ? ' (أنت)' : ''}</span>
      ${p.id === state.hostId ? '<span class="crown">👑</span>' : ''}`;
    list.appendChild(row);
  });
  const startBtn = document.getElementById('btn-start');
  startBtn.style.display = state.hostId === myId ? 'block' : 'none';
  lobbyError.textContent = '';
  showScreen('lobby');
}

// ---------- شاشة اللعب ----------
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
let cellSize = 12;

function resizeCanvas() {
  const wrap = document.getElementById('board-wrap');
  const maxW = wrap.clientWidth - 8;
  const maxH = wrap.clientHeight - 8;
  cellSize = Math.max(4, Math.floor(Math.min(maxW / COLS, maxH / ROWS)));
  canvas.width = cellSize * COLS;
  canvas.height = cellSize * ROWS;
}
window.addEventListener('resize', resizeCanvas);

let playersMeta = []; // id, name, color

socket.on('game-started', (state) => {
  playersMeta = state.players;
  resizeCanvas();
  showScreen('game');
});

socket.on('tick', ({ grid, players }) => {
  drawBoard(grid, players);
  updateScoreBar(players);
});

function colorFor(id) {
  const p = playersMeta.find(pl => pl.id === id);
  return p ? p.color : '#888';
}
function idxColor(idx) {
  const colors = ['#ff3b30', '#34c759', '#0a84ff', '#ffcc00'];
  return colors[idx] ?? '#555';
}

function drawBoard(grid, players) {
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const v = grid[y][x];
      if (v !== -1) {
        ctx.fillStyle = idxColor(v);
        ctx.fillRect(x * cellSize, y * cellSize, cellSize - 1, cellSize - 1);
      }
    }
  }
  // إبراز رؤوس اللاعبين الأحياء
  players.forEach(p => {
    if (p.alive && p.head) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(p.head.x * cellSize + cellSize * 0.2, p.head.y * cellSize + cellSize * 0.2,
        cellSize * 0.6, cellSize * 0.6);
    }
  });
}

function updateScoreBar(players) {
  const bar = document.getElementById('score-bar');
  bar.innerHTML = '';
  players.forEach(p => {
    const meta = playersMeta.find(pl => pl.id === p.id);
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.style.width = p.score + '%';
    seg.style.background = meta ? meta.color : '#555';
    seg.style.opacity = p.alive ? '1' : '0.35';
    seg.textContent = p.score > 8 ? p.score + '%' : '';
    bar.appendChild(seg);
  });
}

// ---------- التحكم ----------
function sendDir(dir) { socket.emit('direction', dir); }

document.querySelectorAll('.dpad-btn').forEach(btn => {
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); sendDir(btn.dataset.dir); });
  btn.addEventListener('mousedown', () => sendDir(btn.dataset.dir));
});

window.addEventListener('keydown', (e) => {
  const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
  if (map[e.key]) { e.preventDefault(); sendDir(map[e.key]); }
});

// دعم السحب باللمس (Swipe) كخيار إضافي على اللوحة
let touchStart = null;
canvas.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  touchStart = { x: t.clientX, y: t.clientY };
});
canvas.addEventListener('touchend', (e) => {
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    sendDir(dx > 0 ? 'right' : 'left');
  } else {
    sendDir(dy > 0 ? 'down' : 'up');
  }
  touchStart = null;
});

// ---------- نهاية اللعبة ----------
socket.on('game-over', ({ winner, players }) => {
  const title = document.getElementById('over-title');
  title.textContent = winner ? `🏆 الفائز: ${winner.name}` : 'تعادل!';
  const results = document.getElementById('over-results');
  results.innerHTML = '';
  players.sort((a, b) => b.score - a.score).forEach(p => {
    const row = document.createElement('div');
    row.className = 'result-row';
    row.innerHTML = `<span class="dot" style="background:${p.color}"></span>
      <span class="name">${p.name}</span><span>${p.score}%</span>`;
    results.appendChild(row);
  });
  const againBtn = document.getElementById('btn-again');
  againBtn.style.display = (winner === null || currentPlayers.find(p => p.id === myId)) ? 'block' : 'none';
  showScreen('over');
});
