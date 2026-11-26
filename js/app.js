import { Engine, DEFAULT_PARAMS, PADS, LM, ENGINE_VERSION } from './engine.js';
import { DrumAudio, PAD_SOUND } from './audio.js';
import { buildProtocol, score, eventsToDetected, TARGET_NAMES } from './scoring.js';
import * as store from './storage.js';

const APP_VERSION = '0.1.0';
const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const WASM = MP_BASE + '/wasm';
const MODELS = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
};
const PAD_COLORS = { hihat: '#f0b429', snare: '#4f8cff', tom: '#33c27f', floor: '#2bb3a6', crash: '#ef5b5b', ride: '#b07cff' };

const $ = (id) => document.getElementById(id);
const video = $('video'), canvas = $('canvas'), g = canvas.getContext('2d');
$('ver').textContent = `v${APP_VERSION} · 엔진 ${ENGINE_VERSION}`;

// ---------- 상태 ----------
let params = { ...DEFAULT_PARAMS, ...store.lsGet('airdrum.params', {}) };
let calibration = store.lsGet('airdrum.calibration', null);
let engine = new Engine(params, calibration);
const audio = new DrumAudio();
let landmarker = null, landmarkerModel = null, fileset = null;
let stream = null, cam = { label: '', width: 0, height: 0, fps: 0 };
let running = false, lastTs = 0, lastLm = null, lastView = null;
const flashes = {};                 // padId → {t, vel}
const perf = { frames: [], infer: [], proc: [] };
let test = null, calib = null, lastEvent = null;

// ---------- 카메라 ----------
async function listCameras() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const sel = $('camSelect'), cur = sel.value;
    sel.innerHTML = '<option value="">기본 카메라</option>' + devs.map((d, i) => `<option value="${d.deviceId}">${d.label || '카메라 ' + (i + 1)}</option>`).join('');
    if (cur) sel.value = cur;
  } catch { /* 권한 전 */ }
}

// ?sim=1 : 사람 대신 가짜 동작 데이터로 화면·소리·보고서 전체 흐름 점검 (개발용)
const SIM = new URLSearchParams(location.search).has('sim');
async function simLandmarker() {
  const { synthReport } = await import('../tools/synth.mjs');
  const rep = synthReport({ protocol: buildProtocol(+$('bpmSelect').value), fps: 60, w: 640, h: 480, jitterMs: 25 });
  const rows = rep.frames.data;
  const toLm = (row) => ({ landmarks: [Array.from({ length: 33 }, (_, i) => ({ x: row[2 + i * 3], y: row[3 + i * 3], visibility: row[4 + i * 3] }))] });
  return { detectForVideo() {
    const tr = test ? performance.now() - test.t0 : -1;
    const i = tr < 0 ? 0 : Math.min(rows.length - 1, Math.round(tr / (1000 / 60)));
    return toLm(rows[i]);
  }, close() {} };
}

async function ensureLandmarker() {
  const model = $('modelSelect').value;
  if (landmarker && landmarkerModel === model) return;
  if (SIM) { landmarker = await simLandmarker(); landmarkerModel = 'sim'; return; }
  $('camInfo').textContent = '인식 모델 불러오는 중… (처음엔 10초쯤 걸릴 수 있어요)';
  const { FilesetResolver, PoseLandmarker } = await import(MP_BASE + '/vision_bundle.mjs');
  fileset ??= await FilesetResolver.forVisionTasks(WASM);
  if (landmarker) { landmarker.close(); landmarker = null; }
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODELS[model], delegate },
    runningMode: 'VIDEO', numPoses: 1,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  try { landmarker = await PoseLandmarker.createFromOptions(fileset, opts('GPU')); }
  catch { landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
  landmarkerModel = model;
}

async function startCamera() {
  $('btnCam').disabled = true;
  try {
    await audio.init(); // 버튼 누를 때 소리 장치 켜기 (브라우저 규칙)
    if (stream) stream.getTracks().forEach(t => t.stop());
    const deviceId = $('camSelect').value;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
        width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 },
      },
    });
    video.srcObject = stream;
    await video.play();
    const track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    cam = { label: track.label, width: video.videoWidth || s.width, height: video.videoHeight || s.height, fps: s.frameRate || 0 };
    canvas.width = cam.width; canvas.height = cam.height;
    await listCameras();
    if (track.getSettings().deviceId) $('camSelect').value = track.getSettings().deviceId;
    await ensureLandmarker();
    $('placeholder').hidden = true;
    $('camInfo').textContent = `${cam.label || '카메라'} · ${cam.width}×${cam.height} · 최대 ${Math.round(cam.fps)}fps 요청됨`;
    $('btnCam').textContent = '카메라 다시 켜기';
    $('btnCalib').disabled = false; $('btnTest').disabled = false;
    engine = new Engine(params, calibration);
    if (!running) { running = true; scheduleFrame(); }
  } catch (e) {
    console.error(e);
    $('camInfo').textContent = '카메라를 켜지 못했어요: ' + (e.message || e) + ' (브라우저 주소창의 카메라 권한을 확인해 주세요)';
  } finally { $('btnCam').disabled = false; }
}

