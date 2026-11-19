// 无头联机测试：起服务器 → 两个玩家 + 观众走完整流程
const { spawn } = require('child_process');
const WebSocket = require('ws');
const PORT = 5299;
const srv = spawn(process.execPath, [__dirname + '/../server.js', String(PORT)], { stdio: 'pipe' });
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, msg) => { console.log((c ? '✔ ' : '✘ ') + msg); if (!c) fails++; };

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const c = { ws, name, msgs: [], state: null, seat: null, token: null };
  ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.t === 'state') c.state = m.state; if (m.t === 'joined') { c.seat = m.seat; c.token = m.token; } if (m.t === 'seat') c.seat = m.seat; });
  c.send = m => ws.send(JSON.stringify(m));
  c.lastErr = () => [...c.msgs].reverse().find(m => m.t === 'error');
  c.open = new Promise(r => ws.on('open', r));
  return c;
}
(async () => {
  await wait(500);
  const bad = client('bad'); await bad.open; bad.send({ t: 'join', room: 'T1', password: '999', name: 'bad' }); await wait(100);
  ok(bad.lastErr()?.code === 'password', '错误密码被拒');
  const A = client('A'), B = client('B'); await A.open; await B.open;
  A.send({ t: 'join', room: 'T1', password: '123', name: 'A' }); await wait(80);
  B.send({ t: 'join', room: 'T1', password: '123', name: 'B' }); await wait(120);
  ok(A.seat === 'black' && B.seat === 'white', 'A 执黑, B 执白');
  B.send({ t: 'move', x: 0, y: 0 }); await wait(80);
  ok(B.lastErr()?.msg === '还没轮到你', '白方抢先被拒');
  // A 在第 7 行连五，B 在第 8 行陪下
  for (let i = 0; i < 5; i++) {
    A.send({ t: 'move', x: 3 + i, y: 7 }); await wait(40);
    if (i < 4) { B.send({ t: 'move', x: 3 + i, y: 8 }); await wait(40); }
  }
  await wait(100);
  ok(B.state.winner === 1 && B.state.winLine.length === 5, '黑方五连获胜，双方状态同步');
  B.send({ t: 'move', x: 0, y: 0 }); await wait(60);
  ok(B.lastErr()?.msg === '本局已结束', '结束后不能再下');
  const S = client('S'); await S.open; S.send({ t: 'join', room: 'T1', password: '123', name: 'S' }); await wait(100);
  ok(S.seat === null && S.state.board[7][5] === 1, '第三人进入为观战并看到棋盘');
  A.send({ t: 'restart' }); await wait(60); B.send({ t: 'restart' }); await wait(120);
  ok(A.seat === 'white' && B.seat === 'black' && A.state.moveCount === 0, '再来一局后交换黑白、棋盘清空');
  // 断线重连
  const tokenB = B.token; B.ws.close(); await wait(150);
  ok(A.state.black && A.state.black.online === false, 'B 掉线后对手看到"掉线"');
  const B2 = client('B'); await B2.open; B2.send({ t: 'join', room: 'T1', password: '123', name: 'B', token: tokenB }); await wait(120);
  ok(B2.seat === 'black' && A.state.black.online, 'B 用 token 重连回到黑方座位');
  B2.send({ t: 'move', x: 7, y: 7 }); await wait(80);
  ok(A.state.board[7][7] === 1, '重连后可以继续落子');
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
  srv.kill(); process.exit(fails ? 1 : 0);
})();
