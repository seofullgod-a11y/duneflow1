// -----------------------------------------------------------------------------
// snowLandform — the map.
//
// Everything in this file is *authored*, not noised. The dune field in
// terrain.wgsl gives the world its texture; this gives it a shape you can
// navigate by. The difference matters: a procedurally uniform erg has no
// landmarks, so every direction looks identical and the player has nowhere to
// go. A map needs walls, gaps, silhouettes on the skyline, and places that are
// obviously *somewhere*.
//
// ## How it composes
//
// One entry point, `landform(p, base)`, returns everything terrainMacro needs
// to fold the map into the dune field:
//
//   add       metres of rock added on top of the field
//   flatten   0..1 — how far the dune field is crushed back toward `base`.
//             Rock does not have dunes on it. Without this a 60 m mesa gets a
//             40 m dune sitting on its cap and reads as a lumpy hill.
//   floorM    0..1 — canyon floor mask
//   floorY    absolute height the canyon floor is pinned to
//   rim       metres added along the canyon lip
//   rock      0..1 — bare-rock mask, handed to the aux bake. The snow/sand
//             material gates it by slope on its own, so it is safe to paint
//             this generously over anything that is geologically rock.
//
// Order of application is fixed and matters: flatten, then add, then cut. A
// canyon cut *after* a massif is a gorge through that massif — which is exactly
// what the spawn slot is.
//
// ## Coordinates
//
// World XZ in metres. `p.x` is east, `p.y` here is world z (north). The play
// disc is 620 m in radius (see PLAY_RADIUS); the height bake covers 1024 m, and
// the clipmap draws to about 870 m — so anything placed inside ~850 m is
// visible, and anything inside 620 m is walkable. Beyond that the raymarched
// range in ridge.wgsl takes over at 9 km.
//
// Named features are listed in game/landmarks.js with the same coordinates. If
// you move something here, move it there too — that table is what the HUD reads
// to announce a discovery.
// -----------------------------------------------------------------------------

/// Distance from `p` to the segment `a`-`b`.
fn sdSeg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
    let pa = p - a;
    let ba = b - a;
    let t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * t);
}

/// Everything the map contributes at one point.
struct Land {
    add: f32,
    flatten: f32,
    floorM: f32,
    floorY: f32,
    rim: f32,
    rock: f32,
};

// ------------------------------------------------------------------- canyons

/// One run of canyon, as a meandering corridor about the segment `a`-`b`.
///
/// Returns (floorMask, rimAdd, rockMask, depth). The caller pins the floor to
/// `base - depth` wherever floorMask is high, which is what makes a canyon
/// floor *flat across its width* while still following the land lengthwise —
/// the single thing that separates a canyon from a trench in a noise field.
///
/// `hw` is the nominal floor half-width in metres; the true width breathes
/// along the run so no stretch is a corridor of constant section. `taperA` and
/// `taperB` are the lengths over which each end fades out — pass 0 at a
/// junction so two runs meet without pinching.
///
/// `wob` scales the meander and the width variation together, and 0 is a
/// meaningful value: it gives a run whose centreline is exactly the segment and
/// whose half-width is exactly `hw`. That is the only way a run can be mirrored
/// on the CPU — game.js clamps the player to the spawn slot's centreline, and
/// it cannot reproduce a GPU noise field to do it. Every other run wobbles.
fn canyonRun(
    p: vec2f, a: vec2f, b: vec2f,
    hw: f32, depth: f32, rimH: f32,
    taperA: f32, taperB: f32, wob: f32
) -> vec4f {
    let ba = b - a;
    let len = max(length(ba), 1e-4);
    let dir = ba / len;
    let nrm = vec2f(-dir.y, dir.x);
    let pa = p - a;

    let along = dot(pa, dir);
    let s = clamp(along, 0.0, len);

    // Meander. Two wavelengths: a long swing that decides where the canyon
    // *goes*, and a short one that keeps the walls from ever being parallel.
    // Seeded off the run's own start point so two runs never meander in step.
    let seed = a.x * 0.031 + a.y * 0.017;
    let mea = wob * (noise2(vec2f(s * 0.0125, seed)) * hw * 2.4
                   + noise2(vec2f(s * 0.052, seed + 4.1)) * hw * 0.55);

    let lat = dot(pa, nrm) - mea;
    // Outside the ends, fall back to a true rounded distance so the corridor
    // closes off instead of running to infinity.
    let over = max(0.0, max(-along, along - len));
    let d = sqrt(lat * lat + over * over);

    // Width breathes: narrows to a squeeze, opens into chambers.
    let wn = 0.68 + 0.60 * (noise2(vec2f(s * 0.021, seed + 9.3)) * 0.5 + 0.5);
    let w = hw * mix(1.0, wn, wob);

    // Floor, wall, rim. The wall is the gap between floorM falling to zero and
    // rim rising — 0.72w to 1.0w, which at hw = 9 m is a shade over 2.5 m of
    // run for the full wall height. Sheer, in other words, and about as sheer
    // as a 0.5 m/texel bake can hold.
    let floorM = 1.0 - smoothstep(w * 0.70, w, d);
    let rimM = smoothstep(w * 0.90, w * 1.22, d) * (1.0 - smoothstep(w * 1.55, w * 3.0, d));
    // Rock is painted wider than the cut: the ground either side of a canyon is
    // scoured caprock, not sand.
    let rockM = 1.0 - smoothstep(w * 2.4, w * 3.8, d);

    var endT = 1.0;
    if (taperA > 0.0) { endT *= smoothstep(0.0, taperA, s); }
    if (taperB > 0.0) { endT *= 1.0 - smoothstep(len - taperB, len, s); }

    return vec4f(floorM * endT, rimM * rimH * endT, rockM * endT, depth);
}

