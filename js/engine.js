// 에어드럼 동작 엔진 (브라우저·Node 공용, 화면/소리 코드 없음)
// 입력: 프레임마다 MediaPipe Pose 랜드마크 33개
// 출력: 타격 이벤트 (패드 타격, 킥, 하이햇 열림/닫힘)
//
// 좌표 규칙
//  - 화면은 거울처럼 좌우 반전해서 보여 준다. 엔진도 같은 반전 좌표를 쓴다.
//    X = (1 - x) * 영상폭,  Y = y * 영상높이  (픽셀)
//  - 길이 단위는 "어깨너비(sw)". 사람 크기나 카메라 거리와 상관없이 같은 기준.
//  - 속도 계산은 화면 절대 좌표 (Y / swRef), 드럼 위치 판단은 어깨 기준 몸 좌표.

export const ENGINE_VERSION = '0.1.0';

export const LM = {
  L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30, L_FOOT: 31, R_FOOT: 32,
};

export const PADS = [
  { id: 'hihat', name: '하이햇', u: -1.05, v: 1.25 },
  { id: 'snare', name: '스네어', u: -0.35, v: 1.65 },
  { id: 'tom', name: '탐', u: 0.35, v: 1.05 },
  { id: 'floor', name: '플로어탐', u: 1.05, v: 1.65 },
  { id: 'crash', name: '크래시', u: -1.35, v: 0.25 },
  { id: 'ride', name: '라이드', u: 1.4, v: 0.55 },
];

export const DEFAULT_PARAMS = {
  stickLen: 0.6,          // 가상 스틱 길이 (팔뚝 길이 대비)
  handMinVel: 2.5,        // 손: 이 속도(어깨너비/초) 이상으로 내려와야 타격
  handDecel: 0.8,         // 손: 최고 속도의 이 비율 아래로 떨어지는 순간 = 타격 (클수록 빨리 울림)
  handRearm: 0.10,        // 손: 다시 치려면 이만큼 들어 올려야 함 (어깨너비)
  handRefractoryMs: 60,   // 손: 연속 오작동 방지 최소 간격
  footMinVel: 1.2,        // 킥: 내려오는 최소 속도
  footDecel: 0.8,
  footRearmRatio: 0.4,    // 킥: 캘리브레이션 때 잰 발 들어올림 높이의 이 비율 이상 들어야 장전
  footRefractoryMs: 90,
  hhOpenRatio: 0.5,       // 하이햇: 잰 들어올림 높이의 이 비율 이상 = 열림
  hhCloseRatio: 0.25,     // 하이햇: 이 비율 아래로 내려오면 = 닫힘
  minVis: 0.5,            // 랜드마크 신뢰도 하한
  padRadius: 0.6,         // 패드 인식 반경 (어깨너비)
  filterMinCutoff: 1.7,   // 떨림 제거 필터 (One Euro)
  filterBeta: 1.5,
};

export const DEFAULT_LIFT = 0.25; // 캘리브레이션 전 기본 발 들어올림 높이 (어깨너비)

// ---------- One Euro 필터: 가만히 있을 땐 떨림 제거, 빠를 땐 지연 최소 ----------
class LowPass {
  constructor() { this.y = null; }
  filter(x, a) { this.y = this.y === null ? x : a * x + (1 - a) * this.y; return this.y; }
}
export class OneEuro {
  constructor(minCutoff = 1.7, beta = 0.4, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = new LowPass(); this.dx = new LowPass(); this.tPrev = null; this.xPrev = null;
  }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  reset() { this.x = new LowPass(); this.dx = new LowPass(); this.tPrev = null; this.xPrev = null; }
  filter(x, tSec) {
    if (this.tPrev === null) { this.tPrev = tSec; this.xPrev = x; this.dx.filter(0, 1); return this.x.filter(x, 1); }
    const dt = Math.max(1e-4, tSec - this.tPrev);
    const dxRaw = (x - this.xPrev) / dt;
    const edx = this.dx.filter(dxRaw, OneEuro.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const y = this.x.filter(x, OneEuro.alpha(cutoff, dt));
    this.tPrev = tSec; this.xPrev = x;
    return y;
  }
}

// ---------- 내려치기 감지 (손·킥 공용) ----------
// 들어 올림(장전) → 빠르게 내려옴 → 감속 시작 순간 = 타격
export class StrikeDetector {
  constructor(opts) { this.o = opts; this.reset(); }
  reset() {
    this.prevV = null; this.prevT = null; this.peak = 0; this.armed = true;
    this.bottom = 0; this.lastFire = -1e9; this.vy = 0;
  }
  // v: 아래로 갈수록 커지는 높이 값(어깨너비 단위), t: ms
  update(t, v) {
    const o = this.o;
    if (this.prevT === null) { this.prevT = t; this.prevV = v; return null; }
    const dt = (t - this.prevT) / 1000;
    if (dt <= 0) return null;
    if (dt > 0.25) { this.prevT = t; this.prevV = v; this.peak = 0; return null; } // 끊겼다 다시 잡힘
    const vy = (v - this.prevV) / dt;
    this.vy = vy;
    this.prevT = t; this.prevV = v;
    if (!this.armed) {
      // 친 뒤 가장 낮은 지점(bottom)에서 rearm 만큼 다시 들어 올리면 장전
      this.bottom = Math.max(this.bottom, v);
      if (this.bottom - v >= o.rearm || t - this.lastFire > 700) this.armed = true;
    }
    if (!this.armed) return null;
    let ev = null;
    if (vy > o.minVel && vy >= this.peak) {
      this.peak = vy;
    } else if (this.peak > 0) {
      if (vy < this.peak * o.decel) {
        if (t - this.lastFire >= o.refractoryMs) {
          ev = { t, vel: this.peak };
          this.armed = false; this.bottom = v; this.lastFire = t;
        }
        this.peak = 0;
      }
    }
    if (vy < 0) this.peak = 0;
    return ev;
  }
}

// ---------- 엔진 ----------
export class Engine {
  constructor(params = {}, calibration = null) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.setCalibration(calibration);
  }

