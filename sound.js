/*
 * 合成音效 (WebAudio, 无素材文件)
 */
(function () {
  'use strict';

  let ctx = null;
  let enabled = localStorage.getItem('gomoku.sound') !== '0';

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // 首次交互解锁
  window.addEventListener('pointerdown', () => ac(), { once: true, passive: true });

  function noiseBurst(dur, freq, gain) {
    const a = ac(); if (!a) return;
    const n = Math.floor(a.sampleRate * dur);
    const buf = a.createBuffer(1, n, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.2);
    const src = a.createBufferSource(); src.buffer = buf;
    const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.1;
    const g = a.createGain(); g.gain.value = gain;
    src.connect(bp).connect(g).connect(a.destination);
    src.start();
  }

  function tone(freq, start, dur, gain, type) {
    const a = ac(); if (!a) return;
    const o = a.createOscillator(); o.type = type || 'sine'; o.frequency.value = freq;
    const g = a.createGain();
    const t0 = a.currentTime + start;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(a.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  const fx = {
    place() { noiseBurst(0.06, 2400, 0.5); tone(190, 0, 0.08, 0.12, 'triangle'); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.34, 0.16)); },
    lose() { tone(330, 0, 0.3, 0.14); tone(233, 0.18, 0.5, 0.14); },
    notify() { tone(880, 0, 0.12, 0.1); tone(1175, 0.09, 0.16, 0.1); }
  };

  window.Sound = {
    play(name) { if (enabled && fx[name]) { try { fx[name](); } catch (e) { } } },
    get enabled() { return enabled; },
    toggle() {
      enabled = !enabled;
      localStorage.setItem('gomoku.sound', enabled ? '1' : '0');
      if (enabled) Sound.play('notify');
      return enabled;
    }
  };
})();
