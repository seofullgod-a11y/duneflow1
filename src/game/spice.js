/**
 * Spice deposits — the collectible.
 *
 * A deposit costs no new pipeline and no new mesh. It is drawn entirely through
 * two systems that already exist:
 *
 *   the glaze     the terrain state buffer's fourth channel (ice in SNOWFLOW,
 *                 retinted here as spice glaze) — a dark cinnamon, genuinely
 *                 reflective patch the sand shader already knows how to draw,
 *                 visible from across the field as a glossy slick. The channel
 *                 is a *max*, not a sum, so it is safe to re-stamp every frame:
 *                 that is also the only way a mark survives the deformation
 *                 window, whose toroidal buffer zeroes anything that scrolls
 *                 out and back in.
 *   the shimmer   a few grains a second out of the shared spray pool, rising
 *                 off the deposit — the "spice blow" tell, and the thing that
 *                 catches the eye long before the glaze resolves.
 *
 * Collection is a distance check. Harvesting stamps a real scoop into the
 * terrain — depth and berm, through the same `brush()` everything else uses —
 * so a worked deposit leaves a worked patch of ground behind it.
 *
 * Allocation per frame: none. Node records are plain objects created at
 * construction and recycled through respawn.
 */

import { PLAY_RADIUS } from "../terrain/heightfield.js";

/** How many deposits exist in the world at once. */
const NODE_COUNT = 14;

/** Deposits respawn elsewhere this long after being harvested, seconds. */
const RESPAWN_DELAY = 45;

/** Radii, metres. */
const GLAZE_RADIUS = 2.4;
const COLLECT_RADIUS = 2.0;
const SHIMMER_RADIUS = 60;
/** Inside this distance of the player the glaze is worth stamping at all —
 *  matches the deformation window's half-extent plus margin. */
const STAMP_RADIUS = 46;

export class SpiceField {
    /**
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../vfx/particles.js").SprayField} spray
     * @param {(amount:number, x:number, z:number) => void} onCollect
     */
    constructor(terrain, spray, onCollect) {
        this.terrain = terrain;
        this.deform = terrain.deform;
        this.spray = spray;
        this.onCollect = onCollect;

        /** @type {{x:number, z:number, y:number, amount:number, active:boolean, respawnAt:number}[]} */
        this.nodes = [];
        this._t = 0;

        for (let i = 0; i < NODE_COUNT; i++) {
            const n = { x: 0, z: 0, y: 0, amount: 0, active: false, respawnAt: 0 };
            this._place(n, true);
            this.nodes.push(n);
        }
    }

    /**
     * Drop a node somewhere fresh.
     * @param {{x:number,z:number,y:number,amount:number,active:boolean}} n
     * @param {boolean} initial spread initial spawns wider than respawns
     */
    _place(n, initial) {
        // Ring placement: never right on top of the spawn point, never outside
        // the playable clamp. The first batch spreads across the whole field so
        // the horizon always has a shimmer somewhere on it.
        const rMin = initial ? 30 : 60;
        const rMax = PLAY_RADIUS - 40;
        const a = Math.random() * Math.PI * 2;
        const r = rMin + Math.random() * (rMax - rMin);
        n.x = Math.cos(a) * r;
        n.z = Math.sin(a) * r;
        n.y = this.terrain.heightAt(n.x, n.z);
        n.amount = 3 + ((Math.random() * 5) | 0); // 3..7 units per deposit
        n.active = true;
    }

    /**
     * @param {number} dt
     * @param {{x:number, y:number, z:number}} playerPos
     */
    update(dt, playerPos) {
        this._t += dt;
        const px = playerPos.x;
        const pz = playerPos.z;

        for (let i = 0; i < this.nodes.length; i++) {
            const n = this.nodes[i];

            if (!n.active) {
                if (this._t >= n.respawnAt) this._place(n, false);
                continue;
            }

            const dx = n.x - px;
            const dz = n.z - pz;
            const dist = Math.hypot(dx, dz);

            // ---- collect ------------------------------------------------
            if (dist < COLLECT_RADIUS) {
                n.active = false;
                n.respawnAt = this._t + RESPAWN_DELAY;
                // The harvest scoop: a real mark, through the same brush as
                // boots and spells, so the ground remembers being worked.
                this.deform.brush(
                    n.x, n.z, GLAZE_RADIUS * 0.8,
                    0.22, 0.16, 0.6, 0, 0, 1, 1
                );
                this._burst(n);
                this.onCollect(n.amount, n.x, n.z);
                continue;
            }

            // ---- glaze --------------------------------------------------
            // Ice channel is a max, so a per-frame stamp is idempotent; depth
            // and berm are zero, so nothing accumulates.
            if (dist < STAMP_RADIUS) {
                this.deform.brush(n.x, n.z, GLAZE_RADIUS, 0, 0, 0, 1.0, 0, 1, 0.3);
            }

            // ---- shimmer ------------------------------------------------
            // A slow trickle of glittering grains. Probability-gated per node
            // per frame rather than a timer, so the field never pulses in sync.
            if (dist < SHIMMER_RADIUS && Math.random() < dt * 9) {
                const ra = Math.random() * Math.PI * 2;
                const rr = Math.random() * GLAZE_RADIUS * 0.8;
                this.spray.emit(
                    n.x + Math.cos(ra) * rr,
                    n.y + 0.05,
                    n.z + Math.sin(ra) * rr,
                    (Math.random() - 0.5) * 0.5,
                    0.7 + Math.random() * 1.2,
                    (Math.random() - 0.5) * 0.5,
                    0.014 + Math.random() * 0.014,
                    1.4 + Math.random() * 1.2,
                    1,      // clod: hard-edged sparkle, not a soft puff
                    0.6
                );
            }
        }
    }

    /** The harvest puff — one visible burst, so collection has a moment. */
    _burst(n) {
        for (let k = 0; k < 26; k++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.random();
            this.spray.emit(
                n.x + Math.cos(a) * r * 0.6,
                n.y + 0.08,
                n.z + Math.sin(a) * r * 0.6,
                Math.cos(a) * (0.8 + r * 1.6),
                1.6 + Math.random() * 2.4,
                Math.sin(a) * (0.8 + r * 1.6),
                0.02 + Math.random() * 0.025,
                0.7 + Math.random() * 0.7,
                Math.random() < 0.4 ? 1 : 0
            );
        }
    }

    /** Nearest active deposit's distance, for a future compass/scanner. */
    nearestDistance(px, pz) {
        let best = Infinity;
        for (let i = 0; i < this.nodes.length; i++) {
            const n = this.nodes[i];
            if (!n.active) continue;
            const d = Math.hypot(n.x - px, n.z - pz);
            if (d < best) best = d;
        }
        return best;
    }
}
