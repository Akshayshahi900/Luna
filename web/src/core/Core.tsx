// The reactor core: plasma orb, HUD rings, gyroscope rings, waveform,
// helper satellites and a particle field, all tinted by the current phase.
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { BINS, live } from "../lib/audio";
import { LOOKS, type Phase } from "../lib/theme";
import { look } from "./look";
import { createOrbit, drag, grab, release, step } from "./orbit";
import { orbFragment, orbVertex } from "./shaders";

const DEG = Math.PI / 180;
const WHITE = new THREE.Color("#ffffff");
const additive = {
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  toneMapped: false,
  side: THREE.DoubleSide,
} as const;

/** Eases the shared look toward the phase's colors and feeds audio in. */
function LookDriver({ phase }: { phase: Phase }) {
  const target = useMemo(() => ({ color: new THREE.Color(), deep: new THREE.Color() }), []);
  useFrame((_, dt) => {
    const want = LOOKS[phase];
    target.color.set(want.color);
    target.deep.set(want.deep);
    const k = 1 - Math.exp(-dt * 3);
    look.color.lerp(target.color, k);
    look.deep.lerp(target.deep, k);
    look.energy += (want.energy - look.energy) * k;
    // Audio is already smoothed by the analyser; only a light touch here so
    // the core stays in sync with the voice (≈ one frame of lag).
    const a = 1 - Math.exp(-dt * 40);
    look.level += (live.level - look.level) * a;
    look.low += (live.low - look.low) * a;
    look.mid += (live.mid - look.mid) * a;
    look.high += (live.high - look.high) * a;
    look.time += dt;
  });
  return null;
}

function Orb() {
  const mesh = useRef<THREE.Mesh>(null);
  const core = useRef<THREE.Mesh>(null);
  const shell = useRef<THREE.Mesh>(null);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uLevel: { value: 0 },
          uLow: { value: 0 },
          uHigh: { value: 0 },
          uEnergy: { value: 0 },
          uColor: { value: new THREE.Color() },
          uDeep: { value: new THREE.Color() },
        },
        vertexShader: orbVertex,
        fragmentShader: orbFragment,
        ...additive,
        side: THREE.FrontSide,
      }),
    [],
  );
  const coreMat = useMemo(() => new THREE.MeshBasicMaterial({ ...additive }), []);
  const shellMat = useMemo(
    () => new THREE.MeshBasicMaterial({ ...additive, wireframe: true, opacity: 0.12 }),
    [],
  );

  useFrame((_, dt) => {
    const u = material.uniforms;
    u.uTime.value += dt * (0.5 + look.energy * 1.8);
    u.uLevel.value = look.level;
    u.uLow.value = look.low;
    u.uHigh.value = look.high;
    u.uEnergy.value = look.energy;
    u.uColor.value.copy(look.color);
    u.uDeep.value.copy(look.deep);
    if (mesh.current) mesh.current.rotation.y += dt * (0.08 + look.energy * 0.3);
    if (core.current) {
      // The inner light beats with the voice's body.
      const pulse = 0.28 + Math.sin(look.time * (2 + look.energy * 4)) * 0.02 + look.level * 0.08 + look.low * 0.14;
      core.current.scale.setScalar(pulse);
      coreMat.color.copy(look.color).lerp(WHITE, 0.55).multiplyScalar(1.6);
    }
    if (shell.current) {
      shell.current.rotation.x += dt * 0.05;
      shell.current.rotation.y -= dt * (0.07 + look.energy * 0.25);
      shellMat.color.copy(look.color);
      shellMat.opacity = 0.08 + look.energy * 0.1;
    }
  });

  return (
    <group>
      <mesh ref={mesh} material={material}>
        <icosahedronGeometry args={[1, 48]} />
      </mesh>
      <mesh ref={core} material={coreMat}>
        <sphereGeometry args={[1, 32, 32]} />
      </mesh>
      <mesh ref={shell} material={shellMat} scale={1.32}>
        <icosahedronGeometry args={[1, 1]} />
      </mesh>
    </group>
  );
}

