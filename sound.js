/*
 * 声音系统 v2 (WebAudio, 无素材文件)
 *
 * 音效 (SFX): 落子/胜利/失败/提示, 走独立音量总线
 * 音乐 (BGM): 程序化生成的五声音阶氛围曲 — 随机游走旋律 + 低音铺底 +
 *             延迟回声, 无任何素材文件; 独立开关与音量, 配置持久化
 */
(function () {
  'use strict';

  let ctx = null, sfxGain = null, musGain = null;
  let sfxOn = localStorage.getItem('gomoku.sfx') !== '0';
  let sfxVol = parseFloat(localStorage.getItem('gomoku.sfxvol') ?? '0.8');
  let musOn = localStorage.getItem('gomoku.music') !== '0';
  let musStyle = localStorage.getItem('gomoku.musicstyle') === 'bright' ? 'bright' : 'calm';
  let musVol = parseFloat(localStorage.getItem('gomoku.musicvol') ?? '0.4');
  if (!(sfxVol >= 0 && sfxVol <= 1)) sfxVol = 0.8;
  if (!(musVol >= 0 && musVol <= 1)) musVol = 0.4;

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      sfxGain = ctx.createGain();
      sfxGain.gain.value = sfxOn ? sfxVol : 0;
      sfxGain.connect(ctx.destination);
      musGain = ctx.createGain();
      musGain.gain.value = musOn ? musVol : 0;
      musGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // 首次交互解锁
  window.addEventListener('pointerdown', () => { ac(); if (musOn) startMusic(); }, { once: true, passive: true });

  function sfx() {
    const a = ac();
    return a ? { a, out: sfxGain } : null;
  }

  // ---------- 音效 ----------
  function noiseBurst(dur, freq, gain) {
    const s = sfx(); if (!s) return;
    const n = Math.floor(s.a.sampleRate * dur);
    const buf = s.a.createBuffer(1, n, s.a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.2);
    const src = s.a.createBufferSource(); src.buffer = buf;
    const bp = s.a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.1;
    const g = s.a.createGain(); g.gain.value = gain;
    src.connect(bp).connect(g).connect(s.out);
    src.start();
  }

  function tone(freq, start, dur, gain, type) {
    const s = sfx(); if (!s) return;
    const o = s.a.createOscillator(); o.type = type || 'sine'; o.frequency.value = freq;
    const g = s.a.createGain();
    const t0 = s.a.currentTime + start;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(s.out);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  const fx = {
    place() { noiseBurst(0.05, 2500, 0.55); tone(185, 0, 0.09, 0.14, 'triangle'); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.34, 0.16)); },
    lose() { tone(330, 0, 0.3, 0.14); tone(233, 0.18, 0.5, 0.14); },
    notify() { tone(880, 0, 0.12, 0.1); tone(1175, 0.09, 0.16, 0.1); },
    bad() { tone(240, 0, 0.14, 0.13, 'square'); tone(200, 0.1, 0.2, 0.1, 'square'); },
    hint() { tone(1319, 0, 0.1, 0.08); tone(1568, 0.08, 0.14, 0.08); }
  };

  // ---------- 程序化背景音乐 ----------
  const STYLES = {
    calm:   { scale: [0, 3, 5, 7, 10, 12, 15, 17, 19], beat: 60 / 74, base: 220, fifth: 110 },  // 小调五声, 慢
    bright: { scale: [0, 2, 4, 7, 9, 12, 14, 16, 19], beat: 60 / 100, base: 262, fifth: 131 }   // 大调五声, 快
  };
  let musicRunning = false, schedTimer = null, nextTime = 0, stepIdx = 0, melodyIdx = 4, delayNode = null;

  function musicNode() {
    const a = ac(); if (!a) return null;
    if (!delayNode) { // 回声链 (一次搭建)
      delayNode = a.createDelay(1.0);
      delayNode.delayTime.value = 0.31;
      const fb = a.createGain(); fb.gain.value = 0.34;
      const wet = a.createGain(); wet.gain.value = 0.5;
      delayNode.connect(fb).connect(delayNode);
      delayNode.connect(wet).connect(musGain);
    }
    return { a, in: musGain, echo: delayNode };
  }

  function scheduleMelodyNote(t) {
    const m = musicNode(); if (!m) return;
    const st = STYLES[musStyle];
    // 随机游走
    melodyIdx += [(-2), -1, -1, 1, 1, 2, 0][Math.floor(Math.random() * 7)];
    if (melodyIdx < 0) melodyIdx = 1;
    if (melodyIdx >= st.scale.length) melodyIdx = st.scale.length - 2;
    if (Math.random() < 0.18) return; // 偶尔休止
    const freq = st.base * Math.pow(2, st.scale[melodyIdx] / 12);
    const o = m.a.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
    const o2 = m.a.createOscillator(); o2.type = 'triangle'; o2.frequency.value = freq * 2.003;
    const g = m.a.createGain();
    const dur = 1.1;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const g2 = m.a.createGain(); g2.gain.value = 0.25;
    o.connect(g); o2.connect(g2).connect(g);
    g.connect(m.in); g.connect(m.echo);
    o.start(t); o.stop(t + dur + 0.1);
    o2.start(t); o2.stop(t + dur + 0.1);
  }

  function scheduleBass(t) {
    const m = musicNode(); if (!m) return;
    const o = m.a.createOscillator(); o.type = 'triangle'; o.frequency.value = STYLES[musStyle].fifth;
    const g = m.a.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.3);
    g.gain.exponentialRampToValueAtTime(0.001, t + 3.4);
    o.connect(g).connect(m.in);
    o.start(t); o.stop(t + 3.6);
  }

  function schedulerTick() {
    const a = ac(); if (!a || !musicRunning) return;
    while (nextTime < a.currentTime + 0.8) {
      if (stepIdx % 8 === 0) scheduleBass(nextTime);
      scheduleMelodyNote(nextTime);
      stepIdx++;
      nextTime += STYLES[musStyle].beat;
    }
  }

  function startMusic() {
    if (musicRunning || !musOn) return;
    const a = ac(); if (!a) return;
    musicRunning = true;
    nextTime = a.currentTime + 0.15;
    schedTimer = setInterval(schedulerTick, 240);
  }

  function stopMusic() {
    musicRunning = false;
    if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
  }

  // ---------- 对外接口 ----------
  window.Sound = {
    play(name) { if (sfxOn && fx[name]) { try { fx[name](); } catch (e) { } } },
    get sfxOn() { return sfxOn; },
    get sfxVol() { return sfxVol; },
    get musicOn() { return musOn; },
    get musicVol() { return musVol; },
    setSfx(on) {
      sfxOn = !!on;
      localStorage.setItem('gomoku.sfx', sfxOn ? '1' : '0');
      if (ctx) sfxGain.gain.value = sfxOn ? sfxVol : 0;
    },
    setSfxVol(v) {
      sfxVol = Math.max(0, Math.min(1, v));
      localStorage.setItem('gomoku.sfxvol', String(sfxVol));
      if (ctx) sfxGain.gain.value = sfxOn ? sfxVol : 0;
    },
    setMusic(on) {
      musOn = !!on;
      localStorage.setItem('gomoku.music', musOn ? '1' : '0');
      if (musOn) startMusic(); else stopMusic();
      if (ctx) musGain.gain.value = musOn ? musVol : 0;
    },
    get musicStyle() { return musStyle; },
    setMusicStyle(st) {
      if (!STYLES[st]) return;
      musStyle = st;
      localStorage.setItem('gomoku.musicstyle', st);
    },
    setMusicVol(v) {
      musVol = Math.max(0, Math.min(1, v));
      localStorage.setItem('gomoku.musicvol', String(musVol));
      if (ctx) musGain.gain.value = musOn ? musVol : 0;
    }
  };
})();
