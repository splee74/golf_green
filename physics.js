// 퍼팅 물리 모델
// 좌표계: 볼 위치 = (0,0), 홀 = (0, distance).
//   x  : 퍼팅 라인 기준 좌우 (+ = 오른쪽)
//   y  : 홀 방향 (+ = 홀 쪽)
// 경사(slope)는 "수평 1m 당 높이 변화(m)" 값. 1% = 0.01.
//   sx : + 이면 오른쪽이 높음 (공은 왼쪽으로 휨)
//   sy : + 이면 홀 쪽이 높음 (오르막)

export const G = 9.81;
export const STIMP_V0 = 1.83;   // 스팀프미터 램프를 떠나는 공 속도 (m/s)
export const CUP_D = 0.108;     // 홀컵 지름 (m)
export const BALL_D = 0.0427;   // 공 지름 (m)
const ROLL_K = 5 / 7;           // 굴러가는 구(球)의 경사 가속 계수

/** 그린 스피드(m, 스팀프 거리)로부터 구름 저항 감속도 (m/s²) */
export function rollDecel(stimpM) {
  return (STIMP_V0 * STIMP_V0) / (2 * stimpM);
}

/** 측정 지점들 사이를 선형 보간한 경사. points: [{t:0..1, sx, sy}] */
export function slopeAt(points, t) {
  if (!points.length) return { sx: 0, sy: 0 };
  const p = [...points].sort((a, b) => a.t - b.t);
  if (t <= p[0].t) return { sx: p[0].sx, sy: p[0].sy };
  const last = p[p.length - 1];
  if (t >= last.t) return { sx: last.sx, sy: last.sy };
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i], b = p[i + 1];
    if (t <= b.t) {
      const k = (t - a.t) / (b.t - a.t);
      return { sx: a.sx + (b.sx - a.sx) * k, sy: a.sy + (b.sy - a.sy) * k };
    }
  }
  return { sx: last.sx, sy: last.sy };
}

/** 공 굴림 시뮬레이션. angle: 직선 대비 조준 각도(rad, + = 오른쪽) */
export function simulate({ distance, stimp, slopes, v0, angle, dt = 0.002, maxT = 25, record = false }) {
  const ar = rollDecel(stimp);
  let x = 0, y = 0;
  let vx = v0 * Math.sin(angle), vy = v0 * Math.cos(angle);
  const path = record ? [{ x, y }] : null;
  let minDist = Infinity, nearest = { x: 0, y: 0, vx, vy };
  let t = 0, stopped = false;
  let cross = null; // 홀 거리(y = distance) 선을 처음 넘는 지점

  while (t < maxT) {
    const s = slopeAt(slopes, y / distance);
    const gx = -ROLL_K * G * s.sx;
    const gy = -ROLL_K * G * s.sy;
    const speed = Math.hypot(vx, vy);

    if (speed < 0.01) {
      // 경사력이 구름 저항보다 작으면 정지
      if (Math.hypot(gx, gy) <= ar) { stopped = true; break; }
    }
    const fx = speed > 1e-6 ? -ar * vx / speed : 0;
    const fy = speed > 1e-6 ? -ar * vy / speed : 0;
    vx += (gx + fx) * dt;
    vy += (gy + fy) * dt;
    const px = x, py = y;
    x += vx * dt;
    y += vy * dt;
    t += dt;
    if (!cross && py < distance && y >= distance) {
      const k = (distance - py) / (y - py);
      cross = { x: px + (x - px) * k, y: distance };
    }

    const d = Math.hypot(x, y - distance);
    if (d < minDist) { minDist = d; nearest = { x, y, vx, vy }; }
    if (record && path.length < 4000 && Math.round(t / dt) % 5 === 0) path.push({ x, y });
  }
  if (record) path.push({ x, y });
  return { stop: { x, y }, stopped, path, minDist, nearest, cross, time: t };
}

// 잔차: [홀 거리 선을 지날 때 좌우 오차, (홀 지나 굴러간 거리 - overshoot)]
function residual(params, angle, v0, overshoot) {
  const r = simulate({ ...params, v0, angle });
  if (r.cross) {
    const past = Math.hypot(r.stop.x - r.cross.x, r.stop.y - r.cross.y);
    return [r.cross.x, past - overshoot];
  }
  // 홀까지 못 감: 멈춘 지점 기준으로 연속적인 값을 준다
  return [r.stop.x, (r.stop.y - params.distance) - overshoot];
}

