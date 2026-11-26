// 테스트 순서(가이드)와 채점. 브라우저·Node 공용.

export const TARGET_NAMES = {
  snare: '스네어', hihat: '하이햇', tom: '탐', floor: '플로어탐', crash: '크래시', ride: '라이드',
  kick: '킥 (오른발 들었다 내리기)', hhOpen: '하이햇 열기 (왼발 들기)', hhClose: '하이햇 닫기 (왼발 내리기)',
};

// 가이드 테스트 순서. t = 테스트 시작(첫 박 카운트) 기준 ms, 박자에 맞춰 소리가 들리는 시각
export const PROTOCOL_VERSION = 2;
export function buildProtocol(bpm = 60) {
  const beat = 60000 / bpm;
  const expected = [];
  const sections = [];
  let t = 4 * beat; // 카운트 4박
  const block = (label, targets, n) => {
    sections.push({ t, label });
    for (let i = 0; i < n; i++) { for (const g of targets) expected.push({ t, target: g }); t += beat; }
    t += 2 * beat;
  };
  block('스네어 8번', ['snare'], 8);
  block('하이햇 8번', ['hihat'], 8);
  // 빠른 연타: 8분음표 (박자의 절반 간격)
  sections.push({ t, label: '하이햇 빠르게 16번 (8분음표)' });
  for (let i = 0; i < 16; i++) { expected.push({ t, target: 'hihat' }); t += beat / 2; }
  t += 2 * beat;
  sections.push({ t, label: '하이햇·스네어 번갈아 16번 (8분음표)' });
  for (let i = 0; i < 16; i++) { expected.push({ t, target: i % 2 ? 'snare' : 'hihat' }); t += beat / 2; }
  t += 2 * beat;
  block('탐 4번', ['tom'], 4);
  block('플로어탐 4번', ['floor'], 4);
  block('크래시 4번', ['crash'], 4);
  block('라이드 4번', ['ride'], 4);
  block('킥 8번 (오른발 들었다 내리기)', ['kick'], 8);
  sections.push({ t, label: '하이햇 페달 4번 (왼발 들기 → 내리기)' });
  for (let i = 0; i < 4; i++) {
    expected.push({ t, target: 'hhOpen' }); t += beat;
    expected.push({ t, target: 'hhClose' }); t += beat;
  }
  t += 2 * beat;
  sections.push({ t, label: '8비트 2마디 (하이햇 8분음표 + 킥·스네어)' });
  for (let bar = 0; bar < 2; bar++) {
    for (let b = 0; b < 4; b++) {
      expected.push({ t, target: 'hihat' });
      expected.push({ t, target: b % 2 === 0 ? 'kick' : 'snare' });
      expected.push({ t: t + beat / 2, target: 'hihat' });
      t += beat;
    }
  }
  t += 2 * beat;
  return { version: PROTOCOL_VERSION, bpm, beatMs: beat, countIn: 4, expected, sections, durationMs: t };
}

// 채점: 기대 타격 ↔ 감지 타격 맞추기
// detected: [{t, label}]  (t = 테스트 시작 기준 ms)
export function score(expected, detected, opts = {}) {
  const win = opts.windowMs ?? 350;
  const until = opts.untilMs ?? Infinity;
  const exp = expected.filter(e => e.t <= until).map((e, i) => ({ ...e, i }));
  const det = detected.filter(d => d.t <= until + win).map((d, i) => ({ ...d, i, used: false }));
  const results = [];
  const offsets = [];
  // 1차: 같은 종류 중 가장 가까운 것
  const matched = new Array(exp.length).fill(null);
  const pairs = [];
  exp.forEach((e, ei) => det.forEach((d, di) => {
    const dt = d.t - e.t;
    if (Math.abs(dt) <= win && d.label === e.target) pairs.push({ ei, di, dt });
  }));
  pairs.sort((a, b) => Math.abs(a.dt) - Math.abs(b.dt));
  for (const pr of pairs) {
    if (matched[pr.ei] || det[pr.di].used) continue;
    matched[pr.ei] = { type: 'correct', di: pr.di, dt: pr.dt };
    det[pr.di].used = true;
  }
  // 2차: 못 맞춘 것 중 시간 안에 다른 드럼이 울렸으면 "잘못 친 드럼"
  const isPad = (x) => !['kick', 'hhOpen', 'hhClose'].includes(x);
  exp.forEach((e, ei) => {
    if (matched[ei]) return;
    let best = null;
    det.forEach((d, di) => {
      if (d.used) return;
      const dt = d.t - e.t;
      if (Math.abs(dt) > win) return;
      if (isPad(e.target) !== isPad(d.label ?? 'none')) return;
      if (!best || Math.abs(dt) < Math.abs(best.dt)) best = { di, dt };
    });
    if (best) { matched[ei] = { type: 'wrong', di: best.di, dt: best.dt, got: det[best.di].label }; det[best.di].used = true; }
    else matched[ei] = { type: 'miss' };
  });
  const per = {};
  const confusion = {};
  exp.forEach((e, ei) => {
    const m = matched[ei];
    per[e.target] ??= { expected: 0, correct: 0, wrong: 0, miss: 0 };
    per[e.target].expected++;
    per[e.target][m.type]++;
    if (m.type === 'correct') offsets.push(m.dt);
    if (m.type === 'wrong') { const k = `${e.target}→${m.got ?? '패드 밖'}`; confusion[k] = (confusion[k] || 0) + 1; }
    results.push({ t: e.t, target: e.target, result: m.type, dt: m.dt ?? null, got: m.got ?? null });
  });
  const extras = det.filter(d => !d.used).map(d => ({ t: d.t, label: d.label }));
  const correct = results.filter(r => r.result === 'correct').length;
  const nExp = exp.length;
  const nDet = det.length;
  const recall = nExp ? correct / nExp : 0;
  const precision = nDet ? correct / nDet : 0;
  const f1 = (precision + recall) ? 2 * precision * recall / (precision + recall) : 0;
  const mean = offsets.length ? offsets.reduce((a, b) => a + b, 0) / offsets.length : null;
  const sd = offsets.length > 1 ? Math.sqrt(offsets.reduce((a, b) => a + (b - mean) ** 2, 0) / (offsets.length - 1)) : null;
  return {
    expected: nExp, detected: nDet, correct,
    wrong: results.filter(r => r.result === 'wrong').length,
    miss: results.filter(r => r.result === 'miss').length,
    extra: extras.length,
    recall, precision, f1,
    timingMeanMs: mean, timingSdMs: sd,
    perTarget: per, confusion, results, extras,
  };
}

// 엔진 이벤트 → 채점 입력
export function eventsToDetected(events, t0 = 0) {
  return events.map(e => ({ t: e.t - t0, label: e.pad ?? null }));
}