function scheduleFrame() {
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) video.requestVideoFrameCallback(onFrame);
  else requestAnimationFrame((now) => onFrame(now, null));
}

// ---------- 프레임 처리 (지연에 가장 중요한 부분) ----------
function onFrame(now, meta) {
  if (!running) return;
  try {
    if (video.readyState >= 2 && landmarker) {
      const pnow = performance.now();
      let frameTime = pnow;
      if (meta && typeof meta.captureTime === 'number' && pnow - meta.captureTime >= 0 && pnow - meta.captureTime < 500) frameTime = meta.captureTime;
      const ts = Math.max(lastTs + 1, Math.round(pnow));
      lastTs = ts;
      const t0 = performance.now();
      const res = landmarker.detectForVideo(video, ts);
      const inferMs = performance.now() - t0;
      const raw = res.landmarks && res.landmarks[0];
      const lm = raw ? raw.map(p => [p.x, p.y, p.visibility ?? 1]) : null;
      lastLm = lm;
      perf.frames.push(pnow); while (perf.frames.length && pnow - perf.frames[0] > 2000) perf.frames.shift();
      perf.infer.push(inferMs); if (perf.infer.length > 60) perf.infer.shift();
      if (test) { test.frameTimes.push(frameTime - test.t0); test.infers.push(inferMs); if (!lm) test.noPerson++; }
      if (lm) {
        const out = engine.process({ t: frameTime, w: cam.width, h: cam.height, lm });
        lastView = out.view;
        for (const ev of out.events) handleEvent(ev, frameTime);
        if (test) recordFrame(frameTime, inferMs, lm);
        if (calib) calibStep(lm, out.view, frameTime);
      } else if (calib) calibStep(null, null, frameTime);
      draw(lm);
      updateStats();
      if (test) testTick();
    }
  } catch (e) { console.error(e); }
  scheduleFrame();
}

function velTo01(ev) {
  const min = ev.kind === 'kick' ? params.footMinVel : params.handMinVel;
  return Math.max(0, Math.min(1, (ev.vel - min) / (min * 3)));
}

function handleEvent(ev, frameTime) {
  // 1) 소리를 가장 먼저
  const v01 = velTo01(ev);
  const calibPad = calib && calib.step === 'pads' && ev.kind === 'hand' ? PADS[calib.idx] : null;
  if (calibPad) audio.play(calibPad.id === 'hihat' ? 'hihatClosed' : PAD_SOUND[calibPad.id], v01);
  else if (ev.kind === 'hand' && ev.pad) {
    if (ev.pad === 'hihat') audio.play(ev.hhOpen ? 'hihatOpen' : 'hihatClosed', v01);
    else audio.play(PAD_SOUND[ev.pad], v01);
  } else if (ev.kind === 'kick') audio.play('kick', v01);
  else if (ev.kind === 'pedal' && ev.pad === 'hhClose') { audio.chokeOpen(); audio.play('hihatPedal', 0.6); }
  const detectedAt = performance.now();
  // 2) 기록·화면
  const procMs = detectedAt - frameTime;
  perf.proc.push(procMs); if (perf.proc.length > 60) perf.proc.shift();
  flashes[ev.pad ?? 'miss'] = { t: detectedAt, vel: v01, u: ev.u, v: ev.v };
  lastEvent = ev;
  const name = ev.pad ? (TARGET_NAMES[ev.pad] || ev.pad).split(' ')[0] : '패드 밖';
  $('stLast').textContent = `${name}${ev.hand ? ' (' + (ev.hand === 'L' ? '왼손' : '오른손') + ')' : ''}`;
  if (test) test.detected.push({ t: ev.t - test.t0, label: ev.pad ?? null, kind: ev.kind, hand: ev.hand ?? null, vel: +ev.vel.toFixed(2), procMs: +procMs.toFixed(1), u: ev.u != null ? +ev.u.toFixed(3) : null, v: ev.v != null ? +ev.v.toFixed(3) : null });
  if (calib && calib.step === 'pads' && ev.kind === 'hand') { calib.hits.push({ u: ev.u, v: ev.v }); }
}

