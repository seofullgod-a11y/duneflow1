/**
 * Desert wind — spindrift racing across the sand and dust hanging in the gusts.
 *
 * Like everything in the game layer this owns no pipeline and no mesh: the wind
 * is drawn entirely through the shared spray pool, the same one the footfalls,
 * the surf plume and the worm dust already use. So a gust is just a burst of
 * grains launched downwind, and the engine draws it with the sand-dust material
 * it already has.
 *
 * Two populations, because desert wind reads as two things at once:
 *
 *   spindrift    low, fast streamers that hug the crests of dunes and race
 *                downwind a few centimetres off the ground. This is the tell
 *                that the *surface* is moving — the thing you see in every Dune
 *                shot of an open erg. Emitted just upwind of the player and to
 *                the sides, so it streams *through* frame rather than away from
 *                it.
 *   gust dust    taller, slower veils that lift and drift, thicker during a
 *                gust and nearly gone between them. This is the haze that sells
 *                distance and depth.
 *
 * The gust envelope is one shared scalar so both populations breathe together —
 * a lull is a lull for the whole field, not a statistical average that never
 * actually goes quiet. It reads `S.windDirection` and `S.windStrength`, the same
 * two settings the cloth, the sky and the deformation refill already follow, so
 * turning the wind up in the overlay turns *everything* up together.
 *
 * Allocation per frame: none.
 */

import { S } from "../core/settings.js";

/** Grains per second of spindrift at full wind, before the gust envelope. */
const SPINDRIFT_RATE = 95;
/** Grains per second of airborne dust at full wind. */
const DUST_RATE = 30;
/** Large slow dust veils per second — the mid-distance murk of the storm. */
const VEIL_RATE = 8;

/** How far up/down-wind of the player the emitters sit, metres. */
const UPWIND = 26;
/** Half-width of the emission band across the wind, metres. */
const SPREAD = 34;

export class Wind {
    /**
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../vfx/particles.js").SprayField} spray
     */
    constructor(terrain, spray) {
        this.terrain = terrain;
        this.spray = spray;

        this._t = 0;
        /** Fractional-grain accumulators, so low rates still emit correctly. */
        this._spinAcc = 0;
        this._dustAcc = 0;
        this._veilAcc = 0;
        this._gust = 0.5;
    }

    /**
     * @param {number} dt
     * @param {{x:number, y:number, z:number}} focus player world position
     */
    update(dt, focus) {
        this._t += dt;

        const strength = S.windStrength;
        if (strength <= 0.001) return;

        // ---- storm envelope ---------------------------------------------
        // A *permanent* storm: the base never drops below a real blow, and the
        // three incommensurate sines ride on top of it as gust fronts — so the
        // field is always streaming and the gusts read as squalls passing
        // through, not as the wind switching on and off.
        const g =
            0.80 +
            0.22 * Math.sin(this._t * 0.23) +
            0.14 * Math.sin(this._t * 0.61 + 1.7) +
            0.09 * Math.sin(this._t * 1.30 + 4.2);
        this._gust = Math.max(0.35, g);
        const env = this._gust * strength;

        // Wind vector. `windDirection` is a compass bearing, same convention as
        // the cloth and the sky.
        const a = (S.windDirection * Math.PI) / 180;
        const wx = Math.sin(a);
        const wz = Math.cos(a);
        // The across-wind axis, for spreading the emission band.
        const cx = wz;
        const cz = -wx;

        // ---- spindrift ---------------------------------------------------
        this._spinAcc += SPINDRIFT_RATE * env * dt;
        let nSpin = this._spinAcc | 0;
        this._spinAcc -= nSpin;
        if (nSpin > 60) nSpin = 60; // clamp a catch-up spike after a hitch
        for (let i = 0; i < nSpin; i++) {
            // Start upwind of the player and off to a random side, so the
            // streamer crosses frame.
            const along = -UPWIND + Math.random() * 8;
            const across = (Math.random() * 2 - 1) * SPREAD;
            const x = focus.x + wx * along + cx * across;
            const z = focus.z + wz * along + cz * across;
            const gy = this.terrain.heightAt(x, z);
            // Just off the deck, moving fast and almost flat.
            const sp = 7 + env * 6 + Math.random() * 3;
            this.spray.emit(
                x, gy + 0.04 + Math.random() * 0.10, z,
                wx * sp + cx * (Math.random() - 0.5) * 1.2,
                0.25 + Math.random() * 0.35,
                wz * sp + cz * (Math.random() - 0.5) * 1.2,
                0.02 + Math.random() * 0.03,
                0.8 + Math.random() * 0.6,
                0,      // powder puff
                0.5     // low drag: it carries downwind rather than stopping dead
            );
        }

        // ---- gust dust ---------------------------------------------------
        // Only the upper half of the envelope throws real airborne haze, so
        // between gusts the air genuinely clears.
        const dustEnv = Math.max(0, env - 0.22);
        this._dustAcc += DUST_RATE * dustEnv * dt;
        let nDust = this._dustAcc | 0;
        this._dustAcc -= nDust;
        if (nDust > 24) nDust = 24;
        for (let i = 0; i < nDust; i++) {
            const along = -UPWIND + Math.random() * 12;
            const across = (Math.random() * 2 - 1) * SPREAD;
            const x = focus.x + wx * along + cx * across;
            const z = focus.z + wz * along + cz * across;
            const gy = this.terrain.heightAt(x, z);
            const sp = 3 + dustEnv * 4;
            this.spray.emit(
                x, gy + 0.4 + Math.random() * 1.6, z,
                wx * sp + cx * (Math.random() - 0.5) * 1.6,
                0.5 + Math.random() * 1.0,
                wz * sp + cz * (Math.random() - 0.5) * 1.6,
                0.06 + Math.random() * 0.07,
                1.8 + Math.random() * 1.8,
                0,
                0.7
            );
        }

        // ---- storm veils -------------------------------------------------
        // The mid-distance murk: big, slow, long-lived sheets drifting through
        // 20-70 m out. Individually they are just large soft grains; together
        // they are the layer that makes the far dunes come and go the way the
        // reference stills do. Emitted in a full ring rather than only upwind,
        // so the horizon is veiled in every direction, not just one.
        this._veilAcc += VEIL_RATE * (0.5 + env * 0.7) * dt;
        let nVeil = this._veilAcc | 0;
        this._veilAcc -= nVeil;
        if (nVeil > 10) nVeil = 10;
        for (let i = 0; i < nVeil; i++) {
            const ang = Math.random() * Math.PI * 2;
            const r = 20 + Math.random() * 50;
            const x = focus.x + Math.cos(ang) * r;
            const z = focus.z + Math.sin(ang) * r;
            const gy = this.terrain.heightAt(x, z);
            const sp = 2.5 + env * 3.5;
            this.spray.emit(
                x, gy + 1.0 + Math.random() * 3.2, z,
                wx * sp, 0.2 + Math.random() * 0.5, wz * sp,
                0.16 + Math.random() * 0.18,
                3.5 + Math.random() * 2.5,
                0,
                0.35
            );
        }
    }

    /** Current storm envelope 0..~1.25 — the game reads this for screen streaks. */
    get gust() {
        return this._gust;
    }
}
