/**
 * The game layer.
 *
 * Everything gameplay lives under `src/game/` and touches the engine only
 * through the same public seams every existing system uses: `deform.brush()`,
 * `spray.emit()`, `rig.addTrauma()`, `terrain.heightAt()` and the character
 * controller's position and input struct. Nothing here owns a pipeline, a mesh
 * or a shader — which is what keeps the engine and the game separable while
 * the story is still being found.
 *
 * ## Stats
 *
 * Two survival stats back the soulslike bars:
 *
 *   hp        0..1. The worm's strike takes a large bite; it regenerates
 *             slowly. At zero: the death card, respawn at the spawn point,
 *             half the carried spice left in the sand.
 *   stamina   0..1. Sprinting and sand-surfing drain it; standing or walking
 *             refills it. At zero the character is *winded*: sprint and surf
 *             are forced off until the bar climbs back over the recovery
 *             mark, so a chase is a resource problem, not a held key.
 *
 * One `update(dt)` per frame from `main.js`, after the contact system and
 * before the camera rig — so a worm throw or a death respawn moves the camera
 * the same frame. It runs before the spell dispatch too, which is what lets
 * the skill plate read `input.spellPressed` for keyboard casts.
 */

import { input } from "../core/input.js";
import { Hud } from "./hud.js";
import { SpiceField } from "./spice.js";
import { WormSystem } from "./worm.js";
import { Wind } from "./wind.js";
import { Controls } from "./controls.js";

/** Stamina drain / regen rates, bar-fractions per second. */
const ST_SPRINT = 0.15;
const ST_SURF = 0.105;
const ST_REGEN = 0.24;
/** Once winded, sprint/surf stay locked until stamina recovers to here. */
const ST_RECOVER = 0.28;

/** HP: what a worm strike costs, and the slow crawl back. */
const HP_WORM_HIT = 0.45;
const HP_REGEN = 0.018;

/** Worm spawn distance ceiling — normalises the boss bar's proximity fill. */
const BOSS_RANGE = 170;

/** Plate names for keyboard casts, indexed by spell key. */
const PLATES = [null, "Sand Sweep", "Sand Ribbon", "Dune Burst", "Crystallise Spice", "Sand Vortex"];

export class Game {
    /**
     * @param {{
     *   terrain: import("../terrain/terrain.js").Terrain,
     *   controller: import("../character/controller.js").CharacterController,
     *   rig: import("../core/camera.js").CameraRig,
     *   spray: import("../vfx/particles.js").SprayField,
     *   post: import("../post/postChain.js").PostChain,
     *   spells: import("../spells/spellSystem.js").SpellSystem,
     *   scene: import("@babylonjs/core/scene").Scene,
     * }} ctx
     */
    constructor(ctx) {
        this.ctx = ctx;

        this.spice = 0;
        this.hp = 1;
        this.stamina = 1;
        /** True from stamina hitting zero until it recovers past ST_RECOVER. */
        this.winded = false;
        this._dead = false;

        this.hud = new Hud();

        this.spiceField = new SpiceField(ctx.terrain, ctx.spray, (amount) => {
            this.spice += amount;
            this.hud.setSpice(this.spice);
            this.hud.toast("+" + amount + " spice", null, 1400);
        });

        this.worm = new WormSystem(
            ctx.terrain, ctx.spray, ctx.rig, ctx.controller,
            (type) => this._onWormEvent(type)
        );

        // The permanent desert storm — see wind.js.
        this.wind = new Wind(ctx.terrain, ctx.spray);

        this.controls = new Controls({
            spells: ctx.spells,
            onAttack: (held) => this._attack(held),
            onCast: (name) => this.hud.skill(name),
        });

        this._attacking = false;
        this.hud.setSpice(0);
        this.hud.setHp(1);
        this.hud.setStamina(1);

        this.phase = "erg";
        this._storyT = 0;
        this._storyBeat = 0;
    }

    /** The scripted trickle of the opening. */
    _story(dt) {
        this._storyT += dt;
        if (this._storyBeat === 0 && this._storyT > 2.0) {
            this._storyBeat = 1;
            this.hud.toast("you wake in the deep shelter",
                "the tribe is gone \u00b7 the water is gone", 5200);
        } else if (this._storyBeat === 1 && this._storyT > 8.5) {
            this._storyBeat = 2;
            this.hud.toast("follow the crystal light",
                "find the way out", 4600);
        }
    }

    /** Crossing the mouth: the reveal, and the systems wake up. */
    _exitCave() {
        this.phase = "erg";
        this.hud.death("THE OPEN ERG", 3600);
        setTimeout(() => {
            this.hud.toast("harvest the spice",
                "the glittering blows \u00b7 speed draws the worm", 5200);
        }, 3800);
        this.ctx.rig.addTrauma(0.25);
    }

