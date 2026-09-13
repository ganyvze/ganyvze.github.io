// ============================================================================
// main.js —— 主程序: 渲染器/主循环/固定子步物理/相机系统/状态机
//   状态机: READY (座舱外等待) → FLYING → CRASHED → (R) 复位
// ============================================================================
import * as THREE from 'three';
import { FlightModel } from './FlightModel.js';
import { Aircraft } from './Aircraft.js';
import { Environment } from './Environment.js';
import { HUD } from './HUD.js';
import { InputController } from './InputController.js';
import { AudioManager } from './AudioManager.js';
import { Autopilot } from './Autopilot.js';
import { ExplosionEffect } from './Effects.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ---------------- 渲染器 ---------------- */
const app = document.getElementById('app');
// logarithmicDepthBuffer: 提升远近深度精度, 消除跑道/地面/远山 z-fighting
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.classList.add('webgl');
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// 近裁剪面取 0.3m (座舱内视角仍可用), 远裁剪 24km, 配合对数深度稳住全程精度
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 24000);
camera.position.set(1010, 4, 8);
camera.lookAt(980, 1.5, 0);

/* ---------------- 子系统 ---------------- */
const env = new Environment(scene, renderer);
const fm = new FlightModel({
  terrainHeight: (x, z) => env.terrainHeight(x, z),
  obstacleHit: (x, y, z) => env.obstacleHit(x, y, z),   // 塔台/机库等建筑碰撞
});
const ac = new Aircraft(scene);
const fx = new ExplosionEffect(scene);
const input = new InputController();
const hud = new HUD(document.getElementById('hud'));
const audio = new AudioManager();
const ap = new Autopilot();
input.attachCanvas(renderer.domElement);

/* ---------------- 状态机 ---------------- */
let appState = 'READY';          // READY / FLYING / CRASHED
let camMode = 1;                 // 1 追尾 2 座舱 3 环绕
let crashShown = false;
let prevOnGround = true;
let paused = false;              // Space / 窗口失焦 暂停

const pauseBox = document.getElementById('pauseBox');
function togglePause(force) {
  if (appState === 'READY') return;
  paused = force !== undefined ? !!force : !paused;
  pauseBox.style.display = paused ? 'flex' : 'none';
}
window.addEventListener('blur', () => togglePause(true));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) togglePause(true);
});

const camHintEl = document.getElementById('camHint');
const overlay = document.getElementById('overlay');
const crashBox = document.getElementById('crashBox');
const CAMS = ['追尾视角', '座舱视角', '环绕视角'];

function setCamHint(extra = '') {
  camHintEl.textContent = `${CAMS[camMode - 1]} · C 切换视角${extra ? ' · ' + extra : ''}`;
}
setCamHint();

/* ---------------- 事件接线 ---------------- */
input.on('flaps', () => { input.controls.flapsIdx = (input.controls.flapsIdx + 1) % 4; });
input.on('gear', () => { input.controls.gearUp = !input.controls.gearUp; });
input.on('camera', () => {
  camMode = camMode % 3 + 1;
  if (camMode === 3) input.exitLock();
  setCamHint();
});
input.on('lock', () => input.toggleLock());
input.on('reset', () => doReset());

/* ---- 自动驾驶事件 ---- */
input.on('apMaster', () => apToggleMaster());
input.on('apHdg', () => apModeKey('hdg'));
input.on('apAlt', () => apModeKey('alt'));
input.on('apVs', () => apModeKey('vs'));
input.on('apVsMinus', () => apVsBump(-200));
input.on('apVsPlus', () => apVsBump(200));
input.on('apSpd', () => apModeKey('spd'));
input.on('apThr', () => {
  // 手动推收油门 = 断开自动油门 (其余模式保留)
  if (ap.spd) { ap.spd = false; audio.apTone('off'); }
});
input.on('pause', () => togglePause());

const AP_FPM = (fpm) => fpm / 196.85;   // ft/min → m/s

function apToggleMaster() {
  ap.master = !ap.master;
  if (!ap.master) { ap.hdg = ap.alt = ap.vs = ap.spd = false; ap._spdI = 0; }
  ap.discTime = ap.master ? -10 : fm.state.simTime;
  audio.apTone(ap.master ? 'on' : 'off');
}

function apModeKey(mode) {
  if (!ap.master) apToggleMaster();          // 快捷: 按模式键自动先接通主开关
  if (!ap.master) return;
  const st0 = fm.state;
  if (st0.onGround) {                        // 地面禁止接通模式
    ap.discTime = st0.simTime;
    audio.apTone('off');
    return;
  }
  ap[mode] = !ap[mode];
  if (ap[mode]) {
    if (mode === 'hdg') ap.hdgTgt = st0.headingDeg;                            // 捕获当前航向
    else if (mode === 'alt') { ap.altTgt = st0.pos.y; ap.vs = false; }         // 捕获当前高度
    else if (mode === 'vs') { ap.vsTgt = clamp(st0.vel.y, -10.16, 10.16); ap.alt = false; }
    else if (mode === 'spd') ap.iasTgt = st0.iasKt;                            // 捕获当前表速
  }
  audio.apTone(ap[mode] ? 'on' : 'off');
}

