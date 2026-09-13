// ============================================================================
// Autopilot.js —— 自动驾驶 (AP)
//   · A/P MASTER 开关 + 四种模式:
//       HDG 航向保持 (侧倾角捕获, 最大坡度 25°) / ALT 高度保持 /
//       VS 垂直速度保持 / SPD 自动油门 (P+I, 带死区)
//   · 纵向高度获取律: 高度误差 → 目标升降率 (钳制 ±7.5 m/s) → 俯仰指令
//   · 舵效/气动阻尼由机体本身提供, 控制律加滚转/俯仰角速率阻尼
//   · 失速保护: 大迎角时限制 AP 俯仰指令, 低速自动补油门
//   · 速度轴输出油门; 引擎自身 Spool 惯性提供响应滞后
// ============================================================================
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;
const FPM = 1 / 196.85; // ft/min → m/s

/* 目标微调速率 (按住方向键/翻页键连续调节, 每秒变化量) */
const AP_RATES = {
  hdg: 6,              // 航向 度/秒
  alt: 300 * 0.3048,   // 高度 米/秒
  vs: 400 * FPM,       // 升降率 m/s 每秒
  spd: 6,              // 速度 kt/秒
};

export class Autopilot {
  constructor() {
    this.master = false;
    this.hdg = false; this.alt = false; this.vs = false; this.spd = false;
    this.hdgTgt = 270;   // 度 (磁航向)
    this.altTgt = 0;     // m (MSL)
    this.vsTgt = 0;      // m/s (正=爬升)
    this.iasTgt = 0;     // kt
    this.discTime = -10; // 最近断开时刻 (simTime), 供 HUD 闪示
    this._spdI = 0;      // 自动油门积分项
    this._vsI = 0;       // 垂直速度积分项 (消除稳态配平误差)
    // 每帧输出: null = 该轴不由 AP 控制
    this.out = { pitch: null, roll: null, throttle: null };
  }

  /* 断开全部模式 (触地/人工超控/复位时调用) */
  disconnect() {
    this.master = this.hdg = this.alt = this.vs = this.spd = false;
    this._spdI = 0;
    this._vsI = 0;
  }

  /* 方向键/翻页键目标微调 (main 每帧调用):
     dirs.hdg / dirs.vert / dirs.spd ∈ {-1, 0, 1}
     · hdg:  若未接通则先捕获当前航向, 再按速率增减目标
     · vert: 若 ALT 接通 → 调目标高度; 若 VS 接通 → 调目标升降率; 都未接通 → 先接通 VS
     · spd:  若未接通则先捕获当前表速, 再按速率增减目标
     地面禁止, 返回是否执行; tone 仅在本次有新接通时回调 */
  nudgeTarget(st, dirs, dt, tone) {
    if (!st || st.onGround) return false;
    const R = AP_RATES;
    let engaged = false;
    if (dirs.hdg) {
      if (!this.hdg) { this.hdg = true; this.hdgTgt = st.headingDeg; engaged = true; }
      this.hdgTgt = (this.hdgTgt + dirs.hdg * R.hdg * dt + 360) % 360;
    }
    if (dirs.vert) {
      if (!this.vs && !this.alt) {
        this.vs = true; this.vsTgt = clamp(st.vel.y, -10.16, 10.16); engaged = true;
      }
      if (this.vs) this.vsTgt = clamp(this.vsTgt + dirs.vert * R.vs * dt, -10.16, 10.16);
      else if (this.alt) this.altTgt += dirs.vert * R.alt * dt;
    }
    if (dirs.spd) {
      if (!this.spd) { this.spd = true; this.iasTgt = st.iasKt; engaged = true; }
      this.iasTgt = clamp(this.iasTgt + dirs.spd * R.spd * dt, 55, 245);
    }
    if (engaged && tone) tone('on');
    return true;
  }

  /* 每帧控制律求解 → this.out (由 main 与手动输入混合) */
  update(dt, st) {
    const o = this.out;
    o.pitch = o.roll = o.throttle = null;
    if (!this.master || st.onGround) {
      this._spdI = 0;
      this._vsI = 0;
      return o;
    }

    /* ---- 横向: HDG 航向保持 ---- */
    if (this.hdg) {
      const err = wrap180(this.hdgTgt - st.headingDeg);     // 度
      let bankTgt = clamp(err * 0.9, -25, 25);              // 坡度指令 (限 25°)
      if (Math.abs(err) < 1.5) bankTgt = 0;                 // 捕获段: 回正
      o.roll = clamp(0.055 * (bankTgt - st.rollDeg) - 0.42 * st.p, -1, 1);
    }

    /* ---- 纵向: ALT (优先) / VS ---- */
    let vsCmd = null;
    if (this.alt) {
      // 高度获取律: 高度误差按 0.12 1/s 折算为目标升降率, 近目标时自然平滑收敛
      vsCmd = clamp((this.altTgt - st.pos.y) * 0.12, -7.5, 7.5);
    } else if (this.vs) {
      vsCmd = this.vsTgt;
    }
    if (vsCmd !== null) {
      // 姿态指令级联: 升降率误差 → 俯仰姿态目标(0.9°/mps + 慢积分消稳态误差) → 升降舵内环
      const e = vsCmd - st.vel.y;                    // 升降率误差 (m/s)
      this._vsI = clamp(this._vsI + e * dt * 0.18, -6, 6);   // 度
      const attTgt = clamp(0.9 * e + this._vsI, -12, 12);    // 度
      o.pitch = clamp(0.045 * (attTgt - st.pitchDeg) - 0.5 * st.q, -0.72, 0.72);
      if (Math.abs(o.pitch) < 0.02) o.pitch = 0;     // 死区: 消除稳态微抖
      // 失速保护: 大迎角时不继续带杆; 速度过低且未开自动油门 → 补中油门
      if (st.stallSig > 0.5) o.pitch = Math.min(o.pitch, 0.22);
      if (st.stallSig > 0.35 && !this.spd) o.throttle = Math.max(o.throttle, 0.55);
    } else {
      this._vsI = 0;
    }

    /* ---- 速度: SPD 自动油门 (P + 慢积分, 小死区) ---- */
    if (this.spd) {
      let e = this.iasTgt - st.iasKt;
      if (Math.abs(e) < 1.5) e = 0;
      this._spdI = clamp(this._spdI + e * dt * 0.006, -0.09, 0.09);
      o.throttle = clamp(0.3 + e * 0.012 + this._spdI, 0.12, 1.0);
    }
    return o;
  }
}

// 便捷常量导出 (供 main / 调试使用)
export const AP_LIMITS = { maxBank: 25, vsMin: -7.5, vsMax: 7.5, vsSelMax: 10.16, vsStep: 200 * FPM };