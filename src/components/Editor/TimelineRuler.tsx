import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { formatTime } from '../../utils/timeFormat';
import { pixelToSample, sampleToPixel } from './waveformRender';

const RULER_H = 24;
const MIN_TICK_PX = 80;
// Candidate tick spacings in seconds (ascending).
const TICK_STEPS = [0.001, 0.01, 0.1, 0.5, 1, 5, 10, 30, 60, 300];

/** 24px time ruler above the waveform. Shares zoom from the store; clicking
 * seeks the cursor. Ticks are chosen so labels stay >= 80px apart. */
export default function TimelineRuler({ sampleRate }: { sampleRate: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(0);

  const zoom = useAppStore((s) => s.zoom);
  const setCursor = useAppStore((s) => s.setCursor);

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

    ctx.fillStyle = '#232328';
    ctx.fillRect(0, 0, width, RULER_H);

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

    ctx.strokeStyle = '#3a3a42';
    ctx.fillStyle = '#8b8b92';
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
    setCursor(Math.max(0, sample));
  };

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      className="h-6 shrink-0 cursor-text border-b border-[#3a3a42] bg-[#232328]"
      data-testid="timeline-ruler"
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
