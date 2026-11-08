import { solvePutt, describeAim, CUP_D } from './physics.js';

// ---------- 저장 ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('gg_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gg_' + k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
};
const settings = Object.assign(
  { offX: 0, offY: 0, overshoot: 40, stimp: 2.7, distance: 5, points: 2, wake: true },
  store.get('settings', {}),
);
const save = () => store.set('settings', settings);

const $ = (s) => document.querySelector(s);
const pct = (v, d = 1) => (v * 100).toFixed(d) + '%';

// ---------- 센서 ----------
// accelerationIncludingGravity: 화면이 위를 향해 평평하게 놓이면 (0, 0, +9.8).
// 위쪽(y+)이 높아지면 y가 +, 오른쪽(x+)이 높아지면 x가 +.
// 경사 = 높이/수평거리 = x/z, y/z.
const buf = [];
let eventCount = 0, firstEvent = 0, lastEvent = 0;

function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null || a.z == null) return;
  let { x, y, z } = a;
  if (z < 0) { x = -x; y = -y; z = -z; } // 부호가 반대로 나오는 기기 대응
  if (z < 1) return;
  const now = performance.now();
  buf.push({ t: now, sx: x / z, sy: y / z, z });
  while (buf.length && now - buf[0].t > 4000) buf.shift();
  if (!firstEvent) firstEvent = now;
  eventCount++;
  lastEvent = now;
}
window.addEventListener('devicemotion', onMotion);

function statsOf(arr) {
  const n = arr.length;
  if (!n) return null;
  let sx = 0, sy = 0, z = 0;
  for (const b of arr) { sx += b.sx; sy += b.sy; z += b.z; }
  sx /= n; sy /= n; z /= n;
  let vx = 0, vy = 0;
  for (const b of arr) { vx += (b.sx - sx) ** 2; vy += (b.sy - sy) ** 2; }
  return { sx, sy, z, n, std: Math.sqrt((vx + vy) / n) };
}
const recent = (ms) => { const now = performance.now(); return buf.filter((b) => now - b.t <= ms); };
const corrected = (m) => ({ ...m, sx: m.sx - settings.offX, sy: m.sy - settings.offY });
const sensorAlive = () => performance.now() - lastEvent < 1000;

/** 손 뗄 시간 0.8초 후 2초간 평균 */
function measure(onStatus, raw = false) {
  return new Promise((resolve, reject) => {
    if (!sensorAlive()) { reject(new Error('센서 신호가 없습니다')); return; }
    const settle = 800, dur = 2000, t0 = performance.now();
    const tick = () => {
      const el = performance.now() - t0;
      if (el < settle) { onStatus('손 떼세요…'); requestAnimationFrame(tick); return; }
      if (el < settle + dur) {
        onStatus(`측정 중 ${((settle + dur - el) / 1000).toFixed(1)}초`);
        requestAnimationFrame(tick); return;
      }
      const s = statsOf(recent(dur));
      if (!s || s.n < 10) { reject(new Error('센서 데이터가 부족합니다')); return; }
      navigator.vibrate?.(60);
      resolve(raw ? s : corrected(s));
    };
    tick();
  });
}

// ---------- 화면 켜짐 유지 ----------
let wakeLock = null;
async function requestWake() {
  if (!settings.wake || !('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* 사용자 제스처 필요 등 */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestWake(); });
document.addEventListener('pointerdown', requestWake, { once: false, passive: true });

// ---------- 탭 ----------
let currentTab = 'level';
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  currentTab = b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + currentTab));
}));

// ---------- 공통 그리기 ----------
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function arrow(ctx, x1, y1, x2, y2, color, width) {
  const ang = Math.atan2(y2 - y1, x2 - x1), head = width * 3.2;
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x1, y1);
  ctx.lineTo(x2 - Math.cos(ang) * head * 0.8, y2 - Math.sin(ang) * head * 0.8); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
  ctx.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
  ctx.closePath(); ctx.fill();
}

