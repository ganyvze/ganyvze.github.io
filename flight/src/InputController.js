// ============================================================================
// InputController.js —— 输入系统
//   · 鼠标虚拟操纵杆 (默认, 自回中) / 指针锁定精确模式 (Enter 切换)
//   · 键盘: W/S 油门, A/D 方向舵, B 刹车/减速板, F/G/C/R 事件
//   · Gamepad API: 左摇杆 滚转/俯仰, 右摇杆 方向舵, LT/RT 模拟扳机 = 油门
// ============================================================================
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const MOUSE_LOCK_GAIN = 0.0065;   // 指针锁定模式灵敏度 (满偏约需 155px 位移)
const STICK_SPRING = 2.2;         // 虚拟杆回中速率 (1/s)

export class InputController {
  constructor() {
    this.controls = { pitch: 0, roll: 0, rudder: 0, throttle: 0, brake: false, flapsIdx: 0, gearUp: false };
    this.mouseMode = 'stick';          // 'stick' (虚拟杆) | 'locked' (指针锁定)
    this.joy = { active: false, x: 0, y: 0 };  // -1..1 虚拟杆偏转

    this._keys = new Set();
    this._callbacks = { flaps: [], gear: [], camera: [], reset: [], lock: [] };
    this._stick = { x: 0, y: 0 };      // 指针锁定模式下的虚拟杆位置 (带自回中)
    this._dragOrigin = null;
    this._pad = null;
    this._btnDebounce = { flaps: 0, gear: 0, camera: 0 };
    this._canvas = null;

    this._bind();
  }

  on(evt, cb) { (this._callbacks[evt] = this._callbacks[evt] || []).push(cb); }
  _emit(evt) { for (const cb of this._callbacks[evt]) cb(); }

  /* 某键是否处于按下状态 (供按住连续调节: 方向键/翻页键等) */
  isDown(code) { return this._keys.has(code); }

  /* ---------------- 事件绑定 ---------------- */
  _bind() {
    window.addEventListener('keydown', (e) => {
      const c = e.code;
      if (['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyF', 'KeyG', 'KeyB', 'KeyR', 'KeyP', 'KeyH', 'KeyJ', 'KeyK', 'KeyZ', 'KeyX', 'KeyT', 'Space', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(c)) {
        e.preventDefault();
      }
      this._keys.add(c);
      if (!e.repeat) {
        if (c === 'KeyF') this._emit('flaps');
        if (c === 'KeyG') this._emit('gear');
        if (c === 'KeyC') this._emit('camera');
        if (c === 'KeyR') this._emit('reset');
        if (c === 'Enter') this._emit('lock');
        if (c === 'Space' || c === 'Escape') this._emit('pause');
        // 自动驾驶
        if (c === 'KeyP') this._emit('apMaster');
        if (c === 'KeyH') this._emit('apHdg');
        if (c === 'KeyJ') this._emit('apAlt');
        if (c === 'KeyK') this._emit('apVs');
        if (c === 'KeyZ') this._emit('apVsMinus');
        if (c === 'KeyX') this._emit('apVsPlus');
        if (c === 'KeyT') this._emit('apSpd');
        if (c === 'KeyW' || c === 'KeyS') this._emit('apThr');   // 手动动油门 = 断开自动油门
      }
    });
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));
    window.addEventListener('blur', () => this._keys.clear());