/// Fold one canyon run into the accumulator, keeping the deepest cut where two
/// runs overlap so junctions read as one continuous floor.
fn addCanyon(L: Land, base: f32, r: vec4f) -> Land {
    var o = L;
    if (r.x > o.floorM) {
        o.floorM = r.x;
        o.floorY = base - r.w;
    }
    o.rim = max(o.rim, r.y);
    o.rock = max(o.rock, r.z);
    return o;
}

// -------------------------------------------------------------------- massifs

/// A mesa: flat cap, sheer wall, talus skirt.
///
/// Returns (height, rockMask, capMask). The cap mask is what the caller uses to
/// flatten the dune field — a mesa with dunes on top is a hill.
fn mesaField(p: vec2f, c: vec2f, r: f32, h: f32, seed: f32) -> vec3f {
    let q = p - c;
    let d = length(q);
    if (d > r * 2.4) { return vec3f(0.0); }

    let ang = atan2(q.y, q.x);
    // Lobed plan. A circular mesa is a birthday cake; real ones are eaten away
    // on one side and buttressed on the other.
    let lobe = 1.0
        + 0.17 * sin(ang * 3.0 + seed)
        + 0.09 * sin(ang * 7.0 - seed * 2.3)
        + 0.11 * noise2(q * 0.022 + vec2f(seed * 3.7, seed));
    let rr = max(r * lobe, 1.0);

    let cap = 1.0 - smoothstep(rr * 0.88, rr, d);
    let skirt = 1.0 - smoothstep(rr * 0.96, rr * 2.0, d);

    // Vertical gullies scoring the wall and running out into the talus. Indexed
    // by angle rather than by world position, so they run straight down the
    // face instead of wrapping round it.
    let gully = ridgedd(vec2f(ang * 6.2, d * 0.05 + seed), 2, 2.13, 0.5).x;

    var hh = h * cap * 0.90;
    hh += h * 0.22 * skirt * skirt * (1.0 - cap);
    hh -= h * 0.13 * gully * (1.0 - cap) * skirt;
    // The cap is never quite level — it drains toward one edge.
    hh += h * 0.045 * cap * (0.5 + 0.5 * sin(ang + seed * 1.7)) * (1.0 - d / rr);

    return vec3f(hh, max(cap, skirt * 0.7), cap);
}

/// A butte: the same idea, but tall for its width, so it reads as a needle.
fn butteField(p: vec2f, c: vec2f, r: f32, h: f32, seed: f32) -> vec3f {
    let q = p - c;
    let d = length(q);
    if (d > r * 3.2) { return vec3f(0.0); }

    let ang = atan2(q.y, q.x);
    let lobe = 1.0 + 0.20 * sin(ang * 4.0 + seed) + 0.10 * sin(ang * 9.0 + seed * 2.0);
    let rr = max(r * lobe, 0.5);

    let cap = 1.0 - smoothstep(rr * 0.80, rr, d);
    let skirt = 1.0 - smoothstep(rr, rr * 3.0, d);
    let flute = ridgedd(vec2f(ang * 8.0, d * 0.09 + seed), 2, 2.1, 0.5).x;

    var hh = h * cap;
    hh += h * 0.30 * skirt * skirt * (1.0 - cap);
    hh -= h * 0.16 * flute * (1.0 - cap) * skirt;
    return vec3f(hh, max(cap, skirt * 0.75), cap);
}

