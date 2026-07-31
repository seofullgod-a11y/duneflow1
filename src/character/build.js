/**
 * Procedural character geometry.
 *
 * Nothing here is authored in a DCC tool. Every surface is a lofted tube, a
 * swept ring or a Bezier-blended shell evaluated from the bind-pose skeleton, so
 * the whole figure is a few hundred lines of tables and a smooth-normal pass.
 *
 * Three meshes come out, because three different vertex programs drive them:
 *
 *   body   linearly blend-skinned to the bones — head, cowl, torso, arms,
 *          trousers, boots, belt.
 *   cloth  driven from the simulated garment grids, sampled with Catmull-Rom in
 *          the vertex shader so a 24x14 solve renders as a smooth surface.
 *   fur    shell fur: the same rim ring emitted N times, each pushed further
 *          along its normal, alpha-tested into strands.
 *
 * Normals are never derived analytically. Everything is built as positions plus
 * indices and then run through one area-weighted smooth-normal pass, which is
 * both less code and immune to the sign errors that analytic normals on a swept
 * surface invite. Closed rings share their seam vertex rather than duplicating
 * it, so the seam is smooth too.
 *
 * Build time only — none of this runs after load, and it allocates freely.
 */

import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import {
    B_ROOT, B_SPINE, B_CHEST, B_NECK, B_HEAD, B_HOOD,
    B_UPPER_L, B_FORE_L, B_HAND_L, B_UPPER_R, B_FORE_R, B_HAND_R,
    B_THIGH_L, B_SHIN_L, B_FOOT_L, B_THIGH_R, B_SHIN_R, B_FOOT_R,
} from "./figure.js";

// ------------------------------------------------------------- material slots
export const M_ROBE = 0;     // deep indigo wool
export const M_MANTLE = 1;   // lighter blue-grey over-mantle
export const M_TUNIC = 2;    // pale cream under-layer
export const M_LEATHER = 3;  // belt and boots
export const M_SKIN = 4;     // face, deep in shade
export const M_TRIM = 5;     // pale blue banding
export const M_FUR = 6;      // cowl and cuff trim
export const M_HAIR = 7;     // the solid base cap under the hair shells

/** Segments around a limb. 14 is smooth at the distances this is seen from. */
const SEG = 14;

// -----------------------------------------------------------------------------

class Builder {
    constructor() {
        this.pos = [];
        this.nrm = [];
        this.uv = [];
        /** (matId, ao) on the body; (shellT, ao) on the fur. */
        this.aux = [];
        this.bi = [];       // bone indices, 4 per vertex
        this.bw = [];       // bone weights, 4 per vertex
        this.idx = [];
        /** Fur supplies its own normals; everything else has them derived. */
        this.explicitNormals = false;
    }

    /** @returns {number} the new vertex's index */
    vert(x, y, z, u, v, matId, ao, b0, w0, b1, w1) {
        this.pos.push(x, y, z);
        this.nrm.push(0, 0, 0);
        this.uv.push(u, v);
        this.aux.push(matId, ao);
        this.bi.push(b0, b1 || 0, 0, 0);
        this.bw.push(w0, w1 || 0, 0, 0);
        return this.pos.length / 3 - 1;
    }

    normal(vi, x, y, z) {
        this.nrm[vi * 3] = x;
        this.nrm[vi * 3 + 1] = y;
        this.nrm[vi * 3 + 2] = z;
    }

    tri(a, b, c) {
        this.idx.push(a, b, c);
    }

    quad(a, b, c, d) {
        // Both diagonals of every quad get used across the mesh, alternating is
        // not worth the bookkeeping on shapes this smooth.
        this.idx.push(a, b, c, a, c, d);
    }
}

/**
 * Area-weighted smooth normals.
 *
 * Area weighting rather than plain averaging: a long thin triangle at a cap
 * would otherwise pull the pole normal off toward its own plane.
 */
function computeNormals(pos, idx) {
    const n = new Float32Array(pos.length);
    for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
        // Un-normalised cross product: its length is twice the triangle area,
        // which is exactly the weight we want.
        const fx = uy * vz - uz * vy;
        const fy = uz * vx - ux * vz;
        const fz = ux * vy - uy * vx;
        n[a] += fx; n[a + 1] += fy; n[a + 2] += fz;
        n[b] += fx; n[b + 1] += fy; n[b + 2] += fz;
        n[c] += fx; n[c + 1] += fy; n[c + 2] += fz;
    }
    for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
        n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
    }
    return n;
}

/**
 * Loft a closed tube through a list of rings.
 *
 * Each ring is `[cx, cy, cz, rx, rz, ao, b0, w0, b1, w1]` and the cross-section
 * plane is derived from the direction to the neighbouring rings, so a limb that
 * bends in the bind pose still gets circular sections rather than sheared ones.
 *
 * @param {Builder} B
 * @param {number[][]} rings
 * @param {number} matId
 * @param {[number,number,number]} ref reference axis the section frame avoids
 */
