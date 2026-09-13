// ============================================================================
// HUD.js —— 平视显示器 (Canvas 2D, 矢量发光风格)
//   姿态指引仪(俯仰梯+滚转刻度) / 空速带(IAS/TAS/Mach) / 高度带(MSL+AGL) /
//   VSI / 航向带 / FPV 飞行路径向量 / 迎角表 / G 值 / 发动机状态 / 告警
// ============================================================================

const DEG = Math.PI / 180;
const VNE_KT = 250;   // 与 FlightModel.C.vneKt 一致

const GC = 'rgba(105,255,160,0.95)';   // 主绿色
const GD = 'rgba(105,255,160,0.42)';   // 暗绿
const WT = 'rgba(235,255,244,0.98)';   // 白
const RED = '#ff4640';
const AMBER = '#ffc640';
const MAG = '#ff4fd8';                 // 品红: 自动驾驶目标游标

export class HUD {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = 0; this.H = 0; this.dpr = 1;
    this.resize();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.cv.width = Math.round(this.W * this.dpr);
    this.cv.height = Math.round(this.H * this.dpr);
    this.cv.style.width = this.W + 'px';
    this.cv.style.height = this.H + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /* ================= 主渲染 ================= */
  render(st, aux = {}) {
    const cv = this.ctx;
    const W = this.W, H = this.H;
    cv.clearRect(0, 0, W, H);
    const s = Math.min(Math.max(Math.min(W, H) / 780, 0.72), 1.45);
    const cx = W / 2, cy = H / 2;
    const ppd = 5.2 * s;           // 像素/度

    cv.save();
    cv.lineCap = 'round';
    cv.font = `${Math.round(12 * s)}px Consolas, monospace`;

    this._pitchLadder(st, cx, cy, s, ppd);
    this._bankScale(st, cx, cy, s);
    this._slipSkid(st, cx, cy, s, ppd);
    this._aoaScale(st, cx, cy, s);
    this._boresight(cx, cy, s);
    this._fpv(st, cx, cy, s, ppd);

    this._speedTape(st, W, H, cx, cy, s, aux.ap);
    this._altTape(st, W, H, cx, cy, s, aux.ap);
    this._headingTape(st, W, H, cx, cy, s, aux.ap);

    this._engineBlock(st, W, H, s);
    this._statusBlock(st, W, H, s);
    this._gMeter(st, W, H, s);
    this._apPanel(st, cx, s, aux.ap);

    this._warnings(st, W, H, cx, cy, s, aux.ap);

    if (aux.mouseMode === 'stick') this._joyOverlay(aux, cx, H, s);
    else this._lockIndicator(cx, H, s);

    // FPS
    cv.fillStyle = GD;
    cv.textAlign = 'right';
    cv.fillText(`${(aux.fps ?? 0).toFixed(0)} FPS`, W - 12 * s, H - 10 * s);
    cv.restore();
  }

  /* ---------------- 俯仰梯 ---------------- */
  _pitchLadder(st, cx, cy, s, ppd) {
    const cv = this.ctx;
    cv.save();
    cv.translate(cx, cy);
    cv.rotate(st.rollDeg * DEG);      // 右坡度 → 地平线顺时针倾斜

    const horizonY = st.pitchDeg * ppd;
    // 地平线 (加粗)
    cv.strokeStyle = WT;
    cv.shadowColor = GC; cv.shadowBlur = 8 * s;
    cv.lineWidth = 2.2 * s;
    cv.beginPath();
    cv.moveTo(-160 * s, horizonY); cv.lineTo(160 * s, horizonY);
    cv.stroke();
    cv.shadowBlur = 0;

    for (let p = -80; p <= 80; p += 5) {
      const y = (st.pitchDeg - p) * ppd;
      if (Math.abs(y) > this.H * 0.78) continue;
      const major = p % 10 === 0;
      const halfW = (major ? 95 : 56) * s * (1 - Math.min(Math.abs(p), 70) / 220);
      cv.strokeStyle = major ? GC : GD;
      cv.lineWidth = (major ? 2 : 1.2) * s;
      cv.beginPath();
      cv.moveTo(-halfW, y); cv.lineTo(halfW, y);
      cv.stroke();
      if (major && p !== 0) {
        cv.fillStyle = WT;
        cv.textAlign = 'left';
        cv.textBaseline = 'middle';
        cv.fillText((p > 0 ? '+' : '−') + Math.abs(p), halfW + 8 * s, y);
      }
    }
    cv.restore();
  }

