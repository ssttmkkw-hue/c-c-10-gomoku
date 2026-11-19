// 五子棋联机客户端
const $ = id => document.getElementById(id);
const store = {
  // token 存 sessionStorage：同一浏览器开两个标签页也算两个玩家，刷新本页能回原座位
  get(k) { try { return sessionStorage.getItem(k) || localStorage.getItem(k) || ''; } catch { return ''; } },
  setSession(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
  setLocal(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let ws = null, me = { seat: null, name: '', room: '', token: '' }, state = null;
let wantConnected = false, retry = 0, hover = null, pingTimer = null;

// ---------- 大厅 ----------
const params = new URLSearchParams(location.search);
$('inName').value = store.get('gomoku.name');
$('inRoom').value = params.get('room') || '';
$('btnRandom').onclick = () => { $('inRoom').value = String(Math.floor(1000 + Math.random() * 9000)); };
$('btnJoin').onclick = join;
for (const id of ['inName', 'inRoom', 'inPwd']) $(id).addEventListener('keydown', e => { if (e.key === 'Enter') join(); });

async function loadRooms() {
  try {
    const list = await (await fetch('/api/rooms')).json();
    $('roomList').innerHTML = list.length ? '<p>正在进行的房间（点击填入）</p>' + list.map(r =>
      `<div class="r" data-id="${esc(r.id)}"><span>房间 ${esc(r.id)}</span><span>${r.players}/2 人${r.spectators ? ' · 观战 ' + r.spectators : ''}</span></div>`).join('') : '';
    for (const el of $('roomList').querySelectorAll('.r')) el.onclick = () => { $('inRoom').value = el.dataset.id; $('inPwd').focus(); };
  } catch {}
}
loadRooms();
setInterval(() => { if (!$('lobby').hidden) loadRooms(); }, 5000);

function join() {
  const room = $('inRoom').value.trim(), pwd = $('inPwd').value;
  if (!room) return lobbyErr('请输入房间号');
  if (!pwd) return lobbyErr('请输入密码');
  me.name = $('inName').value.trim();
  me.room = room; me.pwd = pwd;
  store.setLocal('gomoku.name', me.name); store.setSession('gomoku.name', me.name);
  me.token = store.get('gomoku.token.' + room);
  wantConnected = true;
  connect();
}
function lobbyErr(t) { $('lobbyErr').textContent = t; }

// ---------- 网络 ----------
function connect() {
  setNet('连接中…');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    ws.send(JSON.stringify({ t: 'join', room: me.room, password: me.pwd, name: me.name, token: me.token }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'ping', ts: performance.now() })), 3000);
  };
  ws.onmessage = e => onMsg(JSON.parse(e.data));
  ws.onclose = () => {
    clearInterval(pingTimer);
    if (!wantConnected) return;
    setNet('已断开，重连中…', 'bad');
    setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
  };
}
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function setNet(t, cls = '') { $('net').textContent = t; $('net').className = 'net ' + cls; }

function onMsg(m) {
  switch (m.t) {
    case 'joined':
      me.seat = m.seat; me.token = m.token; me.name = m.name;
      store.setSession('gomoku.token.' + m.room, m.token);
      history.replaceState(null, '', '?room=' + encodeURIComponent(m.room));
      $('lobby').hidden = true; $('game').hidden = false; lobbyErr('');
      $('roomId').textContent = m.room;
      $('chatLog').innerHTML = ''; m.chat.forEach(addChat);
      setNet('已连接', 'ok');
      resize();
      break;
    case 'error':
      if (m.code) { wantConnected = false; ws.close(); lobbyErr(m.msg); $('lobby').hidden = false; $('game').hidden = true; }
      else toast(m.msg);
      break;
    case 'seat': me.seat = m.seat; break;
    case 'state': {
      const prevMoves = state ? state.moveCount : 0;
      state = m.state;
      // 观战补位时服务器会发 seat；这里再兜底一次
      render();
      if (state.moveCount > prevMoves) beep(state.lastMove && state.lastMove.c === 1 ? 520 : 600);
      break;
    }
    case 'chat': addChat(m.item); break;
    case 'pong': setNet(`已连接 · ${Math.round(performance.now() - m.ts)}ms`, 'ok'); break;
    case 'kicked': wantConnected = false; toast(m.msg); break;
  }
}

