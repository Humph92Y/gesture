// 가짜(합성) 동작 데이터 생성기: 실제 카메라 없이 엔진을 점검하기 위한 용도
import { PADS, LM } from '../js/engine.js';

function gauss(rng) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
export function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// protocol.expected 대로 움직이는 사람을 fps 로 촬영했다고 가정한 리포트 생성
export function synthReport({ protocol, fps = 30, noisePx = 1.5, seed = 1, jitterMs = 40, split = 'training', w = 640, h = 480, stickLen = 0.6 }) {
  const rng = mulberry32(seed);
  const sw = 80, ax = w / 2, ay = 110;
  const strike = []; // 손 타격 시각/패드
  const kicks = [], hh = [];
  for (const e of protocol.expected) {
    const t = e.t + gauss(rng) * jitterMs;
    if (e.target === 'kick') kicks.push(t);
    else if (e.target === 'hhOpen') hh.push({ t, open: true });
    else if (e.target === 'hhClose') hh.push({ t, open: false });
    else {
      const pad = PADS.find(p => p.id === e.target);
      strike.push({ t, pad, hand: e.target === 'hihat' || pad.u < 0 ? 'L' : 'R' });
    }
  }
  // 동시에 하이햇+스네어면 스네어는 오른손으로
  for (let i = 0; i < strike.length; i++) for (let j = 0; j < strike.length; j++) {
    if (i !== j && Math.abs(strike[i].t - strike[j].t) < 150 && strike[i].hand === strike[j].hand) {
      const o = strike[i].pad.id === 'hihat' ? strike[j] : strike[i];
      o.hand = o.hand === 'L' ? 'R' : 'L';
    }
  }
  // 한 손의 스틱 끝 궤적: 키프레임 사이를 부드럽게 연결, 내려치는 구간만 가속
  const keys = { L: [], R: [] };
  for (const hand of ['L', 'R']) {
    const list = strike.filter(s => s.hand === hand).sort((a, b) => a.t - b.t);
    const k = keys[hand];
    k.push({ t: -1e9, u: hand === 'L' ? -0.5 : 0.5, v: 1.1, ease: 'smooth' });
    for (const s of list) {
      const up = s.pad.v - 0.5;
      k.push({ t: s.t - 420, u: s.pad.u, v: up + 0.2, ease: 'smooth' });
      k.push({ t: s.t - 160, u: s.pad.u, v: up, ease: 'smooth' });
      k.push({ t: s.t, u: s.pad.u, v: s.pad.v, ease: 'accel' });
      k.push({ t: s.t + 160, u: s.pad.u, v: s.pad.v - 0.25, ease: 'smooth' });
    }
    k.sort((a, b) => a.t - b.t);
  }
  function tipAt(hand, t) {
    const k = keys[hand];
    let i = 0; while (i + 1 < k.length && k[i + 1].t <= t) i++;
    const a = k[i], b = k[i + 1];
    if (!b || a.t < -1e8 && b.t - t > 1000) return { u: a.u, v: a.v };
    const t0 = Math.max(a.t, b.t - 1000);
    let x = Math.min(1, Math.max(0, (t - t0) / (b.t - t0)));
    x = b.ease === 'accel' ? x * x : x * x * (3 - 2 * x);
    return { u: a.u + (b.u - a.u) * x, v: a.v + (b.v - a.v) * x };
  }
  function footLift(t, list) { // 킥: 들었다 내리기
    for (const k of list) { const d = t - k; if (d > -350 && d <= 0) { const x = (d + 350) / 350; return d < -150 ? 0.3 * ((d + 350) / 200) : 0.3 * (1 - ((d + 150) / 150) ** 2); } }
    return 0;
  }
  function hhLift(t) {
    let open = false, since = -1e9;
    for (const e of hh) if (e.t <= t) { open = e.open; since = e.t; }
    const d = t - since;
    if (open) return 0.3 * Math.min(1, d / 120);
    return 0.3 * Math.max(0, 1 - d / 100) * (since > 0 ? 1 : 0);
  }
  const frames = [];
  const dt = 1000 / fps;
  for (let t = 0; t <= protocol.durationMs; t += dt) {
    const pts = new Array(33).fill(null).map(() => [0.5, 0.5, 0.1]);
    const put = (i, X, Y, vis = 0.95) => { // X,Y = 반전 화면 픽셀 → 원본 정규화 좌표
      X += gauss(rng) * noisePx; Y += gauss(rng) * noisePx;
      pts[i] = [1 - X / w, Y / h, vis];
    };
    put(LM.L_SHOULDER, ax - sw / 2, ay); put(LM.R_SHOULDER, ax + sw / 2, ay);
    put(LM.L_HIP, ax - 0.3 * sw, ay + 1.6 * sw); put(LM.R_HIP, ax + 0.3 * sw, ay + 1.6 * sw);
    for (const hand of ['L', 'R']) {
      const { u, v } = tipAt(hand, t);
      // 팔꿈치 → 손목 방향 (0.3, 0.6)*sw 로 고정, 팁 = 손목 + (손목-팔꿈치)*stickLen
      const fx = 0.0 * sw, fy = 0.6 * sw;
      const tipX = ax + u * sw, tipY = ay + v * sw;
      const wx = tipX - fx * stickLen, wy = tipY - fy * stickLen;
      put(hand === 'L' ? LM.L_WRIST : LM.R_WRIST, wx, wy);
      put(hand === 'L' ? LM.L_ELBOW : LM.R_ELBOW, wx - fx, wy - fy);
    }
    const ground = ay + 3.9 * sw;
    const kl = footLift(t, kicks) * sw, hl = hhLift(t) * sw;
    put(LM.R_HEEL, ax + 0.35 * sw, ground - kl); put(LM.R_FOOT, ax + 0.5 * sw, ground - kl + 3);
    put(LM.R_ANKLE, ax + 0.35 * sw, ground - kl - 8);
    put(LM.L_HEEL, ax - 0.35 * sw, ground - hl); put(LM.L_FOOT, ax - 0.5 * sw, ground - hl + 3);
    put(LM.L_ANKLE, ax - 0.35 * sw, ground - hl - 8);
    const row = [Math.round(t), 10];
    for (const p of pts) row.push(+p[0].toFixed(4), +p[1].toFixed(4), +p[2].toFixed(2));
    frames.push(row);
  }
  return {
    format: 'airdrum-report', version: 1, id: `synth-${seed}`, split, synthetic: true,
    device: { width: w, height: h }, params: null, calibration: null,
    protocol, frames: { fields: 't,inferMs,33x(x,y,vis)', data: frames },
  };
}