/**
 * 홀을 지나 overshoot(m) 지점에서 멈추는 세기와 방향을 찾는다.
 * 반환: 조준 오프셋(홀 거리 기준 좌우 m), 평지 환산 거리 등
 */
export function solvePutt({ distance, stimp, slopes, overshoot = 0.4 }) {
  const ar = rollDecel(stimp);
  const maxSlope = Math.max(0, ...slopes.map(s => Math.hypot(s.sx, s.sy)));
  if (ROLL_K * G * maxSlope >= ar) {
    return { ok: false, reason: '경사가 너무 가팔라서 공이 멈추지 않습니다 (그린 스피드/측정값 확인).' };
  }

  const params = { distance, stimp, slopes };
  const target = { x: 0, y: distance + overshoot };
  let angle = 0;
  let v0 = Math.sqrt(2 * ar * (distance + overshoot));

  // 1단계: 멈춘 지점을 (홀 + overshoot) 쪽으로 끌어오는 간단한 반복으로 초기값
  for (let i = 0; i < 30; i++) {
    const S = simulate({ ...params, v0, angle }).stop;
    const dS = Math.hypot(S.x, S.y);
    if (dS < 1e-3) { v0 *= 1.5; continue; }
    if (Math.hypot(target.x - S.x, target.y - S.y) < 0.01) break;
    angle += 0.9 * (Math.atan2(target.x, target.y) - Math.atan2(S.x, S.y));
    v0 *= Math.sqrt(Math.hypot(target.x, target.y) / dS);
  }

  // 2단계: (각도, 세기) 2변수 뉴턴법 — 홀 중심 통과 + overshoot 만큼 지나서 정지
  const hA = 1e-4, hV = 1e-3;
  for (let i = 0; i < 30; i++) {
    const f = residual(params, angle, v0, overshoot);
    if (Math.abs(f[0]) < 0.002 && Math.abs(f[1]) < 0.01) break;
    const fa = residual(params, angle + hA, v0, overshoot);
    const fv = residual(params, angle, v0 + hV, overshoot);
    const J = [[(fa[0] - f[0]) / hA, (fv[0] - f[0]) / hV],
               [(fa[1] - f[1]) / hA, (fv[1] - f[1]) / hV]];
    const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
    if (Math.abs(det) < 1e-12) break;
    let dA = -( J[1][1] * f[0] - J[0][1] * f[1]) / det;
    let dV = -(-J[1][0] * f[0] + J[0][0] * f[1]) / det;
    // 한 번에 너무 크게 움직이지 않도록 제한
    const scale = Math.min(1, 0.15 / Math.abs(dA || 1e-9), 0.5 / Math.abs(dV || 1e-9));
    angle += dA * scale;
    v0 = Math.max(0.05, v0 + dV * scale);
  }

  const final = simulate({ distance, stimp, slopes, v0, angle, record: true });
  const aimOffset = distance * Math.tan(angle);         // 홀 거리에서 좌우 조준점 (m)
  const playsLike = (v0 * v0) / (2 * ar) - overshoot;    // 평지라면 몇 m 퍼팅 세기인가
  const maxBreak = final.path.reduce((m, p) => (Math.abs(p.x) > Math.abs(m) ? p.x : m), 0);

  return {
    ok: final.minDist < CUP_D / 2,
    reason: final.minDist < CUP_D / 2 ? '' : '해를 정확히 찾지 못했습니다. 측정값을 확인하세요.',
    v0, angle, aimOffset, playsLike, maxBreak,
    path: final.path, stop: final.stop, minDist: final.minDist,
  };
}

/** 조준 오프셋을 사람이 읽기 쉬운 말로 */
export function describeAim(offsetM) {
  const abs = Math.abs(offsetM);
  const side = offsetM > 0 ? '오른쪽' : '왼쪽';
  if (abs < BALL_D / 2) return '홀 정중앙';
  if (abs < CUP_D / 2) return `홀 안쪽 ${side} (${Math.round(abs * 100)}cm)`;
  if (abs < CUP_D) return `홀 ${side} 끝 (${Math.round(abs * 100)}cm)`;
  const cups = abs / CUP_D;
  return `홀 ${side} 컵 ${cups.toFixed(1)}개 (${Math.round(abs * 100)}cm)`;
}
