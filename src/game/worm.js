/**
 * The sandworm — threat, tension, and the walk-without-rhythm rule.
 *
 * The worm is never drawn as a mesh. Like everything else in this codebase it
 * is expressed through systems that already exist, which is both cheaper and —
 * for a first pass — more Dune: what you see of a worm from the surface is a
 * travelling ridge of displaced sand and the dust it throws, and both of those
 * the engine already knows how to draw.
 *
 *   the mound    a moving berm-only brush into the terrain state buffer. It
 *                only lands once the worm is inside the 80 m deformation
 *                window, which is exactly right: beyond that you see...
 *   the plume    dust off the shared spray pool at the worm's position, which
 *                is world-space and visible from anywhere.
 *   the rumble   camera trauma scaled by proximity, through the rig's existing
 *                trauma system, so it composes with everything else that
 *                shakes the camera.
 *
 * ## The rules (all tunable at the top of the file)
 *
 * Movement makes *noise*. Standing is silent, walking is nearly silent,
 * sprinting is loud, sand-surfing is very loud. Noise fills a meter; past the
 * threshold a worm surfaces somewhere out on the field and homes on the noise.
 *
 * The worm re-acquires its target only while the player is being loud. Go
 * quiet — stop, or walk — and it keeps ploughing toward where you *were*,
 * loses the trail, and submerges. That is the whole evasion mechanic and it is
 * the film's: movement patterns, not distance, are what the worm hears.
 *
 * An attack is a scare, not a death screen: the player is thrown clear, half
 * the carried spice is lost where they stood, and the field goes quiet again.
 * Death states can be layered on later once there is a story to hang them on.
 *
 * Allocation per frame: none.
 */

// ------------------------------------------------------------------- tuning

/** Noise gain, per second, by activity. */
const NOISE_WALK = 0.014;
const NOISE_RUN = 0.075;
const NOISE_SURF = 0.20;
/** Noise decay per second while quiet. */
const NOISE_DECAY = 0.055;
/** Meter level at which a worm surfaces. */
const SURFACE_AT = 0.55;

/** Worm speed, m/s, and how far out it surfaces. */
const WORM_SPEED_MIN = 11;
const WORM_SPEED_MAX = 17;
const SPAWN_DIST_MIN = 110;
const SPAWN_DIST_MAX = 170;

/** The worm re-aims at the player only above this noise level. */
const TRACK_NOISE = 0.16;
/** Seconds of lost trail before it gives up and submerges. */
const LOSE_AFTER = 6.0;
/** Attack trigger distance, metres. */
const ATTACK_DIST = 5.0;
/** How far the attack throws the player, metres. */
const THROW_DIST = 70;
/** Seconds of calm after an attack before noise accumulates again. */
const CALM_AFTER_ATTACK = 6.0;

/** Mound geometry. */
const MOUND_WIDTH = 1.6;
const MOUND_ELONG = 3.2;

export const WORM_IDLE = 0;
export const WORM_HUNTING = 1;

export class WormSystem {
    /**
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../vfx/particles.js").SprayField} spray
     * @param {import("../core/camera.js").CameraRig} rig
     * @param {import("../character/controller.js").CharacterController} controller
     * @param {(type:string) => void} onEvent "surface" | "lost" | "attack"
     */
    constructor(terrain, spray, rig, controller, onEvent) {
        this.terrain = terrain;
        this.deform = terrain.deform;
        this.spray = spray;
        this.rig = rig;
        this.ch = controller;
        this.onEvent = onEvent;

        /** 0..1 — the wormsign meter. */
        this.noise = 0;
        /** Scales how fast movement feeds the meter. The Quiet Steps upgrade
         *  lowers it; nothing else writes it. */
        this.noiseMul = 1;
        /**
         * Boss mode. While true the worm never loses the trail, never calms,
         * and its strike does not end the hunt — the fight only ends when the
         * story says it does. The story layer flips this; nothing here does.
         */
        this.bossMode = false;
        this.state = WORM_IDLE;

        // Worm body state while hunting.
        this.x = 0;
        this.z = 0;
        this.tx = 0;
        this.tz = 0;
        this.speed = WORM_SPEED_MIN;
        this.heading = 0;
        this._lostTime = 0;
        this._retarget = 0;
        this._calm = 0;
        this._prevX = 0;
        this._prevZ = 0;
    }

    /** @param {number} dt */
    update(dt) {
        const ch = this.ch;

        // Boss: the meter is pinned. It heard you the moment it was called.
        if (this.bossMode) {
            this.noise = 1;
            this._calm = 0;
            if (this.state === WORM_IDLE) this._surface();
            this._hunt(dt);
            return;
        }

        // ---- noise accumulation -----------------------------------------
        if (this._calm > 0) {
            this._calm -= dt;
        } else {
            let gain = 0;
            if (ch.surf > 0.5) {
                gain = NOISE_SURF * (0.4 + 0.6 * ch.speed01);
            } else if (ch.speed > 3.0) {
                gain = NOISE_RUN * Math.min(1, ch.speed / 5.4);
            } else if (ch.speed > 0.4) {
                gain = NOISE_WALK;
            }
            this.noise += gain * dt * this.noiseMul;
        }
        this.noise -= NOISE_DECAY * dt * (ch.speed < 0.4 ? 1.6 : 1.0);
        this.noise = Math.min(1, Math.max(0, this.noise));

        // ---- state machine ----------------------------------------------
        if (this.state === WORM_IDLE) {
            if (this.noise >= SURFACE_AT) this._surface();
            return;
        }

        this._hunt(dt);
    }

