# Auditorium — Keyboard Shortcuts

This table is transcribed directly from `src/services/shortcuts.ts`
(`SHORTCUT_TABLE`), which is the single source of truth the app's global
key-handler reads from. Keep the two in sync: if you add or change a row here,
change `SHORTCUT_TABLE` to match (or vice versa).

Shortcuts are ignored while focus is inside a text input, textarea, select, or
a `contenteditable` element, so they never hijack normal typing (e.g. renaming
a track or a marker).

They are also suspended while a **modal dialog** is open (New File, Export,
Convert, Record), and — in the module column — while a **pipeline pass** or an
**effect Apply** is actually running.
Both suspensions exist for the same reason: those surfaces resolve the document
they act on at the moment you confirm, so a `Ctrl+O` behind one would land the
result on a file you had just replaced. A pipeline tool or an effect card that
is merely OPEN and idle suspends nothing — the whole point of hosting it beside
the waveform is that you can keep working — and the keys come back by
themselves when the pass finishes. Mouse interaction is never suspended by
either; an effect Apply guards itself instead — it commits only to the document
as you left it when you clicked Apply, and says so in the card if that changed
(see the User Guide).

| Shortcut | Action |
|---|---|
| `Space` | Play / Pause |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `Ctrl+Y` | Redo |
| `Ctrl+K` | Split at Cursor — a marker at the cursor, or at both edges of the selection |
| `Ctrl+X` | Cut the selection (or the cursor's segment) to the clipboard, leaving the span silent at the same length |
| `Ctrl+C` | Copy |
| `Ctrl+V` | Paste |
| `Delete` | Silence the selection in place at the same length (or remove every selected multitrack clip, leaving the gap) |
| `Shift+Delete` | Ripple Delete — editor: remove the selection and close the gap; multitrack: remove the selected clip(s) and close the gap |
| `Ctrl+A` | Select All — the whole file in the editor; **every clip on every track** in the multitrack view |
| `Ctrl+Left` | Previous clip edge — multitrack only |
| `Ctrl+Right` | Next clip edge — multitrack only |
| `Home` | Go to Start — the file's, or the **session's** in the multitrack view |
| `End` | Go to End — the file's, or the **end of the last clip** in the multitrack view |
| `Ctrl+O` | Open… |
| `Ctrl+S` | Save project (`.audm`, every view) |
| `Ctrl+Shift+S` | Save project As… |
| `Ctrl+N` | New… |
| `Ctrl+W` | Close |
| `M` | Add Marker at the cursor (editor views only) |
| `Ctrl+E` | Export… |
| `Escape` | Deselect — or, with an effect card open, closes the card (see below) |

## The multitrack-only rows

`Ctrl+Left` and `Ctrl+Right` address the **session timeline**, and their
commands report disabled anywhere else — pressed in the waveform or spectral
editor they do nothing at all, rather than doing something to a document you
cannot see. There is one global key table and no per-view table beside it:
every key runs a command, and a command re-checks its own predicate before it
runs, which is what makes a view-scoped key inert outside its view.
(`Shift+Delete` used to be in this list; it now ripples the editor's selection
too — see the table above.) `Ctrl+K` is the one view-ROUTED edit key: it drops
a marker in the editors and splits clips at the edit cursor in the multitrack,
where it is greyed with nothing selected.

**Merge Clips** — Split's inverse — has **no key at all**, and no row above
because there is nothing to put in one. You reach it through the edit pill's
**Merge** button or **Edit → Merge Clips**; both are multitrack-only and both
stay greyed until some track has two or more of its clips selected.

The rest of the multitrack clip verbs are mouse gestures rather than table rows:

| Gesture | What it does |
|---|---|
| `Ctrl+Click` on a clip | Adds it to the selection (or takes it back out). The clip you clicked last is the one the Properties panel's fields edit |
| `Shift+Click` on a clip | Extends the selection from the last-clicked clip to this one, taking every clip between them **on that track**. Across tracks it acts as a plain click. It adds to what is already selected, so it composes with `Ctrl+Click`; with both modifiers held, `Ctrl` wins and the click is a toggle |
| Drag any selected clip | Moves **every** selected clip by the same amount, as one undo step. Every member previews the move live, so what you see is what lands |
| Drag a group onto another track | The clip you grabbed joins the track under the pointer and the others shift by the same number of tracks, so the group keeps its shape. If that would push any member off the top or bottom of the track list, **nothing changes track** — the group is never scattered, and the highlighted lane is the one the grabbed clip will actually land on |
| `Ctrl` held at the **drop** of a **single-clip** drag | Still the push-clear nudge it has always been — the clip is pushed past the neighbour it would have overlapped, instead of crossfading into it |
| `Ctrl` held at the drop of a **group** drag (2+ clips) | **Nothing.** A group drag has no nudge in this version: pushing only the colliding member clear would change the spacing between the clips you are dragging, and a group drag that deforms the group is not the gesture you made. The group lands where you dropped it, and any overlap it creates arms a crossfade as usual |

In neither case does a held `Ctrl` toggle the selection — that is what
`Ctrl+Click` does, and a drag is not a click. The hint that appears over an
overlap mid-drag offers the `Ctrl` nudge only on a single-clip drag, for the
same reason.

**`Edit → Ripple Delete Time Selection`** has no key and is greyed out in every
view: it would ripple a stretch of *time* out of every track, and the multitrack
view has no gesture for selecting a stretch of time yet (its ruler seeks; there
is a cursor and a clip selection and nothing else). It carries no combo
deliberately — a matched combo is claimed before the command's own predicate is
consulted, so a key bound to a permanently disabled row would be swallowed in
every view and give nothing back.

## `Escape` and the two kinds of surface

`Escape` means one thing in the table above and another over a **modal dialog**,
since the Pipeline module it means nothing at all over a hosted pipeline tool,
and over an effect card it means what it meant when the effect was a dialog:

| Surface | What `Escape` does |
|---|---|
| The editor (nothing open) | Deselect, as above |
| The **multitrack** view | Clears the clip selection — the document selection behind it is not on screen there, so clearing that instead would be an edit with no feedback anywhere |
| A modal dialog (New File, Export, Convert, Record) | Closes the topmost one — unless it is mid-run, when it refuses |
| A **pipeline tool** in the module column (Match Tempo, Vocal Chain, Cover Chain, Transcribe, …) | Nothing. Close it with the **✕** in its header |
| An **effect card** in the module column, idle | **Closes the card** — the same as its **✕** or **Cancel**: a running **Preview** is stopped and the real document goes back to the engine. The selection is kept: the key does *not* fall through to Deselect |
| An **effect card** while **Apply** is running | Nothing, like the ✕ — the pass is never discarded. The key comes back when it finishes |
| A modal dialog opened over an effect card | The modal's: it closes, the card stays |

The pipeline-tool row is deliberate. A hosted tool is not modal — the stage
behind it stays live — so it installs no `Escape` handler of its own; taking
the key would make it a focus trap wearing a different shape. The **✕** is its
dismissal, and mid-pass that ✕ refuses and says why.

The effect card is the one hosted surface that does take the key, and it takes
only that key: an effect was a dialog until the 2026-08-18 program moved it
into the column, and `Escape` closed that dialog. Closing the card is what the
key means there — and not clearing the selection is the
point, because the card resolves the region it writes from the **live**
selection when Apply runs, reading "no selection" as the whole file; an
`Escape` that deselected instead would have quietly widened the next **Apply**
from the span you just previewed to the entire document. (Edit › Deselect and a
click on the waveform still do clear it beside an open card, and the card's
first line — "Selection — 0:01.500 → 0:03.500 (2.00 s)" / "Whole file —
5:00.000" — says so before you press Apply.) Two small rules keep the key
honest: `Escape` typed in a text field *outside* the card — a marker's inline
rename, say — belongs to that field, as every global key does; and with a
modal open over the card, the modal has it.

## Menu-only commands (no bound key)

These are reachable from the menus — File, Edit, Effects, Pipeline, View and
Help — but appear in no row of the key table above: none of them binds a key.
The list is derived from `src/services/menuActions.ts` (its `LAYOUT` plus the
effect-registry loop): every menu command registered without a `shortcut` is
here.

| Command | Menu location |
|---|---|
| Record | File → Record, or the transport bar's record button |
| Open Project… | File menu |
| Mix Down to New File | File menu, multitrack-only |
| Ripple Delete Time Selection | Edit menu — permanently greyed and deliberately key-less; see above |
| Trim to Selection / Silence Selection | Edit menu (also on the floating edit toolbar) |
| Convert Sample Rate… / Convert Channels… | Edit menu |
| Insert Active File at Cursor / Add Track | Edit menu, multitrack-only |
| Next Marker / Previous Marker | Edit menu |
| Capture Noise Print | Effects menu, top row (needs a selection) |
| Every effect in the rack | Effects menu — one row per registered effect under its category heading, each opening that effect's card in the module column; no effect has a key |
| Spatial Positioner | Effects menu, the closing Mix group |
| Detect Tempo / Match Tempo / Align Vocal Timing / Auto-Remix | Pipeline menu, Tempo & Timing group |
| Voice Changer / Vocal Chain / Cover Chain / Align Lyrics | Pipeline menu, Voice group |
| Transcribe / Separate into Stems | Pipeline menu, Analysis group |
| Waveform / Spectral / Multitrack | View menu |
| Spectral: Toggle Log/Linear Scale / Toggle Beat Grid / Toggle Snap to Grid | View menu |
| About Auditorium | Help menu |

Two transport commands are key-less AND menu-less — their only door is the
transport bar itself:

| Command | Where |
|---|---|
| Stop | Transport bar stop button |
| Loop toggle | Transport bar loop button |
