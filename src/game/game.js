/**
 * The game layer.
 *
 * Everything gameplay lives under `src/game/` and touches the engine only
 * through the same public seams every existing system uses: `deform.brush()`,
 * `spray.emit()`, `rig.addTrauma()`, `terrain.heightAt()` and the character
 * controller's position. Nothing in `src/game/` owns a pipeline, a mesh or a
 * shader — which is what keeps the engine and the game separable while the
 * story is still being found.
 *
 * One `update(dt)` per frame, called from `main.js` right after the contact
 * system and before the camera rig — so if the worm throws the player, the
 * camera follows the new position in the same frame instead of one late.
 *
 * State is deliberately flat and inspectable from the console via
 * `SNOWFLOW.game` — the same convention the rest of the demo follows.
 */

import { Hud } from "./hud.js";
import { SpiceField } from "./spice.js";
import { WormSystem } from "./worm.js";

export class Game {
    /**
     * @param {{
     *   terrain: import("../terrain/terrain.js").Terrain,
     *   controller: import("../character/controller.js").CharacterController,
     *   rig: import("../core/camera.js").CameraRig,
     *   spray: import("../vfx/particles.js").SprayField,
     *   post: import("../post/postChain.js").PostChain,
     * }} ctx
     */
    constructor(ctx) {
        this.ctx = ctx;

        /** Spice carried. The score, for now; a resource, once there is a story. */
        this.spice = 0;

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

        this._intro = 4.5;
        this.hud.setSpice(0);
    }

    _onWormEvent(type) {
        if (type === "surface") {
            this.hud.toast("wormsign", "stop moving \u00b7 walk without rhythm");
        } else if (type === "lost") {
            this.hud.toast("the worm passes", "it has lost your trail");
        } else if (type === "attack") {
            const lost = Math.ceil(this.spice / 2);
            this.spice -= lost;
            this.hud.setSpice(this.spice);
            this.hud.toast(
                "shai-hulud",
                lost > 0 ? "you were thrown clear \u00b7 " + lost + " spice lost"
                         : "you were thrown clear",
                3600
            );
            // The throw is a teleport as far as the temporal history is
            // concerned; reprojecting across it smears one long streak over
            // the whole frame.
            this.ctx.post.resetHistory();
        }
    }

    /** @param {number} dt seconds */
    update(dt) {
        const ch = this.ctx.controller;

        if (this._intro > 0) {
            this._intro -= dt;
            if (this._intro <= 0) {
                this.hud.toast(
                    "harvest the spice",
                    "the glittering blows \u00b7 speed draws the worm",
                    4200
                );
            }
        }

        this.spiceField.update(dt, ch.position);
        this.worm.update(dt);
        this.hud.setNoise(this.worm.noise, this.worm.hunting);
    }
}