    // 虚拟操纵杆拖拽
    document.addEventListener('mousedown', (e) => {
      if (this.mouseMode !== 'stick') return;
      this._dragOrigin = { x: e.clientX, y: e.clientY };
      this._dragActive = true;
    });
    document.addEventListener('mousemove', (e) => {
      if (this.mouseMode === 'locked') {
        // 指针锁定: 位移累加 + 弹簧回中
        this._stick.x = clamp(this._stick.x + e.movementX * MOUSE_LOCK_GAIN, -1, 1);
        this._stick.y = clamp(this._stick.y + e.movementY * MOUSE_LOCK_GAIN, -1, 1);
        return;
      }
      if (this._dragActive && this._dragOrigin) {
        const R = 115;
        this.joy.x = clamp((e.clientX - this._dragOrigin.x) / R, -1, 1);
        this.joy.y = clamp((e.clientY - this._dragOrigin.y) / R, -1, 1);
        this.joy.active = true;
      }
    });
    window.addEventListener('mouseup', () => {
      this._dragActive = false; this._dragOrigin = null;
      this.joy.x = this.joy.y = 0; this.joy.active = false;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    // 指针锁定状态
    document.addEventListener('pointerlockchange', () => {
      this.mouseMode = document.pointerLockElement ? 'locked' : 'stick';
      if (this.mouseMode !== 'locked') { this._stick.x = this._stick.y = 0; }
    });

    // 手柄
    window.addEventListener('gamepadconnected', (e) => { this._pad = e.gamepad; });
    window.addEventListener('gamepaddisconnected', () => { this._pad = null; });
  }

  /* ---------------- 指针锁定 ---------------- */
  attachCanvas(canvas) { this._canvas = canvas; }
  requestLock() {
    if (!this._canvas) return;
    try {
      const p = this._canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => {});   // 无手势/被拒绝时静默降级为虚拟杆
    } catch (e) { /* 某些实现可能同步抛出, 忽略 */ }
  }
  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }
  toggleLock() {
    if (this.mouseMode === 'locked') this.exitLock();
    else this.requestLock();
  }

  resetControls() {
    this.controls.throttle = 0; this.controls.flapsIdx = 0;
    this.controls.gearUp = false; this.controls.brake = false;
    this._stick.x = this._stick.y = 0;
    this._keys.clear();
  }

  /* ---------------- 每帧轮询 ---------------- */
  update(dt, allowMouse = true) {
    const k = this._keys;
    const c = this.controls;

    // 键盘油门 (按住连续增/减)
    const rate = 0.42;
    if (k.has('KeyW')) c.throttle = Math.min(1, c.throttle + rate * dt);
    if (k.has('KeyS')) c.throttle = Math.max(0, c.throttle - rate * dt);

    // 键盘方向舵 (弹簧回中)
    const rudT = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    c.rudder += clamp(rudT - c.rudder, -2.4 * dt, 2.4 * dt);

    // 刹车 (按住 B)
    c.brake = k.has('KeyB');

    /* ---- 手柄 ---- */
    let gpRoll = 0, gpPitch = 0, gpRud = 0, gpThr = 0;
    if (!this._pad) {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      this._pad = pads.find(p => p && p.connected) || null;
    }
    if (this._pad) {
      const ax = this._pad.axes;
      const dz = (v) => (Math.abs(v) < 0.13 ? 0 : v);
      gpRoll = dz(ax[0]);
      gpPitch = dz(ax[1]);          // 杆后拉(摇杆向下) = 抬头, 前推 = 低头
      gpRud = dz(ax[2] ?? 0);
      const lt = this._pad.buttons[6]?.value ?? 0;   // 左扳机
      const rt = this._pad.buttons[7]?.value ?? 0;   // 右扳机
      gpThr = (rt - lt) * 0.5 * dt;
      // 按钮
      const blip = (b, name, evt) => {
        this._btnDebounce[name] -= dt;
        if (this._pad.buttons[b]?.pressed && this._btnDebounce[name] <= 0) {
          this._btnDebounce[name] = 0.4;
          this._emit(evt);
        }
      };
      blip(0, 'flaps', 'flaps');
      blip(1, 'gear', 'gear');
      blip(9, 'camera', 'camera');
    }
    c.throttle = clamp(c.throttle + gpThr, 0, 1);

    /* ---- 主操纵输入 (鼠标杆优先, 手柄补充) ---- */
    const dead = (v, d = 0.03) => (Math.abs(v) < d ? 0 : Math.sign(v) * Math.pow((Math.abs(v) - d) / (1 - d), 1.32));
    let mx = 0, my = 0;
    if (allowMouse) {
      if (this.mouseMode === 'locked') { mx = this._stick.x; my = this._stick.y; }
      else { mx = this.joy.x; my = this.joy.y; }
      // 虚拟杆自回中 (锁定模式)
      if (this.mouseMode === 'locked') {
        const sp = Math.exp(-STICK_SPRING * dt);
        this._stick.x *= sp; this._stick.y *= sp;
      }
    }
    const roll = dead(mx) || dead(gpRoll);
    const pitch = dead(my) || dead(gpPitch);   // 杆下拉(y+) = 抬头, 上推 = 低头 (真实驾驶杆习惯)
    c.roll = clamp(roll, -1, 1);
    c.pitch = clamp(pitch, -1, 1);
    if (Math.abs(gpRud) > 0.13) c.rudder = gpRud;
  }
}