interface RingSpec {
  radius: number;
  width: number;
  /** [startDeg, lengthDeg] pieces */
  arcs: [number, number][];
  speed: number;
  /** x/y rotation (radians) to tilt the ring out of the screen plane */
  tilt?: [number, number];
  opacity: number;
  /** fades in with energy (e.g. the scanner sweep) */
  energetic?: boolean;
}

const dashes = (count: number, fill: number): [number, number][] =>
  Array.from({ length: count }, (_, i) => [(i * 360) / count, (360 / count) * fill]);

const RINGS: RingSpec[] = [
  { radius: 1.6, width: 0.022, arcs: [[0, 78], [92, 38], [146, 104], [262, 58], [332, 18]], speed: 0.22, opacity: 0.9 },
  { radius: 1.76, width: 0.006, arcs: [[0, 360]], speed: 0, opacity: 0.35 },
  { radius: 2.12, width: 0.04, arcs: dashes(3, 0.22), speed: -0.14, opacity: 0.7 },
  { radius: 2.12, width: 0.07, arcs: [[0, 24]], speed: 1.6, opacity: 0.9, energetic: true },
  { radius: 2.28, width: 0.005, arcs: dashes(48, 0.55), speed: 0.03, opacity: 0.35 },
  { radius: 2.42, width: 0.012, arcs: [[0, 300]], speed: 0.38, tilt: [1.15, 0.35], opacity: 0.55 },
  { radius: 2.56, width: 0.009, arcs: [[0, 200], [222, 98]], speed: -0.3, tilt: [-1.0, 0.8], opacity: 0.45 },
  { radius: 2.95, width: 0.004, arcs: dashes(120, 0.35), speed: -0.015, opacity: 0.28 },
];

function ArcRing({ spec }: { spec: RingSpec }) {
  const spin = useRef<THREE.Group>(null);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ ...additive }), []);
  const geometries = useMemo(
    () =>
      spec.arcs.map(
        ([start, len]) =>
          new THREE.RingGeometry(spec.radius - spec.width / 2, spec.radius + spec.width / 2, Math.max(8, Math.ceil(len / 2)), 1, start * DEG, len * DEG),
      ),
    [spec],
  );
  useFrame((_, dt) => {
    if (spin.current) spin.current.rotation.z += dt * spec.speed * (0.35 + look.energy * 2.4);
    material.color.copy(look.color);
    // Vowels (mid band) make the rings glow brighter.
    const voice = 1 + look.mid * 0.9 + look.level * 0.4;
    material.opacity = spec.energetic
      ? Math.max(0, look.energy - 0.25) * spec.opacity * 1.4
      : Math.min(1, spec.opacity * voice);
  });
  return (
    <group rotation={[spec.tilt?.[0] ?? 0, spec.tilt?.[1] ?? 0, 0]}>
      <group ref={spin}>
        {geometries.map((g, i) => (
          <mesh key={i} geometry={g} material={material} />
        ))}
      </group>
    </group>
  );
}

