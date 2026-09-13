// ============================================================================
// Effects.js —— 坠毁爆炸特效 (纯程序化, 无外部资源)
//   火球(加色球: 白→橙→暗红, 快速膨胀) + 火花粒子(重力弹道) +
//   烟尘粒团(缓升扩散) + 爆闪点光源
// ============================================================================
import * as THREE from 'three';

export class ExplosionEffect {
  constructor(scene) {
    this.scene = scene;
    this.active = false;
    this.t = 0;

    /* ---------- 火球 (加色混合, 不写深度) ---------- */
    this.fire = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    this.fire.visible = false;
    this.fire.frustumCulled = false;
    scene.add(this.fire);

    /* ---------- 火花粒子 ---------- */
    const SN = 110;
    this._sv = new Float32Array(SN * 3);
    for (let i = 0; i < SN; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const sp = 16 + Math.random() * 62;
      this._sv[i * 3] = Math.sin(ph) * Math.cos(th) * sp;
      this._sv[i * 3 + 1] = Math.cos(ph) * sp * 0.85 + 10;   // 上抛偏置
      this._sv[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SN * 3), 3));
    this.sparks = new THREE.Points(sg, new THREE.PointsMaterial({
      color: 0xffc25e, size: 1.7, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.sparks.visible = false;
    this.sparks.frustumCulled = false;
    scene.add(this.sparks);

    /* ---------- 烟尘 ---------- */
    const MN = 46;
    this._mvel = new Float32Array(MN * 3);
    for (let i = 0; i < MN; i++) {
      const th = Math.random() * Math.PI * 2;
      const r = Math.random() * 6;
      this._mvel[i * 3] = Math.cos(th) * r * 1.6;
      this._mvel[i * 3 + 1] = 4 + Math.random() * 8;
      this._mvel[i * 3 + 2] = Math.sin(th) * r * 1.6;
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MN * 3), 3));
    this.smoke = new THREE.Points(mg, new THREE.PointsMaterial({
      color: 0x3a3a38, size: 6.5, transparent: true, opacity: 0, depthWrite: false,
    }));
    this.smoke.visible = false;
    this.smoke.frustumCulled = false;
    scene.add(this.smoke);

    /* ---------- 爆闪光 ---------- */
    this.light = new THREE.PointLight(0xffb060, 0, 400, 1.6);
    scene.add(this.light);
  }

  boom(x, y, z) {
    this.t = 0;
    this.active = true;
    for (const m of [this.fire, this.sparks, this.smoke]) {
      m.visible = true;
      m.position.set(x, y, z);
    }
    this.light.position.set(x, y, z);
    for (const pts of [this.sparks, this.smoke]) {
      pts.geometry.attributes.position.array.fill(0);
      pts.geometry.attributes.position.needsUpdate = true;
    }
    this.fire.scale.setScalar(1.5);
    this.fire.material.color.setHex(0xffffff);
  }

  stop() {
    this.active = false;
    this.fire.visible = this.sparks.visible = this.smoke.visible = false;
    this.light.intensity = 0;
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const t = this.t;

    /* 火球: 0.22s 膨胀到位, 白→橙→暗红, 约 1.4s 燃尽 */
    const expand = Math.min(1, t / 0.22);
    this.fire.scale.setScalar(1.5 + expand * 11);
    const fm = this.fire.material;
    if (t < 0.08) fm.color.setHex(0xffffff);
    else if (t < 0.24) fm.color.setHex(0xffd984);
    else if (t < 0.7) fm.color.setHex(0xff7a2a);
    else fm.color.setHex(0x6a2c10);
    fm.opacity = t < 0.5 ? Math.min(1, 0.35 + t * 2) : Math.max(0, 1.35 - t * 1.35);

    /* 火花: 重力弹道, 1.5s 后淡出 */
    const sp = this.sparks.geometry.attributes.position.array;
    for (let i = 0; i < this._sv.length; i += 3) {
      this._sv[i + 1] -= 24 * dt;
      sp[i] += this._sv[i] * dt;
      sp[i + 1] += this._sv[i + 1] * dt;
      sp[i + 2] += this._sv[i + 2] * dt;
    }
    this.sparks.geometry.attributes.position.needsUpdate = true;
    this.sparks.material.opacity = t < 1.5 ? Math.min(1, t * 4) : Math.max(0, 1 - (t - 1.5) / 0.8);

    /* 烟尘: 缓慢升腾扩散, 全周期淡入淡出 */
    const mp = this.smoke.geometry.attributes.position.array;
    for (let i = 0; i < this._mvel.length; i += 3) {
      mp[i] += this._mvel[i] * dt;
      mp[i + 1] += this._mvel[i + 1] * dt;
      mp[i + 2] += this._mvel[i + 2] * dt;
    }
    this.smoke.geometry.attributes.position.needsUpdate = true;
    this.smoke.material.opacity = Math.min(1, t * 2.5) * Math.max(0, 1 - t / 2.8);

    /* 爆闪光: 0.12s 冲到峰值, 指数衰减 */
    this.light.intensity = t < 0.12
      ? (t / 0.12) * 2400
      : Math.max(0, 2400 * Math.exp(-(t - 0.12) * 3.4));

    if (t > 3) this.stop();
  }
}