function apVsBump(dfpm) {
  if (!ap.master) apToggleMaster();
  if (!ap.master || fm.state.onGround) return;
  if (!ap.vs) {
    ap.vs = true; ap.alt = false;
    ap.vsTgt = clamp(fm.state.vel.y + AP_FPM(dfpm), -10.16, 10.16);
  } else {
    ap.vsTgt = clamp(ap.vsTgt + AP_FPM(dfpm), -10.16, 10.16);   // ±2000 fpm 行程
  }
  audio.apTone('on');
}

/* 方向键/翻页键按住连续微调 AP 目标:
   ←→ 航向 · ↑↓ 目标高度(ALT)/升降率(VS) · PgUp/PgDn 速度 */
function apKeyNudge(dt) {
  const hdg = (input.isDown('ArrowRight') ? 1 : 0) - (input.isDown('ArrowLeft') ? 1 : 0);
  const vert = (input.isDown('ArrowUp') ? 1 : 0) - (input.isDown('ArrowDown') ? 1 : 0);
  const spd = (input.isDown('PageUp') ? 1 : 0) - (input.isDown('PageDown') ? 1 : 0);
  if (!hdg && !vert && !spd) return;
  if (!ap.master) apToggleMaster();
  ap.nudgeTarget(fm.state, { hdg, vert, spd }, dt, (k) => audio.apTone(k));
}

document.getElementById('btnStart').addEventListener('click', () => {
  audio.unlock();
  overlay.style.display = 'none';
  appState = 'FLYING';
  togglePause(false);
  input.requestLock();
});

document.addEventListener('pointerlockchange', () => {
  setCamHint(input.mouseMode === 'locked' ? '指针锁定' : '虚拟操纵杆模式');
});

function doReset() {
  fm.resetToRunway();
  fm.simTime = 0;
  input.resetControls();
  ap.disconnect();
  ap.discTime = -10;
  fx.stop();
  camMode = 1;
  crashShown = false;
  crashBox.style.display = 'none';
  appState = fm.crashed ? 'CRASHED' : 'FLYING';
  togglePause(false);
  setCamHint();
  // 相机瞬移
  chaseCam.setting = true;
}

/* ---------------- 环绕视角控制 ---------------- */
const orbit = { az: 0.6, el: 0.28, radius: 34 };
let orbitDrag = false;
renderer.domElement.addEventListener('mousedown', (e) => { if (camMode === 3 && e.button === 0) orbitDrag = true; });
window.addEventListener('mouseup', () => { orbitDrag = false; });
window.addEventListener('mousemove', (e) => {
  if (camMode === 3 && orbitDrag) {
    orbit.az -= e.movementX * 0.005;
    orbit.el = clamp(orbit.el - e.movementY * 0.005, -1.25, 1.25);
  }
});
renderer.domElement.addEventListener('wheel', (e) => {
  if (camMode === 3) {
    e.preventDefault();
    orbit.radius = clamp(orbit.radius * Math.exp(e.deltaY * 0.0012), 8, 140);
  }
}, { passive: false });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  hud.resize();
});

/* ---------------- 相机 ---------------- */
const camPos = new THREE.Vector3(1010, 4, 8);
const camTgt = new THREE.Vector3(980, 1.5, 0);
const chaseCam = { setting: true };
const _vF = new THREE.Vector3();
// 座舱相机相对机体姿态: 相机 +X=右翼, +Y=上方(-Z), +Z=后方(-X) → 视线沿机头 +X
const _qCam = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(-1, 0, 0)
));
const _qShake = new THREE.Quaternion();
const _eye = new THREE.Vector3(0.3, 0.34, -0.68);
const _eyeW = new THREE.Vector3();
const _orbit = new THREE.Vector3();

function updateCamera(dt, st) {
  _vF.set(1, 0, 0).applyQuaternion(st.quat);      // 机体前向 (世界)

  if (camMode === 1) {
    const k = chaseCam.setting ? 1 : 1 - Math.exp(-2.6 * dt);
    chaseCam.setting = false;
    const desired = camPos.set(
      st.pos.x - _vF.x * 13, st.pos.y + 3.9, st.pos.z - _vF.z * 13
    );
    camPos.lerp(desired, k);
    const tgt = camTgt.set(
      st.pos.x + _vF.x * 18, st.pos.y + 0.9, st.pos.z + _vF.z * 18
    );
    camTgt.lerp(tgt, 1 - Math.exp(-5 * dt));
    camera.position.copy(camPos);
    camera.lookAt(camTgt);
  } else if (camMode === 2) {
    // 座舱: 飞行员眼睛位 + 机体姿态 + 抖振
    _eye.applyQuaternion(st.quat);
    _eyeW.copy(st.pos).add(_eye);
    camera.position.copy(_eyeW);
    const shake = 0.0016 + st.buffet * 0.024
      + (st.onGround && Math.hypot(st.vel.x, st.vel.z) > 3 ? 0.003 : 0);
    _qShake.setFromEuler(new THREE.Euler(
      (Math.random() * 2 - 1) * shake,
      (Math.random() * 2 - 1) * shake,
      (Math.random() * 2 - 1) * shake * 0.4
    ));
    camera.quaternion.copy(st.quat).multiply(_qCam).multiply(_qShake);
  } else {
    // 环绕
    const phi = Math.PI / 2 - orbit.el;
    _orbit.setFromSphericalCoords(orbit.radius, phi, orbit.az);
    camera.position.copy(st.pos).add(_orbit);
    camera.lookAt(st.pos);
  }
}

