/**
 * GENERATED FILE -- do not hand-edit the numbers.
 *
 * The auto-remix PLAN golden (R4b, Ruling 4). Every value below was produced
 * by the planner **as it stood at commit `5dfa19d` (v1.20.0), before
 * `requiredJoins` existed** -- extracted with `git show HEAD:src/dsp/
 * remixPlan.ts`, run against the same fixture builders `remixPlan.test.ts`
 * uses, and asserted field-for-field on every run.
 *
 * WHAT THIS PROTECTS. `remixGolden.ts` pins the RENDERED AUDIO of four
 * hand-built plans; it cannot notice a planner that starts choosing a
 * different arrangement, because it never asks the planner for one. R4b adds
 * a `2^K` subset axis to the DP's index arithmetic, shared by the K = 0 path
 * -- so "an empty `requiredJoins` changes nothing" needed to stop being an
 * argument about `* 1` and `+ 0` and become a comparison against numbers
 * produced by code that had never heard of the option. These are those
 * numbers.
 *
 * The eight cases span both fixture builders (uniform and genuinely varying
 * bar lengths), strict and loose mode, `allowRepeats` on and off, roll
 * indices 0-3, `exactLength`, and targets from 0.5x to 2.0x the source --
 * including one case whose optimal plan traverses the SAME join key twice
 * (`varying-64-loose-roll1-2.00`, joins `34>2, 34>2`), which is also the
 * measured counter-example to implementing `requiredJoins` as a counter.
 *
 * TO REGENERATE (only when a planner output change is genuinely INTENDED --
 * a regeneration is an admission that auto-remix arrangements moved, and
 * belongs in its own commit with the reason): see the generator described in
 * `.superpowers/sdd/task-R4b-report.md`; it extracts the previous planner
 * from git and prints this block.
 */

export interface RemixPlanGoldenCase {
  /** Matches the `name` in `REMIX_PLAN_GOLDEN_SPECS` in `remixPlan.test.ts`. */
  readonly name: string;
  /** `[start, end]` per segment, exact samples. */
  readonly segments: readonly (readonly [number, number])[];
  /** `${fromBar}>${toBar}` per join, in path order. */
  readonly joins: readonly string[];
  /** `joins[i].cost.total` at double precision -- pins the UNPENALISED
   * per-join breakdown the panel shows, not just the arrangement. */
  readonly joinCosts: readonly number[];
  readonly outputSample: number;
  readonly totalCost: number;
  readonly minOutputSample: number;
  readonly maxOutputSample: number;
  readonly maxBarUse: number;
  readonly canReroll: boolean;
}

export const REMIX_PLAN_GOLDEN: readonly RemixPlanGoldenCase[] = [
  {
    name: "uniform-40-strict-roll0-0.75",
    segments: [[500,240500],[320500,400500]],
    joins: ["24>32"],
    joinCosts: [0.7],
    outputSample: 321300,
    totalCost: 1.0499999999999998,
    minOutputSample: 161300,
    maxOutputSample: 1201300,
    maxBarUse: 1,
    canReroll: true,
  },
  {
    name: "uniform-40-loose-roll2-1.40",
    segments: [[500,190500],[30500,400500]],
    joins: ["19>3"],
    joinCosts: [0.7],
    outputSample: 561300,
    totalCost: 1.0499999999999998,
    minOutputSample: 91300,
    maxOutputSample: 1201300,
    maxBarUse: 2,
    canReroll: true,
  },
  {
    name: "uniform-24-clustered-strict-roll1-1.00",
    segments: [[500,240500]],
    joins: [],
    joinCosts: [],
    outputSample: 241300,
    totalCost: 0,
    minOutputSample: 161300,
    maxOutputSample: 721300,
    maxBarUse: 1,
    canReroll: false,
  },
  {
    name: "varying-48-strict-roll0-0.50",
    segments: [[4000,356943],[886319,1062671]],
    joins: ["16>40"],
    joinCosts: [0],
    outputSample: 536295,
    totalCost: 0.35,
    minOutputSample: 360318,
    maxOutputSample: 3183215,
    maxBarUse: 1,
    canReroll: true,
  },
  {
    name: "varying-48-strict-roll3-1.25",
    segments: [[4000,445335],[92371,1062671]],
    joins: ["20>4"],
    joinCosts: [0],
    outputSample: 1418635,
    totalCost: 0.35,
    minOutputSample: 360318,
    maxOutputSample: 3183215,
    maxBarUse: 2,
    canReroll: true,
  },
  {
    name: "varying-64-loose-roll1-2.00",
    segments: [[4000,754114],[48059,754114],[48059,1415290]],
    joins: ["34>2","34>2"],
    joinCosts: [0,0],
    outputSample: 2830400,
    totalCost: 0.7,
    minOutputSample: 205223,
    maxOutputSample: 4242510,
    maxBarUse: 3,
    canReroll: true,
  },
  {
    name: "varying-64-strict-exact-1.10",
    segments: [[4000,202846],[26089,1415290]],
    joins: ["9>1"],
    joinCosts: [0],
    outputSample: 1595047,
    totalCost: 0.35,
    minOutputSample: 360031,
    maxOutputSample: 4241682,
    maxBarUse: 2,
    canReroll: true,
  },
  {
    name: "uniform-40-strict-norepeat-0.60",
    segments: [[500,160500],[320500,400500]],
    joins: ["16>32"],
    joinCosts: [0.7],
    outputSample: 241300,
    totalCost: 1.0499999999999998,
    minOutputSample: 161300,
    maxOutputSample: 401300,
    maxBarUse: 1,
    canReroll: true,
  },
];