/** Measurement ticks around the core, every fifth one longer. */
function TickRing({ radius = 1.94, count = 180 }) {
  const spin = useRef<THREE.LineSegments>(null);
  const [geometry, material] = useMemo(() => {
    const pts: number[] = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const len = i % 15 === 0 ? 0.12 : i % 5 === 0 ? 0.07 : 0.035;
      pts.push(Math.cos(a) * radius, Math.sin(a) * radius, 0);
      pts.push(Math.cos(a) * (radius + len), Math.sin(a) * (radius + len), 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return [g, new THREE.LineBasicMaterial({ ...additive, opacity: 0.55 })];
  }, [radius, count]);
  useFrame((_, dt) => {
    if (spin.current) spin.current.rotation.z -= dt * 0.04 * (0.4 + look.energy * 2);
    material.color.copy(look.color);
  });
  return <lineSegments ref={spin} geometry={geometry} material={material} />;
}

/** Circular audio waveform hugging the orb. */
function Waveform({ radius = 1.42, points = 256 }) {
  const lines = useMemo(() => {
    return [0, 1].map((layer) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points * 3), 3));
      const m = new THREE.LineBasicMaterial({ ...additive, opacity: layer ? 0.35 : 0.95 });
      return new THREE.LineLoop(g, m);
    });
  }, [points]);
  useFrame(() => {
    const t = look.time;
    const speaking = live.level > 0.02;
    lines.forEach((line, layer) => {
      const pos = line.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < points; i++) {
        const u = i / points;
        const a = u * Math.PI * 2 + Math.PI / 2;
        // Mirror the spectrum so the ring is left/right symmetric.
        const m = u < 0.5 ? u * 2 : (1 - u) * 2;
        const bin = live.bins[Math.min(BINS - 1, Math.floor(m * BINS))] ?? 0;
        const breathe = Math.sin(a * 6 + t * 1.5) * 0.012 + Math.sin(a * 11 - t * 2.3) * 0.008;
        const r = radius + layer * 0.06 + breathe * (1 + look.energy * 2) + (speaking ? bin * 0.5 * (1 - layer * 0.4) : 0);
        pos.setXYZ(i, Math.cos(a) * r, Math.sin(a) * r, 0);
      }
      pos.needsUpdate = true;
      (line.material as THREE.LineBasicMaterial).color.copy(look.color);
    });
  });
  return (
    <>
      {lines.map((l, i) => (
        <primitive key={i} object={l} />
      ))}
    </>
  );
}

/** A ring that bursts outward on every syllable onset. */
function Shockwaves({ pool = 5, life = 0.8 }) {
  const items = useMemo(
    () =>
      Array.from({ length: pool }, () => ({
        mesh: new THREE.Mesh(
          new THREE.RingGeometry(0.985, 1, 128),
          new THREE.MeshBasicMaterial({ ...additive, opacity: 0 }),
        ),
        age: Infinity,
        strength: 0,
      })),
    [pool],
  );
  const seen = useRef(live.onsets);
  const next = useRef(0);
  useFrame((_, dt) => {
    if (live.onsets !== seen.current) {
      seen.current = live.onsets;
      const item = items[next.current++ % pool];
      item.age = 0;
      item.strength = Math.min(1, 0.4 + look.level);
    }
    for (const item of items) {
      item.age += dt;
      const t = item.age / life;
      const m = item.mesh.material as THREE.MeshBasicMaterial;
      if (t >= 1) {
        m.opacity = 0;
        continue;
      }
      const ease = 1 - (1 - t) ** 3;
      item.mesh.scale.setScalar(1.45 + ease * 1.5);
      m.color.copy(look.color);
      m.opacity = (1 - t) ** 2 * 0.75 * item.strength;
    }
  });
  return (
    <>
      {items.map((item, i) => (
        <primitive key={i} object={item.mesh} />
      ))}
    </>
  );
}

/** One glowing node per helper subagent at work, with a short ghost trail. */
function Satellites({ count }: { count: number }) {
  const group = useRef<THREE.Group>(null);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ ...additive }), []);
  const nodes = Math.min(count, 4);
  useFrame(() => {
    material.color.copy(look.color).multiplyScalar(2.2);
    const g = group.current;
    if (!g) return;
    g.children.forEach((child, idx) => {
      const sat = Math.floor(idx / 4);
      const ghost = idx % 4;
      const angle = look.time * 1.4 + sat * 2.1 - ghost * 0.09;
      const tilt = 0.6 + sat * 0.9;
      const r = 2.42;
      child.position.set(Math.cos(angle) * r, Math.sin(angle) * r * Math.cos(tilt), Math.sin(angle) * r * Math.sin(tilt));
      child.scale.setScalar(0.05 * (1 - ghost * 0.22));
    });
  });
  return (
    <group ref={group}>
      {Array.from({ length: nodes * 4 }, (_, i) => (
        <mesh key={i} material={material}>
          <sphereGeometry args={[1, 12, 12]} />
        </mesh>
      ))}
    </group>
  );
}

function dotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function Particles({ count = 1600 }) {
  const ref = useRef<THREE.Points>(null);
  const [geometry, material] = useMemo(() => {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 3 + Math.random() * 5;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      pos.set([r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi) - 2], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ ...additive, size: 0.05, map: dotTexture(), opacity: 0.6, sizeAttenuation: true });
    return [g, m];
  }, [count]);
  useFrame((_, dt) => {
    if (ref.current) {
      ref.current.rotation.y += dt * 0.025 * (1 + look.energy * 5 + look.level * 6);
      ref.current.rotation.x += dt * 0.006;
    }
    material.color.copy(look.color);
    material.opacity = 0.35 + look.energy * 0.35;
  });
  return <points ref={ref} geometry={geometry} material={material} />;
}

/** Fits the core to the screen, spins it slowly, tilts it gently toward the
 *  pointer, and lets you drag it round in 3D. */
function Rig({ children }: { children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  const { viewport, gl } = useThree();
  const orbit = useMemo(createOrbit, []);
  const tilt = useRef({ x: 0, y: 0, weight: 1 });
  const scale = 0.82 * Math.min(1, viewport.width / 6.4, viewport.height / 6.6);

  useEffect(() => {
    const el = gl.domElement;
    let last: { id: number; x: number; y: number } | null = null;
    el.style.cursor = "grab";
    el.style.touchAction = "none";
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || last) return;
      last = { id: e.pointerId, x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
      grab(orbit);
    };
    const move = (e: PointerEvent) => {
      if (!last || e.pointerId !== last.id) return;
      drag(orbit, e.clientX - last.x, e.clientY - last.y);
      last.x = e.clientX;
      last.y = e.clientY;
    };
    const up = (e: PointerEvent) => {
      if (!last || e.pointerId !== last.id) return;
      last = null;
      el.style.cursor = "grab";
      release(orbit);
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, [gl, orbit]);

  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    step(orbit, dt);
    const t = tilt.current;
    const k = 1 - Math.exp(-dt * 2);
    // The pointer tilt fades out while dragging so it doesn't fight the drag.
    t.weight += ((orbit.dragging ? 0 : 1) - t.weight) * (1 - Math.exp(-dt * 6));
    t.y += (live.pointer.x * 0.25 - t.y) * k;
    t.x += (-live.pointer.y * 0.18 - t.x) * k;
    g.rotation.x = orbit.x + t.x * t.weight;
    g.rotation.y = orbit.y + t.y * t.weight;
  });
  return (
    <group ref={ref} scale={scale} position={[0, viewport.height * 0.06, 0]}>
      {children}
    </group>
  );
}

export function Core({ phase, helpers }: { phase: Phase; helpers: number }) {
  return (
    <Canvas
      className="core-canvas"
      dpr={[1, 2]}
      camera={{ position: [0, 0, 7], fov: 45 }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
    >
      <LookDriver phase={phase} />
      <Particles />
      <Rig>
        <Orb />
        <Waveform />
        <Shockwaves />
        <TickRing />
        {RINGS.map((spec, i) => (
          <ArcRing key={i} spec={spec} />
        ))}
        <Satellites count={helpers} />
      </Rig>
      <EffectComposer multisampling={0}>
        <Bloom intensity={1.35} luminanceThreshold={0.05} luminanceSmoothing={0.35} mipmapBlur radius={0.75} />
        <Noise opacity={0.035} />
        <Vignette eskil={false} offset={0.25} darkness={0.75} />
      </EffectComposer>
    </Canvas>
  );
}
