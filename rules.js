/*
 * 五子棋规则引擎 (服务端与浏览器共用)
 *
 * 棋盘: 一维数组, 长度 n*n; 0=空 1=黑 2=白; 索引 idx(x,y) = y*n + x
 *
 * 获胜规则 (rules.mode):
 *   free   自由规则 — 双方连五或长连(≥5)即胜
 *   exact  精确五连 — 黑棋须恰好五连(长连不算胜), 白棋 ≥5 即胜
 *   renju  连珠规则 — 黑棋禁手(三三/四四/长连, 禁手点不可落子), 黑棋恰好五连胜, 白棋 ≥5 即胜
 *
 * 禁手判定为递归实现: 判断活三时需验证其成活四的扩展点本身不是禁手点(假活三不算数)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GomokuRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EMPTY = 0, BLACK = 1, WHITE = 2;
  var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  function newBoard(n) { return new Int8Array(n * n); }
  function idx(x, y, n) { return y * n + x; }
  function inB(n, x, y) { return x >= 0 && x < n && y >= 0 && y < n; }

  // 经过 (x,y) 的同色连子总数(含 (x,y) 本身)
  function runCount(board, n, x, y, c, dx, dy) {
    var cnt = 1, i, j;
    for (i = x + dx, j = y + dy; inB(n, i, j) && board[idx(i, j, n)] === c; i += dx, j += dy) cnt++;
    for (i = x - dx, j = y - dy; inB(n, i, j) && board[idx(i, j, n)] === c; i -= dx, j -= dy) cnt++;
    return cnt;
  }

  // 落子后判定胜负。返回 {win, line(连子索引数组), count}
  function checkWin(board, n, x, y, c, rules) {
    var mode = (rules && rules.mode) || 'free';
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      var cnt = runCount(board, n, x, y, c, dx, dy);
      if (cnt < 5) continue;
      if (cnt > 5 && mode !== 'free' && c === BLACK) continue; // 黑棋长连不胜
      var line = [], i, j;
      for (i = x - dx, j = y - dy; inB(n, i, j) && board[idx(i, j, n)] === c; i -= dx, j -= dy);
      for (i += dx, j += dy; inB(n, i, j) && board[idx(i, j, n)] === c; i += dx, j += dy) line.push(idx(i, j, n));
      return { win: true, line: line, count: cnt };
    }
    return { win: false, line: null, count: 0 };
  }

  // ---- 禁手判定 (仅针对黑棋) ----
  // (x,y) 必须为空点。返回 false 或禁手类型字符串 'overline' | 'double-four' | 'double-three'
  function isForbiddenPoint(board, n, x, y) {
    if (!inB(n, x, y) || board[idx(x, y, n)] !== EMPTY) return false;
    board[idx(x, y, n)] = BLACK;
    var r;
    try {
      r = analyze(board, n, x, y, [idx(x, y, n)]);
    } finally {
      board[idx(x, y, n)] = EMPTY;
    }
    return r;
  }

  // 前提: (x,y) 已放置黑子。visited 为已分析点的索引数组(防循环)。
  function analyze(board, n, x, y, visited) {
    var counts = [0, 0, 0, 0], d;
    for (d = 0; d < 4; d++) counts[d] = runCount(board, n, x, y, BLACK, DIRS[d][0], DIRS[d][1]);

    for (d = 0; d < 4; d++) if (counts[d] === 5) return false;          // 成五即胜, 优先于一切禁手
    for (d = 0; d < 4; d++) if (counts[d] >= 6) return 'overline';

    if (countFours(board, n, x, y) >= 2) return 'double-four';
    if (countThrees(board, n, x, y, visited) >= 2) return 'double-three';
    return false;
  }

  // 统计落子形成的"四"的数量。活四(两端成五点)只算一个; 同向多个跳四各自算一个。
  function countFours(board, n, x, y) {
    var total = 0;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      var wins = {};       // 成五点 -> true
      var straight = false;
      for (var s = -4; s <= 0; s++) {          // 5 连窗口 [s, s+4], 均含落点(偏移 0)
        var blacks = 0, emptyOff = -99, ok = true;
        for (var o = s; o <= s + 4; o++) {
          var v = cellAt(board, n, x, y, dx, dy, o);
          if (v === BLACK) blacks++;
          else if (v === EMPTY) { if (emptyOff !== -99) { ok = false; break; } emptyOff = o; }
          else { ok = false; break; }
        }
        if (!ok || blacks !== 4) continue;
        // 窗口两端外侧不能是黑子(成五须恰好五连)
        if (cellAt(board, n, x, y, dx, dy, s - 1) === BLACK) continue;
        if (cellAt(board, n, x, y, dx, dy, s + 5) === BLACK) continue;
        wins[emptyOff] = true;
      }
      // 活四: 含落点的四连, 两端均为空且再外侧无黑子 → 两个成五点同属一个四
      for (var a = -3; a <= 0; a++) {
        var allBlack = true;
        for (var o2 = a; o2 <= a + 3; o2++) if (cellAt(board, n, x, y, dx, dy, o2) !== BLACK) { allBlack = false; break; }
        if (!allBlack) continue;
        if (cellAt(board, n, x, y, dx, dy, a - 1) !== EMPTY) continue;
        if (cellAt(board, n, x, y, dx, dy, a + 4) !== EMPTY) continue;
        if (cellAt(board, n, x, y, dx, dy, a - 2) === BLACK) continue;
        if (cellAt(board, n, x, y, dx, dy, a + 5) === BLACK) continue;
        straight = true; break;
      }
      total += straight ? 1 : Object.keys(wins).length;
    }
    return total;
  }

  // 统计落子形成的"活三"数量(按三的棋子集合去重)。
  // 活三 = 存在一个扩展点, 落子后成为活四; 且该扩展点本身不是禁手点(假活三)。
  function countThrees(board, n, x, y, visited) {
    var total = 0;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      var seen = {};
      for (var o = -4; o <= 4; o++) {
        if (o === 0) continue;
        var qx = x + dx * o, qy = y + dy * o;
        if (!inB(n, qx, qy) || board[idx(qx, qy, n)] !== EMPTY) continue;
        var qi = idx(qx, qy, n);
        board[idx(qx, qy, n)] = BLACK;
        try {
          var run = straightFourRun(board, n, x, y, dx, dy, o); // 成活四时返回 4 连子偏移区间起点
          if (run !== null) {
            // 三的棋子集合 = 四连子集合去掉扩展点(必含落点)
            var set = [];
            for (var o2 = run; o2 < run + 4; o2++) if (o2 !== o) set.push(idx(x + dx * o2, y + dy * o2, n));
            set.sort(function (a, b) { return a - b; });
            var key = set.join(',');
            if (!seen[key]) {
              seen[key] = true;
              var nv = visited.slice(); nv.push(qi);
              if (analyze(board, n, qx, qy, nv) === false) { /* 扩展点合法, 该三成立 */ }
              else seen[key] = false; // 扩展点为禁手 → 假活三
            }
          }
        } finally {
          board[idx(qx, qy, n)] = EMPTY;
        }
      }
      var cnt = 0;
      for (var k in seen) if (seen[k]) cnt++;
      total += cnt;
    }
    return total;
  }

  // 判断放置扩展点(偏移 o)后, 是否在 (dx,dy) 方向形成含落点的活四。
  // 活四: 四连子两端为空, 且两端再外侧无黑子(两端填子均可恰好成五)。
  function straightFourRun(board, n, x, y, dx, dy, o) {
    for (var a = -3; a <= 0; a++) {
      if (o < a || o > a + 3) continue;               // 扩展点须在这四子之中
      var allBlack = true;
      for (var o2 = a; o2 <= a + 3; o2++) {
        var v = o2 === 0 ? BLACK : cellAt(board, n, x, y, dx, dy, o2);
        if (v !== BLACK) { allBlack = false; break; }
      }
      if (!allBlack) continue;
      if (cellAt(board, n, x, y, dx, dy, a - 1) !== EMPTY) continue;
      if (cellAt(board, n, x, y, dx, dy, a + 4) !== EMPTY) continue;
      if (cellAt(board, n, x, y, dx, dy, a - 2) === BLACK) continue;
      if (cellAt(board, n, x, y, dx, dy, a + 5) === BLACK) continue;
      return a;
    }
    return null;
  }

  // 取 (x,y) 沿方向的偏移 o 处的值; 出界返回 -1
  function cellAt(board, n, x, y, dx, dy, o) {
    var i = x + dx * o, j = y + dy * o;
    if (!inB(n, i, j)) return -1;
    return board[idx(i, j, n)];
  }

  // 扫描全部黑棋禁手点(供 UI 标记)
  function forbiddenPoints(board, n) {
    var out = [];
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (board[idx(x, y, n)] !== EMPTY) continue;
        var r = isForbiddenPoint(board, n, x, y);
        if (r) out.push({ x: x, y: y, reason: r });
      }
    }
    return out;
  }

  return {
    EMPTY: EMPTY, BLACK: BLACK, WHITE: WHITE,
    DIRS: DIRS,
    newBoard: newBoard,
    idx: idx,
    runCount: runCount,
    checkWin: checkWin,
    isForbiddenPoint: isForbiddenPoint,
    forbiddenPoints: forbiddenPoints
  };
});