/// A mountain: ridged spurs radiating from a summit.
///
/// The spur noise is multiplied by the cone twice over, so it dies completely
/// at the foot. A ridged field that survives to the base leaves a halo of
/// jagged rubble in the sand around every peak, which reads as an artefact.
fn peakField(p: vec2f, c: vec2f, r: f32, h: f32, seed: f32) -> vec3f {
    let q = p - c;
    let d = length(q);
    if (d > r * 1.35) { return vec3f(0.0); }

    let ang = atan2(q.y, q.x);
    let lobe = 1.0 + 0.24 * sin(ang * 2.0 + seed * 1.3) + 0.13 * sin(ang * 5.0 - seed);
    let rr = max(r * lobe, 1.0);

    var t = clamp(1.0 - d / rr, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);

    let spur = ridgedd(q * 0.026 + vec2f(seed * 3.1, seed * 1.9), 4, 2.09, 0.52).x;
    let hh = h * (0.34 * t + 0.80 * t * t * (0.30 + 0.90 * spur));

    return vec3f(hh, smoothstep(0.015, 0.22, t), smoothstep(0.42, 0.92, t));
}

/// A range: a massif swept along a segment.
///
/// `peakField` makes a mountain. Five mountains in a row do not make a range —
/// they make five mountains with holes between them, and the holes are exactly
/// where a wall needs to be solid. The difference matters twice on this map:
/// the Great Rampart has to be continuous enough that the spawn slot is a
/// *gorge through it* rather than a trench beside it, and the Shield Wall has to
/// be unbroken except at the two passes, or the passes stop meaning anything.
///
/// The crest height is modulated along the run by a slow noise, so a range still
/// has summits and cols — it is a wall with a skyline, not an extruded triangle.
///
/// `taperA` / `taperB` are the lengths over which each end fades to nothing.
/// Pass 0 at a joint. Two ranges that both taper at a shared endpoint cancel
/// each other there and open a hole in the wall precisely where it is meant to
/// be continuous — which is the same mistake as tapering a canyon at a junction,
/// with the opposite sign.
///
/// Returns (height, rockMask, capMask).
fn rampartField(
    p: vec2f, a: vec2f, b: vec2f,
    halfW: f32, h: f32, seed: f32,
    taperA: f32, taperB: f32
) -> vec3f {
    let ba = b - a;
    let len = max(length(ba), 1e-4);
    let dir = ba / len;
    let nrm = vec2f(-dir.y, dir.x);
    let pa = p - a;

    let along = dot(pa, dir);
    let s = clamp(along, 0.0, len);

    // The crest line wanders off the segment, so a range never reads as ruled.
    let wander = noise2(vec2f(s * 0.0055, seed)) * halfW * 0.55;
    let lat = dot(pa, nrm) - wander;
    let over = max(0.0, max(-along, along - len));

    let w = halfW * (0.74 + 0.52 * (noise2(vec2f(s * 0.0038, seed + 3.1)) * 0.5 + 0.5));
    let d = sqrt(lat * lat + over * over);
    if (d > w * 1.15) { return vec3f(0.0); }

    let t = clamp(1.0 - d / w, 0.0, 1.0);
    // Concave, as on the peaks: a scree apron carrying a steep upper wall.
    let prof = 0.26 * t * t + 0.74 * t * t * t * t;

    var endT = 1.0;
    if (taperA > 0.0) { endT *= smoothstep(0.0, taperA, s); }
    if (taperB > 0.0) { endT *= 1.0 - smoothstep(len - taperB, len, s); }

    // Summits and cols along the crest.
    let crest = 0.52 + 0.68 * (noise2(vec2f(s * 0.0072, seed + 7.3)) * 0.5 + 0.5);

    // Spurs run *down the flanks*: compressed along the crest, stretched
    // across it, so every ridge is a buttress descending from the crest line
    // with a gully either side — the drainage a swept ridge actually has.
    // (s, lat) is already the right coordinate frame and has no polar seam.
    let warp2 = noise2(p * 0.016 + vec2f(seed * 1.7, seed * 0.9)) * 2.1;
    let spur = ridgedd(vec2f(s * 0.052 + warp2, lat * 0.011 + seed), 3, 2.11, 0.54).x;
    let crag = ridgedd(p * 0.052 + vec2f(seed * 2.7, seed * 1.3), 3, 2.09, 0.52).x;

    let flank = t * (1.0 - t) * 4.0;
    var hh = h * crest * endT * prof * (0.60 + 0.55 * spur);
    hh += h * crest * endT * (0.15 * flank * (spur - 0.45) + 0.12 * t * t * (crag - 0.40));
    // Flatten only the upper flank and the crest, not the whole footprint.
    // `t*t` reaches 0.5 halfway down a 120 m flank, and a range 900 m long then
    // deletes the dune field from a quarter of a square kilometre — which is
    // how a mountain turns into a bald plateau you can stand on and conclude
    // the desert has disappeared.
    return vec3f(hh, smoothstep(0.02, 0.24, t * endT), smoothstep(0.48, 0.94, t) * endT);
}

