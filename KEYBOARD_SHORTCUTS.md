# Auditorium — Keyboard Shortcuts

This table is transcribed directly from `src/services/shortcuts.ts`
(`SHORTCUT_TABLE`), which is the single source of truth the app's global
key-handler reads from. Keep the two in sync: if you add or change a row here,
change `SHORTCUT_TABLE` to match (or vice versa).

Shortcuts are ignored while focus is inside a text input, textarea, select, or
a `contenteditable` element, so they never hijack normal typing (e.g. renaming
a track or a marker).

They are also suspended while a **modal dialog** is open (New File, Export,
Convert, Record, an effect's parameter dialog), and — new in the Pipeline
module — while a **pipeline pass is actually running** in the module column.
Both suspensions exist for the same reason: those surfaces resolve the document
they act on at the moment you confirm, so a `Ctrl+O` behind one would land the
result on a file you had just replaced. A pipeline tool that is merely OPEN and
idle suspends nothing — the whole point of hosting it beside the waveform is
that you can keep working — and the keys come back by themselves when the pass
finishes. Mouse interaction is never suspended by either.

| Shortcut | Action |
|---|---|
| `Space` | Play / Pause |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `Ctrl+Y` | Redo |
| `Ctrl+X` | Cut |
| `Ctrl+C` | Copy |
| `Ctrl+V` | Paste |
| `Delete` | Delete selection (or every selected multitrack clip) |
| `Shift+Delete` | Ripple Delete — multitrack only: remove the selected clip(s) and close the gap |
| `Ctrl+A` | Select All |
| `Ctrl+Left` | Previous clip edge — multitrack only |
| `Ctrl+Right` | Next clip edge — multitrack only |
| `Home` | Go to Start |
| `End` | Go to End |
| `Ctrl+O` | Open… |
| `Ctrl+S` | Save |
| `Ctrl+Shift+S` | Save As… |
| `Ctrl+N` | New… |
| `Ctrl+W` | Close |
| `M` | Add Marker at the cursor |
| `Ctrl+E` | Export… |
| `Escape` | Deselect |

## The multitrack-only rows

`Shift+Delete`, `Ctrl+Left` and `Ctrl+Right` address the **session timeline**,
and their commands report disabled anywhere else — pressed in the waveform or
spectral editor they do nothing at all, rather than doing something to a
document you cannot see. There is one global key table and no per-view table
beside it: every key runs a command, and a command re-checks its own predicate
before it runs, which is what makes a view-scoped key inert outside its view.

The rest of the multitrack clip verbs are mouse gestures rather than table rows:

| Gesture | What it does |
|---|---|
| `Ctrl+Click` on a clip | Adds it to the selection (or takes it back out). The clip you clicked last is the one the Properties panel's fields edit |
| Drag any selected clip | Moves **every** selected clip by the same amount, as one undo step. Clips stay on their own tracks |
| `Ctrl` held at the **drop** of a **single-clip** drag | Still the push-clear nudge it has always been — the clip is pushed past the neighbour it would have overlapped, instead of crossfading into it |
| `Ctrl` held at the drop of a **group** drag (2+ clips) | **Nothing.** A group drag has no nudge in this version: pushing only the colliding member clear would change the spacing between the clips you are dragging, and a group drag that deforms the group is not the gesture you made. The group lands where you dropped it, and any overlap it creates arms a crossfade as usual |

In neither case does a held `Ctrl` toggle the selection — that is what
`Ctrl+Click` does, and a drag is not a click.

## `Escape` and the two kinds of surface

`Escape` means one thing in the table above and another over a **modal dialog**,
and since the Pipeline module it means nothing at all over a hosted tool:

| Surface | What `Escape` does |
|---|---|
| The editor (nothing open) | Deselect, as above |
| The **multitrack** view | Clears the clip selection — the document selection behind it is not on screen there, so clearing that instead would be an edit with no feedback anywhere |
| A modal dialog (New File, Export, Convert, Record, an effect's parameters) | Closes the topmost one — unless it is mid-run, when it refuses |
| A **pipeline tool** in the module column (Match Tempo, Vocal Chain, Cover Chain, Transcribe, …) | Nothing. Close it with the **✕** in its header |

The last row is deliberate. A hosted tool is not modal — the stage behind it
stays live — so it installs no `Escape` handler of its own; taking the key would
make it a focus trap wearing a different shape, and would silently steal
Deselect from the waveform you are still working in. The **✕** is its dismissal,
and mid-pass that ✕ refuses and says why.

## Menu-only commands (no bound key)

These are reachable from the **Edit** menu but are not in the global keydown
table above:

| Command | Menu location |
|---|---|
| Next Marker | Edit → Next Marker |
| Previous Marker | Edit → Previous Marker |
| Record | File → Record, or the transport bar's record button |
| Loop toggle | Transport bar loop button |
| Convert Sample Rate… / Convert Channels… | Edit menu |
| Insert Active File at Cursor / Add Track / Mix Down to New File | Edit /
File menus, multitrack-only |
