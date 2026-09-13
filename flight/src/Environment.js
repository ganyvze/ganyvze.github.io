// ============================================================================
// Environment.js —— 环境: 动态天空/雾, 跑道设施, PAPI 进近灯, 无限程序化地形
//   · 地形像 Minecraft 一样按块 (chunk) 无限生成: 无论飞多远脚下都有陆地
//   · 确定性噪声地形 (丘陵基面) + 概率山峰 (2km 网格) + 概率机场 (4km 网格, 展平)
//   · 所有函数为世界坐标的纯函数 → 分块无缝拼合 & 物理碰撞高度完全一致
//   · 跑道 09/27: 东西走向沿 X 轴 (x∈[-1200, 1200]), 东头 09 / 西头 27
// ============================================================================
import * as THREE from 'three';

const RWY_HALF = 1200;   // 主跑道半长 m
const RWY_HALF_W = 22.5; // 主跑道半宽 m

/* ================= 确定性哈希 / 噪声 (纯函数) ================= */
const CHUNK = 1024;      // 地形块边长 m
const CHUNK_SEGS = 16;   // 每块分段 (16×16 → 低多边形 MC 风格)
const CHUNK_RADIUS = 9;  // 装载半径 (块数) → 视距约 9.2km
const MTN_CELL = 2048;   // 山峰网格 m
const AP_CELL = 4096;    // 机场网格 m

function hash2i(x, z, s) {
  let h = (x * 374761393 + z * 668265263 + s * 1442695041) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}
const smooth = (t) => t * t * (3 - 2 * t);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function vnoise(x, z, s) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const fx = x - xi, fz = z - zi;
  const a = hash2i(xi, zi, s), b = hash2i(xi + 1, zi, s);
  const c = hash2i(xi, zi + 1, s), d = hash2i(xi + 1, zi + 1, s);
  const u = smooth(fx), v = smooth(fz);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, z, s, oct) {
  let v = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += a * vnoise(x * f, z * f, s + i * 777); a *= 0.5; f *= 2.05; }
  return v;
}

/* 丘陵基面 (不含山体/机场展平) */
function hillsAt(x, z) {
  return (fbm(x * 0.0011, z * 0.0011, 101, 3) - 0.5) * 64
    + (fbm(x * 0.007, z * 0.007, 201, 2) - 0.5) * 12;
}

/* 机场净空区: 主机场(原点)6.5km / 程序化机场 5.5km 半径内保证无山峰.
   山峰中心距边界至少 2km 以上, 高斯尾(σ≤860m)在机场周边贡献 <60m/<2m:
   机场四周地形在数学上等价于纯丘陵 (≤±40m), 不依赖随机种子 */
function airportClearAt(px, pz) {
  if (px * px + pz * pz < 6500 * 6500) return true;      // 主机场
  const cx0 = Math.floor(px / AP_CELL), cz0 = Math.floor(pz / AP_CELL);
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    const ap = airportOfCell(cx0 + dx, cz0 + dz);
    if (!ap) continue;
    const dxa = px - ap.mx, dza = pz - ap.mz;
    if (dxa * dxa + dza * dza < 5500 * 5500) return true;
  }
  return false;
}

/* 概率山峰: 每个 2km 网格 18% 概率一座高斯峰 (查 3×3 邻域; 机场净空区内跳过) */
function mountainContrib(x, z) {
  let h = 0;
  const cx0 = Math.floor(x / MTN_CELL), cz0 = Math.floor(z / MTN_CELL);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const cx = cx0 + dx, cz = cz0 + dz;
    if (hash2i(cx, cz, 501) > 0.18) continue;
    const mx = (cx + 0.5 + (hash2i(cx, cz, 502) - 0.5) * 0.85) * MTN_CELL;
    const mz = (cz + 0.5 + (hash2i(cx, cz, 503) - 0.5) * 0.85) * MTN_CELL;
    if (airportClearAt(mx, mz)) continue;               // 机场周围不设山
    const H = 320 + hash2i(cx, cz, 504) * 520;          // 320~840m
    const sig = 430 + hash2i(cx, cz, 505) * 430;        // 430~860m
    const d2 = (x - mx) * (x - mx) + (z - mz) * (z - mz);
    if (d2 > (3 * sig) * (3 * sig)) continue;
    h += H * Math.exp(-d2 / (2 * sig * sig));
  }
  return h;
}

