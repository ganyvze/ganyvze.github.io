// ============================================================================
// Aircraft.js —— 飞机实体: 程序化机体建模 + 舵面/襟翼/起落架/螺旋桨动效
// 建模坐标系与物理机体系一致: +X 机头 / +Y 右翼 / +Z 机腹
// ============================================================================
import * as THREE from 'three';

const DEG = Math.PI / 180;

const AIL_MAX = 22 * DEG;   // 副翼行程
const ELE_MAX = 25 * DEG;   // 升降舵行程
const RUD_MAX = 28 * DEG;   // 方向舵行程
const SPOIL_MAX = 55 * DEG; // 减速板行程

export class Aircraft {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'Aircraft';
    scene.add(this.group);

    /* ---------- 材质 ---------- */
    const matBody = new THREE.MeshStandardMaterial({ color: 0x93a7b8, metalness: 0.35, roughness: 0.55 });
    const matAccent = new THREE.MeshStandardMaterial({ color: 0x7c8fa0, metalness: 0.35, roughness: 0.6 });
    const matDark = new THREE.MeshStandardMaterial({ color: 0x4c5a66, metalness: 0.3, roughness: 0.7 });
    const matGlass = new THREE.MeshStandardMaterial({ color: 0x0e1b26, metalness: 0.9, roughness: 0.12 });
    const matWheel = new THREE.MeshStandardMaterial({ color: 0x1b1e20, roughness: 0.9 });
    const matStrut = new THREE.MeshStandardMaterial({ color: 0x9aa2a8, metalness: 0.7, roughness: 0.4 });
    const matSpinner = new THREE.MeshStandardMaterial({ color: 0xd8dee4, metalness: 0.8, roughness: 0.3 });
    const matProp = new THREE.MeshStandardMaterial({ color: 0x23262a, metalness: 0.5, roughness: 0.6 });

