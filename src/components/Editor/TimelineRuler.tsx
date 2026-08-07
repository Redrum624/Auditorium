import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { formatTime } from '../../utils/timeFormat';
import { cssToken, pixelToSample, sampleToPixel } from './waveformRender';

const RULER_H = 24;
const MIN_TICK_PX = 80;
// Candidate tick spacings in seconds (ascending).
const TICK_STEPS = [0.001, 0.01, 0.1, 0.5, 1, 5, 10, 30, 60, 300];

interface Zoom {
  samplesPerPixel: number;
  scrollSample: number;
}

interface TimelineRulerProps {
  sampleRate: number;
  /** External zoom source (multitrack lanes). Defaults to the app store's zoom
   * (single-document editor) when omitted. */
  zoom?: Zoom;
  /** Seek handler for a ruler click. Defaults to the app store's setCursor. */
  onSeek?: (sample: number) => void;
}

/** 24px time ruler. Shares a zoom source (app store by default, or the passed
 * multitrack zoom); clicking seeks. Ticks are chosen so labels stay >= 80px
 * apart. */
export default function TimelineRuler({ sampleRate, zoom: zoomProp, onSeek }: TimelineRulerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(0);

  const storeZoom = useAppStore((s) => s.zoom);
  const storeSetCursor = useAppStore((s) => s.setCursor);
  const zoom = zoomProp ?? storeZoom;
  const seek = onSeek ?? storeSetCursor;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / no backend
    if (width <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(RULER_H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // G6: transparent over the radial stage (the ruler is muted chrome text
    // above the lane, mockup `.timeline`); resizing above already cleared.
    ctx.clearRect(0, 0, width, RULER_H);

    const { samplesPerPixel, scrollSample } = zoom;
    const secPerPixel = samplesPerPixel / sampleRate;
    let stepSec = TICK_STEPS[TICK_STEPS.length - 1];
    for (const s of TICK_STEPS) {
      if (s / secPerPixel >= MIN_TICK_PX) {
        stepSec = s;
        break;
      }
    }

    const stepSamples = stepSec * sampleRate;
    const endSample = scrollSample + width * samplesPerPixel;
    const firstTick = Math.ceil(scrollSample / stepSamples) * stepSamples;

    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.fillStyle = cssToken('--glass-text-muted', '#7a7a82');
    ctx.font = '10px monospace';
    ctx.lineWidth = 1;
    for (let s = firstTick; s <= endSample; s += stepSamples) {
      const x = sampleToPixel(s, scrollSample, samplesPerPixel);
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 6);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      ctx.fillText(formatTime(Math.round(s), sampleRate), x + 3, 12);
    }
  }, [zoom, width, sampleRate]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const sample = Math.round(pixelToSample(x, zoom.scrollSample, zoom.samplesPerPixel));
    seek(Math.max(0, sample));
  };

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      className="mb-1 h-6 shrink-0 cursor-text"
      data-testid="timeline-ruler"
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