function loft(B, rings, matId, ref, capStart, capEnd) {
    const n = rings.length;
    const first = [];
    let prevRow = null;
    let vAcc = 0;

    for (let r = 0; r < n; r++) {
        const cur = rings[r];
        const prev = rings[Math.max(0, r - 1)];
        const next = rings[Math.min(n - 1, r + 1)];

        let ax = next[0] - prev[0], ay = next[1] - prev[1], az = next[2] - prev[2];
        let al = Math.hypot(ax, ay, az) || 1;
        ax /= al; ay /= al; az /= al;

        // U = axis x ref, W = axis x U — the two axes of the section plane.
        let ux = ay * ref[2] - az * ref[1];
        let uy = az * ref[0] - ax * ref[2];
        let uz = ax * ref[1] - ay * ref[0];
        let ul = Math.hypot(ux, uy, uz) || 1;
        ux /= ul; uy /= ul; uz /= ul;
        const wx = ay * uz - az * uy;
        const wy = az * ux - ax * uz;
        const wz = ax * uy - ay * ux;

        if (r > 0) {
            vAcc += Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]);
        }

        // Texture coordinates are metres of surface, not normalised. Every
        // scale in the fabric shader — the weave, the yarn slub — is a physical
        // size, and normalised UVs would make each of them a different size on
        // every part of the body.
        const circ = Math.PI * (cur[3] + cur[4]);

        const row = [];
        for (let s = 0; s < SEG; s++) {
            const a = (s / SEG) * Math.PI * 2;
            const ca = Math.cos(a), sa = Math.sin(a);
            const px = cur[0] + ux * cur[3] * sa + wx * cur[4] * ca;
            const py = cur[1] + uy * cur[3] * sa + wy * cur[4] * ca;
            const pz = cur[2] + uz * cur[3] * sa + wz * cur[4] * ca;
            row.push(B.vert(
                px, py, pz,
                (s / SEG) * circ, vAcc,
                matId, cur[5], cur[6], cur[7], cur[8], cur[9]
            ));
        }

        if (prevRow) {
            for (let s = 0; s < SEG; s++) {
                const s2 = (s + 1) % SEG;
                B.quad(prevRow[s], prevRow[s2], row[s2], row[s]);
            }
        }
        if (r === 0) first.push(...row);
        prevRow = row;
    }

    // Caps: a fan to a centre vertex placed on the ring's own axis.
    if (capStart) capRing(B, rings[0], rings[1], first, matId, true);
    if (capEnd) capRing(B, rings[n - 1], rings[n - 2], prevRow, matId, false);
}

function capRing(B, ring, neighbour, row, matId, isStart) {
    let ax = ring[0] - neighbour[0], ay = ring[1] - neighbour[1], az = ring[2] - neighbour[2];
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al; ay /= al; az /= al;
    const ext = Math.max(ring[3], ring[4]) * 0.7;
    const c = B.vert(
        ring[0] + ax * ext, ring[1] + ay * ext, ring[2] + az * ext,
        0.5, 0.5, matId, ring[5], ring[6], ring[7], ring[8], ring[9]
    );
    for (let s = 0; s < SEG; s++) {
        const s2 = (s + 1) % SEG;
        if (isStart) B.tri(c, row[s2], row[s]);
        else B.tri(c, row[s], row[s2]);
    }
}

/** Bone blend along the spine, by bind-pose height. */
function spineBones(y) {
    if (y < 1.06) {
        const t = Math.min(1, Math.max(0, (y - 0.88) / 0.18));
        return [B_ROOT, 1 - t * 0.5, B_SPINE, t * 0.5];
    }
    if (y < 1.26) {
        const t = (y - 1.06) / 0.20;
        return [B_SPINE, 1 - t, B_CHEST, t];
    }
    const t = Math.min(1, (y - 1.26) / 0.20);
    return [B_CHEST, 1 - t * 0.35, B_NECK, t * 0.35];
}

/** Ring helper: `[cx,cy,cz, rx,rz, ao, b0,w0,b1,w1]`. */
function ring(cx, cy, cz, rx, rz, ao, bones) {
    return [cx, cy, cz, rx, rz, ao, bones[0], bones[1], bones[2], bones[3]];
}

/** Rings along a straight bone segment, interpolating radius and bone weights. */
function limbRings(x0, y0, z0, x1, y1, z1, r0, r1, steps, boneA, boneB, ao, from, to) {
    const out = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // Weight ramps from boneA to boneB across the segment's lower half, so
        // the joint bends smoothly instead of creasing at one ring.
        const w = Math.min(1, Math.max(0, (t - from) / (to - from)));
        const r = r0 + (r1 - r0) * t;
        out.push(ring(
            x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t,
            r, r, ao, [boneA, 1 - w, boneB, w]
        ));
    }
    return out;
}

// -----------------------------------------------------------------------------
//  Body
// -----------------------------------------------------------------------------

/**
 * The figure under the garments: head, cowl, torso, arms, trousers, boots.
 *
 * Most of this is only seen in slivers — the robe covers the torso, the mantle
 * covers the shoulders. What is genuinely on screen is the hood silhouette, the
 * boots, and the forearms, so that is where the ring counts go.
 */