  setCalibration(cal) {
    this.cal = cal ? JSON.parse(JSON.stringify(cal)) : null;
    const p = this.params;
    this.pads = (this.cal && this.cal.pads) ? this.cal.pads : PADS.map(x => ({ ...x }));
    this.swRef = this.cal ? this.cal.swRef : null;
    this.kickBase = this.cal ? this.cal.kickBase : null;
    this.hhBase = this.cal ? this.cal.hhBase : null;
    const kickLift = (this.cal && this.cal.kickLift) || DEFAULT_LIFT;
    const hhLift = (this.cal && this.cal.hhLift) || DEFAULT_LIFT;
    this.hhOpenAt = hhLift * p.hhOpenRatio;
    this.hhCloseAt = hhLift * p.hhCloseRatio;
    const handOpts = { minVel: p.handMinVel, decel: p.handDecel, rearm: p.handRearm, refractoryMs: p.handRefractoryMs };
    this.hands = {
      L: { det: new StrikeDetector(handOpts), fu: new OneEuro(p.filterMinCutoff, p.filterBeta), fv: new OneEuro(p.filterMinCutoff, p.filterBeta), tip: null, lost: true },
      R: { det: new StrikeDetector(handOpts), fu: new OneEuro(p.filterMinCutoff, p.filterBeta), fv: new OneEuro(p.filterMinCutoff, p.filterBeta), tip: null, lost: true },
    };
    this.kick = {
      det: new StrikeDetector({ minVel: p.footMinVel, decel: p.footDecel, rearm: kickLift * p.footRearmRatio, refractoryMs: p.footRefractoryMs }),
      f: new OneEuro(p.filterMinCutoff, p.filterBeta), v: null, lift: 0,
    };
    this.hh = { f: new OneEuro(p.filterMinCutoff, p.filterBeta), v: null, lift: 0, open: false, prevV: null, prevT: null, vy: 0 };
    this.anchor = null; // {x, y, sw} 픽셀
  }

  // 몸 좌표(u,v) → 화면 픽셀
  toScreen(u, v) {
    if (!this.anchor) return null;
    return { x: this.anchor.x + u * this.anchor.sw, y: this.anchor.y + v * this.anchor.sw };
  }

  classify(u, v) {
    let best = null, bd = Infinity;
    for (const pad of this.pads) {
      const d = Math.hypot(u - pad.u, v - pad.v);
      if (d < bd) { bd = d; best = pad; }
    }
    return bd <= this.params.padRadius ? best.id : null;
  }

  // frame = { t: ms, w, h, lm: [[x,y,vis] x33] }  → { events, view }
  process(frame) {
    const { t, w, h, lm } = frame;
    const p = this.params;
    const events = [];
    const P = (i) => {
      const a = lm[i];
      if (!a || a[2] < p.minVis) return null;
      return { x: (1 - a[0]) * w, y: a[1] * h };
    };
    // 어깨 기준점 (천천히 따라감)
    const ls = P(LM.L_SHOULDER), rs = P(LM.R_SHOULDER);
    if (ls && rs) {
      const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y);
      const cx = (ls.x + rs.x) / 2, cy = (ls.y + rs.y) / 2;
      if (sw > 5) {
        if (!this.anchor) this.anchor = { x: cx, y: cy, sw };
        else {
          const a = 0.08;
          this.anchor.x += a * (cx - this.anchor.x);
          this.anchor.y += a * (cy - this.anchor.y);
          this.anchor.sw += a * (sw - this.anchor.sw);
        }
        if (!this.swRef) this.swRef = sw;
      }
    }
    const view = { anchor: this.anchor, tips: {}, kickLift: 0, hhLift: 0, hhOpen: this.hh.open };
    if (!this.anchor || !this.swRef) return { events, view };
    const A = this.anchor, S = this.swRef, tSec = t / 1000;