// ---------- 그리기 ----------
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32]];
function draw(lm) {
  const W = canvas.width, H = canvas.height, now = performance.now();
  g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(video, 0, 0, W, H); g.restore();
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 0, W, H);
  const P = (i) => lm && lm[i] && lm[i][2] > 0.3 ? { x: (1 - lm[i][0]) * W, y: lm[i][1] * H } : null;
  // 뼈대
  g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 2;
  for (const [a, b] of BONES) { const A = P(a), B = P(b); if (A && B) { g.beginPath(); g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.stroke(); } }
  const A = engine.anchor;
  if (A) {
    // 드럼 패드
    const targetPads = test ? upcomingTargets() : {};
    const calibPad = calib && calib.step === 'pads' ? PADS[calib.idx]?.id : null;
    for (const pad of engine.pads) {
      const c = engine.toScreen(pad.u, pad.v), r = A.sw * 0.42;
      const f = flashes[pad.id]; const fa = f ? Math.max(0, 1 - (now - f.t) / 180) : 0;
      g.beginPath(); g.ellipse(c.x, c.y, r, r * 0.55, 0, 0, Math.PI * 2);
      g.fillStyle = hexA(PAD_COLORS[pad.id], 0.18 + 0.7 * fa * (0.4 + 0.6 * (f?.vel ?? 0)));
      g.fill(); g.lineWidth = calibPad === pad.id ? 4 : 2; g.strokeStyle = hexA(PAD_COLORS[pad.id], calibPad === pad.id ? 1 : 0.8); g.stroke();
      g.fillStyle = '#fff'; g.font = `${Math.max(11, A.sw * 0.17)}px sans-serif`; g.textAlign = 'center';
      g.fillText(pad.name, c.x, c.y + 4);
      const tp = targetPads[pad.id];
      if (tp != null) { // 다음 칠 드럼: 줄어드는 고리
        g.beginPath(); g.ellipse(c.x, c.y, r * (1 + 1.5 * (1 - tp)), r * 0.55 * (1 + 1.5 * (1 - tp)), 0, 0, Math.PI * 2);
        g.strokeStyle = `rgba(255,255,255,${0.3 + 0.7 * tp})`; g.lineWidth = 3; g.stroke();
      }
    }
    // 패드 밖 타격 표시
    const fm = flashes.miss;
    if (fm && now - fm.t < 250 && fm.u != null) { const c = engine.toScreen(fm.u, fm.v); g.beginPath(); g.arc(c.x, c.y, A.sw * 0.15, 0, 7); g.strokeStyle = 'rgba(180,180,180,.8)'; g.stroke(); }
    // 가상 스틱
    for (const side of ['L', 'R']) {
      const tip = lastView?.tips?.[side]; if (!tip) continue;
      g.strokeStyle = '#ffd27a'; g.lineWidth = 5; g.beginPath(); g.moveTo(tip.wx, tip.wy); g.lineTo(tip.x, tip.y); g.stroke();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(tip.x, tip.y, 6, 0, 7); g.fill();
    }
  }
  // 발 표시: 화면 왼쪽 아래 = 왼발(하이햇), 오른쪽 아래 = 오른발(킥)
  if (lastView) {
    drawMeter(16, H - 16, '하이햇 페달', lastView.hhLift, engine.hhOpenAt, lastView.hhOpen ? '열림' : '닫힘', lastView.hhOpen ? '#f0b429' : '#888', targetPadsFoot('hh'));
    const fk = flashes.kick; const ka = fk ? Math.max(0, 1 - (now - fk.t) / 200) : 0;
    drawMeter(W - 136, H - 16, '킥', lastView.kickLift, engine.kick.det.o.rearm, ka > 0 ? '쿵!' : '', ka > 0 ? '#ef5b5b' : '#888', targetPadsFoot('kick'));
  }
  // 상태 글자
  g.fillStyle = 'rgba(255,255,255,.75)'; g.font = '12px sans-serif'; g.textAlign = 'left';
  if (!lm) { g.fillStyle = '#f0b429'; g.font = '16px sans-serif'; g.fillText('사람이 안 보여요. 온몸이 나오게 서 주세요.', 16, 28); }
}
function drawMeter(x, y, label, lift, thr, state, color, target) {
  const w = 120, h = 60, max = Math.max(0.3, thr * 2.5);
  g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x, y - h, w, h);
  if (target != null) { g.strokeStyle = `rgba(255,255,255,${0.3 + 0.7 * target})`; g.lineWidth = 3; g.strokeRect(x - 2, y - h - 2, w + 4, h + 4); }
  const bh = Math.max(0, Math.min(1, lift / max)) * (h - 22);
  g.fillStyle = color; g.fillRect(x + 8, y - 6 - bh, 16, bh);
  const ty = y - 6 - Math.min(1, thr / max) * (h - 22);
  g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.moveTo(x + 4, ty); g.lineTo(x + 28, ty); g.stroke();
  g.fillStyle = '#fff'; g.font = '13px sans-serif'; g.textAlign = 'left';
  g.fillText(label, x + 34, y - h + 18); g.fillStyle = color; g.font = 'bold 15px sans-serif'; g.fillText(state, x + 34, y - 14);
}
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }

