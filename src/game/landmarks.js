/**
 * The map's named places.
 *
 * This table is the CPU mirror of `shaders/lib/landform.wgsl`. The shader
 * decides what the ground *is*; this decides what it is *called*, which of it
 * the player has found, and which way to point them. The coordinates in the two
 * files must agree — there is no way to read a name out of a height texture, so
 * a landmark moved in one place and not the other silently announces the wrong
 * thing at the wrong dune.
 *
 * Two jobs:
 *
 *   discovery   the first time the player comes within a landmark's radius, it
 *               is announced and remembered. That is the entire progression
 *               system for exploration, and it is enough of one: a name is what
 *               turns a rock into a destination.
 *   compass     a heading strip with a pip per *discovered* landmark, plus the
 *               nearest undiscovered one shown as an unnamed marker. Undiscovered
 *               places are visible as a direction but not as a name, so the map
 *               pulls without giving itself away.
 *
 * Nothing here owns geometry or state the engine can see. `update()` takes the
 * player position and facing and returns the compass payload; game.js pushes
 * that at the HUD.
 */

// -----------------------------------------------------------------------------
//  The spawn slot
//
//  Mirrors SLOT_HALF_WIDTH / the slot's endpoints in landform.wgsl. The slot is
//  the one canyon authored with its meander switched off, precisely so these
//  three numbers can describe it exactly.
// -----------------------------------------------------------------------------

export const SLOT_HALF_WIDTH = 7.0;
export const SLOT_START_Z = -215;
export const SLOT_MOUTH_Z = 0;
/** Where the player wakes, deep inside the Great Rampart. */
export const SPAWN_Z = -178;
/**
 * Half-width the player is actually clamped to.
 *
 * Inside the floor mask, not on its edge: the bake reconstructs bicubically at
 * 1 m spacing on the CPU mirror, so the last metre or so before the wall reads
 * as already climbing. Clamping short of it keeps the feet on floor the height
 * lookup agrees is floor.
 */
export const SLOT_CLAMP = SLOT_HALF_WIDTH * 0.7 - 1.6;

// -----------------------------------------------------------------------------
//  The register
// -----------------------------------------------------------------------------

/**
 * @typedef {{
 *   id: string, name: string, sub: string,
 *   x: number, z: number, r: number,
 *   compass: boolean,
 * }} Landmark
 *
 * `r` is the discovery radius. It is generous on purpose — a landmark you have
 * to stand on top of to name is one you walk past.
 * `compass` false keeps a place off the heading strip: the slot itself, and the
 * two rim passes, which are routes rather than destinations.
 */

/** @type {Landmark[]} */
export const LANDMARKS = [
    // ---- the opening ------------------------------------------------------
    {
        id: "slot", name: "THE SLOT", sub: "cut through the great rampart",
        x: 0, z: -95, r: 40, compass: false,
    },
    {
        id: "rampart", name: "THE GREAT RAMPART", sub: "the wall at your back",
        x: 0, z: -140, r: 165, compass: true,
    },

    // ---- close in ---------------------------------------------------------
    {
        id: "thumb", name: "THE THUMB", sub: "a finger of rock \u00b7 visible from the mouth",
        x: 175, z: 135, r: 70, compass: true,
    },

    // ---- the canyon roads -------------------------------------------------
    {
        id: "bone", name: "BONE CANYON", sub: "the east road \u00b7 runs to the spice bowl",
        x: 195, z: 15, r: 55, compass: true,
    },
    {
        id: "serpent", name: "THE SERPENT", sub: "the long canyon \u00b7 north-west",
        x: -175, z: 200, r: 60, compass: true,
    },
    {
        id: "cut", name: "DEAD MAN'S CUT", sub: "narrow the whole way",
        x: -225, z: -115, r: 50, compass: true,
    },
    {
        id: "fork", name: "THE FORK", sub: "the climb to table rock",
        x: 225, z: 160, r: 45, compass: false,
    },

    // ---- the far places ---------------------------------------------------
    {
        id: "tabr", name: "SIETCH TABR", sub: "shelter in the mesa \u00b7 long abandoned",
        x: -395, z: -195, r: 135, compass: true,
    },
    {
        id: "table", name: "TABLE ROCK", sub: "flat as a floor \u00b7 nothing grows",
        x: 320, z: 305, r: 105, compass: true,
    },
    {
        id: "sisters", name: "THE SISTERS", sub: "two summits \u00b7 take your bearing from them",
        x: -470, z: 390, r: 175, compass: true,
    },
    {
        id: "maw", name: "THE MAW", sub: "a blow that moved rock",
        x: -520, z: 55, r: 155, compass: true,
    },
    {
        id: "bowl", name: "THE SPICE BOWL", sub: "richest ground \u00b7 no cover at all",
        x: 465, z: -300, r: 220, compass: true,
    },
    {
        id: "boneyard", name: "THE BONEYARD", sub: "broken stone \u00b7 the worm cannot run here",
        x: -215, z: -410, r: 110, compass: true,
    },
    {
        id: "shield", name: "THE SHIELD WALL", sub: "the rim \u00b7 there is no way over",
        x: 400, z: 470, r: 190, compass: true,
    },

    // ---- the ways out -----------------------------------------------------
    {
        id: "windgap", name: "WIND GAP", sub: "the north pass",
        x: 180, z: 548, r: 90, compass: false,
    },
    {
        id: "stair", name: "THE EASTERN STAIR", sub: "the east pass",
        x: 580, z: 278, r: 85, compass: false,
    },
];

