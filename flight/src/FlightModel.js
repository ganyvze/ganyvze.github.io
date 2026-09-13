// ============================================================================
// FlightModel.js —— 六自由度空气动力学与刚体动力学求解核心
// ----------------------------------------------------------------------------
// 机体坐标系: +X 机头前 / +Y 右翼 / +Z 机腹下  (NED 风格, 与 Three.js 世界系区分)
// 世界坐标系: Three.js 约定 (Y 竖直向上, X/Z 为地平面, 北 = -Z)
// 角速度符号: p=滚转率(右滚为正) q=俯仰率(抬头为正) r=偏航率(右偏为正)
// 控制输入:  pitch +1 = 拉杆抬头, roll +1 = 右压杆, rudder +1 = 右舵, 均 ∈ [-1,1]
// 单位: 国际单位制 (米/千克/秒), 角度内部用弧度, 对外状态用度
// ============================================================================
import * as THREE from 'three';

const DEG = Math.PI / 180;
const GRAV = 9.80665;
const RHO0 = 1.225;             // 海平面标准密度 kg/m^3
const FIXED_DT = 1 / 120;       // 固定物理子步 (120 Hz), 帧率独立
const MAX_SUBSTEPS = 8;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ------------------------------------------------------------------ */
/*  ISA 标准大气                                                        */
/* ------------------------------------------------------------------ */
function isaTemperature(h) {                    // h: 海拔 m
  return Math.max(216.65, 288.15 - 0.0065 * Math.min(h, 11000));
}
function isaDensity(h) {
  const T = isaTemperature(h);
  const p = 101325 * Math.pow(1 - 0.0065 * Math.min(h, 11000) / 288.15, 5.2561);
  return p / (287.058 * T);
}
function isaMach(h, v) {
  return v / Math.sqrt(1.4 * 287.058 * isaTemperature(Math.max(h, 0)));
}

