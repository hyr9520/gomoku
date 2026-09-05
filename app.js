/*
 * 前端主逻辑: WebSocket 通信 / 房间流程 / 界面渲染 / 微信分享
 */
(function () {
  'use strict';

  const GR = window.GomokuRules;
  const $ = (id) => document.getElementById(id);

  // ---------- 状态 ----------
  // token 存 sessionStorage: 刷新不丢, 但同一浏览器的多个标签页各自独立身份 (可双开对垒)
  const S = {
    ws: null,
    wsOk: false,
    retry: 0,
    retryTimer: null,
    room: null,          // 最新快照
    token: sessionStorage.getItem('gomoku.token') || null,
    pendingJoin: null,   // 从链接进入时待加入的房间码
    serverOffset: 0,
    overAnnounced: false,
    lanLink: null,       // 本机为 localhost 时, 可分享的局域网链接
    inviteBase: null     // 实际用于分享的链接
  };
  const outbox = [];     // 连接建立前发出的指令, 连上后补发

  const board = new GomokuBoard($('board'));

  // ---------- 工具 ----------
  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2200);
  }

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

  function send(obj) {
    if (S.ws && S.wsOk) { S.ws.send(JSON.stringify(obj)); return true; }
    outbox.push(obj);
    return false;
  }

  function flushOutbox() {
    while (outbox.length) S.ws.send(JSON.stringify(outbox.shift()));
  }

  function banner(on) { $('conn-banner').classList.toggle('show', on); }

  // ---------- 规则选项 ----------
  function readRules() {
    const rules = {};
    for (const seg of document.querySelectorAll('.seg')) {
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
      banner(true);
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
      // 从邀请链接进入 (页面刷新后 token 仍在, 服务端会识别原座位)
      send({ t: 'join', code: S.pendingJoin, name: myName(), token: S.token });
    } else if (S.token) {
      // 刷新后直接恢复进行中的对局
      send({ t: 'resume', token: S.token });
    }
  }

  function handleMsg(msg) {
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
          // 无声清理过期 token, 停留首页
          S.token = null;
          sessionStorage.removeItem('gomoku.token');
          break;
        }
        toast(msg.msg);
        break;
      case 'room_closed':
        toast(msg.msg || '房间已关闭');
        leaveLocal();
        break;
      case 'replaced':
        toast('本房间已在其他页面打开');
        leaveLocal();
        break;
      case 'pong':
        break;
    }
  }

  function leaveLocal() {
    S.room = null;
    S.token = null;
    sessionStorage.removeItem('gomoku.token');
    board.clear();
    hideModal();
    showScreen('home');
    banner(false);
  }

  // ---------- 分享 ----------
  function inviteUrl() { return S.inviteBase || (location.origin + '/r/' + (S.room ? S.room.code : '')); }

  function prepareInvite() {
    S.inviteBase = location.origin + '/r/' + (S.room ? S.room.code : '');
    // 本机通过 localhost 打开时, 局域网地址才是好友可用的链接
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      fetch('/info').then(r => r.json()).then(info => {
        if (info.ips && info.ips.length) {
          S.lanLink = 'http://' + info.ips[0] + ':' + info.port + '/r/' + S.room.code;
          S.inviteBase = S.lanLink;
          renderShare();
        }
      }).catch(() => { });
    }
    renderShare();
  }

  function renderShare() {
    const link = inviteUrl();
    $('invite-link').textContent = link;
    $('wait-code').textContent = S.room ? S.room.code : '····';
    $('hud-code').textContent = S.room ? S.room.code : '····';
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

  // ---------- 渲染 ----------
  function renderRoom() {
    const room = S.room;
    if (!room) return;
    renderShare();

    const myColor = room.youColor;                    // 'black'|'white'|null
    const mySeat = room.you === 'spectator' ? null : room.you;
    const amPlaying = mySeat && (room.colors.black === mySeat || room.colors.white === mySeat);
    const oppSeat = mySeat ? (mySeat === 'host' ? 'guest' : 'host') : null;

    // 玩家卡片
    renderCard('card-black', 'black', room);
    renderCard('card-white', 'white', room);

    // 状态条
    const bar = $('statusbar');
    bar.classList.remove('muted');
    if (room.state === 'waiting') {
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
    board.update(room, { myTurn, myColor: myColor || 'black', forbidden });

    // 等待覆盖层
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

    // 结算覆盖层
    const over = room.state === 'over';
    $('ov-result').classList.toggle('show', over);
    if (over && room.result) {
      const title = $('result-title');
      let cls = 'draw', txt = '平局';
      if (room.result.winner !== 'draw') {
        const winnerColor = room.result.winner;
        if (!amPlaying) {
          txt = (winnerColor === 'black' ? '黑方' : '白方') + '获胜';
          cls = 'win';
        } else if (winnerColor === myColor) {
          txt = '胜利'; cls = 'win';
        } else { txt = '惜败'; cls = 'lose'; }
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
      // 再来一局状态
      const voted = myColor && room.rematch[myColor];
      $('btn-rematch').disabled = !!voted;
      $('btn-rematch').textContent = voted ? '已申请' : '再来一局';
      $('rematch-state').textContent =
        room.rematch.black && room.rematch.white ? '双方同意, 正在交换先后手开始新对局…'
          : (voted ? '等待对方同意…' : '双方都点击「再来一局」即可交换先后手再战');
      if (!S.overAnnounced) {
        S.overAnnounced = true;
        if (!amPlaying) Sound.play('notify');
        else if (room.result.winner === 'draw') Sound.play('notify');
        else Sound.play(room.result.winner === myColor ? 'win' : 'lose');
      }
    }
    if (!over) S.overAnnounced = false;

    // 操作按钮
    $('btn-undo').disabled = !(
      amPlaying && room.state === 'playing' && room.rules.undo &&
      room.turn === myColor && !room.undoReq && !room.drawOffer &&
      room.moves.some(m => m.c === (myColor === 'black' ? 1 : 2)));
    $('btn-draw').disabled = !(amPlaying && room.state === 'playing' && !room.drawOffer && !room.undoReq);
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
      (isMe ? ' · 你' : '') +
      (p && !p.connected ? ' · 断线' : '');
    const timer = card.querySelector('.ptimer');
    if (room.state === 'playing' && room.rules.timeLimit && active && room.deadline) {
      const remain = Math.max(0, (room.deadline - (Date.now() + S.serverOffset)) / 1000);
      timer.classList.remove('off');
      timer.classList.toggle('hot', remain <= 10);
      timer.textContent = Math.floor(remain / 60) + ':' + String(Math.floor(remain % 60)).padStart(2, '0');
    } else {
      timer.classList.add('off');
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

  // 每秒刷新倒计时
  setInterval(() => { if (S.room) { renderCard('card-black', 'black', S.room); renderCard('card-white', 'white', S.room); } }, 250);

  // ---------- 对话框响应 ----------
  function maybePromptRequests(prev, cur) {
    if (!prev) return cur;
    // 对方发来悔棋申请
    if (cur.undoReq && cur.undoReq !== cur.youColor && prev.undoReq !== cur.undoReq) {
      const who = (cur.players[cur.colors[cur.undoReq]] || {}).name || '对方';
      showModal('悔棋请求', who + ' 想撤销最后一手, 是否同意?', [
        { label: '拒绝', cls: 'ghost', cb: () => send({ t: 'undo_res', ok: false }) },
        { label: '同意', cb: () => send({ t: 'undo_res', ok: true }) }
      ]);
    }
    // 对方求和
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
    localStorage.setItem('gomoku.name', v);
    return v;
  }

  for (const seg of document.querySelectorAll('.seg')) {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
    });
  }

  $('name-input').value = localStorage.getItem('gomoku.name') || '';

  $('btn-create').onclick = () => {
    send({ t: 'create', name: myName(), rules: readRules() });
  };

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
    const ov = $('ov-wait');
    if (S.room && S.room.state !== 'waiting') toast('链接已复制 · 新好友打开可进入观战');
    else ov.classList.add('show');
  };

  $('btn-sound').onclick = () => {
    const on = Sound.toggle();
    $('btn-sound').textContent = on ? '🔊' : '🔇';
  };
  $('btn-sound').textContent = Sound.enabled ? '🔊' : '🔇';

  $('btn-exit').onclick = () => {
    const room = S.room;
    if (!room) return;
    if (room.state === 'playing' && room.youColor) {
      showModal('退出房间', '对局进行中, 退出将按认输处理。确定退出?', [
        { label: '继续对局', cls: 'ghost' },
        { label: '退出', cb: () => { send({ t: 'leave' }); leaveLocal(); } }
      ]);
    } else {
      send({ t: 'leave' });
      leaveLocal();
    }
  };

  $('btn-start').onclick = () => send({ t: 'start' });

  $('btn-undo').onclick = () => send({ t: 'undo_req' });

  $('btn-draw').onclick = () => {
    showModal('请求和棋', '向对方提议平局, 对方同意后本局作和。', [
      { label: '取消', cls: 'ghost' },
      { label: '发送请求', cb: () => send({ t: 'draw_req' }) }
    ]);
  };

  $('btn-resign').onclick = () => {
    showModal('确认认输', '认输后本局直接判负, 确定吗?', [
      { label: '再想想', cls: 'ghost' },
      { label: '认输', cb: () => send({ t: 'resign' }) }
    ]);
  };

  $('btn-rematch').onclick = () => send({ t: 'rematch' });
  $('btn-back-home').onclick = () => { send({ t: 'leave' }); leaveLocal(); };

  // 棋盘点击落子
  board.onTap = (x, y) => {
    const room = S.room;
    if (!room || room.state !== 'playing') return;
    if (!room.youColor || room.turn !== room.youColor) return;
    const n = room.rules.size;
    if (room.board[y * n + x] !== 0) { toast('这个位置已有棋子'); return; }
    if (room.rules.mode === 'renju' && room.youColor === 'black') {
      const f = GR.isForbiddenPoint(room.board.slice(), n, x, y);
      if (f) {
        const names = { overline: '长连禁手', 'double-four': '四四禁手', 'double-three': '三三禁手' };
        toast('禁手点: ' + (names[f] || f) + ', 黑棋不可落子');
        return;
      }
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