/** How far out a discovered landmark keeps its pip on the strip. */
const COMPASS_RANGE = 900;

export class Landmarks {
    constructor() {
        /** @type {Set<string>} */
        this.found = new Set();
        /** Scratch, refilled each frame. Never reallocated. One extra slot
         *  carries the transient event mark (a spice blow). */
        this._marks = [];
        for (let i = 0; i < LANDMARKS.length + 1; i++) {
            this._marks.push({ bearing: 0, dist: 0, label: "", known: false });
        }
        /** @type {{x:number, z:number}|null} transient compass mark */
        this.event = null;
        this._count = 0;
        /** Nearest landmark of any kind, for the header line. */
        this.nearest = null;
        this.nearestDist = Infinity;
    }

    /** How many of the register the player has stood in. */
    get discovered() {
        return this.found.size;
    }

    get total() {
        return LANDMARKS.length;
    }

    /**
     * @param {{x: number, z: number}} pos
     * @param {number} facing radians, the character's heading
     * @param {(l: Landmark) => void} onDiscover
     * @returns {{heading: number, marks: object[], count: number}}
     */
    update(pos, facing, onDiscover) {
        let n = 0;
        this.nearest = null;
        this.nearestDist = Infinity;

        for (let i = 0; i < LANDMARKS.length; i++) {
            const l = LANDMARKS[i];
            const dx = l.x - pos.x;
            const dz = l.z - pos.z;
            const d = Math.hypot(dx, dz);

            const known = this.found.has(l.id);
            if (!known && d < l.r) {
                this.found.add(l.id);
                onDiscover(l);
            }

            if (d < this.nearestDist && (known || d < l.r * 2.2)) {
                this.nearestDist = d;
                this.nearest = l;
            }

            if (!l.compass) continue;
            // Bearing measured the same way the figure measures facing: atan2 of
            // (x, z), so a mark dead ahead comes out at the same angle the
            // character is turned to.
            const bearing = Math.atan2(dx, dz);
            const nowKnown = this.found.has(l.id);
            if (!nowKnown && d > l.r * 3.0) continue;
            if (d > COMPASS_RANGE) continue;

            const m = this._marks[n++];
            m.bearing = bearing;
            m.dist = d;
            m.known = nowKnown;
            m.label = nowKnown ? l.name : "";
        }

        // The event mark, if one is live. Always "known" — a blow announces
        // itself; there is nothing to discover about where it is.
        if (this.event) {
            const m = this._marks[n++];
            m.bearing = Math.atan2(this.event.x - pos.x, this.event.z - pos.z);
            m.dist = Math.hypot(this.event.x - pos.x, this.event.z - pos.z);
            m.known = true;
            m.label = "";
        }

        this._count = n;
        return { heading: facing, marks: this._marks, count: n };
    }
}
