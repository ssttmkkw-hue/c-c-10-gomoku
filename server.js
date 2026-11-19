// 五子棋联机服务器：静态页面 + WebSocket 房间 + 服务器裁判
// 运行：node server.js [端口]   环境变量 PORT / ROOM_PASSWORD 可覆盖
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || process.argv[2] || 5218);
const PASSWORD = process.env.ROOM_PASSWORD || '123';
const SIZE = 15;
const SEAT_HOLD_MS = 2 * 60 * 1000;   // 掉线后座位保留 2 分钟
const ROOM_IDLE_MS = 10 * 60 * 1000;  // 空房间 10 分钟后回收

// ---------- 静态文件 ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.end('ok'); return; }
  if (url.pathname === '/api/rooms') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([...rooms.values()].map(r => ({ id: r.id, players: seatCount(r), spectators: r.spectators.size, moves: r.moves.length }))));
    return;
  }
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!p) p = 'index.html';
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- 房间 ----------
/** room: { id, seats:{black,white}, spectators:Set<client>, board, turn, winner, winLine, moves, restartVotes:Set, round, chat, emptySince } */
const rooms = new Map();
const newBoard = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(0)); // 0 空 1 黑 2 白

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    r = { id, seats: { black: null, white: null }, spectators: new Set(), board: newBoard(), turn: 1, winner: 0, winLine: null, moves: [], restartVotes: new Set(), round: 1, chat: [], emptySince: 0 };
    rooms.set(id, r);
  }
  return r;
}
const seatCount = r => (r.seats.black ? 1 : 0) + (r.seats.white ? 1 : 0);
const colorOf = seat => (seat === 'black' ? 1 : 2);

function publicState(r) {
  const seat = s => s && { name: s.name, online: !!s.ws };
  return {
    room: r.id, size: SIZE, board: r.board, turn: r.turn, winner: r.winner, winLine: r.winLine,
    lastMove: r.moves[r.moves.length - 1] || null, moveCount: r.moves.length, round: r.round,
    black: seat(r.seats.black), white: seat(r.seats.white),
    spectators: [...r.spectators].map(c => c.name),
    restartVotes: [...r.restartVotes],
  };
}
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(r, msg) {
  for (const k of ['black', 'white']) if (r.seats[k]) send(r.seats[k].ws, msg);
  for (const c of r.spectators) send(c.ws, msg);
}
function sync(r) { broadcast(r, { t: 'state', state: publicState(r) }); }
function system(r, text) { pushChat(r, { sys: true, text }); }
function pushChat(r, item) {
  item.ts = Date.now();
  r.chat.push(item); if (r.chat.length > 50) r.chat.shift();
  broadcast(r, { t: 'chat', item });
}

function checkWin(b, x, y, c) {
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const line = [[x, y]];
    for (const s of [1, -1]) {
      let i = x + dx * s, j = y + dy * s;
      while (i >= 0 && j >= 0 && i < SIZE && j < SIZE && b[j][i] === c) { line.push([i, j]); i += dx * s; j += dy * s; }
    }
    if (line.length >= 5) return line;
  }
  return null;
}

function resetGame(r, swap) {
  if (swap) { const t = r.seats.black; r.seats.black = r.seats.white; r.seats.white = t; }
  r.board = newBoard(); r.turn = 1; r.winner = 0; r.winLine = null; r.moves = []; r.restartVotes.clear(); r.round++;
}

