# 3. Design rationale (concise)
- **Three connected views over one event log**: patient (submit / received? / awaiting me), clinician (worklist + detail), reviewer (walkthrough + metrics + decision table). A fourth *scenario inspector* replays each synthetic scenario from scratch.
- **Arabic-first RTL** with English toggle; logical CSS properties; ≥44 px targets; visible focus; text labels with colour (never colour alone); skip link; `aria-live` notices; tables collapse to cards on mobile.
- **Every element supports a decision**: tier chips → who first; data column → can I trust it; owner/unresolved → who acts; no decorative charts.
- **States designed**: empty list, no readings, no tasks, form validation errors, blocked treatment text, closed/reopened, insufficient information.
- **Simulation clock** (UTC+3 display) makes overdue/stale/missing logic reproducible and demonstrable.
- **Original branding** (✚ glyph, teal palette); no third-party assets.