/* 程序化机场: 每个 4km 网格 5.5% 概率 (平均间距约 17km), 主机场 3.6km 内不生成.
   返回 null 或 {mx, mz, hdg(rad), run(跑道长), halfW, h0(展平高度)} */
function airportOfCell(cx, cz) {
  if (hash2i(cx, cz, 901) > 0.055) return null;
  const mx = (cx + 0.5 + (hash2i(cx, cz, 902) - 0.5) * 0.8) * AP_CELL;
  const mz = (cz + 0.5 + (hash2i(cx, cz, 903) - 0.5) * 0.8) * AP_CELL;
  if (mx * mx + mz * mz < 3600 * 3600) return null;    // 避开主机场空域
  return {
    mx, mz,
    hdg: (hash2i(cx, cz, 904) * 8 | 0) * 45 * Math.PI / 180,   // 8 方位
    run: 1150, halfW: 16,
    h0: hillsAt(mx, mz),
    cell: cx + ',' + cz,
  };
}

/* 程序化机场展平 (查 3×3 相邻格; 平台边缘 140m 渐变带) */
function airportPlatBlend(x, z, h) {
  const cx0 = Math.floor(x / AP_CELL), cz0 = Math.floor(z / AP_CELL);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const ap = airportOfCell(cx0 + dx, cz0 + dz);
    if (!ap) continue;
    const ox = x - ap.mx, oz = z - ap.mz;
    const c = Math.cos(-ap.hdg), s = Math.sin(-ap.hdg);
    const lx = ox * c - oz * s, lz = ox * s + oz * c;           // 跑道坐标系
    const d = Math.max(Math.abs(lx) - (ap.run / 2 + 100), Math.abs(lz) - (ap.halfW + 90));
    if (d > 140) continue;
    return ap.h0 + (h - ap.h0) * smooth(clamp01(d / 140));
  }
  return h;
}

/* 主机场 (09/27) 展平到 -0.04m: 覆盖跑道/滑行道/停机坪范围, 边缘 130m 渐变.
   略低于铺装面(0m) → 地面与跑道平面永不共面; 轮载下沉 4cm 不可察觉 */
function homePlatBlend(x, z, h) {
  const d = Math.max(Math.abs(x) - 1240, z - 190, -(z + 100));
  if (d > 130) return h;
  return -0.04 + (h + 0.04) * smooth(clamp01(d / 130));
}

/* 世界地形高度 (丘陵 + 山体 + 机场展平) —— 渲染与物理共用 */
function worldHeight(x, z) {
  let h = hillsAt(x, z) + mountainContrib(x, z);
  h = airportPlatBlend(x, z, h);
  h = homePlatBlend(x, z, h);
  return h;
}

/* 是否处于机场铺装区域 (主机场或任一程序化机场平台) */
function airportSurfaceAt(x, z) {
  if (Math.abs(x) < 1250 && z > -105 && z < 195) return true;
  const cx0 = Math.floor(x / AP_CELL), cz0 = Math.floor(z / AP_CELL);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const ap = airportOfCell(cx0 + dx, cz0 + dz);
    if (!ap) continue;
    const ox = x - ap.mx, oz = z - ap.mz;
    const c = Math.cos(-ap.hdg), s = Math.sin(-ap.hdg);
    const lx = ox * c - oz * s, lz = ox * s + oz * c;
    if (Math.abs(lx) < ap.run / 2 + 80 && Math.abs(lz) < ap.halfW + 70) return true;
  }
  return false;
}