/// A crater: raised rim, sunken floor. Reads as a spice blow that went off
/// hard enough to move rock.
fn craterField(p: vec2f, c: vec2f, r: f32, rimH: f32, depth: f32) -> vec3f {
    let q = p - c;
    let d = length(q);
    if (d > r * 1.9) { return vec3f(0.0); }

    let ang = atan2(q.y, q.x);
    let rr = r * (1.0 + 0.11 * sin(ang * 3.0 + 1.1) + 0.06 * sin(ang * 8.0));

    // Rim: a ring centred on rr, breached on one side so the crater is
    // enterable on foot rather than being a bowl with no door.
    let ring = 1.0 - smoothstep(0.0, rr * 0.34, abs(d - rr));
    let breach = 1.0 - 0.92 * (1.0 - smoothstep(0.32, 0.9, abs(ang + 2.2)));
    let bowl = 1.0 - smoothstep(rr * 0.30, rr * 0.94, d);

    let hh = rimH * ring * ring * breach - depth * bowl * bowl;
    return vec3f(hh, max(ring * breach, bowl * 0.45), max(ring * breach, bowl));
}

/// A basin: a wide shallow depression with a floor flat enough to see across.
/// Returns (dh, flatten).
fn basinField(p: vec2f, c: vec2f, r: f32, depth: f32) -> vec2f {
    let d = length(p - c);
    if (d > r * 1.25) { return vec2f(0.0); }
    var t = clamp(1.0 - d / r, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    // 0.45, not 0.85: the Spice Bowl is a *sand* basin. Flattening it as hard
    // as a mesa cap turns the richest ground on the map into a car park.
    return vec2f(-depth * t, t * 0.45);
}

/// Fold a massif result into the accumulator.
fn addMassif(L: Land, m: vec3f) -> Land {
    var o = L;
    o.add += m.x;
    o.rock = max(o.rock, m.y);
    o.flatten = max(o.flatten, m.z);
    return o;
}

// ----------------------------------------------------------------- the map

/// The whole map, evaluated at one point.
///
/// `base` is the dune field's long swell with the dunes themselves removed —
/// the height the ground "would" be with no sand on it. Canyon floors and basin
/// bottoms are pinned relative to it, so the map's cuts follow the roll of the
/// land instead of slicing a flat plane through it.
/// The spawn slot's floor half-width. Mirrored by SLOT_HALF_WIDTH in
/// game/landmarks.js — the two must agree or the player clamps to a corridor
/// that is not where the walls are.
const SLOT_HALF_WIDTH: f32 = 7.0;

fn landform(p: vec2f, base: f32) -> Land {
    var L: Land;
    L.add = 0.0;
    L.flatten = 0.0;
    L.floorM = 0.0;
    L.floorY = base;
    L.rim = 0.0;
    L.rock = 0.0;

    // == massifs ============================================================
    //
    // Ranges accumulate by max, everything else by sum. Two range segments
    // meeting at a shared endpoint each contribute their full crest height
    // there, and summing turns every joint into a spike twice the height of the
    // wall it joins. Cones are different — a summit standing on a range should
    // add to it, and a talus skirt should pile against its neighbour's.
    var rng = vec3f(0.0);
    //
    // THE GREAT RAMPART — the wall behind the spawn. The slot canyon is cut
    // straight through it, so the first thing the player sees on turning round
    // outside is the cliff they came out of. Everything else on the map is
    // placed relative to standing at the mouth looking north.
    //
    // The crest runs east-west at z = -135, which is 55 m north of where the
    // player wakes. Walking out, the walls *rise* for the first fifty metres
    // and only then fall away — so the reveal at the mouth is preceded by the
    // most enclosed part of the walk rather than by a steady opening out.
    rng = max(rng, rampartField(p, vec2f(-430.0, -150.0), vec2f( 455.0, -170.0), 118.0, 98.0, 1.7, 150.0, 150.0));
    // Two summits standing off the wall, for a skyline with something in it.
    L = addMassif(L, peakField(p, vec2f(-255.0, -245.0), 150.0, 72.0, 4.3));
    L = addMassif(L, peakField(p, vec2f( 270.0, -260.0), 140.0, 66.0, 5.8));
    L = addMassif(L, peakField(p, vec2f(-410.0, -305.0), 130.0, 58.0, 2.9));

    // THE SHIELD WALL — the arc closing the north and east rim. Five massifs
    // with deliberate saddles between them: the gaps are Wind Gap and the
    // Eastern Stair, and they are the only ways out of the bowl on that side.
    rng = max(rng, rampartField(p, vec2f(-140.0, 615.0), vec2f( 265.0, 575.0), 112.0, 102.0, 0.6, 150.0,   0.0));
    rng = max(rng, rampartField(p, vec2f( 265.0, 575.0), vec2f( 545.0, 395.0), 118.0, 124.0, 3.4,   0.0,   0.0));
    rng = max(rng, rampartField(p, vec2f( 545.0, 395.0), vec2f( 665.0, 115.0), 106.0, 112.0, 6.1,   0.0,   0.0));
    rng = max(rng, rampartField(p, vec2f( 665.0, 115.0), vec2f( 640.0,-200.0),  98.0,  90.0, 2.2,   0.0, 160.0));
    // Two summits on the wall, so it has a profile and not just a height.
    L = addMassif(L, peakField(p, vec2f( 330.0,  530.0), 140.0,  96.0, 5.1));
    L = addMassif(L, peakField(p, vec2f( 590.0,  270.0), 125.0,  82.0, 1.4));

    // THE SISTERS — twin peaks on the north-west rim. Paired deliberately: two
    // summits of different heights are readable as a *bearing* from anywhere in
    // the bowl, which one summit is not.
    L = addMassif(L, peakField(p, vec2f(-470.0,  390.0), 150.0, 108.0, 5.2));
    L = addMassif(L, peakField(p, vec2f(-330.0,  480.0), 125.0,  86.0, 1.1));

    // SIETCH TABR — the mesa at the end of Dead Man's Cut. Its cap is the
    // flattest thing on the map and its wall is the tallest sheer face, which
    // is what makes it worth the walk.
    L = addMassif(L, mesaField(p, vec2f(-395.0, -195.0), 108.0, 74.0, 2.4));

    // TABLE ROCK — the smaller mesa north-east, over the Fork.
    L = addMassif(L, mesaField(p, vec2f( 320.0,  305.0),  80.0, 52.0, 5.5));

    // THE THUMB — a single needle, close in and directly visible from the slot
    // mouth. This is the map's first landmark and the reason the player picks a
    // direction at all instead of wandering.
    L = addMassif(L, butteField(p, vec2f( 175.0,  135.0),  20.0, 48.0, 3.8));

    // THE BONEYARD — a scatter of small buttes south-west. Cover, and a place
    // where the worm cannot get a clean run at you.
    L = addMassif(L, butteField(p, vec2f(-215.0, -395.0),  14.0, 26.0, 0.9));
    L = addMassif(L, butteField(p, vec2f(-168.0, -430.0),  11.0, 20.0, 3.3));
    L = addMassif(L, butteField(p, vec2f(-262.0, -448.0),  16.0, 31.0, 6.4));
    L = addMassif(L, butteField(p, vec2f(-120.0, -352.0),   9.0, 17.0, 1.9));

    // THE MAW — the crater west. Breached on its east side, so it is walkable.
    let cr = craterField(p, vec2f(-520.0, 55.0), 125.0, 30.0, 22.0);
    L.add += cr.x;
    L.rock = max(L.rock, cr.y);
    L.flatten = max(L.flatten, cr.z * 0.55);

    // THE SPICE BOWL — the great basin south-east. Flat, open, indefensible,
    // and where the richest spice sits. The trade is the whole point of it.
    let bs = basinField(p, vec2f(465.0, -300.0), 215.0, 19.0);
    L.add += bs.x;
    L.flatten = max(L.flatten, bs.y);

    L = addMassif(L, rng);

    // == canyons ============================================================
    //
    // THE SLOT — the spawn corridor, cut clean through the Great Rampart. Runs
    // due north from z = -185 to the mouth at z = 0. Kept straight in plan
    // (game.js clamps the player to a matching centreline) and narrow, so the
    // walls are the full 100 m of the massif above it.
    L = addCanyon(L, base, canyonRun(
        p, vec2f(0.0, -215.0), vec2f(0.0, 4.0),
        SLOT_HALF_WIDTH, 5.0, 3.0, 26.0, 26.0, 0.0
    ));

    // BONE CANYON — east out of the bowl, then south to the Spice Bowl. The
    // main road: wide enough to run, deep enough to hide wormsign.
    L = addCanyon(L, base, canyonRun(p, vec2f(  55.0,  40.0), vec2f( 195.0,  15.0), 11.0, 24.0, 9.0, 30.0, 0.0, 1.0));
    L = addCanyon(L, base, canyonRun(p, vec2f( 195.0,  15.0), vec2f( 335.0, -75.0), 12.0, 26.0, 9.0,  0.0, 0.0, 1.0));
    L = addCanyon(L, base, canyonRun(p, vec2f( 335.0, -75.0), vec2f( 430.0,-205.0), 13.0, 22.0, 8.0,  0.0, 40.0, 1.0));

    // THE FORK — the spur north off Bone Canyon, climbing to Table Rock.
    L = addCanyon(L, base, canyonRun(p, vec2f( 195.0,  15.0), vec2f( 225.0, 160.0),  8.0, 20.0, 8.0,  0.0, 0.0, 1.0));
    L = addCanyon(L, base, canyonRun(p, vec2f( 225.0, 160.0), vec2f( 285.0, 268.0),  7.0, 17.0, 7.0,  0.0, 34.0, 1.0));

    // THE SERPENT — north-west, the long one. Ends under the Sisters.
    L = addCanyon(L, base, canyonRun(p, vec2f( -45.0,  95.0), vec2f(-175.0, 200.0), 13.0, 25.0, 9.0, 34.0, 0.0, 1.0));
    L = addCanyon(L, base, canyonRun(p, vec2f(-175.0, 200.0), vec2f(-305.0, 255.0), 14.0, 27.0, 9.0,  0.0, 0.0, 1.0));
    L = addCanyon(L, base, canyonRun(p, vec2f(-305.0, 255.0), vec2f(-420.0, 345.0), 12.0, 23.0, 8.0,  0.0, 40.0, 1.0));

    // DEAD MAN'S CUT — south-west, narrow the whole way, to Sietch Tabr.
    L = addCanyon(L, base, canyonRun(p, vec2f( -85.0, -70.0), vec2f(-225.0,-115.0),  6.0, 21.0, 8.0, 26.0, 0.0, 1.0));
    L = addCanyon(L, base, canyonRun(p, vec2f(-225.0,-115.0), vec2f(-330.0,-165.0),  5.5, 23.0, 9.0,  0.0, 22.0, 1.0));

    // WIND GAP — the notch through the Shield Wall between the two northern
    // massifs. The only pass on the north rim, and it howls.
    L = addCanyon(L, base, canyonRun(p, vec2f( 155.0, 455.0), vec2f( 205.0, 640.0), 17.0, 15.0, 5.0, 55.0, 70.0, 1.0));

    // THE EASTERN STAIR — the corresponding notch on the east rim.
    L = addCanyon(L, base, canyonRun(p, vec2f( 495.0, 210.0), vec2f( 665.0, 345.0), 16.0, 13.0, 5.0, 50.0, 65.0, 1.0));

    return L;
}
