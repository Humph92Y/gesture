// 드럼 소리: 파일 없이 미리 합성해 둔 소리(AudioBuffer)를 즉시 재생 → 재생 지연 최소화

function noise(len) { const a = new Float32Array(len); for (let i = 0; i < len; i++) a[i] = Math.random() * 2 - 1; return a; }

async function render(sr, dur, build) {
  const ctx = new OfflineAudioContext(1, Math.ceil(sr * dur), sr);
  build(ctx);
  return ctx.startRendering();
}
function noiseSrc(ctx, dur) {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  b.copyToChannel(noise(b.length), 0);
  const s = ctx.createBufferSource(); s.buffer = b; return s;
}
function env(ctx, peak, decay, attack = 0.001) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(peak, attack);
  g.gain.exponentialRampToValueAtTime(0.0001, attack + decay);
  return g;
}

const RECIPES = {
  kick: [0.5, (c) => {
    const o = c.createOscillator(); o.frequency.setValueAtTime(160, 0); o.frequency.exponentialRampToValueAtTime(45, 0.12);
    const g = env(c, 1.0, 0.45); o.connect(g).connect(c.destination); o.start(0);
    const n = noiseSrc(c, 0.02); const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 3000;
    const g2 = env(c, 0.4, 0.015); n.connect(f).connect(g2).connect(c.destination); n.start(0);
  }],
  snare: [0.35, (c) => {
    const n = noiseSrc(c, 0.35); const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1200;
    const g = env(c, 0.7, 0.2); n.connect(f).connect(g).connect(c.destination); n.start(0);
    const o = c.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(220, 0); o.frequency.exponentialRampToValueAtTime(160, 0.08);
    const g2 = env(c, 0.6, 0.1); o.connect(g2).connect(c.destination); o.start(0);
  }],
  hihatClosed: [0.08, (c) => {
    const n = noiseSrc(c, 0.08); const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
    const g = env(c, 0.5, 0.05); n.connect(f).connect(g).connect(c.destination); n.start(0);
  }],
  hihatOpen: [0.7, (c) => {
    const n = noiseSrc(c, 0.7); const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6500;
    const g = env(c, 0.45, 0.6); n.connect(f).connect(g).connect(c.destination); n.start(0);
  }],
  hihatPedal: [0.06, (c) => {
    const n = noiseSrc(c, 0.06); const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 5000; f.Q.value = 1.5;
    const g = env(c, 0.5, 0.04); n.connect(f).connect(g).connect(c.destination); n.start(0);
  }],
  tom: [0.6, (c) => {
    const o = c.createOscillator(); o.frequency.setValueAtTime(220, 0); o.frequency.exponentialRampToValueAtTime(130, 0.3);
    const g = env(c, 0.9, 0.5); o.connect(g).connect(c.destination); o.start(0);
  }],
  floor: [0.8, (c) => {
    const o = c.createOscillator(); o.frequency.setValueAtTime(130, 0); o.frequency.exponentialRampToValueAtTime(75, 0.4);
    const g = env(c, 1.0, 0.7); o.connect(g).connect(c.destination); o.start(0);
  }],
  crash: [1.8, (c) => {
    const n = noiseSrc(c, 1.8); const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 4000;
    const g = env(c, 0.55, 1.7, 0.003); n.connect(f).connect(g).connect(c.destination); n.start(0);
  }],
  ride: [1.2, (c) => {
    const n = noiseSrc(c, 1.2); const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 8000; f.Q.value = 2;
    const g = env(c, 0.35, 1.0); n.connect(f).connect(g).connect(c.destination); n.start(0);
    for (const fr of [2600, 3900]) {
      const o = c.createOscillator(); o.type = 'square'; o.frequency.value = fr;
      const g2 = env(c, 0.04, 0.8); o.connect(g2).connect(c.destination); o.start(0);
    }
  }],
  click: [0.05, (c) => {
    const o = c.createOscillator(); o.frequency.value = 1500; const g = env(c, 0.5, 0.03); o.connect(g).connect(c.destination); o.start(0);
  }],
  clickHi: [0.05, (c) => {
    const o = c.createOscillator(); o.frequency.value = 2200; const g = env(c, 0.6, 0.03); o.connect(g).connect(c.destination); o.start(0);
  }],
};

export class DrumAudio {
  constructor() { this.ctx = null; this.buf = {}; this.openVoice = null; this.master = null; this.metroGain = null; }

  async init() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    // latencyHint 0 = 브라우저가 허용하는 가장 작은 버퍼
    try { this.ctx = new AudioContext({ latencyHint: 0 }); } catch { this.ctx = new AudioContext({ latencyHint: 'interactive' }); }
    const sr = this.ctx.sampleRate;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -6; comp.ratio.value = 4; comp.attack.value = 0.001;
    this.master = this.ctx.createGain(); this.master.gain.value = 0.9;
    this.master.connect(comp).connect(this.ctx.destination);
    this.metroGain = this.ctx.createGain(); this.metroGain.gain.value = 0.5; this.metroGain.connect(this.ctx.destination);
    await Promise.all(Object.entries(RECIPES).map(async ([k, [dur, build]]) => { this.buf[k] = await render(sr, dur, build); }));
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  latencyMs() {
    if (!this.ctx) return null;
    return { base: (this.ctx.baseLatency || 0) * 1000, output: (this.ctx.outputLatency || 0) * 1000 };
  }

  // vel01: 0~1 세기
  play(name, vel01 = 0.8, when = 0) {
    if (!this.ctx || !this.buf[name]) return;
    const s = this.ctx.createBufferSource(); s.buffer = this.buf[name];
    s.playbackRate.value = 1 + (Math.random() - 0.5) * 0.04; // 기계음 느낌 줄이기
    const g = this.ctx.createGain(); g.gain.value = 0.15 + 0.85 * Math.max(0, Math.min(1, vel01));
    s.connect(g).connect(this.master);
    s.start(when);
    if (name === 'hihatOpen') this.openVoice = { s, g };
    return s;
  }

  // 하이햇 닫힘: 울리던 열린 하이햇 소리 끊기
  chokeOpen() {
    if (!this.openVoice) return;
    const { g } = this.openVoice; const t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + 0.03);
    this.openVoice = null;
  }

  click(when, accent = false) {
    if (!this.ctx) return;
    const s = this.ctx.createBufferSource(); s.buffer = this.buf[accent ? 'clickHi' : 'click'];
    s.connect(this.metroGain); s.start(when);
    return s;
  }
}

export const PAD_SOUND = { snare: 'snare', tom: 'tom', floor: 'floor', crash: 'crash', ride: 'ride', kick: 'kick' };
