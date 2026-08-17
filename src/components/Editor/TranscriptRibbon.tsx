import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { getTranscript, useTranscribeVersion } from '../../services/transcribeService';
import { layoutTranscriptRegions, speakerColor } from './transcriptLayout';

/** Lane height in CSS pixels — the ruler's 24px halved, so the ribbon reads as
 * a subordinate strip of the same chrome rather than a second ruler. */
const RIBBON_H = 12;

/**
 * F4b — the transcript's timeline half: one coloured REGION per segment,
 * spanning its real start and end, in its own lane between the time ruler and
 * the waveform.
 *
 * `transcriptLayout.ts`'s header carries the full argument for regions over
 * markers (a marker is a point, markers are persisted into the user's exported
 * files, a marker carries no speaker, and re-clustering would rewrite the
 * user's marker list). The short version: a transcript segment has an end, a
 * speaker and no business being saved into the user's audio.
 *
 * The lane is a SIBLING of the waveform canvas, not an overlay on it. An
 * overlay would put clickable regions over the top strip of the waveform and
 * steal the pointer from selection drags there; a sibling row costs 12 px and
 * only exists when a transcript does, so an untranscribed document's editor is
 * byte-for-byte what it was before.
 *
 * Clicking a region moves the cursor to that segment's start — the same
 * gesture as the panel's time button, so the two halves of the feature behave
 * identically.
 */
export default function TranscriptRibbon() {
  const observerRef = useRef<ResizeObserver | null>(null);
  const [width, setWidth] = useState(0);

  useTranscribeVersion();
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const zoom = useAppStore((s) => s.zoom);
  const setCursor = useAppStore((s) => s.setCursor);

  /**
   * A CALLBACK ref, not `useRef` + a `[]`-dependency effect — and the
   * difference is load-bearing, not stylistic.
   *
   * This lane does not exist until a transcript does (the early return below).
   * An effect with `[]` deps runs ONCE, on the mount where `ref.current` is
   * still null, and never again — so when the transcript arrives later the
   * ResizeObserver is never installed, `width` stays 0, every region is culled
   * by `layoutTranscriptRegions`, and the ribbon silently draws nothing for
   * the rest of the session. That is exactly what happened: the jsdom tests
   * all seeded a transcript BEFORE the first render, so they never saw it, and
   * the packaged smoke run reported `0 region(s)`.
   *
   * A callback ref fires on every mount and unmount of the node itself, which
   * is precisely when the measurement has to be (re)installed.
   */
  const measureLane = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) {
      setWidth(0);
      return;
    }
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    observerRef.current = ro;
  }, []);

  // Belt and braces for the unmount of the COMPONENT rather than the node
  // (React calls the callback ref with null first, but a future refactor that
  // keeps the node alive must still release the observer).
  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    },
    []
  );

  const transcript = activeDocumentId ? getTranscript(activeDocumentId) : null;
  const regions = transcript
    ? layoutTranscriptRegions(transcript.segments, {
        scrollSample: zoom.scrollSample,
        samplesPerPixel: zoom.samplesPerPixel,
        width,
      })
    : [];

  // Nothing to show and nothing to reserve: an untranscribed document's editor
  // keeps its previous layout exactly.
  if (!transcript || transcript.segments.length === 0) return null;

  return (
    <div
      ref={measureLane}
      data-testid="transcript-ribbon"
      className="relative mb-1 shrink-0 overflow-hidden"
      style={{ height: RIBBON_H }}
    >
      {regions.map((region) => (
        <button
          key={region.segmentIndex}
          type="button"
          data-testid="transcript-region"
          data-speaker={region.speaker === null ? 'unknown' : String(region.speaker)}
          title={region.text}
          aria-label={`Go to segment ${region.segmentIndex + 1}`}
          onClick={() => setCursor(region.startSample)}
          className="absolute top-0 rounded-sm"
          style={{
            left: region.x,
            width: region.width,
            height: RIBBON_H,
            background: speakerColor(region.speaker),
            opacity: 0.7,
          }}
        />
      ))}
    </div>
  );
}