// ---------- 실시간 상태 ----------
let statTick = 0;
function updateStats() {
  if (++statTick % 10) return;
  const f = perf.frames, fps = f.length > 1 ? (f.length - 1) / ((f[f.length - 1] - f[0]) / 1000) : 0;
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const inf = avg(perf.infer), proc = avg(perf.proc), al = audio.latencyMs();
  const aMs = al ? al.base + al.output : null;
  $('stFps').textContent = fps ? fps.toFixed(0) : '-';
  $('stInfer').textContent = inf != null ? inf.toFixed(0) + 'ms' : '-';
  $('stProc').textContent = proc != null ? proc.toFixed(0) + 'ms' : '(타격하면 표시)';
  $('stAudio').textContent = aMs != null ? aMs.toFixed(0) + 'ms' : '-';
  const frameGap = fps ? 1000 / fps : 0;
  $('stTotal').textContent = proc != null && aMs != null ? `약 ${(proc + aMs).toFixed(0)}ms` : '-';
  const warns = [];
  if (fps && fps < 24) warns.push(`화면 수가 낮아요(${fps.toFixed(0)}). 방을 밝게 하면 카메라가 빨라집니다.`);
  if (inf && inf > frameGap) warns.push('AI 계산이 화면 속도를 못 따라가요. "빠른 모델"을 쓰세요.');
  $('stWarn').textContent = warns.join(' ');
}

// ---------- 캘리브레이션 ----------
const NEED = [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_WRIST, LM.R_WRIST, LM.L_ANKLE, LM.R_ANKLE, LM.L_HEEL, LM.R_HEEL, LM.L_FOOT, LM.R_FOOT];
function startCalib() {
  calib = { step: 'pose', since: null, samples: [], idx: 0, hits: [], pads: engine.pads.map(p => ({ ...p })), strokes: [], cur: 0, inStroke: false, partial: {} };
  $('btnCalibSkip').hidden = false; $('btnCalibCancel').hidden = false; $('btnCalib').disabled = true; $('btnTest').disabled = true;
  renderCalibSteps();
}
function endCalib(save) {
  if (save) {
    calibration = { ...calib.partial, pads: calib.pads, createdAt: new Date().toISOString() };
    store.lsSet('airdrum.calibration', calibration);
    engine = new Engine(params, calibration);
    setPrompt('캘리브레이션 완료!', '자유롭게 쳐 보시고, 준비되면 "테스트 시작"을 누르세요.', 2500);
  } else setPrompt(null);
  calib = null;
  $('btnCalibSkip').hidden = true; $('btnCalibCancel').hidden = true; $('btnCalib').disabled = false; $('btnTest').disabled = false;
  renderCalibSteps();
}
function renderCalibSteps() {
  const order = ['pose', 'still', 'pads', 'kick', 'hh'];
  const cur = calib ? order.indexOf(calib.step) : -1;
  document.querySelectorAll('#calibSteps li').forEach(li => {
    const i = order.indexOf(li.dataset.s);
    li.className = calib ? (i < cur ? 'done' : i === cur ? 'now' : '') : '';
  });
  $('calibInfo').textContent = calibration ? `저장된 캘리브레이션: ${new Date(calibration.createdAt).toLocaleString()}` : '아직 캘리브레이션 전 (기본 배치 사용 중)';
}
function nextCalib(step) { calib.step = step; calib.since = null; calib.samples = []; calib.strokes = []; calib.inStroke = false; calib.cur = 0; renderCalibSteps(); }
function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

