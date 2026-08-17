# Security Policy

Report vulnerabilities privately via GitHub Security Advisories ("Report a
vulnerability" on the repository's Security tab) — not public issues.

You'll get a response within 7 days. Please include reproduction steps, the
app version (Help → About, or the installer filename), and your OS.

Auditorium is a local desktop app: it makes no network requests except
downloading ML models on first use of the features that need them, and its
local servers/IPC are restricted to the app's own processes. Reports about
that boundary (renderer sandbox escapes, IPC path traversal, model-download
integrity) are especially valuable.
