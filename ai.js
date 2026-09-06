/*
 * 五子棋人机引擎 (零依赖, 前后端通用)
 *
 * bestMove(board, n, color, rules, level) -> {x, y}
 *   board: 长度 n*n 的数组 (0 空 / 1 黑 / 2 白)
 *   level: 'easy' | 'normal' | 'hard'
 *
 * 评分: 5 格滑窗法 — 对每个候选点统计穿过它的所有 5 连窗口内的我方子数,
 * 并以对手视角评分作为防守分量。
 * 难度:
 *   easy   贪心 + 噪声 (前 3 名随机)
 *   normal 贪心 (攻 1.0 + 防 0.9)
 *   hard   强制杀战术 (成五/双四/防双四, 均经反杀验证) + 1.5 层前瞻贪心
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules.js'));
  else root.GomokuAI = factory(root.GomokuRules);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  var BLACK = 1, WHITE = 2, EMPTY = 0;
  var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  // 滑窗权重: 窗口内我方棋子数 -> 分值
  var W = { 1: 2, 2: 24, 3: 360, 4: 5200, 5: 1000000 };

  function other(c) { return c === BLACK ? WHITE : BLACK; }

  // 候选点: 已有棋子切比雪夫距离 2 以内的空点; 空盘返回天元
  function candidates(board, n) {
    var seen = {}, out = [], hasStone = false;
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (board[y * n + x] === EMPTY) continue;
        hasStone = true;
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            var i = x + dx, j = y + dy;
            if (i < 0 || j < 0 || i >= n || j >= n) continue;
            var k = j * n + i;
            if (board[k] === EMPTY && !seen[k]) { seen[k] = 1; out.push({ x: i, y: j }); }
          }
        }
      }
    }
    if (!hasStone) return [{ x: (n >> 1), y: (n >> 1) }];
    return out;
  }

  // 以 color 视角评估在 (x,y) 落子的分值 (滑窗法, 4 方向 x 5 窗口)
  function pointScore(board, n, x, y, color) {
    var total = 0;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      for (var s = -4; s <= 0; s++) {
        var mine = 0, bad = 0;
        for (var o = s; o < s + 5; o++) {
          var i = x + dx * o, j = y + dy * o;
          if (i < 0 || j < 0 || i >= n || j >= n) { bad = 1; break; }
          var v = board[j * n + i];
          if (v === color) mine++;
          else if (v !== EMPTY) { bad = 1; break; }
        }
        if (!bad && mine > 0) total += W[mine] || 0;
      }
    }
    return total;
  }

  // 落子后是否连五 (走规则引擎, 兼容精确五连/禁手模式)
  function isWin(board, n, x, y, color, rules) {
    return R.checkWin(board, n, x, y, color, { mode: rules && rules.mode || 'free' }).win;
  }

  // 按启发式分值排序的候选列表
  function ranked(board, n, color, rules) {
    var opp = other(color);
    var list = candidates(board, n).map(function (c) {
      board[c.y * n + c.x] = color;
      var atk = pointScore(board, n, c.x, c.y, color);
      board[c.y * n + c.x] = EMPTY;
      // 防守分量: 假设对手在此落子
      board[c.y * n + c.x] = opp;
      var def = pointScore(board, n, c.x, c.y, opp);
      board[c.y * n + c.x] = EMPTY;
      var s = atk + def * 0.9;
      // 连珠规则: 黑棋禁手点直接排除
      if (rules && rules.mode === 'renju' && color === BLACK) {
        if (R.isForbiddenPoint(board, n, c.x, c.y)) s = -Infinity;
      }
      return { x: c.x, y: c.y, score: s, atk: atk, def: def };
    });
    list.sort(function (a, b) { return b.score - a.score; });
    return list;
  }

  // 在棋盘上找 color 的立即获胜点
  function winningSpot(board, n, color, rules, cands) {
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      board[c.y * n + c.x] = color;
      var win = isWin(board, n, c.x, c.y, color, rules);
      board[c.y * n + c.x] = EMPTY;
      if (win) return c;
    }
    return null;
  }

  // ---------- 强制杀搜索 (成五 / 双四) ----------

  // color 的全部成五点 (只需检查已有同色子 4 格射线内的空点)
  function findWins(board, n, color, rules) {
    var cands = {};
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (board[y * n + x] !== color) continue;
        for (var d = 0; d < DIRS.length; d++) {
          var dx = DIRS[d][0], dy = DIRS[d][1];
          for (var k = -4; k <= 4; k++) {
            if (k === 0) continue;
            var i = x + dx * k, j = y + dy * k;
            if (i < 0 || j < 0 || i >= n || j >= n) continue;
            if (board[j * n + i] === EMPTY) cands[j * n + i] = 1;
          }
        }
      }
    }
    var out = [];
    for (var key in cands) {
      var idx = Number(key);
      var cx = idx % n, cy = Math.floor(idx / n);
      board[idx] = color;
      if (isWin(board, n, cx, cy, color, rules)) out.push(idx);
      board[idx] = EMPTY;
    }
    return out;
  }

  // color 的全部"1 手杀"第一手: 落此点立即成五, 或形成双四 (两个成五点,
  // 且对手封堵任一成五点都不会反杀)。唯一性由调用方校验。
  function forcedWinFirsts(board, n, color, rules) {
    var defender = other(color);
    var out = [];
    var cands = candidates(board, n);
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      board[c.y * n + c.x] = color;
      var wins;
      if (isWin(board, n, c.x, c.y, color, rules)) {
        out.push(c.y * n + c.x);                    // 立即成五
      } else if ((wins = findWins(board, n, color, rules)).length >= 2) {
        // 双四必胜的前提: 对手封堵任一成五点都不会顺手形成对手自己的五连
        var unstoppable = true;
        for (var wi = 0; wi < wins.length && unstoppable; wi++) {
          board[wins[wi]] = defender;
          if (isWin(board, n, wins[wi] % n, Math.floor(wins[wi] / n), defender, rules)) unstoppable = false;
          board[wins[wi]] = EMPTY;
        }
        if (unstoppable) out.push(c.y * n + c.x);
      }
      board[c.y * n + c.x] = EMPTY;
    }
    return out;
  }

  // 暴力找防守点: 落子后让攻击方的 1 手杀全部消失; 找不到返回 null
  function bestDefense(board, n, attacker, rules) {
    var defender = other(attacker);
    var cands = candidates(board, n);
    for (var i = 0; i < cands.length; i++) {
      var d = cands[i];
      board[d.y * n + d.x] = defender;
      var still = forcedWinFirsts(board, n, attacker, rules);
      board[d.y * n + d.x] = EMPTY;
      if (still.length === 0) return d;
    }
    return null;
  }

  function bestMove(board, n, color, rules, level) {
    rules = rules || { mode: 'free' };
    var cands = candidates(board, n);
    if (!cands.length) return null;
    var renjuBlack = rules.mode === 'renju' && color === BLACK;

    // 1. 我方立即成五
    var winNow = winningSpot(board, n, color, rules, cands);
    if (winNow) return winNow;

    // 2. 对手立即成五 → 必须封堵
    var blockNow = winningSpot(board, n, other(color), rules, cands);
    if (blockNow) return blockNow;

    // 3. hard: 强制杀战术 + 1.5 层前瞻
    if (level === 'hard') {
      // 3a. 己方双四 (连珠规则黑棋双四属禁手, 跳过)
      if (!renjuBlack) {
        var myKills = forcedWinFirsts(board, n, color, rules);
        if (myKills.length) return { x: myKills[0] % n, y: Math.floor(myKills[0] / n) };
      }
      // 3b. 对手双四 → 暴力找防守点 (落子后对手强制杀清零)
      var opKills = forcedWinFirsts(board, n, other(color), rules);
      if (opKills.length) {
        var bd = bestDefense(board, n, other(color), rules);
        if (bd) return { x: bd.x, y: bd.y };
        // 无防守点 (败局) → 落入前瞻贪心
      }
      // 无强制杀 → 贪心 (与 normal 相同, 另加双四/防守战术已在前置分支处理)
    }
    // 4. normal / easy: 贪心
    var rankedList = ranked(board, n, color, rules);
    if (!rankedList.length) return cands[0];
    if (level === 'easy') {
      // 前 3 名里随机, 且叠加少量噪声
      var top = rankedList.slice(0, 3).filter(function (c) { return c.score > -Infinity; });
      top.forEach(function (c) { c.noise = Math.random() * c.score * 0.35; });
      top.sort(function (a, b) { return (b.score + b.noise) - (a.score + a.noise); });
      return { x: top[0].x, y: top[0].y };
    }
    return { x: rankedList[0].x, y: rankedList[0].y };
  }

  return { bestMove: bestMove, candidates: candidates, pointScore: pointScore, findWins: findWins, forcedWinFirsts: forcedWinFirsts };
});
