/**
 * On-screen controls — Elden-Ring-style quick slots plus dual virtual sticks.
 *
 * The slots live where a soulslike keeps them: a cluster in the bottom-left,
 * square frames with a bronze hairline, the key number in the corner. Five
 * spell slots, a wide LASH slot (the attack — a held water whip) and a SURF
 * toggle. They are clickable with a mouse and tappable on touch; either way
 * they write into the same shared `input` struct the keyboard does, so nothing
 * downstream can tell a thumb from a key.
 *
 * The sticks are floating: touch anywhere on the left half and a move stick
 * appears under the finger; the right half spawns a look stick. Desktop players
 * never see them — mouse-look through pointer lock still works exactly as
 * before, and the slots respond to plain clicks.
 *
 * Visibility: the slot cluster is always on (it is the spell bar). The sticks
 * only ever appear under an active touch.
 *
 * No per-frame allocation.
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
    font-family: ui-serif, "Iowan Old Style", "Palatino", Georgia, serif;
}

/* ---- floating sticks (touch only) --------------------------------------- */
.stick {
    position: absolute;
    width: 118px;
    height: 118px;
    margin: -59px 0 0 -59px;
    border-radius: 50%;
    border: 1.5px solid rgba(200, 165, 110, 0.4);
    background: rgba(10, 6, 5, 0.30);
    display: none;
}
.stick .nub {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 50px;
    height: 50px;
    margin: -25px 0 0 -25px;
    border-radius: 50%;
    background: rgba(232, 163, 79, 0.5);
    box-shadow: 0 0 14px rgba(232, 163, 79, 0.45);
}
.stick.show { display: block; }

