"use strict";

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const Matter = require('../src/module/main');
const {
    Vector,
    Vertices,
    Bounds,
    Axes,
    Body,
    Bodies,
    Composite,
    Engine,
    Detector,
    Collision,
    Resolver,
    Constraint
} = Matter;

// Helper for floating-point comparison
function assertClose(actual, expected, tolerance = 1e-6, message = '') {
    const diff = Math.abs(actual - expected);
    assert.ok(
        diff <= tolerance,
        `${message ? message + ': ' : ''}expected ${actual} to be within ${tolerance} of ${expected} (diff: ${diff})`
    );
}

describe('L1: Geometry & Vector Primitives (Unit Isolation)', () => {

    describe('Matter.Vector', () => {
        test('normalise handles zero vector without NaN', () => {
            const zero = Vector.create(0, 0);
            const norm = Vector.normalise(zero);
            assert.equal(norm.x, 0);
            assert.equal(norm.y, 0);
            assert.ok(!Number.isNaN(norm.x) && !Number.isNaN(norm.y));
        });

        test('rotate and rotateAbout preserve magnitude and orthogonality', () => {
            const v = Vector.create(3, 4);
            const r90 = Vector.rotate(v, Math.PI / 2);
            assertClose(Vector.magnitude(r90), 5, 1e-12);
            assertClose(Vector.dot(v, r90), 0, 1e-12);

            const pivot = Vector.create(10, -5);
            const r360 = Vector.rotateAbout(v, Math.PI * 2, pivot);
            assertClose(r360.x, v.x, 1e-12);
            assertClose(r360.y, v.y, 1e-12);
        });

        test('div by zero behaviour (documented IEEE-754 Infinity vs NaN)', () => {
            const v = Vector.create(1, 0);
            const res = Vector.div(v, 0);
            assert.equal(res.x, Infinity);
            assert.ok(Number.isNaN(res.y));
        });
    });

    describe('Matter.Vertices', () => {
        test('area, centre and inertia of a known 10x10 square', () => {
            const pts = [
                { x: -5, y: -5 },
                { x: 5, y: -5 },
                { x: 5, y: 5 },
                { x: -5, y: 5 }
            ];
            const verts = Vertices.create(pts, {});
            assertClose(Vertices.area(verts, false), 100, 1e-9);

            const centre = Vertices.centre(verts);
            assertClose(centre.x, 0, 1e-9);
            assertClose(centre.y, 0, 1e-9);

            // Analytical moment of inertia of square of side a=10, mass=12 about centre: I = m * (a^2 + a^2) / 12 = 12 * 200 / 12 = 200
            const inertia = Vertices.inertia(verts, 12);
            assertClose(inertia, 200, 1e-9);
        });

        test('degenerate collinear vertices: isConvex returns null and centre falls back to a finite mean (no NaN)', () => {
            const collinear = Vertices.create([
                { x: 0, y: 0 },
                { x: 5, y: 0 },
                { x: 10, y: 0 }
            ], {});
            assert.equal(Vertices.area(collinear), 0);
            assert.equal(Vertices.isConvex(collinear), null);

            // Regression: zero-area input used to divide by 6 * area = 0 and
            // return { x: NaN, y: NaN }, poisoning any body built from it.
            const centre = Vertices.centre(collinear);
            assert.ok(Number.isFinite(centre.x) && Number.isFinite(centre.y),
                'Collinear zero-area vertices must not produce a NaN centroid');
            assertClose(centre.x, 5, 1e-9, 'Degenerate centroid falls back to the vertex mean');
            assertClose(centre.y, 0, 1e-9);
        });

        test('isConvex distinguishes convex, concave, and <3 vertex sets', () => {
            const convex = Vertices.create([
                { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }
            ], {});
            const concave = Vertices.create([
                { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 3, y: 3 }, { x: 10, y: 10 }, { x: 0, y: 10 }
            ], {});
            const twoPts = Vertices.create([{ x: 0, y: 0 }, { x: 1, y: 1 }], {});

            assert.equal(Vertices.isConvex(convex), true);
            assert.equal(Vertices.isConvex(concave), false);
            assert.equal(Vertices.isConvex(twoPts), null);
        });

        test('contains accurately checks interior, boundary, and exterior points', () => {
            const sq = Vertices.create([
                { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }
            ], {});
            assert.equal(Vertices.contains(sq, { x: 5, y: 5 }), true);
            assert.equal(Vertices.contains(sq, { x: 0, y: 5 }), true); // On edge
            assert.equal(Vertices.contains(sq, { x: 10.0001, y: 5 }), false);
        });
    });

    describe('Matter.Bounds & Matter.Axes', () => {
        test('Bounds.update extends AABB along velocity vector', () => {
            const verts = Vertices.create([
                { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }
            ], {});
            const bounds = Bounds.create(verts);
            assert.deepEqual(bounds, { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } });

            Bounds.update(bounds, verts, { x: 5, y: -3 });
            assert.equal(bounds.min.x, 0);
            assert.equal(bounds.max.x, 15);
            assert.equal(bounds.min.y, -3);
            assert.equal(bounds.max.y, 10);
        });

        test('Axes.fromVertices deduplicates parallel edges of a rectangle into 2 unique axes', () => {
            const rect = Vertices.create([
                { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }
            ], {});
            const axes = Axes.fromVertices(rect);
            assert.equal(axes.length, 2);
            assertClose( Math.abs(Vector.dot(axes[0], axes[1])), 0, 1e-6);
        });
    });
});

