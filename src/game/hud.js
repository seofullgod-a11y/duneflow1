/**
 * Game HUD — spice counter, wormsign meter, message toasts.
 *
 * Plain DOM, injected once and mutated by class toggles and text writes only.
 * Nothing here allocates per frame and nothing here reads game state: the game
 * pushes into it. Styling leans on the same palette variables `index.html`
 * declares, so the HUD and the boot screen can never drift apart.
 */

const CSS = `
#hud {
    position: fixed;
    inset: 0;
    z-index: 40;
    pointer-events: none;
    font-family: ui-sans-serif, "Inter", "Segoe UI", system-ui, sans-serif;
    color: var(--frost);
}

/* ---- spice counter ------------------------------------------------------ */
#hud-spice {
    position: absolute;
    top: 26px;
    right: 30px;
    text-align: right;
    text-shadow: 0 1px 10px rgba(0, 0, 0, 0.75);
}
#hud-spice .label {
    font-size: 10px;
    letter-spacing: 0.30em;
    text-transform: uppercase;
    color: var(--frost-dim);
}
#hud-spice .value {
    font-size: 26px;
    font-weight: 200;
    letter-spacing: 0.08em;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
    transition: transform 140ms ease;
}
#hud-spice .value.pop { transform: scale(1.22); }

/* ---- wormsign meter ----------------------------------------------------- */
#hud-worm {
    position: absolute;
    left: 50%;
    bottom: 26px;
    transform: translateX(-50%);
    width: min(340px, 52vw);
    text-align: center;
}
#hud-worm .label {
    font-size: 9px;
    letter-spacing: 0.34em;
    text-transform: uppercase;
    color: var(--frost-dim);
    margin-bottom: 6px;
    text-shadow: 0 1px 10px rgba(0, 0, 0, 0.75);
    transition: color 300ms ease;
}
#hud-worm.hunting .label { color: #e86a3f; }
#hud-worm .bar {
    position: relative;
    height: 2px;
    background: rgba(242, 228, 208, 0.14);
    overflow: hidden;
}
#hud-worm .fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: 0%;
    background: linear-gradient(90deg, var(--accent), #e86a3f);
    box-shadow: 0 0 10px rgba(232, 106, 63, 0.6);
    transition: width 120ms linear;
}
#hud-worm.hunting .fill { animation: hud-pulse 0.9s ease-in-out infinite; }
@keyframes hud-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.45; }
}

/* ---- toasts ------------------------------------------------------------- */
#hud-toast {
    position: absolute;
    left: 50%;
    top: 24%;
    transform: translateX(-50%);
    font-size: clamp(15px, 2.2vw, 24px);
    font-weight: 200;
    letter-spacing: 0.42em;
    text-indent: 0.42em;
    text-transform: uppercase;
    text-align: center;
    color: var(--frost);
    text-shadow: 0 2px 18px rgba(0, 0, 0, 0.85);
    opacity: 0;
    transition: opacity 500ms ease;
    white-space: nowrap;
}
#hud-toast.show { opacity: 1; }
#hud-toast .sub {
    display: block;
    margin-top: 0.8em;
    font-size: 10px;
    letter-spacing: 0.26em;
    color: var(--frost-dim);
}
`;

export class Hud {
    constructor() {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        const root = document.createElement("div");
        root.id = "hud";
        root.innerHTML = `
            <div id="hud-spice">
                <div class="label">spice</div>
                <div class="value" id="hud-spice-value">0</div>
            </div>
            <div id="hud-worm">
                <div class="label" id="hud-worm-label">wormsign</div>
                <div class="bar"><div class="fill" id="hud-worm-fill"></div></div>
            </div>
            <div id="hud-toast"></div>
        `;
        document.body.appendChild(root);

        this._spiceEl = document.getElementById("hud-spice-value");
        this._wormEl = document.getElementById("hud-worm");
        this._wormLabel = document.getElementById("hud-worm-label");
        this._wormFill = document.getElementById("hud-worm-fill");
        this._toastEl = document.getElementById("hud-toast");

        this._toastTimer = 0;
        this._lastSpice = -1;
        this._lastNoisePct = -1;
    }

    /** @param {number} n */
    setSpice(n) {
        if (n === this._lastSpice) return;
        this._lastSpice = n;
        this._spiceEl.textContent = String(n);
        this._spiceEl.classList.add("pop");
        setTimeout(() => this._spiceEl.classList.remove("pop"), 160);
    }

    /**
     * @param {number} noise 0..1
     * @param {boolean} hunting a worm is currently on the surface
     */
    setNoise(noise, hunting) {
        const pct = Math.round(Math.min(1, Math.max(0, noise)) * 100);
        if (pct !== this._lastNoisePct) {
            this._lastNoisePct = pct;
            this._wormFill.style.width = pct + "%";
        }
        this._wormEl.classList.toggle("hunting", !!hunting);
        this._wormLabel.textContent = hunting ? "shai-hulud approaches" : "wormsign";
    }

    /**
     * @param {string} text headline
     * @param {string} [sub] smaller second line
     * @param {number} [ms] visible duration
     */
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
}
