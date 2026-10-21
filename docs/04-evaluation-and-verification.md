# 4. Pilot evaluation outline and verification

## Future comparison (usability / workflow evaluation — NOT a clinical trial)
- **Design:** within-participant crossover; the same synthetic case set (≥30 cases incl. the 7 scenarios) shown to each reviewer as (A) the proposed worklist and (B) a basic chronological newest-first list, order counterbalanced.
- **Participants:** clinicians/nurses from 1–2 diabetes clinics (n to be decided with the MOH innovation team).
- **Measures:** correct identification of cases the panel pre-labelled "needs review"; time to first correct selection; ownership/closure errors; perceived workload (e.g. NASA-TLX); comprehension of explanations; Arabic usability (SUS Arabic).
- **Hypotheses (unproven):** the proposed list reduces missed pre-labelled cases and ownership ambiguity. Panel labels must be set before viewing either list.
- **Out of scope:** patient outcomes, clinical validity of thresholds, deployment.

## Automated verification
`npm test` — 42 Vitest tests: validation & unit conversion, duplicates, missing/stale/implausible data, rule boundaries (70/180, 3rd reading, 72 h window), overlapping triggers, stable ordering (input-order independent), duplicate-trigger prevention, reopening, transitions & authorisation, overrides, treatment-text guard, event-based metrics, serialisation round-trip, clock monotonicity, each of the 9 scenarios. `npm run build` (typecheck + Vite production build) passes.

## Browser verification (headless Chrome via playwright-core, scripted)
Performed: Arabic RTL render; patient form error state and flagged-submission state; full loop (submit → acknowledge → assign → approved message → patient reply → close → closed tab); override rejected without reason then accepted and re-ranked; timed review session; English LTR toggle; desktop (1280) and mobile (390) layouts, no horizontal overflow after fix; console clean after favicon fix. Defects found and repaired: collapsed override section/lost input after validation error; off-screen skip-link and hidden table header causing mobile horizontal scroll.
**Not performed:** screen-reader testing, formal WCAG audit/contrast tooling, cross-browser (only Chromium), real-user Arabic review, the Playwright MCP tool (unavailable).
