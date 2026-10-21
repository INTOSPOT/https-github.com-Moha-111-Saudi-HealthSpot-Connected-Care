# HealthSpot — Diabetes Follow-up Demonstrator

Arabic-first (RTL, English toggle) prototype of a diabetes follow-up loop for an innovation review. **Synthetic data only. Rules/thresholds are simulation settings requiring clinical validation. Not validated triage, prediction or AI. Not deployed.**

```
npm install
npm run dev      # http://localhost:5173
npm test         # 42 unit/scenario tests
npm run build    # typecheck + production build
```

- `src/core/` — UI-independent engine (quality, completeness, triggers, priority, event-sourced workflow, metrics, scenarios).
- `src/ui/` — vanilla TypeScript views (Patient, Clinician, Reviewer, Scenario inspector), no framework.
- `docs/` — benchmark, algorithm spec & decision table, design rationale, evaluation & verification, limitations, Arabic brief, 3-minute Arabic script.

State is stored in browser localStorage (use "Reset demo" to restore the seeded scenarios). Simulation clock starts at 2026-03-10 08:00 UTC.