function describeY(sy) {
  if (Math.abs(sy) < 0.001) return '평평';
  return sy > 0 ? `위쪽 오르막 ${pct(sy)}` : `위쪽 내리막 ${pct(-sy)}`;
}
function describeX(sx) {
  if (Math.abs(sx) < 0.001) return '평평';
  return sx > 0 ? `오른쪽 높음 ${pct(sx)}` : `왼쪽 높음 ${pct(-sx)}`;
}

// ---------- 수평계 ----------
const levelCanvas = $('#levelCanvas');
const MAX_SLOPE_VIEW = 0.05; // 원 가장자리 = 5%

function drawLevel(m) {
  const ctx = levelCanvas.getContext('2d');
  const W = levelCanvas.width, c = W / 2, R = W / 2 - 16;
  ctx.clearRect(0, 0, W, W);

  ctx.fillStyle = cssVar('--green');
  ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2;
  for (const k of [0.2, 0.4, 0.6, 0.8]) { ctx.beginPath(); ctx.arc(c, c, R * k, 0, Math.PI * 2); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(c - R, c); ctx.lineTo(c + R, c); ctx.moveTo(c, c - R); ctx.lineTo(c, c + R); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.font = '600 22px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('폰 위쪽 ▲', c, 40);
  ctx.font = '18px system-ui';
  for (const k of [1, 2, 3, 4]) ctx.fillText(k + '%', c + 4 + R * k * 0.2, c - 6);

  if (!m) return;
  const mag = Math.hypot(m.sx, m.sy);
  const k = Math.min(1, mag / MAX_SLOPE_VIEW) / (mag || 1);
  // 화면 좌표: 기기 x → 오른쪽, 기기 y → 위쪽
  const hx = m.sx * k * R, hy = -m.sy * k * R;
  if (mag > 0.0015) arrow(ctx, c, c, c - hx, c - hy, cssVar('--danger'), 10);
  // 기포(높은 쪽)
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(c + hx, c + hy, 26, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
}

function updateLevel() {
  const alive = sensorAlive();
  const badge = $('#sensorBadge');
  badge.textContent = alive ? '센서 정상' : '센서 없음';
  badge.className = 'badge ' + (alive ? 'on' : 'off');

  if (currentTab === 'level') {
    const s = alive ? statsOf(recent(600)) : null;
    if (s) {
      const m = corrected(s);
      drawLevel(m);
      const mag = Math.hypot(m.sx, m.sy);
      $('#levelTotal').textContent = pct(mag);
      $('#levelDir').textContent = s.z < 9.0 ? '폰을 평평하게 놓아주세요' : (s.std > 0.004 ? '흔들리는 중…' : '안정됨');
      $('#levelY').textContent = describeY(m.sy);
      $('#levelX').textContent = describeX(m.sx);
    } else {
      drawLevel(null);
      $('#levelTotal').textContent = '–';
      $('#levelDir').textContent = noSensorMessage();
    }
  }
  if (currentTab === 'settings') updateRaw();
  setTimeout(() => requestAnimationFrame(updateLevel), 66);
}

function noSensorMessage() {
  if (!window.isSecureContext) return 'HTTPS 주소로 열어야 센서를 쓸 수 있습니다';
  if (!('DeviceMotionEvent' in window)) return '이 브라우저는 움직임 센서를 지원하지 않습니다';
  return '센서 신호 없음 — 휴대폰 Chrome에서 열어주세요 (아래 퍼팅 탭은 수동 입력 가능)';
}

$('#levelMeasure').addEventListener('click', async (e) => {
  const btn = e.currentTarget, box = $('#levelHold');
  btn.disabled = true;
  try {
    const m = await measure((t) => { btn.textContent = t; });
    box.hidden = false;
    box.innerHTML = `<div class="label">정밀 측정 결과</div>
      <div class="val">경사 ${pct(Math.hypot(m.sx, m.sy), 2)}</div>
      <div class="sub">${describeY(m.sy)} · ${describeX(m.sx)}${m.std > 0.004 ? ' · ⚠ 흔들림이 있었습니다' : ''}</div>`;
  } catch (err) {
    box.hidden = false; box.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = '정밀 측정 (2초)';
  }
});

// ---------- 설정 ----------
function updateRaw() {
  const s = statsOf(recent(1000));
  const rate = eventCount && lastEvent > firstEvent ? (eventCount / ((lastEvent - firstEvent) / 1000)).toFixed(0) : '–';
  $('#raw').textContent = [
    `보안 연결(HTTPS): ${window.isSecureContext ? '예' : '아니오'}`,
    `센서 신호: ${sensorAlive() ? '수신 중' : '없음'} (${rate} Hz)`,
    s ? `원시 경사  X ${pct(s.sx, 2)}  Y ${pct(s.sy, 2)}  (z ${s.z.toFixed(2)})` : '원시 경사: –',
    s ? `흔들림(표준편차): ${pct(s.std, 2)}` : '',
    `보정값  X ${pct(settings.offX, 2)}  Y ${pct(settings.offY, 2)}`,
  ].join('\n');
}

let cal1 = null;
function showCal() {
  $('#calStatus').textContent = (settings.offX || settings.offY)
    ? `현재 보정값: X ${pct(settings.offX, 2)}, Y ${pct(settings.offY, 2)}`
    : '보정 안 됨';
}
$('#cal1').addEventListener('click', async (e) => {
  const btn = e.currentTarget; btn.disabled = true;
  try {
    cal1 = await measure((t) => { btn.textContent = t; }, true);
    $('#cal2').disabled = false;
    $('#calStatus').textContent = '1단계 완료. 폰을 같은 자리에서 180° 돌린 뒤 2단계를 누르세요.';
  } catch (err) { $('#calStatus').textContent = err.message; }
  finally { btn.disabled = false; btn.textContent = '1단계 측정'; }
});
$('#cal2').addEventListener('click', async (e) => {
  const btn = e.currentTarget; btn.disabled = true;
  try {
    const m2 = await measure((t) => { btn.textContent = t; }, true);
    // 180° 돌리면 실제 경사는 부호가 바뀌고 센서 오차는 그대로 → 평균이 오차
    settings.offX = (cal1.sx + m2.sx) / 2;
    settings.offY = (cal1.sy + m2.sy) / 2;
    save(); cal1 = null; showCal();
    btn.textContent = '2단계 (180° 돌린 후)';
  } catch (err) { $('#calStatus').textContent = err.message; btn.textContent = '2단계 (180° 돌린 후)'; btn.disabled = false; return; }
  btn.disabled = true;
});
$('#calReset').addEventListener('click', () => { settings.offX = 0; settings.offY = 0; save(); showCal(); });

const overshootEl = $('#overshoot'), wakeEl = $('#wake');
overshootEl.value = settings.overshoot;
wakeEl.checked = settings.wake;
overshootEl.addEventListener('change', () => {
  settings.overshoot = clamp(+overshootEl.value || 0, 0, 100); overshootEl.value = settings.overshoot; save(); recompute();
});
wakeEl.addEventListener('change', () => {
  settings.wake = wakeEl.checked; save();
  if (!settings.wake && wakeLock) wakeLock.release(); else requestWake();
});

// ---------- 퍼팅 읽기 ----------
const POINT_LAYOUT = {
  1: [{ t: 0.5, name: '중간' }],
  2: [{ t: 0.3, name: '볼 쪽' }, { t: 0.75, name: '홀 쪽' }],
  3: [{ t: 0.15, name: '볼 근처' }, { t: 0.5, name: '중간' }, { t: 0.85, name: '홀 근처' }],
};
let points = []; // {t, name, sx, sy, measured}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

const distanceEl = $('#distance'), stimpEl = $('#stimp');
distanceEl.value = settings.distance;
stimpEl.value = settings.stimp;

function setDistance(v) { settings.distance = +clamp(v, 0.5, 30).toFixed(1); distanceEl.value = settings.distance; save(); renderPoints(); recompute(); }
function setStimp(v) { settings.stimp = +clamp(v, 1.5, 4.5).toFixed(1); stimpEl.value = settings.stimp; save(); markStimp(); recompute(); }
distanceEl.addEventListener('change', () => setDistance(+distanceEl.value || settings.distance));
stimpEl.addEventListener('change', () => setStimp(+stimpEl.value || settings.stimp));
document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
  const [key, d] = b.dataset.step.split(':');
  if (key === 'distance') setDistance(settings.distance + +d); else setStimp(settings.stimp + +d);
}));
function markStimp() {
  document.querySelectorAll('#stimpPresets .chip').forEach((c) => c.classList.toggle('active', +c.dataset.stimp === settings.stimp));
}
document.querySelectorAll('#stimpPresets .chip').forEach((c) => c.addEventListener('click', () => setStimp(+c.dataset.stimp)));

