import type { RemixAnalysis } from '../dsp/remixFeatures';

/**
 * Shared cluster-strip derivation (G4): extracted verbatim from
 * RemixDialog.tsx so the persistent TEMPO card (Layout/TempoCard.tsx) and the
 * Auto-Remix dialog render the SAME structure strip from the same analysis —
 * one colour cycle, one run derivation, one meter label.
 */

/** One colour per cluster label, cycled — the structure strip's only job is to
 * make "these bars belong together" legible before the user commits. */
export const CLUSTER_COLORS = ['#26c6da', '#e0a458', '#7e57c2', '#66bb6a', '#ef5350', '#42a5f5'];

/** The strip colour for a cluster label (safe for any integer, cycled). */
export function clusterColor(cluster: number): string {
  return CLUSTER_COLORS[((cluster % CLUSTER_COLORS.length) + CLUSTER_COLORS.length) % CLUSTER_COLORS.length];
}

export const METERS: { value: string; beatsPerBar: number }[] = [
  { value: '3/4', beatsPerBar: 3 },
  { value: '4/4', beatsPerBar: 4 },
  { value: '6/8', beatsPerBar: 6 },
];

export function meterLabel(beatsPerBar: number): string {
  return METERS.find((m) => m.beatsPerBar === beatsPerBar)?.value ?? `${beatsPerBar}/4`;
}

export interface StructureRun {
  cluster: number;
  startSample: number;
  endSample: number;
  widthPercent: number;
}

/** One block per MAXIMAL RUN of consecutive bars sharing a cluster label. Bar
 * `m` spans `[barBoundary[m], barBoundary[m+1])` and is labelled `cluster[m]`,
 * so a run's duration is the distance between the first and last boundary it
 * covers and the widths sum to 100%.
 *
 * Deliberately defensive about the analysis SHAPE, not just its values: after
 * an octave correction (`regridTempo`), a level:'remix' cache row is a
 * `deriveGrid` result carrying NO `barBoundary`/`cluster`/`numBars` at all
 * (the exact hazard `setRemixAnalysis`'s doc comment describes), and the
 * persistent TEMPO card reads `getRemixAnalysis` on every render — so a
 * missing field must yield an empty strip, never a throw. */
export function structureRuns(analysis: RemixAnalysis | null): StructureRun[] {
  if (!analysis || !(analysis.numBars >= 1)) return [];
  const { barBoundary, cluster, numBars } = analysis;
  if (!barBoundary || !cluster || barBoundary.length < numBars + 1 || cluster.length < numBars) {
    return [];
  }
  const total = barBoundary[numBars] - barBoundary[0];
  if (!(total > 0)) return [];

  const runs: StructureRun[] = [];
  let start = 0;
  for (let bar = 1; bar <= numBars; bar++) {
    if (bar === numBars || cluster[bar] !== cluster[start]) {
      const startSample = barBoundary[start];
      const endSample = barBoundary[bar];
      runs.push({
        cluster: cluster[start],
        startSample,
        endSample,
        widthPercent: ((endSample - startSample) / total) * 100,
      });
      start = bar;
    }
  }
  return runs;
}
