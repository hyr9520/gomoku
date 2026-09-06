/*
 * 棋盘渲染 v2 (Canvas)
 *
 * 美术: 多层木纹 + 木节 + 漆面反光 + 暗角 + 立体厚度边; 写实棋子
 * (双高光/底部环境反光/随机高光角度/接触阴影); 坐标标注;
 * 互动: 落子回弹动画 / 点击涟漪 / 待确认子(半透明) / 胜利金线流光 + 彩带
 * 性能: 木纹层离屏缓存, 仅在需要动画时运行 rAF
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

  const COLS = 'ABCDEFGHJKLMNOP'; // 跳过 I (围棋惯例)
  function easeOutBack(t) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  class GomokuBoard {
    constructor(canvas, fxCanvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.fx = fxCanvas || null;         // 特效层 (彩带), pointer-events:none
      this.fxCtx = this.fx ? this.fx.getContext('2d') : null;
      this.n = 15;
      this.board = null;
      this.lastMove = null;
      this.winLine = null;
      this.forbidden = [];
      this.myTurn = false;
      this.myColor = 'black';
      this.hover = null;
      this.pending = [];                  // [{idx, color}] 待服务器确认的落子
      this.anims = new Map();             // idx -> {start}
      this.ripples = [];                  // [{x, y, start}]
      this.confetti = [];
      this.pulseStart = 0;
      this.celebrated = false;
      this.onTap = null;
      this._raf = null;
      this._woodKey = '';
      this.woodSeed = 20260905;   // 每局可换"木料", 同局纹理一致
      this.hint = null;           // {x, y, until} 残局提示标记
      this.alert = null;          // {cells:[idx], start, until, color} 威胁跳动提醒

      canvas.addEventListener('pointerdown', (e) => this._onDown(e));
      canvas.addEventListener('pointermove', (e) => this._onMove(e));
      canvas.addEventListener('pointerleave', () => { this.hover = null; this._requestFrame(); });
      window.addEventListener('resize', () => this._resize());
      if (window.ResizeObserver) new ResizeObserver(() => this._resize()).observe(canvas.parentElement || canvas);
    }

    setRules(size) {
      if (this.n !== size) { this.n = size; this._woodKey = ''; }
      this._resize();
    }

    // 更换"木料" (不同房间/关卡呈现不同色泽与纹理)
    setWoodSeed(seed) {
      seed = seed | 0;
      if (this.woodSeed !== seed) { this.woodSeed = seed; this._woodKey = ''; this._requestFrame(); }
    }

    celebrate() {
      this._spawnConfetti();
      this._requestFrame();
    }

    // room: 服务端/本地快照; opts: {myTurn, myColor, forbidden, pending, hint:{x,y}}
    update(room, opts) {
      opts = opts || {};
      if (!room.board) { this.board = null; this._requestFrame(); return; }
      this.n = room.rules.size;
      this.board = room.board;
      const lastM = room.moves[room.moves.length - 1];
      this.lastMove = lastM ? { x: lastM.x, y: lastM.y } : null;
      if (this.lastMove && this._lastRendered !== room.moves.length) {
        this.anims.set(GomokuRules.idx(lastM.x, lastM.y, this.n), { start: performance.now() });
        if (this._lastRendered !== undefined) Sound.play('place');
      }
      this._lastRendered = room.moves.length;
      this.winLine = room.winLine;
      if (room.winLine && !this.pulseStart) this.pulseStart = performance.now();
      if (!room.winLine) { this.pulseStart = 0; this.celebrated = false; }
      this.myTurn = !!opts.myTurn;
      this.myColor = opts.myColor || 'black';
      this.forbidden = opts.forbidden || [];
      this.pending = opts.pending || [];
      this.alert = opts.alert || null;
      if (opts.hint) this.hint = { x: opts.hint.x, y: opts.hint.y, until: performance.now() + 2600 };
      this._resize();
      this._requestFrame();
    }

    clear() {
      this.board = null; this.lastMove = null; this.winLine = null;
      this.forbidden = []; this.pending = []; this.anims.clear();
      this.ripples = []; this.confetti = []; this.pulseStart = 0;
      this.celebrated = false; this._lastRendered = undefined; this.alert = null;
      this.hover = null;
      this._clearFx();
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
        if (this.fx) {
          this.fx.width = px; this.fx.height = px;
          this.fx.style.width = side + 'px'; this.fx.style.height = side + 'px';
        }
        this._woodKey = '';
      }
      this.dpr = dpr;
      this._requestFrame();
    }

    _geometry() {
      const px = this.canvas.width;
      const margin = Math.round(px * 0.06);
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
      const dx = px - (margin + gx * cell), dy = py - (margin + gy * cell);
      if (Math.hypot(dx, dy) > cell * 0.52) return null;
      return { x: gx, y: gy };
    }

    _onMove(e) {
      if (!this.board) return;
      const p = this._xyFromEvent(e);
      if (JSON.stringify(p) !== JSON.stringify(this.hover)) {
        this.hover = p;
        this._requestFrame();
      }
    }

    _onDown(e) {
      if (!this.board) return;
      const p = this._xyFromEvent(e);
      if (p) {
        // 点击涟漪 (视口坐标 -> 画布坐标)
        const rect = this.canvas.getBoundingClientRect();
        const scale = this.canvas.width / rect.width;
        this.ripples.push({
          x: (e.clientX - rect.left) * scale,
          y: (e.clientY - rect.top) * scale,
          start: performance.now()
        });
        this._requestFrame();
        if (this.onTap) this.onTap(p.x, p.y);
      }
    }

    _requestFrame() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this._draw(); });
    }

    // ---------- 木纹层 (离屏缓存) ----------
    _wood() {
      const key = this.canvas.width + 'x' + this.n;
      if (this._woodKey === key && this._woodCache) return this._woodCache;
      const px = this.canvas.width;
      const off = document.createElement('canvas');
      off.width = px; off.height = px;
      const c = off.getContext('2d');
      const { margin, cell } = this._geometry();
      const th = Math.max(3, px * 0.014);          // 棋盘厚度

      // 1. 基底渐变 (木料色泽随种子变化)
      const palettes = [
        ['#f2dcab', '#e6c284', '#d8ad6c', '#c89a55'],   // 暖黄桦木
        ['#eedcc9', '#dfc19a', '#d1ab78', '#bd9254'],   // 浅色枫木
        ['#e9d49b', '#d9b874', '#c9a05e', '#b8894a']    // 深色柚木
      ];
      const pal = palettes[this.woodSeed % 3];
      const rnd = mulberry32(this.woodSeed);
      const g = c.createLinearGradient(px * 0.1, 0, px * 0.9, px);
      g.addColorStop(0, pal[0]);
      g.addColorStop(0.35, pal[1]);
      g.addColorStop(0.7, pal[2]);
      g.addColorStop(1, pal[3]);
      c.fillStyle = g;
      c.fillRect(0, 0, px, px);

      // 2. 宽木纹带 (缓曲线, 半透明深棕)
      c.lineCap = 'round';
      for (let i = 0; i < 9; i++) {
        const y0 = rnd() * px;
        const amp = px * (0.006 + rnd() * 0.016);
        c.strokeStyle = 'rgba(140,96,44,' + (0.05 + rnd() * 0.05).toFixed(3) + ')';
        c.lineWidth = px * (0.004 + rnd() * 0.008);
        c.beginPath();
        for (let x = 0; x <= px; x += px / 26) {
          const y = y0 + Math.sin(x / px * 5.1 + i * 1.9) * amp + Math.sin(x / px * 17 + i * 3) * amp * 0.3;
          if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.stroke();
      }

      // 3. 细木纹线
      for (let i = 0; i < 70; i++) {
        const y0 = rnd() * px;
        const amp = px * (0.002 + rnd() * 0.008);
        c.strokeStyle = rnd() < 0.5
          ? 'rgba(150,104,48,' + (0.03 + rnd() * 0.045).toFixed(3) + ')'
          : 'rgba(255,238,205,' + (0.03 + rnd() * 0.05).toFixed(3) + ')';
        c.lineWidth = Math.max(1, px * 0.0012);
        c.beginPath();
        for (let x = 0; x <= px; x += px / 22) {
          const y = y0 + Math.sin(x / px * 8.7 + i * 2.3) * amp;
          if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.stroke();
      }

      // 4. 木节 (两处, 同心椭圆)
      for (let k = 0; k < 2; k++) {
        const kx = px * (0.18 + rnd() * 0.64), ky = px * (0.14 + rnd() * 0.72);
        for (let r = 1; r < 6; r++) {
          c.strokeStyle = 'rgba(118,78,32,' + (0.075 - r * 0.011).toFixed(3) + ')';
          c.lineWidth = Math.max(1, px * 0.0014);
          c.beginPath();
          c.ellipse(kx, ky, r * px * 0.013, r * px * 0.008, rnd() * 3, 0, Math.PI * 2);
          c.stroke();
        }
        const kg = c.createRadialGradient(kx, ky, 0, kx, ky, px * 0.012);
        kg.addColorStop(0, 'rgba(96,60,22,0.28)');
        kg.addColorStop(1, 'rgba(96,60,22,0)');
        c.fillStyle = kg;
        c.beginPath(); c.arc(kx, ky, px * 0.012, 0, Math.PI * 2); c.fill();
      }

      // 5. 漆面斜向反光
      const sheen = c.createLinearGradient(0, 0, px, px * 0.7);
      sheen.addColorStop(0, 'rgba(255,250,230,0.14)');
      sheen.addColorStop(0.4, 'rgba(255,250,230,0.03)');
      sheen.addColorStop(1, 'rgba(255,250,230,0)');
      c.fillStyle = sheen;
      c.fillRect(0, 0, px, px);

      // 6. 暗角
      const vig = c.createRadialGradient(px / 2, px / 2, px * 0.42, px / 2, px / 2, px * 0.75);
      vig.addColorStop(0, 'rgba(60,36,10,0)');
      vig.addColorStop(1, 'rgba(60,36,10,0.22)');
      c.fillStyle = vig;
      c.fillRect(0, 0, px, px);

      // 7. 立体厚度: 底边与右侧的深色侧面 + 高光棱线
      c.fillStyle = 'rgba(94,62,24,0.55)';
      c.fillRect(0, px - th, px, th);
      c.fillRect(px - th, 0, th, px);
      c.fillStyle = 'rgba(60,38,12,0.65)';
      c.fillRect(0, px - th * 0.35, px, th * 0.35);
      c.fillRect(px - th * 0.35, 0, th * 0.35, px);
      c.strokeStyle = 'rgba(255,240,210,0.28)';
      c.lineWidth = Math.max(1, px * 0.0015);
      c.beginPath(); c.moveTo(0, px - th); c.lineTo(px - th, px - th); c.stroke();
      c.beginPath(); c.moveTo(px - th, 0); c.lineTo(px - th, px - th); c.stroke();

      // 8. 边框: 外粗内细双线
      c.strokeStyle = 'rgba(88,54,20,0.85)';
      c.lineWidth = Math.max(1.5, px * 0.0045);
      c.strokeRect(margin - cell * 0.28, margin - cell * 0.28, cell * (this.n - 1) + cell * 0.56, cell * (this.n - 1) + cell * 0.56);
      c.strokeStyle = 'rgba(88,54,20,0.4)';
      c.lineWidth = Math.max(1, px * 0.002);
      c.strokeRect(margin - cell * 0.5, margin - cell * 0.5, cell * (this.n - 1) + cell, cell * (this.n - 1) + cell);

      // 9. 坐标标注 (顶部字母 / 左侧数字)
      const fs = Math.max(8, cell * 0.32);
      c.font = '600 ' + fs + 'px -apple-system, "PingFang SC", sans-serif';
      c.fillStyle = 'rgba(92,58,22,0.55)';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      for (let i = 0; i < this.n; i++) {
        const p = margin + i * cell;
        c.fillText(COLS[i] || String(i + 1), p, margin - cell * 0.62);
        c.fillText(String(i + 1), margin - cell * 0.62, p);
      }

      // 10. 网格 + 星位并入缓存 (每帧免画几十条线, 19 路盘性能关键)
      c.strokeStyle = 'rgba(72,44,14,0.85)';
      c.lineWidth = Math.max(1, px * 0.0016);
      c.lineCap = 'round';
      c.beginPath();
      for (let i = 0; i < this.n; i++) {
        const p = margin + i * cell;
        c.moveTo(margin, p); c.lineTo(px - margin, p);
        c.moveTo(p, margin); c.lineTo(p, px - margin);
      }
      c.stroke();
      c.lineWidth = Math.max(1.6, px * 0.0032);
      c.strokeRect(margin, margin, cell * (this.n - 1), cell * (this.n - 1));
      c.fillStyle = 'rgba(72,44,14,0.9)';
      for (const [sx, sy] of starPoints(this.n)) {
        c.beginPath();
        c.arc(margin + sx * cell, margin + sy * cell, Math.max(2, cell * 0.078), 0, Math.PI * 2);
        c.fill();
      }

      this._woodKey = key;
      this._woodCache = off;
      return off;
    }

    // ---------- 棋子 ----------
    _stone(ctx, cx, cy, r, isBlack, angle, alpha) {
      ctx.save();
      if (alpha !== undefined) ctx.globalAlpha = alpha;
      // 接触阴影 (椭圆, 略偏下)
      ctx.save();
      ctx.translate(cx + r * 0.08, cy + r * 0.22);
      ctx.scale(1, 0.62);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.96, 0, Math.PI * 2);
      ctx.shadowColor = 'rgba(30,18,4,0.45)';
      ctx.shadowBlur = r * 0.55;
      ctx.fillStyle = 'rgba(30,18,4,0.30)';
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle || 0);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      const g = ctx.createRadialGradient(-r * 0.38, -r * 0.42, r * 0.08, 0, 0, r * 1.06);
      if (isBlack) {
        g.addColorStop(0, '#8f8f8f');
        g.addColorStop(0.32, '#3e3e3e');
        g.addColorStop(0.75, '#101010');
        g.addColorStop(1, '#000');
      } else {
        g.addColorStop(0, '#fffef8');
        g.addColorStop(0.5, '#f2eee3');
        g.addColorStop(1, '#cdc6b2');
      }
      ctx.fillStyle = g;
      ctx.fill();
      // 边缘环境反光 (黑子偏冷, 白子偏暖阴影)
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.86, Math.PI * 0.15, Math.PI * 0.85);
      if (isBlack) { ctx.strokeStyle = 'rgba(130,170,230,0.20)'; ctx.lineWidth = r * 0.10; }
      else { ctx.strokeStyle = 'rgba(120,100,60,0.14)'; ctx.lineWidth = r * 0.08; }
      ctx.stroke();
      ctx.restore();

      // 双高光: 大柔光 + 小锐光
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle || 0);
      ctx.beginPath();
      ctx.ellipse(-r * 0.32, -r * 0.38, r * 0.30, r * 0.17, -0.7, 0, Math.PI * 2);
      ctx.fillStyle = isBlack ? 'rgba(255,255,255,0.26)' : 'rgba(255,255,255,0.92)';
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(-r * 0.44, -r * 0.5, r * 0.09, r * 0.055, -0.7, 0, Math.PI * 2);
      ctx.fillStyle = isBlack ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,1)';
      ctx.fill();
      ctx.restore();

      if (!isBlack && alpha === undefined) {
        ctx.strokeStyle = 'rgba(90,70,40,0.14)';
        ctx.lineWidth = Math.max(0.6, r * 0.045);
        ctx.beginPath(); ctx.arc(cx, cy, r - 0.3, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }

    // ---------- 彩带特效 ----------
    _spawnConfetti() {
      if (!this.fxCtx) return;
      const px = this.fx.width;
      const colors = ['#d9b36c', '#cd5c40', '#f2ede2', '#e2bd7c', '#9d3a24'];
      const parts = [];
      for (let i = 0; i < 90; i++) {
        parts.push({
          x: px / 2 + (Math.random() - 0.5) * px * 0.3,
          y: px * (0.35 + Math.random() * 0.15),
          vx: (Math.random() - 0.5) * px * 0.012,
          vy: -px * (0.006 + Math.random() * 0.010),
          size: px * (0.006 + Math.random() * 0.009),
          rot: Math.random() * Math.PI * 2,
          vr: (Math.random() - 0.5) * 0.3,
          color: colors[i % colors.length],
          born: performance.now() + Math.random() * 250,
          life: 1500 + Math.random() * 700
        });
      }
      this.confetti = parts;
    }

    _clearFx() {
      if (this.fxCtx) this.fxCtx.clearRect(0, 0, this.fx.width, this.fx.height);
    }

    _drawFx(now) {
      if (!this.fxCtx) return;
      const ctx = this.fxCtx;
      ctx.clearRect(0, 0, this.fx.width, this.fx.height);
      if (!this.confetti.length) return;
      let alive = false;
      for (const p of this.confetti) {
        if (now < p.born) { alive = true; continue; }
        const age = now - p.born;
        if (age > p.life) continue;
        alive = true;
        p.vy += this.fx.width * 0.00025;
        p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - age / p.life);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62);
        ctx.restore();
      }
      if (!alive) this.confetti = [];
    }

    // ---------- 主绘制 ----------
    _draw() {
      const ctx = this.ctx;
      const px = this.canvas.width;
      if (!px) { this._requestFrame(); return; }
      const now = performance.now();
      ctx.clearRect(0, 0, px, px);
      ctx.drawImage(this._wood(), 0, 0);

      if (this.board) {
        const { margin, cell } = this._geometry();
        const r = cell * 0.44;

        // 禁手标记 (红叉 + 半透明底)
        for (const f of this.forbidden) {
          const cx = margin + f.x * cell, cy = margin + f.y * cell;
          const s = r * 0.5;
          ctx.fillStyle = 'rgba(200,60,45,0.12)';
          ctx.beginPath(); ctx.arc(cx, cy, r * 0.9, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = 'rgba(205,55,40,0.9)';
          ctx.lineWidth = Math.max(1.5, px * 0.0035);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s);
          ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s);
          ctx.stroke();
        }

        // 残局提示标记 (金色脉冲环)
        if (this.hint) {
          const ht = (now - this.hint.until) / 2600;
          if (ht >= 1) this.hint = null;
          else {
            const hcx = margin + this.hint.x * cell, hcy = margin + this.hint.y * cell;
            const pa = 0.5 + 0.5 * Math.sin(now / 140);
            ctx.strokeStyle = 'rgba(217,179,108,' + (0.35 + 0.55 * pa).toFixed(3) + ')';
            ctx.lineWidth = Math.max(2, r * 0.1);
            ctx.beginPath(); ctx.arc(hcx, hcy, r * (1.02 + 0.1 * Math.sin(now / 180)), 0, Math.PI * 2); ctx.stroke();
            this._requestFrame();
          }
        }

        // 胜利金线 (流光)
        if (this.winLine && this.winLine.length) {
          const t = (now - this.pulseStart) / 1000;
          const a = 0.6 + 0.35 * Math.sin(t * 3.4);
          const p1 = this.winLine[0], p2 = this.winLine[this.winLine.length - 1];
          const x1 = margin + (p1 % this.n) * cell, y1 = margin + Math.floor(p1 / this.n) * cell;
          const x2 = margin + (p2 % this.n) * cell, y2 = margin + Math.floor(p2 / this.n) * cell;
          ctx.save();
          const lg = ctx.createLinearGradient(x1, y1, x2, y2);
          lg.addColorStop(0, 'rgba(255,224,130,' + a.toFixed(3) + ')');
          lg.addColorStop(0.5, 'rgba(255,196,70,' + Math.min(1, a + 0.2).toFixed(3) + ')');
          lg.addColorStop(1, 'rgba(255,224,130,' + a.toFixed(3) + ')');
          ctx.strokeStyle = lg;
          ctx.lineWidth = r * 0.24;
          ctx.lineCap = 'round';
          ctx.shadowColor = 'rgba(255,190,60,0.95)';
          ctx.shadowBlur = r * 1.1;
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
          ctx.restore();
        }

        // 棋子
        const pendingSet = {};
        for (const p of this.pending) pendingSet[p.idx] = p.color;
        for (let y = 0; y < this.n; y++) {
          for (let x = 0; x < this.n; x++) {
            const idx = y * this.n + x;
            const v = this.board[idx];
            if (!v) continue;
            const cx = margin + x * cell, cy = margin + y * cell;
            let scale = 1;
            const anim = this.anims.get(idx);
            if (anim) {
              const t = Math.min(1, (now - anim.start) / 200);
              if (t >= 1) this.anims.delete(idx);
              else scale = 1.35 - 0.35 * easeOutBack(t);
            }
            const angle = ((idx * 137.5) % 24 - 12) * Math.PI / 180;
            const inWin = this.winLine && this.winLine.indexOf(idx) !== -1;
            // 威胁提醒: 涉及的棋子跳动 + 脉冲环
            let bounce = 0, alerted = false;
            if (this.alert && now < this.alert.until && this.alert.cells.indexOf(idx) !== -1) {
              alerted = true;
              const at = (now - this.alert.start) / 1000;
              bounce = Math.abs(Math.sin(at * Math.PI * 3.4)) * r * 0.42;
              const rc = this.alert.color === 'red' ? '235,90,65' : '255,215,120';
              ctx.strokeStyle = 'rgba(' + rc + ',' + (0.7 + 0.3 * Math.sin(now / 110)).toFixed(3) + ')';
              ctx.lineWidth = Math.max(2, r * 0.14);
              ctx.beginPath(); ctx.arc(cx, cy, r * (1.12 + 0.06 * Math.sin(now / 110)), 0, Math.PI * 2); ctx.stroke();
              ctx.shadowColor = 'rgba(' + rc + ',0.8)';
              ctx.shadowBlur = r * 0.5;
            }
            this._stone(ctx, cx, cy - bounce, r * scale * (inWin ? 1.06 : 1), v === 1, angle);

            // 最后一手标记 (呼吸红点)
            if (this.lastMove && this.lastMove.x === x && this.lastMove.y === y) {
              const pa = 0.75 + 0.25 * Math.sin(now / 300);
              ctx.fillStyle = 'rgba(235,72,45,' + pa.toFixed(3) + ')';
              ctx.beginPath();
              ctx.arc(cx, cy - bounce, Math.max(1.6, r * 0.17), 0, Math.PI * 2);
              ctx.fill();
            }
            // 胜利五子描金圈
            if (inWin) {
              const t = (now - this.pulseStart) / 1000;
              ctx.strokeStyle = 'rgba(255,215,120,' + (0.7 + 0.3 * Math.sin(t * 3.4)).toFixed(3) + ')';
              ctx.lineWidth = Math.max(1.5, r * 0.09);
              ctx.beginPath(); ctx.arc(cx, cy, r * 1.06, 0, Math.PI * 2); ctx.stroke();
            }
          }
        }

        // 待确认子 (半透明 + 金色虚线环)
        for (const p of this.pending) {
          const cx = margin + (p.idx % this.n) * cell;
          const cy = margin + Math.floor(p.idx / this.n) * cell;
          this._stone(ctx, cx, cy, r, p.color === 1, 0, 0.5);
          ctx.save();
          ctx.strokeStyle = 'rgba(217,179,108,0.9)';
          ctx.lineWidth = Math.max(1, r * 0.08);
          ctx.setLineDash([r * 0.28, r * 0.22]);
          ctx.lineDashOffset = -(now / 40) % 100;
          ctx.beginPath(); ctx.arc(cx, cy, r * 1.12, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }

        // 悬停预览
        if (this.hover && this.myTurn && this.board[this.hover.y * this.n + this.hover.x] === 0) {
          const cx = margin + this.hover.x * cell, cy = margin + this.hover.y * cell;
          ctx.globalAlpha = 0.45;
          this._stone(ctx, cx, cy, r, this.myColor === 'black');
          ctx.globalAlpha = 1;
        }

        // 点击涟漪
        for (const rp of this.ripples) {
          const t = (now - rp.start) / 450;
          if (t >= 1) continue;
          ctx.strokeStyle = 'rgba(255,240,210,' + (0.55 * (1 - t)).toFixed(3) + ')';
          ctx.lineWidth = Math.max(1.5, px * 0.004) * (1 - t * 0.6);
          ctx.beginPath();
          ctx.arc(rp.x, rp.y, cell * (0.25 + t * 0.75), 0, Math.PI * 2);
          ctx.stroke();
        }
        if (this.ripples.length) {
          this.ripples = this.ripples.filter(rp => now - rp.start < 450);
        }

        if (this.anims.size || this.ripples.length || this.winLine ||
            (this.alert && now < this.alert.until)) this._requestFrame();
      }

      // 彩带
      this._drawFx(now);
      if (this.winLine && !this.celebrated) {
        this.celebrated = true;
        this._spawnConfetti();
        this._requestFrame();
      }
      if (this.confetti.length) this._requestFrame();
    }
  }

  window.GomokuBoard = GomokuBoard;
})();
