/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { useEffect, useRef, useState, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGameStore } from '../store/gameStore';
import { WORLD_SIZE, TURN_SPEED, BOOST_SPEED, BASE_SPEED, SEGMENT_SPACING } from '../shared/types';
import * as THREE from 'three';
import { Sphere, Grid } from '@react-three/drei';

interface SnakeData {
  id: string;
  name: string;
  color: string;
  segments: { x: number; y: number }[];
  score: number;
  currentAngle: number;
  targetAngle: number;
  isBoosting: boolean;
  state: 'alive' | 'dead';
  respawnTimer: number;
  turnDecisionTimer: number;
  isBot: boolean;
}

interface OrbData {
  x: number;
  y: number;
  value: number;
  color: string;
  dirty: boolean;
}

const TOTAL_ORBS = 200;
const MAX_SNAKE_SEGMENTS = 350;

const ORB_COLORS = [
  '#ff007f', // hot pink
  '#00f0ff', // cyan
  '#39ff14', // neon green
  '#ffe600', // yellow
  '#ff6600', // orange
  '#b026ff', // purple
  '#00ffff', // aqua
  '#ff3366', // coral
];

const BOT_CONFIGS = [
  { id: 'bot-1', name: '极光幻影', color: '#ff007f' },
  { id: 'bot-2', name: '赛博烈焰', color: '#ff5500' },
  { id: 'bot-3', name: '量子迅雷', color: '#ffe600' },
  { id: 'bot-4', name: '暗夜毒牙', color: '#a855f7' },
  { id: 'bot-5', name: '霓虹猎手', color: '#06b6d4' },
  { id: 'bot-6', name: '虚空吞噬', color: '#ec4899' },
  { id: 'bot-7', name: '机械狂暴', color: '#10b981' },
  { id: 'bot-8', name: '星际流星', color: '#3b82f6' },
  { id: 'bot-9', name: '幽灵游侠', color: '#84cc16' },
];

function createSegments(startX: number, startY: number, angle: number, length: number) {
  const segments: { x: number; y: number }[] = [];
  for (let i = 0; i < length; i++) {
    segments.push({
      x: startX - Math.cos(angle) * i * SEGMENT_SPACING,
      y: startY - Math.sin(angle) * i * SEGMENT_SPACING,
    });
  }
  return segments;
}

