// Bakes the macro landform (broad dunes + medium drifts + rock outcrops) into a
// single-channel float texture covering the whole playable field.
//
// Baked rather than evaluated live for one reason: the CPU needs the same
// heights for character grounding, footfall placement and spell hit points, and
// reading back a GPU bake is the only way to guarantee the two never disagree.
// Re-implementing the noise in JS would drift the moment f32 and f64 rounding
// diverged, and the character would float or sink by centimetres.

#include<snowNoise>
#include<snowTerrain>

varying vUV: vec2f;

uniform worldOrigin: vec2f;
uniform worldSize: f32;
uniform windAngle: f32;
uniform heightAmp: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let p = uniforms.worldOrigin + input.vUV * uniforms.worldSize;

    // (height, authored-rock mask, canyon-floor mask) — one evaluation for all
    // three; see terrainMacroFull.
    // `mf`, not `macro` — `macro` is a WGSL *reserved word*, and the failure
    // mode of using one is the worst kind: this file alone stops compiling,
    // the bake silently never runs, and the game renders a perfectly flat
    // world with only the analytic fine ripples on it. Same trap as `patch`
    // in terrainFineFiltered.
    let mf = terrainMacroFull(p, uniforms.windAngle, uniforms.heightAmp);
    var h = mf.x;

    // Rock displaces sand upward; sand then re-accumulates on the flatter faces,
    // which the material resolves from the mask in the aux bake.
    //
    // Suppressed inside canyon floors. A scattered outcrop dropped into a 6 m
    // corridor is a wall across the only route through it, and the player is
    // clamped to the centreline down there and cannot walk round it.
    let open = 1.0 - smoothstep(0.15, 0.75, mf.z);
    let rock = rockField(p, uniforms.windAngle);
    h += rock.x * open;

    // The authored mask covers cliffs, caps and canyon lips; the outcrop mask
    // covers the scatter. Both feed the same channel — the material gates it by
    // slope on its own, so painting generously here costs nothing.
    let mask = max(rock.y * open, mf.y);

    fragmentOutputs.color = vec4f(h, mask, 0.0, 1.0);
}
