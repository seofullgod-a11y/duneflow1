/**
 * On-screen controls — dual virtual sticks, five spell buttons, an attack
 * button, and a sprint/surf toggle. Touch and mouse both drive them.
 *
 * The controls are a thin input surface: they never touch game state, they only
 * write into the shared `input` struct (src/core/input.js) exactly the way the
 * keyboard and mouse do, so the controller, camera and spell dispatch downstream
 * cannot tell a thumb from a key. Two things do go straight to the game because
 * they have no keyboard-shaped field to borrow — a spell tap (routed through
 * `input.spellPressed`, which the dispatch already reads) and the attack, which
 * calls the callback the game hands in.
 *
 * ## Left stick — move (360°)
 * A floating stick: it appears wherever the left half of the screen is first
 * touched and tracks from there, so there is no fixed pad to reach for. Writes
 * `input.touchMoveX/Z`, already inside the unit disc.
 *
 * ## Right stick — look
 * Drives the camera the way the mouse does, as a per-frame delta into
 * `input.touchLookX/Y`. Also a floating stick on the right half.
 *
 * ## Buttons
 * Fixed pills over the sticks' resting area but above them in z, so a button
 * press never starts a stick. Spell 1-5, a held Water-Lash attack, and a
 * sprint/surf toggle.
 *
 * ## Auto-hide on desktop
 * The whole layer starts hidden and reveals itself the first time a touch is
 * seen, OR when the player clicks the little controller icon. On a mouse-only
 * desktop the icon is there if wanted and out of the way if not — the keyboard
 * still works regardless.
 *
 * No per-frame allocation: the sticks reuse two pointer records and the buttons
 * are wired once.
 */

import { input } from "../core/input.js";

const CSS = `
#controls {
    position: fixed;
    inset: 0;
    z-index: 45;
    pointer-events: none;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    font-family: ui-sans-serif, "Inter", "Segoe UI", system-ui, sans-serif;
    display: none;
}
#controls.on { display: block; }

/* ---- floating sticks ---------------------------------------------------- */
.stick {
    position: absolute;
    width: 118px;
    height: 118px;
    margin: -59px 0 0 -59px;
    border-radius: 50%;
    border: 1.5px solid rgba(242, 228, 208, 0.28);
    background: rgba(20, 12, 9, 0.28);
    box-shadow: 0 2px 20px rgba(0, 0, 0, 0.4);
    display: none;
}
.stick .nub {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 52px;
    height: 52px;
    margin: -26px 0 0 -26px;
    border-radius: 50%;
    background: rgba(232, 163, 79, 0.55);
    box-shadow: 0 0 14px rgba(232, 163, 79, 0.5);
}
.stick.show { display: block; }

/* ---- buttons ------------------------------------------------------------ */
.btn {
    position: absolute;
    pointer-events: auto;
    display: grid;
    place-items: center;
    border-radius: 50%;
    border: 1.5px solid rgba(242, 228, 208, 0.30);
    background: rgba(29, 18, 16, 0.55);
    color: var(--frost);
    font-weight: 300;
    text-align: center;
    line-height: 1.1;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    transition: transform 90ms ease, background 90ms ease;
}
.btn:active, .btn.held { transform: scale(0.9); background: rgba(232, 163, 79, 0.4); }
.btn .k { font-size: 9px; letter-spacing: 0.14em; opacity: 0.65; }
.btn .n { font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; }

/* spell cluster, bottom-right */
.spell { width: 54px; height: 54px; }
.attack {
    width: 84px; height: 84px;
    border-color: rgba(120, 190, 255, 0.55);
    background: rgba(30, 60, 90, 0.5);
}
.attack.held { background: rgba(120, 190, 255, 0.5); }
.sprint {
    width: 60px; height: 60px;
    left: 30px; bottom: 150px;
    border-color: rgba(232, 106, 63, 0.5);
}
.sprint.on { background: rgba(232, 106, 63, 0.5); }

/* desktop reveal toggle */
#controls-toggle {
    position: fixed;
    right: 18px;
    bottom: 78px;
    z-index: 46;
    pointer-events: auto;
    width: 40px; height: 40px;
    border-radius: 8px;
    border: 1px solid rgba(242, 228, 208, 0.22);
    background: rgba(29, 18, 16, 0.6);
    color: var(--frost-dim);
    font-size: 17px;
    display: grid; place-items: center;
    cursor: pointer;
    opacity: 0.5;
    transition: opacity 150ms ease;
}
#controls-toggle:hover { opacity: 1; }
`;