    _surface() {
        const ch = this.ch;
        const a = Math.random() * Math.PI * 2;
        const d = SPAWN_DIST_MIN + Math.random() * (SPAWN_DIST_MAX - SPAWN_DIST_MIN);
        this.x = ch.position.x + Math.cos(a) * d;
        this.z = ch.position.z + Math.sin(a) * d;
        this._prevX = this.x;
        this._prevZ = this.z;
        this.tx = ch.position.x;
        this.tz = ch.position.z;
        this.speed = WORM_SPEED_MIN;
        this._lostTime = 0;
        this._retarget = 0;
        this.state = WORM_HUNTING;
        this.onEvent("surface");
    }

    _hunt(dt) {
        const ch = this.ch;

        // ---- targeting: it hears rhythm, not position -------------------
        this._retarget -= dt;
        if (this.noise > TRACK_NOISE) {
            this._lostTime = 0;
            if (this._retarget <= 0) {
                this.tx = ch.position.x;
                this.tz = ch.position.z;
                this._retarget = 1.8;
                // The louder the prey, the harder it commits.
                this.speed = Math.min(
                    WORM_SPEED_MAX,
                    WORM_SPEED_MIN + this.noise * (WORM_SPEED_MAX - WORM_SPEED_MIN)
                );
            }
        } else if (!this.bossMode) {
            this._lostTime += dt;
            if (this._lostTime > LOSE_AFTER) {
                this.state = WORM_IDLE;
                this.noise = Math.min(this.noise, 0.2);
                this.onEvent("lost");
                return;
            }
        }

        // ---- movement ----------------------------------------------------
        let dx = this.tx - this.x;
        let dz = this.tz - this.z;
        const distToTarget = Math.hypot(dx, dz) || 1;
        dx /= distToTarget;
        dz /= distToTarget;
        this.heading = Math.atan2(dx, dz);

        this._prevX = this.x;
        this._prevZ = this.z;
        // It never quite stops — past its target it ploughs on and carves an
        // overshoot arc, which reads far more alive than braking to a halt.
        const step = this.speed * dt;
        this.x += dx * step;
        this.z += dz * step;

        const distToPlayer = Math.hypot(this.x - ch.position.x, this.z - ch.position.z);

        // ---- the mound ---------------------------------------------------
        // Berm scaled by distance travelled, the same rule the surf groove
        // uses, so the ridge has the same height per metre at any frame rate.
        const moved = Math.hypot(this.x - this._prevX, this.z - this._prevZ);
        const k = Math.min(moved, 0.8);
        this.deform.brush(
            this.x, this.z,
            MOUND_WIDTH,
            -0.10 * k,      // negative depression: the sand is pushed *up*
            0.85 * k,       // and heaped into a running ridge
            0, 0,
            this.heading,
            MOUND_ELONG,
            1.0
        );

        // ---- the plume ---------------------------------------------------
        const wy = this.terrain.heightAt(this.x, this.z);
        const grains = 2 + ((this.speed * dt * 4) | 0);
        for (let i = 0; i < grains; i++) {
            const s = (Math.random() - 0.5) * 2.4;
            this.spray.emit(
                this.x + (Math.random() - 0.5) * 1.4,
                wy + 0.2 + Math.random() * 0.5,
                this.z + (Math.random() - 0.5) * 1.4,
                dx * -1.5 + s, 2.2 + Math.random() * 3.5, dz * -1.5 + s,
                0.05 + Math.random() * 0.06,
                1.2 + Math.random() * 1.4,
                0
            );
        }

        // ---- the rumble --------------------------------------------------
        const near = Math.max(0, 1 - distToPlayer / 90);
        if (near > 0) this.rig.addTrauma(near * near * 1.1 * dt);

        // ---- the attack --------------------------------------------------
        if (distToPlayer < ATTACK_DIST) this._attack();
    }

    _attack() {
        const ch = this.ch;

        // Throw the player clear, away from the worm.
        let ax = ch.position.x - this.x;
        let az = ch.position.z - this.z;
        const al = Math.hypot(ax, az) || 1;
        ax /= al;
        az /= al;
        ch.position.x += ax * THROW_DIST;
        ch.position.z += az * THROW_DIST;
        this.terrain.heightfield.clampToPlayArea(ch.position);
        ch.position.y = this.terrain.heightAt(ch.position.x, ch.position.z);
        ch.velocity.set(0, 0, 0);

        // A crater where the strike landed.
        this.deform.brush(this.x, this.z, 4.5, 0.5, 0.45, 0.4, 0, 0, 1, 1);
        this.rig.addTrauma(1.0);

        if (this.bossMode) {
            // The Grandfather does not dive after a strike. It wheels for
            // another pass — which is what makes the fight a fight.
            this._retarget = 0;
            this.onEvent("attack");
            return;
        }
        this.state = WORM_IDLE;
        this.noise = 0;
        this._calm = CALM_AFTER_ATTACK;
        this.onEvent("attack");
    }

    /** The story calls this when the boss is beaten or dismissed. */
    dismiss() {
        this.bossMode = false;
        this.state = 0; // WORM_IDLE
        this.noise = 0;
        this._calm = 12;
    }

    /** True while a worm is on the surface. */
    get hunting() {
        return this.state === WORM_HUNTING;
    }

    /** Metres from worm to player, or Infinity while idle. */
    get distance() {
        if (this.state !== WORM_HUNTING) return Infinity;
        return Math.hypot(this.x - this.ch.position.x, this.z - this.ch.position.z);
    }
}
