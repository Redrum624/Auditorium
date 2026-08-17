import type { ComponentPropsWithRef, ComponentPropsWithoutRef, CSSProperties } from 'react';

/**
 * v1.6 "Glass · Sectioned" primitives (task G1). Thin presentational wrappers
 * over the Vitrine tokens ported into src/index.css — no logic, no state:
 * every component here is a single element (or element + presentational
 * siblings) whose anatomy is copied from Vitrine's components
 * (photo_app/src/components/{Controls,Layout,Dialogs}) per the plan's
 * ruling 1, with the accent already cyan via the tokens (ruling 2). Vitrine
 * is the same author's photo-viewer project, so the copied anatomy is
 * first-party code — self-licensed, no third-party attribution required.
 *
 * Anatomy quick-reference (Vitrine):
 *  - card: radius 20 (--radius-card) · blur 28 · --glass-shadow  → .glass-card
 *  - chrome: radius 16 (--radius-dock) · blur 24 · chrome shadow → .glass-chrome
 *  - section label: 10px/700, 1.4px tracking, uppercase, accent + hairline
 *  - icon tile: accent-soft fill + 1px accent-ring border + accent glyph
 *
 * Nothing consumes these until G2+ — rendering none of them is a pixel-level
 * no-op for the app.
 */

/** Glass panel/dialog card: `.glass-card` (bakes the 20px --radius-card). */
export function GlassCard({ className = '', ...rest }: ComponentPropsWithoutRef<'div'>) {
  return <div className={`glass-card ${className}`} {...rest} />;
}

/**
 * Floating chrome pill (toolbar, icon rail, status bar): `.glass-chrome`
 * deliberately bakes no radius (Vitrine anatomy — each floating element sets
 * its own), so the pill supplies the 16px dock radius as an overridable
 * default (e.g. the G3 toolbar pill will pass 14).
 */
export function ChromePill({ className = '', style, ...rest }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      className={`glass-chrome ${className}`}
      style={{ borderRadius: 'var(--radius-dock)', ...style }}
      {...rest}
    />
  );
}

/**
 * Section header inside a glass card: 10px/700 uppercase accent text followed
 * by a fading hairline. Ported from Vitrine's Controls/SectionLabel.tsx.
 */
export function SectionLabel({ className = '', children, ...rest }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div className={`flex items-center ${className}`} style={{ gap: 8 }} {...rest}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '1.4px',
          textTransform: 'uppercase',
          color: 'var(--accent)',
          whiteSpace: 'nowrap',
        }}
      >
        {children}
      </span>
      <span
        aria-hidden="true"
        style={{
          flex: 1,
          height: 1,
          background: 'linear-gradient(to right, rgba(255,255,255,.12), transparent)',
        }}
      />
    </div>
  );
}

export type GlassButtonVariant = 'default' | 'accent' | 'primary';

/** Idle chrome-secondary button (mockup `.btn` / Vitrine modal secondary). */
const defaultBtn: CSSProperties = {
  padding: '6px 14px',
  borderRadius: 9,
  fontSize: 12.5,
  border: '1px solid var(--glass-border)',
  background: 'rgba(255,255,255,.05)',
  color: 'var(--glass-text-chrome-primary)',
};

/** Selected/active accent chip (mockup `.tb.accent`, `.chip.accent`). */
const accentBtn: CSSProperties = {
  padding: '6px 14px',
  borderRadius: 9,
  fontSize: 12.5,
  border: '1px solid transparent',
  background: 'var(--accent-soft)',
  color: 'var(--accent)',
  boxShadow: '0 0 0 1px var(--accent-ring)',
};

/** Solid-accent primary (Vitrine Controls/AccentButton.tsx layout; fill/glow
 *  and interactive states come from `.glass-modal-btn-primary`). */
const primaryBtn: CSSProperties = {
  padding: '9px 18px',
  borderRadius: 11,
  fontSize: 12.5,
  fontWeight: 700,
};

const BUTTON_STYLES: Record<GlassButtonVariant, CSSProperties> = {
  default: defaultBtn,
  accent: accentBtn,
  primary: primaryBtn,
};

const BUTTON_CLASSES: Record<GlassButtonVariant, string> = {
  default: 'glass-modal-btn-secondary',
  accent: '',
  primary: 'glass-modal-btn-primary',
};

/**
 * Glass button in Vitrine's three roles: `default` (idle chrome secondary —
 * Cancel, Re-detect), `accent` (soft accent chip — the active segment/state),
 * `primary` (solid accent with glow — Create Remix, Apply, Export).
 */
