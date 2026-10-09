import iconUrl from './assets/icon.png';
import {
  makeBootGlass,
  advanceBootGlass,
  glassPosition,
  canAssembleBoot,
  GLASS_FLOAT_MIN_MS,
  CONVERGE_DURATION,
  ASSEMBLED_HOLD_MS,
  BOOT_FRAME_MS,
  type BootState,
  type GlassPoint,
} from '@shared/startup';
import './splash.css';

const bridge = window.faionyxSplash;
const root = document.documentElement;
const canvas = document.querySelector<HTMLCanvasElement>('#glass')!;
const ctx = canvas.getContext('2d', { alpha: true })!;
const caption = document.querySelector<HTMLSpanElement>('#stage')!;
const icon = new Image();
let state: BootState = { completed: [], ready: false },
  pointer: GlassPoint | null = null;
let view = { w: 1, h: 1, dpr: 1 };
let geometry = makeBootGlass(1, 1);
let start = 0,
  convergence: number | null = null,
  raf = 0,
  assembled = false,
  lastFrame = 0;
let nextFrame = 0;
let finishTimer = 0,
  finished = false;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const labels = ['读取配置', '加载账户', '扫描游戏实例', '加载首页图片、Java 与皮肤', '准备首帧'];

/* ---------------- 滚动锁定 ---------------- */

// 立即上锁：模块执行早于首帧绘制，避免滚动条闪一下再消失
let scrollLocked = false;
function lockScroll() {
  if (scrollLocked) return;
  scrollLocked = true;
  root.classList.add('splash-active');
}
function unlockScroll() {
  if (!scrollLocked) return;
  scrollLocked = false;
  root.classList.remove('splash-active');
}
lockScroll();

/* ---------------- 视口 / 分辨率 ---------------- */

function readViewport() {
  const w = Math.max(1, Math.round(root.clientWidth || window.innerWidth));
  const h = Math.max(1, Math.round(root.clientHeight || window.innerHeight));
  const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
  return { w, h, dpr };
}

function resize() {
  const next = readViewport();
  const unchanged = next.w === view.w && next.h === view.h && next.dpr === view.dpr;
  view = next;
  if (unchanged) return;

  const pixelW = Math.round(next.w * next.dpr);
  const pixelH = Math.round(next.h * next.dpr);
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }
  canvas.style.width = `${next.w}px`;
  canvas.style.height = `${next.h}px`;

  ctx.setTransform(next.dpr, 0, 0, next.dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  geometry = makeBootGlass(next.w, next.h);
  if (assembled) paint(performance.now());
}

let resizeQueued = 0;
function scheduleResize() {
  if (resizeQueued) return;
  resizeQueued = requestAnimationFrame(() => {
    resizeQueued = 0;
    resize();
  });
}

let dprQuery: MediaQueryList | undefined;
function onDprChange() {
  watchDpr();
  scheduleResize();
}
function watchDpr() {
  dprQuery?.removeEventListener('change', onDprChange);
  dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  dprQuery.addEventListener('change', onDprChange);
}

/* ---------------- 渲染 ---------------- */

const GLOW_RAMP_MS = 900; // 柔光自聚合完成起的浮现时长