$('btnLeave').onclick = () => {
  wantConnected = false; send({ t: 'leave' }); ws && ws.close();
  state = null; me.seat = null;
  $('game').hidden = true; $('lobby').hidden = false;
  history.replaceState(null, '', location.pathname);
  loadRooms();
};
$('btnRestart').onclick = () => send({ t: 'restart' });
$('btnCopy').onclick = async () => {
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(me.room)}`;
  try { await navigator.clipboard.writeText(url); toast('已复制：' + url); } catch { prompt('复制这个链接发给朋友', url); }
};
$('chatForm').onsubmit = e => { e.preventDefault(); const t = $('chatIn').value.trim(); if (t) send({ t: 'chat', text: t }); $('chatIn').value = ''; };

// ---------- 侧栏 ----------
function render() {
  if (!state) return;
  const myColor = me.seat === 'black' ? 1 : me.seat === 'white' ? 2 : 0;
  for (const [k, c] of [['black', 1], ['white', 2]]) {
    const el = $(k === 'black' ? 'pBlack' : 'pWhite'), p = state[k];
    el.querySelector('.pname').textContent = p ? p.name : '等待加入…';
    const em = el.querySelector('em');
    em.textContent = p ? (p.online ? (state.restartVotes.includes(k) ? '想再来' : '在线') : '掉线') : '';
    em.className = p && !p.online ? 'off' : '';
    el.classList.toggle('turn', !state.winner && state.turn === c && !!state.black && !!state.white);
    el.classList.toggle('me', me.seat === k);
  }
  const st = $('status'); st.className = 'status';
  if (state.winner === 3) st.textContent = '和棋';
  else if (state.winner) {
    const w = state.winner === 1 ? '黑' : '白';
    if (myColor) { st.textContent = state.winner === myColor ? '你赢了！🎉' : '你输了'; st.classList.add(state.winner === myColor ? 'win' : 'lose'); }
    else st.textContent = `${w}方获胜`;
  } else if (!state.black || !state.white) st.textContent = '等待对手进入房间…';
  else if (!myColor) st.textContent = `观战中 · 轮到${state.turn === 1 ? '黑' : '白'}方`;
  else st.textContent = state.turn === myColor ? '轮到你下' : '对手思考中…';

  const btn = $('btnRestart');
  btn.hidden = !(myColor && state.winner);
  btn.textContent = state.restartVotes.includes(me.seat) ? '等待对方同意…' : '再来一局（交换黑白）';
  $('spect').textContent = state.spectators.length ? '观战：' + state.spectators.join('、') : '';
  draw();
}
function addChat(it) {
  const d = document.createElement('div');
  if (it.sys) { d.className = 'sys'; d.textContent = '· ' + it.text; }
  else d.innerHTML = `<b>${esc(it.name)}</b>：${esc(it.text)}`;
  $('chatLog').appendChild(d); $('chatLog').scrollTop = 1e9;
}

// ---------- 棋盘 ----------
const cv = $('board'), ctx = cv.getContext('2d');
let geo = { px: 0, cell: 0, pad: 0 };
function resize() {
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (!r.width) return;
  cv.width = r.width * dpr; cv.height = r.width * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const n = 15; geo.px = r.width; geo.cell = r.width / (n + 0.6); geo.pad = (r.width - geo.cell * (n - 1)) / 2;
  draw();
}
addEventListener('resize', resize);

function draw() {
  const { px, cell, pad } = geo, n = 15; if (!px) return;
  ctx.fillStyle = '#dcb06b'; ctx.fillRect(0, 0, px, px);
  ctx.strokeStyle = '#5a4120'; ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const p = pad + i * cell;
    ctx.beginPath(); ctx.moveTo(pad, p); ctx.lineTo(pad + cell * (n - 1), p); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p, pad); ctx.lineTo(p, pad + cell * (n - 1)); ctx.stroke();
  }
  ctx.fillStyle = '#5a4120';
  for (const [x, y] of [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]]) { ctx.beginPath(); ctx.arc(pad + x * cell, pad + y * cell, cell * 0.1, 0, 7); ctx.fill(); }
  if (!state) return;
  const b = state.board;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (b[y][x]) stone(x, y, b[y][x], 1);
  // 悬停预览
  const myColor = me.seat === 'black' ? 1 : me.seat === 'white' ? 2 : 0;
  if (hover && myColor && myColor === state.turn && !state.winner && state.black && state.white && !b[hover.y][hover.x]) stone(hover.x, hover.y, myColor, 0.4);
  if (state.lastMove) { const { x, y, c } = state.lastMove; ctx.fillStyle = c === 1 ? '#fff' : '#000'; ctx.beginPath(); ctx.arc(pad + x * cell, pad + y * cell, cell * 0.12, 0, 7); ctx.fill(); }
  if (state.winLine) {
    const pts = state.winLine.slice().sort((a, c) => a[0] - c[0] || a[1] - c[1]);
    const [a, z] = [pts[0], pts[pts.length - 1]];
    ctx.strokeStyle = '#e0453a'; ctx.lineWidth = Math.max(3, cell * 0.12); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(pad + a[0] * cell, pad + a[1] * cell); ctx.lineTo(pad + z[0] * cell, pad + z[1] * cell); ctx.stroke();
  }
}
function stone(x, y, c, alpha) {
  const { cell, pad } = geo, cx = pad + x * cell, cy = pad + y * cell, r = cell * 0.44;
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
  if (c === 1) { g.addColorStop(0, '#666'); g.addColorStop(1, '#0b0b0b'); } else { g.addColorStop(0, '#fff'); g.addColorStop(1, '#c9c4bb'); }
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
  ctx.globalAlpha = 1;
}
function cellAt(e) {
  const r = cv.getBoundingClientRect();
  const x = Math.round((e.clientX - r.left - geo.pad) / geo.cell), y = Math.round((e.clientY - r.top - geo.pad) / geo.cell);
  return x >= 0 && y >= 0 && x < 15 && y < 15 ? { x, y } : null;
}
cv.addEventListener('mousemove', e => { const h = cellAt(e); if (JSON.stringify(h) !== JSON.stringify(hover)) { hover = h; draw(); } });
cv.addEventListener('mouseleave', () => { hover = null; draw(); });
cv.addEventListener('click', e => { const c = cellAt(e); if (c && state) send({ t: 'move', x: c.x, y: c.y }); });

// ---------- 小工具 ----------
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
let toastT; function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2200); }
let actx; function beep(f) { try { actx = actx || new AudioContext(); const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; g.gain.setValueAtTime(0.08, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.08); o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.09); } catch {} }
