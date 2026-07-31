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
import {
    Landmarks, SLOT_CLAMP, SLOT_MOUTH_Z, SLOT_START_Z, SPAWN_Z,
} from "./landmarks.js";

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

/** The dash: an impulse along the move direction. */
const DASH_SPEED = 13.0;
const DASH_COST = 0.24;
/** Seconds of worm-proof grace after a dash — the dodge window. */
const DASH_IFRAMES = 0.55;
/** Spice paid out the first time a landmark is walked into. */
const DISCOVER_REWARD = 25;

/**
 * The trade. Four permanent upgrades, bought with carried spice at any time
 * (the fiction: a sietch trader's debt-marks, honoured anywhere). Owned
 * upgrades persist in localStorage so a death — or a browser refresh — does
 * not erase progression; the carried spice persists with them so dying with a
 * full purse costs half of it, exactly what the death rule already says.
 */
const UPGRADES = [
    { id: "lungs", key: 1, name: "LUNGS OF THE SIETCH", desc: "stamina drains a third slower", cost: 60 },
    { id: "blood", key: 2, name: "STILL BLOOD", desc: "wounds close twice as fast", cost: 80 },
    { id: "steps", key: 3, name: "QUIET STEPS", desc: "movement draws the worm far less", cost: 100 },
    { id: "wind", key: 4, name: "SECOND WIND", desc: "dashing costs half the breath", cost: 120 },
    { id: "strider", key: 5, name: "DUNE STRIDER", desc: "walk and run a fifth faster", cost: 150 },
    { id: "grip", key: 6, name: "MAKER'S GRIP", desc: "a worm strike takes half as much", cost: 180 },
];
const SAVE_KEY = "duneflow.save.v1";

/** Sietch Tabr shelter zone: centre and radius, mirroring landmarks.js. */
const SIETCH = { x: -395, z: -195, r: 120 };

/**
 * Spice blows. Every few minutes the desert erupts somewhere: a column of
 * thrown sand marks the site, an unnamed pip appears on the tape, and standing
 * in the plume harvests spice fast — but the ground there is *loud*, so the
 * blow is also a standing invitation to the worm. Risk against payout, on a
 * timer, somewhere you have to travel to: it is the whole game in miniature,
 * and it recurs on its own without a quest system to drive it.
 */