function setPointCount(n) {
  settings.points = n; save();
  const old = points;
  points = POINT_LAYOUT[n].map((p, i) => old[i] && old.length === n ? old[i] : { ...p, sx: 0, sy: 0, measured: false });
  document.querySelectorAll('#pointCount button').forEach((b) => b.classList.toggle('active', +b.dataset.n === n));
  renderPoints(); recompute();
}
document.querySelectorAll('#pointCount button').forEach((b) => b.addEventListener('click', () => setPointCount(+b.dataset.n)));

function renderPoints() {
  const wrap = $('#points');
  wrap.innerHTML = '';
  points.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'card point' + (p.measured ? ' done' : '');
    const at = (settings.distance * p.t).toFixed(1);
    el.innerHTML = `
      <div class="head">
        <div><div class="title">${i + 1}. ${p.name}</div><div class="label">볼에서 약 ${at} m</div></div>
        <button class="btn primary">측정</button>
      </div>
      <div class="fields">
        <div><label>홀 방향 오르막(+) %</label><input type="number" inputmode="decimal" step="0.1" data-k="sy" value="${(p.sy * 100).toFixed(1)}"></div>
        <div><label>오른쪽 높음(+) %</label><input type="number" inputmode="decimal" step="0.1" data-k="sx" value="${(p.sx * 100).toFixed(1)}"></div>
      </div>
      <div class="state">${p.measured ? (p.shaky ? '⚠ 흔들림이 있었습니다. 다시 측정해 보세요.' : '측정 완료') : '아직 측정 안 함 (직접 입력도 가능)'}</div>`;
    const btn = el.querySelector('button');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const m = await measure((t) => { btn.textContent = t; });
        Object.assign(p, { sx: m.sx, sy: m.sy, measured: true, shaky: m.std > 0.004 });
        renderPoints(); recompute();
        if (points.every((q) => q.measured)) $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) {
        el.querySelector('.state').textContent = err.message + ' — 값을 직접 입력할 수 있습니다.';
        btn.disabled = false; btn.textContent = '측정';
      }
    });
    el.querySelectorAll('input').forEach((inp) => inp.addEventListener('change', () => {
      p[inp.dataset.k] = (+inp.value || 0) / 100;
      p.measured = true; p.shaky = false;
      el.classList.add('done');
      el.querySelector('.state').textContent = '직접 입력함';
      recompute();
    }));
    wrap.appendChild(el);
  });
}