export function buildBody(scene) {
    const B = new Builder();

    // ---- torso ------------------------------------------------------------
    const torso = [];
    const TORSO = [
        [0.88, 0.150, 0.120], [0.98, 0.142, 0.113], [1.06, 0.134, 0.106],
        [1.14, 0.140, 0.109], [1.22, 0.156, 0.118], [1.30, 0.172, 0.126],
        [1.38, 0.176, 0.126], [1.44, 0.160, 0.116],
    ];
    for (let i = 0; i < TORSO.length; i++) {
        const [y, rx, rz] = TORSO[i];
        torso.push(ring(0, y, 0, rx, rz, 0.72, spineBones(y)));
    }
    loft(B, torso, M_TRIM, [0, 0, 1], true, false);

    // ---- belt -------------------------------------------------------------
    const belt = [
        ring(0, 0.955, 0, 0.153, 0.124, 0.62, spineBones(0.955)),
        ring(0, 0.995, 0, 0.160, 0.130, 0.70, spineBones(0.995)),
        ring(0, 1.035, 0, 0.152, 0.123, 0.62, spineBones(1.035)),
    ];
    loft(B, belt, M_LEATHER, [0, 0, 1], false, false);

    // ---- neck + head ------------------------------------------------------
    const neck = [
        ring(0, 1.42, -0.005, 0.062, 0.058, 0.35, [B_NECK, 1, B_HEAD, 0]),
        ring(0, 1.50, 0.000, 0.058, 0.055, 0.30, [B_NECK, 0.5, B_HEAD, 0.5]),
        ring(0, 1.56, 0.002, 0.062, 0.060, 0.28, [B_HEAD, 1, 0, 0]),
    ];
    loft(B, neck, M_SKIN, [0, 0, 1], false, false);

    // The head.
    //
    // This used to be a featureless ovoid, and that was the right call while it
    // lived at the bottom of a cowl: a half-finished face in shadow is worse
    // than a silhouette. The hood is down now, the camera gets within two
    // metres of it, and the ovoid stopped being a silhouette and started being
    // a mannequin. See buildHead.
    buildHead(B);
    buildHairCap(B);
    buildCowlDown(B);

    // ---- arms -------------------------------------------------------------
    for (let a = 0; a < 2; a++) {
        const s = a === 0 ? -1 : 1;
        const up = a === 0 ? B_UPPER_L : B_UPPER_R;
        const fo = a === 0 ? B_FORE_L : B_FORE_R;
        const hd = a === 0 ? B_HAND_L : B_HAND_R;

        const upper = limbRings(
            s * 0.185, 1.400, 0, s * 0.230, 1.123, 0,
            0.064, 0.050, 4, up, fo, 0.55, 0.72, 1.0
        );
        loft(B, upper, M_ROBE, [0, 0, 1], true, false);

        const fore = limbRings(
            s * 0.230, 1.123, 0, s * 0.243, 0.866, 0.016,
            0.050, 0.042, 4, fo, hd, 0.62, 0.75, 1.0
        );
        loft(B, fore, M_ROBE, [0, 0, 1], false, false);

        // The hand is a mitt. Fingers at this distance are three pixels of
        // noise; a clean silhouette reads better and costs nothing.
        const hand = [
            ring(s * 0.243, 0.866, 0.016, 0.044, 0.038, 0.55, [hd, 1, 0, 0]),
            ring(s * 0.245, 0.820, 0.024, 0.050, 0.040, 0.55, [hd, 1, 0, 0]),
            ring(s * 0.247, 0.780, 0.032, 0.046, 0.036, 0.52, [hd, 1, 0, 0]),
            ring(s * 0.248, 0.752, 0.038, 0.030, 0.026, 0.50, [hd, 1, 0, 0]),
        ];
        loft(B, hand, M_LEATHER, [0, 0, 1], false, true);
    }

    // ---- legs and boots ---------------------------------------------------
    for (let l = 0; l < 2; l++) {
        const s = l === 0 ? -1 : 1;
        const th = l === 0 ? B_THIGH_L : B_THIGH_R;
        const sh = l === 0 ? B_SHIN_L : B_SHIN_R;
        const ft = l === 0 ? B_FOOT_L : B_FOOT_R;

        const thigh = limbRings(
            s * 0.100, 0.905, 0, s * 0.100, 0.460, 0,
            0.114, 0.086, 5, th, sh, 0.5, 0.74, 1.0
        );
        loft(B, thigh, M_ROBE, [0, 0, 1], true, false);

        // Trousers narrow to the ankle then flare into the boot shaft.
        const shin = [
            ring(s * 0.100, 0.460, 0, 0.086, 0.086, 0.55, [sh, 1, 0, 0]),
            ring(s * 0.100, 0.360, 0.004, 0.076, 0.076, 0.55, [sh, 1, 0, 0]),
            ring(s * 0.100, 0.270, 0.006, 0.070, 0.070, 0.52, [sh, 1, 0, 0]),
            ring(s * 0.100, 0.200, 0.006, 0.075, 0.076, 0.48, [sh, 0.6, ft, 0.4]),
            ring(s * 0.100, 0.140, 0.004, 0.080, 0.082, 0.44, [sh, 0.25, ft, 0.75]),
            ring(s * 0.100, 0.100, 0.000, 0.074, 0.078, 0.42, [ft, 1, 0, 0]),
        ];
        loft(B, shin, M_ROBE, [0, 0, 1], false, false);

        // The boot runs along the foot's own axis, so it swings with the ankle
        // roll rather than being a block bolted to the shin.
        const boot = [
            ring(s * 0.100, 0.055, -0.088, 0.046, 0.052, 0.35, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.058, -0.050, 0.056, 0.066, 0.38, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.054, 0.010, 0.058, 0.060, 0.42, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.048, 0.078, 0.056, 0.050, 0.45, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.043, 0.142, 0.050, 0.043, 0.48, [ft, 1, 0, 0]),
            ring(s * 0.100, 0.040, 0.190, 0.033, 0.031, 0.48, [ft, 1, 0, 0]),
        ];
        loft(B, boot, M_LEATHER, [0, 1, 0], true, true);
    }

    return finishSkinned(scene, "charBody", B);
}

// -----------------------------------------------------------------------------
//  Head
// -----------------------------------------------------------------------------

/**
 * Skull profile, bind pose: `[y, halfWidth, frontRadius, backRadius]` in metres.
 *
 * Three radii per slice rather than two, and that third number is what stops
 * this reading as an egg. A head in plan is not an ellipse — it is short in
 * front of the ear and long behind it, because the face is a flat plate hung on
 * the front of a much larger braincase. Give the front and the back the same
 * radius and the result is a peanut with a nose on it, at any resolution.
 *
 * Total height 0.244 m, chin to crown, on a 1.79 m figure. Slightly small for
 * the body, deliberately: heroic proportion survives being read at fifteen
 * metres better than accurate proportion does, and the same reasoning already
 * set the shoulder width in figure.js.
 */
const HEAD_PROFILE = [
    [1.522, 0.030, 0.052, 0.036], // chin
    [1.542, 0.050, 0.069, 0.058], // jaw
    [1.562, 0.062, 0.078, 0.072], // mouth
    [1.584, 0.070, 0.083, 0.082], // cheek
    [1.606, 0.074, 0.083, 0.090], // eye line
    [1.628, 0.076, 0.082, 0.095], // brow
    [1.652, 0.076, 0.079, 0.098], // lower forehead
    [1.676, 0.075, 0.075, 0.098], // upper forehead
    [1.700, 0.072, 0.069, 0.095],
    [1.722, 0.064, 0.060, 0.086],
    [1.742, 0.050, 0.046, 0.068],
    [1.758, 0.031, 0.028, 0.042],
    [1.766, 0.008, 0.008, 0.011], // crown
];
const HEAD_CX = 0.0;
const HEAD_CZ = 0.005;
const HEAD_TOP = 1.766;
const HEAD_COLS = 26;

/** Head centre, still used by the cowl and the fur trim. */
const HEAD_C = [0, 1.655, 0.005];

const _sec = [0, 0, 0];
const _hp = [0, 0, 0];

function gauss(x, mu, sigma) {
    const t = (x - mu) / sigma;
    return Math.exp(-t * t);
}

function smooth01(x) {
    const t = x < 0 ? 0 : x > 1 ? 1 : x;
    return t * t * (3 - 2 * t);
}