const BLOW_EVERY_MIN = 100;   // seconds between blows, minimum
const BLOW_EVERY_MAX = 170;
const BLOW_DURATION = 55;
const BLOW_RADIUS = 22;       // harvest inside this
const BLOW_RATE = 6;          // spice per second while inside
const BLOW_NOISE = 0.055;     // extra wormsign per second while inside

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

        // The named map. See landmarks.js — it mirrors landform.wgsl.
        this.landmarks = new Landmarks();

        /** @type {Record<string, boolean>} */
        this.upgrades = {};
        this._loadSave();
        this.worm.noiseMul = this.upgrades.steps ? 0.55 : 1.0;
        ctx.controller.speedMul = this.upgrades.strider ? 1.2 : 1.0;

        /** Seconds of dodge grace remaining. */
        this._iframes = 0;
        this._dashCd = 0;

        /** The spice blow event. */
        this._blowTimer = 30 + Math.random() * 60; // first one comes early
        this._blow = null; // {x, z, y, left, banked}
        this._inSietch = false;
        this._allFound = false;

        this._attacking = false;
        this.hud.setSpice(this.spice);
        this.hud.setHp(1);
        this.hud.setStamina(1);

        // The spawn slot: a gorge cut clean through the Great Rampart, a
        // hundred metres of rock either side. The centreline is exactly x = 0
        // because the slot is the one canyon in landform.wgsl authored with its
        // meander switched off — which is what makes clamping to it on the CPU
        // possible at all.
        this.phase = "canyon";
        {
            const c = ctx.controller;
            c.position.x = 0;
            c.position.z = SPAWN_Z;
            c.position.y = ctx.terrain.heightAt(0, SPAWN_Z);
        }
        this._storyT = 0;
        this._storyBeat = 0;
    }

    _loadSave() {
        try {
            const raw = localStorage.getItem(SAVE_KEY);
            if (!raw) return;
            const d = JSON.parse(raw);
            if (d && typeof d === "object") {
                this.upgrades = d.upgrades || {};
                this.spice = Math.max(0, d.spice | 0);
                for (const id of d.found || []) this.landmarks.found.add(id);
            }
        } catch (e) {
            // Private windows throw on localStorage; the game just starts fresh.
        }
    }

    _save() {
        try {
            localStorage.setItem(SAVE_KEY, JSON.stringify({
                upgrades: this.upgrades,
                spice: this.spice,
                found: Array.from(this.landmarks.found),
            }));
        } catch (e) { /* see above */ }
    }

    _buy(id) {
        const u = UPGRADES.find((x) => x.id === id);
        if (!u || this.upgrades[id] || this.spice < u.cost) return;
        this.spice -= u.cost;
        this.upgrades[id] = true;
        if (id === "steps") this.worm.noiseMul = 0.55;
        if (id === "strider") this.ctx.controller.speedMul = 1.2;
        this.hud.setSpice(this.spice);
        this.hud.toast(u.name.toLowerCase(), "the trade is honoured", 2600);
        this._save();
        this._openTrade(); // re-render with the new state
    }

    _openTrade() {
        this.hud.tradeShow(
            UPGRADES.map((u) => ({ ...u, owned: !!this.upgrades[u.id] })),
            this.spice,
            (id) => this._buy(id)
        );
    }

    /** The dash: a burst along the input direction, or straight ahead. */
    _dash() {
        if (this._dashCd > 0 || this.winded) return;
        const cost = DASH_COST * (this.upgrades.wind ? 0.5 : 1.0);
        if (this.stamina < cost) return;
        this.stamina -= cost;

        const ch = this.ctx.controller;
        // Along the current velocity if moving, else along the facing — a
        // standing dash is a dodge, a moving dash is a lunge, and while surfing
        // it is a straight speed boost.
        let dx = ch.velocity.x, dz = ch.velocity.z;
        const sp = Math.hypot(dx, dz);
        if (sp > 0.5) { dx /= sp; dz /= sp; }
        else { dx = Math.sin(ch.facing); dz = Math.cos(ch.facing); }
        ch.velocity.x += dx * DASH_SPEED;
        ch.velocity.z += dz * DASH_SPEED;

        this._iframes = DASH_IFRAMES;
        this._dashCd = 0.55;
        this.ctx.rig.addTrauma(0.10);
        // The dash kicks up a burst of sand where it started — a dozen grains
        // thrown back against the lunge, plus a couple of clods.
        for (let i = 0; i < 14; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.random();
            this.ctx.spray.emit(
                ch.position.x + Math.cos(a) * 0.3,
                ch.position.y + 0.15 + Math.random() * 0.3,
                ch.position.z + Math.sin(a) * 0.3,
                -dx * (2.0 + r * 3.0) + Math.cos(a) * 1.2,
                1.2 + Math.random() * 1.8,
                -dz * (2.0 + r * 3.0) + Math.sin(a) * 1.2,
                0.05 + Math.random() * 0.06,
                0.5 + Math.random() * 0.4,
                i < 3 ? 1 : 0,
                1.4
            );
        }
    }

    /** Pick a blow site: away from the player, inside the play disc, on open
     *  sand (a blow inside a canyon or against a cliff is invisible and the
     *  march to it is a trap). Rejection sampling, a handful of tries. */
    _spawnBlow() {
        const ch = this.ctx.controller;
        for (let i = 0; i < 10; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = 180 + Math.random() * 260;
            const x = ch.position.x + Math.cos(a) * r;
            const z = ch.position.z + Math.sin(a) * r;
            if (Math.hypot(x, z) > 540) continue;
            const y = this.ctx.terrain.heightAt(x, z);
            // Reject rock: sample the ground's tilt; a blow wants flats.
            const y2 = this.ctx.terrain.heightAt(x + 8, z);
            const y3 = this.ctx.terrain.heightAt(x, z + 8);
            if (Math.abs(y2 - y) > 4 || Math.abs(y3 - y) > 4) continue;
            this._blow = { x, z, y, left: BLOW_DURATION, banked: 0 };
            this.landmarks.event = this._blow;
            this.hud.toast("spice blow", "the desert erupts \u00b7 follow the tape", 5200);
            return;
        }
        // No good site this time; try again soon.
        this._blowTimer = 20;
    }

    /** @param {number} dt */
    _updateBlow(dt) {
        if (!this._blow) {
            this._blowTimer -= dt;
            if (this._blowTimer <= 0) this._spawnBlow();
            return;
        }
        const b = this._blow;
        b.left -= dt;

        const ch = this.ctx.controller;
        const d = Math.hypot(ch.position.x - b.x, ch.position.z - b.z);

        // The eruption column. Cheap: a handful of grains a frame, only while
        // anyone is close enough for them to resolve.
        if (d < 420) {
            const n = d < 120 ? 5 : 2;
            for (let i = 0; i < n; i++) {
                const a = Math.random() * Math.PI * 2;
                const r = Math.random() * 4.0;
                this.ctx.spray.emit(
                    b.x + Math.cos(a) * r, b.y + Math.random() * 1.5, b.z + Math.sin(a) * r,
                    Math.cos(a) * 1.5, 7.0 + Math.random() * 9.0, Math.sin(a) * 1.5,
                    0.07 + Math.random() * 0.10, 1.6 + Math.random() * 1.2,
                    Math.random() < 0.25 ? 1 : 0, 0.6
                );
            }
        }

        // Harvest — and the noise that comes with standing in an eruption.
        if (d < BLOW_RADIUS) {
            b.banked += BLOW_RATE * dt;
            this.worm.noise = Math.min(1, this.worm.noise + BLOW_NOISE * dt);
            if (b.banked >= 5) {
                const take = Math.floor(b.banked);
                b.banked -= take;
                this.spice += take;
                this.hud.setSpice(this.spice);
            }
        }

        if (b.left <= 0) {
            this._blow = null;
            this.landmarks.event = null;
            this._blowTimer = BLOW_EVERY_MIN + Math.random() * (BLOW_EVERY_MAX - BLOW_EVERY_MIN);
            this._save();
            this.hud.toast("the blow subsides", null, 2600);
        }
    }

    /** The scripted trickle of the opening. */
    _story(dt) {
        this._storyT += dt;
        if (this._storyBeat === 0 && this._storyT > 2.0) {
            this._storyBeat = 1;
            this.hud.toast("you wake in the slot",
                "the tribe is gone \u00b7 the water is gone", 5200);
        } else if (this._storyBeat === 1 && this._storyT > 8.5) {
            this._storyBeat = 2;
            this.hud.toast("the light is north",
                "follow the cut out of the rampart", 4600);
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
        setTimeout(() => {
            this.hud.toast("space to dash \u00b7 u to trade",
                "spice buys permanent strength", 5200);
        }, 9400);
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
            if (this._iframes > 0) {
                // Dodged. The strike lands where you were.
                this.hud.toast("dodged", "shai-hulud strikes sand", 2400);
                this.ctx.rig.addTrauma(0.30);
                return;
            }
            this.hp -= HP_WORM_HIT * (this.upgrades.grip ? 0.5 : 1.0);
            this.ctx.post.resetHistory();
            if (this.hp > 0) {
                const lost = Math.ceil(this.spice / 2);
                this.spice -= lost;
                this.hud.setSpice(this.spice);
                this._save();
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
        this._save();

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

        if (this.phase === "canyon") {
            this._story(dt);
            if (ch.position.z < SLOT_MOUTH_Z + 6) {
                // Straight walls, straight clamp. Held a little inside the
                // floor mask — see SLOT_CLAMP.
                if (ch.position.x < -SLOT_CLAMP) ch.position.x = -SLOT_CLAMP;
                if (ch.position.x > SLOT_CLAMP) ch.position.x = SLOT_CLAMP;
                if (ch.position.z < SLOT_START_Z + 14) ch.position.z = SLOT_START_Z + 14;
            } else {
                this._exitCave();
            }
        }
        const underground = this.phase === "canyon";

        // ---- the trade -----------------------------------------------------
        if (input.tradePressed) {
            if (this.hud.tradeOpen) this.hud.tradeHide();
            else this._openTrade();
        }
        if (this.hud.tradeOpen) {
            // Number keys buy instead of casting while the panel is up. The
            // spell dispatch runs after this, so zeroing the field here is all
            // the suppression needed.
            const n = input.spellPressed;
            if (n >= 1 && n <= 6) {
                const u = UPGRADES.find((x) => x.key === n);
                if (u) this._buy(u.id);
            }
            input.spellPressed = 0;
        }

        // ---- the dash ------------------------------------------------------
        this._dashCd = Math.max(0, this._dashCd - dt);
        this._iframes = Math.max(0, this._iframes - dt);
        if (input.dashPressed && !this.hud.tradeOpen) this._dash();

        // ---- keyboard cast plate (buttons report through onCast) ---------
        // Runs before the spell dispatch consumes the field, so both input
        // paths land on the same plate.
        if (input.spellPressed >= 1 && input.spellPressed <= 5) {
            this.hud.skill(PLATES[input.spellPressed]);
        }

        // ---- stamina ------------------------------------------------------
        const surfing = ch.surf > 0.5;
        const sprinting = input.sprint && ch.speed > 3.0 && !surfing;
        const lungs = this.upgrades.lungs ? 0.67 : 1.0;
        if (surfing) this.stamina -= ST_SURF * lungs * dt;
        else if (sprinting) this.stamina -= ST_SPRINT * lungs * dt;
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
        this.hp = Math.min(1, this.hp + HP_REGEN * (this.upgrades.blood ? 2.0 : 1.0) * dt);
        if (this.hp <= 0 && !this._dead) this._die();

        // ---- systems (asleep underground) --------------------------------
        if (!underground) {
            this.spiceField.update(dt, ch.position);
            this.worm.update(dt);
            this.wind.update(dt, ch.position);
            this._updateBlow(dt);

            // The Sietch shelters. Inside Tabr's ground the rock is too thick
            // for the worm to read — noise bleeds off fast — and the quiet is
            // worth a faster mend. This turns the far south-west corner into
            // the map's rest point, which is exactly as far from the Spice
            // Bowl as a rest point should be.
            const inS = Math.hypot(ch.position.x - SIETCH.x, ch.position.z - SIETCH.z) < SIETCH.r;
            if (inS) {
                this.worm.noise = Math.max(0, this.worm.noise - 0.25 * dt);
                this.hp = Math.min(1, this.hp + 0.03 * dt);
                if (!this._inSietch) {
                    this.hud.toast("the sietch shelters you",
                        "the worm cannot hear \u00b7 wounds mend", 3600);
                }
            }
            this._inSietch = inS;
        }

        // Storm streaks: a faint constant screen-space wind smear whose weight
        // rides the gust envelope, so squalls visibly rake the frame. main.js
        // takes the max of this and the surf streak. Still air underground.
        this.stormStreak01 = underground ? 0 : 0.10 + this.wind.gust * 0.22;

        // ---- the map ------------------------------------------------------
        // Runs everywhere, including inside the slot: the tape is how the
        // player learns that north is out before they are told it.
        const cp = this.landmarks.update(ch.position, ch.facing, (l) => {
            this.hud.discover(l.name, l.sub);
            this.ctx.rig.addTrauma(0.06);
            // Exploration pays. Not much — the spice field is still the
            // economy — but enough that walking toward an unnamed pip on the
            // tape is never a wasted trip.
            this.spice += DISCOVER_REWARD;
            this.hud.setSpice(this.spice);
            this.hud.toast("+" + DISCOVER_REWARD + " spice", "for the finding", 2200);
            this._save();
        });
        if (!this._allFound && this.landmarks.discovered >= this.landmarks.total) {
            this._allFound = true;
            this.spice += 300;
            this.hud.setSpice(this.spice);
            this.hud.death("THE DESERT IS KNOWN", 4200);
            setTimeout(() => {
                this.hud.toast("+300 spice", "every place has its name again", 4600);
            }, 4400);
            this._save();
        }

        const near = this.landmarks.nearest;
        this.hud.setCompass(
            cp.heading, cp.marks, cp.count,
            near && this.landmarks.found.has(near.id) ? near.name : null
        );

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