/* ---- slot cluster, bottom-left ------------------------------------------ */
#slots {
    position: absolute;
    left: 26px;
    bottom: 24px;
    pointer-events: auto;
    display: grid;
    grid-template-columns: repeat(5, 52px);
    grid-auto-rows: 52px;
    gap: 8px;
}
.slot {
    position: relative;
    display: grid;
    place-items: center;
    background:
        radial-gradient(120% 120% at 50% 20%, rgba(46, 29, 20, 0.85), rgba(10, 6, 5, 0.85));
    border: 1px solid rgba(200, 165, 110, 0.55);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.7), inset 0 1px 6px rgba(0,0,0,0.7);
    color: var(--frost);
    cursor: pointer;
    transition: transform 80ms ease, border-color 120ms ease, background 120ms ease;
}
.slot:active, .slot.held { transform: scale(0.92); border-color: var(--accent); }
.slot.on { border-color: var(--accent); box-shadow: 0 0 10px rgba(232,163,79,0.5), 0 0 0 1px rgba(0,0,0,0.7); }
.slot .k {
    position: absolute;
    top: 2px;
    left: 5px;
    font-size: 9px;
    color: var(--frost-dim);
}
.slot .g { font-size: 20px; color: var(--accent); line-height: 1; }
.slot .n {
    position: absolute;
    bottom: 3px;
    left: 0; right: 0;
    text-align: center;
    font-size: 8px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--frost-dim);
}
.slot.wide { grid-column: span 3; }
.slot.wide .g { font-size: 22px; }
.slot.wide .n { font-size: 10px; letter-spacing: 0.24em; }
.slot.lash { border-color: rgba(232, 140, 60, 0.65); }
.slot.lash .g { color: #ffc27a; }
.slot.lash.held { background: rgba(90, 50, 20, 0.7); }
`;

/** Max nub travel, px — full stick deflection. */
const STICK_R = 52;

/** Spell metadata: key → glyph, short label, plate name. */
const SPELLS = [
    { key: 1, g: "\u2312", n: "sweep",  plate: "Sand Sweep" },
    { key: 2, g: "\u224b", n: "ribbon", plate: "Sand Ribbon" },
    { key: 3, g: "\u2607", n: "burst",  plate: "Dune Burst" },
    { key: 4, g: "\u2b22", n: "spice",  plate: "Crystallise Spice" },
    { key: 5, g: "\u06de", n: "vortex", plate: "Sand Vortex" },
];

export class Controls {
    /**
     * @param {{
     *   spells: import("../spells/spellSystem.js").SpellSystem,
     *   onAttack: (held:boolean) => void,
     *   onCast?: (plateName:string) => void,
     * }} ctx
     */
    constructor(ctx) {
        this.spells = ctx.spells;
        this.onAttack = ctx.onAttack;
        this.onCast = ctx.onCast || (() => {});

        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        const root = document.createElement("div");
        root.id = "controls";
        const slotHtml = SPELLS.map(
            (s) => `<div class="slot" id="slot-s${s.key}">
                        <span class="k">${s.key}</span>
                        <span class="g">${s.g}</span>
                        <span class="n">${s.n}</span>
                    </div>`
        ).join("");
        root.innerHTML = `
            <div class="stick" id="stick-move"><div class="nub"></div></div>
            <div class="stick" id="stick-look"><div class="nub"></div></div>
            <div id="slots">
                ${slotHtml}
                <div class="slot wide lash" id="slot-lash">
                    <span class="g">\u2248</span><span class="n">sand lash</span>
                </div>
                <div class="slot wide" id="slot-surf" style="grid-column: span 2;">
                    <span class="g">\u224f</span><span class="n">surf</span>
                </div>
            </div>
        `;
        document.body.appendChild(root);
        this.root = root;

        this._moveEl = document.getElementById("stick-move");
        this._lookEl = document.getElementById("stick-look");
        this._moveNub = this._moveEl.firstElementChild;
        this._lookNub = this._lookEl.firstElementChild;

        this._movePtr = null;
        this._lookPtr = null;
        this._surfOn = false;

        this._wireSticks();
        this._wireSlots();
    }

    // ---------------------------------------------------------------- sticks
    // Touch-only by design: a mouse drag on open screen would fight the
    // pointer-lock look, and desktop already has WASD.

    _wireSticks() {
        window.addEventListener("pointerdown", (e) => {
            if (e.pointerType !== "touch") return;
            if (e.target.closest(".slot")) return;
            input.touchActive = true;
            const left = e.clientX < window.innerWidth * 0.5;
            const rec = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
            if (left && !this._movePtr) {
                this._movePtr = rec;
                this._show(this._moveEl, e.clientX, e.clientY);
            } else if (!left && !this._lookPtr) {
                this._lookPtr = rec;
                this._show(this._lookEl, e.clientX, e.clientY);
            }
        });
        window.addEventListener("pointermove", (e) => {
            if (this._movePtr && e.pointerId === this._movePtr.id) {
                this._drive(this._movePtr, this._moveNub, e, true);
            } else if (this._lookPtr && e.pointerId === this._lookPtr.id) {
                this._drive(this._lookPtr, this._lookNub, e, false);
            }
        });
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

    _drive(rec, nub, e, isMove) {
        const dx = e.clientX - rec.ox;
        const dy = e.clientY - rec.oy;
        const len = Math.hypot(dx, dy);
        const clamped = Math.min(len, STICK_R);
        const nx = len > 0 ? dx / len : 0;
        const ny = len > 0 ? dy / len : 0;
        nub.style.transform =
            `translate(calc(-50% + ${nx * clamped}px), calc(-50% + ${ny * clamped}px))`;
        const vx = nx * (clamped / STICK_R);
        const vy = ny * (clamped / STICK_R);
        if (isMove) {
            input.touchMoveX = vx;
            input.touchMoveZ = -vy;
        } else {
            input.touchLookX = vx * 0.055;
            input.touchLookY = vy * 0.045;
        }
    }

    // ---------------------------------------------------------------- slots

    _wireSlots() {
        // Spell taps: 1,3,4,5 fire; 2 (ribbon) is a hold.
        for (const s of SPELLS) {
            const el = document.getElementById("slot-s" + s.key);
            if (s.key === 2) {
                this._hold(el,
                    () => { input.spellHeld2 = true; this.onCast(s.plate); },
                    () => { input.spellHeld2 = false; });
            } else {
                el.addEventListener("pointerdown", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    input.spellPressed = s.key;
                    this.onCast(s.plate);
                });
            }
        }

        // Water Lash — the attack, a hold.
        this._hold(document.getElementById("slot-lash"),
            () => { this.onAttack(true); this.onCast("Sand Lash"); },
            () => this.onAttack(false));

        // Surf toggle.
        const surf = document.getElementById("slot-surf");
        surf.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.setSurf(!this._surfOn);
        });
    }

    /** Programmatic surf state — the game forces it off at zero stamina. */
    setSurf(on) {
        this._surfOn = !!on;
        document.getElementById("slot-surf").classList.toggle("on", this._surfOn);
        input.touchSurf = this._surfOn;
        input.touchActive = true;
    }

    get surfOn() {
        return this._surfOn;
    }

    _hold(el, onDown, onUp) {
        const d = (e) => {
            e.preventDefault();
            e.stopPropagation();
            el.classList.add("held");
            onDown();
        };
        const u = (e) => {
            if (e) { e.preventDefault(); e.stopPropagation(); }
            el.classList.remove("held");
            onUp();
        };
        el.addEventListener("pointerdown", d);
        el.addEventListener("pointerup", u);
        el.addEventListener("pointerleave", u);
        el.addEventListener("pointercancel", u);
    }
}
