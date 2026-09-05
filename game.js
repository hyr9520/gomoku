/*
 * 房间与对战逻辑 (服务端权威)
 *
 * 连接身份: 每个玩家连接时获得 token, 客户端保存在 localStorage;
 * 刷新/断线后携带 token 重连即可回到原座位。第三者加入满员房间成为观战者。
 *
 * 广播策略: 任何状态变化后向房间内所有连接发送完整快照 (棋盘最大 19x19, 快照 < 3KB),
 * 客户端逻辑因此极简, 断线重连天然正确。
 */
'use strict';

const crypto = require('crypto');
const Rules = require('./rules.js');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去除易混淆字符
const DISCONNECT_GRACE_MS = 60 * 1000;   // 对战中断线, 60 秒内可重连
const ROOM_IDLE_MS = 10 * 60 * 1000;     // 无人连接的房间保留 10 分钟
const ROOM_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const rooms = new Map();       // code -> Room
const tokenIndex = new Map();  // token -> {room, seat}

const SIZES = [13, 15, 19];
const MODES = ['free', 'exact', 'renju'];
const FIRSTS = ['host', 'guest', 'random'];
const TIME_LIMITS = [0, 30, 60, 180];

function newToken() { return crypto.randomBytes(16).toString('hex'); }

function newCode() {
  for (let tries = 0; tries < 50; tries++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('no room code available');
}

function cleanName(name) {
  let s = String(name || '').trim().slice(0, 12);
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  return s || '玩家';
}

function normalizeRules(input) {
  const r = input || {};
  return {
    size: SIZES.includes(r.size) ? r.size : 15,
    mode: MODES.includes(r.mode) ? r.mode : 'free',
    first: FIRSTS.includes(r.first) ? r.first : 'host',
    timeLimit: TIME_LIMITS.includes(r.timeLimit) ? r.timeLimit : 0,
    undo: r.undo !== false
  };
}

function createRoom(rules) {
  const room = {
    code: newCode(),
    rules: normalizeRules(rules),
    state: 'waiting',            // waiting | playing | over
    players: { host: null, guest: null }, // {token, name, connected, conn}
    colors: { black: null, white: null }, // 'host' | 'guest'
    board: null, moves: [], turn: null,
    result: null, winLine: null,
    drawOffer: null, undoReq: null,   // 'black' | 'white'
    rematch: { black: false, white: false },
    deadline: null, deadlineTimer: null,
    disconnectTimers: { host: null, guest: null },
    spectators: new Set(),
    lastActivity: Date.now(),
    createdAt: Date.now()
  };
  rooms.set(room.code, room);
  return room;
}

function getRoom(code) { return rooms.get(String(code || '').toUpperCase()); }

function touch(room) { room.lastActivity = Date.now(); }

function seatColor(room, seat) {
  for (const c of ['black', 'white']) if (room.colors[c] === seat) return c;
  return null;
}

// ---------- 快照 ----------

function snapshotFor(room, viewer) {
  const players = {};
  for (const seat of ['host', 'guest']) {
    const p = room.players[seat];
    players[seat] = p ? { name: p.name, connected: p.connected } : null;
  }
  const you = viewer === 'spectator' ? 'spectator' : viewer;
  const youColor = you === 'spectator' ? null : seatColor(room, you);
  return {
    code: room.code,
    rules: room.rules,
    state: room.state,
    players,
    colors: room.colors,
    board: room.board ? Array.from(room.board) : null,
    moves: room.moves.map(m => ({ x: m.x, y: m.y, c: m.c })),
    turn: room.turn,
    deadline: room.deadline,
    now: Date.now(),
    result: room.result,
    winLine: room.winLine,
    drawOffer: room.drawOffer,
    undoReq: room.undoReq,
    rematch: room.rematch,
    you, youColor
  };
}

function broadcast(room) {
  for (const seat of ['host', 'guest']) {
    const p = room.players[seat];
    if (p && p.connected && p.conn) p.conn.send(JSON.stringify({ t: 'room', room: snapshotFor(room, seat) }));
  }
  for (const conn of room.spectators) {
    conn.send(JSON.stringify({ t: 'room', room: snapshotFor(room, 'spectator') }));
  }
}

function sendError(conn, msg) {
  conn.send(JSON.stringify({ t: 'error', msg }));
}

// ---------- 计时 ----------

function clearDeadline(room) {
  if (room.deadlineTimer) { clearTimeout(room.deadlineTimer); room.deadlineTimer = null; }
  room.deadline = null;
}

function setDeadline(room) {
  clearDeadline(room);
  if (!room.rules.timeLimit || room.state !== 'playing') return;
  room.deadline = Date.now() + room.rules.timeLimit * 1000;
  room.deadlineTimer = setTimeout(() => {
    if (room.state !== 'playing' || !room.deadline) return;
    const loser = room.turn;
    const winner = loser === 'black' ? 'white' : 'black';
    endGame(room, winner, 'timeout');
    broadcast(room);
  }, room.rules.timeLimit * 1000 + 500);
  room.deadlineTimer.unref();
}

// ---------- 对局流程 ----------

function startGame(room, keepColors) {
  if (!keepColors) {
    const blackSeat = room.rules.first === 'random'
      ? (crypto.randomInt(2) === 0 ? 'host' : 'guest')
      : room.rules.first;
    room.colors.black = blackSeat;
    room.colors.white = blackSeat === 'host' ? 'guest' : 'host';
  }
  room.board = Rules.newBoard(room.rules.size);
  room.moves = [];
  room.turn = 'black';
  room.result = null; room.winLine = null;
  room.drawOffer = null; room.undoReq = null;
  room.rematch = { black: false, white: false };
  room.state = 'playing';
  setDeadline(room);
  touch(room);
}

function rebuildBoard(room) {
  room.board = Rules.newBoard(room.rules.size);
  for (const m of room.moves) room.board[Rules.idx(m.x, m.y, room.rules.size)] = m.c;
}

function turnFromMoves(room) {
  if (room.moves.length === 0) return 'black';
  const last = room.moves[room.moves.length - 1];
  return last.c === Rules.BLACK ? 'white' : 'black';
}

function endGame(room, winner, reason, winLine) {
  clearDeadline(room);
  room.state = 'over';
  room.result = winner === 'draw' ? { winner: 'draw', reason } : { winner, reason };
  room.winLine = winLine || null;
  room.drawOffer = null; room.undoReq = null;
  room.rematch = { black: false, white: false };
  touch(room);
}

function applyMove(room, seat, x, y) {
  const color = seatColor(room, seat);
  const n = room.rules.size;
  if (room.state !== 'playing') return '当前不在对局中';
  if (color !== room.turn) return '还没轮到你';
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) return '坐标不合法';
  if (room.board[Rules.idx(x, y, n)] !== Rules.EMPTY) return '这个位置已有棋子';
  if (room.rules.mode === 'renju' && color === 'black') {
    const f = Rules.isForbiddenPoint(room.board, n, x, y);
    if (f) {
      const names = { overline: '长连禁手', 'double-four': '四四禁手', 'double-three': '三三禁手' };
      return '禁手点(' + (names[f] || f) + '),黑棋不可落子';
    }
  }
  const c = color === 'black' ? Rules.BLACK : Rules.WHITE;
  room.board[Rules.idx(x, y, n)] = c;
  room.moves.push({ x, y, c });
  room.drawOffer = null; room.undoReq = null;

  const win = Rules.checkWin(room.board, n, x, y, c, { mode: room.rules.mode });
  if (win.win) {
    endGame(room, color, 'five', win.line);
  } else if (room.moves.length === n * n) {
    endGame(room, 'draw', 'board-full');
  } else {
    room.turn = color === 'black' ? 'white' : 'black';
    setDeadline(room);
  }
  touch(room);
  return null;
}

