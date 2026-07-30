/**
 * Game HUD — Elden-Ring-style layout, desert palette.
 *
 *   top-left        layered status bars: HP (red), stamina (green),
 *                   wormsign (amber) — thin, long, stacked, with a bronze
 *                   hairline frame.
 *   left, mid       the skill-name plate ("Water Lash") that fades in when a
 *                   spell is cast.
 *   bottom-centre   the boss bar. Appears only while a worm is on the surface:
 *                   its name over a long thin bar that FILLS as the worm
 *                   closes distance.
 *   bottom-right    the spice counter, framed like a rune purse.
 *   centre          the death card ("SWALLOWED BY THE SAND"), full-width
 *                   letterboxed text.
 *
 * Plain DOM, injected once, mutated by class toggles and text writes. The game
 * pushes state in; nothing here reads game state. All colours lean on the
 * palette variables `index.html` declares.
 */

const CSS = `
#hud {
    position: fixed;
    inset: 0;
    z-index: 40;
    pointer-events: none;
    font-family: ui-serif, "Iowan Old Style", "Palatino", Georgia, serif;
    color: var(--frost);
}

/* ---- status bars, top-left --------------------------------------------- */
/* Layered soulslike bars: a dark recessed channel inside a double bronze
   frame, a diamond finial capping the left end, a glass highlight across the
   top of the fill, and a pale damage-ghost that lags the HP. Length encodes
   importance: HP longest, stamina shorter, wormsign shortest. */
#hud-bars {
    position: absolute;
    top: 28px;
    left: 34px;
    width: min(380px, 42vw);
    filter: drop-shadow(0 2px 6px rgba(0,0,0,0.55));
}
.hbar {
    position: relative;
    height: 12px;
    margin-bottom: 9px;
    background:
        linear-gradient(180deg, rgba(4,2,2,0.92), rgba(18,11,8,0.88));
    border: 1px solid rgba(214, 178, 122, 0.75);
    box-shadow:
        0 0 0 1px rgba(0,0,0,0.85),
        0 0 0 2px rgba(120, 92, 55, 0.35),
        inset 0 2px 3px rgba(0,0,0,0.9),
        inset 0 -1px 1px rgba(214,178,122,0.12);
    border-radius: 1px;
}
/* the diamond finial on the left end */
.hbar::before {
    content: "";
    position: absolute;
    left: -7px;
    top: 50%;
    width: 9px;
    height: 9px;
    transform: translateY(-50%) rotate(45deg);
    background: linear-gradient(135deg, #e8cf9a 0%, #a97f43 55%, #6f4d24 100%);
    border: 1px solid rgba(0,0,0,0.8);
    box-shadow: 0 0 4px rgba(232, 163, 79, 0.4);
}
/* glass highlight along the top of every fill */
.hbar::after {
    content: "";
    position: absolute;
    inset: 2px 2px auto 2px;
    height: 3px;
    background: linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0));
    pointer-events: none;
    z-index: 2;
}
.hbar .fill {
    position: absolute;
    inset: 2px auto 2px 2px;
    width: 100%;
    transition: width 160ms ease-out;
    z-index: 1;
}
.hbar.hp .fill {
    background: linear-gradient(180deg,
        #e06a55 0%, #c03a2e 34%, #8e2620 68%, #611512 100%);
    box-shadow: 0 0 8px rgba(200, 68, 58, 0.35);
}
.hbar.st { width: 84%; }
.hbar.st .fill {
    background: linear-gradient(180deg,
        #7cc47e 0%, #4d9a54 34%, #37753d 68%, #234f2a 100%);
    box-shadow: 0 0 8px rgba(88, 163, 92, 0.30);
}
.hbar.ws { height: 9px; width: 58%; }
.hbar.ws .fill {
    background: linear-gradient(180deg,
        #f2c377 0%, #d68f3c 40%, #a3622a 72%, #7c4718 100%);
    box-shadow: 0 0 8px rgba(232, 163, 79, 0.35);
}
/* damage ghost: a pale strip that lags the HP fill, the classic soulslike read */
.hbar.hp .ghost {
    position: absolute;
    inset: 2px auto 2px 2px;
    width: 100%;
    background: rgba(240, 205, 150, 0.6);
    transition: width 900ms ease 250ms;
}

/* ---- skill name plate, mid-left ---------------------------------------- */
#hud-skill {
    position: absolute;
    left: 28px;
    top: 55%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 16px 7px 12px;
    background: linear-gradient(90deg, rgba(10,6,5,0.78), rgba(10,6,5,0.0));
    border-left: 2px solid rgba(200, 165, 110, 0.7);
    font-size: 15px;
    letter-spacing: 0.10em;
    opacity: 0;
    transition: opacity 350ms ease;
    text-shadow: 0 1px 8px rgba(0,0,0,0.9);
}
#hud-skill.show { opacity: 1; }
#hud-skill .glyph { color: var(--accent); font-size: 17px; }

/* ---- boss bar, bottom-centre ------------------------------------------- */
#hud-boss {
    position: absolute;
    left: 50%;
    bottom: 92px;
    transform: translateX(-50%);
    width: min(720px, 72vw);
    text-align: left;
    opacity: 0;
    transition: opacity 500ms ease;
}
#hud-boss.show { opacity: 1; }
#hud-boss .name {
    font-size: 17px;
    letter-spacing: 0.14em;
    margin: 0 0 4px 2px;
    text-shadow: 0 2px 10px rgba(0,0,0,0.95);
}
#hud-boss .bar {
    position: relative;
    height: 8px;
    background: rgba(10, 6, 5, 0.75);
    border: 1px solid rgba(200, 165, 110, 0.5);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.65), inset 0 1px 2px rgba(0,0,0,0.85);
}
#hud-boss .fill {
    position: absolute;
    inset: 1px auto 1px 1px;
    width: 0%;
    background: linear-gradient(180deg, #d8b25f 0%, #a3702c 55%, #7c4f1c 100%);
    transition: width 140ms linear;
}

/* ---- spice counter, bottom-right --------------------------------------- */
#hud-spice {
    position: absolute;
    right: 26px;
    bottom: 24px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    background: rgba(10, 6, 5, 0.68);
    border: 1px solid rgba(200, 165, 110, 0.5);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.6);
    font-variant-numeric: tabular-nums;
}
#hud-spice .glyph { color: var(--accent); font-size: 15px; }
#hud-spice .value {
    font-size: 18px;
    letter-spacing: 0.06em;
    min-width: 3ch;
    text-align: right;
    transition: transform 140ms ease;
}
#hud-spice .value.pop { transform: scale(1.25); }

/* ---- toasts (top-centre, small) ---------------------------------------- */
#hud-toast {
    position: absolute;
    left: 50%;
    top: 15%;
    transform: translateX(-50%);
    font-size: 15px;
    letter-spacing: 0.30em;
    text-indent: 0.30em;
    text-transform: uppercase;
    text-align: center;
    text-shadow: 0 2px 14px rgba(0, 0, 0, 0.9);
    opacity: 0;
    transition: opacity 450ms ease;
    white-space: nowrap;
}
#hud-toast.show { opacity: 1; }
#hud-toast .sub {
    display: block;
    margin-top: 0.7em;
    font-size: 10px;
    letter-spacing: 0.22em;
    color: var(--frost-dim);
}

/* ---- death card --------------------------------------------------------- */
#hud-death {
    position: absolute;
    inset: 38% 0 auto 0;
    padding: 28px 0;
    background: linear-gradient(180deg,
        rgba(0,0,0,0) 0%, rgba(8,4,3,0.82) 18%,
        rgba(8,4,3,0.82) 82%, rgba(0,0,0,0) 100%);
    text-align: center;
    font-size: clamp(26px, 4.4vw, 52px);
    letter-spacing: 0.34em;
    text-indent: 0.34em;
    color: #b8452f;
    text-shadow: 0 0 26px rgba(184, 69, 47, 0.55);
    opacity: 0;
    transition: opacity 900ms ease;
}
#hud-death.show { opacity: 1; }
`;