    /* ---------- 机身 (Lathe 旋转体) ---------- */
    const fusProfile = [
      [0.001, 3.62], [0.14, 3.5], [0.30, 3.35], [0.52, 3.0], [0.70, 2.45],
      [0.82, 1.7], [0.90, 0.7], [0.92, -0.5], [0.88, -1.6], [0.76, -2.5],
      [0.58, -3.15], [0.38, -3.5], [0.16, -3.68], [0.10, -3.72],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const fusGeo = new THREE.LatheGeometry(fusProfile, 22);
    fusGeo.rotateZ(-Math.PI / 2);      // 旋转轴 +Y → +X (机头朝 +X)
    const fus = new THREE.Mesh(fusGeo, matBody);
    fus.castShadow = true;
    this.group.add(fus);

    // 座舱盖
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 22, 14), matGlass);
    canopy.scale.set(1.45, 0.58, 0.6);
    canopy.position.set(0.55, 0, -0.5);
    this.group.add(canopy);

    // 机头涡桨短舱 + 螺旋桨
    const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.75, 14), matSpinner);
    spinner.geometry.rotateZ(-Math.PI / 2);
    spinner.position.set(3.78, 0, 0);
    this.group.add(spinner);

    this.propSpin = 0;
    const prop = new THREE.Group();
    prop.position.set(3.95, 0, 0);
    for (let i = 0; i < 3; i++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.28, 0.3), matProp);
      blade.position.y = 0.72;
      blade.rotation.x = -18 * DEG;    // 桨叶扭转
      const hub = new THREE.Group();
      hub.rotation.x = (i / 3) * Math.PI * 2;
      hub.add(blade);
      prop.add(hub);
    }
    this.group.add(prop);
    this.prop = prop;

    // 排气管 (两侧)
    for (const s of [1, -1]) {
      const exh = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 1.9, 8), matDark);
      exh.geometry.rotateZ(Math.PI / 2);
      exh.position.set(-2.6, s * 0.42, -0.28);
      this.group.add(exh);
    }

    /* ---------- 机翼 (带二面角) ---------- */
    this.wingR = this._buildWing(matBody, matDark, 1);
    this.wingL = this._buildWing(matBody, matDark, -1);

    /* ---------- 平尾 + 升降舵 ---------- */
    const stab = new THREE.Mesh(new THREE.BoxGeometry(1.1, 4.7, 0.1), matAccent);
    stab.position.set(-3.42, 0, -0.05);
    this.group.add(stab);
    this.eleR = this._buildElevator(1);
    this.eleL = this._buildElevator(-1);

    /* ---------- 垂尾 + 方向舵 ---------- */
    const fin = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.1, 1.8), matAccent);
    fin.position.set(-3.65, 0, -0.62);
    this.group.add(fin);
    const rudPivot = new THREE.Group();
    rudPivot.position.set(-4.2, 0, -0.62);
    const rudder = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.09, 1.62), matDark);
    rudder.position.set(-0.18, 0, 0);
    rudPivot.add(rudder);
    this.group.add(rudPivot);
    this.rud = rudPivot;

    /* ---------- 起落架 ---------- */
    this.gearN = this._buildGear(matStrut, matWheel, { x: 2.05, y: 0, z: 0.45 }, true);
    this.gearMainR = this._buildGear(matStrut, matWheel, { x: -0.35, y: 1.72, z: 0.3 }, false);
    this.gearMainL = this._buildGear(matStrut, matWheel, { x: -0.35, y: -1.72, z: 0.3 }, false);

    /* ---------- 灯光 ---------- */
    const mkLight = (c, p, r = 0.07) => {
      const m = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: c, emissiveIntensity: 2.6 });
      const s = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 8), m);
      s.position.copy(p);
      this.group.add(s);
      return m;
    };
    this.lightRight = mkLight(0x18ff60, new THREE.Vector3(0.1, 6.05, -0.04));   // 右翼尖绿
    this.lightLeft = mkLight(0xff3040, new THREE.Vector3(0.1, -6.05, -0.04));   // 左翼尖红
    this.beaconMat = mkLight(0xff4040, new THREE.Vector3(-0.35, 0, -1.05), 0.06); // 防撞灯
    this.landMat = mkLight(0xfff2c0, new THREE.Vector3(-0.2, -2.4, 0.3), 0.09);  // 着陆灯

    /* ---------- 减速板 ---------- */
    this.spoilerR = this._buildSpoiler(matDark, 1);
    this.spoilerL = this._buildSpoiler(matDark, -1);

    this._spin = 0;
  }

  _buildWing(matBody, matDark, side) { // side: +1 右翼, -1 左翼
    const g = new THREE.Group();
    g.position.set(0, side * 0.95, 0.02);
    g.rotation.x = -side * 3 * DEG;          // 上反角
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.5, 4.7, 0.14), matBody);
    wing.position.set(0.05, side * 2.9, 0);
    wing.castShadow = true;
    g.add(wing);

    // 副翼
    const ailPivot = new THREE.Group();
    ailPivot.position.set(-0.4, side * 4.05, 0);
    const aileron = new THREE.Mesh(new THREE.BoxGeometry(0.38, 1.5, 0.09), matDark);
    aileron.position.set(-0.19, 0, 0);
    ailPivot.add(aileron);
    g.add(ailPivot);

    // 襟翼
    const flPivot = new THREE.Group();
    flPivot.position.set(-0.42, side * 2.15, 0);
    const flap = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.85, 0.1), matDark);
    flap.position.set(-0.2, 0, 0);
    flPivot.add(flap);
    g.add(flPivot);

    this.group.add(g);
    g.userData = { ail: ailPivot, flap: flPivot };
    return g;
  }

  _buildElevator(side) {
    const g = new THREE.Group();
    g.position.set(-3.84, side * 1.9, -0.05);
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.9, 0.09),
      new THREE.MeshStandardMaterial({ color: 0x4c5a66, roughness: 0.7 }));
    m.position.set(-0.19, 0, 0);
    g.add(m);
    this.group.add(g);
    return g;
  }

  _buildSpoiler(mat, side) {
    const g = new THREE.Group();
    g.position.set(0.1, side * 1.75, -0.09);
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.85, 0.02), mat);
    m.position.set(-0.22, 0, 0);
    g.add(m);
    this.group.add(g);
    return g;
  }

  _buildGear(matStrut, matWheel, anchor, isNose) {
    const pivot = new THREE.Group();
    pivot.position.set(anchor.x, anchor.y, anchor.z);
    const leg = new THREE.Group();

    // 撑杆 (沿 +Z 向下)
    const strutLen = isNose ? 0.85 : 0.62;
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, strutLen, 8), matStrut);
    strut.geometry.rotateX(Math.PI / 2);
    strut.position.z = strutLen / 2 - 0.12;
    leg.add(strut);

    // 转向组 (前轮) / 轮组
    const steer = new THREE.Group();
    const wheelCage = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.09, 10, 18), matWheel);
    tire.rotation.x = Math.PI / 2;          // 轮面竖直 (轴向 ±Y)
    tire.castShadow = true;
    wheelCage.add(tire);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.24, 8), matStrut);
    hub.geometry.rotateX(Math.PI / 2);
    wheelCage.add(hub);
    steer.add(wheelCage);
    leg.add(steer);
    pivot.add(leg);
    this.group.add(pivot);

    pivot.userData = { leg, strut, steer, wheelCage, isNose };
    return pivot;
  }

  /* ------------------------------------------------------------------ */
  update(snap, t, dt) {
    this.group.position.copy(snap.pos);
    this.group.quaternion.copy(snap.quat);

    // 主舵面 (镜像翼: 左翼舵面符号取反)
    const ailR = snap.rollInput * AIL_MAX;
    this.wingR.userData.ail.rotation.y = -ailR;
    this.wingL.userData.ail.rotation.y = ailR;

    const ele = snap.pitchInput * ELE_MAX;
    this.eleR.rotation.y = this.eleL.rotation.y = -ele;

    this.rud.rotation.z = -snap.rudderInput * RUD_MAX;

    // 襟翼 / 减速板
    const flap = snap.flapDeg * DEG;
    this.wingR.userData.flap.rotation.y = this.wingL.userData.flap.rotation.y = flap;
    const sp = snap.spoiler * SPOIL_MAX;
    this.spoilerR.rotation.y = this.spoilerL.rotation.y = -sp;

    // 起落架收放动画
    const pG = snap.gearProgress;
    this.gearN.rotation.y = -1.38 * pG;               // 前轮向后上收
    this.gearMainR.rotation.x = -1.45 * pG;           // 主轮向外上收
    this.gearMainL.rotation.x = 1.45 * pG;

    // 悬挂压缩 + 前轮转向 + 轮子滚动
    const pen = snap.gearCompression;                 // [nose, R, L]
    this._applySuspension(this.gearN, pen[0], snap.steerAngleDeg * DEG);
    this._applySuspension(this.gearMainR, pen[1], 0);
    this._applySuspension(this.gearMainL, pen[2], 0);

    this._spin += snap.wheelAngVel * dt;

    // 螺旋桨
    this.propSpin += (12 + snap.rpmPct * 42) * dt;
    this.prop.rotation.x = this.propSpin;

    // 防撞灯闪
    const flash = Math.sin(t * 5.2) > 0.45 ? 3.2 : 0.12;
    this.beaconMat.emissiveIntensity = flash;
    // 着陆灯 (地面时点亮)
    this.landMat.emissiveIntensity = snap.gearProgress < 0.4 ? 2.2 : 0.25;
  }

  _applySuspension(pivot, comp, steer) {
    const u = pivot.userData;
    u.steer.rotation.z = steer;                                     // 前轮转向
    const s = Math.max(0.15, 1 - comp / 0.4);
    u.strut.scale.z = s;
    u.wheelCage.rotation.y = this._spin ?? 0;                        // 轮滚动
    const base = u.isNose ? 0.72 : 0.46;
    u.wheelCage.position.z = base - comp + (u.isNose ? 0 : 0.05);
  }
}