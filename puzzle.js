/*
 * 残局挑战 关卡生成器 v2 (确定性: 同一关永远同一题)
 *
 * 难度阶梯:
 *   L1      win      致胜一子   — 落子连五 (热身)
 *   L2      block    化解杀着   — 堵住对手的成五点 (热身)
 *   L3-5    double4  一子双杀   — 找到同时形成两个四的杀着, 对手无法兼顾
 *   L6+     vcf      连续冲四   — 每手都必须冲四/成五, 逼对手就范 (深度随关卡递增)
 *
 * 核心求解器 forcedWin(depth): 只允许"冲四/成五"这类强制手,
 * 对手应手唯一 (必须挡), 可证明先手必胜。返回所有合法"第一手"。
 * 解题要求第一手唯一 → 题目严谨。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules.js'));
  else root.GomokuPuzzle = factory(root.GomokuRules);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  var N = 9, EMPTY = 0, BLACK = 1, WHITE = 2;
  var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function other(c) { return c === BLACK ? WHITE : BLACK; }

  // color 的全部成五点 (只需检查已有同色子 4 格射线内的空点 — 成五点旁必有同色子)
  function findWins(board, color) {
    var cands = {};
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        if (board[y * N + x] !== color) continue;
        for (var d = 0; d < 4; d++) {
          var dx = DIRS[d][0], dy = DIRS[d][1];
          for (var k = -4; k <= 4; k++) {           // 双向扫描, k=0 是棋子本身
            if (k === 0) continue;
            var i = x + dx * k, j = y + dy * k;
            if (i < 0 || j < 0 || i >= N || j >= N) continue;
            if (board[j * N + i] === EMPTY) cands[j * N + i] = 1;
          }
        }
      }
    }
    var out = [];
    for (var key in cands) {
      var idx = Number(key);
      var cx = idx % N, cy = Math.floor(idx / N);
      board[idx] = color;
      if (R.checkWin(board, N, cx, cy, color, { mode: 'free' }).win) out.push(idx);
      board[idx] = EMPTY;
    }
    return out;
  }

  /*
   * 先手必胜搜索 (只走强制手): 返回所有能引出必胜路线的"第一手"
   * depth = 还允许的先手手数 (冲四算一手; 成五立即胜)
   * 前提: 轮到 color, 且对手当前没有成五点 (否则先手杀不成立)
   */
  function forcedWin(board, color, depth) {
    var defender = other(color);
    if (depth <= 0) return [];
    if (findWins(board, defender).length > 0) return []; // 对手有杀, 先手不成立

    var out = [];
    var tried = {};
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var i = y * N + x;
        if (board[i] !== EMPTY || tried[i]) continue;
        board[i] = color;
        // 立即成五
        if (R.checkWin(board, N, x, y, color, { mode: 'free' }).win) {
          out.push(i); board[i] = EMPTY; continue;
        }
        var wins = findWins(board, color);
        if (wins.length >= 2) {
          out.push(i); board[i] = EMPTY; continue;   // 双四, 无解
        }
        if (wins.length === 1 && depth >= 2) {
          var w = wins[0];
          board[w] = defender;                        // 对手被迫封堵
          if (!R.checkWin(board, N, w % N, Math.floor(w / N), defender, { mode: 'free' }).win) {
            // 封堵没有顺手给对手成五 → 继续搜
            if (forcedWin(board, color, depth - 1).length > 0) out.push(i);
          }
          board[w] = EMPTY;
        }
        board[i] = EMPTY;
      }
    }
    return out;
  }

  // 摆一条四连 (含一个被堵死的端点)
  function placeFour(board, rng, color) {
    for (var attempt = 0; attempt < 60; attempt++) {
      var d = DIRS[Math.floor(rng() * 4)];
      var dx = d[0], dy = d[1];
      var sx, sy, ok = false, tries = 0;
      while (!ok && tries++ < 40) {
        sx = Math.floor(rng() * N); sy = Math.floor(rng() * N);
        var ex = sx + dx * 4, ey = sy + dy * 4;
        var bx = sx - dx, by = sy - dy;
        if (ex < 0 || ex >= N || ey < 0 || ey >= N) continue;
        if (bx < 0 || bx >= N || by < 0 || by >= N) continue;
        ok = true;
      }
      if (!ok) continue;
      var cells = [], blocked = null, clear = true;
      for (var i = -1; i <= 4; i++) {
        var x = sx + dx * i, y = sy + dy * i;
        if (board[y * N + x] !== EMPTY) { clear = false; break; }
      }
      if (!clear) continue;
      for (i = 0; i <= 3; i++) cells.push([sx + dx * i, sy + dy * i]);
      blocked = [sx - dx, sy - dy];
      return { cells: cells, blocked: blocked };
    }
    return null;
  }

  // ---------- 各题型构造 ----------
  function buildWarmup(level, rng) {
    var type = level === 1 ? 'win' : 'block';
    var fourOwner = type === 'win' ? ((level % 4 === 1) ? BLACK : WHITE)
                                   : ((level % 4 === 2) ? BLACK : WHITE);
    var mover = type === 'win' ? fourOwner : other(fourOwner);
    for (var att = 0; att < 300; att++) {
      var board = new Array(N * N).fill(0);
      var four = placeFour(board, rng, fourOwner);
      if (!four) continue;
      for (var i = 0; i < four.cells.length; i++) board[four.cells[i][1] * N + four.cells[i][0]] = fourOwner;
      board[four.blocked[1] * N + four.blocked[0]] = other(fourOwner);
      var noise = 2 + Math.floor(rng() * 3);
      for (var k = 0; k < noise; k++) {
        var x = Math.floor(rng() * N), y = Math.floor(rng() * N);
        var far = true;
        for (var j = 0; j < four.cells.length; j++) {
          if (Math.abs(four.cells[j][0] - x) <= 1 && Math.abs(four.cells[j][1] - y) <= 1) far = false;
        }
        if (Math.abs(four.blocked[0] - x) <= 1 && Math.abs(four.blocked[1] - y) <= 1) far = false;
        if (!far || board[y * N + x] !== EMPTY) continue;
        board[y * N + x] = rng() < 0.5 ? BLACK : WHITE;
      }
      var ownerWins = findWins(board, fourOwner);
      if (ownerWins.length !== 1) continue;
      if (type === 'block' && findWins(board, mover).length !== 0) continue;
      return {
        n: N, board: board.slice(), color: mover, type: type,
        solution: ownerWins[0], fourOwner: fourOwner, depth: 1
      };
    }
    return null;
  }

  // 一子双杀: 交点 p 落子后同时形成两条线上的四 (各自恰好一个成五点)
  function buildDouble4(level, rng) {
    var fourOwner = (level % 4 === 3) ? BLACK : WHITE;
    var mover = fourOwner;
    for (var att = 0; att < 300; att++) {
      var board = new Array(N * N).fill(0);
      var px = 2 + Math.floor(rng() * (N - 4));
      var py = 2 + Math.floor(rng() * (N - 4));
      var d1 = DIRS[Math.floor(rng() * 4)];
      var d2 = DIRS[Math.floor(rng() * 4)];
      if (d1[0] === d2[0] && d1[1] === d2[1]) continue;
      // 同轴 (d2 = -d1) 也排除
      if (d1[0] === -d2[0] && d1[1] === -d2[1]) continue;
      var ok = true;
      var involved = [[px, py]];
      // 两条线: 正方向三子 + 反方向堵一子 + 正方向第 4 格为成五点
      for (const d of [d1, d2]) {
        for (var i = 1; i <= 4; i++) {
          var x = px + d[0] * i, y = py + d[1] * i;
          if (x < 0 || y < 0 || x >= N || y >= N) { ok = false; break; }
        }
        var bx = px - d[0], by = py - d[1];
        if (bx < 0 || by < 0 || bx >= N || by >= N) ok = false;
        if (!ok) break;
      }
      if (!ok) continue;
      // 占位: 交点先空着; 两条线各放 3 子 (正方向 1..3), 反方向 1 格放对手子
      for (const d of [d1, d2]) {
        for (i = 1; i <= 3; i++) {
          var xi = px + d[0] * i, yi = py + d[1] * i;
          if (board[yi * N + xi] !== EMPTY) { ok = false; break; }
          board[yi * N + xi] = fourOwner;
        }
        if (!ok) break;
        var xb = px - d[0], yb = py - d[1];
        if (board[yb * N + xb] !== EMPTY) { ok = false; break; }
        board[yb * N + xb] = other(fourOwner);
      }
      if (!ok) continue;
      // 散子远离
      var noise = 2 + Math.floor(rng() * 2);
      for (var k = 0; k < noise; k++) {
        var x2 = Math.floor(rng() * N), y2 = Math.floor(rng() * N);
        var far = true;
        for (var j = 0; j < involved.length; j++) {
          if (Math.abs(involved[j][0] - x2) <= 1 && Math.abs(involved[j][1] - y2) <= 1) far = false;
        }
        if (!far || board[y2 * N + x2] !== EMPTY) continue;
        board[y2 * N + x2] = rng() < 0.5 ? BLACK : WHITE;
      }
      // 验证: 落 p 后形成双四, 且第一手唯一
      board[py * N + px] = fourOwner;
      var wins = findWins(board, fourOwner);
      if (wins.length < 2) { board[py * N + px] = EMPTY; continue; }
      board[py * N + px] = EMPTY;
      var firsts = forcedWin(board, fourOwner, 1);
      if (firsts.length !== 1 || firsts[0] !== py * N + px) continue;
      return {
        n: N, board: board.slice(), color: mover, type: 'double4',
        solution: py * N + px, fourOwner: fourOwner, depth: 1
      };
    }
    return null;
  }

  // 连续冲四: 自模拟一局 → 搜索两手杀 VCF (冲四 → 对手挡 → 双四/成五), 第一手唯一
  function buildVCF(level, rng) {
    var depth = 2;
    var mover = (level % 4 === 2) ? BLACK : WHITE;
    for (var att = 0; att < 160; att++) {
      var board = new Array(N * N).fill(0);
      // 自模拟: 交替落子制造自然的交叠棋形
      var stones = 0;
      var first = [Math.floor(N / 2), Math.floor(N / 2)];
      board[first[1] * N + first[0]] = rng() < 0.5 ? BLACK : WHITE;
      stones++;
      var guard = 0;
      while (stones < 6 + Math.floor(rng() * 6) && guard++ < 200) {
        var x = Math.floor(rng() * N), y = Math.floor(rng() * N);
        if (board[y * N + x] !== EMPTY) continue;
        // 靠近已有棋子
        var near = false;
        for (var yy = y - 2; yy <= y + 2; yy++) {
          for (var xx = x - 2; xx <= x + 2; xx++) {
            if (yy < 0 || xx < 0 || yy >= N || xx >= N) continue;
            if (board[yy * N + xx] !== EMPTY) near = true;
          }
        }
        if (!near) continue;
        board[y * N + x] = stones % 2 === 0 ? mover : other(mover);
        stones++;
      }
      if (findWins(board, other(mover)).length > 0) continue; // 对手不能有杀
      var firsts = forcedWin(board, mover, depth);
      if (firsts.length !== 1) continue;
      // 该位置不应有更浅的杀 (保证难度名副其实)
      if (forcedWin(board, mover, depth - 1).length > 0) continue;
      return {
        n: N, board: board.slice(), color: mover, type: 'vcf',
        solution: firsts[0], fourOwner: mover, depth: depth
      };
    }
    return null;
  }

  function fallbackPuzzle(level) {
    var type = level % 2 === 1 ? 'win' : 'block';
    var fourOwner = type === 'win' ? ((level % 4 === 1) ? BLACK : WHITE)
                                   : ((level % 4 === 2) ? BLACK : WHITE);
    var mover = type === 'win' ? fourOwner : other(fourOwner);
    var board = new Array(N * N).fill(0);
    var y = 4, sx = 3;
    for (var i = 0; i < 4; i++) board[y * N + sx + i] = fourOwner;
    board[y * N + sx - 1] = other(fourOwner);
    return { n: N, board: board, color: mover, type: type, solution: y * N + sx + 4, fourOwner: fourOwner, depth: 1 };
  }

  function generate(level) {
    var builders;
    if (level === 1) builders = [function (r) { return buildWarmup(1, r); }];
    else if (level === 2) builders = [function (r) { return buildWarmup(2, r); }];
    else if (level <= 5) builders = [function (r) { return buildDouble4(level, r); }];
    else builders = [function (r) { return buildVCF(level, r); }, function (r) { return buildDouble4(level, r); }];

    for (var b = 0; b < builders.length; b++) {
      for (var s = 0; s < 120; s++) {
        var p = builders[b](mulberry32(level * 7919 + 13 + s * 104729 + b * 31));
        if (p) return p;
      }
    }
    return fallbackPuzzle(level);
  }

  return { generate: generate, findWins: findWins, forcedWin: forcedWin, N: N };
});