function handleUndoRequest(room, seat) {
  const color = seatColor(room, seat);
  if (room.state !== 'playing') return '当前不在对局中';
  if (!room.rules.undo) return '本房间未开启悔棋';
  if (color !== room.turn) return '只有轮到你落子时才能申请悔棋';
  if (!room.moves.some(m => m.c === (color === 'black' ? Rules.BLACK : Rules.WHITE))) return '你还没有落子';
  room.undoReq = color;
  touch(room);
  return null;
}

function handleUndoResponse(room, seat, ok) {
  const color = seatColor(room, seat);
  if (!room.undoReq) return '没有悔棋申请';
  if (color === room.undoReq) return '等待对方答复';
  const requester = room.undoReq; // 'black' | 'white'
  room.undoReq = null;
  if (ok && room.state === 'playing') {
    // 回退申请者的最后一手; 若对方已应手, 连同应手一起回退
    let pops = 0;
    while (room.moves.length > 0 && pops < 2) {
      const last = room.moves.pop();
      pops++;
      if ((last.c === Rules.BLACK ? 'black' : 'white') === requester) break;
    }
    rebuildBoard(room);
    room.turn = turnFromMoves(room);
    setDeadline(room);
  }
  touch(room);
  return null;
}

function handleDrawRequest(room, seat) {
  const color = seatColor(room, seat);
  if (room.state !== 'playing') return '当前不在对局中';
  room.drawOffer = color;
  touch(room);
  return null;
}