  /* ---------------- 滚转刻度 + 天指针 ---------------- */
  _bankScale(st, cx, cy, s) {
    const cv = this.ctx;
    const R = 80 * s;
    cv.strokeStyle = GC;
    cv.lineWidth = 1.4 * s;
    for (const a of [10, 20, 30, 45, 60]) {
      const x = cx + Math.sin(a * DEG) * R, y = cy - Math.cos(a * DEG) * R;
      const len = (a >= 30 ? 10 : 6) * s;
      const x2 = cx + Math.sin(a * DEG) * (R - len), y2 = cy - Math.cos(a * DEG) * (R - len);
      cv.beginPath(); cv.moveTo(x, y); cv.lineTo(x2, y2); cv.stroke();
      if (a >= 45) {
        cv.fillStyle = GD;
        cv.textAlign = 'center'; cv.textBaseline = 'top';
        cv.fillText(String(a), x, y + 6 * s);
      }
    }
    // 天空指针
    const px = cx + Math.sin(st.rollDeg * DEG) * R;
    const py = cy - Math.cos(st.rollDeg * DEG) * R;
    cv.fillStyle = WT;
    cv.beginPath();
    cv.moveTo(px, py - 2 * s);
    cv.lineTo(px - 8 * s, py - 14 * s);
    cv.lineTo(px + 8 * s, py - 14 * s);
    cv.closePath();
    cv.fill();
  }

  /* ---------------- 侧滑球 ---------------- */
  _slipSkid(st, cx, cy, s, ppd) {
    const cv = this.ctx;
    const y = cy + 56 * s;
    const hw = 17 * s;
    cv.strokeStyle = GC;
    cv.lineWidth = 1.6 * s;
    cv.beginPath();
    cv.moveTo(cx - hw, y - 5 * s); cv.lineTo(cx + hw, y - 5 * s);
    cv.lineTo(cx + hw - 4 * s, y + 4 * s); cv.lineTo(cx - hw + 4 * s, y + 4 * s);
    cv.closePath();
    cv.stroke();
    const bx = Math.max(-hw + 4 * s, Math.min(hw - 4 * s, st.betaDeg * ppd * 2.2));
    cv.fillStyle = WT;
    cv.beginPath();
    cv.arc(cx + bx, y - 2 * s, 3.4 * s, 0, Math.PI * 2);
    cv.fill();
  }

  /* ---------------- 迎角表 ---------------- */
  _aoaScale(st, cx, cy, s) {
    const cv = this.ctx;
    const x = cx - 168 * s;
    const y0 = cy + 22 * s, dy = 2.35 * s;     // px per deg
    // 红色临界区
    cv.fillStyle = 'rgba(255,60,50,0.85)';
    const crit = 17;
    cv.fillRect(x - 3 * s, y0 - crit * dy, 8 * s, crit * dy);
    // 刻度
    cv.strokeStyle = GD;
    cv.beginPath();
    cv.moveTo(x, y0); cv.lineTo(x, y0 - 20 * dy);
    cv.stroke();
    cv.fillStyle = GC;
    cv.textAlign = 'right'; cv.textBaseline = 'middle';
    cv.fillText('α', x - 8 * s, y0 - 9 * dy);
    // 当前迎角游标
    const ay = y0 - Math.max(-5, Math.min(st.alphaDeg, 28)) * dy;
    cv.fillStyle = WT;
    cv.beginPath();
    cv.moveTo(x + 6 * s, ay);
    cv.lineTo(x + 14 * s, ay - 4 * s);
    cv.lineTo(x + 14 * s, ay + 4 * s);
    cv.closePath();
    cv.fill();
  }

