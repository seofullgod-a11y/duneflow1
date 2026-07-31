/**
 * The story — DUNEFLOW: The Last Water.
 *
 * ## The frame
 *
 * The tribe of the Deep Shelter did not die. In the worst drought in living
 * memory they made a trade with the oldest worm of this erg — THE GRANDFATHER —
 * water for service, and it took them *into* the sand. The storm that has not
 * stopped since is its breath. You slept through the taking, sealed in the
 * slot, and you are what is left.
 *
 * The tribe's covenant was sworn on three WATER RINGS, left where the oaths
 * were made: in the shadow of the sietch, in the wind of the north pass, and
 * in the pit the first blow tore open. Carry all three to the Spice Bowl —
 * the open ground where nothing can hide — and the Grandfather must come to
 * answer for them. Break it, and the debt breaks with it: the tribe's water
 * returns to the sand, and the storm finally exhales.
 *
 * ## The shape of the game
 *
 * Act I  THE WAKING     out of the slot; reach The Thumb. Teaches movement,
 *                       the tape, and that names are rewards.
 * Act II THE THREE RINGS three journeys to three corners of the map, each
 *                       through different terrain and different worm risk.
 *                       This is where the trade loop matters: the player is
 *                       expected to arrive at Act III with most upgrades.
 * Act III THE GRANDFATHER the boss. Called at the Spice Bowl; fought with the
 *                       systems the game already taught — dash i-frames to
 *                       survive its pass, Sand Lash to wound it while it is
 *                       close, stamina as the clock on both.
 * After                 the storm calms. A quieter desert, permanently, so
 *                       the ending is visible in the world and not only in a
 *                       card.
 *
 * ## The fight, mechanically
 *
 * The worm's boss mode (worm.js) pins its noise and removes its calm-downs;
 * the story owns its HP. Two ways to wound it, both close-range:
 *
 *   lash    holding the attack with the worm inside LASH_RANGE bleeds it —
 *           steady damage for standing in the most dangerous place there is.
 *   riposte a strike dodged with dash i-frames costs it a chunk — the high-
 *           skill line through the fight.
 *
 * Everything here runs off Game's public state; nothing touches a pipeline.
 */

/** Story stages, persisted by index. */
export const ST_WAKING = 0;
export const ST_RINGS = 1;
export const ST_CARRY = 2;
export const ST_BOSS = 3;
export const ST_DONE = 4;

/** The three rings. Channel time is the stand-still cost of taking one. */
const RINGS = [
    {
        id: "stone", x: -352, z: -158, name: "THE RING OF STONE",
        sub: "sworn in the sietch's shadow",
        lore: ["the first oath", "water for shelter \u00b7 the stone kept its half"],
    },
    {
        id: "wind", x: 180, z: 548, name: "THE RING OF WIND",
        sub: "sworn in the mouth of the pass",
        lore: ["the second oath", "water for passage \u00b7 the wind still howls it"],
    },
    {
        id: "dust", x: -520, z: 55, name: "THE RING OF DUST",
        sub: "sworn in the first blow's pit",
        lore: ["the third oath", "water for spice \u00b7 the pit remembers"],
    },
];
const RING_RADIUS = 7;
const CHANNEL_TIME = 2.6;

/** The summoning ground. */
const ALTAR = { x: 465, z: -300, r: 14 };

/** Boss tuning. */
const BOSS_NAME = "THE GRANDFATHER";
const LASH_RANGE = 34;
const LASH_DPS = 0.040;      // ~25 s of held lash in range, across the fight
const RIPOSTE_DAMAGE = 0.09; // a dodged strike costs it this
const BOSS_HP_REGEN = 0.006; // slow — disengaging fully resets nothing fast

export class Story {
    /** @param {import("./game.js").Game} game */
    constructor(game) {
        this.g = game;
        this.stage = ST_WAKING;
        /** @type {Set<string>} */
        this.rings = new Set();
        this.bossHp = 1;
        this._channel = 0;
        this._channelRing = null;
        this._bossIntroT = 0;
        this._lash = 0; // seconds of continuous lash, for feedback pacing
    }

    // ------------------------------------------------------------ persistence
    saveInto(d) {
        d.story = { stage: this.stage, rings: Array.from(this.rings) };
    }

    loadFrom(d) {
        if (!d.story) return;
        this.stage = Math.min(d.story.stage | 0, ST_DONE);
        for (const id of d.story.rings || []) this.rings.add(id);
        // Never resume mid-boss: the fight state is not worth persisting, and
        // reloading into a pinned worm is a bad first frame. Back to the altar.
        if (this.stage === ST_BOSS) this.stage = ST_CARRY;
        if (this.stage === ST_DONE) this.g.applyCalmWorld();
    }

    // -------------------------------------------------------------- objective
    /** @returns {string|null} the HUD objective line */
    objective() {
        switch (this.stage) {
            case ST_WAKING:
                return this.g.phase === "canyon"
                    ? "leave the slot"
                    : "reach the thumb";
            case ST_RINGS: {
                const left = RINGS.length - this.rings.size;
                return "recover the water rings \u00b7 " + left + " remain";
            }
            case ST_CARRY:
                return "carry the rings to the spice bowl";
            case ST_BOSS:
                return "break the covenant";
            default:
                return null;
        }
    }

    /** The compass target for the current beat, or null. */
    _target() {
        switch (this.stage) {
            case ST_WAKING:
                return this.g.phase === "canyon" ? null : { x: 175, z: 135 };
            case ST_RINGS: {
                // Nearest unclaimed ring. Guides without dictating an order.
                const ch = this.g.ctx.controller;
                let best = null;
                let bd = Infinity;
                for (const r of RINGS) {
                    if (this.rings.has(r.id)) continue;
                    const d = Math.hypot(r.x - ch.position.x, r.z - ch.position.z);
                    if (d < bd) { bd = d; best = r; }
                }
                return best;
            }
            case ST_CARRY:
            case ST_BOSS:
                return ALTAR;
            default:
                return null;
        }
    }