/* ---------------- 主循环 ---------------- */
const clock = new THREE.Clock();
let fpsAcc = 0, fpsCnt = 0, fps = 60;

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  // FPS
  fpsAcc += dt; fpsCnt++;
  if (fpsAcc >= 0.5) { fps = fpsCnt / fpsAcc; fpsAcc = 0; fpsCnt = 0; }

  if (!paused && appState !== 'READY') input.update(dt, camMode !== 3);

  // 自动驾驶: 方向键/翻页键目标微调 + 控制律求解 → 与手动输入混合; 人工超控 (>45%) 立即脱开
  if (!paused && appState === 'FLYING') {
    apKeyNudge(dt);
    const apOut = ap.update(dt, fm.state);
    const u = input.controls;
    if ((apOut.pitch !== null && Math.abs(u.pitch) > 0.45) ||
        (apOut.roll !== null && Math.abs(u.roll) > 0.45)) {
      ap.disconnect();
      ap.discTime = fm.state.simTime;
      audio.apTone('off');
    } else {
      if (apOut.pitch !== null) u.pitch = apOut.pitch;
      if (apOut.roll !== null) u.roll = apOut.roll;
      if (apOut.throttle !== null) u.throttle = apOut.throttle;
    }
  }
  if (!paused) fm.step(dt, input.controls);
  const st = fm.state;

  // 坠机状态切换 (由物理模型判定结构过载/触地冲击/建筑撞击)
  if (!paused && st.crashed && !crashShown) {
    crashShown = true;
    crashBox.style.display = 'flex';
    audio.crash();
    fx.boom(st.pos.x, st.pos.y, st.pos.z);   // 爆炸特效在坠机点触发
    appState = 'CRASHED';
    input.exitLock();
    ap.disconnect();
  }

  // 接地音效 + 触地自动脱开自动驾驶
  if (!paused && st.onGround && !prevOnGround) {
    const hard = clamp(-st.vsFpm / 1800, 0, 1);
    audio.touchdown(hard);
    if (ap.master) {
      ap.disconnect();
      ap.discTime = st.simTime;
      audio.apTone('off');
    }
  }
  prevOnGround = st.onGround;

  // 视景/机体动画/视角 (暂停时冻结; 环境照常渲染且由 simTime 驱动, 自然静止)
  if (!paused) {
    ac.update({
      pos: st.pos, quat: st.quat,
      rollInput: fm.input.roll, pitchInput: fm.input.pitch, rudderInput: fm.input.rudder,
      flapDeg: st.flapDeg, gearProgress: st.gearProgress,
      gearCompression: st.gearCompression, steerAngleDeg: st.steerAngleDeg,
      wheelAngVel: st.wheelAngVel, rpmPct: st.rpmPct,
    }, t, Math.max(dt, 1 / 120));
    updateCamera(dt, st);
    fx.update(Math.max(dt, 1 / 120));        // 爆炸特效动画 (暂停时冻结)
  }
  env.update(t, st, camera.position);
  audio.update(dt, {
    n1pct: st.n1pct, throttle: st.throttle, iasMs: st.ias,
    groundSpeedMs: st.onGround ? Math.hypot(st.vel.x, st.vel.z) : 0,
    onGround: st.onGround, stallWarning: st.stallHorn,   // 蜂鸣只跟随空中失速告警
    pullUp: st.pullUp, gearMoving: st.gearState === 'transit',
    crashed: st.crashed, paused,
  });

  hud.render(st, {
    fps, mouseMode: input.mouseMode, joy: input.joy,
    ap: {
      master: ap.master, hdg: ap.hdg, alt: ap.alt, vs: ap.vs, spd: ap.spd,
      hdgTgt: ap.hdgTgt, altTgtFt: ap.altTgt * 3.28084,
      vsFpmTgt: ap.vsTgt * 196.85, iasTgt: ap.iasTgt,
      disc: st.simTime - ap.discTime < 2.5,
    },
  });
  renderer.render(scene, camera);
}
loop();

// 调试入口
window.__SIM = { fm, audio, input, env, ac, camera, renderer, scene, hud, ap, fx };  // eslint-disable-line
console.log('%cFlightSim-6DOF 已就绪 —— 推油门 (W) 起飞, 跑道 27', 'color:#3dffb0');