/* ------------------------------------------------------------------ */
/*  气动系数表 (自变量: 攻角, 单位: 度; 线性插值)                          */
/* ------------------------------------------------------------------ */
// 升力系数 CL —— 含失速后的骤降与深失速区
const CL_TABLE = [
  [-180, -0.05], [-150, -0.62], [-120, -0.70], [-100, -0.28], [-90, 0.05],
  [-60, 0.75], [-45, 0.62], [-30, 0.55], [-24, 0.05], [-20, -0.50],
  [-16.5, -0.95], [-13, -0.62], [-9, -0.28], [-5, -0.02], [-2, 0.14],
  [0, 0.26], [4, 0.62], [8, 0.96], [11, 1.18], [14, 1.44],
  [16.5, 1.52], [19, 1.16], [23, 1.02], [28, 1.10], [35, 1.18],
  [45, 1.24], [60, 0.95], [75, 0.42], [90, 0.06], [105, -0.35],
  [120, -0.66], [150, -0.62], [180, -0.05],
];
// 寄生阻力系数 CD0 —— 失速后激增
const CD0_TABLE = [
  [-180, 1.90], [-120, 1.60], [-90, 1.75], [-60, 1.15], [-45, 0.85],
  [-35, 0.55], [-25, 0.22], [-20, 0.14], [-16, 0.10], [-12, 0.055],
  [-8, 0.036], [-4, 0.030], [0, 0.027], [4, 0.030], [8, 0.038],
  [12, 0.052], [14, 0.075], [16, 0.115], [18, 0.21], [20, 0.30],
  [24, 0.43], [30, 0.52], [40, 0.70], [60, 1.05], [90, 1.60],
  [120, 1.75], [150, 1.72], [180, 1.90],
];
// 俯仰力矩系数 CM (关于重心, 抬头为正) —— 负斜率 = 纵向静稳定
// 深失速区 (α>28°) 保持中性微负: 让机头可自然下坠退出失速, 避免深失速锁死
const CM_TABLE = [
  [-180, 0.0], [-90, 0.0], [-60, -0.02], [-45, 0.05], [-30, 0.06],
  [-20, 0.09], [-12, 0.10], [-8, 0.085], [-4, 0.062], [0, 0.045],
  [3, 0.026], [5, 0.008], [7, -0.012], [10, -0.038], [13, -0.066],
  [15, -0.09], [17, -0.085], [19, -0.06], [22, -0.03], [28, -0.012],
  [35, -0.012], [45, 0.0], [60, 0.0], [90, 0.0], [180, 0.0],
];
function lookup(tab, deg) {
  const x = clamp(deg, tab[0][0], tab[tab.length - 1][0]);
  for (let i = 0; i < tab.length - 1; i++) {
    const a = tab[i], b = tab[i + 1];
    if (x >= a[0] && x <= b[0]) {
      const t = (x - a[0]) / (b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return tab[tab.length - 1][1];
}

// 起落架几何与悬挂参数 (机体坐标)
const GEAR_CFG = [
  { x: 2.05, y: 0.0,  k: 43000, c: 4100, brake: false, steer: true },  // 前轮
  { x: -0.35, y: 1.72, k: 95000, c: 9800, brake: true, steer: false }, // 右主轮
  { x: -0.35, y: -1.72, k: 95000, c: 9800, brake: true, steer: false },// 左主轮
];

export class FlightModel {
  constructor(opts = {}) {
    this.terrainHeight = opts.terrainHeight ?? (() => 0);
    this.obstacleHit = opts.obstacleHit ?? (() => false);   // 建筑等实体障碍碰撞 (x,y,z)→bool
    this.C = {
      // ---- 质量与惯量 ----
      mass: 2300,                 // kg
      S: 16.3,                    // 机翼面积 m^2
      b: 11.0,                    // 翼展 m
      cbar: 1.55,                 // 平均气动弦长 m
      Ixx: 3400, Iyy: 12500, Izz: 15200,   // 转动惯量 kg·m^2 (滚/俯/偏)
      // ---- 动力 ----
      Tmax: 14000,                // 海平面最大推力 N (涡桨 ~1100 轴马力, T/W≈0.62)
      n1Idle: 0.28,               // 怠速 N1
      // ---- 气动导数 ----
      k: 0.048,                   // 诱导阻力因子 (CL^2 项)
      CYb: -0.85,                 // 侧力系数 /rad
      Clb: -0.075,                // 上反效应 (滚转静稳定)
      Clp: -0.47,                 // 滚转阻尼
      Cl_da: 0.077,               // 副翼滚转效能 ·(每单位输入, 已含 22° 行程折算)
      Cl_dr: 0.0064,              // 方向舵滚转交感 ·(已含 28° 行程)
      Cnb: 0.075,                 // 风标稳定性 (偏航静稳定)
      Cnr: -0.105,                // 偏航阻尼
      Cn_dr: 0.0367,              // 方向舵偏航效能 ·(已含 28° 行程)
      Cn_da: -0.0046,             // 副翼反偏航 ·(已含 22° 行程)
      CM_de: 0.18,                // 升降舵俯仰效能 ·(每单位输入, 已含 25° 行程; TE上偏符号已折算)
      CM_q: -15.0,                // 俯仰阻尼
      CM_flap: -0.035,            // 全放襟翼的低头力矩
      alphaCritBase: 16.5,        // 干净构型临界攻角 (度)
      // ---- 舵面行程 (rad) ----
      defAil: 22 * DEG,
      defEle: 25 * DEG,
      defRud: 28 * DEG,
      // ---- 起落架 / 地面 ----
      wheelR: 0.36,
      gearDownZ: 1.32,            // 放轮状态轮毂离重心垂向距离 (机体系 +Z)
      muRoll: 0.018,              // 滚动摩擦
      muBrake: 0.52,              // 刹车摩擦
      muLat: 0.95,                // 轮胎侧向抓地极限
      cLat: 5200,                 // 轮胎侧向刚度 N·s/m
      // ---- 其它 ----
      vRef: 55,                   // 舵面满效参考速度 m/s
      vneKt: 250,                 // 不可逾越速度 (节)
      windX: 0, windZ: 0,         // 恒定风 (世界系, m/s)
    };

    // ---- 状态量 ----
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.omega = new THREE.Vector3();     // (p, q, r) 机体角速度
    this.acc = 0;                         // 物理时间累加器
    this.simTime = 0;

    // ---- 控制/系统状态 ----
    this.controls = { pitch: 0, roll: 0, rudder: 0, throttle: 0, brake: false, flapsIdx: 0, gearUp: false };
    this.input = { pitch: 0, roll: 0, rudder: 0 };   // 带舵机速率平滑后的输入
    this.flapDeg = 0;
    this.gearProgress = 0;      // 0 = 放下, 1 = 收上
    this.n1 = this.C.n1Idle;
    this.parkingBrake = true;   // 初始停留刹车
    this.crashed = false;

    this.onGround = true;
    this.wowTimer = 0.5;
    this.steerAngle = 0;
    this.wheelAngVel = 0;
    this.currentSpoiler = 0;
    this.lastAlpha = 0;
    this.buffetSm = 0;
    this.peakLoad = 1.0;
    this.gearPen = [0, 0, 0];
    this.iasPrev = 0;

    // ---- 预分配临时向量 ----
    this._qInv = new THREE.Quaternion();
    this._va = new THREE.Vector3(); this._vb = new THREE.Vector3();
    this._liftDir = new THREE.Vector3(); this._dragDir = new THREE.Vector3();
    this._fA = new THREE.Vector3(); this._fG = new THREE.Vector3();
    this._mG = new THREE.Vector3(); this._fW = new THREE.Vector3();
    this._hub = new THREE.Vector3(); this._hubLocal = new THREE.Vector3();
    this._hubVel = new THREE.Vector3(); this._hubVb = new THREE.Vector3();
    this._omegaW = new THREE.Vector3(); this._wind = new THREE.Vector3();
    this._fTmp = new THREE.Vector3(); this._mTmp = new THREE.Vector3();
    this._rBody = new THREE.Vector3(); this._wBody = new THREE.Vector3();
    this._fwd = new THREE.Vector3(); this._right = new THREE.Vector3();
    this._up = new THREE.Vector3(); this._sf = new THREE.Vector3();
    this.gust = new THREE.Vector3();

    this.resetToRunway();
  }

  /* ------------------------------------------------------------------ */
  resetToRunway() {
    this.pos.set(980, 1.565, 0);            // 跑道 27 (东头) 起点
    // 姿态 = 机头朝西(-X) / 右翼朝北(-Z) / 机腹朝地(-Y), 即"朝向 27 的平地姿态"
    // 机体轴约定: +X 机头 / +Y 右翼 / +Z 机腹 (即模型 local 轴), 用 makeBasis 显式构造
    this._basisM = this._basisM || new THREE.Matrix4();
    this._basisM.makeBasis(
      new THREE.Vector3(-1, 0, 0),   // local X (机头) → 西
      new THREE.Vector3(0, 0, -1),   // local Y (右翼) → 北
      new THREE.Vector3(0, -1, 0)    // local Z (机腹) → 地
    );
    this.quat.setFromRotationMatrix(this._basisM);
    this.vel.set(0, 0, 0);
    this.omega.set(0, 0, 0);
    this.n1 = this.C.n1Idle;
    this.flapDeg = 0;
    this.gearProgress = 0;
    this.steerAngle = 0;
    this.parkingBrake = true;
    this.crashed = false;
    this.onGround = true;
    this.wowTimer = 0.5;
    this.acc = 0;
    this.lastAlpha = 0;
    this.buffetSm = 0;
    this.peakLoad = 1;
    this.input.pitch = this.input.roll = this.input.rudder = 0;
    this.gust.set(0, 0, 0);
  }

  /* ------------------------------------------------------------------ */
  /*  每帧入口：更新系统状态后以固定子步积分                                  */
  /* ------------------------------------------------------------------ */
  step(dt, controls) {
    dt = Math.min(Math.max(dt, 0), 0.05);
    if (controls) {
      Object.assign(this.controls, controls);
      this.controls.flapsIdx = clamp(Controls_i(this.controls.flapsIdx, 0, 3), 0, 3);
    }

    // ---- 油门 / 发动机 N1 转子惯性 (spool-up 滞后) ----
    const tgtN1 = this.C.n1Idle + (1 - this.C.n1Idle) * this.controls.throttle;
    const tau = tgtN1 >= this.n1 ? 2.6 : 1.35;         // 加速慢、减速快
    this.n1 += (tgtN1 - this.n1) * (1 - Math.exp(-dt / tau));

    // ---- 襟翼作动 ----
    const flapTargets = [0, 10, 22, 35];
    const fT = flapTargets[this.controls.flapsIdx];
    this.flapDeg = clamp(fT, this.flapDeg - 26 * dt, this.flapDeg + 26 * dt);

    // ---- 起落架作动 (有轮载时禁止收起) ----
    const wantUp = this.controls.gearUp && !this.onGround;
    this.gearProgress = clamp(wantUp ? 1 : 0, this.gearProgress - 0.65 * dt, this.gearProgress + 0.65 * dt);

    // ---- 停留刹车释放逻辑 ----
    if (this.parkingBrake && (this.controls.brake || this.controls.throttle > 0.03)) {
      this.parkingBrake = false;
    }

    // ---- 减速板: 空中按住 B 展开 ----
    this.currentSpoiler = (this.controls.brake && !this.onGround) ? 1 : 0;
    // 平滑展开 (视觉/力都跟随)
    this.currentSpoiler = clamp(this.currentSpoiler, this._spPrev !== undefined ? this._spPrev - 2.2 * dt : 0, this._spPrev !== undefined ? this._spPrev + 2.2 * dt : 1);
    this._spPrev = this.currentSpoiler;

    // ---- 操纵输入舵机平滑 ----
    const rate = 3.2;   // 满行程约 0.3s
    for (const k of ['pitch', 'roll', 'rudder']) {
      const t = this.controls[k], c = this.input[k];
      this.input[k] = Math.abs(t - c) < rate * dt ? t : c + Math.sign(t - c) * rate * dt;
    }

    // ---- 前轮转向 ----
    const steerTgt = this.input.rudder * 30 * (1 / (1 + Math.abs(this._hubVb.x) / 35)); // 高速时收敛
    this.steerAngle = clamp(steerTgt, this.steerAngle - 75 * dt, this.steerAngle + 75 * dt);

    // ---- 固定子步积分 ----
    this.acc += dt;
    let n = 0;
    while (this.acc >= FIXED_DT && n < MAX_SUBSTEPS) {
      if (this.crashed) this.crashedSubstep(FIXED_DT);
      else this.substep(FIXED_DT);
      this.simTime += FIXED_DT;
      this.acc -= FIXED_DT;
      n++;
    }
    if (n === MAX_SUBSTEPS) this.acc = 0;

    // ---- NaN 保险 ----
    if (!isFinite(this.pos.x + this.pos.y + this.pos.z + this.vel.x + this.omega.x)) {
      this.resetToRunway();
    }
    this.refreshState();
  }

  /* ------------------------------------------------------------------ */
  /*  低通半随机紊流 + 恒定风                                                */
  /* ------------------------------------------------------------------ */
  updateWinds(h) {
    const lag = Math.min(1, 2.0 * h);
    this.gust.x += ((Math.random() * 2 - 1) * 1.4 - this.gust.x) * lag;
    this.gust.y += ((Math.random() * 2 - 1) * 0.7 - this.gust.y) * lag;
    this.gust.z += ((Math.random() * 2 - 1) * 1.4 - this.gust.z) * lag;
    this._wind.set(this.C.windX + this.gust.x, this.gust.y, this.C.windZ + this.gust.z);
  }

  /* ------------------------------------------------------------------ */
  /*  单个物理子步: 受力分解 → 力矩 → 积分                                   */
  /* ------------------------------------------------------------------ */
  substep(h) {
    const C = this.C;
    this.updateWinds(h);

    const tH = this.terrainHeight(this.pos.x, this.pos.z);
    const agl = this.pos.y - tH;
    const rho = isaDensity(this.pos.y);
    this._qInv.copy(this.quat).invert();

    /* ---- 1. 相对气流与迎角 ---- */
    this._va.copy(this.vel).sub(this._wind);
    this._vb.copy(this._va).applyQuaternion(this._qInv);
    const V = this._vb.length();
    const VxM = Math.max(V, 0.45);
    const u = this._vb.x, v = this._vb.y, w = this._vb.z;
    let alpha, beta;
    if (V < 0.6) { alpha = this.lastAlpha * 0.9; beta = 0; }
    else {
      alpha = Math.atan2(w, u);
      beta = Math.asin(clamp(v / VxM, -1, 1));
    }
    const alphaDeg = alpha / DEG;
    const alphaDot = (alpha - this.lastAlpha) / h;
    this.lastAlpha = alpha;
    const qbar = 0.5 * rho * V * V;

    // 动失速迟滞: 攻角快速增大时升力峰值延后 (α̇ 修正)
    const alphaLag = clamp(1.8 * (C.cbar / (2 * VxM)) * alphaDot, -8 * DEG, 8 * DEG);
    const aEff = alpha - alphaLag;

    /* ---- 2. 地面效应 (高度 < 翼展时诱导阻力减小、升力增加) ---- */
    const xg = clamp(Math.max(agl, 0) / C.b, 0, 1);
    const sigma = (16 * xg * xg) / (1 + 16 * xg * xg);   // 升力线理论近似
    const kEff = C.k * (0.32 + 0.68 * sigma);
    const dCLge = 0.10 * (1 - xg);

    /* ---- 3. 构型增量 ---- */
    const dCLf = this.flapDeg * 0.0265;      // 全放 35° ≈ +0.93
    const dCDf = this.flapDeg * 0.00245;     // 全放 ≈ +0.086
    const gearAero = this.gearProgress < 0.45;
    const dCDg = gearAero ? 0.030 : 0;
    const sp = this.currentSpoiler;
    const alphaCrit = (C.alphaCritBase - this.flapDeg * 0.055) * DEG;

    /* ---- 4. 升阻特性 ---- */
    const CL = lookup(CL_TABLE, aEff / DEG) + dCLf + dCLge - 0.45 * sp;
    const CD = lookup(CD0_TABLE, aEff / DEG) + kEff * CL * CL + dCDf + dCDg + 0.105 * sp;
    const Lm = qbar * C.S * CL;              // 升力 N
    const Dm = qbar * C.S * CD;              // 阻力 N
    const Ym = qbar * C.S * C.CYb * beta;    // 侧力 N (β>0 时向左)

    // 升力方向: 垂直于相对气流与右翼轴 (right × Va)
    this._liftDir.set(0, 1, 0).cross(this._vb);
    if (this._liftDir.lengthSq() > 1e-8) this._liftDir.normalize();
    else this._liftDir.set(0, 0, -1);
    this._dragDir.copy(this._vb).multiplyScalar(-1 / VxM);

    this._fA.copy(this._liftDir).multiplyScalar(Lm).addScaledVector(this._dragDir, Dm);
    this._fA.y += Ym;

    /* ---- 5. 推力 (沿机体 X, 高空衰减) ---- */
    const n1n = clamp((this.n1 - C.n1Idle) / (1 - C.n1Idle), 0, 1);
    const thrust = C.Tmax * (0.05 + 0.95 * Math.pow(n1n, 1.8)) * Math.pow(rho / RHO0, 0.85);

    /* ---- 6. 气动力矩 (滚/俯/偏) ---- */
    const p = this.omega.x, q = this.omega.y, r = this.omega.z;
    const phat = p * C.b / (2 * VxM);
    const qhat = q * C.cbar / (2 * VxM);
    const rhat = r * C.b / (2 * VxM);
    const effC = clamp((V * V) / (C.vRef * C.vRef), 0.12, 1.0);   // 舵面低速失效
    // 失速区舵效衰退: 气流分离使舵面控制力下降 (越深失速越无力)
    const stallCtl = 1 - 0.62 * clamp((alphaDeg - (alphaCrit / DEG - 3)) / 9, 0, 1);
    const effCS = effC * stallCtl;
    const uR = this.input.roll, uP = this.input.pitch, uY = this.input.rudder;

    const cl = C.Clb * beta + C.Clp * phat + C.Cl_da * uR * effCS + C.Cl_dr * uY * effCS;
    const cm = lookup(CM_TABLE, aEff / DEG) + C.CM_q * qhat
             + C.CM_de * uP * effCS + C.CM_flap * (this.flapDeg / 35);
    const cn = C.Cnb * beta + C.Cnr * rhat + C.Cn_dr * uY * effCS + C.Cn_da * uR * effCS;

    let Mx = qbar * C.S * C.b * cl;
    let My = qbar * C.S * C.cbar * cm;
    let Mz = qbar * C.S * C.b * cn;

    /* ---- 7. 失速抖振与大气微扰 ---- */
    const stallSig = clamp((alphaDeg - (C.alphaCritBase - 6)) / 6, 0, 1) * (V > 6 ? 1 : 0.25);
    const buffetTgt = Math.max(stallSig * 0.6, sp * 0.45);
    this.buffetSm += (buffetTgt - this.buffetSm) * Math.min(1, 7 * h);
    const rnd = () => Math.random() * 2 - 1;
    if (this.buffetSm > 0.02) {
      const j = qbar * C.S * C.b * 0.0065 * this.buffetSm;
      Mx += rnd() * j; My += rnd() * j * 1.2; Mz += rnd() * j;
      this._fA.x += rnd() * qbar * C.S * 0.005 * this.buffetSm;
      this._fA.z += rnd() * qbar * C.S * 0.005 * this.buffetSm;
    }
    // 常值微扰 (随动压, 静态时无感)
    const tC = qbar * C.S * 0.0004;
    Mx += rnd() * tC * C.b; My += rnd() * tC * C.cbar; Mz += rnd() * tC * C.b;

    /* ---- 8. 重力 (世界系 -Y, 转至机体系) ---- */
    this._wBody.set(0, -C.mass * GRAV, 0).applyQuaternion(this._qInv);

    /* ---- 9. 起落架/地面接触力 (弹簧-阻尼-摩擦-转向) ---- */
    this._fG.set(0, 0, 0);
    this._mG.set(0, 0, 0);
    this._omegaW.copy(this.omega).applyQuaternion(this.quat);
    const brakeOn = this.controls.brake || this.parkingBrake;
    let Ntot = 0, maxPenDot = 0;

    if (this.gearProgress < 0.92) {
      for (let i = 0; i < GEAR_CFG.length; i++) {
        const g = GEAR_CFG[i];
        this._hubLocal.set(g.x, g.y, C.gearDownZ);
        this._hub.copy(this._hubLocal).applyQuaternion(this.quat).add(this.pos);
        const gap = this._hub.y - C.wheelR - this.terrainHeight(this._hub.x, this._hub.z);
        if (gap >= 0) { this.gearPen[i] = 0; continue; }

        const pen = -gap;
        this.gearPen[i] = pen;
        // 轮毂速度 (刚体运动学)
        this._rBody.copy(this._hub).sub(this.pos);
        this._hubVel.copy(this._omegaW).cross(this._rBody).add(this.vel);
        const penDot = -this._hubVel.y;
        maxPenDot = Math.max(maxPenDot, penDot);

        let N = g.k * pen + g.c * penDot;
        if (N <= 0) continue;
        Ntot += N;

        // 轮胎切向速度 (机体系)
        this._hubVb.copy(this._hubVel).applyQuaternion(this._qInv);
        if (i >= 1) this.wheelAngVel += (this._hubVb.x / C.wheelR - this.wheelAngVel) * Math.min(1, 8 * h);

        const mu = brakeOn && g.brake ? C.muBrake : C.muRoll;
        const Froll = -Math.tanh(this._hubVb.x / 0.7) * mu * N;
        let Fx, Fy;
        if (g.steer) {
          const sa = this.steerAngle * DEG;
          const vLat = -this._hubVb.x * Math.sin(sa) + this._hubVb.y * Math.cos(sa);
          const Fs = -clamp(vLat * C.cLat, -C.muLat * N, C.muLat * N);
          Fx = Froll - Math.sin(sa) * Fs;
          Fy = Math.cos(sa) * Fs;
        } else {
          const Fs = -clamp(this._hubVb.y * C.cLat, -C.muLat * N, C.muLat * N);
          Fx = Froll; Fy = Fs;
        }
        // 力与力矩 (体轴)
        this._fTmp.set(Fx, Fy, -N);
        this._fG.add(this._fTmp);
        this._mTmp.crossVectors(this._hubLocal, this._fTmp);
        this._mG.add(this._mTmp);
      }
    }

    /* ---- 10. 轮载 (WOW) 判定与结构过载 ---- */
    const loadFactor = Ntot / (C.mass * GRAV);
    this.peakLoad = Math.max(this.peakLoad * Math.exp(-0.5 * h), loadFactor);
    if (Ntot > 0.6 * C.mass * GRAV) this.wowTimer += h; else this.wowTimer = Math.max(0, this.wowTimer - 2 * h);
    this.onGround = this.wowTimer > 0.2;
    // 结构极限: 主轮爆震 / 悬架打底
    if (this.peakLoad > 4.6 || (Math.max.apply(null, this.gearPen) > 0.52 && maxPenDot > 4)) {
      this.crashed = true;
    }

    /* ---- 11. 合力/合力矩, 半隐式欧拉积分 ---- */
    this._fW.copy(this._fA)
      .add(this._fG)
      .add(this._wBody);
    this._fW.x += thrust;

    this._sf.copy(this._fW).sub(this._wBody).multiplyScalar(1 / C.mass); // 比力(不含重力), 用于 G 值

    Mx += this._mG.x; My += this._mG.y; Mz += this._mG.z;

    // 线运动
    this._fW.applyQuaternion(this.quat).multiplyScalar(1 / C.mass);
    this.vel.addScaledVector(this._fW, h);
    let spd = this.vel.length();
    if (spd > 220) this.vel.multiplyScalar(220 / spd);
    this.pos.addScaledVector(this.vel, h);
    // 硬地板保险
    const floor = this.terrainHeight(this.pos.x, this.pos.z) + 0.15;
    if (this.pos.y < floor) { this.pos.y = floor; if (this.vel.y < 0) this.vel.y *= -0.25; }

    /* ---- 障碍物碰撞 (塔台/机库等建筑: 结构损毁坠机) ---- */
    if (this.obstacleHit(this.pos.x, this.pos.y, this.pos.z)) {
      this.crashed = true;
    }

    // 角运动 (含陀螺交叉耦合项)
    const Ix = C.Ixx, Iy = C.Iyy, Iz = C.Izz;
    const pdot = (Mx + (Iy - Iz) * q * r) / Ix;
    const qdot = (My + (Iz - Ix) * r * p) / Iy;
    const rdot = (Mz + (Ix - Iy) * p * q) / Iz;
    this.omega.x = clamp(this.omega.x + pdot * h, -7, 7);
    this.omega.y = clamp(this.omega.y + qdot * h, -7, 7);
    this.omega.z = clamp(this.omega.z + rdot * h, -7, 7);

    // 四元数积分: q̇ = ½ q ⊗ [0, ω]  (机体系角速度, 右乘 = 机体轴旋转)
    const { x: qx, y: qy, z: qz, w: qw } = this.quat;
    const { x: wx, y: wy, z: wz } = this.omega;
    this.quat.x += 0.5 * (qw * wx + qy * wz - qz * wy) * h;
    this.quat.y += 0.5 * (qw * wy + qz * wx - qx * wz) * h;
    this.quat.z += 0.5 * (qw * wz + qx * wy - qy * wx) * h;
    this.quat.w += 0.5 * (-qx * wx - qy * wy - qz * wz) * h;
    this.quat.normalize();
  }

  /* ------------------------------------------------------------------ */
  /*  坠机后的衰减物理 (不解气动, 仅重力+地面+强阻尼)                          */
  /* ------------------------------------------------------------------ */
  crashedSubstep(h) {
    this.n1 = Math.max(0, this.n1 - 0.35 * h);
    this.omega.multiplyScalar(Math.exp(-2.5 * h));
    this._qInv.copy(this.quat).invert();
    const tH = this.terrainHeight(this.pos.x, this.pos.z);
    this._fW.set(0, -this.C.mass * GRAV, 0);
    this._fW.addScaledVector(this.vel, -0.25 * this.C.mass);   // 空气阻力近似
    // 地面支撑
    if (this.pos.y - tH < 0.3) {
      const k = 200000, c = 30000;
      const pen = 0.3 - (this.pos.y - tH);
      let N = k * pen - c * this.vel.y;
      if (N > 0) this._fW.y += N;
      this._fW.x -= this.vel.x * 0.35 * this.C.mass;
      this._fW.z -= this.vel.z * 0.35 * this.C.mass;
    }
    this.vel.addScaledVector(this._fW.multiplyScalar(1 / this.C.mass), FIXED_DT * 1);
    this.pos.addScaledVector(this.vel, h);
    const floor = tH + 0.2;
    if (this.pos.y < floor) { this.pos.y = floor; this.vel.y = 0; this.vel.x *= 0.6; this.vel.z *= 0.6; }
  }

  /* ------------------------------------------------------------------ */
  /*  输出快照 (供 HUD / 音效 / 视景 / 相机)                                 */
  /* ------------------------------------------------------------------ */
  refreshState() {
    const C = this.C;
    const tH = this.terrainHeight(this.pos.x, this.pos.z);
    const agl = Math.max(this.pos.y - tH, 0);
    const rho = isaDensity(this.pos.y);
    const V = this.vel.length();

    // 姿态 (fwd/right/up 体轴 → 世界)
    this._fwd.set(1, 0, 0).applyQuaternion(this.quat);
    this._right.set(0, 1, 0).applyQuaternion(this.quat);
    this._up.set(0, 0, -1).applyQuaternion(this.quat);

    let heading = Math.atan2(this._fwd.x, -this._fwd.z) / DEG;   // 北 = -Z
    if (heading < 0) heading += 360;
    const pitchDeg = Math.asin(clamp(this._fwd.y, -1, 1)) / DEG;
    const cosT = Math.max(Math.cos(pitchDeg * DEG), 0.15);
    const rollDeg = Math.asin(clamp(-this._right.y / cosT, -1, 1)) / DEG;

    const ias = V * Math.sqrt(rho / RHO0);
    const iasKt = ias * 1.94384;
    const tasKt = V * 1.94384;
    const mach = isaMach(this.pos.y, V);

    // 理论失速速度 (当前构型 CLmax 附近)
    const CLstall = lookup(CL_TABLE, C.alphaCritBase - this.flapDeg * 0.055) + this.flapDeg * 0.0265;
    const vsKt = Math.sqrt(2 * C.mass * GRAV / (rho * C.S * Math.max(CLstall, 0.9))) * Math.sqrt(rho / RHO0) * 1.94384;

    // 迎角快照
    this._qInv.copy(this.quat).invert();
    this._va.copy(this.vel).sub(this._wind).applyQuaternion(this._qInv);
    const Vs2 = Math.max(this._va.length(), 0.45);
    let al, be;
    if (this._va.length() < 0.6) { al = this.lastAlpha; be = 0; }
    else { al = Math.atan2(this._va.z, this._va.x); be = Math.asin(clamp(this._va.y / Vs2, -1, 1)); }
    const alphaDeg = al / DEG;

    const stallSig = clamp((alphaDeg - (C.alphaCritBase - this.flapDeg * 0.055 - 6)) / 6, 0, 1);
    // 失速警告只在空中显示: 地面(含起降滑跑)一律不显示
    const stallWarning = !this.onGround && V > 0.8 && (stallSig > 0.72 || iasKt < vsKt * 1.08);
    const stallHorn = stallWarning;

    // G 值 (比力沿机体法向 / g)
    const gLoad = -this._sf.z / GRAV;
    const gLat = this._sf.y / GRAV;

    // 告警
    const pullUp = !this.onGround && agl < 92 && this.vel.y < -6.2;
    const gearWarn = !this.onGround && this.gearProgress > 0.5 && this.controls.throttle < 0.35 && agl < 90;
    const overSpeed = iasKt > C.vneKt;

    this.iasAcc = (iasKt - this.iasPrev) / Math.max(FIXED_DT, 0.0083);
    this.iasPrev = iasKt;

    const flapsLabel = ['0°', '10°', '22°', '35°'][this.controls.flapsIdx];

    this.state = {
      crashed: this.crashed,
      onGround: this.onGround,
      simTime: this.simTime,
      pos: this.pos, quat: this.quat, vel: this.vel,
      pitchDeg, rollDeg, headingDeg: heading,
      p: this.omega.x, q: this.omega.y, r: this.omega.z,   // 机体角速率 (rad/s), 供自动驾驶阻尼项
      ias, iasKt, tasKt, mach,
      altFt: this.pos.y * 3.28084,
      aglFt: agl * 3.28084,
      vsFpm: this.vel.y * 196.85,
      alphaDeg, betaDeg: be / DEG,
      gLoad, gLat,
      n1: this.n1, n1pct: this.n1 * 100, rpmPct: this.n1 * 100,
      throttle: this.controls.throttle,
      thrustRatio: n1Ratio(this),
      flapDeg: this.flapDeg, flapIdx: this.controls.flapsIdx, flapLabel: flapsLabel,
      gearProgress: this.gearProgress,
      gearState: this.gearProgress < 0.05 ? 'down' : this.gearProgress > 0.95 ? 'up' : 'transit',
      gearCompression: this.gearPen.slice(),
      steerAngleDeg: this.steerAngle,
      wheelAngVel: this.wheelAngVel,
      spoiler: this.currentSpoiler,
      brake: this.controls.brake || this.parkingBrake,
      parkingBrake: this.parkingBrake,
      stallSig, stallWarning, stallHorn, vsKt,
      pullUp, gearWarn, overSpeed,
      buffet: this.buffetSm,
      peakLoad: this.peakLoad,
      iasAcc: this.iasAcc,
    };
    return this.state;
  }
}

/* 引擎推力比 (显示用) */
function n1Ratio(m) {
  const n1n = clamp((m.n1 - m.C.n1Idle) / (1 - m.C.n1Idle), 0, 1);
  return 0.05 + 0.95 * Math.pow(n1n, 1.8);
}
/* flapsIdx 钳制辅助 */
function Controls_i(v, a, b) { return clamp(v, a, b); }