/** Interpolate the profile table at an arbitrary height. */
function headSection(y, out) {
    const n = HEAD_PROFILE.length;
    if (y <= HEAD_PROFILE[0][0]) {
        out[0] = HEAD_PROFILE[0][1]; out[1] = HEAD_PROFILE[0][2]; out[2] = HEAD_PROFILE[0][3];
        return out;
    }
    for (let i = 1; i < n; i++) {
        if (y <= HEAD_PROFILE[i][0]) {
            const a = HEAD_PROFILE[i - 1];
            const b = HEAD_PROFILE[i];
            const t = (y - a[0]) / (b[0] - a[0]);
            out[0] = a[1] + (b[1] - a[1]) * t;
            out[1] = a[2] + (b[2] - a[2]) * t;
            out[2] = a[3] + (b[3] - a[3]) * t;
            return out;
        }
    }
    const l = HEAD_PROFILE[n - 1];
    out[0] = l[1]; out[1] = l[2]; out[2] = l[3];
    return out;
}

/**
 * Radial displacement of the skull surface, metres, at height `y` and azimuth
 * `a` (0 straight ahead, positive toward the character's left).
 *
 * Each term is one anatomical landmark written as a bump in two dimensions.
 * Doing it this way rather than sculpting vertices means the same function
 * drives the hair cap, the shell roots and the occlusion field, so all four
 * agree by construction and none of them can drift when a number changes.
 */
function headRadial(y, a) {
    const c = Math.cos(a);
    let d = 0;

    // Brow ridge — a bar across the front, dying out past the temples. The
    // single most valuable feature on the whole head: it is what puts the eyes
    // in shadow under any sun, which is what makes a face read at distance.
    d += 0.0080 * gauss(y, 1.631, 0.013) * smooth01((c - 0.10) / 0.70);

    // Eye sockets, under it.
    d -= 0.0070 * gauss(y, 1.606, 0.011) *
        (gauss(a, 0.42, 0.20) + gauss(a, -0.42, 0.20));

    // Cheekbones.
    d += 0.0052 * gauss(y, 1.588, 0.017) *
        (gauss(a, 0.72, 0.26) + gauss(a, -0.72, 0.26));

    // Temples, pinched. A skull is narrowest just above the ear, and leaving
    // that out is most of why an ovoid head looks inflated.
    d -= 0.0058 * gauss(y, 1.657, 0.021) *
        (gauss(a, 1.16, 0.30) + gauss(a, -1.16, 0.30));

    // Jaw corner.
    d += 0.0048 * gauss(y, 1.551, 0.015) *
        (gauss(a, 1.02, 0.34) + gauss(a, -1.02, 0.34));

    // The occiput bulges low and tucks in high.
    d += 0.0040 * gauss(y, 1.662, 0.032) * Math.max(0, -c);

    return d;
}

/** Baked occlusion for the skull. Eyes dark, jaw underside dark, crown open. */
function headAO(y, a) {
    let ao = 0.42 + 0.34 * smooth01((y - 1.53) / 0.22);

    // The eye sockets carry their own darkness rather than relying on the brow
    // to cast into them. At fifteen metres the shadow is two pixels wide and
    // the sun is often behind the figure; the baked term is what survives both.
    ao -= 0.30 * gauss(y, 1.607, 0.013) *
        (gauss(a, 0.42, 0.19) + gauss(a, -0.42, 0.19));

    // Under the jaw and behind the ears.
    ao -= 0.18 * gauss(y, 1.536, 0.016);
    ao -= 0.10 * gauss(y, 1.616, 0.020) *
        (gauss(a, 1.55, 0.22) + gauss(a, -1.55, 0.22));

    return Math.max(0.06, Math.min(1, ao));
}

/**
 * A point on (or `off` metres outside) the skull surface.
 * @param {number} y @param {number} a @param {number} off @param {number[]} out
 */
function headPoint(y, a, off, out) {
    headSection(y, _sec);
    const s = Math.sin(a);
    const c = Math.cos(a);
    // Blend the front and back radii through the sides rather than switching at
    // c = 0. A hard switch leaves a crease running vertically down both temples
    // that no smooth-normal pass can hide.
    const k = smooth01((c + 0.40) / 0.80);
    const rz = _sec[2] + (_sec[1] - _sec[2]) * k;
    const r = headRadial(y, a) + off;
    out[0] = HEAD_CX + s * (_sec[0] + r);
    out[1] = y;
    out[2] = HEAD_CZ + c * (rz + r);
    return out;
}

/** The skull, the nose and the ears. */
function buildHead(B) {
    // ---- cranium ----------------------------------------------------------
    let prev = null;
    let first = null;
    for (let i = 0; i < HEAD_PROFILE.length; i++) {
        const y = HEAD_PROFILE[i][0];
        const row = [];
        for (let c = 0; c < HEAD_COLS; c++) {
            const a = (c / HEAD_COLS) * Math.PI * 2;
            headPoint(y, a, 0, _hp);
            row.push(B.vert(
                _hp[0], _hp[1], _hp[2],
                (c / HEAD_COLS) * 0.48, y - 1.52,
                M_SKIN, headAO(y, a), B_HEAD, 1, 0, 0
            ));
        }
        if (prev) {
            for (let c = 0; c < HEAD_COLS; c++) {
                const c2 = (c + 1) % HEAD_COLS;
                B.quad(prev[c], prev[c2], row[c2], row[c]);
            }
        }
        if (!first) first = row;
        prev = row;
    }

    // Crown and chin caps. The chin is buried in the neck loft, but an open
    // ring there shows as a black crescent whenever the head tips back.
    const crown = B.vert(HEAD_CX, HEAD_TOP + 0.006, HEAD_CZ, 0.24, 0.25,
        M_SKIN, 0.80, B_HEAD, 1, 0, 0);
    const under = B.vert(HEAD_CX, 1.514, HEAD_CZ, 0.24, 0.0,
        M_SKIN, 0.14, B_HEAD, 1, 0, 0);
    for (let c = 0; c < HEAD_COLS; c++) {
        const c2 = (c + 1) % HEAD_COLS;
        B.tri(crown, prev[c], prev[c2]);
        B.tri(under, first[c2], first[c]);
    }

    // ---- nose -------------------------------------------------------------
    // Small, straight and slightly hooked at the tip. It contributes almost
    // nothing to a front view and everything to a profile, which is the view
    // the camera spends most of its time in over the shoulder.
    const nose = [
        ring(0, 1.640, HEAD_CZ + 0.068, 0.009, 0.007, 0.52, [B_HEAD, 1, 0, 0]),
        ring(0, 1.618, HEAD_CZ + 0.079, 0.010, 0.011, 0.50, [B_HEAD, 1, 0, 0]),
        ring(0, 1.598, HEAD_CZ + 0.089, 0.012, 0.015, 0.46, [B_HEAD, 1, 0, 0]),
        ring(0, 1.583, HEAD_CZ + 0.091, 0.016, 0.016, 0.40, [B_HEAD, 1, 0, 0]),
        ring(0, 1.574, HEAD_CZ + 0.078, 0.017, 0.012, 0.30, [B_HEAD, 1, 0, 0]),
    ];
    loft(B, nose, M_SKIN, [1, 0, 0], false, false);

    // ---- ears -------------------------------------------------------------
    for (let e = 0; e < 2; e++) {
        const sx = e === 0 ? -1 : 1;
        const ear = [
            ring(sx * 0.064, 1.617, -0.007, 0.011, 0.023, 0.30, [B_HEAD, 1, 0, 0]),
            ring(sx * 0.077, 1.619, -0.009, 0.014, 0.027, 0.38, [B_HEAD, 1, 0, 0]),
            ring(sx * 0.085, 1.617, -0.007, 0.008, 0.020, 0.34, [B_HEAD, 1, 0, 0]),
        ];
        loft(B, ear, M_SKIN, [0, 1, 0], false, true);
    }
}

