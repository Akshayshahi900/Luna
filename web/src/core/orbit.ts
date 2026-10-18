// Drag-to-rotate for the core: yaw/pitch from pointer drags, a little
// inertia after release, a slow constant spin, and the tilt levelling out
// again when left alone.
// Pure math; <Rig/> feeds it pointer deltas and reads x/y every frame.

export const ORBIT = {
  /** radians per pixel dragged */
  sensitivity: 0.008,
  /** pitch limit, so the core never flips upside down */
  maxPitch: (80 * Math.PI) / 180,
  /** how fast the spin from a flick dies out (1/s) */
  friction: 3.5,
  /** constant yaw while nobody is dragging (rad/s): one turn ≈ 50 s */
  spin: 0.125,
  /** seconds without a drag before the tilt levels out */
  returnAfter: 4,
  /** easing rate of that levelling (1/s) */
  returnRate: 1.2,
};

const TURN = Math.PI * 2;

export interface Orbit {
  /** pitch (rotation about x), radians */
  x: number;
  /** yaw (rotation about y), radians; unbounded, so it can spin freely */
  y: number;
  /** angular velocity, radians/s */
  vx: number;
  vy: number;
  dragging: boolean;
  /** seconds since the last drag ended */
  idle: number;
  /** drag movement since the last step(), radians */
  pendingX: number;
  pendingY: number;
}

export function createOrbit(): Orbit {
  return { x: 0, y: 0, vx: 0, vy: 0, dragging: false, idle: Infinity, pendingX: 0, pendingY: 0 };
}

const clampPitch = (x: number) => Math.max(-ORBIT.maxPitch, Math.min(ORBIT.maxPitch, x));

export function grab(o: Orbit): void {
  o.dragging = true;
  o.vx = o.vy = 0;
  o.pendingX = o.pendingY = 0;
}

/** Pointer moved by (dx, dy) px while held: right spins right, down tips the top toward you. */
export function drag(o: Orbit, dx: number, dy: number): void {
  if (!o.dragging) return;
  const ry = dx * ORBIT.sensitivity;
  const rx = dy * ORBIT.sensitivity;
  o.y += ry;
  const x = clampPitch(o.x + rx);
  o.pendingX += x - o.x;
  o.pendingY += ry;
  o.x = x;
}

export function release(o: Orbit): void {
  if (!o.dragging) return;
  o.dragging = false;
  o.idle = 0;
}

/** Advance one frame: measure flick speed while held; spin, coast and level out after. */
export function step(o: Orbit, dt: number): void {
  if (dt <= 0) return;
  if (o.dragging) {
    // Smoothed so the release speed is the recent motion, not one jittery frame.
    const k = 1 - Math.exp(-dt * 20);
    o.vx += (o.pendingX / dt - o.vx) * k;
    o.vy += (o.pendingY / dt - o.vy) * k;
    o.pendingX = o.pendingY = 0;
    return;
  }
  o.idle += dt;
  // The flick coasts on top of the constant spin and fades into it.
  o.y = (o.y + (ORBIT.spin + o.vy) * dt) % TURN;
  const x = clampPitch(o.x + o.vx * dt);
  if (x !== o.x + o.vx * dt) o.vx = 0;
  o.x = x;
  const decay = Math.exp(-dt * ORBIT.friction);
  o.vx *= decay;
  o.vy *= decay;

  if (o.idle > ORBIT.returnAfter) {
    const k = 1 - Math.exp(-dt * ORBIT.returnRate);
    o.x += (0 - o.x) * k;
    if (Math.abs(o.x) < 1e-4) o.x = 0;
  }
}
