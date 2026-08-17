import { createRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import {
  ChromePill,
  FieldLabel,
  GlassButton,
  GlassCard,
  GlassField,
  GlassSelect,
  GlassSlider,
  IconTile,
  SectionLabel,
} from './glass';

// G1 contract tests: the primitives are THIN presentational wrappers over the
// Vitrine tokens ported into src/index.css. What matters (and what later tasks
// build on) is the class/token contract — the load-bearing classes are present,
// the variants differ, and testids/aria/refs pass through — NOT pixel output,
// which jsdom cannot see. Anatomy source of truth: photo_app's components
// (ruling 1) with the accent swapped to Auditorium cyan (ruling 2).

describe('glass tokens (src/index.css)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../index.css'), 'utf8');

  it('carries the Auditorium cyan accent trio per ruling 2 (not Vitrine blue)', () => {
    expect(css).toContain('--accent: #26c6da');
    expect(css).toContain('--accent-soft: rgba(38, 198, 218, 0.14)');
    expect(css).toContain('--accent-ring: rgba(38, 198, 218, 0.35)');
  });

  it('carries the Vitrine glass surface tokens verbatim', () => {
    expect(css).toContain('--glass-bg: rgba(15, 15, 19, 0.78)');
    expect(css).toContain('--glass-bg-chrome: rgba(16, 16, 20, 0.72)');
    expect(css).toContain('--glass-border: rgba(255, 255, 255, 0.08)');
    expect(css).toContain('--glass-blur: 28px');
    expect(css).toContain('--glass-blur-chrome: 24px');
    expect(css).toContain('--radius-card: 20px');
    expect(css).toContain('--radius-dock: 16px');
    expect(css).toContain(
      '--canvas-bg: radial-gradient(1400px 800px at 42% 45%, #121216, #08080a)'
    );
  });

  it('carries the glass text scale', () => {
    expect(css).toContain('--glass-text-title: #f0f0f2');
    expect(css).toContain('--glass-text-label: #c2c2ca');
    expect(css).toContain('--glass-text-secondary: #a8a8b0');
    expect(css).toContain('--glass-text-muted: #7a7a82');
    expect(css).toContain('--glass-text-chrome-idle: #8a8a92');
    expect(css).toContain('--glass-text-chrome-primary: #d8d8de');
  });

  it('defines the surface, slider and scrollbar rules the primitives rely on', () => {
    expect(css).toContain('.glass-card');
    expect(css).toContain('.glass-chrome');
    expect(css).toContain('.glass-slider-thumb');
    expect(css).toContain('::-webkit-scrollbar');
  });
});

describe('GlassCard', () => {
  it('renders children on a .glass-card surface and passes className/testid through', () => {
    render(
      <GlassCard data-testid="card" className="extra">
        <span>inside</span>
      </GlassCard>
    );
    const card = screen.getByTestId('card');
    expect(card).toHaveClass('glass-card');
    expect(card).toHaveClass('extra');
    expect(screen.getByText('inside')).toBeInTheDocument();
  });
});

describe('ChromePill', () => {
  it('renders children on a .glass-chrome surface at the dock radius', () => {
    render(
      <ChromePill data-testid="pill" className="extra">
        pill content
      </ChromePill>
    );
    const pill = screen.getByTestId('pill');
    expect(pill).toHaveClass('glass-chrome');
    expect(pill).toHaveClass('extra');
    // .glass-chrome deliberately bakes NO radius (Vitrine anatomy) — the pill
    // primitive supplies the 16px dock radius itself.
    expect(pill.style.borderRadius).toBe('var(--radius-dock)');
    expect(screen.getByText('pill content')).toBeInTheDocument();
  });

  it('lets a consumer override the radius via style', () => {
    render(
      <ChromePill data-testid="pill" style={{ borderRadius: 14 }}>
        x
      </ChromePill>
    );
    expect(screen.getByTestId('pill').style.borderRadius).toBe('14px');
  });
});

describe('SectionLabel', () => {
  it('renders an uppercase letter-spaced accent label with a hairline', () => {
    const { container } = render(<SectionLabel className="extra">Edits</SectionLabel>);
    const label = screen.getByText('Edits');
    expect(label.style.textTransform).toBe('uppercase');
    expect(label.style.letterSpacing).toBe('1.4px');
    expect(label.style.color).toBe('var(--accent)');
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(container.firstElementChild).toHaveClass('extra');
  });
});

