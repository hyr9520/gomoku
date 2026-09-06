/*
 * 前端主逻辑 v3
 *
 * 模式:
 *   online  — 联机对战 (服务端权威, 全量快照驱动, 即时预览子)
 *   local   — 单机模式, S.local.kind 区分:
 *     ai      — 人机对战 (三档棋力)
 *     hotseat — 双人同屏 (轮流落子)
 *     puzzle  — 残局挑战 (致胜一子/化解杀着, 关卡制)
 */
(function () {
  'use strict';

  const GR = window.GomokuRules;
  const AIE = window.GomokuAI;
  const PZ = window.GomokuPuzzle;
  const $ = (id) => document.getElementById(id);

  // ---------- 状态 ----------
  const S = {
    mode: 'online',        // 'online' | 'local'
    local: null,           // {kind, rules, board, moves, playerColor, aiColor, over, result, winLine, turn, gen, puzzle, challenge}
    ws: null,
    wsOk: false,
    retry: 0,
    retryTimer: null,
    room: null,
    token: sessionStorage.getItem('gomoku.token') || null,
    pendingJoin: null,
    serverOffset: 0,
    overAnnounced: false,
    resultTimer: null,
    resultShown: false,
    lanLink: null,
    inviteBase: null,
    pending: new Map()     // 联机: 已点未确认的落子 idx -> 1|2
  };
  const outbox = [];

  const board = new GomokuBoard($('board'), $('fx'));
  function strHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h) + 1; }

  // ---------- 工具 ----------
  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2200);
  }

  function vibrate(ms) { if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) { } } }

  function showModal(title, body, buttons) {
    $('m-title').textContent = title;
    $('m-body').textContent = body;
    const box = $('m-btns');
    box.innerHTML = '';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.className = 'btn ' + (b.cls || '');
      btn.textContent = b.label;
      btn.onclick = () => { hideModal(); if (b.cb) b.cb(); };
      box.appendChild(btn);
    }
    $('modal').classList.add('show');
  }
  function hideModal() { $('modal').classList.remove('show'); }

  function showScreen(name) {
    for (const s of ['home', 'room']) $('screen-' + s).classList.toggle('active', s === name);
  }

  function isLocal() { return S.mode === 'local'; }
  function kind() { return isLocal() && S.local ? S.local.kind : null; }

  function send(obj) {
    if (S.mode !== 'online') return false;
    if (S.ws && S.wsOk) { S.ws.send(JSON.stringify(obj)); return true; }
    outbox.push(obj);
    return false;
  }

  function flushOutbox() { while (outbox.length) S.ws.send(JSON.stringify(outbox.shift())); }

  function banner(on) { $('conn-banner').classList.toggle('show', on); }

  function exitToHome() {
    if (S.aiTimer) { clearTimeout(S.aiTimer); S.aiTimer = null; }
    S.mode = 'online';
    S.local = null;
    S.room = null;
    S.pending.clear();
    board.clear();
    hideModal();
    showScreen('home');
  }

  function leaveOnline() {
    S.mode = 'online';
    S.room = null;
    S.token = null;
    sessionStorage.removeItem('gomoku.token');
    S.pending.clear();
    board.clear();
    hideModal();
    showScreen('home');
    banner(false);
  }

  // ---------- 规则选项 ----------
  function readRules() {
    const rules = {};
    for (const seg of document.querySelectorAll('.seg:not(.seg-ai)')) {
      const on = seg.querySelector('button.on');
      if (!on) continue;
      const k = seg.dataset.key, v = on.dataset.v;
      if (k === 'size') rules.size = Number(v);
      else if (k === 'timeLimit') rules.timeLimit = Number(v);
      else if (k === 'undo') rules.undo = v === '1';
      else rules[k] = v;
    }
    return rules;
  }

  function readAiLevel() {
    const on = document.querySelector('.seg-ai button.on');
    return (on && on.dataset.v) || 'normal';
  }

  function ruleSummary(rules) {
    const modeName = { free: '自由规则 · 长连也算胜', exact: '精确五连 · 黑长连不算胜', renju: '连珠规则 · 黑棋禁手' }[rules.mode];
    const firstName = { host: '房主执黑先行', guest: '对方执黑先行', random: '随机先手' }[rules.first];
    const timeName = rules.timeLimit ? '每步 ' + (rules.timeLimit >= 60 ? (rules.timeLimit / 60) + ' 分钟' : rules.timeLimit + ' 秒') : '不限时';
    return [
      ['棋盘', rules.size + ' × ' + rules.size],
      ['获胜', modeName],
      ['先手', firstName],
      ['限时', timeName],
      ['悔棋', rules.undo ? '允许 (需对方同意)' : '不允许']
    ];
  }

  // ---------- WebSocket ----------
  function connect() {
    clearTimeout(S.retryTimer);
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    let ws;
    try { ws = new WebSocket(proto + location.host); } catch (e) { scheduleReconnect(); return; }
    S.ws = ws;

    ws.onopen = () => {
      S.wsOk = true; S.retry = 0;
      banner(false);
      onReady();
      flushOutbox();
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
      handleMsg(msg);
    };
    ws.onclose = () => {
      S.wsOk = false;
      if (S.mode === 'online') banner(true);
      scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch (e) { } };
  }

  function scheduleReconnect() {
    clearTimeout(S.retryTimer);
    const delay = Math.min(500 * Math.pow(2, S.retry++), 6000);
    S.retryTimer = setTimeout(connect, delay);
  }

  function onReady() {
    if (S.pendingJoin) {
      send({ t: 'join', code: S.pendingJoin, name: myName(), token: S.token });
    } else if (S.token) {
      send({ t: 'resume', token: S.token });
    }
  }

  function handleMsg(msg) {
    if (S.mode !== 'online') return;
    switch (msg.t) {
      case 'created':
      case 'joined':
        if (msg.token) {
          S.token = msg.token;
          sessionStorage.setItem('gomoku.token', msg.token);
        }
        if (S.pendingJoin) history.replaceState(null, '', '/');
        S.pendingJoin = null;
        S.room = msg.room;
        S.overAnnounced = false;
        S.resultShown = false;
        if (S.resultTimer) { clearTimeout(S.resultTimer); S.resultTimer = null; }
        board.setWoodSeed(strHash(S.room.code));
        prepareInvite();
        showScreen('room');
        renderRoom();
        if (msg.t === 'created') toast('房间已创建, 把链接发给微信好友吧');
        break;
      case 'room':
        maybePromptRequests(S.room, msg.room);
        S.room = msg.room;
        S.serverOffset = msg.room.now - Date.now();
        renderRoom();
        break;
      case 'error':
        if (msg.msg === '会话已过期') {
          S.token = null;
          sessionStorage.removeItem('gomoku.token');
          break;
        }
        toast(msg.msg);
        break;
      case 'room_closed':
        toast(msg.msg || '房间已关闭');
        leaveOnline();
        break;
      case 'replaced':
        toast('本房间已在其他页面打开');
        leaveOnline();
        break;
      case 'pong':
        break;
    }
  }

  // ---------- 分享 ----------
  function inviteUrl() { return S.inviteBase || (location.origin + '/r/' + (S.room ? S.room.code : '')); }

  function prepareInvite() {
    S.inviteBase = location.origin + '/r/' + (S.room ? S.room.code : '');
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      fetch('/info').then(r => r.json()).then(info => {
        if (info.ips && info.ips.length && S.room) {
          S.lanLink = 'http://' + info.ips[0] + ':' + info.port + '/r/' + S.room.code;
          S.inviteBase = S.lanLink;
          renderShare();
        }
      }).catch(() => { });
    }
    renderShare();
  }

  function renderShare() {
    const kindLabel = { ai: '人机', hotseat: '同屏', puzzle: '残局' }[kind()] || null;
    $('invite-link').textContent = inviteUrl();
    $('wait-code').textContent = S.room ? (isLocal() ? kindLabel : S.room.code) : '····';
    $('hud-code').textContent = S.room ? (isLocal() ? kindLabel : S.room.code) : '····';
    $('chip-label').textContent = isLocal() ? '模式' : '房间';
    $('btn-share').style.display = isLocal() ? 'none' : '';
  }

  function copyText(text, ok) {
    const done = () => toast(ok || '已复制');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done));
    } else legacyCopy(text, done);
  }

  function legacyCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败, 请长按链接手动复制'); }
    document.body.removeChild(ta);
  }

  function drawQR(text) {
    const canvas = $('qr-img');
    try {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      const count = qr.getModuleCount();
      const size = canvas.width;
      const cell = Math.floor(size / (count + 2));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#111';
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (qr.isDark(r, c)) ctx.fillRect((c + 1) * cell, (r + 1) * cell, cell, cell);
        }
      }
      $('qr-area').style.display = 'block';
    } catch (e) {
      $('qr-area').style.display = 'none';
    }
  }

  // ---------- 单机: 人机 / 双人同屏 ----------
  const AI_NAME = { easy: '电脑 · 简单', normal: '电脑 · 普通', hard: '电脑 · 困难' };

  function startLocalGame(kind, playerColor) {
    const rules = readRules();
    if (S.aiTimer) { clearTimeout(S.aiTimer); S.aiTimer = null; }
    S.mode = 'local';
    S.pending.clear();
    S.local = {
      kind,
      rules: { size: rules.size, mode: rules.mode, undo: rules.undo },
      board: GR.newBoard(rules.size),
      moves: [],
      playerColor: kind === 'hotseat' ? 'black' : playerColor,
      aiColor: kind === 'ai' ? (playerColor === 'black' ? 'white' : 'black') : null,
      over: false, result: null, winLine: null,
      turn: 'black',
      gen: (S.local ? S.local.gen : 0) + 1,
      puzzle: null, challenge: null
    };
    board.setWoodSeed(strHash(kind + '-' + Date.now()));
    S.room = localSnapshot();
    S.overAnnounced = false;
    S.resultShown = false;
    if (S.resultTimer) { clearTimeout(S.resultTimer); S.resultTimer = null; }
    showScreen('room');
    renderRoom();
    if (S.local.kind === 'ai' && S.local.turn === S.local.aiColor) scheduleAI();
  }

  function localSnapshot() {
    const L = S.local;
    const lv = readAiLevel();
    const base = {
      code: { ai: '人机对战', hotseat: '双人同屏', puzzle: '残局挑战' }[L.kind],
      rules: { size: L.rules.size, mode: L.rules.mode, first: 'host', timeLimit: 0, undo: L.rules.undo },
      state: L.over ? 'over' : 'playing',
      colors: { black: 'host', white: 'guest' },
      board: Array.from(L.board),
      moves: L.moves.map(m => ({ x: m.x, y: m.y, c: m.c })),
      turn: L.turn,
      deadline: null, now: Date.now(),
      result: L.result, winLine: L.winLine,
      drawOffer: null, undoReq: null,
      rematch: { black: false, white: false },
      you: 'host', youColor: L.kind === 'hotseat' ? null : L.playerColor
    };
    if (L.kind === 'ai') {
      base.players = {
        host: { name: myName() || '我', connected: true },
        guest: { name: AI_NAME[lv] || '电脑', connected: true }
      };
    } else if (L.kind === 'hotseat') {
      base.players = {
        host: { name: myName() || '玩家甲', connected: true },
        guest: { name: '玩家乙', connected: true }
      };
    } else {
      base.players = {
        host: { name: myName() || '挑战者', connected: true },
        guest: { name: '残局 · 第 ' + L.puzzle.level + ' 关', connected: true }
      };
    }
    return base;
  }

  function finishLocalMove() {
    const L = S.local;
    const n = L.rules.size;
    const last = L.moves[L.moves.length - 1];
    const win = GR.checkWin(L.board, n, last.x, last.y, last.c, { mode: L.rules.mode });
    if (win.win) {
      L.over = true;
      L.result = { winner: last.c === 1 ? 'black' : 'white', reason: 'five' };
      L.winLine = win.line;
    } else if (L.moves.length === n * n) {
      L.over = true;
      L.result = { winner: 'draw', reason: 'board-full' };
    } else {
      L.turn = L.turn === 'black' ? 'white' : 'black';
    }
    S.room = localSnapshot();
    renderRoom();
  }

  function applyLocalMove(x, y) {
    const L = S.local;
    if (!L || L.over || (L.kind === 'ai' && L.turn === L.aiColor)) return false;
    const n = L.rules.size;
    if (L.board[GR.idx(x, y, n)] !== 0) return false;
    if (L.rules.mode === 'renju' && L.turn === 'black' &&
        GR.isForbiddenPoint(L.board, n, x, y)) return false;
    const c = L.turn === 'black' ? 1 : 2;
    L.board[GR.idx(x, y, n)] = c;
    L.moves.push({ x, y, c });
    finishLocalMove();
    return true;
  }

  function scheduleAI() {
    const L = S.local;
    if (!L || L.over || L.kind !== 'ai' || L.turn !== L.aiColor) return;
    const gen = L.gen;
    const level = readAiLevel();
    const color = L.turn === 'black' ? 1 : 2;
    S.aiTimer = setTimeout(() => {
      if (S.aiTimer) { clearTimeout(S.aiTimer); S.aiTimer = null; }
      if (!S.local || S.local.gen !== gen || S.local.over || S.local.turn !== L.aiColor) return;
      const mv = AIE.bestMove(S.local.board, S.local.rules.size, color, { mode: S.local.rules.mode }, level);
      if (mv && S.local && S.local.gen === gen && !S.local.over && S.local.turn === L.aiColor) {
        const n = L.rules.size;
        L.board[GR.idx(mv.x, mv.y, n)] = color;
        L.moves.push({ x: mv.x, y: mv.y, c: color });
        finishLocalMove();
      }
    }, 420 + Math.random() * 480);
  }

  function localUndo() {
    const L = S.local;
    if (!L || L.over || !L.rules.undo) return;
    if (S.aiTimer) { clearTimeout(S.aiTimer); S.aiTimer = null; }
    if (L.kind === 'hotseat') {
      L.moves.pop();
    } else {
      let pops = 0;
      while (L.moves.length > 0 && pops < 2) {
        const last = L.moves.pop();
        pops++;
        if ((last.c === 1 ? 'black' : 'white') === L.playerColor) break;
      }
    }
    L.board = GR.newBoard(L.rules.size);
    for (const m of L.moves) L.board[GR.idx(m.x, m.y, L.rules.size)] = m.c;
    L.turn = L.moves.length === 0 ? 'black' : (L.moves[L.moves.length - 1].c === 1 ? 'white' : 'black');
    S.room = localSnapshot();
    renderRoom();
    if (L.kind === 'ai' && L.turn === L.aiColor) scheduleAI();
  }

  // ---------- 单机: 残局挑战 ----------
  function startPuzzle(level, score, hearts) {
    if (S.aiTimer) { clearTimeout(S.aiTimer); S.aiTimer = null; }
    const p = PZ.generate(level);
    S.mode = 'local';
    S.pending.clear();
    const stones = [];
    for (let y = 0; y < p.n; y++) {
      for (let x = 0; x < p.n; x++) {
        const v = p.board[y * p.n + x];
        if (v) stones.push({ x, y, c: v });
      }
    }
    S.local = {
      kind: 'puzzle',
      rules: { size: p.n, mode: 'free', undo: false },
      board: p.board.slice(),
      moves: stones,
      playerColor: p.color === 1 ? 'black' : 'white',
      aiColor: null,
      over: false, result: null, winLine: null,
      turn: p.color === 1 ? 'black' : 'white',
      gen: (S.local ? S.local.gen : 0) + 1,
      puzzle: {
        level, type: p.type, color: p.color, solution: p.solution,
        depth: p.depth || 1, left: p.depth || 1, locked: false,
        hearts: hearts === undefined ? 3 : hearts,
        hint: null
      },
      challenge: { score: score || 0, best: Number(localStorage.getItem('gomoku.puzzleBest') || 0) }
    };
    board.setWoodSeed(strHash('puzzle-' + level));
    S.room = localSnapshot();
    S.overAnnounced = false;
    S.resultShown = false;
    if (S.resultTimer) { clearTimeout(S.resultTimer); S.resultTimer = null; }
    showScreen('room');
    renderRoom();
  }

  function puzzleSolved(passed) {
    const L = S.local;
    const P = L.puzzle;
    if (passed) {
      L.challenge.score++;
      P.hearts = Math.min(3, P.hearts + 1);
      board.celebrate();
      Sound.play('notify');
    } else {
      L.challenge.best = Math.max(L.challenge.best, L.challenge.score);
      localStorage.setItem('gomoku.puzzleBest', String(L.challenge.best));
      L.over = true;
      L.result = { winner: null, reason: 'challenge-end' };
      S.room = localSnapshot();
      renderRoom();
    }
  }

  function pzFindWins(colorNum) {
    const L = S.local;
    const n = L.rules.size;
    return PZ.findWins(L.board, colorNum).map(i => ({ idx: i, x: i % n, y: Math.floor(i / n) }));
  }

  function puzzleFail(msg) {
    const L = S.local;
    const P = L.puzzle;
    vibrate(60);
    Sound.play('bad');
    P.locked = false;
    const cv = $('board');
    cv.classList.remove('shake');
    void cv.offsetWidth;
    cv.classList.add('shake');
    P.hearts--;
    if (P.hearts <= 0) { puzzleSolved(false); return; }
    toast(msg + ' (' + P.hearts + ' 次机会)');
    S.room = localSnapshot();
    renderRoom();
  }

  function puzzleTap(x, y) {
    const L = S.local;
    const P = L.puzzle;
    if (P.locked) return;
    const n = L.rules.size;
    const idx = GR.idx(x, y, n);
    if (L.board[idx] !== 0) { toast('这里已有棋子'); return; }
    const cNum = P.color;
    const defender = cNum === 1 ? 2 : 1;

    if (P.type === 'win') {
      L.board[idx] = cNum; L.moves.push({ x, y, c: cNum });
      finishLocalMove();            // 成五 → 金线彩带 → 结算"通过"
      puzzleSolved(true);
      return;
    }
    if (P.type === 'block') {
      L.board[idx] = cNum; L.moves.push({ x, y, c: cNum });
      L.over = true;
      L.result = { winner: null, reason: 'puzzle-pass' };
      puzzleSolved(true);
      S.room = localSnapshot();
      renderRoom();
      return;
    }

    if (P.type === 'double4') {
      if (idx !== P.solution) { puzzleFail('这不是一子双杀点'); return; }
      L.board[idx] = cNum; L.moves.push({ x, y, c: cNum });
      renderRoom();
      P.locked = true;
      const gen = L.gen;
      const wins = pzFindWins(cNum);
      setTimeout(() => {                                   // 对手封堵一处
        if (!S.local || S.local.gen !== gen) return;
        L.board[wins[0].y * n + wins[0].x] = defender;
        L.moves.push({ x: wins[0].x, y: wins[0].y, c: defender });
        Sound.play('place');
        renderRoom();
        setTimeout(() => {                                 // 另一处成五
          if (!S.local || S.local.gen !== gen) return;
          L.board[wins[1].y * n + wins[1].x] = cNum;
          L.moves.push({ x: wins[1].x, y: wins[1].y, c: cNum });
          finishLocalMove();
          puzzleSolved(true);
        }, 650);
      }, 650);
      return;
    }

    // 连续冲四 (vcf): 每手都必须冲四或成五, 电脑自动防守
    L.board[idx] = cNum; L.moves.push({ x, y, c: cNum });
    if (GR.checkWin(L.board, n, x, y, cNum, { mode: 'free' }).win) {
      finishLocalMove();
      puzzleSolved(true);
      return;
    }
    const wins = pzFindWins(cNum);
    if (wins.length === 0) {
      // 非强制手: 撤回并判失败
      L.board[idx] = 0; L.moves.pop();
      puzzleFail('这手没有形成冲四');
      return;
    }
    if (wins.length >= 2) {
      // 双四无解 → 自动收官
      P.locked = true;
      const gen = L.gen;
      setTimeout(() => {
        if (!S.local || S.local.gen !== gen) return;
        L.board[wins[0].y * n + wins[0].x] = defender;
        L.moves.push({ x: wins[0].x, y: wins[0].y, c: defender });
        renderRoom();
        setTimeout(() => {
          if (!S.local || S.local.gen !== gen) return;
          L.board[wins[1].y * n + wins[1].x] = cNum;
          L.moves.push({ x: wins[1].x, y: wins[1].y, c: cNum });
          finishLocalMove();
          puzzleSolved(true);
        }, 650);
      }, 600);
      return;
    }
    // 单四: 对手被迫封堵, 继续冲四
    P.left--;
    if (P.left < 0) {
      L.board[idx] = 0; L.moves.pop();
      P.left = P.depth;
      puzzleFail('手数已用尽, 冲四路线中断');
      return;
    }
    const gen = L.gen;
    const w = wins[0];
    P.locked = true;
    setTimeout(() => {
      if (!S.local || S.local.gen !== gen) return;
      L.board[w.y * n + w.x] = defender;
      L.moves.push({ x: w.x, y: w.y, c: defender });
      Sound.play('place');
      if (GR.checkWin(L.board, n, w.x, w.y, defender, { mode: 'free' }).win) {
        // 对手封堵顺手反杀 → 此路不通, 整段撤回
        L.board[w.y * n + w.x] = 0; L.moves.pop();
        L.board[idx] = 0; L.moves.pop();
        P.left = P.depth;
        P.locked = false;
        puzzleFail('对手反杀! 这条路线不通');
        return;
      }
      P.locked = false;
      renderRoom();
    }, 620);
  }

  function puzzleHint() {
    const L = S.local;
    const P = L.puzzle;
    if (P.hearts <= 1) { toast('至少保留 1 颗心才能用提示'); Sound.play('bad'); return; }
    P.hearts--;
    P.hint = { x: P.solution % L.rules.size, y: Math.floor(P.solution / L.rules.size) };
    Sound.play('hint');
    S.room = localSnapshot();
    renderRoom();
    toast('提示已点亮 (消耗 1 颗心)');
  }

  // ---------- 威胁提示 (冲四/活四/双活三/四三) ----------
  // 扫描刚落的最后一手在各方向形成的威胁, 返回 {kind, cells} 或 null
  function scanThreats(board, n, x, y, color) {
    const num = color === 'black' ? 1 : 2;
    const DIRS4 = [[1, 0], [0, 1], [1, 1], [1, -1]];
    const cells = new Set();
    let fours = 0, threes = 0, openFour = false;
    for (const [dx, dy] of DIRS4) {
      let str = '';
      for (let o = -4; o <= 4; o++) {
        const i = x + dx * o, j = y + dy * o;
        if (i < 0 || j < 0 || i >= n || j >= n) { str += 'X'; continue; }
        const v = board[j * n + i];
        str += v === 0 ? '.' : (v === num ? 'O' : 'X');
      }
      // str[4] 为落点; 含落点的 5 窗口: 4 子 + 1 空 → 冲四/活四
      let four = false;
      for (let k = 0; k <= 4; k++) {
        const w = str.slice(k, k + 5);
        if (w[4 - k] !== 'O') continue;
        const oCnt = (w.match(/O/g) || []).length;
        if (oCnt === 4 && w.includes('.')) {
          four = true;
          if (str[k - 1] === '.' && str[k + 5] === '.') openFour = true;
          for (let m = 0; m < 5; m++) {
            if (w[m] === 'O') cells.add((y + dy * (k + m)) * n + (x + dx * (k + m)));
          }
        }
      }
      if (four) { fours++; continue; }
      // 活三: .OOO. 含落点
      for (let k = 1; k <= 3; k++) {
        if (str.slice(k, k + 5) === '.OOO.') {
          threes++;
          for (let m = 1; m <= 3; m++) cells.add((y + dy * (k + m)) * n + (x + dx * (k + m)));
          break;
        }
      }
    }
    let kind = null;
    if (fours >= 1 && threes >= 1) kind = '⚠ 四三!';
    else if (fours >= 2) kind = '⚠ 双四!';
    else if (threes >= 2) kind = '⚠ 三三!';
    else if (openFour) kind = '⚠ 活四!';
    else if (fours === 1) kind = '⚠ 冲四!';
    return kind ? { kind, cells: [...cells] } : null;
  }

  // ---------- 渲染 ----------
  function renderRoom() {
    const room = S.room;
    if (!room) return;
    renderShare();

    const myColor = room.youColor;
    const mySeat = room.you === 'spectator' ? null : room.you;
    const amPlaying = mySeat && (room.colors.black === mySeat || room.colors.white === mySeat);
    const oppSeat = mySeat ? (mySeat === 'host' ? 'guest' : 'host') : null;
    const kd = kind();

    renderCard('card-black', 'black', room);
    renderCard('card-white', 'white', room);

    // 状态条
    const bar = $('statusbar');
    bar.classList.remove('muted', 'thinking');
    if (isLocal() && kd === 'puzzle') {
      const P = S.local.puzzle;
      if (room.state === 'over') {
        bar.textContent = room.result && room.result.reason !== 'challenge-end' ? '✓ 通过!' : '挑战结束';
        bar.classList.add('muted');
      } else {
        const typeText = {
          win: '致胜一子:落子连五', block: '化解杀着:堵住对手',
          double4: '一子双杀:一手形成双四', vcf: '连续冲四:每手都要冲四'
        }[P.type];
        bar.textContent = '第 ' + P.level + ' 关 · ' + typeText +
          (P.type === 'vcf' ? ' · 剩 ' + P.left + ' 手' : '') +
          ' · ' + ('❤'.repeat(P.hearts) || '💔');
        bar.classList.add('muted');
      }
    } else if (isLocal() && kd === 'hotseat' && room.state === 'playing') {
      bar.textContent = '轮到 ' + (room.turn === 'black' ? '黑方' : '白方') + ' 落子';
    } else if (isLocal() && kd === 'ai' && room.state === 'playing') {
      if (room.turn === S.local.aiColor) { bar.textContent = '电脑思考中'; bar.classList.add('thinking', 'muted'); }
      else bar.textContent = '轮到你落子 · 执' + (myColor === 'black' ? '黑' : '白');
    } else if (room.state === 'waiting') {
      bar.textContent = mySeat === 'host' ? '等待好友加入…' : '已加入房间, 等待房主开始';
      bar.classList.add('muted');
    } else if (room.state === 'over') {
      bar.textContent = '对局结束';
      bar.classList.add('muted');
    } else if (!amPlaying) {
      bar.textContent = '观战中 · ' + (room.turn === 'black' ? '黑方' : '白方') + '行棋';
      bar.classList.add('muted');
    } else {
      const opp = room.players[oppSeat];
      if (opp && !opp.connected) {
        bar.textContent = '对方已断线, 等待重连 (60 秒内)…';
      } else if (room.turn === myColor) {
        bar.textContent = '轮到你落子 · 执' + (myColor === 'black' ? '黑' : '白');
      } else {
        bar.textContent = '等待 ' + (opp ? opp.name : '对方') + ' 落子…';
        bar.classList.add('muted');
      }
    }

    // 棋盘
    const myTurn = amPlaying && room.state === 'playing' && room.turn === myColor;
    let forbidden = [];
    if (room.rules.mode === 'renju' && myTurn && myColor === 'black' && room.board) {
      forbidden = GR.forbiddenPoints(room.board, room.rules.size);
    }
    if (S.mode === 'online' && S.pending.size && room.board) {
      for (const [idx, c] of [...S.pending]) {
        const v = room.board[idx];
        if (v === c || v !== 0) S.pending.delete(idx);
      }
    }
    // 威胁提示: 最后一手形成 冲四/活四/双三/四三 时, 相关棋子跳动提醒
    if (room.state === 'playing' && room.moves.length && room.moves.length !== S.alertMoves) {
      S.alertMoves = room.moves.length;
      const last = room.moves[room.moves.length - 1];
      const lastColor = last.c === 1 ? 'black' : 'white';
      const t = scanThreats(room.board, room.rules.size, last.x, last.y, lastColor);
      if (t) {
        S.alert = {
          cells: t.cells, kind: t.kind,
          start: performance.now(), until: performance.now() + 2500,
          color: (room.youColor && lastColor === room.youColor) ? 'gold' : 'red'
        };
        Sound.play('hint');
        vibrate(20);
        toast(t.kind + (room.youColor && lastColor === room.youColor ? ' (我方)' : ' (对方)'));
      } else S.alert = null;
    } else if (!room.moves.length) {
      S.alert = null; S.alertMoves = 0;
    }
    board.update(room, {
      myTurn, myColor: myColor || 'black', forbidden,
      pending: S.mode === 'online' ? [...S.pending].map(([idx, c]) => ({ idx, color: c })) : [],
      hint: (isLocal() && kd === 'puzzle' && S.local.puzzle.hint) ? S.local.puzzle.hint : null,
      alert: S.alert
    });

    // 等待覆盖层 (联机)
    const waiting = room.state === 'waiting';
    $('ov-wait').classList.toggle('show', waiting);
    if (waiting) {
      const rs = ruleSummary(room.rules);
      $('rule-summary').innerHTML = rs.map(r =>
        '<div class="rule-line"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>').join('');
      renderSeat('seat-host', room.players.host, room.rules.first === 'host');
      renderSeat('seat-guest', room.players.guest, room.rules.first === 'guest');
      const canStart = mySeat === 'host' && !!room.players.guest;
      $('btn-start').disabled = !canStart;
      $('wait-hint').textContent =
        mySeat === 'host'
          ? (room.players.guest ? '对手已就位, 点击开始' : '发送上方链接, 邀请好友加入')
          : '等待房主开始对局…';
    }

    // 结算覆盖层 (延迟弹出, 先看胜利演出)
    const over = room.state === 'over';
    if (!over) {
      S.resultShown = false;
      if (S.resultTimer) { clearTimeout(S.resultTimer); S.resultTimer = null; }
      $('ov-result').classList.remove('show');
    }
    if (over && !S.resultShown) {
      S.resultShown = true;
      S.resultTimer = setTimeout(() => $('ov-result').classList.add('show'), isLocal() && kd === 'puzzle' ? 900 : 1250);
    }
    if (over && room.result) {
      const stampEl = $('result-stamp');
      const title = $('result-title');
      if (isLocal() && kd === 'puzzle') {
        const passed = room.result.reason !== 'challenge-end';
        title.textContent = passed ? '通过!' : '挑战结束';
        title.className = 'result-title win';
        if (passed) {
          $('result-sub').textContent = '第 ' + S.local.puzzle.level + ' 关 · 累计 ' + S.local.challenge.score + ' 分';
          $('btn-rematch').textContent = '下一关';
          stampEl.textContent = '通';
          stampEl.className = 'result-stamp';
        } else {
          $('result-sub').textContent = '通过 ' + S.local.challenge.score + ' 关 · 历史最佳 ' + S.local.challenge.best;
          $('btn-rematch').textContent = '再来一轮';
          stampEl.textContent = '终';
          stampEl.className = 'result-stamp lose';
        }
        $('rematch-state').textContent = '';
      } else {
        let cls = 'draw', txt = '平局';
        if (room.result.winner !== 'draw') {
          const winnerColor = room.result.winner;
          if (!amPlaying) { txt = (winnerColor === 'black' ? '黑方' : '白方') + '获胜'; cls = 'win'; }
          else if (winnerColor === myColor) { txt = '胜利'; cls = 'win'; }
          else { txt = kd === 'ai' ? '再接再厉' : '惜败'; cls = 'lose'; }
        }
        title.textContent = txt;
        title.className = 'result-title ' + cls;
        const reasons = {
          five: '五连成线', timeout: '超时判负', resign: '认输',
          disconnect: '掉线超时', agreement: '双方同意', 'board-full': '棋盘已满'
        };
        const winnerName = room.result.winner === 'draw' ? ''
          : (room.players[room.colors[room.result.winner]] || {}).name || '';
        $('result-sub').textContent =
          room.result.winner === 'draw'
            ? (reasons[room.result.reason] || '') + ' · 和棋'
            : (winnerName + ' (' + (room.result.winner === 'black' ? '黑' : '白') + ') · ' + (reasons[room.result.reason] || ''));
        if (isLocal() && kd === 'ai') {
          $('btn-rematch').disabled = false;
          $('btn-rematch').textContent = '再来一局';
          $('rematch-state').textContent = '先手互换, 重新开战!';
        } else {
          const voted = myColor && room.rematch[myColor];
          $('btn-rematch').disabled = !!voted;
          $('btn-rematch').textContent = voted ? '已申请' : '再来一局';
          $('rematch-state').textContent =
            room.rematch.black && room.rematch.white ? '双方同意, 正在交换先后手开始新对局…'
              : (voted ? '等待对方同意…' : '双方都点击「再来一局」即可交换先后手再战');
        }
        // 印章
        if (room.result.winner === 'draw') { stampEl.textContent = '和'; stampEl.className = 'result-stamp draw'; }
        else if (!amPlaying) { stampEl.textContent = '观'; stampEl.className = 'result-stamp lose'; }
        else if (room.result.winner === myColor) { stampEl.textContent = '胜'; stampEl.className = 'result-stamp'; }
        else { stampEl.textContent = '负'; stampEl.className = 'result-stamp lose'; }
      }
      if (!S.overAnnounced) {
        S.overAnnounced = true;
        if (!amPlaying) Sound.play('notify');
        else if (room.result.winner === 'draw') Sound.play('notify');
        else Sound.play(room.result.winner === myColor ? 'win' : 'lose');
        if (amPlaying && room.result.winner === myColor && room.result.winner !== 'draw') vibrate([30, 40, 60]);
      }
    }
    if (!over) S.overAnnounced = false;

    // 操作按钮 (按模式显隐)
    const undoBtn = $('btn-undo');
    undoBtn.textContent = kd === 'puzzle' ? '提示' : '悔棋';
    if (kd === 'puzzle') {
      undoBtn.disabled = room.state !== 'playing' || S.local.puzzle.hearts <= 1;
    } else {
      undoBtn.disabled = !(
        amPlaying && room.state === 'playing' && room.rules.undo &&
        room.turn === myColor && !room.undoReq && !room.drawOffer &&
        room.moves.some(m => m.c === (myColor === 'black' ? 1 : 2)));
    }
    $('btn-draw').style.display = isLocal() ? 'none' : '';
    $('btn-draw').disabled = !(amPlaying && room.state === 'playing' && !room.drawOffer && !room.undoReq);
    $('btn-resign').style.display = kd === 'hotseat' || kd === 'puzzle' ? 'none' : '';
    $('btn-resign').disabled = !(amPlaying && room.state === 'playing');
  }

  function renderCard(id, color, room) {
    const card = $(id);
    const seat = room.colors[color];
    const p = seat ? room.players[seat] : null;
    const isMe = seat && seat === room.you;
    const active = room.state === 'playing' && room.turn === color;
    card.classList.toggle('active', active);
    card.querySelector('.pname').textContent = p ? p.name : '等待加入';
    card.querySelector('.psub').textContent =
      (color === 'black' ? '黑' : '白') +
      (isMe && !isLocal() ? ' · 你' : '') +
      (p && !p.connected ? ' · 断线' : '');
    const timer = card.querySelector('.ptimer');
    const ring = card.querySelector('.ring');
    const timed = room.state === 'playing' && room.rules.timeLimit && active && room.deadline;
    if (timed) {
      const remain = Math.max(0, (room.deadline - (Date.now() + S.serverOffset)) / 1000);
      const total = room.rules.timeLimit;
      timer.classList.remove('off');
      timer.classList.toggle('hot', remain <= 10);
      timer.textContent = Math.floor(remain / 60) + ':' + String(Math.floor(remain % 60)).padStart(2, '0');
      ring.classList.add('on');
      ring.style.setProperty('--p', Math.max(0, Math.min(100, (remain / total) * 100)));
    } else {
      timer.classList.add('off');
      ring.classList.remove('on');
    }
  }

  function renderSeat(id, p, willBlack) {
    const el = $(id);
    const icon = el.querySelector('.stone-icon');
    icon.style.visibility = willBlack ? 'visible' : 'hidden';
    icon.className = 'stone-icon ' + (willBlack ? 'black' : 'white');
    el.classList.toggle('filled', !!p);
    el.querySelector('.name').textContent = p ? p.name : (id === 'seat-host' ? '房主 (我)' : '玩家');
    el.querySelector('.who').textContent = p
      ? (willBlack ? '执黑先行' : '执白后行') + (p.connected ? '' : ' · 断线')
      : '虚位以待';
  }

  // 每 250ms 刷新倒计时圆环
  setInterval(() => {
    if (S.mode === 'online' && S.room) {
      renderCard('card-black', 'black', S.room);
      renderCard('card-white', 'white', S.room);
    }
  }, 250);

  // ---------- 对话框响应 ----------
  function maybePromptRequests(prev, cur) {
    if (!prev) return cur;
    if (cur.undoReq && cur.undoReq !== cur.youColor && prev.undoReq !== cur.undoReq) {
      const who = (cur.players[cur.colors[cur.undoReq]] || {}).name || '对方';
      showModal('悔棋请求', who + ' 想撤销最后一手, 是否同意?', [
        { label: '拒绝', cls: 'ghost', cb: () => send({ t: 'undo_res', ok: false }) },
        { label: '同意', cb: () => send({ t: 'undo_res', ok: true }) }
      ]);
    }
    if (cur.drawOffer && cur.drawOffer !== cur.youColor && prev.drawOffer !== cur.drawOffer) {
      const who = (cur.players[cur.colors[cur.drawOffer]] || {}).name || '对方';
      showModal('求和请求', who + ' 提议平局握手言和, 是否同意?', [
        { label: '拒绝', cls: 'ghost', cb: () => send({ t: 'draw_res', ok: false }) },
        { label: '同意', cb: () => send({ t: 'draw_res', ok: true }) }
      ]);
    }
    return cur;
  }

  // ---------- 事件绑定 ----------
  function myName() {
    const v = $('name-input').value.trim();
    if (v) localStorage.setItem('gomoku.name', v);
    return v;
  }

  for (const seg of document.querySelectorAll('.seg')) {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      if (seg.classList.contains('seg-ai')) localStorage.setItem('gomoku.ailv', btn.dataset.v);
    });
  }
  (function () {
    const lv = localStorage.getItem('gomoku.ailv');
    if (!lv) return;
    const btn = document.querySelector('.seg-ai button[data-v="' + lv + '"]');
    if (btn) {
      document.querySelectorAll('.seg-ai button').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
    }
  })();

  $('name-input').value = localStorage.getItem('gomoku.name') || '';

  $('btn-create').onclick = () => {
    send({ t: 'create', name: myName(), rules: readRules() });
  };
  $('btn-ai').onclick = () => startLocalGame('ai', 'black');
  $('btn-hot').onclick = () => startLocalGame('hotseat');
  $('btn-puzzle').onclick = () => startPuzzle(1, 0, 3);

  $('btn-join').onclick = () => {
    const code = $('code-input').value.trim().toUpperCase();
    if (!code) { toast('请输入邀请码'); return; }
    send({ t: 'join', code, name: myName(), token: S.token });
  };
  $('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').onclick(); });

  $('btn-copy').onclick = () => copyText(inviteUrl(), '链接已复制, 打开微信粘贴给好友');

  $('btn-more-share').onclick = () => {
    const area = $('qr-area');
    if (area.style.display === 'none') {
      drawQR(inviteUrl());
      if (navigator.share) {
        navigator.share({ title: '五子棋 · 联机对战', text: '来和我下五子棋!房间码 ' + (S.room ? S.room.code : ''), url: inviteUrl() })
          .catch(() => { });
      }
    } else {
      area.style.display = 'none';
    }
  };

  $('btn-share').onclick = () => {
    copyText(inviteUrl(), '链接已复制, 打开微信粘贴给好友');
    if (S.room && S.room.state !== 'waiting') toast('链接已复制 · 新好友打开可进入观战');
    else $('ov-wait').classList.add('show');
  };

  // 声音配置弹层
  $('btn-sound').onclick = () => {
    $('sound-pop').classList.toggle('show');
  };
  document.addEventListener('click', (e) => {
    const pop = $('sound-pop');
    if (!pop.classList.contains('show')) return;
    if (e.target === $('btn-sound') || pop.contains(e.target)) return;
    pop.classList.remove('show');
  });
  function refreshSoundPop() {
    $('sp-sfx').textContent = Sound.sfxOn ? '开' : '关';
    $('sp-sfx').classList.toggle('on', Sound.sfxOn);
    $('sp-music').textContent = Sound.musicOn ? '开' : '关';
    $('sp-music').classList.toggle('on', Sound.musicOn);
    $('vol-sfx').value = Math.round(Sound.sfxVol * 100);
    $('vol-music').value = Math.round(Sound.musicVol * 100);
  }
  $('sp-sfx').onclick = () => { Sound.setSfx(!Sound.sfxOn); refreshSoundPop(); };
  $('sp-music').onclick = () => { Sound.setMusic(!Sound.musicOn); refreshSoundPop(); };
  $('vol-sfx').oninput = (e) => Sound.setSfxVol(e.target.value / 100);
  $('vol-music').oninput = (e) => Sound.setMusicVol(e.target.value / 100);
  // 音乐风格切换
  for (const btn of document.querySelectorAll('#sp-style-row button')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#sp-style-row button').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      Sound.setMusicStyle(btn.dataset.v);
    });
  }
  (function initStyleBtns() {
    const cur = Sound.musicStyle;
    document.querySelectorAll('#sp-style-row button').forEach(b => b.classList.toggle('on', b.dataset.v === cur));
  })();
  refreshSoundPop();

  $('btn-exit').onclick = () => {
    if (isLocal()) { exitToHome(); return; }
    const room = S.room;
    if (!room) return;
    if (room.state === 'playing' && room.youColor) {
      showModal('退出房间', '对局进行中, 退出将按认输处理。确定退出?', [
        { label: '继续对局', cls: 'ghost' },
        { label: '退出', cb: () => { send({ t: 'leave' }); leaveOnline(); } }
      ]);
    } else {
      send({ t: 'leave' });
      leaveOnline();
    }
  };

  $('btn-start').onclick = () => send({ t: 'start' });

  $('btn-undo').onclick = () => {
    if (kind() === 'puzzle') { puzzleHint(); return; }
    if (isLocal()) { localUndo(); return; }
    send({ t: 'undo_req' });
  };

  $('btn-draw').onclick = () => {
    showModal('请求和棋', '向对方提议平局, 对方同意后本局作和。', [
      { label: '取消', cls: 'ghost' },
      { label: '发送请求', cb: () => send({ t: 'draw_req' }) }
    ]);
  };

  $('btn-resign').onclick = () => {
    if (isLocal() && kind() === 'ai') {
      showModal('认输', '确定向电脑认输吗?', [
        { label: '再想想', cls: 'ghost' },
        { label: '认输', cb: () => {
          const L = S.local;
          if (L && !L.over) {
            L.over = true;
            L.result = { winner: L.aiColor, reason: 'resign' };
            S.room = localSnapshot();
            renderRoom();
          }
        } }
      ]);
      return;
    }
    showModal('确认认输', '认输后本局直接判负, 确定吗?', [
      { label: '再想想', cls: 'ghost' },
      { label: '认输', cb: () => send({ t: 'resign' }) }
    ]);
  };

  $('btn-rematch').onclick = () => {
    if (isLocal()) {
      const kd = kind();
      if (kd === 'puzzle') {
        const r = S.local.result;
        if (S.local.over && r && r.reason === 'challenge-end') startPuzzle(1, 0, 3);
        else startPuzzle(S.local.puzzle.level + 1, S.local.challenge.score, S.local.puzzle.hearts);
      } else {
        startLocalGame(kd, S.local.playerColor === 'black' ? 'white' : 'black');
      }
      return;
    }
    send({ t: 'rematch' });
  };
  $('btn-back-home').onclick = () => {
    if (isLocal()) { exitToHome(); return; }
    send({ t: 'leave' });
    leaveOnline();
  };

  board.onTap = (x, y) => {
    const room = S.room;
    if (!room || room.state !== 'playing') return;
    const n = room.rules.size;
    const kd = kind();

    if (isLocal() && kd === 'puzzle') { puzzleTap(x, y); return; }
    if (isLocal() && kd === 'hotseat') {
      if (room.board[y * n + x] !== 0) { toast('这里已有棋子'); return; }
      vibrate(12);
      applyLocalMove(x, y);
      return;
    }

    if (!room.youColor || room.turn !== room.youColor) return;
    if (room.board[y * n + x] !== 0) { toast('这个位置已有棋子'); return; }
    if (room.rules.mode === 'renju' && room.youColor === 'black') {
      const f = GR.isForbiddenPoint(room.board.slice(), n, x, y);
      if (f) {
        const names = { overline: '长连禁手', 'double-four': '四四禁手', 'double-three': '三三禁手' };
        toast('禁手点: ' + (names[f] || f) + ', 黑棋不可落子');
        return;
      }
    }
    vibrate(12);
    if (isLocal() && kd === 'ai') {
      applyLocalMove(x, y);
      if (S.local && !S.local.over && S.local.turn === S.local.aiColor) scheduleAI();
      return;
    }
    const idx = y * n + x;
    if (!S.pending.has(idx)) {
      S.pending.set(idx, room.youColor === 'black' ? 1 : 2);
      renderRoom();
    }
    send({ t: 'move', x, y });
  };

  // ---------- 入口 ----------
  (function parseEntry() {
    const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{1,8})/);
    const q = new URLSearchParams(location.search).get('room');
    const code = (m && m[1]) || q;
    if (code) S.pendingJoin = code.toUpperCase();
  })();

  connect();
})();
