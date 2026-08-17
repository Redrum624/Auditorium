'use strict';

/**
 * F6 gate bank — fixes `src/dsp/ctcAlign.ts`'s LYRICS_MATCH_THRESHOLD, and
 * decides whether the gate refuses or merely warns.
 *
 * CTC forced alignment never says "could not align": a path always exists, so
 * the wrong lyrics come back confidently placed. The path score is the only
 * handle. The F6 spike measured a 0.754 nats/frame margin between correct and
 * length-matched-shuffled lyrics — on TWO files — and said in as many words
 * that n = 2 supports "a gate is feasible" and not an operating point.
 *
 * This bench is the bank that was missing.
 *
 * ## The bank
 *
 * Every passage is a (audio, text) pair whose text is known for the whole of
 * the audio, plus three deliberately harder classes:
 *
 *   - **correct**  — the passage's own text.
 *   - **shuffled** — the SAME words in a different order, five fixed seeds. A
 *     longer wrong text is penalised for its length alone, so the control must
 *     be length-matched; this one is exactly so.
 *   - **foreign**  — another passage's text, at the closest available word
 *     count. Length-matched as far as the bank allows, and reported with the
 *     count so a mismatch is visible.
 *   - **partial**  — correct lyrics over a recording that contains MORE than
 *     they describe (the reference 142 s take sings the six lines twice). This
 *     is a correct case the user would expect to pass, and it is the hardest
 *     one in the bank.
 *   - **no-speech** — correct lyrics over material with no voice in it at all
 *     (the generated test tone and beat). Always wrong, and the easiest.
 *
 * ## The split
 *
 * By MATERIAL, not by row: a threshold tuned on a passage and then tested on a
 * neighbouring cut of the same passage would be tested on itself. Calibration
 * takes the spoken control and the first half of the sung lines; the rest is
 * held out and is only ever REPORTED against, never fitted to.
 *
 * Usage:  node scripts/align-gate-bench.cjs [--long=<wav>]
 * Requires the lyrics sidecar (test-assets/align-bench-lyrics.txt — see
 * align-bench-common.cjs); skips with a message when it is absent.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  ASSETS,
  MODEL_PATHS,
  LYRICS_SIDECAR,
  LYRIC_LINES,
  SPEECH_CLAUSES,
  SHUFFLE_SEEDS,
  loadDsp,
  decodeMono16k,
  runModel,
  shuffleWords,
} = require('./align-bench-common.cjs');

/** Margin kept on each side of a cut passage, in seconds. A cut made exactly on
 * the aligned boundaries would hand the correct text a passage that starts and
 * ends precisely where it does, which flatters it; the margin is applied to
 * every passage equally so it flatters nothing. */
const CUT_MARGIN_SECONDS = 0.15;

function words(text) {
  return text.split(/\s+/).filter(Boolean);
}