function calibStep(lm, view, t) {
  const c = calib;
  if (c.step === 'pose') {
    const missing = !lm ? NEED : NEED.filter(i => !(lm[i] && lm[i][2] > 0.5 && lm[i][1] > 0.01 && lm[i][1] < 0.99));
    if (missing.length) {
      c.since = null;
      const feet = missing.some(i => i >= 27);
      setPrompt(feet ? '발이 화면에 보이도록 해 주세요' : '온몸이 화면에 나오게 서 주세요', feet ? '한 걸음 뒤로 가거나 카메라를 조금 아래로 기울여 주세요' : '머리부터 발끝까지 보여야 해요');
    } else {
      c.since ??= t;
      setPrompt('좋아요! 그대로 서 계세요', `${Math.max(0, 1 - (t - c.since) / 1000).toFixed(1)}초`);
      if (t - c.since > 1000) nextCalib('still');
    }
  } else if (c.step === 'still') {
    c.since ??= t;
    const remain = 3000 - (t - c.since);
    setPrompt('양발을 바닥에 붙이고 가만히 서 주세요', `주먹은 스틱 쥔 것처럼 편하게 · ${Math.max(0, remain / 1000).toFixed(1)}초`);
    if (lm) {
      const W = cam.width, H = cam.height, px = (i) => ({ x: (1 - lm[i][0]) * W, y: lm[i][1] * H });
      const ls = px(LM.L_SHOULDER), rs = px(LM.R_SHOULDER);
      const fy = (a, b) => (px(a).y + px(b).y) / 2;
      c.samples.push({ sw: Math.hypot(ls.x - rs.x, ls.y - rs.y), ky: fy(LM.R_HEEL, LM.R_FOOT), hy: fy(LM.L_HEEL, LM.L_FOOT) });
    }
    if (remain <= 0) {
      if (c.samples.length < 10) { c.since = null; c.samples = []; return; }
      const swRef = median(c.samples.map(s => s.sw));
      c.partial = { swRef, kickBase: median(c.samples.map(s => s.ky)) / swRef, hhBase: median(c.samples.map(s => s.hy)) / swRef };
      engine = new Engine(params, { ...c.partial, pads: c.pads });
      nextCalib('pads'); c.idx = 0; c.hits = [];
    }
  } else if (c.step === 'pads') {
    const pad = PADS[c.idx];
    if (!pad) { nextCalib('kick'); return; }
    setPrompt(`${pad.name} 자리에서 3번 쳐 보세요 (${c.hits.length}/3)`, '원하는 높이·위치에서 주먹을 들었다 내려치세요. 지금 표시된 자리를 그대로 쓰려면 "건너뛰기"');
    if (c.hits.length >= 3) {
      const u = c.hits.reduce((a, h) => a + h.u, 0) / c.hits.length, v = c.hits.reduce((a, h) => a + h.v, 0) / c.hits.length;
      const p = c.pads.find(x => x.id === pad.id); p.u = +u.toFixed(3); p.v = +v.toFixed(3);
      engine.pads = c.pads;
      c.idx++; c.hits = [];
    }
  } else if (c.step === 'kick' || c.step === 'hh') {
    const lift = view ? (c.step === 'kick' ? view.kickLift : view.hhLift) : 0;
    const n = c.strokes.length;
    setPrompt(c.step === 'kick' ? `오른발을 들었다 내려 놓으세요 (${n}/3)` : `왼발을 들었다 내려 놓으세요 (${n}/3)`,
      c.step === 'kick' ? '킥을 칠 때처럼 편한 높이로' : '하이햇을 열 때처럼 편한 높이로 (바닥 = 닫힘, 들기 = 열림)');
    if (!c.inStroke && lift > 0.06) { c.inStroke = true; c.cur = lift; }
    if (c.inStroke) { c.cur = Math.max(c.cur, lift); if (lift < 0.03) { c.inStroke = false; c.strokes.push(c.cur); } }
    if (c.strokes.length >= 3) {
      const avg = c.strokes.reduce((a, b) => a + b, 0) / c.strokes.length;
      if (c.step === 'kick') { c.partial.kickLift = +avg.toFixed(3); nextCalib('hh'); }
      else { c.partial.hhLift = +avg.toFixed(3); endCalib(true); }
    }
  }
}
function skipCalibStep() {
  if (!calib) return;
  const c = calib;
  if (c.step === 'pose') nextCalib('still');
  else if (c.step === 'still') { c.since = -1e9; }
  else if (c.step === 'pads') { c.idx++; c.hits = []; if (c.idx >= PADS.length) nextCalib('kick'); }
  else if (c.step === 'kick') nextCalib('hh');
  else endCalib(true);
}

