const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// In-memory state. Everything lives in this one object for the lifetime of
// the process; the /api/admin/reset endpoint clears it for a new round.
// ---------------------------------------------------------------------------
const state = {
  isOpen: false, // is registration currently open for /join?
  numbers: [], // [{ id, number, maxLimit, currentCount }]
  participants: new Map(), // participantId -> { numberId, number, assignedAt }
};

function publicState() {
  return {
    isOpen: state.isOpen,
    numbers: state.numbers.map((n) => ({
      id: n.id,
      number: n.number,
      maxLimit: n.maxLimit,
      currentCount: n.currentCount,
    })),
    totalAssigned: state.participants.size,
    totalCapacity: state.numbers.reduce((sum, n) => sum + n.maxLimit, 0),
  };
}

function broadcastState() {
  io.emit('state:update', publicState());
}

// ---------------------------------------------------------------------------
// Public state (used by /display and /join to render live info)
// ---------------------------------------------------------------------------
app.get('/api/state', (req, res) => {
  res.json(publicState());
});

// QR code pointing at this server's /join page, rendered as a PNG so the
// display page works without any external/CDN dependency.
app.get('/api/qr.png', async (req, res) => {
  const joinUrl = `${req.protocol}://${req.get('host')}/join`;
  try {
    const buffer = await QRCode.toBuffer(joinUrl, {
      width: 480,
      margin: 2,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    res.type('png').send(buffer);
  } catch (err) {
    res.status(500).send('Не удалось сгенерировать QR-код');
  }
});

// ---------------------------------------------------------------------------
// Join flow
// ---------------------------------------------------------------------------
app.post('/api/join', (req, res) => {
  const { participantId } = req.body || {};
  if (!participantId || typeof participantId !== 'string') {
    return res.status(400).json({ error: 'participantId обязателен' });
  }

  // Idempotent: a participant who already has a number (e.g. after reload)
  // always gets the same number back instead of rolling again.
  const existing = state.participants.get(participantId);
  if (existing) {
    return res.json({ number: existing.number, alreadyAssigned: true });
  }

  if (!state.isOpen) {
    return res.status(403).json({ error: 'Регистрация ещё не открыта' });
  }

  // Everything below is synchronous (no await), so it runs to completion in
  // a single turn of the event loop. Node never interleaves two request
  // handlers mid-execution, so this read-then-write is race-free even under
  // many simultaneous requests.
  const available = state.numbers.filter((n) => n.currentCount < n.maxLimit);
  if (available.length === 0) {
    return res.status(409).json({ error: 'Все места заняты' });
  }

  // Weighted by remaining free slots, not uniform per number label — a
  // number with 10 free slots is 5x more likely to be picked than one with
  // 2, matching how a raffle with differently-sized buckets fills up.
  const totalRemaining = available.reduce((sum, n) => sum + (n.maxLimit - n.currentCount), 0);
  let roll = Math.floor(Math.random() * totalRemaining);
  let chosen = available[available.length - 1];
  for (const n of available) {
    const remaining = n.maxLimit - n.currentCount;
    if (roll < remaining) {
      chosen = n;
      break;
    }
    roll -= remaining;
  }
  chosen.currentCount += 1;
  const record = { numberId: chosen.id, number: chosen.number, assignedAt: Date.now() };
  state.participants.set(participantId, record);

  broadcastState();
  res.json({ number: chosen.number, alreadyAssigned: false });
});

// ---------------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------------
app.get('/api/admin/state', (req, res) => {
  res.json(publicState());
});

app.post('/api/admin/numbers', (req, res) => {
  const { numbers } = req.body || {};
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: 'Нужен непустой список номеров' });
  }

  for (const n of numbers) {
    const limit = Number(n.maxLimit);
    if (n.number === undefined || n.number === null || String(n.number).trim() === '') {
      return res.status(400).json({ error: 'У каждого номера должно быть значение' });
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      return res.status(400).json({ error: 'Лимит должен быть положительным числом' });
    }
  }

  state.numbers = numbers.map((n) => ({
    id: crypto.randomUUID(),
    number: String(n.number).trim(),
    maxLimit: Math.floor(Number(n.maxLimit)),
    currentCount: 0,
  }));
  state.participants = new Map();
  state.isOpen = false;

  broadcastState();
  res.json(publicState());
});

app.post('/api/admin/start', (req, res) => {
  if (state.numbers.length === 0) {
    return res.status(400).json({ error: 'Сначала настройте номера' });
  }
  state.isOpen = true;
  broadcastState();
  res.json(publicState());
});

app.post('/api/admin/stop', (req, res) => {
  state.isOpen = false;
  broadcastState();
  res.json(publicState());
});

app.post('/api/admin/reset', (req, res) => {
  state.participants = new Map();
  state.numbers.forEach((n) => {
    n.currentCount = 0;
  });
  state.isOpen = false;
  broadcastState();
  res.json(publicState());
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
app.get('/', (req, res) => res.redirect('/display'));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.get('/join', (req, res) => res.sendFile(path.join(__dirname, 'public', 'join.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

io.on('connection', (socket) => {
  socket.emit('state:update', publicState());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
  console.log(`  Экран для проектора: http://localhost:${PORT}/display`);
  console.log(`  Админка:             http://localhost:${PORT}/admin`);
});