/** Half the stick radius, in px — the nub travels this far at full deflection. */
const STICK_R = 52;

export class Controls {
    /**
     * @param {{
     *   spells: import("../spells/spellSystem.js").SpellSystem,
     *   onAttack: (held:boolean) => void,
     * }} ctx
     */
    constructor(ctx) {
        this.spells = ctx.spells;
        this.onAttack = ctx.onAttack;

        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        const root = document.createElement("div");
        root.id = "controls";
        root.innerHTML = `
            <div class="stick" id="stick-move"><div class="nub"></div></div>
            <div class="stick" id="stick-look"><div class="nub"></div></div>

            <div class="btn attack"  id="btn-attack"><span class="n">lash</span></div>
            <div class="btn sprint"  id="btn-sprint"><span class="n">surf</span></div>

            <div class="btn spell" id="btn-s1"><span class="k">1</span><span class="n">swp</span></div>
            <div class="btn spell" id="btn-s2"><span class="k">2</span><span class="n">rbn</span></div>
            <div class="btn spell" id="btn-s3"><span class="k">3</span><span class="n">blm</span></div>
            <div class="btn spell" id="btn-s4"><span class="k">4</span><span class="n">cry</span></div>
            <div class="btn spell" id="btn-s5"><span class="k">5</span><span class="n">vtx</span></div>
        `;
        document.body.appendChild(root);
        this.root = root;

        const toggle = document.createElement("div");
        toggle.id = "controls-toggle";
        toggle.textContent = "\u2295"; // circled plus — "on-screen controls"
        toggle.title = "on-screen controls";
        document.body.appendChild(toggle);
        toggle.addEventListener("click", () => this.setVisible(!this._visible));

        this._visible = false;
        this._moveEl = document.getElementById("stick-move");
        this._lookEl = document.getElementById("stick-look");
        this._moveNub = this._moveEl.firstElementChild;
        this._lookNub = this._lookEl.firstElementChild;

        /** Active pointer for each stick: {id, ox, oy}. */
        this._movePtr = null;
        this._lookPtr = null;
        this._sprintOn = false;

        this._layout();
        window.addEventListener("resize", () => this._layout());

        this._wireSticks();
        this._wireButtons();
    }

    setVisible(v) {
        this._visible = !!v;
        this.root.classList.toggle("on", this._visible);
    }

    _layout() {
        // Buttons are positioned in CSS by side offsets that already adapt; the
        // spell cluster is arc-placed here so it scales with the short edge.
        const spells = ["s1", "s2", "s3", "s4", "s5"];
        const cx = window.innerWidth - 66;
        const cy = window.innerHeight - 210;
        const R = 92;
        for (let i = 0; i < spells.length; i++) {
            const el = document.getElementById("btn-" + spells[i]);
            // Fan across a quarter arc up-and-left of the attack button.
            const a = Math.PI * (0.62 + i * 0.16);
            el.style.left = (cx + Math.cos(a) * R - 27) + "px";
            el.style.top = (cy + Math.sin(a) * R - 27) + "px";
        }
        const atk = document.getElementById("btn-attack");
        atk.style.left = (window.innerWidth - 118) + "px";
        atk.style.bottom = "70px";
    }

    // ---------------------------------------------------------------- sticks