let promptTimer = null;
function setPrompt(big, small = '', autoHideMs = 0) {
  clearTimeout(promptTimer);
  if (!big) { $('prompt').hidden = true; return; }
  $('prompt').hidden = false; $('promptBig').textContent = big; $('promptSmall').textContent = small;
  $('promptSmall').hidden = !small;
  if (autoHideMs) promptTimer = setTimeout(() => { if (!test && !calib) $('prompt').hidden = true; }, autoHideMs);
}

// ---------- 테스트 ----------
async function nextSplit() {
  const sel = $('splitSelect').value;
  if (sel !== 'auto') return sel;
  const reps = await store.listReports();
  const nt = reps.filter(r => r.split === 'training').length, nv = reps.filter(r => r.split === 'validation').length;
  return nt <= nv ? 'training' : 'validation';
}

async function startTest() {
  if (test || !landmarker) return;
  await audio.init();
  const split = await nextSplit();
  const bpm = +$('bpmSelect').value;
  const protocol = buildProtocol(bpm);
  const al = audio.latencyMs();
  const lead = 1.0;
  const ctxNow = audio.ctx.currentTime, perfNow = performance.now();
  const t0 = perfNow + lead * 1000 + (al.base + al.output); // 첫 박 소리가 귀에 들리는 시각
  const clicks = [];
  const sectionStarts = new Set(protocol.sections.map(s => Math.round(s.t)));
  for (let i = 0; i * protocol.beatMs <= protocol.durationMs; i++) {
    const tb = i * protocol.beatMs;
    clicks.push(audio.click(ctxNow + lead + tb / 1000, i === 0 || sectionStarts.has(Math.round(tb))));
  }
  test = { t0, split, protocol, frames: [], frameTimes: [], infers: [], noPerson: 0, detected: [], clicks, startedAt: new Date().toISOString(), perfStart: perf.frames.length };
  $('btnTest').disabled = true; $('btnStop').disabled = false; $('btnCalib').disabled = true;
  $('lastResult').textContent = `테스트 중 (${split === 'training' ? '학습용' : '검증용'}) … 끝까지 하면 자동 저장됩니다.`;
}

function recordFrame(frameTime, inferMs, lm) {
  const row = [+(frameTime - test.t0).toFixed(1), +inferMs.toFixed(1)];
  for (const p of lm) row.push(+p[0].toFixed(4), +p[1].toFixed(4), +p[2].toFixed(2));
  test.frames.push(row);
}

function upcomingTargets() {
  const out = {};
  if (!test) return out;
  const tr = performance.now() - test.t0, beat = test.protocol.beatMs;
  for (const e of test.protocol.expected) {
    const d = e.t - tr;
    if (d > -120 && d < beat) out[e.target] = Math.max(out[e.target] ?? 0, Math.min(1, 1 - d / beat));
  }
  return out;
}
function targetPadsFoot(which) {
  if (!test) return null;
  const up = upcomingTargets();
  if (which === 'kick') return up.kick ?? null;
  return up.hhOpen ?? up.hhClose ?? null;
}

function testTick() {
  const tr = performance.now() - test.t0, P = test.protocol;
  if (tr < 0) { setPrompt('준비…', '박자 소리가 4번 나면 시작합니다'); return; }
  if (tr < P.countIn * P.beatMs) { setPrompt(`${P.countIn - Math.floor(tr / P.beatMs)}`, '박자 소리를 들으며 준비하세요'); return; }
  if (tr > P.durationMs) { finishTest(true); return; }
  const sec = [...P.sections].reverse().find(s => s.t <= tr + P.beatMs * 2) || P.sections[0];
  const next = P.expected.filter(e => e.t >= tr - 150).slice(0, 2);
  const names = [...new Set(next.filter(e => e.t - next[0].t < 50).map(e => (TARGET_NAMES[e.target] || e.target)))];
  const soon = next.length && next[0].t - tr < P.beatMs * 0.75;
  setPrompt(names.length ? (soon ? '' : '다음: ') + names.join(' + ') : '…', `${sec.label} · ${(tr / 1000).toFixed(0)}/${(P.durationMs / 1000).toFixed(0)}초`);
}