function handleDrawResponse(room, seat, ok) {
  const color = seatColor(room, seat);
  if (!room.drawOffer) return '没有求和申请';
  if (color === room.drawOffer) return '等待对方答复';
  room.drawOffer = null;
  if (ok && room.state === 'playing') {
    endGame(room, 'draw', 'agreement');
  }
  touch(room);
  return null;
}

function handleRematch(room, seat) {
  if (room.state !== 'over') return '对局结束后才能再来一局';
  const color = seatColor(room, seat);
  if (!color) return '观战者不能申请再战';
  room.rematch[color] = true;
  if (room.rematch.black && room.rematch.white) {
    const b = room.colors.black;
    room.colors.black = room.colors.white;
    room.colors.white = b; // 交换先后手
    startGame(room, true);
  }
  touch(room);
  return null;
}

// ---------- 连接处理 ----------

function bindSeat(room, seat, conn) {
  const p = room.players[seat];
  if (p.conn && p.conn !== conn) {
    p.conn.send(JSON.stringify({ t: 'replaced' })); // 旧连接(如旧标签页)让位
    p.conn._roomCtx = null;
  }
  p.conn = conn;
  p.connected = true;
  conn._roomCtx = { room, seat };
  const dt = room.disconnectTimers[seat];
  if (dt) { clearTimeout(dt); room.disconnectTimers[seat] = null; }
}

function markDisconnected(room, seat) {
  const p = room.players[seat];
  if (!p) return;
  p.connected = false;
  p.conn = null;
  if (room.state === 'playing') {
    if (room.disconnectTimers[seat]) clearTimeout(room.disconnectTimers[seat]);
    room.disconnectTimers[seat] = setTimeout(() => {
      room.disconnectTimers[seat] = null;
      if (room.state === 'playing' && room.players[seat] && !room.players[seat].connected) {
        const winner = seatColor(room, seat) === 'black' ? 'white' : 'black';
        endGame(room, winner, 'disconnect');
        broadcast(room);
      }
    }, DISCONNECT_GRACE_MS);
    room.disconnectTimers[seat].unref();
  }
  touch(room);
}

function releaseSeat(room, seat) {
  const p = room.players[seat];
  if (!p) return;
  if (room.disconnectTimers[seat]) { clearTimeout(room.disconnectTimers[seat]); room.disconnectTimers[seat] = null; }
  tokenIndex.delete(p.token);
  room.players[seat] = null;
  if (room.state === 'playing') {
    // 对局中主动退出按认输处理
    const winner = seatColor(room, seat) === 'black' ? 'white' : 'black';
    endGame(room, winner, 'resign');
  } else if (room.state === 'waiting' && seat === 'host') {
    closeRoom(room, '房主已解散房间');
    return;
  }
  touch(room);
}

function closeRoom(room, reason) {
  clearDeadline(room);
  for (const seat of ['host', 'guest']) {
    const p = room.players[seat];
    if (p) {
      tokenIndex.delete(p.token);
      if (p.conn) {
        p.conn._roomCtx = null;
        try { p.conn.send(JSON.stringify({ t: 'room_closed', msg: reason || '房间已关闭' })); } catch (e) { }
      }
    }
    if (room.disconnectTimers[seat]) clearTimeout(room.disconnectTimers[seat]);
  }
  for (const conn of room.spectators) {
    conn._roomCtx = null;
    try { conn.send(JSON.stringify({ t: 'room_closed', msg: reason || '房间已关闭' })); } catch (e) { }
  }
  room.spectators.clear();
  rooms.delete(room.code);
}

function handleConnection(conn) {
  conn.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { route(conn, msg); } catch (e) { sendError(conn, '服务器内部错误'); }
  });
  conn.on('close', () => {
    const ctx = conn._roomCtx;
    if (!ctx) return;
    if (ctx.spectator) {
      ctx.room.spectators.delete(conn);
      return;
    }
    const { room, seat } = ctx;
    const p = room.players[seat];
    if (p && p.conn === conn) markDisconnected(room, seat);
    if (rooms.has(room.code)) broadcast(room);
  });
}