    _wireSticks() {
        // One pointer set drives both sticks; which one a pointer owns is
        // decided by the half of the screen it went down in.
        const down = (e) => {
            // A pointer that started on a button is not a stick; the button's
            // own handler stops propagation, so anything reaching here is stick.
            this.setVisibleOnce();
            const left = e.clientX < window.innerWidth * 0.5;
            const rec = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
            if (left && !this._movePtr) {
                this._movePtr = rec;
                this._show(this._moveEl, e.clientX, e.clientY);
            } else if (!left && !this._lookPtr) {
                this._lookPtr = rec;
                this._show(this._lookEl, e.clientX, e.clientY);
            }
        };
        const move = (e) => {
            if (this._movePtr && e.pointerId === this._movePtr.id) {
                this._drive(this._movePtr, this._moveNub, e, true);
            } else if (this._lookPtr && e.pointerId === this._lookPtr.id) {
                this._drive(this._lookPtr, this._lookNub, e, false);
            }
        };
        const up = (e) => {
            if (this._movePtr && e.pointerId === this._movePtr.id) {
                this._movePtr = null;
                this._hide(this._moveEl, this._moveNub);
                input.touchMoveX = 0;
                input.touchMoveZ = 0;
            } else if (this._lookPtr && e.pointerId === this._lookPtr.id) {
                this._lookPtr = null;
                this._hide(this._lookEl, this._lookNub);
            }
        };

        // Bound on the window so a stick keeps tracking outside its own circle,
        // but only acts once the controls are visible.
        window.addEventListener("pointerdown", (e) => {
            if (!this._visible) return;
            // Ignore presses that landed on a button (they set _onButton).
            if (e.target.closest(".btn") || e.target.closest("#controls-toggle")) return;
            down(e);
        });
        window.addEventListener("pointermove", (e) => {
            if (this._visible) move(e);
        });
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
    }

    _show(el, x, y) {
        el.style.left = x + "px";
        el.style.top = y + "px";
        el.classList.add("show");
    }
    _hide(el, nub) {
        el.classList.remove("show");
        nub.style.transform = "translate(-50%, -50%)";
    }

    /** Convert a pointer's offset from its origin into a stick value. */
    _drive(rec, nub, e, isMove) {
        let dx = e.clientX - rec.ox;
        let dy = e.clientY - rec.oy;
        const len = Math.hypot(dx, dy);
        const clamped = Math.min(len, STICK_R);
        const nx = len > 0 ? dx / len : 0;
        const ny = len > 0 ? dy / len : 0;
        nub.style.transform =
            `translate(calc(-50% + ${nx * clamped}px), calc(-50% + ${ny * clamped}px))`;

        const vx = nx * (clamped / STICK_R);
        const vy = ny * (clamped / STICK_R);
        if (isMove) {
            // Screen down = toward the camera = -Z in the controller's frame.
            input.touchMoveX = vx;
            input.touchMoveZ = -vy;
        } else {
            // Look: queue a per-frame delta, scaled to feel like the mouse.
            input.touchLookX = vx * 0.055;
            input.touchLookY = vy * 0.045;
        }
    }

    // -------------------------------------------------------------- buttons

    _wireButtons() {
        const hold = (id, onDown, onUp) => {
            const el = document.getElementById(id);
            const d = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.setVisibleOnce();
                el.classList.add("held");
                onDown();
            };
            const u = (e) => {
                e.preventDefault();
                e.stopPropagation();
                el.classList.remove("held");
                if (onUp) onUp();
            };
            el.addEventListener("pointerdown", d);
            el.addEventListener("pointerup", u);
            el.addEventListener("pointerleave", u);
            el.addEventListener("pointercancel", u);
        };

        // Spells 1,3,4,5 are taps → route through the dispatch's own field.
        for (const [id, n] of [["btn-s1", 1], ["btn-s3", 3], ["btn-s4", 4], ["btn-s5", 5]]) {
            const el = document.getElementById(id);
            el.addEventListener("pointerdown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.setVisibleOnce();
                input.spellPressed = n;
            });
        }
        // Ribbon (2) is a hold.
        hold("btn-s2",
            () => { input.spellHeld2 = true; },
            () => { input.spellHeld2 = false; });

        // Attack — Water Lash, a held cast handled by the game.
        hold("btn-attack",
            () => this.onAttack(true),
            () => this.onAttack(false));

        // Surf toggle: press to start sand-surfing, press again to stop. Surf
        // already carries its own speed, so it does not also need sprint.
        const sp = document.getElementById("btn-sprint");
        sp.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.setVisibleOnce();
            this._sprintOn = !this._sprintOn;
            sp.classList.toggle("on", this._sprintOn);
            input.touchSurf = this._sprintOn;
        });
    }

    /** First touch anywhere reveals the layer (desktop starts hidden). */
    setVisibleOnce() {
        if (!this._visible) this.setVisible(true);
        input.touchActive = true;
    }
}