    /**
     * Water Lash — the attack. Held, it drives the Ribbon spell (a whip of
     * water that tracks the aim and scores the sand) plus a camera kick on the
     * leading edge. Routed through the spell system's `debugRibbon` latch so it
     * composes with the spell-2 slot instead of fighting it each frame.
     * @param {boolean} held
     */
    _attack(held) {
        if (held && !this._attacking) this.ctx.rig.addTrauma(0.18);
        this._attacking = held;
        this.ctx.spells.debugRibbon = held;
    }

    _onWormEvent(type) {
        if (type === "surface") {
            this.hud.toast("wormsign", "stop moving \u00b7 walk without rhythm");
        } else if (type === "lost") {
            this.hud.toast("the worm passes", "it has lost your trail");
        } else if (type === "attack") {
            this.hp -= HP_WORM_HIT;
            this.ctx.post.resetHistory();
            if (this.hp > 0) {
                const lost = Math.ceil(this.spice / 2);
                this.spice -= lost;
                this.hud.setSpice(this.spice);
                this.hud.toast(
                    "shai-hulud",
                    lost > 0 ? "thrown clear \u00b7 " + lost + " spice lost" : "thrown clear",
                    3200
                );
            }
        }
    }

    _die() {
        if (this._dead) return;
        this._dead = true;
        this.hud.death("SWALLOWED BY THE SAND");

        const ch = this.ctx.controller;
        const lost = Math.ceil(this.spice / 2);
        this.spice -= lost;

        setTimeout(() => {
            ch.position.set(0, 0, 8);
            ch.position.y = this.ctx.terrain.heightAt(0, 8);
            ch.velocity.set(0, 0, 0);
            this.ctx.post.resetHistory();
            this.hp = 1;
            this.stamina = 1;
            this.winded = false;
            this.worm.noise = 0;
            this.hud.setSpice(this.spice);
            this._dead = false;
        }, 2600);
    }

    /** @param {number} dt seconds */
    update(dt) {
        const ch = this.ctx.controller;

        const underground = false;

        // ---- keyboard cast plate (buttons report through onCast) ---------
        // Runs before the spell dispatch consumes the field, so both input
        // paths land on the same plate.
        if (input.spellPressed >= 1 && input.spellPressed <= 5) {
            this.hud.skill(PLATES[input.spellPressed]);
        }

        // ---- stamina ------------------------------------------------------
        const surfing = ch.surf > 0.5;
        const sprinting = input.sprint && ch.speed > 3.0 && !surfing;
        if (surfing) this.stamina -= ST_SURF * dt;
        else if (sprinting) this.stamina -= ST_SPRINT * dt;
        else this.stamina += ST_REGEN * dt * (ch.speed < 0.4 ? 1.25 : 1.0);
        this.stamina = Math.min(1, Math.max(0, this.stamina));

        if (this.stamina <= 0 && !this.winded) {
            this.winded = true;
            this.hud.toast("winded", null, 1400);
        }
        if (this.winded) {
            // Force the fast movement off until the bar recovers. These are
            // read next frame, which is close enough for a fatigue system.
            input.touchSprint = false;
            input.surf = false;
            input.touchSurf = false;
            if (this.controls.surfOn) this.controls.setSurf(false);
            if (this.stamina >= ST_RECOVER) this.winded = false;
        }

        // ---- hp -----------------------------------------------------------
        this.hp = Math.min(1, this.hp + HP_REGEN * dt);
        if (this.hp <= 0 && !this._dead) this._die();

        // ---- systems (asleep underground) --------------------------------
        if (!underground) {
            this.spiceField.update(dt, ch.position);
            this.worm.update(dt);
            this.wind.update(dt, ch.position);
        }

        // Storm streaks: a faint constant screen-space wind smear whose weight
        // rides the gust envelope, so squalls visibly rake the frame. main.js
        // takes the max of this and the surf streak. Still air underground.
        this.stormStreak01 = underground ? 0 : 0.10 + this.wind.gust * 0.22;

        // ---- hud ----------------------------------------------------------
        this.hud.setHp(Math.max(0, this.hp));
        this.hud.setStamina(this.stamina);
        this.hud.setNoise(this.worm.noise);
        if (this.worm.hunting) {
            const fill = 1 - Math.min(1, this.worm.distance / BOSS_RANGE);
            this.hud.setBoss("SHAI-HULUD", fill);
        } else {
            this.hud.setBoss(null);
        }
    }
}