export class Environment {
  constructor(scene, renderer) {
    this.scene = scene;
    this.groundLevel = 0;

    /* ---------- 大气与雾 (贴近地平线色 → 地形块边缘自然隐入) ---------- */
    scene.fog = new THREE.Fog(0xc6d8e6, 700, 14000);
    scene.background = new THREE.Color(0xc6d8e6);

    /* ---------- 天空穹顶 (跟随相机) ---------- */
    const sunDir = new THREE.Vector3(0.42, 0.55, -0.5).normalize();
    this.sunDir = sunDir;
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        sunDir: { value: sunDir },
        top: { value: new THREE.Color(0x2f69c7) },
        horizon: { value: new THREE.Color(0xcfe3f2) },
        glow: { value: new THREE.Color(0xffe9b8) },
      },
      vertexShader: `
        varying vec3 vDir;
        void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        varying vec3 vDir;
        uniform vec3 sunDir; uniform vec3 top; uniform vec3 horizon; uniform vec3 glow;
        void main(){
          float h = clamp(vDir.y, -1.0, 1.0);
          vec3 col = mix(horizon, top, pow(max(h, 0.0), 0.55));
          col = mix(col * 0.30, col, smoothstep(-0.06, 0.02, h));   // 地平线以下压暗
          float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
          col += glow * pow(s, 1200.0) * 2.4;                        // 太阳本体
          col += glow * pow(s, 90.0) * 0.18;                         // 日晕
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(16000, 32, 16), skyMat);
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    /* ---------- 灯光 ---------- */
    const hemi = new THREE.HemisphereLight(0xbdd7ff, 0x55603f, 0.8);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2dc, 2.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -170; sun.shadow.camera.right = 170;
    sun.shadow.camera.top = 170; sun.shadow.camera.bottom = -170;
    sun.shadow.camera.near = 60; sun.shadow.camera.far = 2600;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.06;   // 消除浅角日照下的阴影痤疮(条纹闪烁)
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    /* ---------- 无限地形 (chunk 管理) ---------- */
    const grass = this._makeGrassTexture();
    const aniso = renderer.capabilities.getMaxAnisotropy();
    grass.anisotropy = Math.min(aniso, 16);
    grass.wrapS = grass.wrapT = THREE.RepeatWrapping;
    grass.colorSpace = THREE.SRGBColorSpace;

    this._chunkMat = new THREE.MeshStandardMaterial({ map: grass, roughness: 1.0, flatShading: true });
    this.chunkGroup = new THREE.Group();
    scene.add(this.chunkGroup);
    this._chunks = new Map();    // key → mesh
    this._queue = [];            // 待生成块队列
    this._need = new Set();
    this._ccx = null; this._ccz = null;

    this.airportGroup = new THREE.Group();
    scene.add(this.airportGroup);
    this._apObjs = new Map();    // cellKey → group
    this._apNeed = new Set();
    this._apQueue = [];

    /* ---------- 跑道组 (主机场) ---------- */
    this.runwayGroup = new THREE.Group();
    scene.add(this.runwayGroup);
    this._buildRunway();
    this._buildAirport();
    this._buildObstacles();
    this._buildTrees();

    /* 初始地形 (同步全量构建, 启动遮罩期间完成) */
    this._syncChunks(0, 0);
    this._syncAirports(0, 0);
    this._drain(9999);
    this._drainAirports(9999);
  }

  /* ================= 地形高度 / 机场判定 API (物理与渲染共用) ================= */
  terrainHeight(x, z) { return worldHeight(x, z); }
  airportSurface(x, z) { return airportSurfaceAt(x, z); }

  /* 查询某点附近(3×3网格)的程序化机场信息, 无则 null */
  airportInfoAt(x, z) {
    const cx0 = Math.floor(x / AP_CELL), cz0 = Math.floor(z / AP_CELL);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const ap = airportOfCell(cx0 + dx, cz0 + dz);
      if (ap) return ap;
    }
    return null;
  }

  /* ================= 地形块 ================= */
  _buildChunkMesh(cx, cz) {
    const g = new THREE.PlaneGeometry(CHUNK, CHUNK, CHUNK_SEGS, CHUNK_SEGS);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position, uv = g.attributes.uv;
    const ox = cx * CHUNK, oz = cz * CHUNK;
    for (let i = 0; i < pos.count; i++) {
      // 顶点本地坐标 ±512m, 高度按本地+偏移换算出的世界坐标采样
      const x = pos.getX(i) + ox, z = pos.getZ(i) + oz;
      pos.setY(i, worldHeight(x, z));
      uv.setXY(i, x / 250, z / 250);       // 世界坐标 UV → 块间纹理连续
    }
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, this._chunkMat);
    /* 关键: 网格整体定位到世界坐标 (ox, 0, oz) —— 顶点保持本地坐标,
       否则所有块会全部堆叠在原点, 形成大面积穿插与过度绘制 */
    mesh.position.set(ox, 0, oz);
    mesh.receiveShadow = true;
    this.chunkGroup.add(mesh);
    return mesh;
  }

  /* 以 (ccx,ccz) 为中心重建块集合: 缺块入队, 圈外块销毁 */
  _syncChunks(ccx, ccz) {
    this._need.clear();
    for (let dz = -CHUNK_RADIUS; dz <= CHUNK_RADIUS; dz++) {
      for (let dx = -CHUNK_RADIUS; dx <= CHUNK_RADIUS; dx++) {
        this._need.add((ccx + dx) + ',' + (ccz + dz));
      }
    }
    for (const k of Array.from(this._chunks.keys())) {
      if (!this._need.has(k)) {
        const m = this._chunks.get(k);
        this.chunkGroup.remove(m);
        m.geometry.dispose();
        this._chunks.delete(k);
      }
    }
    for (const k of this._need) if (!this._chunks.has(k)) this._queue.push(k);
  }

  /* 每帧定额生成 (避免飞行中卡顿) */
  _drain(budget) {
    let n = 0;
    while (this._queue.length && n < budget) {
      const k = this._queue.shift();
      if (this._chunks.has(k) || !this._need.has(k)) continue;
      const p = k.split(',');
      this._chunks.set(k, this._buildChunkMesh(+p[0], +p[1]));
      n++;
    }
  }

  /* ================= 程序化机场视觉 ================= */
  _buildAirportVisual(ap) {
    // 共享材质/几何 (首次创建)
    if (!this._apTex) {
      this._apTex = this._makeProcRunwayTexture();
      this._apTex.colorSpace = THREE.SRGBColorSpace;
      this._apTex.anisotropy = 4;
      this._apMat = new THREE.MeshStandardMaterial({ map: this._apTex, roughness: 0.95 });
      this._apPlaneGeo = new THREE.PlaneGeometry(ap.run, ap.halfW * 2);
      const mk = (c, e) => {
        const m = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: c, emissiveIntensity: e });
        m.depthTest = false; m.depthWrite = false;
        return m;
      };
      this._apLWhite = mk(0xfff4d8, 1.2);
      this._apLGreen = mk(0x18ff7a, 2.0);
      this._apLRed = mk(0xff2e2e, 2.0);
      this._apLGeo = new THREE.BoxGeometry(1.1, 0.05, 1.1);
    }
    const grp = new THREE.Group();
    grp.position.set(ap.mx, ap.h0, ap.mz);
    grp.rotation.y = ap.hdg;

    const asphalt = new THREE.Mesh(this._apPlaneGeo, this._apMat);
    asphalt.rotation.x = -Math.PI / 2;
    asphalt.position.y = 0.04;
    asphalt.receiveShadow = true;
    grp.add(asphalt);

    // 边灯 / 入口灯 (不参与深度测试: 远距离稳定绘制)
    for (let lx = -ap.run / 2 + 40; lx < ap.run / 2; lx += 90) {
      for (const lz of [-ap.halfW - 1.5, ap.halfW + 1.5]) {
        const m = new THREE.Mesh(this._apLGeo, this._apLWhite);
        m.position.set(lx, 0.05, lz);
        m.renderOrder = 3;
        grp.add(m);
      }
    }
    for (const lz of [-13, 0, 13]) {
      const a = new THREE.Mesh(this._apLGeo, this._apLGreen);
      a.position.set(-ap.run / 2 + 8, 0.05, lz); a.renderOrder = 3; grp.add(a);
      const b = new THREE.Mesh(this._apLGeo, this._apLRed);
      b.position.set(ap.run / 2 - 8, 0.05, lz); b.renderOrder = 3; grp.add(b);
    }

    this.airportGroup.add(grp);
    return grp;
  }

  _makeProcRunwayTexture() {
    const W = 1024, H = 48;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#25272a';
    ctx.fillRect(0, 0, W, H);
    const white = 'rgba(245,248,250,0.95)';
    ctx.fillStyle = white;
    ctx.fillRect(0, H / 2 - 15, W, 1.6);   // 边线 (16m 半宽)
    ctx.fillRect(0, H / 2 + 15, W, 1.6);
    for (let x = 0; x < W; x += 46) {      // 中心虚线
      ctx.fillRect(x, H / 2 - 0.8, 26, 1.6);
    }
    for (const e of [8, W - 36]) {         // 入口斑马线
      for (let i = 0; i < 8; i++) {
        const z = -9.5 + i * 2.5;
        ctx.fillRect(e, H / 2 + z * (H / 32), 28, 1.5);
        ctx.fillRect(e, H / 2 + (2.4 + i * 2.5) * (H / 32), 28, 1.5);
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    return tex;
  }

  /* 以 (ccx,ccz) 为中心同步机场物件. 注意: 机场格网(4km)与地形块(1km)尺度不同,
   须先把块坐标换算为机场格坐标, 覆盖半径取视觉环 + 1 格 (保证跨块跑道完整) */
  _syncAirports(ccx, ccz) {
    this._apNeed.clear();
    const acx = Math.floor((ccx * CHUNK) / AP_CELL);
    const acz = Math.floor((ccz * CHUNK) / AP_CELL);
    const R = Math.ceil((CHUNK_RADIUS * CHUNK) / AP_CELL) + 1;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const ap = airportOfCell(acx + dx, acz + dz);
        if (ap) this._apNeed.add(ap.cell);
      }
    }
    for (const k of Array.from(this._apObjs.keys())) {
      if (!this._apNeed.has(k)) {
        const g = this._apObjs.get(k);
        this.airportGroup.remove(g);
        g.traverse((o) => { if (o.geometry && o.geometry !== this._apPlaneGeo) o.geometry.dispose(); });
        this._apObjs.delete(k);
      }
    }
    for (const k of this._apNeed) if (!this._apObjs.has(k)) this._apQueue.push(k);
  }

  _drainAirports(budget) {
    let n = 0;
    while (this._apQueue.length && n < budget) {
      const k = this._apQueue.shift();
      if (this._apObjs.has(k) || !this._apNeed.has(k)) continue;
      const p = k.split(',');
      const ap = airportOfCell(+p[0], +p[1]);
      if (!ap) continue;
      this._apObjs.set(k, this._buildAirportVisual(ap));
      n++;
    }
  }

  /* ================= 主跑道 ================= */
  _buildRunway() {
    const g = this.runwayGroup;

    // 沥青道面 + 标线 (合并为单张纹理, 单平面): 见 _makeRunwaySurface
    const surfTex = this._makeRunwaySurface();
    surfTex.colorSpace = THREE.SRGBColorSpace;
    const surfMat = new THREE.MeshStandardMaterial({ map: surfTex, roughness: 0.95 });
    const asphalt = new THREE.Mesh(new THREE.PlaneGeometry(RWY_HALF * 2, RWY_HALF_W * 2), surfMat);
    asphalt.rotation.x = -Math.PI / 2;
    asphalt.position.y = 0.0;
    asphalt.receiveShadow = true;
    g.add(asphalt);

    // 跑道中线灯 (不参与深度测试: 远距离下小体积始终稳定绘制在道面上方)
    const cLight = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfffbe8, emissiveIntensity: 1.5 });
    cLight.depthTest = false;
    cLight.depthWrite = false;
    const clGeo = new THREE.BoxGeometry(0.5, 0.03, 0.35);
    for (let x = -RWY_HALF + 50; x < RWY_HALF - 30; x += 60) {
      const m = new THREE.Mesh(clGeo, cLight);
      m.position.set(x, 0.03, 0);
      m.renderOrder = 3;
      g.add(m);
    }
    // 跑道边灯 (白) + 入口灯 (绿进入/红尽头)
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff4d8, emissiveIntensity: 1.2 });
    edgeMat.depthTest = false;
    edgeMat.depthWrite = false;
    const eg = new THREE.BoxGeometry(0.6, 0.03, 0.4);
    for (let x = -RWY_HALF + 30; x < RWY_HALF - 20; x += 60) {
      for (const z of [-RWY_HALF_W - 1.5, RWY_HALF_W + 1.5]) {
        const m = new THREE.Mesh(eg, edgeMat);
        m.position.set(x, 0.03, z);
        m.renderOrder = 3;
        g.add(m);
      }
    }
    const thrGreen = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x18ff7a, emissiveIntensity: 2.0 });
    const thrRed = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff2e2e, emissiveIntensity: 2.0 });
    thrGreen.depthTest = false; thrGreen.depthWrite = false;
    thrRed.depthTest = false; thrRed.depthWrite = false;
    const tg = new THREE.BoxGeometry(1.1, 0.05, 1.1);
    for (const z of [-20, -12, -4, 4, 12, 20]) {
      const a = new THREE.Mesh(tg, thrGreen); a.position.set(-1195, 0.04, z); a.renderOrder = 3; g.add(a);
      const b = new THREE.Mesh(tg, thrRed); b.position.set(1195, 0.04, z); b.renderOrder = 3; g.add(b);
    }

    /* ---------- PAPI (跑道 27, 西头: 向西进近) ---------- */
    this.papiLamps = [];
    const house = new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 0.7 });
    for (let i = 0; i < 4; i++) {
      const lamp = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 1.4, 6), house);
      // 底端埋入地面 1cm: 避免底盖与地面平面共面产生闪烁
      pole.position.y = 0.69;
      lamp.add(pole);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.42, 0.62), house);
      box.position.set(0, 1.55, 0);
      box.rotation.x = -0.12;
      lamp.add(box);
      const lens = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.3, 0.08),
        new THREE.MeshStandardMaterial({ color: 0x050505, emissive: 0xff4040, emissiveIntensity: 2.4 })
      );
      lens.position.set(0, 1.55, 0.327);
      lens.rotation.x = -0.12;
      lamp.add(lens);
      lamp.position.set(-890 - i * 9.5, 0, RWY_HALF_W + 9.5);
      g.add(lamp);
      this.papiLamps.push(lens.material);
    }
  }

  _makeRunwaySurface() {
    const W = 2048, H = 128;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    // 沥青底色 + 全部标线绘制在同一张纹理上 → 跑道仅是"一个平面", 内部不可能闪烁
    ctx.fillStyle = '#25272a';
    ctx.fillRect(0, 0, W, H);
    const sx = W / (RWY_HALF * 2);     // px per m (x)
    const sz = H / (RWY_HALF_W * 2);   // px per m (z)
    const Z0 = H / 2;

    const white = 'rgba(245,248,250,0.96)';
    // 边线
    ctx.fillStyle = white;
    for (const z of [-17, 17]) {
      ctx.fillRect(0, Z0 + z * sz - 1, W, 2.4);
    }
    // 中心虚线 30m 段 / 20m 间隔
    for (let x = -RWY_HALF + 8; x < RWY_HALF - 30; x += 50) {
      ctx.fillRect((x + RWY_HALF) * sx, Z0 - 1.6, 30 * sx, 3.2);
    }
    // 入口斑马线 (两端 8 条 × 30m 长)
    for (const end of [-1, 1]) {
      for (let i = 0; i < 8; i++) {
        const z = -9.5 + i * 2.4;      // 中心线两侧 4 条, 间距2.4m, 宽1.8m
        const x0 = end === -1 ? -RWY_HALF + 8 : RWY_HALF - 38;
        ctx.fillRect((x0 + RWY_HALF) * sx, Z0 + z * sz, 30 * sx, 1.8 * sz);
        const z2 = 2.3 + i * 2.4;
        ctx.fillRect((x0 + RWY_HALF) * sx, Z0 + z2 * sz, 30 * sx, 1.8 * sz);
      }
    }
    // 接地带标线 (每端 6 组, 间隔 150m, 每组 3 根)
    for (const end of [-1, 1]) {
      for (let k = 0; k < 6; k++) {
        const x0 = end === -1 ? -RWY_HALF + 158 + k * 180 : RWY_HALF - 190 - k * 180;
        for (const side of [-1, 1]) {
          for (let b = 0; b < 3; b++) {
            const z = side * (6.5 + b * 3.6);
            ctx.fillRect((x0 + RWY_HALF) * sx, Z0 + z * sz - 1.5, 26 * sx, 3.0 * sz * 0.55);
          }
        }
      }
    }
    // 瞄准点 (每端, 距入口 300m, 两条 30m×4m)
    for (const end of [-1, 1]) {
      const x0 = end === -1 ? -RWY_HALF + 285 : RWY_HALF - 315;
      for (const side of [-1, 1]) {
        const z = side * 8.5;
        ctx.fillRect((x0 + RWY_HALF) * sx, Z0 + z * sz - 2, 30 * sx, 4 * sz);
      }
    }
    // 跑道号
    ctx.font = 'bold 52px Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('27', (-RWY_HALF + 156 + RWY_HALF) * sx, Z0);
    ctx.fillText('09', (RWY_HALF - 156 + RWY_HALF) * sx, Z0);

    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    return tex;
  }

  _makeGrassTexture() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#56723f';
    ctx.fillRect(0, 0, 256, 256);
    // 低对比大颗粒噪点: 减少远处高频闪烁
    const cols = ['#4f6a3a', '#5b7843', '#506a38', '#5d7a46', '#496231'];
    for (let i = 0; i < 1500; i++) {
      ctx.fillStyle = cols[(Math.random() * cols.length) | 0];
      ctx.fillRect(Math.random() * 256, Math.random() * 256, 3.2, 3.2);
    }
    const tex = new THREE.CanvasTexture(cv);
    return tex;
  }

  /* ================= 机场建筑群 ================= */
  _buildAirport() {
    const g = this.runwayGroup;
    // 滑行道 + 停机坪: 合并为单个连续水泥面 (两者原范围有重叠, 分成两个同高平面会共面闪烁)
    const conc = new THREE.MeshStandardMaterial({ color: 0x8d9399, roughness: 0.9 });
    // 覆盖并集: x -140..850, z 33.5..160
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(990, 126.5), conc);
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(355, 0, 96.75);
    apron.receiveShadow = true;
    g.add(apron);

    // 机库 / 塔台不投影: 它们浅角大阴影落在停机坪上会产生阴影痤疮闪烁
    const hangarMat = new THREE.MeshStandardMaterial({ color: 0xb8bfc6, roughness: 0.6, metalness: 0.3 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x7a3f32, roughness: 0.8 });
    for (const hx of [620, 830]) {
      const hang = new THREE.Mesh(new THREE.BoxGeometry(64, 15, 44), hangarMat);
      hang.position.set(hx, 7.35, 120);      // 底端埋入停机坪 15cm: 避免底盖与该面共面
      hang.receiveShadow = true;
      g.add(hang);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(66, 3, 46), roofMat);
      roof.position.set(hx, 16.25, 120);
      g.add(roof);
    }
    // 塔台
    const towerMat = new THREE.MeshStandardMaterial({ color: 0xd5dade, roughness: 0.5 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4, 22, 12), towerMat);
    shaft.position.set(980, 10.85, 40);      // 底端埋入地面 15cm
    g.add(shaft);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(11, 7, 11), new THREE.MeshStandardMaterial({ color: 0x131c2c, roughness: 0.2, metalness: 0.6 }));
    cab.position.set(980, 24.5, 40);
    g.add(cab);
    this.towerBeacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.45, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff4030, emissiveIntensity: 3 })
    );
    this.towerBeacon.position.set(980, 32, 40);
    g.add(this.towerBeacon);
    // 风向袋 (杆底端埋入停机坪 5cm, 避免底盖共面)
    const sockPole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 7, 6), towerMat);
    sockPole.position.set(560, 3.45, 120);
    g.add(sockPole);
    const sock = new THREE.Mesh(new THREE.ConeGeometry(0.7, 2.6, 10), new THREE.MeshStandardMaterial({ color: 0xff9c2e, roughness: 0.8 }));
    sock.geometry.rotateZ(Math.PI / 2);
    sock.position.set(560 + 2.1, 6.6, 120);
    g.add(sock);
  }

  /* ================= 碰撞障碍物 (机场建筑 AABB, 含膨胀) ================= */
  /* 水平膨胀 8m 覆盖翼展/机身前伸, 垂直膨胀 2m; 与 _buildAirport 尺寸保持一致 */
  _buildObstacles() {
    const M = 8, YM = 2;
    this._obs = [];
    const add = (x0, x1, y0, y1, z0, z1) =>
      this._obs.push({ x0: x0 - M, x1: x1 + M, y0: y0 - YM, y1: y1 + YM, z0: z0 - M, z1: z1 + M });
    for (const hx of [620, 830]) add(hx - 33, hx + 33, -0.2, 17.8, 98, 142);  // 机库 ×2 (含屋顶)
    add(974.5, 985.5, -0.2, 28.5, 34.5, 45.5);                                // 塔台 (塔身+指挥室)
    add(558, 566, -0.2, 8, 118.5, 121.5);                                     // 风向袋杆
  }

  /* 机体中心是否与任一建筑相撞 (由 FlightModel 每子步调用) */
  obstacleHit(x, y, z) {
    for (const b of this._obs) {
      if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1 && z > b.z0 && z < b.z1) return true;
    }
    return false;
  }

  /* ================= 树木 (Instanced, 贴合地形) ================= */
  _buildTrees() {
    let seed = 1234567;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

    const N = 460;
    const trunkGeo = new THREE.CylinderGeometry(0.14, 0.24, 2.4, 5);
    trunkGeo.translate(0, 0.9, 0);      // 底端埋入地下 0.3m
    const canopyGeo = new THREE.ConeGeometry(1.7, 3.6, 7);
    canopyGeo.translate(0, 3.1, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5d4632, roughness: 0.9 });
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0x3e6231, roughness: 0.95 });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, N);
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, N);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();

    let placed = 0, guard = 0;
    while (placed < N && guard++ < N * 30) {
      const a = rnd() * Math.PI * 2;
      const r = 620 + rnd() * 7500;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (airportSurfaceAt(x, z)) continue;    // 不在机场铺装区种树
      if (worldHeight(x, z) > 190) continue;   // 山体雪线上不种
      const sc = 0.7 + rnd() * 1.15;
      v.set(x, worldHeight(x, z), z);          // 贴合地形
      s.set(sc, sc, sc);
      q.setFromEuler(new THREE.Euler(0, rnd() * Math.PI * 2, 0));
      m.compose(v, q, s);
      trunks.setMatrixAt(placed, m);
      canopies.setMatrixAt(placed, m);
      placed++;
    }
    trunks.count = canopies.count = placed;
    // 树木不投影: 保留投影只会带来阴影痤疮
    this.scene.add(trunks, canopies);
  }

  /* ================= 每帧更新 ================= */
  update(t, state, camPos) {
    // 天空 / 太阳灯跟随相机
    this.sky.position.copy(camPos);
    this.sun.position.copy(camPos).addScaledVector(this.sunDir, 800);
    this.sun.target.position.copy(camPos);

    // 塔台信标
    this.towerBeacon.material.emissiveIntensity = (Math.sin(t * 3.2) > 0.6) ? 3.5 : 0.1;

    // PAPI: 仅用于向西进近 27 号 (航向 200°~340°), 瞄准点 = 西头再向西 300m
    const aimX = -RWY_HALF - 300;
    const adv = state.pos.x - aimX;
    const headingOk = state.headingDeg > 200 && state.headingDeg < 340;
    const active = headingOk && adv > 60 && adv < 9000 && state.pos.y < 700;
    for (let i = 0; i < 4; i++) {
      const m = this.papiLamps[i];
      if (!active) { m.emissive.setHex(0x665544); m.emissiveIntensity = 0.12; continue; }
      const glide = Math.atan2(Math.max(state.pos.y, 1), adv) * 180 / Math.PI;
      const white = glide > 2.7 + i * 0.2;      // 3° 时 = 2 白 2 红
      m.emissive.setHex(white ? 0xffffff : 0xff2020);
      m.emissiveIntensity = white ? 2.6 : 2.6;
    }

    // 无限地形: 跨块时重建需求集, 每帧定额生成
    const ccx = Math.floor(state.pos.x / CHUNK), ccz = Math.floor(state.pos.z / CHUNK);
    if (ccx !== this._ccx || ccz !== this._ccz) {
      this._ccx = ccx; this._ccz = ccz;
      this._syncChunks(ccx, ccz);
      this._syncAirports(ccx, ccz);
    }
    this._drain(4);
    this._drainAirports(1);
  }
}