function route(conn, msg) {
  const ctx = conn._roomCtx;
  const t = msg.t;

  if (t === 'ping') { conn.send('{"t":"pong"}'); return; }

  // --- 需要房间的动作 ---
  if (['move', 'undo_req', 'undo_res', 'draw_req', 'draw_res', 'resign', 'rematch', 'start', 'leave'].indexOf(t) !== -1) {
    if (!ctx || ctx.spectator) { sendError(conn, '观战者不能进行该操作'); return; }
    const { room, seat } = ctx;
    const p = room.players[seat];
    if (!p || p.conn !== conn) { sendError(conn, '连接已失效, 请刷新页面'); return; }
    touch(room);
    let err = null;
    switch (t) {
      case 'start':
        if (seat !== 'host') err = '只有房主可以开始对局';
        else if (room.state !== 'waiting') err = '对局已经开始';
        else if (!room.players.guest) err = '等待对手加入后才能开始';
        else startGame(room);
        break;
      case 'move': err = applyMove(room, seat, msg.x, msg.y); break;
      case 'undo_req': err = handleUndoRequest(room, seat); break;
      case 'undo_res': err = handleUndoResponse(room, seat, !!msg.ok); break;
      case 'draw_req': err = handleDrawRequest(room, seat); break;
      case 'draw_res': err = handleDrawResponse(room, seat, !!msg.ok); break;
      case 'resign':
        if (room.state !== 'playing') err = '当前不在对局中';
        else {
          const winner = seatColor(room, seat) === 'black' ? 'white' : 'black';
          endGame(room, winner, 'resign');
        }
        break;
      case 'rematch': err = handleRematch(room, seat); break;
      case 'leave':
        releaseSeat(room, seat);
        conn._roomCtx = null;
        if (!rooms.has(room.code)) {
          conn.send(JSON.stringify({ t: 'room_closed', msg: '已离开房间' }));
          return;
        }
        break;
    }
    if (err) sendError(conn, err);
    else if (rooms.has(room.code)) broadcast(room);
    return;
  }

  // --- 建房 / 加入 / 恢复 ---
  if (t === 'create') {
    if (ctx) { sendError(conn, '请先离开当前房间'); return; }
    const room = createRoom(msg.rules);
    const token = newToken();
    room.players.host = { token, name: cleanName(msg.name), connected: true, conn };
    tokenIndex.set(token, { room, seat: 'host' });
    conn._roomCtx = { room, seat: 'host' };
    conn.send(JSON.stringify({ t: 'created', token, code: room.code, room: snapshotFor(room, 'host') }));
    return;
  }

  if (t === 'join') {
    if (ctx) { sendError(conn, '请先离开当前房间'); return; }
    const room = getRoom(msg.code);
    if (!room) { sendError(conn, '房间不存在, 请核对邀请码'); return; }
    touch(room);
    if (!room.players.host) { closeRoom(room, '房间已解散'); sendError(conn, '房间已解散'); return; }

    // 已有身份 (断线重连)
    if (msg.token) {
      const idx = tokenIndex.get(String(msg.token));
      if (idx && idx.room === room) {
        bindSeat(room, idx.seat, conn);
        conn.send(JSON.stringify({ t: 'joined', token: msg.token, room: snapshotFor(room, idx.seat) }));
        broadcast(room);
        return;
      }
    }

    if (!room.players.guest) {
      const token = newToken();
      room.players.guest = { token, name: cleanName(msg.name), connected: true, conn };
      tokenIndex.set(token, { room, seat: 'guest' });
      conn._roomCtx = { room, seat: 'guest' };
      conn.send(JSON.stringify({ t: 'joined', token, room: snapshotFor(room, 'guest') }));
      broadcast(room);
    } else {
      // 满员 → 观战
      room.spectators.add(conn);
      conn._roomCtx = { room, spectator: true };
      conn.send(JSON.stringify({ t: 'joined', token: null, room: snapshotFor(room, 'spectator') }));
    }
    return;
  }

  if (t === 'resume') {
    if (ctx) return;
    const idx = tokenIndex.get(String(msg.token || ''));
    if (!idx || !rooms.has(idx.room.code)) {
      sendError(conn, '会话已过期');
      return;
    }
    const { room, seat } = idx;
    touch(room);
    bindSeat(room, seat, conn);
    conn.send(JSON.stringify({ t: 'joined', token: msg.token, room: snapshotFor(room, seat) }));
    broadcast(room);
    return;
  }

  sendError(conn, '未知指令');
}

// ---------- 清理 ----------

function gc() {
  const now = Date.now();
  for (const room of Array.from(rooms.values())) {
    const hasConn = ['host', 'guest'].some(s => room.players[s] && room.players[s].connected) || room.spectators.size > 0;
    if (now - room.createdAt > ROOM_MAX_AGE_MS) { closeRoom(room, '房间时间过长已关闭'); continue; }
    if (!hasConn && now - room.lastActivity > ROOM_IDLE_MS) closeRoom(room, '房间已闲置关闭');
  }
}

function roomCount() { return rooms.size; }

module.exports = { handleConnection, gc, roomCount, getRoom };