function main() {
  for (const p of Object.values(MODEL_PATHS)) {
    if (!fs.existsSync(p)) throw new Error(`missing pinned model file: ${p}`);
  }
  if (!LYRIC_LINES) {
    console.log(
      `skipped: the ground-truth lyrics sidecar is absent (${LYRICS_SIDECAR}) — ` +
        'the whole bank scores known text against real recordings, so there is nothing to measure without it'
    );
    return;
  }
  const dsp = loadDsp();
  const blank = (vocab) => vocab['<pad>'];

  const wav = (name) => path.join(ASSETS, name);
  const need = ['speech16k.wav', 'vocal-30s.wav'];
  for (const n of need) if (!fs.existsSync(wav(n))) throw new Error(`missing bench material: ${wav(n)}`);

  const speech = decodeMono16k(dsp, wav('speech16k.wav'));
  const sung = decodeMono16k(dsp, wav('vocal-30s.wav'));

  // ── 1. align the two whole materials, to cut passages from ────────────────
  const whole = runModel([
    { name: 'whole-speech', samples: speech },
    { name: 'whole-sung', samples: sung },
  ]);
  const vocab = whole.vocab;
  const alignWhole = (name, text) => {
    const grid = whole.results.get(name);
    const r = dsp.alignLyrics(grid.logProbs, grid.frames, grid.classes, dsp.tokenizeLyrics(text, vocab), blank(vocab));
    if (!r.ok) throw new Error(`${name}: ${r.message}`);
    return r;
  };
  const speechAligned = alignWhole('whole-speech', SPEECH_CLAUSES.join(' '));
  const sungAligned = alignWhole('whole-sung', LYRIC_LINES.join('\n'));

  /** Cuts `[fromWord, toWord)` out of `samples` using an alignment's spans. */
  const cut = (samples, aligned, fromWord, toWord) => {
    const margin = Math.round(CUT_MARGIN_SECONDS * 16000);
    const start = Math.max(0, aligned.words[fromWord].startFrame * 320 - margin);
    const end = Math.min(samples.length, aligned.words[toWord - 1].endFrame * 320 + margin);
    return samples.slice(start, end);
  };

  // ── 2. build the passages ─────────────────────────────────────────────────
  /** @type {{name:string, samples:Float32Array, text:string, split:'calibration'|'held-out', kind:string}[]} */
  const passages = [];

  passages.push({
    name: 'speech-whole',
    samples: speech,
    text: SPEECH_CLAUSES.join(' '),
    split: 'calibration',
    kind: 'spoken',
  });
  {
    let cursor = 0;
    SPEECH_CLAUSES.forEach((clause, i) => {
      const n = words(clause).length;
      passages.push({
        name: `speech-clause-${i + 1}`,
        samples: cut(speech, speechAligned, cursor, cursor + n),
        text: clause,
        split: 'calibration',
        kind: 'spoken',
      });
      cursor += n;
    });
  }

  const lineStarts = [];
  {
    let cursor = 0;
    for (const line of LYRIC_LINES) {
      lineStarts.push(cursor);
      cursor += words(line).length;
    }
    lineStarts.push(cursor);
  }
  LYRIC_LINES.forEach((line, i) => {
    passages.push({
      name: `sung-line-${i + 1}`,
      samples: cut(sung, sungAligned, lineStarts[i], lineStarts[i + 1]),
      text: line,
      // Lines 1-3 calibrate, 4-6 are held out. Split by material, so a cut is
      // never tested against a threshold fitted on its own audio.
      split: i < 3 ? 'calibration' : 'held-out',
      kind: 'sung',
    });
  });
  for (let i = 0; i + 1 < LYRIC_LINES.length; i++) {
    passages.push({
      name: `sung-pair-${i + 1}${i + 2}`,
      samples: cut(sung, sungAligned, lineStarts[i], lineStarts[i + 2]),
      text: `${LYRIC_LINES[i]}\n${LYRIC_LINES[i + 1]}`,
      split: i + 1 < 3 ? 'calibration' : 'held-out',
      kind: 'sung',
    });
  }
  passages.push({
    name: 'sung-whole',
    samples: sung,
    text: LYRIC_LINES.join('\n'),
    split: 'held-out',
    kind: 'sung',
  });

  // Correct lyrics over a take that sings them TWICE — the hardest correct
  // case. The default is the user-local long reference take; --long=<wav>
  // points at another one.
  const longArg = process.argv.find((a) => a.startsWith('--long='));
  const longTake = longArg
    ? path.resolve(longArg.slice('--long='.length))
    : wav('long-real-take.wav');
  if (fs.existsSync(longTake)) {
    passages.push({
      name: 'sung-partial-coverage',
      samples: decodeMono16k(dsp, longTake),
      text: LYRIC_LINES.join('\n'),
      split: 'held-out',
      kind: 'partial',
    });
  } else {
    console.log(`sung-partial-coverage: skipped (long reference take absent at ${longTake} — pass --long=<wav>)\n`);
  }
  // No voice at all — always wrong, whatever the text.
  for (const [name, file] of [
    ['tone', 'tone.wav'],
    ['beat', 'beat120.wav'],
  ]) {
    if (fs.existsSync(wav(file))) {
      passages.push({
        name: `no-speech-${name}`,
        samples: decodeMono16k(dsp, wav(file)).slice(0, 16000 * 20),
        text: LYRIC_LINES.join('\n'),
        split: 'held-out',
        kind: 'no-speech',
      });
    }
  }

  // ── 3. one emission grid per passage ──────────────────────────────────────
  const grids = runModel(passages.map((p) => ({ name: p.name, samples: p.samples })));

  // ── 4. score every (passage, text) pair ───────────────────────────────────
  const rows = [];
  /**
   * TWO candidate statistics, because the F6 spike reported that the median
   * per-word score "separates even harder" than the path score and the bank is
   * the place to find out whether that survives contact with a passage the text
   * only partly covers.
   *
   *  - `path`  — mean log-probability over EVERY frame, the spike's headline
   *              quantity. Frames the text does not cover are charged to it.
   *  - `word`  — median of the per-word mean log-probability. Only frames the
   *              path actually assigned to a word count, so a recording that
   *              contains material the lyrics do not describe costs nothing.
   */
  const score = (passage, text) => {
    const grid = grids.results.get(passage.name);
    const tokenized = dsp.tokenizeLyrics(text, grids.vocab);
    const r = dsp.alignLyrics(grid.logProbs, grid.frames, grid.classes, tokenized, blank(grids.vocab));
    if (!r.ok) return null;
    return { path: r.pathScore, word: median(r.words.map((w) => w.score)) };
  };
  const push = (p, label, text, wordCount, s) => {
    if (!s || !Number.isFinite(s.path) || !Number.isFinite(s.word)) return;
    rows.push({ passage: p.name, split: p.split, kind: p.kind, label, text, words: wordCount, ...s });
  };
  /** Word multiset key — two texts with the same key are the same target. */
  const key = (text) =>
    words(text)
      .map((w) => w.toUpperCase().replace(/[^A-Z']/g, ''))
      .sort()
      .join(' ');

  for (const p of passages) {
    const own = words(p.text);
    if (p.kind !== 'no-speech') {
      push(p, 'correct', 'own', own.length, score(p, p.text));
    }
    for (const seed of SHUFFLE_SEEDS) {
      const shuffled = shuffleWords(own, seed).join(' ');
      if (shuffled === own.join(' ')) continue;
      push(p, 'wrong', `shuffled/${seed}`, own.length, score(p, shuffled));
    }
    // Foreign text: another passage's, at the closest word count — but never
    // one whose words ARE this passage's words. `sung-whole` and
    // `sung-partial-coverage` carry the same six lines, and labelling one as
    // the other's wrong text would score the correct target as a negative.
    const others = passages.filter(
      (q) => q.name !== p.name && q.kind !== 'no-speech' && key(q.text) !== key(p.text)
    );
    if (others.length > 0) {
      others.sort((a, b) => Math.abs(words(a.text).length - own.length) - Math.abs(words(b.text).length - own.length));
      const foreign = others[0];
      push(p, 'wrong', `foreign/${foreign.name}`, words(foreign.text).length, score(p, foreign.text));
    }
    if (p.kind === 'no-speech') {
      push(p, 'wrong', 'lyrics-over-silence', own.length, score(p, p.text));
    }
  }

  const usable = rows;
  // A passage too short for its own text produces no row at all — the aligner
  // refuses before scoring. Named, so the counts below can be reconciled.
  const skipped = passages.filter((p) => !rows.some((r) => r.passage === p.name));
  if (skipped.length > 0) {
    console.log(`skipped (no alignment possible): ${skipped.map((p) => p.name).join(', ')}\n`);
  }

  // ── 5. choose the threshold on the calibration split ONLY ─────────────────
  const calibration = usable.filter((r) => r.split === 'calibration');
  const heldOut = usable.filter((r) => r.split === 'held-out');

  const auc = (set, stat) => {
    const pos = set.filter((r) => r.label === 'correct').map((r) => r[stat]);
    const neg = set.filter((r) => r.label === 'wrong').map((r) => r[stat]);
    if (pos.length === 0 || neg.length === 0) return null;
    let wins = 0;
    for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
    return wins / (pos.length * neg.length);
  };

  const confusion = (set, stat, threshold) => ({
    tp: set.filter((r) => r.label === 'correct' && r[stat] >= threshold).length,
    fn: set.filter((r) => r.label === 'correct' && r[stat] < threshold).length,
    fp: set.filter((r) => r.label === 'wrong' && r[stat] >= threshold).length,
    tn: set.filter((r) => r.label === 'wrong' && r[stat] < threshold).length,
  });

  /**
   * The threshold is chosen from CALIBRATION SCORES ONLY — candidates are the
   * midpoints between consecutive calibration values, never the held-out ones.
   * Letting a held-out score be a candidate would leak the test set into the
   * threshold even though the criterion never looked at its labels.
   *
   * Candidates are midpoints rather than observed values so the chosen point
   * does not sit exactly on a sample, and ties on Youden J are broken by the
   * WIDEST gap — the point furthest from anything the bank actually measured.
   */
  const chooseOn = (stat) => {
    const values = [...new Set(calibration.map((r) => r[stat]))].sort((a, b) => a - b);
    let best = null;
    for (let i = 0; i + 1 < values.length; i++) {
      const threshold = (values[i] + values[i + 1]) / 2;
      const gap = values[i + 1] - values[i];
      // Threshold semantics: statistic >= threshold reads as "match".
      const { tp, fn, fp, tn } = confusion(calibration, stat, threshold);
      const youden = tp / Math.max(1, tp + fn) + tn / Math.max(1, tn + fp) - 1;
      if (!best || youden > best.youden || (youden === best.youden && gap > best.gap)) {
        best = { threshold, youden, gap };
      }
    }
    return best;
  };

  // ── 6. report ─────────────────────────────────────────────────────────────
  console.log('# F6 gate bank\n');
  console.log('passage                 split        kind       label    words     path     word  text');
  for (const r of usable) {
    console.log(
      `${r.passage.padEnd(23)} ${r.split.padEnd(12)} ${r.kind.padEnd(10)} ` +
        `${r.label.padEnd(8)} ${String(r.words).padStart(5)} ${r.path.toFixed(4).padStart(8)} ` +
        `${r.word.toFixed(4).padStart(8)}  ${r.text}`
    );
  }

  const summarise = (name, set, stat) => {
    const pos = set.filter((r) => r.label === 'correct').map((r) => r[stat]);
    const neg = set.filter((r) => r.label === 'wrong').map((r) => r[stat]);
    const a = auc(set, stat);
    console.log(`\n${name} [${stat}]: ${pos.length} correct, ${neg.length} wrong, AUC ${a === null ? 'n/a' : a.toFixed(3)}`);
    if (pos.length) console.log(`  correct: min ${Math.min(...pos).toFixed(4)}  median ${median(pos).toFixed(4)}  max ${Math.max(...pos).toFixed(4)}`);
    if (neg.length) console.log(`  wrong  : min ${Math.min(...neg).toFixed(4)}  median ${median(neg).toFixed(4)}  max ${Math.max(...neg).toFixed(4)}`);
    if (pos.length && neg.length) {
      const gap = Math.min(...pos) - Math.max(...neg);
      console.log(`  separable: ${gap > 0 ? `YES, margin ${gap.toFixed(4)}` : `NO, overlap ${(-gap).toFixed(4)}`}`);
    }
  };

  for (const stat of ['path', 'word']) {
    console.log(`\n${'='.repeat(72)}`);
    summarise('CALIBRATION', calibration, stat);
    summarise('HELD-OUT', heldOut, stat);
    const chosen = chooseOn(stat);
    const cc = confusion(calibration, stat, chosen.threshold);
    const hc = confusion(heldOut, stat, chosen.threshold);
    console.log(
      `\nchosen on CALIBRATION only [${stat}]: ${chosen.threshold.toFixed(4)} ` +
        `(Youden J ${chosen.youden.toFixed(3)}, midpoint of a ${chosen.gap.toFixed(4)} gap)`
    );
    console.log(`  calibration: TP ${cc.tp}  FN ${cc.fn}  FP ${cc.fp}  TN ${cc.tn}`);
    console.log(`  held-out   : TP ${hc.tp}  FN ${hc.fn}  FP ${hc.fp}  TN ${hc.tn}`);
  }

  console.log('\nFN = correct lyrics the gate would have doubted. FP = wrong lyrics it would have accepted.');
  console.log('A statistic with any held-out FP or FN must ship as a WARNING, never as a refusal.');
}

function median(list) {
  const a = [...list].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}

main();
