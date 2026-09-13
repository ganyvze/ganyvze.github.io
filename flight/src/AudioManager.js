// ============================================================================
// AudioManager.js —— 程序化音效 (Web Audio API, 无需外部资源)
//   引擎轰鸣 (基频+谐波+次谐波, 随 N1 变化) / 风噪白噪声 / 地面滚动隆隆声 /
//   失速蜂鸣 / PULL UP 双音告警 / 液压起落架声 / 接地与坠机音效
// ============================================================================

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.started = false;
    this._hornPhase = 0;
    this._pullPhase = 0;
  }

  /* 须在用户手势中调用 */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.85;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 5;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
      this._buildEngine();
      this._buildWind();
      this._buildHorn();
      this._buildAlerts();
      this.started = true;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) { if (this.master) this.master.gain.value = m ? 0 : 0.85; }

  _noiseBuffer(seconds = 2, brown = false) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = brown ? (last + 0.02 * w) / 1.02 : w;
      d[i] = brown ? last * 3.5 : w;
    }
    return buf;
  }

  _buildEngine() {
    const c = this.ctx;
    this._eg = c.createGain(); this._eg.gain.value = 0;
    this._lpE = c.createBiquadFilter();
    this._lpE.type = 'lowpass'; this._lpE.frequency.value = 900;
    this._eg.connect(this._lpE); this._lpE.connect(this.master);

    this._o1 = c.createOscillator(); this._o1.type = 'sawtooth'; this._o1.frequency.value = 60;
    this._g1 = c.createGain(); this._g1.gain.value = 0.55;
    this._o2 = c.createOscillator(); this._o2.type = 'square'; this._o2.frequency.value = 121;
    this._g2 = c.createGain(); this._g2.gain.value = 0.22;
    this._o3 = c.createOscillator(); this._o3.type = 'sine'; this._o3.frequency.value = 30;
    this._g3 = c.createGain(); this._g3.gain.value = 0.9;
    // 涡桨高频呼啸
    this._o4 = c.createOscillator(); this._o4.type = 'triangle'; this._o4.frequency.value = 330;
    this._bp4 = c.createBiquadFilter(); this._bp4.type = 'bandpass'; this._bp4.frequency.value = 660; this._bp4.Q.value = 4;
    this._g4 = c.createGain(); this._g4.gain.value = 0.05;

    this._o1.connect(this._g1).connect(this._eg);
    this._o2.connect(this._g2).connect(this._eg);
    this._o3.connect(this._g3).connect(this._eg);
    this._o4.connect(this._bp4).connect(this._g4).connect(this.master);

    this._o1.start(); this._o2.start(); this._o3.start(); this._o4.start();
  }

  _buildWind() {
    const c = this.ctx;
    // 风噪声
    const src = c.createBufferSource();
    src.buffer = this._noiseBuffer(2, false);
    src.loop = true;
    this._bpW = c.createBiquadFilter(); this._bpW.type = 'bandpass'; this._bpW.frequency.value = 500; this._bpW.Q.value = 0.7;
    this._gw = c.createGain(); this._gw.gain.value = 0;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500;
    this._gh = c.createGain(); this._gh.gain.value = 0;
    src.connect(this._bpW).connect(this._gw).connect(this.master);
    src.connect(hp).connect(this._gh).connect(this.master);
    src.start();
    this._windSrc = src;

    // 地面滚动声 (棕噪声)
    const rSrc = c.createBufferSource();
    rSrc.buffer = this._noiseBuffer(2, true);
    rSrc.loop = true;
    this._lpR = c.createBiquadFilter(); this._lpR.type = 'lowpass'; this._lpR.frequency.value = 85;
    this._gr = c.createGain(); this._gr.gain.value = 0;
    rSrc.connect(this._lpR).connect(this._gr).connect(this.master);
    rSrc.start();
  }

  _buildHorn() {
    const c = this.ctx;
    this._horn = c.createOscillator(); this._horn.type = 'square'; this._horn.frequency.value = 850;
    this._ghorn = c.createGain(); this._ghorn.gain.value = 0;
    this._horn.connect(this._ghorn).connect(this.master);
    this._horn.start();
  }

  _buildAlerts() {
    const c = this.ctx;
    // PULL UP / 告警双音
    this._al = c.createOscillator(); this._al.type = 'triangle'; this._al.frequency.value = 1560;
    this._gal = c.createGain(); this._gal.gain.value = 0;
    this._al.connect(this._gal).connect(this.master);
    this._al.start();
    // 液压
    this._hy = c.createOscillator(); this._hy.type = 'sine'; this._hy.frequency.value = 250;
    this._ghy = c.createGain(); this._ghy.gain.value = 0;
    const lfo = c.createOscillator(); lfo.frequency.value = 7;
    const lg = c.createGain(); lg.gain.value = 30;
    lfo.connect(lg).connect(this._ghy.gain);
    this._hy.connect(this._ghy).connect(this.master);
    this._hy.start(); lfo.start();
  }

  /* ---------------- 事件音效 ---------------- */
  touchdown(hard = 0) {
    if (!this.started) return;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this._noiseBuffer(0.8, true);
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 220 + hard * 260; bp.Q.value = 0.8;
    const g = c.createGain();
    const t = c.currentTime;
    g.gain.setValueAtTime(0.6 + hard * 0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
  }

  crash() {
    if (!this.started) return;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this._noiseBuffer(1.6, true);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const g = c.createGain();
    const t = c.currentTime;
    g.gain.setValueAtTime(1.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t);
    this._eg.gain.setTargetAtTime(0, t, 0.05);
  }

  /* 自动驾驶提示音: on = 单音接通, off = 双音脱开 (类似民航告警) */
  _apBeep(freq, dur, gain = 0.14, delay = 0) {
    const c = this.ctx;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = 'sine'; o.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.03);
  }

  apTone(kind) {
    if (!this.started) return;
    if (kind === 'on') this._apBeep(950, 0.12);
    else { this._apBeep(640, 0.13); this._apBeep(430, 0.16, 0.14, 0.17); }
  }

  /* ---------------- 每帧更新 ---------------- */
  update(dt, a) {
    if (!this.started || !this.ctx) return;
    const c = this.ctx, t = c.currentTime;

    // 暂停: 所有持续性声源渐弱至静音
    if (a.paused) {
      this._eg.gain.setTargetAtTime(0, t, 0.08);
      this._gw.gain.setTargetAtTime(0, t, 0.08);
      this._gh.gain.setTargetAtTime(0, t, 0.08);
      this._gr.gain.setTargetAtTime(0, t, 0.08);
      this._ghorn.gain.setTargetAtTime(0, t, 0.05);
      this._gal.gain.setTargetAtTime(0, t, 0.05);
      this._ghy.gain.setTargetAtTime(0, t, 0.08);
      return;
    }

    const n1 = a.n1pct ?? 0;
    const speed = a.iasMs ?? 0;

    // 引擎: 基频随 N1 提升, 音量随油门
    const f = 46 + n1 * 1.55;
    this._o1.frequency.setTargetAtTime(f, t, 0.06);
    this._o2.frequency.setTargetAtTime(f * 2.02, t, 0.06);
    this._o3.frequency.setTargetAtTime(f * 0.5, t, 0.06);
    this._o4.frequency.setTargetAtTime(240 + n1 * 1.6, t, 0.08);
    this._bp4.frequency.setTargetAtTime(480 + n1 * 3.2, t, 0.08);
    this._g4.gain.setTargetAtTime(0.02 + n1 * 0.00055, t, 0.1);
    const engineGain = a.crashed ? 0 : 0.10 + n1 * 0.0041 + (a.throttle ?? 0) * 0.05;
    this._eg.gain.setTargetAtTime(engineGain, t, 0.1);
    this._lpE.frequency.setTargetAtTime(700 + n1 * 22, t, 0.1);

    // 风噪
    const w = Math.min(1, speed / 70);
    this._gw.gain.setTargetAtTime(Math.min(0.4, w * w * 0.24), t, 0.15);
    this._gh.gain.setTargetAtTime(Math.min(0.16, w * w * 0.09), t, 0.15);
    this._bpW.frequency.setTargetAtTime(280 + speed * 7, t, 0.2);

    // 地面滚动
    const gs = a.groundSpeedMs ?? 0;
    this._gr.gain.setTargetAtTime(Math.min(0.5, gs / 45) * 0.28, t, 0.12);

    // 失速蜂鸣 (急促门控)
    if (a.stallWarning) {
      this._hornPhase += dt * 3.2;
      this._ghorn.gain.setTargetAtTime(Math.sin(this._hornPhase * Math.PI * 2) > 0 ? 0.16 : 0, t, 0.015);
    } else {
      this._ghorn.gain.setTargetAtTime(0, t, 0.03);
    }

    // PULL UP 双音交替
    if (a.pullUp) {
      this._pullPhase += dt;
      const on = (this._pullPhase % 0.5) < 0.24;
      this._al.frequency.setTargetAtTime((this._pullPhase % 1.0) < 0.5 ? 1560 : 1980, t, 0.02);
      this._gal.gain.setTargetAtTime(on ? 0.22 : 0, t, 0.02);
    } else {
      this._gal.gain.setTargetAtTime(0, t, 0.05);
    }

    // 液压
    this._ghy.gain.setTargetAtTime(a.gearMoving ? 0.1 : 0, t, 0.1);
  }
}