async function finishTest(completed) {
  if (!test) return;
  const T = test; test = null;
  const tr = performance.now() - T.t0;
  if (!completed) for (const c of T.clicks) { try { c.stop(); } catch { /* 이미 재생됨 */ } }
  const recordedUntilMs = Math.max(0, Math.min(tr, T.protocol.durationMs));
  const s = score(T.protocol.expected, T.detected.map(d => ({ t: d.t, label: d.label })), { untilMs: recordedUntilMs });
  const infer = T.infers;
  const times = T.frameTimes;
  const gaps = times.slice(1).map((x, i) => x - times[i]).filter(x => x > 0);
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const procs = T.detected.map(d => d.procMs).sort((a, b) => a - b);
  const al = audio.latencyMs();
  const audioMs = al.base + al.output;
  const fpsAvg = gaps.length ? 1000 / avg(gaps) : 0;
  const perfSum = {
    fpsAvg: +fpsAvg.toFixed(1), fpsMin: gaps.length ? +(1000 / Math.max(...gaps)).toFixed(1) : 0,
    inferAvgMs: +(avg(infer) ?? 0).toFixed(1), procAvgMs: +(avg(procs) ?? 0).toFixed(1),
    procP90Ms: procs.length ? procs[Math.floor(procs.length * 0.9)] : null,
    framesTotal: times.length, framesNoPerson: T.noPerson,
    audioMs: +audioMs.toFixed(1), estInternalMs: +((avg(procs) ?? 0) + audioMs).toFixed(1),
  };
  const report = {
    format: 'airdrum-report', version: 1,
    id: 'r-' + T.startedAt.replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6),
    createdAt: T.startedAt, split: T.split, completed, recordedUntilMs: Math.round(recordedUntilMs),
    appVersion: APP_VERSION, engineVersion: ENGINE_VERSION,
    device: { userAgent: navigator.userAgent, camera: cam.label, width: cam.width, height: cam.height, fpsRequested: 60, fpsReported: cam.fps, model: landmarkerModel },
    audio: { sampleRate: audio.ctx.sampleRate, baseLatencyMs: +al.base.toFixed(1), outputLatencyMs: +al.output.toFixed(1) },
    params: { ...params }, calibration,
    protocol: T.protocol,
    detected: T.detected,
    summary: { ...s, perf: perfSum },
    frames: { fields: 't(ms, 첫 박 기준), inferMs, 33×(x, y, visibility)', data: T.frames },
  };
  await store.saveReport(report);
  $('btnTest').disabled = false; $('btnStop').disabled = true; $('btnCalib').disabled = false;
  setPrompt(completed ? '테스트 끝!' : '테스트 종료', `맞음 ${s.correct}/${s.expected} · 보고서 저장됨`, 4000);
  $('lastResult').innerHTML = resultHtml(report);
  renderReports();
}

function pct(x) { return (x * 100).toFixed(0) + '%'; }
function resultHtml(r) {
  const s = r.summary, p = s.perf;
  const rows = Object.entries(s.perTarget).map(([k, v]) => `<tr><td>${(TARGET_NAMES[k] || k).split(' (')[0]}</td><td>${v.correct}/${v.expected}</td><td>${v.wrong}</td><td>${v.miss}</td></tr>`).join('');
  const conf = Object.entries(s.confusion).map(([k, v]) => `${k.replace(/hhOpen|hhClose|[a-z]+/g, m => (TARGET_NAMES[m] || m).split(' (')[0])} ${v}번`).join(', ');
  return `<div><span class="score">${pct(s.recall)}</span> 인식 (맞음 ${s.correct}/${s.expected}) · 헛울림 ${s.extra}번 · <span class="tag ${r.split}">${r.split === 'training' ? '학습' : '검증'}</span>${r.completed ? '' : ' · 중간 종료'}</div>
  <div class="muted">박자 대비 평균 ${s.timingMeanMs != null ? Math.round(s.timingMeanMs) + 'ms' : '-'} (들쭉날쭉 ±${s.timingSdMs != null ? Math.round(s.timingSdMs) : '-'}ms) · 화면 ${p.fpsAvg}fps · 내부 지연 약 ${p.estInternalMs}ms</div>
  <table style="margin-top:6px"><thead><tr><th>대상</th><th>맞음</th><th>다른 드럼</th><th>놓침</th></tr></thead><tbody>${rows}</tbody></table>
  ${conf ? `<div class="muted" style="margin-top:4px">잘못 인식: ${conf}</div>` : ''}`;
}

