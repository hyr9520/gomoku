/*
 * 棋盘渲染 (Canvas)
 * 木纹棋盘 + 立体棋子 + 落子动画 + 胜利高亮 + 禁手标记
 */
(function () {
  'use strict';

  // 固定种子伪随机 (保证木纹每次重绘一致)
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function starPoints(n) {
    if (n === 13) return [[3, 3], [9, 3], [3, 9], [9, 9], [6, 6]];
    if (n === 15) return [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]];
    return [[3, 3], [9, 3], [15, 3], [3, 9], [9, 9], [15, 9], [3, 15], [9, 15], [15, 15]];
  }

  class GomokuBoard {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.n = 15;
      this.board = null;          // Uint8Array
      this.lastMove = null;       // {x, y}
      this.winLine = null;        // [idx]
      this.forbidden = [];        // [{x, y}]
      this.myTurn = false;
      this.myColor = 'black';
      this.hover = null;          // {x, y}
      this.anims = new Map();     // idx -> {start}
      this.pulseStart = 0;
      this.onTap = null;
      this._raf = null;

      canvas.addEventListener('pointerdown', (e) => this._pick(e, true));
      canvas.addEventListener('pointermove', (e) => this._pick(e, false));
      canvas.addEventListener('pointerleave', () => { this.hover = null; this._requestFrame(); });
      window.addEventListener('resize', () => this._resize());
      if (window.ResizeObserver) new ResizeObserver(() => this._resize()).observe(canvas.parentElement || canvas);
    }

    setRules(size) {
      if (this.n !== size) { this.n = size; this._woodCache = null; }
      this._resize();
    }

    // room: 服务端快照
    update(room, opts) {
      opts = opts || {};
      if (!room.board) { this.board = null; this._requestFrame(); return; }
      this.n = room.rules.size;
      this.board = room.board;
      const lastM = room.moves[room.moves.length - 1];
      this.lastMove = lastM ? { x: lastM.x, y: lastM.y } : null;
      if (this.lastMove && (!this._lastRendered || this._lastRendered !== room.moves.length)) {
        this.anims.set(GomokuRules.idx(lastM.x, lastM.y, this.n), { start: performance.now() });
        Sound.play('place');
      }
      this._lastRendered = room.moves.length;
      this.winLine = room.winLine;
      if (room.winLine && !this.pulseStart) this.pulseStart = performance.now();
      if (!room.winLine) this.pulseStart = 0;
      this.myTurn = !!opts.myTurn;
      this.myColor = opts.myColor || 'black';
      this.forbidden = opts.forbidden || [];
      this._resize();
      this._requestFrame();
    }

    clear() {
      this.board = null; this.lastMove = null; this.winLine = null;
      this.forbidden = []; this.anims.clear(); this.pulseStart = 0;
      this._lastRendered = 0;
      this._requestFrame();
    }

    // ---------- 布局 ----------
    _resize() {
      const wrap = this.canvas.parentElement;
      if (!wrap) return;
      const availW = wrap.clientWidth || 300;
      const availH = wrap.clientHeight || 300;
      const side = Math.max(240, Math.min(availW, availH));
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const px = Math.round(side * dpr);
      if (this.canvas.width !== px || this.canvas.height !== px) {
        this.canvas.width = px;
        this.canvas.height = px;
        this.canvas.style.width = side + 'px';
        this.canvas.style.height = side + 'px';
        this._woodCache = null;
      }
      this.dpr = dpr;
      this._requestFrame();
    }

    _geometry() {
      const px = this.canvas.width;
      const margin = Math.round(px * 0.055);
      const cell = (px - margin * 2) / (this.n - 1);
      return { margin, cell };
    }

    _xyFromEvent(e) {
      const rect = this.canvas.getBoundingClientRect();
      const scale = this.canvas.width / rect.width;
      const px = (e.clientX - rect.left) * scale;
      const py = (e.clientY - rect.top) * scale;
      const { margin, cell } = this._geometry();
      const gx = Math.round((px - margin) / cell);
      const gy = Math.round((py - margin) / cell);
      if (gx < 0 || gy < 0 || gx >= this.n || gy >= this.n) return null;
      // 距离交点太远不认
      const dx = px - (margin + gx * cell), dy = py - (margin + gy * cell);
      if (Math.hypot(dx, dy) > cell * 0.52) return null;
      return { x: gx, y: gy };
    }

    _pick(e, isDown) {
      if (!this.board) return;
      const p = this._xyFromEvent(e);
      if (!isDown) {
        if (JSON.stringify(p) !== JSON.stringify(this.hover)) {
          this.hover = p;
          this._requestFrame();
        }
        return;
      }
      if (p && this.onTap) this.onTap(p.x, p.y);
    }

    _requestFrame() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this._draw(); });
    }

    // ---------- 绘制 ----------
    _wood() {
      if (this._woodCache) return this._woodCache;
      const px = this.canvas.width;
      const off = document.createElement('canvas');
      off.width = px; off.height = px;
      const c = off.getContext('2d');
      const g = c.createLinearGradient(0, 0, px * 0.15, px);
      g.addColorStop(0, '#edca8b');
      g.addColorStop(0.5, '#e2b878');
      g.addColorStop(1, '#d3a25f');
      c.fillStyle = g;
      c.fillRect(0, 0, px, px);

      // 木纹
      const rnd = mulberry32(20260905);
      c.lineCap = 'round';
      for (let i = 0; i < 42; i++) {
        const y0 = rnd() * px;
        const amp = px * (0.004 + rnd() * 0.012);
        const dark = rnd() < 0.22;
        c.strokeStyle = dark ? 'rgba(122,84,38,0.14)' : 'rgba(255,235,200,0.10)';
        c.lineWidth = px * (dark ? 0.0022 : 0.0016);
        c.beginPath();
        for (let x = 0; x <= px; x += px / 24) {
          const y = y0 + Math.sin(x / px * 6.3 + i * 1.7) * amp + Math.sin(x / px * 23 + i) * amp * 0.35;
          if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.stroke();
      }
      // 两个木节
      for (let k = 0; k < 2; k++) {
        const kx = px * (0.2 + rnd() * 0.6), ky = px * (0.15 + rnd() * 0.7);
        for (let r = 1; r < 5; r++) {
          c.strokeStyle = 'rgba(120,80,36,' + (0.05 - r * 0.008) + ')';
          c.lineWidth = px * 0.0015;
          c.beginPath();
          c.ellipse(kx, ky, r * px * 0.011, r * px * 0.007, rnd() * 3, 0, Math.PI * 2);
          c.stroke();
        }
      }
      // 内边框
      const { margin, cell } = this._geometry();
      c.strokeStyle = 'rgba(90,58,24,0.55)';
      c.lineWidth = Math.max(1, px * 0.004);
      c.strokeRect(margin - cell * 0.02, margin - cell * 0.02, cell * (this.n - 1) + cell * 0.04, cell * (this.n - 1) + cell * 0.04);
      this._woodCache = off;
      return off;
    }

    _draw() {
      const ctx = this.ctx;
      const px = this.canvas.width;
      if (!px) { this._requestFrame(); return; }
      ctx.clearRect(0, 0, px, px);
      ctx.drawImage(this._wood(), 0, 0);

      if (!this.board) { return; }
      const { margin, cell } = this._geometry();
      const r = cell * 0.44;

      // 网格
      ctx.strokeStyle = 'rgba(74,46,16,0.8)';
      ctx.lineWidth = Math.max(1, px * 0.0016);
      ctx.beginPath();
      for (let i = 0; i < this.n; i++) {
        const p = margin + i * cell;
        ctx.moveTo(margin, p); ctx.lineTo(px - margin, p);
        ctx.moveTo(p, margin); ctx.lineTo(p, px - margin);
      }
      ctx.stroke();
      // 外框加粗
      ctx.lineWidth = Math.max(1.5, px * 0.003);
      ctx.strokeRect(margin, margin, cell * (this.n - 1), cell * (this.n - 1));

      // 星位
      ctx.fillStyle = 'rgba(74,46,16,0.9)';
      for (const [sx, sy] of starPoints(this.n)) {
        ctx.beginPath();
        ctx.arc(margin + sx * cell, margin + sy * cell, Math.max(2, cell * 0.075), 0, Math.PI * 2);
        ctx.fill();
      }

      // 禁手标记
      for (const f of this.forbidden) {
        const cx = margin + f.x * cell, cy = margin + f.y * cell;
        const s = r * 0.5;
        ctx.strokeStyle = 'rgba(200,50,40,0.9)';
        ctx.lineWidth = Math.max(1.5, px * 0.0035);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s);
        ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s);
        ctx.stroke();
      }

      // 胜利线底光
      if (this.winLine && this.winLine.length) {
        const t = (performance.now() - this.pulseStart) / 1000;
        const a = 0.55 + 0.35 * Math.sin(t * 3.2);
        const p1 = this.winLine[0], p2 = this.winLine[this.winLine.length - 1];
        const x1 = margin + (p1 % this.n) * cell, y1 = margin + Math.floor(p1 / this.n) * cell;
        const x2 = margin + (p2 % this.n) * cell, y2 = margin + Math.floor(p2 / this.n) * cell;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,208,90,' + a.toFixed(3) + ')';
        ctx.lineWidth = r * 0.26;
        ctx.lineCap = 'round';
        ctx.shadowColor = 'rgba(255,190,60,0.9)';
        ctx.shadowBlur = r * 0.9;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.restore();
      }

      // 棋子
      const now = performance.now();
      for (let y = 0; y < this.n; y++) {
        for (let x = 0; x < this.n; x++) {
          const v = this.board[y * this.n + x];
          if (!v) continue;
          const idx = y * this.n + x;
          const cx = margin + x * cell, cy = margin + y * cell;
          let scale = 1;
          const anim = this.anims.get(idx);
          if (anim) {
            const t = (now - anim.start) / 170;
            if (t >= 1) this.anims.delete(idx);
            else {
              const e = 1 - Math.pow(1 - t, 3);         // easeOutCubic
              scale = 1.35 - 0.35 * e;
            }
          }
          this._stone(ctx, cx, cy, r * scale, v === 1);
          // 最后一手标记
          if (this.lastMove && this.lastMove.x === x && this.lastMove.y === y) {
            ctx.fillStyle = 'rgba(230,70,45,0.95)';
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(1.5, r * 0.16), 0, Math.PI * 2);
            ctx.fill();
          }
          // 胜利五子描金圈
          if (this.winLine && this.winLine.indexOf(idx) !== -1) {
            const t = (performance.now() - this.pulseStart) / 1000;
            ctx.strokeStyle = 'rgba(255,215,120,' + (0.7 + 0.3 * Math.sin(t * 3.2)).toFixed(3) + ')';
            ctx.lineWidth = Math.max(1.5, r * 0.09);
            ctx.beginPath(); ctx.arc(cx, cy, r * 1.02, 0, Math.PI * 2); ctx.stroke();
          }
        }
      }
      if (this.anims.size || this.winLine) this._requestFrame();

      // 悬停预览
      if (this.hover && this.myTurn && this.board[this.hover.y * this.n + this.hover.x] === 0) {
        const cx = margin + this.hover.x * cell, cy = margin + this.hover.y * cell;
        ctx.globalAlpha = 0.45;
        this._stone(ctx, cx, cy, r, this.myColor === 'black');
        ctx.globalAlpha = 1;
      }
    }

    _stone(ctx, cx, cy, r, isBlack) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.4)';
      ctx.shadowBlur = r * 0.5;
      ctx.shadowOffsetY = r * 0.18;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      const g = ctx.createRadialGradient(cx - r * 0.38, cy - r * 0.42, r * 0.1, cx, cy, r * 1.05);
      if (isBlack) {
        g.addColorStop(0, '#8d8d8d');
        g.addColorStop(0.35, '#3d3d3d');
        g.addColorStop(1, '#000');
      } else {
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.5, '#efefef');
        g.addColorStop(1, '#c6c6c6');
      }
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();
      if (!isBlack) {
        ctx.strokeStyle = 'rgba(0,0,0,0.12)';
        ctx.lineWidth = Math.max(0.6, r * 0.045);
        ctx.beginPath(); ctx.arc(cx, cy, r - 0.3, 0, Math.PI * 2); ctx.stroke();
      }
      // 高光
      ctx.beginPath();
      ctx.ellipse(cx - r * 0.32, cy - r * 0.38, r * 0.3, r * 0.18, -0.7, 0, Math.PI * 2);
      ctx.fillStyle = isBlack ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.85)';
      ctx.fill();
    }
  }

  window.GomokuBoard = GomokuBoard;
})();