  /* ---------------- 中心基准符号 ---------------- */
  _boresight(cx, cy, s) {
    const cv = this.ctx;
    cv.strokeStyle = GC;
    cv.fillStyle = GC;
    cv.lineWidth = 2 * s;
    cv.beginPath();
    cv.arc(cx, cy, 7 * s, 0, Math.PI * 2);
    cv.stroke();
    cv.beginPath();
    cv.moveTo(cx - 52 * s, cy); cv.lineTo(cx - 16 * s, cy);
    cv.moveTo(cx + 16 * s, cy); cv.lineTo(cx + 52 * s, cy);
    cv.moveTo(cx, cy - 7 * s); cv.lineTo(cx, cy - 14 * s);
    cv.stroke();
  }

  /* ---------------- FPV 飞行路径向量 ---------------- */
  _fpv(st, cx, cy, s, ppd) {
    const v = st.vel;
    const vh = Math.hypot(v.x, v.z);
    if (vh < 1.5) return;
    const chi = Math.atan2(v.x, -v.z) / DEG;          // 航迹方位角 (北=-Z)
    const gamma = Math.atan2(v.y, vh) / DEG;          // 航迹倾角
    let dx = ((chi - st.headingDeg + 540) % 360) - 180;
    dx *= ppd;
    const dy = (st.pitchDeg - gamma) * ppd;
    const ph = st.rollDeg * DEG;
    const x = cx + dx * Math.cos(ph) - dy * Math.sin(ph);
    const y = cy + dx * Math.sin(ph) + dy * Math.cos(ph);
    if (Math.abs(x - cx) > this.W || Math.abs(y - cy) > this.H) return;
    const cv = this.ctx;
    const r = 8.5 * s;
    cv.strokeStyle = WT;
    cv.lineWidth = 1.8 * s;
    cv.beginPath();
    cv.arc(x, y, r, 0, Math.PI * 2);
    cv.moveTo(x - r - 7 * s, y); cv.lineTo(x - r, y);
    cv.moveTo(x + r, y); cv.lineTo(x + r + 7 * s, y);
    cv.moveTo(x, y - r); cv.lineTo(x, y - r - 6 * s);
    cv.stroke();
  }