function recompute() {
  const resEl = $('#result'), errEl = $('#resultError');
  if (!points.some((p) => p.measured)) { resEl.hidden = true; errEl.hidden = true; return; }
  const slopes = points.map((p) => ({ t: p.t, sx: p.sx, sy: p.sy }));
  const overshoot = settings.overshoot / 100;
  const r = solvePutt({ distance: settings.distance, stimp: settings.stimp, slopes, overshoot });
  if (!r.path) {
    resEl.hidden = true; errEl.hidden = false; errEl.textContent = r.reason; return;
  }
  errEl.hidden = r.ok; errEl.textContent = r.reason;
  resEl.hidden = false;

  $('#aimText').textContent = describeAim(r.aimOffset);
  const diff = r.playsLike - settings.distance;
  const strength = Math.abs(diff) < 0.15 ? '평지와 비슷한 세기'
    : diff > 0 ? `실제보다 ${diff.toFixed(1)} m 세게` : `실제보다 ${(-diff).toFixed(1)} m 약하게`;
  $('#speedText').textContent = `세기: 평지 ${r.playsLike.toFixed(1)} m 퍼팅처럼 (${strength})`;
  const breakSide = r.aimOffset > 0 ? '왼쪽' : '오른쪽';
  $('#breakText').textContent = Math.abs(r.aimOffset) < 0.02
    ? `거의 휘지 않습니다 · 홀 지나 ${settings.overshoot}cm 기준`
    : `공은 ${breakSide}으로 휘어 들어갑니다 · 홀 지나 ${settings.overshoot}cm 기준`;
  drawPutt(r, slopes);
}

