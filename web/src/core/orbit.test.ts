import { describe, expect, it } from "vitest";
import { ORBIT, createOrbit, drag, grab, release, step } from "./orbit";

const run = (o: ReturnType<typeof createOrbit>, seconds: number, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) step(o, dt);
};

describe("orbit", () => {
  it("only rotates while held", () => {
    const o = createOrbit();
    drag(o, 100, 0);
    expect(o.y).toBe(0);
    grab(o);
    drag(o, 100, 50);
    expect(o.y).toBeCloseTo(100 * ORBIT.sensitivity);
    expect(o.x).toBeCloseTo(50 * ORBIT.sensitivity);
  });

  it("never tips past the pitch limit", () => {
    const o = createOrbit();
    grab(o);
    drag(o, 0, 100000);
    expect(o.x).toBe(ORBIT.maxPitch);
    drag(o, 0, -200000);
    expect(o.x).toBe(-ORBIT.maxPitch);
  });

  it("spins slowly on its own, but not while held", () => {
    const o = createOrbit();
    run(o, 2);
    expect(o.y).toBeCloseTo(2 * ORBIT.spin, 2);
    grab(o);
    const held = o.y;
    run(o, 2);
    expect(o.y).toBe(held);
  });

  it("coasts after a flick, then settles back to the slow spin", () => {
    const o = createOrbit();
    grab(o);
    for (let i = 0; i < 10; i++) {
      drag(o, 10, 0);
      step(o, 1 / 60);
    }
    release(o);
    expect(o.vy).toBeGreaterThan(ORBIT.spin);
    run(o, 0.2);
    const fast = o.y;
    run(o, 1 / 60);
    expect((o.y - fast) * 60).toBeGreaterThan(ORBIT.spin * 2);
    run(o, 1.5);
    expect(Math.abs(o.vy)).toBeLessThan(0.1);
  });

  it("keeps the tilt for a while, then levels out", () => {
    const o = createOrbit();
    grab(o);
    drag(o, 200, 80);
    release(o);
    run(o, ORBIT.returnAfter - 0.5);
    expect(o.x).toBeCloseTo(80 * ORBIT.sensitivity);
    run(o, 15);
    expect(o.x).toBe(0);
  });

  it("keeps the yaw angle bounded however long it spins", () => {
    const o = createOrbit();
    run(o, 600);
    expect(Math.abs(o.y)).toBeLessThan(2 * Math.PI);
  });
});