  /* ---------------- 空速带 ---------------- */
  _speedTape(st, W, H, cx, cy, s, ap) {
    const cv = this.ctx;
    const bx = W * 0.115, bw = 74 * s, bh = H * 0.58;
    const by = cy - bh / 2;
    const ppt = 1.45 * s;                       // px per kt

    cv.fillStyle = 'rgba(0,26,16,0.32)';
    cv.strokeStyle = GD;
    cv.lineWidth = 1.4 * s;
    this._rr(cv, bx, by, bw, bh, 4 * s);
    cv.fill(); cv.stroke();

    cv.save();
    cv.beginPath();
    this._rr(cv, bx, by, bw, bh, 4 * s);
    cv.clip();
    const lo = Math.floor((st.iasKt - 150) / 10) * 10;
    for (let kt = lo; kt <= st.iasKt + 150; kt += 10) {
      const y = cy + (st.iasKt - kt) * ppt;
      if (Math.abs(y - cy) > bh / 2) continue;
      const major = kt % 20 === 0;
      cv.strokeStyle = major ? GC : GD;
      cv.lineWidth = (major ? 2 : 1.2) * s;
      cv.beginPath();
      cv.moveTo(bx + bw - (major ? 24 : 14) * s, y);
      cv.lineTo(bx + bw, y);
      cv.stroke();
      if (major) {
        cv.fillStyle = WT;
        cv.textAlign = 'right'; cv.textBaseline = 'middle';
        cv.fillText(String(kt), bx + bw - 30 * s, y);
      }
    }
    // 失速速度红标
    const ys = cy + (st.iasKt - st.vsKt) * ppt;
    if (Math.abs(ys - cy) < bh / 2) {
      cv.fillStyle = RED;
      cv.fillRect(bx - 6 * s, ys - 5 * s, 12 * s, 10 * s);
    }
    // Vne 红白斜纹
    const yv = cy + (st.iasKt - VNE_KT) * ppt;
    if (Math.abs(yv - cy) < bh / 2 + 20 * s) {
      cv.fillStyle = RED;
      cv.fillRect(bx, yv - 4 * s, bw, 8 * s);
      cv.fillStyle = WT;
      cv.fillRect(bx, yv - 4 * s, bw, 3 * s);
    }
    cv.restore();

    // SPD 自动驾驶目标游标
    if (ap && ap.spd) {
      const yb = cy + (st.iasKt - ap.iasTgt) * ppt;
      if (Math.abs(yb - cy) < bh / 2) {
        cv.fillStyle = MAG;
        cv.beginPath();
        cv.moveTo(bx - 4 * s, yb);
        cv.lineTo(bx - 13 * s, yb - 5 * s);
        cv.lineTo(bx - 13 * s, yb + 5 * s);
        cv.closePath();
        cv.fill();
      }
    }

    // 指示框
    cv.fillStyle = 'rgba(0,14,8,0.92)';
    cv.strokeStyle = GC;
    cv.lineWidth = 1.6 * s;
    this._rr(cv, bx - 6 * s, cy - 18 * s, bw + 12 * s, 36 * s, 3 * s);
    cv.fill(); cv.stroke();
    cv.fillStyle = WT;
    cv.textAlign = 'right'; cv.textBaseline = 'middle';
    cv.font = `${Math.round(21 * s)}px Consolas, monospace`;
    cv.fillText(`${Math.round(st.iasKt)}`, bx + bw - 10 * s, cy);
    cv.font = `${Math.round(12 * s)}px Consolas, monospace`;

    // 趋势箭头
    const acc = st.iasAcc;
    if (Math.abs(acc) > 0.4) {
      const dir = acc > 0 ? -1 : 1;
      cv.fillStyle = GC;
      cv.beginPath();
      cv.moveTo(bx + bw + 24 * s, cy + dir * 8 * s);
      cv.lineTo(bx + bw + 30 * s, cy + dir * 2 * s);
      cv.lineTo(bx + bw + 18 * s, cy + dir * 2 * s);
      cv.closePath(); cv.fill();
    }
    cv.textAlign = 'left';
    cv.fillStyle = GD;
    cv.fillText(`M ${st.mach.toFixed(2)}`, bx, cy + 30 * s);
    cv.fillText(`TAS ${Math.round(st.tasKt)}`, bx, cy + 45 * s);
  }

