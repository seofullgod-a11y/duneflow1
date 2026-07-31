/**
 * The Deep Shelter — the cave the game now opens in.
 *
 * Story frame (v1): you wake in the abandoned shelter of a vanished tribe.
 * The water is gone, the people are gone, and the storm outside has not
 * stopped since. Glowing spice crystals mark the old path out. Follow them,
 * reach the mouth, step into the open erg — and the game proper begins.
 *
 * ## Construction
 *
 * The cave is one procedural tunnel mesh: a chain of noisy ring cross-sections
 * following the terrain from z = -68 up to the mouth at z = 0, closed at the
 * back, open at the front, normals facing inward. It uses Babylon standard
 * materials and a couple of point lights — deliberately NOT the custom WGSL
 * pipeline: the rock is static local geometry that plain materials handle
 * fine, and keeping it out of the terrain/shadow/depth systems means the
 * engine doesn't know the cave exists. The floor IS the terrain heightfield;
 * the rock is dressing plus a corridor clamp in `constrain()`.
 *
 * Crystal shards (emissive, spice-pink and amber, per the Dune Awakening
 * reference) stud the walls and carry the wayfinding: their glow gradient
 * points at the exit.
 *
 * The game asks two things of this module each frame while the phase is
 * "cave": `constrain(pos)` to keep the player inside the corridor, and
 * `isOutside(pos)` to detect the exit crossing.
 */

// Tree-shaken Babylon does not pull the default-material shaders in by
// itself; without these side-effect imports, StandardMaterial throws at first
// draw on WebGPU — which kills the whole render loop and blacks the screen.
import "@babylonjs/core/ShadersWGSL/default.vertex.js";
import "@babylonjs/core/ShadersWGSL/default.fragment.js";
import "@babylonjs/core/Shaders/default.vertex.js";
import "@babylonjs/core/Shaders/default.fragment.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { CreatePolyhedron } from "@babylonjs/core/Meshes/Builders/polyhedronBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { PointLight } from "@babylonjs/core/Lights/pointLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";

/** Tunnel runs from here to the mouth at z = MOUTH_Z. */
export const CAVE_START_Z = -68;
export const MOUTH_Z = 0;
/** Where the player wakes. */
export const SPAWN = { x: 0, z: -62 };

const RINGS = 40;
const SEGS = 16;
/** Corridor half-width the player is clamped to. */
const CLAMP_X = 2.5;

function hash(n) {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return s - Math.floor(s);
}