function SnakeRenderer({
  snakeId,
  color,
  getSnake,
}: {
  snakeId: string;
  color: string;
  getSnake: (id: string) => SnakeData | undefined;
}) {
  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const headRef = useRef<THREE.Mesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame(() => {
    if (!bodyRef.current || !headRef.current) return;
    const s = getSnake(snakeId);
    if (!s || s.state !== 'alive' || s.segments.length === 0) {
      bodyRef.current.count = 0;
      headRef.current.visible = false;
      return;
    }

    headRef.current.visible = true;
    const count = s.segments.length;
    const bodyCount = Math.min(count - 1, MAX_SNAKE_SEGMENTS);
    bodyRef.current.count = Math.max(0, bodyCount);

    headRef.current.position.set(s.segments[0].x, s.segments[0].y, 0.5);

    for (let i = 1; i <= bodyCount; i++) {
      dummy.position.set(s.segments[i].x, s.segments[i].y, 0.5);
      dummy.updateMatrix();
      bodyRef.current.setMatrixAt(i - 1, dummy.matrix);
    }
    bodyRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <Sphere ref={headRef} args={[0.8, 12, 12]}>
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={1.8}
          roughness={0.2}
          metalness={0.8}
          toneMapped={false}
        />
      </Sphere>
      <instancedMesh
        ref={bodyRef}
        args={[null as any, null as any, MAX_SNAKE_SEGMENTS]}
        frustumCulled={false}
      >
        <sphereGeometry args={[0.6, 10, 10]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={1.2}
          roughness={0.2}
          metalness={0.8}
          toneMapped={false}
        />
      </instancedMesh>
    </group>
  );
}

function MouseReticle({
  positionRef,
  isVisible,
}: {
  positionRef: React.MutableRefObject<THREE.Vector3>;
  isVisible: boolean;
}) {
  const meshRef = useRef<THREE.Group>(null);

  useFrame((state) => {
    if (!meshRef.current || !isVisible) return;
    meshRef.current.position.set(positionRef.current.x, positionRef.current.y, 0.05);
    const scale = 1 + Math.sin(state.clock.elapsedTime * 6) * 0.12;
    meshRef.current.scale.set(scale, scale, 1);
  });

  if (!isVisible) return null;

  return (
    <group ref={meshRef}>
      <mesh>
        <ringGeometry args={[0.6, 0.75, 24]} />
        <meshBasicMaterial color="#00f5d4" transparent opacity={0.4} side={THREE.DoubleSide} />
      </mesh>
      <mesh>
        <circleGeometry args={[0.18, 12]} />
        <meshBasicMaterial color="#00f5d4" transparent opacity={0.6} />
      </mesh>
    </group>
  );
}

export function GameScene() {
  const { setPlayerDead, updateLeaderboard, restartCount } = useGameStore();
  const { camera } = useThree();
  const inputs = useRef({ boost: false });
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const [lightTarget] = useState(() => new THREE.Object3D());

  const mouseNdc = useRef({ x: 0, y: 0, hasMoved: false });
  const mouseNdcVec = useMemo(() => new THREE.Vector2(), []);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const groundPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), []);
  const mouseWorldPos = useRef(new THREE.Vector3(0, 0, 0));

  // Static orbs pool
  const orbsRef = useRef<OrbData[]>([]);
  const orbMeshRef = useRef<THREE.InstancedMesh>(null);
  const orbDummy = useMemo(() => new THREE.Object3D(), []);
  const orbColorObj = useMemo(() => new THREE.Color(), []);
  const orbsInitialized = useRef(false);

  // Reusable drop pool to avoid array allocation during orb drop
  const dropOrb = (x: number, y: number, color?: string) => {
    const orbs = orbsRef.current;
    // Overwrite the oldest or a random orb to maintain constant array size
    const idx = Math.floor(Math.random() * orbs.length);
    if (orbs[idx]) {
      orbs[idx].x = x;
      orbs[idx].y = y;
      orbs[idx].color = color ?? ORB_COLORS[Math.floor(Math.random() * ORB_COLORS.length)];
      orbs[idx].dirty = true;
    }
  };

  // Snakes Map & Cached List
  const snakesRef = useRef<Record<string, SnakeData>>({});
  const snakeListRef = useRef<SnakeData[]>([]);

  // Initialize game entities once
  const initGame = () => {
    // 1. Static Orbs Pool
    const boundary = WORLD_SIZE / 2 - 5;
    const initialOrbs: OrbData[] = [];
    for (let i = 0; i < TOTAL_ORBS; i++) {
      initialOrbs.push({
        x: (Math.random() - 0.5) * 2 * boundary,
        y: (Math.random() - 0.5) * 2 * boundary,
        value: 1,
        color: ORB_COLORS[Math.floor(Math.random() * ORB_COLORS.length)],
        dirty: true,
      });
    }
    orbsRef.current = initialOrbs;
    orbsInitialized.current = false;

    // 2. Player "我"
    const playerAngle = Math.random() * Math.PI * 2;
    const playerSnake: SnakeData = {
      id: 'player',
      name: '我',
      color: '#00f5d4',
      segments: createSegments(0, 0, playerAngle, 12),
      score: 12,
      currentAngle: playerAngle,
      targetAngle: playerAngle,
      isBoosting: false,
      state: 'alive',
      respawnTimer: 0,
      turnDecisionTimer: 0,
      isBot: false,
    };
    snakesRef.current['player'] = playerSnake;

    // 3. 9 Virtual Opponents
    const bots: SnakeData[] = [];
    BOT_CONFIGS.forEach((bot) => {
      const startX = (Math.random() - 0.5) * (WORLD_SIZE - 40);
      const startY = (Math.random() - 0.5) * (WORLD_SIZE - 40);
      const angle = Math.random() * Math.PI * 2;
      const initialScore = 14 + Math.floor(Math.random() * 16);

      const botSnake: SnakeData = {
        id: bot.id,
        name: bot.name,
        color: bot.color,
        segments: createSegments(startX, startY, angle, initialScore),
        score: initialScore,
        currentAngle: angle,
        targetAngle: angle,
        isBoosting: false,
        state: 'alive',
        respawnTimer: 0,
        turnDecisionTimer: Math.random() * 0.3,
        isBot: true,
      };
      snakesRef.current[bot.id] = botSnake;
      bots.push(botSnake);
    });

    snakeListRef.current = [playerSnake, ...bots];
  };

  // Re-spawn or restart player
  useEffect(() => {
    if (snakesRef.current['player']) {
      const angle = Math.random() * Math.PI * 2;
      const startX = (Math.random() - 0.5) * 40;
      const startY = (Math.random() - 0.5) * 40;
      const player = snakesRef.current['player'];
      player.segments = createSegments(startX, startY, angle, 12);
      player.score = 12;
      player.currentAngle = angle;
      player.targetAngle = angle;
      player.isBoosting = false;
      player.state = 'alive';
      inputs.current.boost = false;
    } else {
      initGame();
    }
  }, [restartCount]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      mouseNdc.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouseNdc.current.y = -(e.clientY / window.innerHeight) * 2 + 1;
      mouseNdc.current.hasMoved = true;
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 0) {
        const target = e.target as HTMLElement | null;
        if (target && (target.closest('button') || target.closest('input') || target.closest('a'))) {
          return;
        }
        inputs.current.boost = true;
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 0) {
        inputs.current.boost = false;
      }
    };

    const handleTouch = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        const touch = e.touches[0];
        const target = touch.target as HTMLElement | null;
        if (target && (target.closest('button') || target.closest('input') || target.closest('a'))) {
          return;
        }
        mouseNdc.current.x = (touch.clientX / window.innerWidth) * 2 - 1;
        mouseNdc.current.y = -(touch.clientY / window.innerHeight) * 2 + 1;
        mouseNdc.current.hasMoved = true;
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp') {
        inputs.current.boost = true;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp') {
        inputs.current.boost = false;
      }
    };

    const handleBlur = () => {
      inputs.current.boost = false;
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('mousedown', handleMouseDown, { passive: true });
    window.addEventListener('mouseup', handleMouseUp, { passive: true });
    window.addEventListener('touchstart', handleTouch, { passive: true });
    window.addEventListener('touchmove', handleTouch, { passive: true });
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('touchstart', handleTouch);
      window.removeEventListener('touchmove', handleTouch);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  const lastLeaderboardUpdate = useRef(0);

  useFrame((state, delta) => {
    // Clamp delta to prevent huge jumps when tab was inactive
    const clampedDelta = Math.min(delta, 0.05);
    const player = snakesRef.current['player'];
    const boundary = WORLD_SIZE / 2;
    const snakeList = snakeListRef.current;

    // ----------------------------------------------------
    // 1. UPDATE PLAYER
    // ----------------------------------------------------
    if (player && player.state === 'alive' && player.segments.length > 0) {
      if (mouseNdc.current.hasMoved) {
        mouseNdcVec.set(mouseNdc.current.x, mouseNdc.current.y);
        raycaster.setFromCamera(mouseNdcVec, camera);
        const hit = raycaster.ray.intersectPlane(groundPlane, mouseWorldPos.current);
        if (hit) {
          const head = player.segments[0];
          const dx = mouseWorldPos.current.x - head.x;
          const dy = mouseWorldPos.current.y - head.y;
          const distSq = dx * dx + dy * dy;

          if (distSq > 0.3) {
            const targetAngle = Math.atan2(dy, dx);
            let diff = targetAngle - player.currentAngle;
            diff = Math.atan2(Math.sin(diff), Math.cos(diff));

            const maxTurn = TURN_SPEED * 1.3 * clampedDelta;
            if (Math.abs(diff) <= maxTurn) {
              player.currentAngle = targetAngle;
            } else {
              player.currentAngle += Math.sign(diff) * maxTurn;
            }
          }
        }
      }

      player.isBoosting = inputs.current.boost && player.score > 10;
      const speed = player.isBoosting ? BOOST_SPEED : BASE_SPEED;

      const pHead = { ...player.segments[0] };
      pHead.x += Math.cos(player.currentAngle) * speed * clampedDelta;
      pHead.y += Math.sin(player.currentAngle) * speed * clampedDelta;

      // Clamp boundary
      pHead.x = Math.max(-boundary, Math.min(boundary, pHead.x));
      pHead.y = Math.max(-boundary, Math.min(boundary, pHead.y));

      player.segments.unshift(pHead);

      if (player.isBoosting) {
        player.score -= 2 * clampedDelta;
        if (Math.random() < 0.12 && player.segments.length > 0) {
          const tail = player.segments[player.segments.length - 1];
          dropOrb(tail.x, tail.y, player.color);
        }
        if (player.score <= 10) {
          player.isBoosting = false;
          player.score = 10;
        }
      }

      const targetLen = Math.floor(player.score);
      while (player.segments.length > targetLen) {
        player.segments.pop();
      }

      // Check player collision with all bots
      let playerDied = false;
      for (let bIdx = 0; bIdx < BOT_CONFIGS.length; bIdx++) {
        const bot = snakesRef.current[BOT_CONFIGS[bIdx].id];
        if (!bot || bot.state !== 'alive' || bot.segments.length === 0) continue;

        // Bounding check between heads first
        const bHead = bot.segments[0];
        const distToBotSq = (pHead.x - bHead.x) * (pHead.x - bHead.x) + (pHead.y - bHead.y) * (pHead.y - bHead.y);
        // If bot is farther than its maximum body radius, skip
        if (distToBotSq > (bot.segments.length * 0.6 + 5) ** 2) continue;

        for (let s = 0; s < bot.segments.length; s++) {
          const seg = bot.segments[s];
          const dx = pHead.x - seg.x;
          const dy = pHead.y - seg.y;
          if (dx * dx + dy * dy < 2.0) {
            playerDied = true;
            break;
          }
        }
        if (playerDied) break;
      }

      if (playerDied) {
        player.state = 'dead';
        for (let i = 0; i < player.segments.length; i += 2) {
          const seg = player.segments[i];
          dropOrb(seg.x, seg.y, player.color);
        }
        player.segments = [];
        setPlayerDead(player.score);
      } else {
        // Camera smooth follow
        const targetZ = Math.min(45, Math.max(22, 20 + player.score * 0.18));
        camera.position.x += (pHead.x - camera.position.x) * 10 * clampedDelta;
        camera.position.y += (pHead.y - camera.position.y) * 10 * clampedDelta;
        camera.position.z += (targetZ - camera.position.z) * 4 * clampedDelta;
        camera.lookAt(camera.position.x, camera.position.y, 0);

        if (lightRef.current) {
          lightRef.current.position.set(camera.position.x + 10, camera.position.y - 10, 30);
          lightTarget.position.set(camera.position.x, camera.position.y, 0);
        }
      }
    }

    // ----------------------------------------------------
    // 2. UPDATE 9 VIRTUAL OPPONENTS (BOTS)
    // ----------------------------------------------------
    for (let b = 0; b < BOT_CONFIGS.length; b++) {
      const bot = snakesRef.current[BOT_CONFIGS[b].id];
      if (!bot) continue;

      if (bot.state === 'dead') {
        bot.respawnTimer -= clampedDelta;
        if (bot.respawnTimer <= 0) {
          const startX = (Math.random() - 0.5) * (WORLD_SIZE - 40);
          const startY = (Math.random() - 0.5) * (WORLD_SIZE - 40);
          const angle = Math.random() * Math.PI * 2;
          const initialScore = 14 + Math.floor(Math.random() * 15);
          bot.segments = createSegments(startX, startY, angle, initialScore);
          bot.score = initialScore;
          bot.currentAngle = angle;
          bot.targetAngle = angle;
          bot.state = 'alive';
          bot.isBoosting = false;
        }
        continue;
      }

      if (bot.segments.length === 0) continue;
      const bHead = bot.segments[0];

      // A. Boundary steering (high priority)
      const margin = 12;
      let urgentAvoidance = false;
      if (
        bHead.x > boundary - margin ||
        bHead.x < -boundary + margin ||
        bHead.y > boundary - margin ||
        bHead.y < -boundary + margin
      ) {
        bot.targetAngle = Math.atan2(-bHead.y, -bHead.x);
        urgentAvoidance = true;
      }

      // B. Obstacle avoidance (distance gated)
      if (!urgentAvoidance) {
        const lookX = bHead.x + Math.cos(bot.currentAngle) * 8;
        const lookY = bHead.y + Math.sin(bot.currentAngle) * 8;

        for (let sIdx = 0; sIdx < snakeList.length; sIdx++) {
          const other = snakeList[sIdx];
          if (!other || other.state !== 'alive' || other.id === bot.id || other.segments.length === 0) continue;

          // Quick distance check between heads
          const oHead = other.segments[0];
          const distSq = (bHead.x - oHead.x) * (bHead.x - oHead.x) + (bHead.y - oHead.y) * (bHead.y - oHead.y);
          if (distSq > 900) continue; // farther than 30 units, ignore

          // Check every 2nd segment to save 50% CPU
          for (let segI = 0; segI < other.segments.length; segI += 2) {
            const seg = other.segments[segI];
            const dx = lookX - seg.x;
            const dy = lookY - seg.y;
            if (dx * dx + dy * dy < 16) {
              bot.targetAngle = Math.atan2(bHead.y - seg.y, bHead.x - seg.x);
              urgentAvoidance = true;
              bot.isBoosting = false;
              break;
            }
          }
          if (urgentAvoidance) break;
        }
      }

      // C. Normal hunting behavior
      if (!urgentAvoidance) {
        bot.turnDecisionTimer -= clampedDelta;
        if (bot.turnDecisionTimer <= 0) {
          bot.turnDecisionTimer = 0.25 + Math.random() * 0.25;

          let closestDist = 35 * 35;
          let bestOrb: OrbData | null = null;
          const orbs = orbsRef.current;
          // Sample every 4th orb to save CPU
          for (let oIdx = 0; oIdx < orbs.length; oIdx += 4) {
            const o = orbs[oIdx];
            const dx = o.x - bHead.x;
            const dy = o.y - bHead.y;
            const dist = dx * dx + dy * dy;
            if (dist < closestDist) {
              closestDist = dist;
              bestOrb = o;
            }
          }

          if (bestOrb) {
            bot.targetAngle = Math.atan2(bestOrb.y - bHead.y, bestOrb.x - bHead.x);
            bot.isBoosting = bot.score > 25 && closestDist < 100 && Math.random() < 0.2;
          } else {
            bot.targetAngle += (Math.random() - 0.5) * 0.6;
            bot.isBoosting = false;
          }
        }
      }

      // Smooth turn
      let diff = bot.targetAngle - bot.currentAngle;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const maxTurn = TURN_SPEED * 1.1 * clampedDelta;
      if (Math.abs(diff) <= maxTurn) {
        bot.currentAngle = bot.targetAngle;
      } else {
        bot.currentAngle += Math.sign(diff) * maxTurn;
      }

      const botSpeed = bot.isBoosting ? BOOST_SPEED : BASE_SPEED;
      const nextHead = {
        x: bHead.x + Math.cos(bot.currentAngle) * botSpeed * clampedDelta,
        y: bHead.y + Math.sin(bot.currentAngle) * botSpeed * clampedDelta,
      };

      nextHead.x = Math.max(-boundary, Math.min(boundary, nextHead.x));
      nextHead.y = Math.max(-boundary, Math.min(boundary, nextHead.y));

      bot.segments.unshift(nextHead);

      if (bot.isBoosting) {
        bot.score -= 2 * clampedDelta;
        if (Math.random() < 0.1 && bot.segments.length > 0) {
          const tail = bot.segments[bot.segments.length - 1];
          dropOrb(tail.x, tail.y, bot.color);
        }
        if (bot.score <= 10) {
          bot.isBoosting = false;
          bot.score = 10;
        }
      }

      const bTargetLen = Math.floor(bot.score);
      while (bot.segments.length > bTargetLen) {
        bot.segments.pop();
      }

      // D. Collision Check: Did this bot hit another snake's body?
      let botDied = false;
      for (let sIdx = 0; sIdx < snakeList.length; sIdx++) {
        const other = snakeList[sIdx];
        if (!other || other.state !== 'alive' || other.id === bot.id || other.segments.length === 0) continue;

        // Bounding check between heads
        const oHead = other.segments[0];
        const distToOtherSq = (nextHead.x - oHead.x) * (nextHead.x - oHead.x) + (nextHead.y - oHead.y) * (nextHead.y - oHead.y);
        if (distToOtherSq > (other.segments.length * 0.6 + 5) ** 2) continue;

        for (let segI = 0; segI < other.segments.length; segI++) {
          const seg = other.segments[segI];
          const dx = nextHead.x - seg.x;
          const dy = nextHead.y - seg.y;
          if (dx * dx + dy * dy < 2.0) {
            botDied = true;
            break;
          }
        }
        if (botDied) break;
      }

      if (botDied) {
        bot.state = 'dead';
        bot.respawnTimer = 2.0 + Math.random() * 2.0;
        for (let i = 0; i < bot.segments.length; i += 2) {
          const seg = bot.segments[i];
          dropOrb(seg.x, seg.y, bot.color);
        }
        bot.segments = [];
      }
    }

    // ----------------------------------------------------
    // 3. EFFICIENT ORBS EATING & IN-PLACE INSTANCE UPDATE
    // ----------------------------------------------------
    const orbs = orbsRef.current;
    const orbMesh = orbMeshRef.current;
    let needsOrbBufferUpdate = !orbsInitialized.current;

    // Check collision with alive snakes
    for (let sIdx = 0; sIdx < snakeList.length; sIdx++) {
      const s = snakeList[sIdx];
      if (s.state !== 'alive' || s.segments.length === 0) continue;
      const head = s.segments[0];

      for (let i = 0; i < orbs.length; i++) {
        const o = orbs[i];
        const dx = head.x - o.x;
        const dy = head.y - o.y;
        if (dx * dx + dy * dy < 3.8) {
          s.score += o.value;
          // In-place respawn: avoids array allocations
          const b = boundary - 5;
          o.x = (Math.random() - 0.5) * 2 * b;
          o.y = (Math.random() - 0.5) * 2 * b;
          o.color = ORB_COLORS[Math.floor(Math.random() * ORB_COLORS.length)];
          o.dirty = true;
          needsOrbBufferUpdate = true;
        }
      }
    }

    // Update only dirty orb matrices and colors on the GPU
    if (orbMesh && (needsOrbBufferUpdate || !orbsInitialized.current)) {
      const isInitial = !orbsInitialized.current;
      for (let i = 0; i < orbs.length; i++) {
        const o = orbs[i];
        if (isInitial || o.dirty) {
          orbDummy.position.set(o.x, o.y, 0.5);
          orbDummy.updateMatrix();
          orbMesh.setMatrixAt(i, orbDummy.matrix);
          orbColorObj.set(o.color);
          orbMesh.setColorAt(i, orbColorObj);
          o.dirty = false;
        }
      }
      orbMesh.count = orbs.length;
      orbMesh.instanceMatrix.needsUpdate = true;
      if (orbMesh.instanceColor) {
        orbMesh.instanceColor.needsUpdate = true;
      }
      orbsInitialized.current = true;
    }

    // ----------------------------------------------------
    // 4. LEADERBOARD REFRESH (5Hz, Zero Garbage)
    // ----------------------------------------------------
    const now = state.clock.elapsedTime;
    if (now - lastLeaderboardUpdate.current > 0.2) {
      lastLeaderboardUpdate.current = now;
      const list = snakeList
        .filter((s) => s.state === 'alive')
        .map((s) => ({
          id: s.id,
          name: s.name,
          score: Math.floor(s.score),
          color: s.color,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

      updateLeaderboard(list, player ? player.score : 0);
    }
  });

  const getSnake = (id: string) => snakesRef.current[id];

  return (
    <>
      <ambientLight intensity={0.6} />

      <directionalLight
        ref={lightRef}
        target={lightTarget}
        intensity={1.5}
      />
      <primitive object={lightTarget} />

      {/* Ground plane */}
      <mesh position={[0, 0, -0.2]}>
        <planeGeometry args={[WORLD_SIZE, WORLD_SIZE]} />
        <meshStandardMaterial color="#080808" roughness={0.9} metalness={0.1} />
      </mesh>

      <Grid
        position={[0, 0, -0.1]}
        rotation={[Math.PI / 2, 0, 0]}
        args={[WORLD_SIZE, WORLD_SIZE]}
        cellSize={1}
        cellThickness={0.4}
        cellColor="#1e3a8a"
        sectionSize={10}
        sectionThickness={0.8}
        sectionColor="#3b82f6"
        fadeDistance={90}
        fadeStrength={1}
      />

      {/* Orbs */}
      <instancedMesh
        ref={orbMeshRef}
        args={[null as any, null as any, TOTAL_ORBS]}
        frustumCulled={false}
      >
        <sphereGeometry args={[0.45, 8, 8]} />
        <meshStandardMaterial
          roughness={0.4}
          metalness={0.1}
          toneMapped={false}
          emissiveIntensity={2.0}
        />
      </instancedMesh>

      {/* Mouse Aim Reticle */}
      <MouseReticle
        positionRef={mouseWorldPos}
        isVisible={Boolean(snakesRef.current['player']?.state === 'alive')}
      />

      {/* Player Snake */}
      <SnakeRenderer
        key="player"
        snakeId="player"
        color="#00f5d4"
        getSnake={getSnake}
      />

      {/* 9 Virtual Opponents */}
      {BOT_CONFIGS.map((bot) => (
        <SnakeRenderer
          key={bot.id}
          snakeId={bot.id}
          color={bot.color}
          getSnake={getSnake}
        />
      ))}
    </>
  );
}