  /* ---------------- 高度带 + VSI ---------------- */
  _altTape(st, W, H, cx, cy, s, ap) {
    const cv = this.ctx;
    const bw = 74 * s, bh = H * 0.58;
    const bx = W - W * 0.115 - bw, by = cy - bh / 2;
    const ppt = 0.092 * s;                      // px per ft

    cv.fillStyle = 'rgba(0,26,16,0.32)';
    cv.strokeStyle = GD;
    cv.lineWidth = 1.4 * s;
    this._rr(cv, bx, by, bw, bh, 4 * s);
    cv.fill(); cv.stroke();

    cv.save();
    cv.beginPath();
    this._rr(cv, bx, by, bw, bh, 4 * s);
    cv.clip();
    const lo = Math.floor((st.altFt - 4000) / 100) * 100;
    for (let ft = lo; ft <= st.altFt + 4000; ft += 100) {
      const y = cy + (st.altFt - ft) * ppt;
      if (Math.abs(y - cy) > bh / 2) continue;
      const major = ft % 200 === 0;
      cv.strokeStyle = major ? GC : GD;
      cv.lineWidth = (major ? 2 : 1.2) * s;
      cv.beginPath();
      cv.moveTo(bx, y);
      cv.lineTo(bx + (major ? 24 : 14) * s, y);
      cv.stroke();
      if (major) {
        cv.fillStyle = WT;
        cv.textAlign = 'left'; cv.textBaseline = 'middle';
        cv.fillText(String(ft), bx + 30 * s, y);
      }
    }
    cv.restore();

    // ALT 自动驾驶目标游标
    if (ap && ap.alt) {
      const yb = cy + (st.altFt - ap.altTgtFt) * ppt;
      if (Math.abs(yb - cy) < bh / 2 + 20 * s) {
        cv.fillStyle = MAG;
        cv.beginPath();
        cv.moveTo(bx + bw + 4 * s, yb);
        cv.lineTo(bx + bw + 12 * s, yb - 5 * s);
        cv.lineTo(bx + bw + 12 * s, yb + 5 * s);
        cv.closePath();
        cv.fill();
      }
    }

    // 指示框 (MSL)
    cv.fillStyle = 'rgba(0,14,8,0.92)';
    cv.strokeStyle = GC;
    cv.lineWidth = 1.6 * s;
    this._rr(cv, bx - 6 * s, cy - 18 * s, bw + 12 * s, 36 * s, 3 * s);
    cv.fill(); cv.stroke();
    cv.fillStyle = WT;
    cv.textAlign = 'left'; cv.textBaseline = 'middle';
    cv.font = `${Math.round(21 * s)}px Consolas, monospace`;
    cv.fillText(`${Math.round(st.altFt)}`, bx + 10 * s, cy);
    cv.font = `${Math.round(12 * s)}px Consolas, monospace`;
    cv.fillStyle = GD;
    cv.fillText('MSL ft', bx + 88 * s, cy);

    // 无线电高度 (低空)
    if (st.aglFt < 2800) {
      cv.fillStyle = 'rgba(0,14,8,0.92)';
      cv.strokeStyle = AMBER;
      this._rr(cv, bx - 6 * s, cy + 22 * s, bw + 12 * s, 24 * s, 3 * s);
      cv.fill(); cv.stroke();
      cv.fillStyle = AMBER;
      cv.textAlign = 'left';
      cv.fillText(`R ${Math.round(Math.max(st.aglFt, 0))}`, bx + 2 * s, cy + 34 * s);
    }

    // VSI 指针
    const vsy = cy + 40 * s;
    const halfH = 64 * s;
    cv.strokeStyle = GD;
    cv.lineWidth = 2 * s;
    cv.beginPath();
    cv.moveTo(bx - 12 * s, vsy - halfH); cv.lineTo(bx - 12 * s, vsy + halfH);
    cv.stroke();
    const yv = vsy - (Math.max(-3000, Math.min(st.vsFpm, 3000)) / 3000) * halfH;
    cv.fillStyle = GC;
    cv.beginPath();
    cv.moveTo(bx - 12 * s, yv);
    cv.lineTo(bx - 20 * s, yv - 4 * s);
    cv.lineTo(bx - 20 * s, yv + 4 * s);
    cv.closePath(); cv.fill();
    // VS 自动驾驶目标游标
    if (ap && ap.vs) {
      const yb = vsy - (Math.max(-3000, Math.min(ap.vsFpmTgt, 3000)) / 3000) * halfH;
      cv.strokeStyle = AMBER;
      cv.lineWidth = 1.6 * s;
      cv.beginPath();
      cv.moveTo(bx - 10 * s, yb);
      cv.lineTo(bx - 24 * s, yb - 3.5 * s);
      cv.lineTo(bx - 24 * s, yb + 3.5 * s);
      cv.closePath();
      cv.stroke();
    }
    cv.fillStyle = GD;
    cv.textAlign = 'left';
    cv.fillText(`${Math.round(st.vsFpm)}`, bx + 4 * s, vsy - halfH - 6 * s);
  }

