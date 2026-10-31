/* eslint-env node */
"use strict";

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Headless environment setup (mirrors matter-js test/TestTools.js prepareGlobals)
// ---------------------------------------------------------------------------

function purgeMatterCache() {
    for (const key of Object.keys(require.cache)) {
        if (
            key.includes(path.sep + 'src' + path.sep) ||
            key.includes(path.sep + 'build' + path.sep) ||
            key.includes(path.sep + 'examples' + path.sep)
        ) {
            delete require.cache[key];
        }
    }
}

function setupHeadlessGlobals() {
    const frameCallbacks = [];
    let mathRandomSeed = 0;

    global.document = global.window = {
        performance: {},
        addEventListener: () => {},
        requestAnimationFrame: callback => {
            frameCallbacks.push(callback);
            return frameCallbacks.length;
        },
        cancelAnimationFrame: () => {},
        createElement: () => ({
            parentNode: {},
            width: 800,
            height: 600,
            style: {},
            addEventListener: () => {},
            setAttribute: () => {},
            getAttribute: name => ({ 'data-pixel-ratio': '1' }[name]),
            getContext: () => new Proxy({}, {
                get() { return () => {}; }
            })
        })
    };

    global.document.body = global.document.createElement();
    global.Image = function Image() {};

    Math.random = () => {
        mathRandomSeed = (mathRandomSeed * 9301 + 49297) % 233280;
        return mathRandomSeed / 233280;
    };

    global.timeNow = 0;
    global.window.performance.now = () => global.timeNow;

    global.Date = function() {
        this.toString = () => global.timeNow.toString();
        this.valueOf = () => global.timeNow;
    };
    global.Date.now = () => global.timeNow;

    return { frameCallbacks };
}

// ---------------------------------------------------------------------------
// Snapshot capture
// ---------------------------------------------------------------------------

function captureSnapshot(engine, Matter) {
    const allBodies = Matter.Composite.allBodies(engine.world);
    const allConstraints = Matter.Composite.allConstraints(engine.world);

    const extrinsics = {};
    const intrinsics = {};

    for (const body of allBodies) {
        assert.ok(Number.isFinite(body.position.x) && Number.isFinite(body.position.y),
            `Body ${body.id} position is finite`);
        assert.ok(Number.isFinite(body.velocity.x) && Number.isFinite(body.velocity.y),
            `Body ${body.id} velocity is finite`);
        assert.ok(Number.isFinite(body.angle), `Body ${body.id} angle is finite`);

        extrinsics[body.id] = {
            x: Number(body.position.x.toPrecision(8)),
            y: Number(body.position.y.toPrecision(8)),
            vx: Number(body.velocity.x.toPrecision(8)),
            vy: Number(body.velocity.y.toPrecision(8)),
            angle: Number(body.angle.toPrecision(8))
        };

        intrinsics[body.id] = {
            mass: Number(body.mass.toPrecision(6)),
            inertia: body.inertia === Infinity ? 'Infinity' : Number(body.inertia.toPrecision(6)),
            area: Number(body.area.toPrecision(6)),
            friction: body.friction,
            restitution: body.restitution,
            isStatic: body.isStatic
        };
    }

    return {
        bodyCount: allBodies.length,
        constraintCount: allConstraints.length,
        timestamp: Number(engine.timing.timestamp.toPrecision(8)),
        extrinsics,
        intrinsics
    };
}