describe('GlassButton', () => {
  it('default variant: secondary chrome anatomy, fires onClick, type=button', () => {
    const onClick = jest.fn();
    render(<GlassButton onClick={onClick}>Cancel</GlassButton>);
    const btn = screen.getByRole('button', { name: 'Cancel' });
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn).toHaveClass('glass-modal-btn-secondary');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('accent variant: accent-soft fill + accent text + ring, distinct from default', () => {
    render(<GlassButton variant="accent">Waveform</GlassButton>);
    const btn = screen.getByRole('button', { name: 'Waveform' });
    expect(btn).not.toHaveClass('glass-modal-btn-secondary');
    expect(btn).not.toHaveClass('glass-modal-btn-primary');
    expect(btn.style.background).toBe('var(--accent-soft)');
    expect(btn.style.color).toBe('var(--accent)');
    expect(btn.style.boxShadow).toContain('var(--accent-ring)');
  });

  it('primary variant: solid-accent modal primary anatomy, distinct from default', () => {
    render(<GlassButton variant="primary">Create Remix</GlassButton>);
    const btn = screen.getByRole('button', { name: 'Create Remix' });
    expect(btn).toHaveClass('glass-modal-btn-primary');
    expect(btn).not.toHaveClass('glass-modal-btn-secondary');
  });

  it('passes disabled, className, aria and testid through', () => {
    render(
      <GlassButton disabled className="extra" aria-label="do it" data-testid="gb">
        Go
      </GlassButton>
    );
    const btn = screen.getByTestId('gb');
    expect(btn).toBeDisabled();
    expect(btn).toHaveClass('extra');
    expect(btn).toHaveAttribute('aria-label', 'do it');
  });
});

describe('GlassField', () => {
  it('renders a token-styled input, forwards the ref, works controlled', () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = jest.fn();
    render(
      <GlassField
        ref={ref}
        aria-label="Length"
        value="0:32"
        onChange={onChange}
        data-testid="field"
      />
    );
    const field = screen.getByLabelText('Length') as HTMLInputElement;
    expect(ref.current).toBe(field);
    expect(field.value).toBe('0:32');
    // jsdom serializes the declared rgba(255,255,255,.04) with normalized spacing.
    expect(field.style.background).toBe('rgba(255, 255, 255, 0.04)');
    expect(field.style.color).toBe('var(--glass-text-label)');
    fireEvent.change(field, { target: { value: '0:48' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('merges className through', () => {
    render(<GlassField aria-label="x" defaultValue="" className="extra" />);
    expect(screen.getByLabelText('x')).toHaveClass('extra');
  });
});

describe('GlassSelect (G5)', () => {
  it('renders a token-styled select with GlassField anatomy, forwards the ref, works controlled', () => {
    const ref = createRef<HTMLSelectElement>();
    const onChange = jest.fn();
    render(
      <GlassSelect ref={ref} aria-label="Format" value="wav" onChange={onChange} data-testid="sel">
        <option value="wav">WAV</option>
        <option value="mp3">MP3</option>
      </GlassSelect>
    );
    const select = screen.getByLabelText('Format') as HTMLSelectElement;
    expect(ref.current).toBe(select);
    expect(select.value).toBe('wav');
    // Same field anatomy as GlassField (Vitrine glassFormStyles: select === input)
    // in every respect BUT the background, which MT1-4 made opaque: the select's
    // native popup is painted with it off the glass surface, where the shared
    // `rgba(255,255,255,.04)` tint composites to near-white under light-gray
    // option text. The token's value is what that tint composited to on the
    // stage, so the closed control is unchanged — which is what this line, and
    // the identical radius/colour/padding below it, still pin.
    expect(select.style.background).toBe('var(--glass-field-bg)');
    expect(select.style.color).toBe('var(--glass-text-label)');
    expect(select.style.borderRadius).toBe('8px');
    fireEvent.change(select, { target: { value: 'mp3' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('merges className through', () => {
    render(
      <GlassSelect aria-label="x" defaultValue="a" className="extra">
        <option value="a">a</option>
      </GlassSelect>
    );
    expect(screen.getByLabelText('x')).toHaveClass('extra');
  });
});

describe('FieldLabel (G5)', () => {
  it('renders a real <label> (htmlFor association intact) in muted field-label anatomy', () => {
    render(
      <>
        <FieldLabel htmlFor="fl-target">Target length</FieldLabel>
        <input id="fl-target" defaultValue="" />
      </>
    );
    const input = screen.getByLabelText('Target length');
    expect(input.id).toBe('fl-target');
    const label = screen.getByText('Target length');
    expect(label.tagName).toBe('LABEL');
    expect(label.style.color).toBe('var(--glass-text-muted)');
    expect(label.style.display).toBe('block');
  });

  it('merges className and testid through', () => {
    render(
      <FieldLabel className="extra" data-testid="fl">
        x
      </FieldLabel>
    );
    expect(screen.getByTestId('fl')).toHaveClass('extra');
  });
});

describe('GlassSlider', () => {
  it('renders a range input with the .glass-slider-thumb contract over an inset track', () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = jest.fn();
    const { container } = render(
      <GlassSlider
        ref={ref}
        aria-label="Crossfade"
        min={0}
        max={200}
        value={25}
        onChange={onChange}
      />
    );
    const slider = screen.getByLabelText('Crossfade') as HTMLInputElement;
    expect(slider.type).toBe('range');
    expect(slider).toHaveClass('glass-slider-thumb');
    expect(slider).not.toHaveClass('is-edited');
    expect(ref.current).toBe(slider);
    expect(slider.min).toBe('0');
    expect(slider.max).toBe('200');
    expect(slider.value).toBe('25');
    // The 5px inset track is presentational only.
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    fireEvent.change(slider, { target: { value: '50' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('carries .is-edited when edited, and puts className on the wrapper', () => {
    const { container } = render(
      <GlassSlider aria-label="x" edited className="extra" min={0} max={1} defaultValue={0} />
    );
    expect(screen.getByLabelText('x')).toHaveClass('glass-slider-thumb', 'is-edited');
    expect(container.firstElementChild).toHaveClass('extra');
  });
});

describe('IconTile', () => {
  it('renders an accent-soft tile with accent ring and accent glyph color', () => {
    render(
      <IconTile data-testid="tile" className="extra">
        <svg data-testid="glyph" />
      </IconTile>
    );
    const tile = screen.getByTestId('tile');
    expect(tile).toHaveClass('extra');
    expect(tile.style.background).toBe('var(--accent-soft)');
    expect(tile.style.color).toBe('var(--accent)');
    expect(tile.style.border).toContain('var(--accent-ring)');
    expect(screen.getByTestId('glyph')).toBeInTheDocument();
  });
});