export class Hud {
    constructor() {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        const root = document.createElement("div");
        root.id = "hud";
        root.innerHTML = `
            <div id="hud-bars">
                <div class="hbar hp"><div class="ghost"></div><div class="fill"></div></div>
                <div class="hbar st"><div class="fill"></div></div>
                <div class="hbar ws"><div class="fill"></div></div>
            </div>
            <div id="hud-skill"><span class="glyph">\u25c8</span><span id="hud-skill-name"></span></div>
            <div id="hud-boss">
                <div class="name" id="hud-boss-name">SHAI-HULUD</div>
                <div class="bar"><div class="fill" id="hud-boss-fill"></div></div>
            </div>
            <div id="hud-spice">
                <span class="glyph">\u2726</span>
                <span class="value" id="hud-spice-value">0</span>
            </div>
            <div id="hud-toast"></div>
            <div id="hud-death"></div>
        `;
        document.body.appendChild(root);

        this._hpFill = root.querySelector(".hbar.hp .fill");
        this._hpGhost = root.querySelector(".hbar.hp .ghost");
        this._stFill = root.querySelector(".hbar.st .fill");
        this._wsFill = root.querySelector(".hbar.ws .fill");
        this._boss = document.getElementById("hud-boss");
        this._bossName = document.getElementById("hud-boss-name");
        this._bossFill = document.getElementById("hud-boss-fill");
        this._spiceEl = document.getElementById("hud-spice-value");
        this._skillEl = document.getElementById("hud-skill");
        this._skillName = document.getElementById("hud-skill-name");
        this._toastEl = document.getElementById("hud-toast");
        this._deathEl = document.getElementById("hud-death");

        this._toastTimer = 0;
        this._skillTimer = 0;
        this._lastSpice = -1;
        this._lastHp = -1;
        this._lastSt = -1;
        this._lastWs = -1;
    }