function paint(now: number) {
  const elapsed = now - start;
  ctx.clearRect(0, 0, view.w, view.h);
  const complete = reduced || (convergence !== null && elapsed - convergence >= CONVERGE_DURATION);

  if (complete) {
    const cx = geometry.left + geometry.board / 2;
    const cy = geometry.top + geometry.board / 2;

    // 自聚合完成的那一刻起算的浮现进度：0 → 1
    const baseElapsed = convergence !== null ? convergence + CONVERGE_DURATION : 0;
    const rampMs = reduced ? 1 : GLOW_RAMP_MS;
    const revealT = Math.min(1, Math.max(0, (elapsed - baseElapsed) / rampMs));
    // smoothstep 缓出：起步慢，末尾稳，观感是"浮现"而非"弹出"
    const revealEase = revealT * revealT * (3 - 2 * revealT);

    if (revealEase > 0) {
      // 呼吸相位也从同一基准起算，避免淡入期间相位乱跳
      const phase = (elapsed - baseElapsed) / 1400;
      const pulse = 0.5 + 0.5 * Math.sin(phase);

      // 半径：先由 0.70×board 慢慢张开，再叠加脉动
      const grow = 0.7 + 0.12 * revealEase;
      const glowRadius = geometry.board * (grow + 0.2 * pulse * revealEase);

      const glow = ctx.createRadialGradient(cx, cy, geometry.board * 0.2, cx, cy, glowRadius);
      glow.addColorStop(0, `rgba(125, 211, 252, ${(0.3 + 0.16 * pulse) * revealEase})`);
      glow.addColorStop(0.55, `rgba(167, 139, 250, ${(0.16 + 0.1 * pulse) * revealEase})`);
      glow.addColorStop(1, 'rgba(125, 211, 252, 0)');

      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, glowRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // 浮动同步受 revealEase 抑制，图标不会在柔光还没起来时先晃
    const floatPhase = (elapsed - baseElapsed) / 1800;
    const float = Math.sin(floatPhase) * 1.2 * revealEase;

    ctx.drawImage(icon, geometry.left, geometry.top + float, geometry.board, geometry.board);
    return;
  }
  for (const shard of geometry.shards) {
    const p = glassPosition(shard, elapsed, convergence),
      glass = 1 - p.progress;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rotation);
    ctx.scale(p.scale, p.scale);
    const polygon = new Path2D();
    shard.vertices.forEach((v, i) => (i ? polygon.lineTo(v.x, v.y) : polygon.moveTo(v.x, v.y)));
    polygon.closePath();
    ctx.save();
    ctx.clip(polygon);
    ctx.globalAlpha = 0.12 + 0.88 * p.progress;
    ctx.drawImage(icon, -shard.sourceX, -shard.sourceY, geometry.board, geometry.board);
    ctx.restore();
    ctx.globalAlpha = glass;
    const tint = ctx.createLinearGradient(-28, -30, 32, 35);
    tint.addColorStop(0, '#effaff80');
    tint.addColorStop(0.4, '#badfff20');
    tint.addColorStop(0.52, '#ffffff58');
    tint.addColorStop(1, '#bcb0fa28');
    ctx.fillStyle = tint;
    ctx.fill(polygon);
    ctx.strokeStyle = '#25334945';
    ctx.lineWidth = 2.4;
    ctx.stroke(polygon);
    ctx.strokeStyle = '#eaf7ffb8';
    ctx.lineWidth = 0.85;
    ctx.stroke(polygon);
    const [a, b] = shard.vertices;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = `rgba(255,255,255,${0.55 + Math.sin(elapsed / 1100 + shard.phase) * 0.25})`;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }
}

/* ---------------- 主循环 ---------------- */

const offPointer = bridge.onPointer((next) => {
  pointer = next;
});
const offState = bridge.onState((next) => {
  state = next;
  caption.textContent = state.ready ? '准备就绪' : `${labels[Math.min(4, state.completed.length)]}…`;
});
const offReveal = bridge.onReveal(() => {
  document.body.classList.add('leaving');
  const done = () => {
    if (finished) return;
    finished = true;
    window.clearTimeout(finishTimer);
    unlockScroll();
    bridge.finished();
  };
  document.body.addEventListener('transitionend', done, { once: true });
  // 兜底：prefers-reduced-motion 或无过渡时 transitionend 不会触发，会永久锁住滚动
  finishTimer = window.setTimeout(done, 700);
});

function frame(now: number) {
  if (now + 0.5 < nextFrame) {
    raf = requestAnimationFrame(frame);
    return;
  }
  if (!nextFrame) nextFrame = now;
  nextFrame += BOOT_FRAME_MS;
  if (nextFrame <= now) nextFrame = now + BOOT_FRAME_MS;
  if (!start) start = now;
  const elapsed = now - start,
    delta = lastFrame ? now - lastFrame : BOOT_FRAME_MS;
  lastFrame = now;
  if (canAssembleBoot(state) && convergence === null && (reduced || elapsed >= GLASS_FLOAT_MIN_MS)) convergence = elapsed;
  if (convergence === null && !reduced) advanceBootGlass(geometry.shards, elapsed, delta, pointer);
  paint(now);
  if (!assembled && state.ready && convergence !== null && (reduced || elapsed - convergence >= CONVERGE_DURATION + ASSEMBLED_HOLD_MS)) {
    assembled = true;
    raf = requestAnimationFrame(() => bridge.assembled());
  } else if (!assembled) raf = requestAnimationFrame(frame);
}

/* ---------------- 启动 & 清理 ---------------- */

icon.onload = () => {
  document.body.dataset.motion = reduced ? 'system-reduced' : 'full';
  watchDpr();
  resize();
  raf = requestAnimationFrame(frame);
  bridge.ready();
};
icon.onerror = () => {
  unlockScroll();
  bridge.failed('Icon资源无法加载');
};
icon.src = iconUrl;

window.addEventListener('resize', scheduleResize);
window.addEventListener('orientationchange', scheduleResize);
window.addEventListener('load', scheduleResize, { once: true });
window.addEventListener('error', () => {
  unlockScroll();
  bridge.failed('启动动画渲染失败');
});
window.addEventListener('unload', () => {
  cancelAnimationFrame(raf);
  if (resizeQueued) cancelAnimationFrame(resizeQueued);
  window.clearTimeout(finishTimer);
  offPointer();
  offState();
  offReveal();
  dprQuery?.removeEventListener('change', onDprChange);
  window.removeEventListener('resize', scheduleResize);
  window.removeEventListener('orientationchange', scheduleResize);
  window.removeEventListener('load', scheduleResize);
});