    // ------------------------------------------------------------------ beats
    /** @param {number} dt */
    update(dt) {
        const g = this.g;
        const ch = g.ctx.controller;
        const hud = g.hud;

        hud.setObjective(this.objective());
        g.landmarks.quest = this._target();

        switch (this.stage) {
            case ST_WAKING: {
                // Reaching the Thumb — by discovery or plain proximity.
                if (g.phase !== "canyon" &&
                    (g.landmarks.found.has("thumb") ||
                     Math.hypot(ch.position.x - 175, ch.position.z - 135) < 80)) {
                    this.stage = ST_RINGS;
                    hud.discover("THE THREE RINGS",
                        "the covenant was sworn on three rings \u00b7 the tape knows where");
                    g.saveStory();
                }
                break;
            }

            case ST_RINGS: {
                this._updateRings(dt);
                if (this.rings.size >= RINGS.length) {
                    this.stage = ST_CARRY;
                    hud.discover("THE DEBT IS GATHERED",
                        "carry the rings to the open ground \u00b7 it must answer");
                    g.saveStory();
                }
                break;
            }

            case ST_CARRY: {
                const d = Math.hypot(ch.position.x - ALTAR.x, ch.position.z - ALTAR.z);
                if (d < ALTAR.r) this._beginBoss();
                break;
            }

            case ST_BOSS:
                this._updateBoss(dt);
                break;
        }
    }

    _updateRings(dt) {
        const g = this.g;
        const ch = g.ctx.controller;

        let near = null;
        for (const r of RINGS) {
            if (this.rings.has(r.id)) continue;
            if (Math.hypot(r.x - ch.position.x, r.z - ch.position.z) < RING_RADIUS) {
                near = r;
                break;
            }
        }

        // Channelled, not walked over. Standing still for the take is a real
        // cost — the meter keeps climbing if the worm is loose — and moving
        // resets it, so the take is a decision rather than a doorway.
        if (near && ch.speed < 0.6) {
            if (this._channelRing !== near.id) {
                this._channelRing = near.id;
                this._channel = 0;
                g.hud.toast("hold still", "the sand gives it up slowly", 2200);
            }
            this._channel += dt;
            if (this._channel >= CHANNEL_TIME) {
                this.rings.add(near.id);
                this._channelRing = null;
                g.hud.discover(near.name, near.sub);
                g.hud.toast(near.lore[0], near.lore[1], 5200);
                g.ctx.rig.addTrauma(0.12);
                g.saveStory();
            }
        } else {
            this._channelRing = null;
            this._channel = 0;
        }
    }

    _beginBoss() {
        const g = this.g;
        this.stage = ST_BOSS;
        this.bossHp = 1;
        this._bossIntroT = 0;
        this._lash = 0;
        g.worm.bossMode = true;
        g.hud.death(BOSS_NAME, 3400);
        g.hud.toast("it answers",
            "dash through its strike \u00b7 lash it while it is near", 6400);
        g.ctx.rig.addTrauma(0.6);
    }

    /**
     * A boss strike resolved. Called by Game from the worm's attack event,
     * after the i-frame check — `dodged` says which side of it we came out on.
     * @param {boolean} dodged
     */
    onBossStrike(dodged) {
        if (this.stage !== ST_BOSS) return;
        if (dodged) {
            this.bossHp -= RIPOSTE_DAMAGE;
            this.g.hud.toast("riposte", "the dodge cuts it", 2000);
            this._checkBossDown();
        }
    }

    _updateBoss(dt) {
        const g = this.g;
        const worm = g.worm;
        this._bossIntroT += dt;

        // The lash: damage for holding the attack inside its reach.
        if (g.isLashing && worm.hunting && worm.distance < LASH_RANGE) {
            this.bossHp -= LASH_DPS * dt;
            this._lash += dt;
            if (this._lash > 2.5) {
                this._lash = 0;
                g.ctx.rig.addTrauma(0.05);
            }
        } else {
            this._lash = 0;
            this.bossHp = Math.min(1, this.bossHp + BOSS_HP_REGEN * dt);
        }

        // The boss bar carries its wound, not its distance, during the fight.
        g.hud.setBoss(BOSS_NAME, this.bossHp);

        // Leaving the bowl entirely breaks the summons — the covenant can only
        // be answered on open ground. Generous radius: this is an anti-cheese
        // wall, not a fence the fight should ever touch.
        const ch = g.ctx.controller;
        if (Math.hypot(ch.position.x - ALTAR.x, ch.position.z - ALTAR.z) > 260) {
            worm.dismiss();
            this.stage = ST_CARRY;
            g.hud.toast("it will not follow",
                "the answer is owed on open ground", 3600);
            return;
        }

        this._checkBossDown();
    }

    _checkBossDown() {
        if (this.bossHp > 0) return;
        const g = this.g;
        this.stage = ST_DONE;
        g.worm.dismiss();
        g.hud.setBoss(null);

        g.hud.death("THE COVENANT IS BROKEN", 4600);
        setTimeout(() => {
            g.hud.discover("THE STORM EXHALES",
                "the tribe's water returns to the sand \u00b7 the desert is yours");
        }, 4900);
        g.spice += 500;
        g.hud.setSpice(g.spice);
        g.applyCalmWorld();
        g.saveStory();
    }
}