describe('L2: Collision Detection & Constraint/Impulse Solving (Minimal Repros)', () => {

    describe('Matter.Collision & Matter.Detector (Broadphase + Narrowphase SAT)', () => {
        test('exact penetration depth, normal, and 2 support points for edge-on-edge overlap', () => {
            const boxA = Bodies.rectangle(0, 0, 20, 20);
            const boxB = Bodies.rectangle(18, 0, 20, 20); // 2px overlap along X

            const col = Collision.collides(boxA, boxB);
            assert.ok(col !== null && col.collided);
            assertClose(col.depth, 2, 1e-6);
            assertClose(Math.abs(col.normal.x), 1, 1e-6);
            assertClose(col.normal.y, 0, 1e-6);
            assert.equal(col.supportCount, 2);
        });

        test('Collision.collides shared _supports mutation hazard between consecutive calls', () => {
            const b1 = Bodies.rectangle(0, 0, 20, 20);
            const b2 = Bodies.rectangle(15, 0, 20, 20);
            const b3 = Bodies.rectangle(0, 100, 20, 20);
            const b4 = Bodies.rectangle(15, 100, 20, 20);

            const col1 = Collision.collides(b1, b2);
            const firstSupportsSnapshot = col1.supports.slice(0, col1.supportCount).map(v => ({ x: v.x, y: v.y }));

            const col2 = Collision.collides(b3, b4);
            // Verify whether col1.supports array elements were overwritten by col2
            const afterSecondCall = col1.supports.slice(0, col1.supportCount).map(v => ({ x: v.x, y: v.y }));
            assert.deepEqual(afterSecondCall, firstSupportsSnapshot, 'col1.supports should not be mutated by subsequent Collision.collides');

            // Verify zero-containment fallback (diamond crossing square without vertex containment):
            // Collision._findSupports returns shared module-scoped _supports array!
            const crossA = Bodies.rectangle(0, 0, 40, 10);
            const crossB = Bodies.rectangle(0, 0, 10, 40);
            const crossCol = Collision.collides(crossA, crossB);
            assert.equal(crossCol.supportCount, 1, 'Zero vertex containment falls back to 1 support point');
        });

        test('Detector respects collisionFilter (category, mask, group)', () => {
            const a = Bodies.rectangle(0, 0, 20, 20, {
                collisionFilter: { group: -1, category: 0x0001, mask: 0xFFFF }
            });
            const b = Bodies.rectangle(5, 0, 20, 20, {
                collisionFilter: { group: -1, category: 0x0001, mask: 0xFFFF }
            });
            // Negative shared group never collides
            assert.equal(Detector.canCollide(a.collisionFilter, b.collisionFilter), false);

            const detector = Detector.create({ bodies: [a, b] });
            assert.equal(Detector.collisions(detector).length, 0);
        });
    });

    describe('Matter.Resolver (Impulse, Restitution, Friction & Tunneling)', () => {
        test('1D head-on elastic collision (restitution = 1, zero friction/air) conserves momentum', () => {
            const engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
            const ballA = Bodies.circle(-30, 0, 10, {
                restitution: 1,
                friction: 0,
                frictionAir: 0,
                frictionStatic: 0,
                slop: 0
            });
            const ballB = Bodies.circle(30, 0, 10, {
                restitution: 1,
                friction: 0,
                frictionAir: 0,
                frictionStatic: 0,
                slop: 0
            });

            Body.setVelocity(ballA, { x: 5, y: 0 });
            Body.setVelocity(ballB, { x: 0, y: 0 });

            const initialMomentum = ballA.mass * ballA.velocity.x + ballB.mass * ballB.velocity.x;
            Composite.add(engine.world, [ballA, ballB]);

            for (let step = 0; step < 20; step++) {
                Engine.update(engine, 1000 / 60);
            }

            const finalMomentum = ballA.mass * ballA.velocity.x + ballB.mass * ballB.velocity.x;
            assertClose(finalMomentum, initialMomentum, 1e-4, 'Total linear momentum must be conserved');
            assert.ok(ballB.velocity.x > 4.5, `Expected ballB to pick up velocity, got ${ballB.velocity.x}`);
            assert.ok(Math.abs(ballA.velocity.x) < 0.5, `Expected ballA to nearly stop, got ${ballA.velocity.x}`);
        });

        test('Static vs Dynamic friction threshold on flat surface', () => {
            function runWithHorizontalForce(forceX, friction) {
                const engine = Engine.create({ gravity: { x: 0, y: 1, scale: 0.001 } });
                const ground = Bodies.rectangle(0, 50, 400, 20, { isStatic: true, friction: friction, frictionStatic: 1 });
                const block = Bodies.rectangle(0, 30, 20, 20, { friction: friction, frictionStatic: 1, frictionAir: 0 });
                Composite.add(engine.world, [ground, block]);

                // Let settle for 30 steps
                for (let i = 0; i < 30; i++) Engine.update(engine, 16.666);
                const startX = block.position.x;

                // Apply horizontal force for 20 steps
                for (let i = 0; i < 20; i++) {
                    Body.applyForce(block, block.position, { x: forceX, y: 0 });
                    Engine.update(engine, 16.666);
                }
                return block.position.x - startX;
            }

            const highFrictionDisp = runWithHorizontalForce(0.0005, 0.9);
            const zeroFrictionDisp = runWithHorizontalForce(0.0005, 0.0);
            assert.ok(zeroFrictionDisp > highFrictionDisp + 1, `Zero friction displacement (${zeroFrictionDisp}) should exceed high friction (${highFrictionDisp})`);
        });

        test('High-speed tunneling threshold against thin static barrier (Discrete CCD boundary) + validated sub-stepping mitigation', () => {
            // Wall thickness = 4px at x = 50 (spans x: 48..52)
            // Bullet radius = 4px starting at x = 0
            function bulletPassesWall(speedPxPerStep, substeps = 1) {
                const engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
                const wall = Bodies.rectangle(50, 0, 4, 200, { isStatic: true });
                const bullet = Bodies.circle(0, 0, 4, { frictionAir: 0, restitution: 0 });
                Body.setVelocity(bullet, { x: speedPxPerStep, y: 0 });
                Composite.add(engine.world, [wall, bullet]);

                for (let i = 0; i < 10 * substeps; i++) {
                    Engine.update(engine, 16.666 / substeps);
                }
                return bullet.position.x > 55; // true if tunneled through wall
            }

            assert.equal(bulletPassesWall(6), false, 'Moderate speed (6px/step) should be stopped by 4px wall');
            assert.equal(bulletPassesWall(40), true, 'Extreme speed (40px/step > wall thickness + diameter) tunnels through in discrete step');

            // Known limitation of discrete collision detection (no CCD).
            // Validated mitigation: sub-stepping keeps the per-substep displacement
            // small enough for the swept bounds to catch the wall.
            assert.equal(bulletPassesWall(40, 8), false, 'Sub-stepping 8x mitigates tunneling at 40px/step');
        });
    });

    describe('Matter.Constraint & Compound Bodies', () => {
        test('Compound body shifts centre of mass and sums mass/inertia accurately (parallel axis theorem)', () => {
            const partA = Bodies.rectangle(0, 0, 20, 20, { density: 0.001 });
            const partB = Bodies.rectangle(40, 0, 20, 20, { density: 0.001 });
            const expectedMass = partA.mass + partB.mass;

            const compound = Body.create({ parts: [partA, partB] });
            assertClose(compound.mass, expectedMass, 1e-6);
            assertClose(compound.position.x, 20, 1e-6);
            assertClose(compound.position.y, 0, 1e-6);

            // Parallel axis theorem: I_total = sum(I_part + m_part * d_part^2)
            // where d_part is the distance from the part centre to the compound centre.
            // Regression: the release build (build/matter.js) omits the m * d^2 term,
            // underestimating compound inertia (see L4 finding F1).
            const dA2 = Math.pow(partA.position.x - compound.position.x, 2)
                + Math.pow(partA.position.y - compound.position.y, 2);
            const dB2 = Math.pow(partB.position.x - compound.position.x, 2)
                + Math.pow(partB.position.y - compound.position.y, 2);
            const expectedInertia = (partA.inertia + partA.mass * dA2)
                + (partB.inertia + partB.mass * dB2);

            assertClose(compound.inertia, expectedInertia, 1e-6,
                'Compound inertia must include the parallel axis theorem offset term');
            assert.ok(compound.inertia > partA.inertia + partB.inertia,
                'Offset term must make compound inertia larger than the naive sum');
        });

        test('Constraint with extreme mass ratio (1:1000) and stiffness = 1 remains finite without NaN explosion', () => {
            const engine = Engine.create({ gravity: { x: 0, y: 1, scale: 0.001 } });
            const heavy = Bodies.circle(0, 0, 50, { density: 1.0, isStatic: false });
            const light = Bodies.circle(100, 0, 5, { density: 0.001, isStatic: false });
            const link = Constraint.create({
                bodyA: heavy,
                bodyB: light,
                length: 100,
                stiffness: 1
            });

            Composite.add(engine.world, [heavy, light, link]);

            for (let i = 0; i < 60; i++) {
                Engine.update(engine, 16.666);
            }

            assert.ok(Number.isFinite(light.position.x) && Number.isFinite(light.position.y));
            assert.ok(Number.isFinite(heavy.position.x) && Number.isFinite(heavy.position.y));
            const finalDist = Vector.magnitude(Vector.sub(light.position, heavy.position));
            assertClose(finalDist, 100, 2.0, 'Constraint length should remain close to target 100px');
        });

        test('Regression: Constraint.create keeps an explicit stiffness of 0 instead of coercing it to 1', () => {
            const a = Bodies.circle(0, 0, 10);
            const b = Bodies.circle(50, 0, 10);
            const zeroStiffConstraint = Constraint.create({
                bodyA: a,
                bodyB: b,
                length: 50,
                stiffness: 0
            });
            // Regression: the old `constraint.stiffness || default` treated 0 as falsy
            // and silently replaced an explicitly disabled constraint with stiffness 1.
            assert.equal(zeroStiffConstraint.stiffness, 0, 'Explicit stiffness: 0 must be preserved');

            // and a zero-stiffness constraint must apply no force at all
            const engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
            Body.setPosition(b, { x: 100, y: 0 });
            Composite.add(engine.world, [a, b, zeroStiffConstraint]);
            for (let i = 0; i < 30; i++) Engine.update(engine, 16.666);
            assertClose(Vector.magnitude(Vector.sub(b.position, a.position)), 100, 0.5,
                'stiffness: 0 must not pull the bodies toward the rest length');
        });

        test('Bug/Quirk exposure: Vector.create(NaN, NaN) falls back to (0, 0) via the x || 0 default', () => {
            const vNan = Vector.create(NaN, NaN);
            assert.deepEqual(vNan, { x: 0, y: 0 });
        });
    });
});