async function renderReports() {
  const reps = await store.listReports();
  const nt = reps.filter(r => r.split === 'training').length, nv = reps.length - nt;
  $('repCount').textContent = `(학습 ${nt} · 검증 ${nv})`;
  $('repBody').innerHTML = reps.map(r => `<tr data-id="${r.id}">
    <td>${new Date(r.createdAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
    <td><span class="tag ${r.split}">${r.split === 'training' ? '학습' : '검증'}</span></td>
    <td>${r.summary.correct}/${r.summary.expected}${r.completed ? '' : '*'}</td>
    <td>${Math.round(r.summary.perf.estInternalMs)}ms</td>
    <td><button class="small secondary" data-act="view">보기</button> <button class="small secondary" data-act="dl">받기</button> <button class="small secondary" data-act="del">삭제</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">아직 없음</td></tr>';
}
$('repBody').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const id = b.closest('tr').dataset.id;
  const rep = (await store.listReports()).find(r => r.id === id); if (!rep) return;
  if (b.dataset.act === 'view') $('repDetail').innerHTML = resultHtml(rep);
  if (b.dataset.act === 'dl') store.download(`airdrum-${rep.split}-${rep.id}.json`, rep);
  if (b.dataset.act === 'del' && confirmDelete(b)) { await store.deleteReport(id); renderReports(); }
});
function confirmDelete(btn) { // 실수 방지: 두 번 눌러야 삭제
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1'; btn.textContent = '정말 삭제?'; btn.classList.add('danger');
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = '삭제'; btn.classList.remove('danger'); }, 2500);
  return false;
}
$('btnExportAll').addEventListener('click', async () => {
  const reps = await store.listReports();
  if (!reps.length) return;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  store.download(`airdrum-reports-${stamp}.json`, { format: 'airdrum-export', exportedAt: new Date().toISOString(), reports: reps });
});

// ---------- 감도 설정 ----------
const SLIDERS = [
  ['handMinVel', '손 감도: 최소 내려치는 속도 (낮을수록 예민)', 1, 6, 0.1],
  ['handDecel', '손 반응 시점 (높을수록 빨리 울림, 너무 높으면 오작동)', 0.3, 0.95, 0.05],
  ['footMinVel', '킥 감도: 최소 발 내리는 속도', 0.4, 3, 0.1],
  ['footRearmRatio', '킥: 이만큼 발을 들어야 다음 킥 준비 (비율)', 0.15, 0.9, 0.05],
  ['hhOpenRatio', '하이햇 열림 높이 (비율)', 0.2, 0.9, 0.05],
  ['padRadius', '드럼 인식 범위 (넓을수록 관대)', 0.3, 1.2, 0.05],
  ['filterBeta', '떨림 제거 vs 반응속도 (높을수록 빠르지만 떨림)', 0.3, 5, 0.1],
];
function renderSliders() {
  $('sliders').innerHTML = SLIDERS.map(([k, label, min, max, step]) => `<label class="slider"><span>${label}</span><span class="val" id="v_${k}">${params[k]}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${params[k]}" data-k="${k}"></label>`).join('');
}
$('sliders').addEventListener('input', (e) => {
  const k = e.target.dataset.k; if (!k) return;
  params[k] = +e.target.value;
  if (k === 'hhOpenRatio') params.hhCloseRatio = params.hhOpenRatio / 2;
  $('v_' + k).textContent = params[k];
  store.lsSet('airdrum.params', params);
  engine = new Engine(params, calibration);
});
$('btnResetParams').addEventListener('click', () => { params = { ...DEFAULT_PARAMS }; store.lsSet('airdrum.params', {}); renderSliders(); engine = new Engine(params, calibration); });

// ---------- 버튼 ----------
$('btnCam').addEventListener('click', startCamera);
$('camSelect').addEventListener('change', () => { if (stream) startCamera(); });
$('modelSelect').addEventListener('change', async () => { if (stream) { await ensureLandmarker(); $('camInfo').textContent = `${cam.label} · ${cam.width}×${cam.height} · 모델: ${landmarkerModel}`; } });
$('btnCalib').addEventListener('click', startCalib);
$('btnCalibSkip').addEventListener('click', skipCalibStep);
$('btnCalibCancel').addEventListener('click', () => endCalib(false));
$('btnTest').addEventListener('click', startTest);
$('btnStop').addEventListener('click', () => finishTest(false));

renderSliders(); renderCalibSteps(); renderReports(); listCameras();
if (!window.isSecureContext) $('camInfo').textContent = '카메라는 https 주소에서만 켜집니다.';
