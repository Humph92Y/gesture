// 가짜(합성) 동작 데이터 생성기: 실제 카메라 없이 엔진을 점검하기 위한 용도
import { PADS, LM } from '../js/engine.js';

function gauss(rng) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
export function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// protocol.expected 대로 움직이는 사람을 fps 로 촬영했다고 가정한 리포트 생성
export function synthReport({ protocol, fps = 30, noisePx = 1.5, seed = 1, jitterMs = 40, split = 'training', w = 640, h = 480, style = 'wrist' }) {
  const wrist = style === 'wrist';
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
      // 실제 드럼처럼: 하이햇·탐·플로어탐·라이드 = 오른손(하이햇은 팔을 교차), 스네어·크래시 = 왼손
      strike.push({ t, pad, hand: ['snare', 'crash'].includes(e.target) ? 'L' : 'R' });
    }
  }
  // 동시에 하이햇+스네어면 스네어는 오른손으로
  for (let i = 0; i < strike.length; i++) for (let j = 0; j < strike.length; j++) {
    if (i !== j && Math.abs(strike[i].t - strike[j].t) < 150 && strike[i].hand === strike[j].hand) {
      const o = strike[i].pad.id === 'hihat' ? strike[j] : strike[i];
      o.hand = o.hand === 'L' ? 'R' : 'L';
    }
  }
  // 손 동작: 팔(손목 위치)은 드럼 사이를 천천히 옮겨 다니고, 타격은 손목 꺾기(손 각도)로 한다.
  // 손 각도 phi: 0도 = 손(스틱)이 위를 향함, 90도 = 카메라 쪽(앞)을 향함 → 화면에서 손 길이가 짧아 보임
  const HL = 0.22; // 손목→손가락마디 길이 (어깨너비)
  const plan = { L: [], R: [] };
  for (const hand of ['L', 'R']) plan[hand] = strike.filter(s => s.hand === hand).sort((a, b) => a.t - b.t);
  function lerpKeys(k, t) {
    let i = 0; while (i + 1 < k.length && k[i + 1].t <= t) i++;
    const a = k[i], b = k[i + 1];
    if (!b) return a.val;
    let x = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    x = b.ease === 'accel' ? x * x : x * x * (3 - 2 * x);
    return a.val.map((v, j) => v + (b.val[j] - v) * x);
  }
  const keyCache = {};
  function handKeys(hand) {
    if (keyCache[hand]) return keyCache[hand];
    const list = plan[hand];
    const home = hand === 'L' ? [-0.5, 1.3] : [0.5, 1.3];
    const arm = [{ t: -1e9, val: home }], ang = [{ t: -1e9, val: [50] }];
    list.forEach((s, i) => {
      const prev = list[i - 1], next = list[i + 1];
      const gapBefore = prev ? s.t - prev.t : 1000, gapAfter = next ? next.t - s.t : 1000;
      const target = [s.pad.u, s.pad.v];
      if (wrist) {
        // 팔은 이전 타격 직후부터 다음 드럼 위로 이동 (큰 동작 없음)
        arm.push({ t: s.t - Math.min(400, gapBefore * 0.7), val: target });
        ang.push({ t: s.t - Math.min(170, gapBefore * 0.5), val: [15] });   // 손목 젖힘(스틱 들기)
        ang.push({ t: s.t, val: [95], ease: 'accel' });                      // 손목 꺾어 내려침
        ang.push({ t: s.t + Math.min(90, gapAfter * 0.3), val: [55] });      // 반동
      } else {
        // 팔 전체로 치기 (예전 방식): 손 각도 고정, 손목 높이가 크게 오르내림
        arm.push({ t: s.t - Math.min(420, gapBefore * 0.7), val: [target[0], target[1] - 0.2] });
        arm.push({ t: s.t - Math.min(160, gapBefore * 0.4), val: [target[0], target[1] - 0.5] });
        arm.push({ t: s.t, val: target, ease: 'accel' });
        arm.push({ t: s.t + Math.min(160, gapAfter * 0.4), val: [target[0], target[1] - 0.25] });
      }
    });
    arm.sort((a, b) => a.t - b.t); ang.sort((a, b) => a.t - b.t);
    return (keyCache[hand] = { arm, ang });
  }
  function handPose(hand, t) {
    const k = handKeys(hand);
    const [u, v] = lerpKeys(k.arm, t);
    const phi = wrist ? lerpKeys(k.ang, t)[0] : 80;
    const r = phi * Math.PI / 180;
    // 손목 위치: 타격 순간 스틱 끝이 패드 중심에 오도록 약간 위쪽 + 손목 젖힐 때 살짝 들림
    const lift = wrist ? 0.04 * Math.cos(r) : 0;
    return { u, v: v - lift, hx: (hand === 'L' ? -1 : 1) * 0.03, hy: -HL * Math.cos(r) };
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
      const hp = handPose(hand, t);
      const wx = ax + hp.u * sw, wy = ay + hp.v * sw;
      const L = hand === 'L';
      put(L ? LM.L_WRIST : LM.R_WRIST, wx, wy);
      put(L ? LM.L_ELBOW : LM.R_ELBOW, wx + (L ? 0.15 : -0.15) * sw, wy + 0.55 * sw);
      const kx = wx + hp.hx * sw, ky = wy + hp.hy * sw;
      put(L ? LM.L_INDEX : LM.R_INDEX, kx + 0.04 * sw, ky, 0.85);
      put(L ? LM.L_PINKY : LM.R_PINKY, kx - 0.04 * sw, ky + 0.01 * sw, 0.85);
      put(L ? LM.L_THUMB : LM.R_THUMB, kx + 0.02 * sw, ky - 0.01 * sw, 0.85);
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