    /** @param {number} v 0..1 */
    setHp(v) {
        const pct = Math.round(Math.min(1, Math.max(0, v)) * 100);
        if (pct === this._lastHp) return;
        this._lastHp = pct;
        this._hpFill.style.width = pct + "%";
        // The ghost strip follows late; its CSS transition supplies the lag.
        this._hpGhost.style.width = pct + "%";
    }

    /** @param {number} v 0..1 */
    setStamina(v) {
        const pct = Math.round(Math.min(1, Math.max(0, v)) * 100);
        if (pct === this._lastSt) return;
        this._lastSt = pct;
        this._stFill.style.width = pct + "%";
    }

    /** @param {number} v 0..1 wormsign meter */
    setNoise(v) {
        const pct = Math.round(Math.min(1, Math.max(0, v)) * 100);
        if (pct === this._lastWs) return;
        this._lastWs = pct;
        this._wsFill.style.width = pct + "%";
    }

    /**
     * Boss bar. Pass null to hide.
     * @param {string|null} name
     * @param {number} [fill] 0..1 — proximity, filling as the worm closes
     */
    setBoss(name, fill) {
        if (!name) {
            this._boss.classList.remove("show");
            return;
        }
        this._bossName.textContent = name;
        this._bossFill.style.width =
            (Math.min(1, Math.max(0, fill || 0)) * 100).toFixed(1) + "%";
        this._boss.classList.add("show");
    }

    /** @param {number} n */
    setSpice(n) {
        if (n === this._lastSpice) return;
        this._lastSpice = n;
        this._spiceEl.textContent = String(n);
        this._spiceEl.classList.add("pop");
        setTimeout(() => this._spiceEl.classList.remove("pop"), 160);
    }

    /** Skill-name plate, Elden-style, mid-left. */
    skill(name) {
        this._skillName.textContent = name;
        this._skillEl.classList.add("show");
        clearTimeout(this._skillTimer);
        this._skillTimer = setTimeout(
            () => this._skillEl.classList.remove("show"), 1900
        );
    }

    toast(text, sub, ms) {
        this._toastEl.innerHTML =
            text + (sub ? `<span class="sub">${sub}</span>` : "");
        this._toastEl.classList.add("show");
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(
            () => this._toastEl.classList.remove("show"),
            ms || 2600
        );
    }

    /** The big letterboxed death card. */
    death(text, ms) {
        this._deathEl.textContent = text;
        this._deathEl.classList.add("show");
        setTimeout(() => this._deathEl.classList.remove("show"), ms || 3200);
    }
}