function drawPutt(r, slopes) {
  const cv = $('#puttCanvas'), ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, D = settings.distance;
  const top = 60, bottom = H - 50;
  const ys = (bottom - top) / (D + settings.overshoot / 100 + 0.2);
  const halfNeed = Math.max(Math.abs(r.aimOffset), ...r.path.map((p) => Math.abs(p.x)), 0.25) * 1.25;
  const xs = Math.min((W / 2 - 30) / halfNeed, ys * 4);
  const X = (x) => W / 2 + x * xs, Y = (y) => bottom - y * ys;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = cssVar('--green'); ctx.fillRect(0, 0, W, H);
  // 잔디 줄무늬
  ctx.fillStyle = cssVar('--green-dark');
  for (let i = 0; i < 10; i += 2) ctx.fillRect(0, (H / 10) * i, W, H / 10);

  // 경사 화살표 (내리막 방향)
  ctx.globalAlpha = 0.85;
  for (const s of slopes) {
    const mag = Math.hypot(s.sx, s.sy);
    if (mag < 0.001) continue;
    const L = Math.min(90, 25 + mag * 2500);
    const ux = -s.sx / mag, uy = s.sy / mag; // 화면 좌표: 오른쪽 +, 아래 +
    const cx = 70, cy = Y(D * s.t);
    arrow(ctx, cx - ux * L / 2, cy - uy * L / 2, cx + ux * L / 2, cy + uy * L / 2, '#ffffff', 5);
    ctx.fillStyle = '#ffffff'; ctx.font = '600 20px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(pct(mag), cx, cy + 50);
  }
  ctx.globalAlpha = 1;

  // 조준선
  ctx.setLineDash([12, 10]); ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(r.aimOffset), Y(D)); ctx.stroke();
  ctx.setLineDash([]);
  // 조준점 마커
  ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(X(r.aimOffset), Y(D), 12, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#ffd54a'; ctx.font = '700 22px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('조준', X(r.aimOffset), Y(D) - 22);

  // 홀
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.ellipse(X(0), Y(D), Math.max(8, (CUP_D / 2) * xs), Math.max(8, (CUP_D / 2) * ys), 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(X(0), Y(D)); ctx.lineTo(X(0), Y(D) - 50); ctx.stroke();
  ctx.fillStyle = '#e53935';
  ctx.beginPath(); ctx.moveTo(X(0), Y(D) - 50); ctx.lineTo(X(0) + 28, Y(D) - 42); ctx.lineTo(X(0), Y(D) - 34); ctx.fill();

  // 공 경로
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 5; ctx.lineJoin = 'round';
  ctx.beginPath();
  r.path.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.6)';
  ctx.beginPath(); ctx.arc(X(r.stop.x), Y(r.stop.y), 7, 0, Math.PI * 2); ctx.fill();

  // 공
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#333'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(X(0), Y(0), 12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  const ex = xs / ys;
  $('#scaleText').textContent = ex > 1.1
    ? `잘 보이도록 좌우를 ${ex.toFixed(1)}배 확대해서 그렸습니다. 흰 화살표는 측정 지점의 내리막 방향입니다.`
    : '흰 화살표는 측정 지점의 내리막 방향입니다.';
}

// ---------- 시작 ----------
markStimp();
showCal();
setPointCount(settings.points);
requestAnimationFrame(updateLevel);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