  /* ---------------- 航向带 ---------------- */
  _headingTape(st, W, H, cx, cy, s, ap) {
    const cv = this.ctx;
    const y = 26 * s;
    const pph = 4.6 * s;
    cv.strokeStyle = GD;
    cv.lineWidth = 1.6 * s;
    cv.beginPath();
    cv.moveTo(cx - 78 * s, y + 26 * s); cv.lineTo(cx + 78 * s, y + 26 * s);
    cv.stroke();

    for (let h = 0; h < 360; h += 5) {
      let d = ((h - st.headingDeg + 540) % 360) - 180;
      if (Math.abs(d) > 78) continue;
      const x = cx + d * pph;
      const major = h % 10 === 0;
      cv.strokeStyle = major ? GC : GD;
      cv.lineWidth = (major ? 1.8 : 1.1) * s;
      cv.beginPath();
      cv.moveTo(x, y + (major ? 12 : 7) * s);
      cv.lineTo(x, y + 26 * s);
      cv.stroke();
      if (h % 30 === 0) {
        cv.fillStyle = WT;
        cv.textAlign = 'center'; cv.textBaseline = 'top';
        let lab;
        if (h === 0) lab = 'N'; else if (h === 90) lab = 'E';
        else if (h === 180) lab = 'S'; else if (h === 270) lab = 'W';
        else lab = String(h).padStart(3, '0');
        cv.fillText(lab, x, y + 9 * s);
      }
    }
    // 指针
    cv.fillStyle = WT;
    cv.beginPath();
    cv.moveTo(cx, y + 30 * s);
    cv.lineTo(cx - 7 * s, y + 22 * s);
    cv.lineTo(cx + 7 * s, y + 22 * s);
    cv.closePath(); cv.fill();
    // HDG 自动驾驶目标游标
    if (ap && ap.hdg) {
      const d = ((ap.hdgTgt - st.headingDeg + 540) % 360) - 180;
      if (Math.abs(d) <= 90) {
        const x = cx + d * pph;
        cv.fillStyle = MAG;
        cv.beginPath();
        cv.moveTo(x, y + 29 * s);
        cv.lineTo(x - 5 * s, y + 38 * s);
        cv.lineTo(x + 5 * s, y + 38 * s);
        cv.closePath();
        cv.fill();
      }
    }
  }

  /* ---------------- 发动机状态 ---------------- */
  _engineBlock(st, W, H, s) {
    const cv = this.ctx;
    const x = W * 0.115, y = H - 78 * s;
    const bw = 96 * s;
    cv.textBaseline = 'middle';
    cv.fillStyle = GC;
    cv.textAlign = 'left';
    cv.fillText('N1', x, y - 12 * s);
    cv.fillStyle = 'rgba(0,26,16,0.32)';
    cv.fillRect(x + 30 * s, y - 16 * s, bw, 8 * s);
    cv.fillStyle = GC;
    cv.fillRect(x + 30 * s, y - 16 * s, bw * st.n1pct / 100, 8 * s);
    cv.fillStyle = WT;
    cv.fillText(`${st.n1pct.toFixed(0)}%`, x + 30 * s + bw + 8 * s, y - 12 * s);

    cv.fillStyle = AMBER;
    cv.fillText('THR', x, y + 14 * s);
    cv.fillStyle = 'rgba(0,26,16,0.32)';
    cv.fillRect(x + 30 * s, y + 10 * s, bw, 8 * s);
    cv.fillStyle = AMBER;
    cv.fillRect(x + 30 * s, y + 10 * s, bw * st.throttle, 8 * s);
    cv.fillStyle = WT;
    cv.fillText(`${(st.throttle * 100).toFixed(0)}%`, x + 30 * s + bw + 8 * s, y + 14 * s);
  }