// ---------- 连接 ----------
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  const client = { ws, room: null, seat: null, name: '', token: '' };

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'ping') return send(ws, { t: 'pong', ts: m.ts });

    if (m.t === 'join') {
      if (client.room) return;
      const id = String(m.room || '').trim().slice(0, 16);
      if (!id) return send(ws, { t: 'error', code: 'room', msg: '请输入房间号' });
      if (String(m.password || '') !== PASSWORD) return send(ws, { t: 'error', code: 'password', msg: '密码错误' });
      const r = getRoom(id);
      client.name = String(m.name || '').trim().slice(0, 12) || '玩家' + Math.floor(Math.random() * 900 + 100);
      client.token = /^[a-f0-9]{32}$/.test(m.token) ? m.token : crypto.randomBytes(16).toString('hex');
      client.room = r;
      r.emptySince = 0;

      // 断线重连：token 对得上就回原座位
      let seat = ['black', 'white'].find(k => r.seats[k] && r.seats[k].token === client.token);
      if (seat) {
        const old = r.seats[seat];
        if (old.ws && old.ws !== ws) { send(old.ws, { t: 'kicked', msg: '你在别处重新进入了这个房间' }); old.ws.close(); }
        clearTimeout(old.holdTimer);
        old.ws = ws; old.name = client.name;
        system(r, `${client.name} 重新连上了`);
      } else {
        seat = ['black', 'white'].find(k => !r.seats[k]);
        if (seat) {
          r.seats[seat] = { token: client.token, name: client.name, ws, holdTimer: null };
          system(r, `${client.name} 入座执${seat === 'black' ? '黑' : '白'}`);
        } else {
          r.spectators.add(client);
          system(r, `${client.name} 进来观战`);
        }
      }
      client.seat = seat || null;
      send(ws, { t: 'joined', room: r.id, seat: client.seat, token: client.token, name: client.name, chat: r.chat });
      sync(r);
      return;
    }

    const r = client.room; if (!r) return;
    // 座位可能因换色而变化：每次按 token 重新确认
    const mySeat = ['black', 'white'].find(k => r.seats[k] && r.seats[k].token === client.token && r.seats[k].ws === ws) || null;

    if (m.t === 'move') {
      const x = m.x | 0, y = m.y | 0;
      if (!mySeat) return send(ws, { t: 'error', msg: '观战中不能落子' });
      if (r.winner) return send(ws, { t: 'error', msg: '本局已结束' });
      if (!r.seats.black || !r.seats.white) return send(ws, { t: 'error', msg: '等对手进房间' });
      if (colorOf(mySeat) !== r.turn) return send(ws, { t: 'error', msg: '还没轮到你' });
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || r.board[y][x]) return send(ws, { t: 'error', msg: '这里不能下' });
      r.board[y][x] = r.turn;
      r.moves.push({ x, y, c: r.turn });
      const line = checkWin(r.board, x, y, r.turn);
      if (line) { r.winner = r.turn; r.winLine = line; system(r, `${r.seats[mySeat].name}（${r.turn === 1 ? '黑' : '白'}）五连获胜！`); }
      else if (r.moves.length === SIZE * SIZE) { r.winner = 3; system(r, '棋盘下满，和棋'); }
      else r.turn = 3 - r.turn;
      sync(r);
    } else if (m.t === 'restart') {
      if (!mySeat) return;
      r.restartVotes.add(mySeat);
      const others = ['black', 'white'].filter(k => r.seats[k]);
      if (others.every(k => r.restartVotes.has(k))) {
        resetGame(r, others.length === 2);
        system(r, `第 ${r.round} 局开始，双方交换黑白`);
        // 通知双方新座位
        for (const k of ['black', 'white']) if (r.seats[k]) send(r.seats[k].ws, { t: 'seat', seat: k });
      } else system(r, `${r.seats[mySeat].name} 想再来一局`);
      sync(r);
    } else if (m.t === 'chat') {
      const text = String(m.text || '').trim().slice(0, 120);
      if (text) pushChat(r, { name: client.name, seat: mySeat, text });
    } else if (m.t === 'leave') {
      leave(client, true);
    }
  });

  ws.on('close', () => leave(client, false));
});

function leave(client, explicit) {
  const r = client.room; if (!r) return;
  client.room = null;
  if (r.spectators.delete(client)) { system(r, `${client.name} 离开了`); }
  for (const k of ['black', 'white']) {
    const s = r.seats[k];
    if (!s || s.token !== client.token || s.ws !== client.ws) continue;
    if (explicit) {
      r.seats[k] = null; r.restartVotes.delete(k);
      system(r, `${s.name} 离开了座位`);
      promoteSpectator(r, k);
    } else {
      s.ws = null;
      system(r, `${s.name} 掉线了，座位保留 2 分钟`);
      s.holdTimer = setTimeout(() => {
        if (r.seats[k] === s && !s.ws) { r.seats[k] = null; r.restartVotes.delete(k); system(r, `${s.name} 的座位已释放`); promoteSpectator(r, k); sync(r); checkEmpty(r); }
      }, SEAT_HOLD_MS);
    }
  }
  sync(r);
  checkEmpty(r);
}

// 有空座时让最早的观众补位（只在棋局未开始或已结束时）
function promoteSpectator(r, k) {
  if (r.moves.length && !r.winner) return;
  const c = r.spectators.values().next().value;
  if (!c) return;
  r.spectators.delete(c);
  r.seats[k] = { token: c.token, name: c.name, ws: c.ws, holdTimer: null };
  c.seat = k;
  send(c.ws, { t: 'seat', seat: k });
  system(r, `${c.name} 补位执${k === 'black' ? '黑' : '白'}`);
}

function checkEmpty(r) {
  const anyone = r.spectators.size || ['black', 'white'].some(k => r.seats[k] && r.seats[k].ws);
  if (!anyone && !r.emptySince) r.emptySince = Date.now();
}

// 心跳 + 回收空房间
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._dead) { ws.terminate(); continue; }
    ws._dead = true; ws.ping();
  }
  const now = Date.now();
  for (const [id, r] of rooms) if (r.emptySince && now - r.emptySince > ROOM_IDLE_MS) rooms.delete(id);
}, 15000);
wss.on('connection', ws => ws.on('pong', () => { ws._dead = false; }));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`五子棋联机服务器已启动  密码=${PASSWORD}`);
  console.log(`  本机:   http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  局域网: http://${a.address}:${PORT}`);
});