function runScenario(exampleName, useSourceMain, updates = 60) {
    // Globals MUST be installed before requiring Matter, so Render captures our mock
    const { frameCallbacks } = setupHeadlessGlobals();
    purgeMatterCache();

    const Matter = useSourceMain
        ? require('../src/module/main')
        : require('../build/matter');

    // Reset determinism controls
    Matter.Common._nextId = 0;
    Matter.Common._seed = 0;
    Matter.Common.info = Matter.Common.warn = () => {};
    // Replace canvas rendering with a no-op so we benchmark pure physics
    Matter.Render.world = () => {};

    global.Matter = Matter;

    const Examples = require('../examples/index');
    const instance = Examples[exampleName]();
    const { engine, runner } = instance;

    let totalStepNs = 0;
    let maxOverlap = 0;

    for (let step = 0; step < updates; step++) {
        global.timeNow = (step + 1) * runner.delta;

        const t0 = process.hrtime.bigint();
        Matter.Engine.update(engine, runner.delta);
        const t1 = process.hrtime.bigint();
        totalStepNs += Number(t1 - t0);

        for (const pair of engine.pairs.list) {
            if (pair.isActive && !pair.isSensor) {
                const overlap = Math.max(pair.collision.depth - pair.slop, 0);
                if (overlap > maxOverlap) maxOverlap = overlap;
            }
        }
    }

    frameCallbacks.length = 0;

    const snapshot = captureSnapshot(engine, Matter);
    snapshot.avgStepMs = (totalStepNs / 1e6) / updates;
    snapshot.maxOverlap = maxOverlap;

    return snapshot;
}

// ---------------------------------------------------------------------------
// Scenario catalogue
// ---------------------------------------------------------------------------

// Two different reasons used to share one exclusion list. They are not the same
// problem and must not be handled the same way:
//
// (a) Examples that cannot run headless in Node at all. Both fetch external
//     assets at call time (`svg/icons/*.svg`, `svg/terrain.svg`) through relative
//     URLs. Node has no document base URL, so `example.svg()` rejects with
//     ERR_INVALID_URL - an unhandled rejection that kills the whole test process -
//     and `example.terrain()` warns and builds 0 bodies. No dependency can fix
//     this, so they are excluded unconditionally.
const NOT_NODE_RUNNABLE = ['svg', 'terrain'];

// (b) Examples that only need the optional `poly-decomp` package. When it is
//     installed (the CI job that runs `pnpm install`, or any local dev tree) they
//     are covered; when it is absent (the dependency-free job) they are skipped
//     instead of masquerading as failures.
const OPTIONAL_DEP_EXAMPLES = ['concave', 'raycasting'];

function isResolvable(specifier) {
    try {
        require.resolve(specifier);
        return true;
    } catch (err) {
        return false;
    }
}

const HAS_POLY_DECOMP = isResolvable('poly-decomp');
const COVERED_OPTIONAL = HAS_POLY_DECOMP ? OPTIONAL_DEP_EXAMPLES : [];

const ExamplesIndex = require('../examples/index');
const CORE_EXAMPLES = Object.keys(ExamplesIndex).filter(
    name => !NOT_NODE_RUNNABLE.includes(name) && !OPTIONAL_DEP_EXAMPLES.includes(name)
);
const SMOKE_EXAMPLES = CORE_EXAMPLES.concat(COVERED_OPTIONAL);

// Scenes used for the cross-build deterministic regression comparison
const REGRESSION_TARGETS = [
    'stack', 'circleStack', 'pyramid', 'newtonsCradle',
    'compound', 'compoundStack', 'chains', 'bridge', 'car', 'catapult',
    'cloth', 'constraints', 'doublePendulum', 'friction', 'staticFriction',
    'restitution', 'sleeping', 'remove', 'slingshot', 'wreckingBall'
].concat(COVERED_OPTIONAL);

// Scenes allowed to diverge between src/ and the committed release artifact, and why:
// - 'compound'  : F1, src applies the parallel axis theorem to compound inertia,
//                 the stale build/matter.js artifact does not (see Finding F1 test).
// - 'remove'    : intentional; the wake-on-lost-contact fix (sleeping bodies wake
//                 when a contact ends, e.g. a support body is removed) changes this
//                 example's trajectory inside the 150-step window.
// - 'concave' / 'raycasting' : F1 again. Both build concave bodies through
//                 Bodies.fromVertices / Common.setDecomp, so the parallel axis
//                 theorem applies to them exactly like 'compound'. Measured
//                 2026-10-31 on this tree: intrinsic AND extrinsic differ at both
//                 60 and 150 steps in both scenes (28 and 53 bodies respectively).
//                 Only present when poly-decomp is installed.
// Everything else - including 'sleeping', the other enableSleeping example - stays
// bit-identical: the sleeping fixes only fire in the pathological cases L3 covers.
const KNOWN_DIVERGENT = ['compound', 'remove'].concat(COVERED_OPTIONAL);