// -----------------------------------------------------------------------------
//  Hair
// -----------------------------------------------------------------------------

const HAIR_COLS = 30;
const HAIR_ROWS = 6;

/**
 * The hairline, as a height per azimuth.
 *
 * High at the forehead, receding at the temples, and dropping to a nape at the
 * back — a crop, short back and sides. The two sine terms at the end are the
 * whole reason it does not look like a swimming cap: a hairline is an edge
 * between two materials, and a *smooth* edge between two materials is the one
 * thing hair never has.
 */
function hairlineY(a) {
    const c = Math.cos(a);
    let y = 1.645 + 0.045 * Math.max(0, c) - 0.042 * Math.max(0, -c);
    y -= 0.015 * (gauss(a, 0.62, 0.26) + gauss(a, -0.62, 0.26)); // temples
    y += 0.009 * gauss(a, 0.0, 0.30);                            // centre peak
    y += 0.0040 * Math.sin(a * 13.0 + 0.7) + 0.0025 * Math.sin(a * 27.0 + 2.1);
    return y;
}

/** Height of a hair sample: `t` 0 at the hairline, 1 at the crown. */
function hairY(a, t) {
    const y0 = hairlineY(a);
    return y0 + (HEAD_TOP - y0) * t;
}

/**
 * The solid cap under the shells.
 *
 * Shell fur is a stack of alpha-tested sheets and you can always see between
 * them at a grazing angle. Without an opaque base the scalp shows through the
 * gaps in silhouette and the crop reads as thinning. The cap costs 400
 * triangles and removes the entire failure mode.
 */
function buildHairCap(B) {
    let prev = null;
    for (let r = 0; r <= HAIR_ROWS; r++) {
        const t = r / HAIR_ROWS;
        const row = [];
        for (let c = 0; c < HAIR_COLS; c++) {
            const a = (c / HAIR_COLS) * Math.PI * 2;
            // Thickness tapers to nothing at the hairline, so the edge sinks
            // into the scalp rather than standing off it as a visible lip.
            const off = 0.0012 + 0.0088 * smooth01(t / 0.42);
            headPoint(hairY(a, t), a, off, _hp);
            row.push(B.vert(
                _hp[0], _hp[1], _hp[2],
                a * 0.075, t * 0.08,
                M_HAIR, 0.26 + 0.50 * t, B_HEAD, 1, 0, 0
            ));
        }
        if (prev) {
            for (let c = 0; c < HAIR_COLS; c++) {
                const c2 = (c + 1) % HAIR_COLS;
                B.quad(prev[c], prev[c2], row[c2], row[c]);
            }
        }
        prev = row;
    }
    const crown = B.vert(HEAD_CX, HEAD_TOP + 0.014, HEAD_CZ, 0.0, 0.09,
        M_HAIR, 0.80, B_HEAD, 1, 0, 0);
    for (let c = 0; c < HAIR_COLS; c++) {
        B.tri(crown, prev[c], prev[(c + 1) % HAIR_COLS]);
    }
}

/**
 * The hair itself: shell fur over the cap.
 *
 * Same shader and the same trick as the cowl trim — N copies of one surface,
 * each pushed further out, alpha-tested into strands — but tuned for a 2 cm
 * crop instead of a 5 cm trim: shorter, four times denser, and its own material
 * so it can be near-black while the trim stays leather-brown.
 *
 * Bound rigidly to the head bone. Hair this short does not swing, and the fur
 * shader's droop term is already more motion than a crop should have.
 */