export function GlassButton({
  variant = 'default',
  className = '',
  style,
  type = 'button',
  disabled,
  ...rest
}: ComponentPropsWithoutRef<'button'> & { variant?: GlassButtonVariant }) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={`${BUTTON_CLASSES[variant]} inline-flex items-center justify-center gap-2 ${className}`}
      style={{
        ...BUTTON_STYLES[variant],
        cursor: disabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
      {...rest}
    />
  );
}

/**
 * Token-styled text/number input (Vitrine Dialogs/glassFormStyles.ts
 * `inputStyle`, verbatim). Forwards its ref — dialog consumers focus fields.
 */
export function GlassField({ className = '', style, ...rest }: ComponentPropsWithRef<'input'>) {
  return (
    <input
      className={className}
      style={{
        width: '100%',
        fontSize: 12,
        padding: '6px 8px',
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,.1)',
        background: 'rgba(255,255,255,.04)',
        color: 'var(--glass-text-label)',
        ...style,
      }}
      {...rest}
    />
  );
}

/**
 * Token-styled select (G5): Vitrine's `glassFormStyles.selectStyle`, which is
 * defined as an ALIAS of `inputStyle` — selects and inputs share the exact
 * same field anatomy, so this mirrors GlassField on a `<select>`.
 *
 * MT1-4 — with ONE deliberate divergence from `GlassField`, which is why the
 * alias is no longer literal: the background is the OPAQUE `--glass-field-bg`
 * rather than the shared `rgba(255,255,255,.04)` tint. A select spawns a native
 * dropdown popup that Chromium paints with this background but NOT on the glass
 * surface, so a 4%-white tint that reads dark on the stage reads near-white in
 * the popup and buries the light-gray option text. `GlassField` keeps the tint
 * because an `<input>` has no popup to get it wrong. The token's value is the
 * composite the tint already produced, so this control looks unchanged closed.
 * See the `select` block in `src/index.css` and `nativeSelect.test.tsx`.
 */
export function GlassSelect({ className = '', style, ...rest }: ComponentPropsWithRef<'select'>) {
  return (
    <select
      className={className}
      style={{
        width: '100%',
        fontSize: 12,
        padding: '6px 8px',
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,.1)',
        background: 'var(--glass-field-bg)',
        color: 'var(--glass-text-label)',
        ...style,
      }}
      {...rest}
    />
  );
}

/**
 * Muted field label above a GlassField/GlassSelect (G5): the mockup's `.lbl`
 * anatomy (block, small, muted, 4px below-gap). A real `<label>` so `htmlFor`
 * associations — which several dialog tests query by — keep working.
 */
export function FieldLabel({ className = '', style, ...rest }: ComponentPropsWithoutRef<'label'>) {
  return (
    <label
      className={className}
      style={{
        display: 'block',
        fontSize: 11,
        color: 'var(--glass-text-muted)',
        marginBottom: 4,
        ...style,
      }}
      {...rest}
    />
  );
}

/**
 * Bare glass slider: the 5px inset track + `.glass-slider-thumb` range input
 * from Vitrine's Controls/SliderRow.tsx, WITHOUT the label/value-chip/detent
 * logic (G1 primitives carry no logic — a later consumer composes those).
 * `className` styles the wrapper (sizing); everything else, including the
 * ref, goes to the input. `edited` mirrors SliderRow's `.is-edited` accent
 * glow for values off their default.
 */
export function GlassSlider({
  className = '',
  style,
  edited = false,
  ...rest
}: ComponentPropsWithRef<'input'> & { edited?: boolean }) {
  return (
    <div className={className} style={{ position: 'relative', height: 5 }}>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 3,
          background: 'rgba(255,255,255,.09)',
          boxShadow: 'inset 0 1px 2px rgba(0,0,0,.6)',
          pointerEvents: 'none',
        }}
      />
      <input
        type="range"
        className={`glass-slider-thumb${edited ? ' is-edited' : ''}`}
        style={{ position: 'absolute', inset: 0, width: '100%', margin: 0, background: 'transparent', ...style }}
        {...rest}
      />
    </div>
  );
}

/**
 * Accent icon tile (card headers, active rail states): accent-soft fill,
 * 1px accent-ring border, accent glyph. 28px/radius 8 per Vitrine's
 * ModuleCardHeader icon chip; pass a ~15px lucide glyph as children.
 */
export function IconTile({ className = '', style, ...rest }: ComponentPropsWithoutRef<'span'>) {
  return (
    <span
      className={`inline-flex items-center justify-center flex-shrink-0 ${className}`}
      style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        background: 'var(--accent-soft)',
        border: '1px solid var(--accent-ring)',
        color: 'var(--accent)',
        ...style,
      }}
      {...rest}
    />
  );
}