  /* ---------------- 起落架/襟翼/减速板状态 ---------------- */
  _statusBlock(st, W, H, s) {
    const cv = this.ctx;
    const x = W - W * 0.115;
    const y = H - 78 * s;
    // 起落架三灯
    const blink = Math.sin(st.simTime * 8) > 0;
    let col = GC;
    if (st.gearState === 'up') col = RED;
    else if (st.gearState === 'transit') col = blink ? AMBER : 'rgba(255,198,64,0.15)';
    cv.fillStyle = col;
    for (let i = 0; i < 3; i++) {
      this._rr(cv, x - 70 * s + i * 16 * s, y - 16 * s, 11 * s, 11 * s, 2 * s);
      cv.fill();
    }
    cv.textAlign = 'right';
    cv.textBaseline = 'middle';
    cv.fillStyle = col;
    cv.fillText(st.gearState === 'up' ? 'GEAR UP' : st.gearState === 'down' ? 'GEAR DN' : 'GEAR ●', x + 4 * s, y - 10 * s);

    // 襟翼/减速板/刹车
    cv.fillStyle = st.flapDeg > 1 ? AMBER : GD;
    cv.fillText(`FLAP ${st.flapLabel}`, x - 70 * s, y + 14 * s);
    if (st.spoiler > 0.5) { cv.fillStyle = AMBER; cv.fillText('SPLR', x - 70 * s, y + 30 * s); }
    if (st.brake) { cv.fillStyle = st.parkingBrake ? AMBER : GC; cv.fillText('BRK', x + 4 * s, y + 30 * s); }
  }

  /* ---------------- G 值 ---------------- */
  _gMeter(st, W, H, s) {
    const cv = this.ctx;
    const x = W * 0.115, y = 40 * s;
    let col = WT;
    if (st.gLoad > 4.2) col = RED;
    else if (st.gLoad > 2.4) col = AMBER;
    cv.fillStyle = col;
    cv.textAlign = 'left';
    cv.font = `${Math.round(22 * s)}px Consolas, monospace`;
    cv.fillText(`${st.gLoad.toFixed(1)} G`, x, y);
    cv.font = `${Math.round(12 * s)}px Consolas, monospace`;
    cv.fillStyle = GD;
    cv.fillText(`α ${st.alphaDeg.toFixed(1)}°  β ${st.betaDeg.toFixed(1)}°`, x, y + 18 * s);
  }

  /* ---------------- 自动驾驶通告栏 ---------------- */
  _apPanel(st, cx, s, ap) {
    if (!ap || !(ap.master || ap.disc)) return;
    const cv = this.ctx;
    const blink = Math.sin(st.simTime * 6) > 0;
    cv.textBaseline = 'middle';
    cv.font = `${Math.round(12 * s)}px Consolas, monospace`;
    const items = [
      { t: 'AP1', box: true, col: ap.master ? GC : (ap.disc && blink ? AMBER : GD) },
      { t: 'HDG ' + (ap.hdg ? String(Math.round(ap.hdgTgt)).padStart(3, '0') : '---'), on: ap.hdg },
      { t: 'SPD ' + (ap.spd ? String(Math.round(ap.iasTgt)) : '---'), on: ap.spd },
      { t: 'ALT ' + (ap.alt ? String(Math.round(ap.altTgtFt)) : '---'), on: ap.alt },
      { t: 'VS ' + (ap.vs ? (ap.vsFpmTgt >= 0 ? '+' : '−') + String(Math.round(ap.vsFpmTgt)) : '---'), on: ap.vs },
    ];
    const gaps = 11 * s;
    let total = 0;
    for (const it of items) total += cv.measureText(it.t).width + gaps;
    let x = cx - total / 2;
    const y = 64 * s;
    for (const it of items) {
      const w = cv.measureText(it.t).width;
      if (it.box) {
        cv.strokeStyle = it.col;
        cv.lineWidth = 1.2 * s;
        cv.strokeRect(x - 5 * s, y - 9.5 * s, w + 10 * s, 19 * s);
      }
      cv.fillStyle = it.on || it.box ? it.col : GD;
      cv.textAlign = 'left';
      cv.fillText(it.t, x, y + 0.5);
      x += w + gaps;
    }
  }