export class Cave {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../terrain/terrain.js").Terrain} terrain
     */
    constructor(scene, terrain) {
        this.terrain = terrain;

        // ---- lights (affect only these standard-material meshes) ---------
        const hemi = new HemisphericLight("caveHemi", new Vector3(0, 1, 0), scene);
        hemi.intensity = 0.32;
        hemi.diffuse = new Color3(0.55, 0.30, 0.22);
        hemi.groundColor = new Color3(0.12, 0.05, 0.04);

        // ---- rock material ------------------------------------------------
        const rock = new StandardMaterial("caveRock", scene);
        rock.diffuseColor = new Color3(0.34, 0.145, 0.095);
        rock.specularColor = new Color3(0.015, 0.01, 0.008);
        rock.emissiveColor = new Color3(0.085, 0.034, 0.024);
        rock.backFaceCulling = false;

        // ---- tunnel mesh --------------------------------------------------
        const positions = [];
        const indices = [];
        for (let i = 0; i <= RINGS; i++) {
            const t = i / RINGS;
            const z = CAVE_START_Z + t * (MOUTH_Z + 4 - CAVE_START_Z);
            // A gentle S-sway so the mouth is never visible from the back wall.
            const cx = Math.sin(t * Math.PI * 1.6) * 2.2;
            const floorY = terrain.heightAt(cx, z);
            // Radius: pinched shut at the back, breathing along the length,
            // flaring at the mouth.
            let r = 3.3 + Math.sin(t * 19.0 + 1.3) * 0.5 + hash(i * 3.1) * 0.5;
            if (i < 3) r *= i / 3 * 0.7 + 0.12;         // back wall
            if (t > 0.88) r *= 1.0 + (t - 0.88) * 3.2;  // mouth flare
            for (let j = 0; j < SEGS; j++) {
                const a = (j / SEGS) * Math.PI * 2;
                const wob = 1.0 + (hash(i * 57.7 + j * 9.3) - 0.5) * 0.42;
                const rx = r * wob;
                const ry = r * 0.72 * wob;
                positions.push(
                    cx + Math.cos(a) * rx,
                    floorY + 1.35 + Math.sin(a) * ry,
                    z
                );
            }
        }
        for (let i = 0; i < RINGS; i++) {
            for (let j = 0; j < SEGS; j++) {
                const j2 = (j + 1) % SEGS;
                const a = i * SEGS + j, b = i * SEGS + j2;
                const c = (i + 1) * SEGS + j, d = (i + 1) * SEGS + j2;
                indices.push(a, c, b, b, c, d);
            }
        }
        const normals = [];
        VertexData.ComputeNormals(positions, indices, normals);
        const vd = new VertexData();
        vd.positions = positions;
        vd.indices = indices;
        vd.normals = normals;
        const tunnel = new Mesh("caveTunnel", scene);
        vd.applyToMesh(tunnel);
        tunnel.material = rock;
        tunnel.isPickable = false;
        this.tunnel = tunnel;

        // ---- crystals: the wayfinding glow --------------------------------
        // Brighter and denser toward the exit, so the light itself is the
        // guide. Two colours: spice-pink shards and amber veins.
        const pink = new StandardMaterial("cavePink", scene);
        pink.emissiveColor = new Color3(1.0, 0.34, 0.52);
        pink.diffuseColor = Color3.Black();
        pink.specularColor = Color3.Black();
        const amber = new StandardMaterial("caveAmber", scene);
        amber.emissiveColor = new Color3(1.0, 0.62, 0.22);
        amber.diffuseColor = Color3.Black();
        amber.specularColor = Color3.Black();

        for (let k = 0; k < 22; k++) {
            const t = 0.12 + (k / 22) * 0.85;
            const z = CAVE_START_Z + t * (MOUTH_Z - CAVE_START_Z);
            const cx = Math.sin(t * Math.PI * 1.6) * 2.2;
            const side = hash(k * 7.7) > 0.5 ? 1 : -1;
            const floorY = terrain.heightAt(cx, z);
            const shard = CreatePolyhedron("crys" + k, {
                type: 1,
                size: 0.16 + hash(k * 3.3) * 0.30 + t * 0.18,
            }, scene);
            shard.position.set(
                cx + side * (1.6 + hash(k * 11.1) * 1.1),
                floorY + 0.5 + hash(k * 5.9) * 2.0,
                z + (hash(k * 13.7) - 0.5) * 2.0
            );
            shard.rotation.set(hash(k) * 3.14, hash(k * 2) * 3.14, hash(k * 3) * 3.14);
            shard.scaling.y = 1.7 + hash(k * 4.1) * 1.4;
            shard.material = hash(k * 17.3) > 0.4 ? pink : amber;
            shard.isPickable = false;
        }

        // Two dim warm point lights so the rock itself has form between glows.
        const l1 = new PointLight("caveL1", new Vector3(1.5, terrain.heightAt(1.5, -44) + 2.4, -44), scene);
        l1.diffuse = new Color3(1.0, 0.45, 0.30);
        l1.intensity = 14;
        const l2 = new PointLight("caveL2", new Vector3(-1.8, terrain.heightAt(-1.8, -18) + 2.6, -18), scene);
        l2.diffuse = new Color3(1.0, 0.55, 0.42);
        l2.intensity = 18;
    }

    /** Corridor centreline x at a given z. */
    _cx(z) {
        const t = (z - CAVE_START_Z) / (MOUTH_Z + 4 - CAVE_START_Z);
        return Math.sin(Math.min(Math.max(t, 0), 1) * Math.PI * 1.6) * 2.2;
    }

    /** Keep a position inside the corridor while underground. */
    constrain(pos) {
        if (pos.z >= MOUTH_Z - 1) return;
        if (pos.z < CAVE_START_Z + 3) pos.z = CAVE_START_Z + 3;
        const cx = this._cx(pos.z);
        if (pos.x < cx - CLAMP_X) pos.x = cx - CLAMP_X;
        if (pos.x > cx + CLAMP_X) pos.x = cx + CLAMP_X;
    }

    /** @returns {boolean} true once the position has crossed the mouth. */
    isOutside(pos) {
        return pos.z >= MOUTH_Z - 1;
    }
}
