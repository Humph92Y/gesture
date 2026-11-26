#!/usr/bin/env node
// 학습/검증 분리 평가 도구
//
//   node tools/evaluate.mjs [보고서폴더 또는 파일...]         현재 설정으로 학습·검증 각각 채점
//   node tools/evaluate.mjs --tune [보고서...]                학습 데이터로만 설정값 찾기 → 검증 데이터로 정확도 확인
//   node tools/evaluate.mjs --synth                            가짜 데이터로 엔진 자체 점검
//
// 원칙: 설정값(감도 등)은 "학습" 보고서로만 고르고, 정확도는 그 설정을 한 번도 본 적 없는 "검증" 보고서로만 판단한다.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PARAMS, replay } from '../js/engine.js';
import { score, eventsToDetected, buildProtocol } from '../js/scoring.js';
import { synthReport } from './synth.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const inputs = args.filter(a => !a.startsWith('--'));

function loadReports(paths) {
  const out = [];
  const add = (obj, src) => {
    if (Array.isArray(obj)) obj.forEach(o => add(o, src));
    else if (obj && obj.reports) add(obj.reports, src);
    else if (obj && obj.format === 'airdrum-report') out.push({ ...obj, _src: src });
  };
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const st = fs.statSync(p);
    const files = st.isDirectory() ? fs.readdirSync(p).filter(f => f.endsWith('.json')).map(f => path.join(p, f)) : [p];
    for (const f of files) { try { add(JSON.parse(fs.readFileSync(f, 'utf8')), f); } catch (e) { console.error('읽기 실패:', f, e.message); } }
  }
  return out;
}

function evalReport(rep, params) {
  const events = replay(rep, params);
  const det = eventsToDetected(events, 0);
  const until = rep.recordedUntilMs ?? rep.protocol.durationMs;
  return score(rep.protocol.expected, det, { untilMs: until });
}

function evalSet(reps, params) {
  if (!reps.length) return null;
  let c = 0, e = 0, d = 0;
  const rows = reps.map(r => { const s = evalReport(r, params); c += s.correct; e += s.expected; d += s.detected; return { id: r.id, s }; });
  const recall = e ? c / e : 0, precision = d ? c / d : 0;
  return { rows, recall, precision, f1: (recall + precision) ? 2 * recall * precision / (recall + precision) : 0 };
}

const pct = x => (x * 100).toFixed(1) + '%';
function printSet(name, res) {
  if (!res) { console.log(`\n[${name}] 보고서 없음`); return; }
  console.log(`\n[${name}] 보고서 ${res.rows.length}개 · 인식률 ${pct(res.recall)} · 정밀도 ${pct(res.precision)} · F1 ${pct(res.f1)}`);
  for (const { id, s } of res.rows) {
    console.log(`  - ${id}: 맞음 ${s.correct}/${s.expected}, 잘못친드럼 ${s.wrong}, 놓침 ${s.miss}, 헛울림 ${s.extra}, 타이밍 ${s.timingMeanMs?.toFixed(0) ?? '-'}±${s.timingSdMs?.toFixed(0) ?? '-'}ms`);
    const per = Object.entries(s.perTarget).map(([k, v]) => `${k} ${v.correct}/${v.expected}`).join(', ');
    console.log(`      ${per}`);
  }
}

// 학습 데이터로만 격자 탐색
const GRID = {
  handMinVel: [1.5, 2.2, 3.0, 4.0],
  handDecel: [0.6, 0.8, 0.9],
  handMinStroke: [0.1, 0.2, 0.3],
  gripBlend: [0.6, 0.85, 1.0],
  footMinVel: [0.8, 1.2, 1.8],
  footRearmRatio: [0.25, 0.4, 0.6],
  hhOpenRatio: [0.35, 0.5, 0.7],
};
function tune(train, base) {
  let best = { f1: -1, params: base };
  const keys = Object.keys(GRID);
  const rec = (i, cur) => {
    if (i === keys.length) {
      const p = { ...cur, hhCloseRatio: cur.hhOpenRatio / 2 };
      const r = evalSet(train, p);
      if (r.f1 > best.f1) best = { f1: r.f1, params: p };
      return;
    }
    for (const v of GRID[keys[i]]) rec(i + 1, { ...cur, [keys[i]]: v });
  };
  rec(0, { ...base });
  return best;
}

let reports;
if (flags.has('--synth')) {
  const proto = buildProtocol(60);
  // 손목으로 치는 동작(기본) + 팔 전체로 치는 동작 둘 다 섞어서 점검
  reports = [1, 2, 3, 4].map(s => synthReport({ protocol: proto, seed: s, noisePx: 2, style: s % 2 ? 'wrist' : 'arm', split: s <= 2 ? 'training' : 'validation' }));
} else {
  reports = loadReports(inputs.length ? inputs : ['test-reports']);
}
if (!reports.length) { console.log('보고서가 없습니다. test-reports/ 폴더에 앱에서 내보낸 JSON을 넣어 주세요.'); process.exit(0); }

const train = reports.filter(r => r.split === 'training');
const valid = reports.filter(r => r.split === 'validation');
console.log(`보고서: 학습 ${train.length}개 / 검증 ${valid.length}개`);

let params = { ...DEFAULT_PARAMS };
if (flags.has('--tune')) {
  if (!train.length) { console.log('학습 보고서가 없어 설정값을 찾을 수 없습니다.'); process.exit(1); }
  const best = tune(train, params);
  params = best.params;
  console.log('\n학습 데이터로 고른 설정값:', JSON.stringify(Object.fromEntries(Object.keys(GRID).map(k => [k, params[k]]))));
  fs.writeFileSync('tools/tuned-params.json', JSON.stringify(params, null, 2));
}
printSet('학습 (설정 고르는 데 사용)', evalSet(train, params));
printSet('검증 (정확도 판단용, 설정 고를 때 안 봄)', evalSet(valid, params));
if (flags.has('--synth')) {
  const v = evalSet(valid, params);
  if (v.f1 < 0.9) { console.error('\n자체 점검 실패: 검증 F1 < 90%'); process.exit(1); }
  console.log('\n자체 점검 통과');
}