describe('L4: E2E Deterministic Regression & Stress Benchmarks', () => {

    describe(`1. Full-Suite Smoke & NaN/Infinity Invariant Checks (${SMOKE_EXAMPLES.length} Scenes x 60 Steps)`, () => {
        test(`All ${SMOKE_EXAMPLES.length} runnable examples execute 60 steps without throwing or producing NaN coordinates`, () => {
            const summary = [];
            for (const name of SMOKE_EXAMPLES) {
                const snap = runScenario(name, true, 60);
                // A scene that stops building a world still satisfies "did not
                // throw, coordinates are finite" - that is how `terrain` used to
                // pass with 0 bodies. An empty world must never look green.
                assert.ok(snap.bodyCount > 0,
                    `Example '${name}' built 0 bodies - an empty world must not pass as a smoke test`);
                summary.push({
                    name,
                    bodies: snap.bodyCount,
                    constraints: snap.constraintCount,
                    avgStepMs: Number(snap.avgStepMs.toFixed(3))
                });
            }
            assert.equal(summary.length, SMOKE_EXAMPLES.length);
            console.log(`\n[L4 Smoke] ${summary.length} scenes passed, total bodies simulated: ` +
                summary.reduce((a, b) => a + b.bodies, 0));
            // Make the coverage gap visible instead of letting a green run imply
            // every example was exercised.
            console.log(COVERED_OPTIONAL.length
                ? `[L4 Coverage] poly-decomp present: ${COVERED_OPTIONAL.join(', ')} included in smoke + cross-build`
                : `[L4 Coverage] poly-decomp MISSING: ${OPTIONAL_DEP_EXAMPLES.join(', ')} skipped ` +
                  `(run \`pnpm install\` or the installing CI job to cover them)`);
            console.log(`[L4 Coverage] not Node-runnable, excluded by design: ${NOT_NODE_RUNNABLE.join(', ')} ` +
                `(asset fetch; same boundary as upstream test/Examples.spec.js excludeExamples)`);
        });
    });

    describe('2. Same-Version Deterministic Regression (repeat-run reproducibility)', () => {
        test(`Two independent runs of the same engine build produce bit-identical extrinsics across ${REGRESSION_TARGETS.length} scenes`, () => {
            for (const name of REGRESSION_TARGETS) {
                const runA = runScenario(name, true, 60);
                const runB = runScenario(name, true, 60);

                assert.deepEqual(runA.extrinsics, runB.extrinsics,
                    `Non-deterministic trajectory in example '${name}' between two identical runs`);
                assert.deepEqual(runA.intrinsics, runB.intrinsics,
                    `Non-deterministic intrinsic properties in example '${name}'`);
                assert.equal(runA.timestamp, runB.timestamp);
            }
        });
    });

    describe('3. Cross-Build Deterministic Regression (src/module/main.js vs committed build/matter.js)', () => {
        test(`Intrinsic + extrinsic state matches exactly across ${REGRESSION_TARGETS.length - KNOWN_DIVERGENT.length} of ${REGRESSION_TARGETS.length} scenes (150-step window)`, () => {
            const diverged = [];
            for (const name of REGRESSION_TARGETS) {
                const srcSnap = runScenario(name, true, 150);
                const buildSnap = runScenario(name, false, 150);

                const intrinsicMatch =
                    JSON.stringify(srcSnap.intrinsics) === JSON.stringify(buildSnap.intrinsics);
                const extrinsicMatch =
                    JSON.stringify(srcSnap.extrinsics) === JSON.stringify(buildSnap.extrinsics);

                if (!intrinsicMatch || !extrinsicMatch) {
                    diverged.push(name);
                    continue;
                }

                assert.deepEqual(srcSnap.intrinsics, buildSnap.intrinsics,
                    `Intrinsic mismatch in example '${name}' between src/ and build/matter.js`);
                assert.deepEqual(srcSnap.extrinsics, buildSnap.extrinsics,
                    `Extrinsic trajectory drift in example '${name}' after 150 steps`);
            }

            // Only the two compound-body scenes are allowed to diverge, and they must be the exact set
            assert.deepEqual(diverged.sort(), KNOWN_DIVERGENT.slice().sort(),
                `Unexpected set of diverging scenes: ${diverged.join(', ')}`);
        });

        test('Finding F1: src/ applies the parallel axis theorem to compound-body inertia, build/matter.js does not', () => {
            const srcSnap = runScenario('compound', true, 60);
            const buildSnap = runScenario('compound', false, 60);

            // Body id 8 is the compound (multi-part) body in the `compound` example
            const srcInertia = srcSnap.intrinsics['8'].inertia;
            const buildInertia = buildSnap.intrinsics['8'].inertia;

            // src/ Body._totalProperties adds  sum(part.mass * |part.position - centre|^2)
            // build/matter.js only sums  sum(part.inertia)
            assert.ok(srcInertia > buildInertia * 5,
                `Expected src inertia (${srcInertia}) to be far greater than build inertia (${buildInertia})`);

            // Mass / area / friction / restitution must remain identical (only inertia changed)
            assert.equal(srcSnap.intrinsics['8'].mass, buildSnap.intrinsics['8'].mass);
            assert.equal(srcSnap.intrinsics['8'].area, buildSnap.intrinsics['8'].area);
            assert.equal(srcSnap.intrinsics['8'].friction, buildSnap.intrinsics['8'].friction);
            assert.equal(srcSnap.intrinsics['8'].restitution, buildSnap.intrinsics['8'].restitution);

            // The single-part bodies must be completely unaffected
            assert.deepEqual(srcSnap.intrinsics['3'], buildSnap.intrinsics['3']);
            assert.deepEqual(srcSnap.intrinsics['10'], buildSnap.intrinsics['10']);

            console.log(`\n[L4 Finding F1] compound body inertia: src=${srcInertia} vs build=${buildInertia} ` +
                `(ratio ${(srcInertia / buildInertia).toFixed(2)}x)`);
        });
    });

    describe('4. High-Load Stress Benchmarks & Bundle Size Verification', () => {
        test('stress / stress2 / stress3 / stress4 sustained-load benchmark with overlap & bundle size checks', () => {
            const benchmarks = {};

            for (const scene of ['stress', 'stress2', 'stress3', 'stress4']) {
                const repeats = 2;
                const updates = 60;
                const runs = [];

                for (let r = 0; r < repeats; r++) {
                    if (global.gc) global.gc();
                    const memBefore = process.memoryUsage().heapUsed;
                    const snap = runScenario(scene, true, updates);
                    const memAfter = process.memoryUsage().heapUsed;

                    runs.push({
                        bodies: snap.bodyCount,
                        avgStepMs: snap.avgStepMs,
                        maxOverlap: snap.maxOverlap,
                        heapDeltaKB: Math.max(0, (memAfter - memBefore) / 1024)
                    });
                }

                const meanStepMs = runs.reduce((acc, x) => acc + x.avgStepMs, 0) / repeats;
                benchmarks[scene] = {
                    bodies: runs[0].bodies,
                    meanStepMs: Number(meanStepMs.toFixed(3)),
                    maxOverlap: Number(runs[0].maxOverlap.toFixed(3))
                };

                assert.ok(Number.isFinite(meanStepMs) && meanStepMs > 0);
                // Overlap must stay bounded: a healthy solver keeps penetration under a few px
                assert.ok(runs[0].maxOverlap < 50,
                    `${scene} penetration exceeded 50px (${runs[0].maxOverlap.toFixed(2)})`);
            }

            console.log('\n[L4 Stress Benchmark Summary (60 steps x 2 repeats)]:',
                JSON.stringify(benchmarks, null, 2));

            const buildSizeKB = fs.statSync(path.resolve(__dirname, '../build/matter.js')).size / 1024;
            const minSizeKB = fs.statSync(path.resolve(__dirname, '../build/matter.min.js')).size / 1024;
            console.log(`[L4 Bundle Size]: matter.js = ${buildSizeKB.toFixed(2)} KB, matter.min.js = ${minSizeKB.toFixed(2)} KB`);

            assert.ok(minSizeKB > 50 && minSizeKB < 150,
                `Expected minified bundle between 50KB and 150KB, got ${minSizeKB.toFixed(2)}KB`);
        });
    });
});