export function buildHair(scene) {
    const B = new Builder();
    B.explicitNormals = true;

    const cols = HAIR_COLS;
    const rows = HAIR_ROWS;
    const n = (rows + 1) * cols;
    const bases = new Float32Array(n * 3);
    const outs = new Float32Array(n * 3);
    const lens = new Float32Array(n);
    const uvs = new Float32Array((rows + 1) * (cols + 1) * 2);

    // Shell directions radiate from a point inside the braincase rather than
    // from the true surface normal. Hair grows out of a scalp, not out of a
    // brow ridge, and following the normal exactly makes the strands over the
    // temples splay sideways.
    const SC = [0, 1.668, HEAD_CZ - 0.006];

    for (let r = 0; r <= rows; r++) {
        const t = r / rows;
        for (let c = 0; c < cols; c++) {
            const a = (c / cols) * Math.PI * 2;
            const k = r * cols + c;
            const o = k * 3;

            headPoint(hairY(a, t), a, 0.0105, _hp);
            bases[o] = _hp[0]; bases[o + 1] = _hp[1]; bases[o + 2] = _hp[2];

            let dx = _hp[0] - SC[0], dy = _hp[1] - SC[1], dz = _hp[2] - SC[2];
            const dl = Math.hypot(dx, dy, dz) || 1;
            outs[o] = dx / dl; outs[o + 1] = dy / dl; outs[o + 2] = dz / dl;

            // Length: a fade at the hairline, full crop over the crown, and a
            // shade shorter round the back and sides.
            const cz = Math.cos(a);
            const sides = 0.82 + 0.18 * Math.max(0, cz);
            lens[k] = (0.0035 + 0.0165 * smooth01(t / 0.5)) * sides;
        }
    }

    // Texture coordinates in metres of surface — the strand field's pitch is a
    // physical size, so the seam column has to carry the *wrapped* arc length
    // rather than reset to zero, or the strands compress into a stripe there.
    const circ = 0.075 * Math.PI * 2;
    for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
            const o = (r * (cols + 1) + c) * 2;
            uvs[o] = (c / cols) * circ;
            uvs[o + 1] = (r / rows) * 0.085;
        }
    }

    emitFurPatch(B, cols, rows, bases, outs, uvs, lens, HAIR_SHELLS, B_HEAD, 0.44);
    return finishSkinned(scene, "charHair", B, true);
}

// -----------------------------------------------------------------------------
//  The fallen cowl
// -----------------------------------------------------------------------------

const COWL_COLS = 28;
const COWL_ROWS = 6;

/**
 * The cowl, lowered.
 *
 * Not deleted — lowered. A desert robe without a hood at all reads as a
 * bathrobe, and the shape bunched behind the neck is what tells you the figure
 * *has* one and chose to take it off, which is a different character note than
 * never having had one.
 *
 * It stands rather than hangs, and that is a clearance decision as much as an
 * aesthetic one: the mantle behind it is a simulated panel that collides only
 * with the torso capsules, so anything of ours that reaches down its back will
 * eventually be flapped through. Everything here stays above the mantle's
 * collar line at y = 1.442 and tucks its own hem *under* it.
 */

/** Top edge of the standing collar. Reused verbatim by the fur trim. */
export function cowlRimPoint(s, out) {
    const a = s * Math.PI * 2;
    const sa = Math.sin(a);
    const ca = Math.cos(a);
    const back = Math.max(0, -ca);
    out[0] = 0.116 * sa * (1.0 + 0.42 * back);
    out[1] = 1.474 + 0.094 * back * back;
    out[2] = -0.014 + 0.104 * ca - 0.046 * back;
    return out;
}

function cowlBasePoint(s, out) {
    const a = s * Math.PI * 2;
    const sa = Math.sin(a);
    const ca = Math.cos(a);
    const back = Math.max(0, -ca);
    out[0] = 0.148 * sa * (1.0 + 0.22 * back);
    out[1] = 1.402 - 0.026 * back;
    out[2] = -0.010 + 0.118 * ca;
    return out;
}

function buildCowlDown(B) {
    const rim = [0, 0, 0];
    const base = [0, 0, 0];
    let prevRow = null;

    for (let r = 0; r <= COWL_ROWS; r++) {
        const t = r / COWL_ROWS;
        const row = [];
        for (let c = 0; c < COWL_COLS; c++) {
            const s = c / COWL_COLS;
            cowlRimPoint(s, rim);
            cowlBasePoint(s, base);

            const a = s * Math.PI * 2;
            const ca = Math.cos(a);
            const back = Math.max(0, -ca);

            // Control point, bowed out and back. Heavier at the back, where the
            // fabric is doubled over on itself, than at the throat.
            const mx = (rim[0] + base[0]) * 0.5 * (1.0 + 0.30 * back);
            const my = (rim[1] + base[1]) * 0.5 + 0.010 * back;
            const mz = (rim[2] + base[2]) * 0.5 - 0.048 * back - 0.006;

            const it = 1 - t;
            const px = it * it * rim[0] + 2 * it * t * mx + t * t * base[0];
            const py = it * it * rim[1] + 2 * it * t * my + t * t * base[1];
            const pz = it * it * rim[2] + 2 * it * t * mz + t * t * base[2];

            // Folds. A collar that is a clean swept surface reads as moulded
            // plastic; the pleats are what make it cloth that has been pushed
            // back off a head rather than tailored into that shape.
            const fold = 0.0075 * Math.sin(a * 9.0 + 1.1) * (0.35 + 0.65 * t) * (0.4 + 0.6 * back);
            const fl = Math.hypot(px, pz - 0.0) || 1;

            const ao = 0.30 + 0.48 * t;
            row.push(B.vert(
                px + (px / fl) * fold, py, pz + ((pz + 0.02) / fl) * fold,
                s * 0.72, t * 0.22,
                M_ROBE, ao, B_CHEST, 1, B_NECK, 0
            ));
        }
        if (prevRow) {
            for (let c = 0; c < COWL_COLS; c++) {
                const c2 = (c + 1) % COWL_COLS;
                B.quad(prevRow[c], prevRow[c2], row[c2], row[c]);
            }
        }
        prevRow = row;
    }
}

// -----------------------------------------------------------------------------
//  Fur
// -----------------------------------------------------------------------------

/** Shells per fur band. Below about 18 the layering is visible as banding. */
const COWL_SHELLS = 22;
const CUFF_SHELLS = 18;
/**
 * Shells in the hair.
 *
 * Fewer than the trim, and that is not a saving. The stack has to resolve the
 * strand *length*, and these strands are a third as long — twenty-two shells
 * across 2 cm puts the sheets under a millimetre apart, which is finer than the
 * strand field's own cell and just draws the same alpha test twelve extra times.
 */
const HAIR_SHELLS = 12;

/**
 * Shell fur.
 *
 * A trim band is modelled as a partial torus around the edge it decorates: a
 * ring of cross-sections, each an arc of directions pointing away from the
 * garment. That surface is then emitted once per shell, each copy pushed
 * further along its own direction, and the fragment shader alpha-tests a hashed
 * strand field whose threshold rises with the shell parameter — so strands
 * taper, end at different lengths, and the band reads as fur rather than as a
 * smooth sausage.
 *
 * Bone-bound rather than cloth-bound, deliberately: the hood rim rides the hood
 * bone and the cuffs ride the forearms, both of which are rigid. Binding fur to
 * a simulated surface would need the shell direction to come out of the cloth
 * solve — a second vertex program, for very little visible gain.
 */