  /* ---------------- 告警 ---------------- */
  _warnings(st, W, H, cx, cy, s, ap) {
    const cv = this.ctx;
    const blink = Math.sin(st.simTime * 7) > 0;
    const glow = (c, blur) => { cv.shadowColor = c; cv.shadowBlur = blur; };
    cv.textAlign = 'center';
    cv.textBaseline = 'middle';
    if (st.pullUp && blink) {
      cv.fillStyle = RED;
      glow(RED, 22 * s);
      cv.font = `bold ${Math.round(30 * s)}px Consolas, monospace`;
      cv.fillText('PULL UP', cx, cy - 74 * s);
      glow('transparent', 0);
    }
    if (st.stallWarning && blink) {
      cv.fillStyle = RED;
      glow(RED, 16 * s);
      cv.font = `bold ${Math.round(20 * s)}px Consolas, monospace`;
      cv.fillText('STALL', W * 0.26, cy - 66 * s);
      glow('transparent', 0);
    }
    if (st.gearWarn && blink) {
      cv.fillStyle = AMBER;
      glow(AMBER, 18 * s);
      cv.font = `bold ${Math.round(24 * s)}px Consolas, monospace`;
      cv.fillText('GEAR', cx, cy + 84 * s);
      glow('transparent', 0);
    }
    if (st.overSpeed && blink) {
      cv.fillStyle = RED;
      glow(RED, 12 * s);
      cv.font = `bold ${Math.round(14 * s)}px Consolas, monospace`;
      cv.fillText('OVERSPEED', W * 0.115, cy - H * 0.29 - 8 * s);
      glow('transparent', 0);
    }
    if (ap && ap.disc && blink) {
      cv.fillStyle = AMBER;
      glow(AMBER, 14 * s);
      cv.font = `bold ${Math.round(16 * s)}px Consolas, monospace`;
      cv.fillText('AP DISC', cx, cy + 118 * s);
      glow('transparent', 0);
    }
    cv.font = `${Math.round(12 * s)}px Consolas, monospace`;
  }

  /* ---------------- 虚拟操纵杆覆盖层 ---------------- */
  _joyOverlay(aux, cx, H, s) {
    const cv = this.ctx;
    const R = 92 * s;
    const y = H - 142 * s;
    cv.strokeStyle = 'rgba(105,255,160,0.55)';
    cv.fillStyle = 'rgba(0,26,16,0.22)';
    cv.lineWidth = 1.6 * s;
    cv.beginPath();
    cv.arc(cx, y, R, 0, Math.PI * 2);
    cv.fill(); cv.stroke();
    cv.beginPath();
    cv.arc(cx, y, R * 0.5, 0, Math.PI * 2);
    cv.stroke();
    cv.beginPath();
    cv.moveTo(cx - R, y); cv.lineTo(cx + R, y);
    cv.moveTo(cx, y - R); cv.lineTo(cx, y + R);
    cv.stroke();
    const jx = aux.joy.x * (R - 18 * s), jy = aux.joy.y * (R - 18 * s);
    cv.fillStyle = aux.joy.active ? 'rgba(235,255,244,0.95)' : 'rgba(105,255,160,0.6)';
    cv.beginPath();
    cv.arc(cx + jx, y + jy, 13 * s, 0, Math.PI * 2);
    cv.fill();
    cv.fillStyle = 'rgba(105,255,160,0.5)';
    cv.textAlign = 'center';
    cv.fillText('拖拽鼠标 = 操纵杆 (下拖抬头 · 上推低头 · 左右压杆)', cx, y - R - 12 * s);
  }

  _lockIndicator(cx, H, s) {
    const cv = this.ctx;
    cv.fillStyle = 'rgba(105,255,160,0.5)';
    cv.textAlign = 'center';
    cv.fillText('● 指针锁定 (Enter 释放)', cx, H - 46 * s);
  }

  /* ---------------- 工具 ---------------- */
  _rr(cv, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cv.beginPath();
    cv.moveTo(x + r, y);
    cv.arcTo(x + w, y, x + w, y + h, r);
    cv.arcTo(x + w, y + h, x, y + h, r);
    cv.arcTo(x, y + h, x, y, r);
    cv.arcTo(x, y, x + w, y, r);
    cv.closePath();
  }
}