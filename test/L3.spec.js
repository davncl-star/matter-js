"use strict";

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const Matter = require('../src/module/main');
const {
    Body,
    Bodies,
    Composite,
    Engine,
    Events,
    Sleeping,
    Pair,
    Pairs
} = Matter;

describe('L3: State Machine, Sleeping Lifecycle, Cache & Event Ordering', () => {

    describe('Matter.Sleeping & Wakeup Propagation', () => {
        test('Body transitions to sleep after sleepThreshold frames and fires sleepStart / sleepEnd events', () => {
            const engine = Engine.create({
                enableSleeping: true,
                gravity: { x: 0, y: 0, scale: 0 }
            });
            const box = Bodies.rectangle(0, 0, 20, 20, { sleepThreshold: 15 });
            Composite.add(engine.world, box);

            let sleepStarted = 0;
            let sleepEnded = 0;
            Events.on(box, 'sleepStart', () => { sleepStarted++; });
            Events.on(box, 'sleepEnd', () => { sleepEnded++; });

            for (let i = 0; i < 20; i++) {
                Engine.update(engine, 16.666);
            }

            assert.equal(box.isSleeping, true);
            assert.equal(sleepStarted, 1);

            // Apply force -> should wake up on next update
            Body.applyForce(box, box.position, { x: 0.05, y: 0 });
            Engine.update(engine, 16.666);

            assert.equal(box.isSleeping, false);
            assert.equal(sleepEnded, 1);
        });

        test('Collision with fast moving body wakes up sleeping target', () => {
            const engine = Engine.create({
                enableSleeping: true,
                gravity: { x: 0, y: 0, scale: 0 }
            });
            const target = Bodies.circle(50, 0, 15, { sleepThreshold: 10, frictionAir: 0 });
            const striker = Bodies.circle(0, 0, 15, { frictionAir: 0 });

            Composite.add(engine.world, [target]);
            for (let i = 0; i < 15; i++) Engine.update(engine, 16.666);
            assert.equal(target.isSleeping, true);

            Composite.add(engine.world, [striker]);
            Body.setVelocity(striker, { x: 8, y: 0 });

            for (let i = 0; i < 10; i++) Engine.update(engine, 16.666);
            assert.equal(target.isSleeping, false);
            assert.ok(target.velocity.x > 1, 'Target should be awake and moving');
        });

        test('Regression: removing the lower support wakes the upper sleeping body so it falls (no floating deadlock)', () => {
            const engine = Engine.create({
                enableSleeping: true,
                gravity: { x: 0, y: 1, scale: 0.001 }
            });

            const ground = Bodies.rectangle(0, 100, 200, 20, { isStatic: true });
            const supportBox = Bodies.rectangle(0, 80, 20, 20, { sleepThreshold: 15 });
            const topBox = Bodies.rectangle(0, 60, 20, 20, { sleepThreshold: 15 });

            Composite.add(engine.world, [ground, supportBox, topBox]);

            // Let stack settle and fall asleep
            for (let i = 0; i < 120; i++) {
                Engine.update(engine, 16.666);
            }
            assert.equal(supportBox.isSleeping, true);
            assert.equal(topBox.isSleeping, true);
            const restingY = topBox.position.y;

            // Remove the support box underneath topBox
            Composite.remove(engine.world, supportBox);

            // Regression: the upper body used to stay asleep and float in mid-air
            // forever. Losing its last contact must wake it on the very next update.
            Engine.update(engine, 16.666);
            assert.equal(topBox.isSleeping, false, 'Upper body must wake once its support is removed');

            for (let i = 0; i < 59; i++) {
                Engine.update(engine, 16.666);
            }
            assert.ok(topBox.position.y > restingY + 10,
                `Upper body must fall after losing support (y: ${topBox.position.y}, was ${restingY})`);
        });
    });

    describe('Matter.Pairs Cache Lifecycle & Leak Detection', () => {
        test('Normal separation cleans up pairs.table and pairs.list when bodies are awake', () => {
            const engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
            const a = Bodies.circle(0, 0, 15);
            const b = Bodies.circle(10, 0, 15);
            Composite.add(engine.world, [a, b]);

            Engine.update(engine, 16.666);
            assert.equal(engine.pairs.list.length, 1);
            assert.equal(Object.keys(engine.pairs.table).length, 1);

            // Move bodies apart while awake (sleepCounter === 0)
            Body.setPosition(b, { x: 200, y: 0 });
            Engine.update(engine, 16.666);

            assert.equal(engine.pairs.list.length, 0);
            assert.equal(Object.keys(engine.pairs.table).length, 0);
        });

        test('Regression: Composite.remove and Composite.clear both release cached collision pairs (no sleepCounter leak)', () => {
            const engine = Engine.create({
                enableSleeping: true,
                gravity: { x: 0, y: 0, scale: 0 }
            });

            // 1. Composite.remove resets sleepCounter = 0 so Pairs.update cleans up on next tick
            const a1 = Bodies.rectangle(0, 0, 20, 20, { sleepThreshold: 15, isSensor: true });
            const b1 = Bodies.rectangle(10, 0, 20, 20, { sleepThreshold: 15 });
            Composite.add(engine.world, [a1, b1]);
            for (let i = 0; i < 5; i++) Engine.update(engine, 16.666);
            assert.equal(engine.pairs.list.length, 1);

            Composite.remove(engine.world, [a1, b1]);
            assert.equal(a1.sleepCounter, 0, 'Composite.removeBody explicitly resets sleepCounter = 0');
            Engine.update(engine, 16.666);
            assert.equal(engine.pairs.list.length, 0);

            // 2. Composite.clear must do the same (it used to leak every sleeping pair
            //    forever: bodies.length = 0 without resetting sleepCounter kept the
            //    Pairs retention condition permanently true)
            const a2 = Bodies.rectangle(0, 0, 20, 20, { sleepThreshold: 15, isSensor: true });
            const b2 = Bodies.rectangle(10, 0, 20, 20, { sleepThreshold: 15 });
            Composite.add(engine.world, [a2, b2]);
            for (let i = 0; i < 5; i++) Engine.update(engine, 16.666);
            assert.ok(a2.sleepCounter > 0 && b2.sleepCounter > 0);
            assert.equal(engine.pairs.list.length, 1);

            Composite.clear(engine.world, false);
            assert.equal(Composite.allBodies(engine.world).length, 0);
            assert.equal(a2.sleepCounter, 0, 'Composite.clear must reset sleepCounter of removed bodies');

            for (let i = 0; i < 5; i++) {
                Engine.update(engine, 16.666);
            }

            assert.equal(engine.pairs.list.length, 0, 'Composite.clear must not leak pairs in pairs.list');
            assert.equal(Object.keys(engine.pairs.table).length, 0, 'Composite.clear must not leak pairs in pairs.table');
        });

        test('Regression: sleeping Compound bodies retain their collision pairs (parentA/parentB sleepCounter check)', () => {
            const engine = Engine.create({
                enableSleeping: true,
                gravity: { x: 0, y: 0, scale: 0 }
            });

            // Compound body A and Compound body B overlapping while sleeping
            const partA1 = Bodies.rectangle(0, 0, 20, 20, { isSensor: true });
            const partA2 = Bodies.rectangle(20, 0, 20, 20, { isSensor: true });
            const compA = Body.create({ parts: [partA1, partA2], sleepThreshold: 15 });

            const partB1 = Bodies.rectangle(5, 0, 20, 20);
            const partB2 = Bodies.rectangle(25, 0, 20, 20);
            const compB = Body.create({ parts: [partB1, partB2], sleepThreshold: 15 });

            let collisionEndCount = 0;
            Events.on(engine, 'collisionEnd', () => { collisionEndCount++; });

            Composite.add(engine.world, [compA, compB]);
            for (let i = 0; i < 20; i++) Engine.update(engine, 16.666);

            assert.equal(compA.isSleeping, true);
            assert.equal(compB.isSleeping, true);
            assert.equal(partA1.sleepCounter, 0, 'Child parts never get a sleepCounter, which is why the parents must be checked');

            // Regression: Pairs.update used to test pair.collision.bodyA.sleepCounter
            // (the child part, always 0) instead of parentA.sleepCounter, so compound
            // pairs were deleted the moment the compound bodies fell asleep and fired
            // a false collisionEnd. Parts overlap pairwise: A1-B1, A2-B1, A2-B2.
            assert.equal(engine.pairs.list.length, 3, 'Sleeping compound pairs must be retained');
            assert.equal(collisionEndCount, 0, 'No collisionEnd may fire merely because compound bodies fell asleep');
        });

        test('Regression: body.timeScale = 0 freezes the body instead of corrupting velocity with NaN', () => {
            const engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
            const body = Bodies.circle(0, 0, 10, { frictionAir: 0 });
            Body.setVelocity(body, { x: 5, y: 0 });
            // Freeze this single body using the documented body.timeScale property
            body.timeScale = 0;
            Composite.add(engine.world, body);

            Engine.update(engine, 16.666);

            // Regression: Body.update wrote body.deltaTime = 0 and updateVelocities then
            // computed Body._baseDelta / 0, turning velocity and speed into NaN.
            assert.ok(Number.isFinite(body.velocity.x) && Number.isFinite(body.speed),
                'velocity and speed must stay finite while the body is frozen');
            assert.equal(body.position.x, 0, 'a frozen body must not move');
            assert.ok(Math.abs(body.velocity.x - 5) < 1e-9, 'a frozen body keeps its velocity');

            // unfreeze: motion resumes from the preserved velocity
            body.timeScale = 1;
            for (let i = 0; i < 10; i++) Engine.update(engine, 16.666);
            assert.ok(body.position.x > 1, 'body resumes moving after timeScale is restored');
        });
    });

    describe('Matter.Events & Timestep (delta) Edge Cases', () => {
        test('Exact event firing sequence: beforeUpdate -> beforeSolve -> collisionStart -> collisionActive -> collisionEnd -> afterUpdate', () => {
            const engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
            const a = Bodies.circle(0, 0, 20);
            const b = Bodies.circle(15, 0, 20);
            Composite.add(engine.world, [a, b]);

            const trace = [];
            ['beforeUpdate', 'beforeSolve', 'collisionStart', 'collisionActive', 'collisionEnd', 'afterUpdate'].forEach(name => {
                Events.on(engine, name, () => trace.push(name));
            });

            // Tick 1: first contact -> collisionStart (not collisionActive yet!)
            Engine.update(engine, 16.666);
            assert.deepEqual(trace, ['beforeUpdate', 'beforeSolve', 'collisionStart', 'afterUpdate']);

            // Tick 2: sustained contact -> collisionActive
            trace.length = 0;
            Engine.update(engine, 16.666);
            assert.deepEqual(trace, ['beforeUpdate', 'beforeSolve', 'collisionActive', 'afterUpdate']);

            // Tick 3: separated -> collisionEnd
            trace.length = 0;
            Body.setPosition(b, { x: 200, y: 0 });
            Engine.update(engine, 16.666);
            assert.deepEqual(trace, ['beforeUpdate', 'beforeSolve', 'collisionEnd', 'afterUpdate']);
        });

        test('Bug Exposure #3: Engine.update(engine, 0) skips integration but runs Resolver/updateVelocities, zeroing or corrupting velocity', () => {
            const engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
            const body = Bodies.circle(0, 0, 10, { frictionAir: 0 });
            Body.setVelocity(body, { x: 5, y: 0 });
            Composite.add(engine.world, body);

            // Normal step
            Engine.update(engine, 16.666);
            assert.ok(Math.abs(body.velocity.x - 5) < 0.01);

            // Step with delta = 0 (e.g. duplicate frame timestamp in requestAnimationFrame)
            // Engine.js:116 skips Engine._bodiesUpdate(allBodies, delta) when delta <= 0,
            // so body.position === body.positionPrev (which was updated in previous step? Wait: let's check what happens!)
            Engine.update(engine, 0);

            // Let's see what happens if a colliding pair or constraint is solved when delta = 0
            const c1 = Bodies.circle(0, 100, 15, { frictionAir: 0 });
            const c2 = Bodies.circle(10, 100, 15, { frictionAir: 0 });
            Composite.add(engine.world, [c1, c2]);

            // With delta = 0, Resolver.solveVelocity computes timeScale = 0 -> division or zeroed friction
            Engine.update(engine, 0);
            assert.ok(Number.isFinite(c1.position.x) && Number.isFinite(c2.position.x));
        });
    });
});
