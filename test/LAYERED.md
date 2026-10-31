# Layered Physics Test Suite (L1–L4)

A four-layer test suite for Matter.js that isolates failure domains: pure
geometry first, then collision/impulse solving, then state-machine lifecycle,
finally whole-scene deterministic regression and stress benchmarks.

Dependency-free by default: runs with `node:test` against `src/` and `build/`
directly, no `npm install` needed. Two L4 scenes (`concave`, `raycasting`) build
concave bodies through `poly-decomp`; L4 detects that package at runtime and
widens its own coverage when it is present. With it absent those two are skipped
and the run says so (`[L4 Coverage] poly-decomp MISSING ...`) instead of failing.

## Layers

| Layer | File | Scope |
|---|---|---|
| L1 | `test/L1_L2.spec.js` | `Vector`, `Vertices`, `Bounds`, `Axes` — degenerate input, precision, degenerate polygons |
| L2 | `test/L1_L2.spec.js` | `Collision`, `Detector`, `Resolver`, `Constraint`, compound bodies — penetration depth, momentum conservation, friction thresholds, tunneling boundary |
| L3 | `test/L3.spec.js` | `Sleeping`, `Pairs`, `Composite`, `Events`, timestep edge cases — sleep/wake lifecycle, cache leaks, event ordering, `delta = 0` |
| L4 | `test/L4.spec.js` | 44 example scenes × smoke checks (46 when `poly-decomp` is installed), same-version determinism (bit-identical reruns), cross-build regression (`src/` vs `build/matter.js`), `stress`/`stress2`/`stress3`/`stress4` benchmarks |

## Running

```sh
# everything (Node >= 22)
pnpm run test:layers        # or: node --expose-gc --test test/L1_L2.spec.js test/L3.spec.js test/L4.spec.js

pnpm run test:l1-l2         # layers 1+2, fast (~1s)
pnpm run test:l3            # layer 3 (~2s)
pnpm run test:l4            # layer 4 (~50-90s, depends on machine and Node version)
```

If `pnpm` refuses to start with `This project is configured to use >=11.11.0 of pnpm`,
that gate lives in `package.json` (`devEngines` / `packageManager`) and blocks every
`pnpm run` script, including the nested call inside `pnpm test`. The suite itself has no
pnpm dependency - run the `node` commands above directly. (Verified on Node 22.23.4
and Node 24.16.0, Windows, with pnpm 11.4.0 installed.)

CI: `.github/workflows/layered-tests.yml` runs the suite on ubuntu and windows
with Node 22 on every push / PR touching `src/`, `build/`, `examples/` or `test/`.
It has two jobs: `layered-tests` (no install, so `concave`/`raycasting` are
skipped) and `layered-tests-external` (installs `poly-decomp` and fails hard if
that coverage ever silently disappears).

## Cross-build regression semantics (L4)

`build/matter.js` in this repository is the committed release artifact (the
previous release), while `src/` is current master. L4 asserts bit-identical
extrinsics and intrinsics between the two for every scene **except** a small
documented set (`KNOWN_DIVERGENT` in `test/L4.spec.js`):

- `compound` — finding F1: `src/` applies the parallel axis theorem
  (`I = Σ(I_part + m·d²)`) to compound body inertia; the release artifact sums
  `Σ I_part` only. Mass/area/friction/restitution are identical.
- `remove` — intentional: the wake-on-lost-contact fix (finding 4) changes this
  example's trajectory when sleeping bodies are removed from the world.
- `concave`, `raycasting` — F1 again: both build concave bodies via
  `Bodies.fromVertices` / `Common.setDecomp`, so the parallel axis theorem change
  hits them exactly like `compound` (measured 2026-10-31: intrinsic *and*
  extrinsic differ at 60 and 150 steps). Only asserted when `poly-decomp` is
  installed.

Two examples are excluded from every run and cannot be fixed by installing
anything: `svg` and `terrain` fetch external assets through relative URLs, which
Node cannot resolve — `example.svg()` rejects with `ERR_INVALID_URL` and
`example.terrain()` builds 0 bodies. Upstream's own jest suite draws the same
boundary (`excludeExamples = ['svg', 'terrain']` in `test/Examples.spec.js`).

Note that `sleeping` — the other `enableSleeping` example — stays bit-identical:
the sleeping fixes only fire in the pathological cases the L3 tests cover.

Any other divergence fails the build.

## Findings & fix status

| # | Finding | Location | Status |
|---|---|---|---|
| 1 | Zero-area (collinear) vertices produced a NaN centroid via `6 * area` division | `src/geometry/Vertices.js` `Vertices.centre` | **fixed** — falls back to vertex mean |
| 2 | `Constraint.create({ stiffness: 0 })` silently coerced to `1` (`\|\|` default) | `src/constraint/Constraint.js` | **fixed** — explicit numeric stiffness preserved |
| 3 | `body.timeScale = 0` produced `NaN` velocity/speed (division by `deltaTime = 0`) | `src/body/Body.js` `Body.update` | **fixed** — non-positive effective delta freezes the body |
| 4 | Removing a sleeping body's support left the upper body floating asleep forever | `src/core/Engine.js` (wake on lost contact) | **fixed** — sleeping bodies wake when their last contact ends |
| 5 | `Composite.clear` leaked every cached pair forever (never reset `sleepCounter`) | `src/body/Composite.js` `Composite.clear` | **fixed** — removed bodies get `sleepCounter = 0` like `removeBody` |
| 6 | Compound body pairs were deleted the moment the body slept (checked child `part.sleepCounter`, always 0), firing a false `collisionEnd` | `src/collision/Pairs.js` `Pairs.update` | **fixed** — retention checks `parentA/parentB.sleepCounter` |
| 7 | High-speed tunneling: discrete collision detection (no CCD) misses bullets displacing more than wall + diameter per step | inherent limitation | **documented** — sub-stepping (e.g. `Engine.update(engine, delta/8)`) is a validated mitigation (see L2 test) |
| 8 | F1: compound inertia diverges between `src/` and the committed `build/matter.js` artifact (parallel axis theorem) | `build/matter.js` is stale | **documented** — rebuild the artifact on release; `src/` is correct |

All fixed findings are guarded by `Regression:` tests in the suite — reverting
a fix turns the suite red.