export function buildFur(scene) {
    const B = new Builder();
    B.explicitNormals = true;
    const p = [0, 0, 0];

    // ---- cowl rim ---------------------------------------------------------
    // Runs the top edge of the fallen collar. Its outward direction points away
    // from the neck axis and tips upward, so the trim stands proud of the
    // collar instead of lying flat along it.
    //
    // Bound to the chest, not the hood bone: the cowl is off the head now and
    // rides the shoulders. B_HOOD still exists and is still posed — it is just
    // no longer carrying any geometry.
    const cols = 26;
    const bases = new Float32Array(cols * 3);
    const outs = new Float32Array(cols * 3);
    const AXIS = [0, 1.470, -0.014];
    for (let c = 0; c < cols; c++) {
        cowlRimPoint(c / cols, p);
        bases[c * 3] = p[0]; bases[c * 3 + 1] = p[1]; bases[c * 3 + 2] = p[2];
        let dx = p[0] - AXIS[0], dy = 0, dz = p[2] - AXIS[2];
        const dl = Math.hypot(dx, dz) || 1;
        dx = dx / dl; dz = dz / dl;
        dy = 0.55;
        const l2 = Math.hypot(dx, dy, dz) || 1;
        outs[c * 3] = dx / l2; outs[c * 3 + 1] = dy / l2; outs[c * 3 + 2] = dz / l2;
    }
    emitFurBand(B, cols, bases, outs, 0.018, 0.038, COWL_SHELLS, B_CHEST, 0.52);

    // ---- cuffs ------------------------------------------------------------
    for (let a = 0; a < 2; a++) {
        const s = a === 0 ? -1 : 1;
        const bone = a === 0 ? B_FORE_L : B_FORE_R;
        const n = 12;
        const cb = new Float32Array(n * 3);
        const co = new Float32Array(n * 3);
        // The forearm runs almost straight down in the bind pose, so the band's
        // ring sits in the XZ plane around it and its outward is radial.
        for (let c = 0; c < n; c++) {
            const ang = (c / n) * Math.PI * 2;
            const rx = Math.sin(ang), rz = Math.cos(ang);
            // Sits on the sleeve at the wrist, just above the loose cuff rows,
            // where the garment is pinned hard enough that a bone-bound band
            // cannot visibly separate from it.
            cb[c * 3] = s * 0.240 + rx * 0.066;
            cb[c * 3 + 1] = 0.900;
            cb[c * 3 + 2] = 0.012 + rz * 0.064;
            co[c * 3] = rx; co[c * 3 + 1] = 0; co[c * 3 + 2] = rz;
        }
        emitFurBand(B, n, cb, co, 0.015, 0.032, CUFF_SHELLS, bone, 0.52);
    }

    return finishSkinned(scene, "charFur", B, true);
}

/** Cross-section steps across a fur band, and the arc they cover. */
const FUR_ARC_STEPS = 4;
const FUR_ARC = 2.1; // radians, centred on the outward direction

/**
 * One fur band.
 *
 * @param {Builder} B
 * @param {number} cols positions around the ring
 * @param {Float32Array} bases ring positions, 3 floats each
 * @param {Float32Array} outs unit outward direction per ring position
 * @param {number} r0 radius of the band's core, metres
 * @param {number} len strand length beyond the core, metres
 * @param {number} shells
 * @param {number} bone
 * @param {number} ao
 */
function emitFurBand(B, cols, bases, outs, r0, len, shells, bone, ao) {
    const dir = new Float32Array((cols * (FUR_ARC_STEPS + 1)) * 3);

    // Precompute the cross-section directions once: each is the outward vector
    // rotated about the ring's own tangent.
    for (let c = 0; c < cols; c++) {
        const cn = (c + 1) % cols;
        const cp = (c - 1 + cols) % cols;
        let tx = bases[cn * 3] - bases[cp * 3];
        let ty = bases[cn * 3 + 1] - bases[cp * 3 + 1];
        let tz = bases[cn * 3 + 2] - bases[cp * 3 + 2];
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;

        const ox = outs[c * 3], oy = outs[c * 3 + 1], oz = outs[c * 3 + 2];
        // Third axis of the cross-section plane.
        const ax = ty * oz - tz * oy;
        const ay = tz * ox - tx * oz;
        const az = tx * oy - ty * ox;

        for (let k = 0; k <= FUR_ARC_STEPS; k++) {
            const phi = (k / FUR_ARC_STEPS - 0.5) * FUR_ARC;
            const cs = Math.cos(phi), sn = Math.sin(phi);
            const o = (c * (FUR_ARC_STEPS + 1) + k) * 3;
            dir[o] = ox * cs + ax * sn;
            dir[o + 1] = oy * cs + ay * sn;
            dir[o + 2] = oz * cs + az * sn;
        }
    }

    // Arc length around the ring, so the strand field has a uniform pitch in
    // metres regardless of how big the band is. The shader multiplies this by a
    // density in cells per metre; anything else makes hood fur and cuff fur
    // come out at different scales.
    const arc = new Float32Array(cols + 1);
    for (let c = 1; c <= cols; c++) {
        const a = ((c - 1) % cols) * 3;
        const b = (c % cols) * 3;
        arc[c] = arc[c - 1] + Math.hypot(
            bases[b] - bases[a], bases[b + 1] - bases[a + 1], bases[b + 2] - bases[a + 2]
        );
    }

    const stride = FUR_ARC_STEPS + 1;
    for (let s = 0; s < shells; s++) {
        const t = s / (shells - 1);
        const rowBase = B.pos.length / 3;

        for (let c = 0; c <= cols; c++) {
            const ci = c % cols;
            for (let k = 0; k <= FUR_ARC_STEPS; k++) {
                const o = (ci * stride + k) * 3;
                const dx = dir[o], dy = dir[o + 1], dz = dir[o + 2];
                const rad = r0 + len * t;
                const across = (k / FUR_ARC_STEPS - 0.5) * FUR_ARC * r0;
                const vi = B.vert(
                    bases[ci * 3] + dx * rad,
                    bases[ci * 3 + 1] + dy * rad,
                    bases[ci * 3 + 2] + dz * rad,
                    arc[c], across,
                    t, ao, bone, 1, 0, 0
                );
                B.normal(vi, dx, dy, dz);
            }
        }

        // Shells are independent sheets: each is stitched only to itself, never
        // to its neighbours. That is the whole idea — the gaps between them are
        // where you see through to the shell behind.
        for (let c = 0; c < cols; c++) {
            for (let k = 0; k < FUR_ARC_STEPS; k++) {
                const a = rowBase + c * stride + k;
                B.quad(a, a + 1, a + stride + 1, a + stride);
            }
        }
    }
}

