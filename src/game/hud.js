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
#hud-bars {
    position: absolute;
    top: 26px;
    left: 28px;
    width: min(360px, 40vw);
}
.hbar {
    position: relative;
    height: 10px;
    margin-bottom: 7px;
    background: rgba(10, 6, 5, 0.72);
    border: 1px solid rgba(200, 165, 110, 0.55);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.6), inset 0 1px 2px rgba(0,0,0,0.8);
}
.hbar .fill {
    position: absolute;
    inset: 1px auto 1px 1px;
    width: 100%;
    transition: width 160ms ease-out;
}
.hbar.hp .fill {
    background: linear-gradient(180deg, #c8443a 0%, #8e2620 55%, #6e1a16 100%);
}
.hbar.st .fill {
    background: linear-gradient(180deg, #58a35c 0%, #37753d 55%, #285c2f 100%);
}
.hbar.ws { height: 7px; width: 72%; }
.hbar.ws .fill {
    background: linear-gradient(180deg, #e8a34f 0%, #b06a26 60%, #8a4d18 100%);
}
/* damage ghost: a pale strip that lags the HP fill, the classic soulslike read */
.hbar.hp .ghost {
    position: absolute;
    inset: 1px auto 1px 1px;
    width: 100%;
    background: rgba(240, 210, 160, 0.55);
    transition: width 900ms ease 250ms;
}
.hbar.hp .fill { z-index: 1; }

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
