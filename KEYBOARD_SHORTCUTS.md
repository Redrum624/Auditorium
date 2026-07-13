# Auditorium — Keyboard Shortcuts

This table is transcribed directly from `src/services/shortcuts.ts`
(`SHORTCUT_TABLE`), which is the single source of truth the app's global
key-handler reads from. Keep the two in sync: if you add or change a row here,
change `SHORTCUT_TABLE` to match (or vice versa).

Shortcuts are ignored while focus is inside a text input, textarea, select, or
a `contenteditable` element, so they never hijack normal typing (e.g. renaming
a track or a marker).

| Shortcut | Action |
|---|---|
| `Space` | Play / Pause |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `Ctrl+Y` | Redo |
| `Ctrl+X` | Cut |
| `Ctrl+C` | Copy |
| `Ctrl+V` | Paste |
| `Delete` | Delete selection (or the selected multitrack clip) |
| `Ctrl+A` | Select All |
| `Home` | Go to Start |
| `End` | Go to End |
| `Ctrl+O` | Open… |
| `Ctrl+S` | Save |
| `Ctrl+N` | New… |
| `M` | Add Marker at the cursor |
| `Ctrl+E` | Export… |
| `Escape` | Deselect |

## Menu-only commands (no bound key)

These are reachable from the **Edit** menu but are not in the global keydown
table above:

| Command | Menu location |
|---|---|
| Next Marker | Edit → Next Marker |
| Previous Marker | Edit → Previous Marker |
| Save As… | File → Save As… (`Ctrl+Shift+S` shown in the menu, but the
global handler does not intercept it — use the menu) |
| Close | File → Close (`Ctrl+W` shown in the menu; use the menu) |
| Loop toggle | Transport bar loop button |
| Record | Transport bar record button |
| Convert Sample Rate… / Convert Channels… | Edit menu |
| Insert Active File at Cursor / Add Track / Mix Down to New File | Edit /
File menus, multitrack-only |