/**
 * One fur *patch* — an open grid rather than a closed band.
 *
 * `emitFurBand` sweeps a cross-section around a ring, which is right for a trim
 * and useless for a scalp: hair covers an area, not an edge. This takes the
 * area directly as a (rows+1) x cols lattice of roots, each with its own
 * outward direction and its own strand length, and emits the whole lattice once
 * per shell.
 *
 * The lattice wraps in the column direction and does not in the row direction,
 * so one duplicated seam column is emitted to carry the wrapped texture
 * coordinate. Sharing the seam vertex instead would reset the strand field's
 * arc length to zero there and draw a visible parting down one side of the head.
 *
 * @param {Builder} B
 * @param {number} cols columns around, wrapping
 * @param {number} rows row spans (so rows+1 lines of roots)
 * @param {Float32Array} bases root positions, 3 floats per lattice point
 * @param {Float32Array} outs unit shell direction, 3 floats per lattice point
 * @param {Float32Array} uvs strand-field coordinates in metres, 2 floats per
 *                           lattice point *including* the seam column
 * @param {Float32Array} lens strand length per lattice point, metres
 * @param {number} shells
 * @param {number} bone
 * @param {number} ao
 */
function emitFurPatch(B, cols, rows, bases, outs, uvs, lens, shells, bone, ao) {
    const stride = cols + 1;

    for (let s = 0; s < shells; s++) {
        const t = s / (shells - 1);
        const rowBase = B.pos.length / 3;

        for (let r = 0; r <= rows; r++) {
            for (let c = 0; c <= cols; c++) {
                const k = r * cols + (c % cols);
                const o = k * 3;
                const dx = outs[o], dy = outs[o + 1], dz = outs[o + 2];
                const push = lens[k] * t;
                const u = (r * stride + c) * 2;
                const vi = B.vert(
                    bases[o] + dx * push,
                    bases[o + 1] + dy * push,
                    bases[o + 2] + dz * push,
                    uvs[u], uvs[u + 1],
                    t, ao, bone, 1, 0, 0
                );
                B.normal(vi, dx, dy, dz);
            }
        }

        // As with the bands: shells are independent sheets, never stitched to
        // each other. The gaps are the point.
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const a = rowBase + r * stride + c;
                B.quad(a, a + 1, a + stride + 1, a + stride);
            }
        }
    }
}

// -----------------------------------------------------------------------------

function finishSkinned(scene, name, B, isFur) {
    const pos = new Float32Array(B.pos);
    const idx = new Uint32Array(B.idx);
    const nrm = B.explicitNormals ? new Float32Array(B.nrm) : computeNormals(pos, idx);

    const mesh = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.normals = nrm;
    vd.uvs = new Float32Array(B.uv);
    vd.applyToMesh(mesh, false);

    mesh.setVerticesData("aux", new Float32Array(B.aux), false, 2);
    mesh.setVerticesData("boneIdx", new Float32Array(B.bi), false, 4);
    mesh.setVerticesData("boneWt", new Float32Array(B.bw), false, 4);

    // The mesh is placed entirely by the vertex shader from bone matrices, so
    // its world matrix is the identity for ever and its bounding box is a lie.
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { triangles: idx.length / 3, vertices: pos.length / 3, fur: !!isFur };
    return mesh;
}

// -----------------------------------------------------------------------------
//  Cloth render mesh
// -----------------------------------------------------------------------------

/**
 * The render mesh for the simulated garments.
 *
 * It carries no positions of its own — `position` is `(u, v, panelIndex)` and
 * the vertex shader reconstructs the surface by Catmull-Rom interpolation of the
 * panel's simulated node grid. That decoupling is what lets a 24x14 verlet solve
 * render as a smooth 48x28 surface, and it means the sim cost is independent of
 * how finely the garment is tessellated.
 *
 * @param {import("./cloth.js").ClothPanel[]} panels
 */
export function buildClothMesh(scene, panels) {
    const pos = [];
    const uv = [];
    const aux = [];
    const idx = [];

    for (let pi = 0; pi < panels.length; pi++) {
        const p = panels[pi];
        const cu = p.renderCols;
        const cv = p.renderRows;
        const base = pos.length / 3;

        for (let j = 0; j <= cv; j++) {
            const v = j / cv;
            for (let i = 0; i <= cu; i++) {
                const u = i / cu;
                pos.push(u, v, pi);
                uv.push(u * p.weaveU, v * p.weaveV);
                // (matId, ao). Garments darken toward the hem, where they sit in
                // their own folds and close to the ground.
                aux.push(p.matId, p.aoTop + (p.aoBottom - p.aoTop) * v);
            }
        }

        const stride = cu + 1;
        for (let j = 0; j < cv; j++) {
            for (let i = 0; i < cu; i++) {
                const a = base + j * stride + i;
                const b = a + 1;
                const c = a + stride;
                const d = c + 1;
                idx.push(a, b, d, a, d, c);
            }
        }
    }

    const mesh = new Mesh("charCloth", scene);
    const vd = new VertexData();
    vd.positions = new Float32Array(pos);
    vd.indices = new Uint32Array(idx);
    vd.uvs = new Float32Array(uv);
    vd.applyToMesh(mesh, false);
    mesh.setVerticesData("aux", new Float32Array(aux), false, 2);

    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { triangles: idx.length / 3, vertices: pos.length / 3 };
    return mesh;
}