    // 손 (가상 스틱 끝)
    for (const side of ['L', 'R']) {
      const H = this.hands[side];
      const wr = P(side === 'L' ? LM.L_WRIST : LM.R_WRIST);
      const el = P(side === 'L' ? LM.L_ELBOW : LM.R_ELBOW);
      if (!wr || !el) {
        if (!H.lost) { H.det.reset(); H.fu.reset(); H.fv.reset(); }
        H.lost = true; H.tip = null; continue;
      }
      H.lost = false;
      const tx = wr.x + (wr.x - el.x) * p.stickLen;
      const ty = wr.y + (wr.y - el.y) * p.stickLen;
      // 필터는 어깨너비 단위로 (사람 크기와 상관없이 같은 감도)
      const fx = H.fu.filter(tx / S, tSec) * S, fy = H.fv.filter(ty / S, tSec) * S;
      const u = (fx - A.x) / A.sw, v = (fy - A.y) / A.sw;
      H.tip = { x: fx, y: fy, u, v, wx: wr.x, wy: wr.y };
      view.tips[side] = H.tip;
      const hit = H.det.update(t, fy / S);
      if (hit) {
        const pad = this.classify(u, v);
        events.push({ kind: 'hand', hand: side, pad, t, vel: hit.vel, u, v, hhOpen: this.hh.open });
      }
    }

    // 발 높이 = 뒤꿈치와 발끝 평균 (없으면 발목)
    const footY = (heel, toe, ankle) => {
      const a = P(heel), b = P(toe);
      if (a && b) return (a.y + b.y) / 2;
      if (a) return a.y; if (b) return b.y;
      const c = P(ankle); return c ? c.y : null;
    };

    // 킥 = 오른발 들었다 내리기
    const ky = footY(LM.R_HEEL, LM.R_FOOT, LM.R_ANKLE);
    if (ky !== null) {
      const v = this.kick.f.filter(ky / S, tSec);
      if (this.kickBase === null || v > this.kickBase) this.kickBase = v; // 가장 낮은 위치 = 바닥
      this.kick.lift = this.kickBase - v;
      view.kickLift = this.kick.lift;
      const hit = this.kick.det.update(t, v);
      if (hit) events.push({ kind: 'kick', pad: 'kick', t, vel: hit.vel });
    } else { this.kick.det.reset(); this.kick.f.reset(); }

    // 하이햇 페달 = 왼발. 바닥에 붙이면 닫힘, 들면 열림
    const hy = footY(LM.L_HEEL, LM.L_FOOT, LM.L_ANKLE);
    if (hy !== null) {
      const v = this.hh.f.filter(hy / S, tSec);
      if (this.hhBase === null || v > this.hhBase) this.hhBase = v;
      const H = this.hh;
      if (H.prevT !== null && t > H.prevT) H.vy = (v - H.prevV) / ((t - H.prevT) / 1000);
      H.prevT = t; H.prevV = v;
      H.lift = this.hhBase - v;
      view.hhLift = H.lift;
      if (!H.open && H.lift > this.hhOpenAt) {
        H.open = true; events.push({ kind: 'pedal', pad: 'hhOpen', t, vel: Math.max(0, -H.vy) });
      } else if (H.open && H.lift < this.hhCloseAt) {
        H.open = false; events.push({ kind: 'pedal', pad: 'hhClose', t, vel: Math.max(0, H.vy) });
      }
      view.hhOpen = H.open;
    } else { this.hh.f.reset(); this.hh.prevT = null; }

    return { events, view };
  }
}

// 이벤트 → 채점용 라벨
export function eventLabel(ev) {
  if (ev.kind === 'hand') return ev.pad; // null 이면 "패드 밖"
  return ev.pad; // kick, hhOpen, hhClose
}

// 녹화된 프레임 전체를 엔진에 다시 넣어 이벤트 재현 (학습/검증 평가용)
export function replay(report, params) {
  const eng = new Engine(params || report.params, report.calibration || null);
  const W = report.device.width, H = report.device.height;
  const out = [];
  for (const row of report.frames.data) {
    const lm = [];
    for (let i = 0; i < 33; i++) lm.push([row[2 + i * 3], row[3 + i * 3], row[4 + i * 3]]);
    const { events } = eng.process({ t: row[0], w: W, h: H, lm });
    for (const e of events) out.push(e);
  }
  return out;
}
