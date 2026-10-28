import { Color, Mesh, Vector3, type BufferGeometry, type Scene, type ShaderMaterial } from 'three';
import { createRockGeometry, setGeometryColor } from '../gfx/props';
import { createLitMaterial } from '../gfx/materials';
import { mulberry32 } from '../util/math';

export interface StoneHost {
  waterHeight(x: number, z: number): number;
  terrainHeight(x: number, z: number): number;
  onSkip(p: Vector3, v: Vector3, index: number): void;
  onPlunge(p: Vector3, v: Vector3): void;
  /** Called now and then while a stone sinks, to trail bubbles. */
  onSink(p: Vector3): void;
  onLand(p: Vector3, v: Vector3): void;
}

type State = 'fly' | 'sink' | 'rest' | 'dead';

interface Stone {
  mesh: Mesh;
  pos: Vector3;
  vel: Vector3;
  spin: number;
  tumble: Vector3;
  state: State;
  age: number;
  skips: number;
}

const MAX_STONES = 10;
const GRAVITY = 9.81;
/** Skipping works below roughly 20° of incidence (Clanet et al. measured ~20° as the sweet spot). */
const SKIP_ANGLE = (22 * Math.PI) / 180;

/** Thrown stones: ballistic flight, skipping on shallow fast contact, sinking otherwise. */
export class Stones {
  private stones: Stone[] = [];
  private geos: BufferGeometry[];
  private material: ShaderMaterial;
  private rnd = mulberry32(5);
  private scene: Scene;
  private host: StoneHost;
  private tmp = new Vector3();

  constructor(scene: Scene, host: StoneHost) {
    this.scene = scene;
    this.host = host;
    const tints = [new Color(0.17, 0.165, 0.16), new Color(0.22, 0.2, 0.18), new Color(0.14, 0.145, 0.15)];
    this.geos = [11, 23, 37].map((s, i) => setGeometryColor(createRockGeometry(s, 1, 0.42), tints[i]));
    this.material = createLitMaterial({ kind: 'rock' });
  }

  throw(origin: Vector3, velocity: Vector3) {
    if (this.stones.length >= MAX_STONES) this.remove(this.stones[0]);
    const r = this.rnd;
    const mesh = new Mesh(this.geos[Math.floor(r() * this.geos.length)], this.material);
    const s = 0.07 + r() * 0.03;
    mesh.scale.set(s, s, s);
    mesh.position.copy(origin);
    this.scene.add(mesh);
    this.stones.push({
      mesh,
      pos: origin.clone(),
      vel: velocity.clone(),
      spin: 18 + r() * 14,
      tumble: new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(4),
      state: 'fly',
      age: 0,
      skips: 0,
    });
  }

  get active() {
    return this.stones.some((s) => s.state === 'fly');
  }

  update(dt: number) {
    for (const s of [...this.stones]) {
      s.age += dt;
      if (s.state === 'fly') this.fly(s, dt);
      else if (s.state === 'sink') this.sink(s, dt);
      else if (s.state === 'rest' && s.age > 8) this.remove(s);
      s.mesh.position.copy(s.pos);
    }
  }

  private fly(s: Stone, dt: number) {
    s.vel.y -= GRAVITY * dt;
    s.pos.addScaledVector(s.vel, dt);
    // spin flat like a skipping stone, with a little wobble
    s.mesh.rotation.y += s.spin * dt;
    s.mesh.rotation.x = Math.sin(s.age * 7) * 0.08;
    const wy = this.host.waterHeight(s.pos.x, s.pos.z);
    const ty = this.host.terrainHeight(s.pos.x, s.pos.z);
    if (ty > wy && s.pos.y <= ty + 0.03) {
      s.pos.y = ty + 0.03;
      this.host.onLand(s.pos, s.vel);
      s.vel.set(0, 0, 0);
      s.state = 'rest';
      s.age = 0;
      return;
    }
    if (s.pos.y > wy || s.vel.y > 0) return;
    const vh = Math.hypot(s.vel.x, s.vel.z);
    const angle = Math.atan2(-s.vel.y, vh);
    if (angle < SKIP_ANGLE && vh > 3.2 && s.skips < 18) {
      s.skips++;
      s.pos.y = wy + 0.005;
      this.host.onSkip(s.pos, s.vel, s.skips);
      s.vel.y = -s.vel.y * 0.6 + 0.25;
      s.vel.x *= 0.82;
      s.vel.z *= 0.82;
      // each contact nudges the heading a little
      const yaw = (this.rnd() - 0.5) * 0.08;
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      const x = s.vel.x * c - s.vel.z * sn;
      s.vel.z = s.vel.x * sn + s.vel.z * c;
      s.vel.x = x;
      return;
    }
    this.host.onPlunge(s.pos, s.vel);
    s.vel.multiplyScalar(0.12);
    s.state = 'sink';
    s.age = 0;
  }

  private sink(s: Stone, dt: number) {
    // terminal velocity in water ≈ 0.6 m/s for a pebble
    s.vel.x *= Math.exp(-dt * 3);
    s.vel.z *= Math.exp(-dt * 3);
    s.vel.y += (-0.6 - s.vel.y) * Math.min(1, dt * 4);
    s.pos.addScaledVector(s.vel, dt);
    this.tmp.copy(s.tumble).multiplyScalar(dt);
    s.mesh.rotation.x += this.tmp.x;
    s.mesh.rotation.z += this.tmp.z;
    const ty = this.host.terrainHeight(s.pos.x, s.pos.z);
    if (s.pos.y <= ty + 0.03) {
      s.pos.y = ty + 0.03;
      s.vel.set(0, 0, 0);
    }
    if (s.age < 2.5 && s.pos.y < -0.05 && Math.random() < dt * 9) this.host.onSink(s.pos);
    if (s.age > 9) this.remove(s);
  }

  private remove(s: Stone) {
    this.scene.remove(s.mesh);
    this.stones.splice(this.stones.indexOf(s), 1);
  }

  dispose() {
    for (const s of [...this.stones]) this.remove(s);
    this.geos.forEach((g) => g.dispose());
    this.material.dispose();
  }
}
