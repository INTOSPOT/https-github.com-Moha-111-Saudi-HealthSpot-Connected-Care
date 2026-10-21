# 1. Benchmark (source-backed, with stated limits)

## Research limitation (read first)
Only one web-search tool was available. It returned an AI-written summary with citations to official pages; **the cited pages themselves were not opened or read in this session**, and no published outcome studies were retrieved. Everything below is therefore labelled **Documented (per search summary citing an official page)** or **Unknown (not found in the material reviewed — this is NOT a claim that the feature is absent)**. Re-verify against the primary sources before any external use.

Sources (cited by the search tool):
- S1 Dexcom Clarity for clinics: https://provider.dexcom.com/products/dexcom-clarity
- S2 Dexcom Clarity Clinic user guide (PDF): https://productstore.clarity.dexcom.com/Documentation/en/Dexcom_Clarity_User_Guide_Clinic.pdf
- S3 Dexcom Clarity for Professionals (Canada): https://ca.provider.dexcom.com/data-analysis-dexcom-clarity
- mySugr and Glooko statements came from the same summary **without a retrievable official URL** → treated as *unverified*; official pages must be located.

| Dimension | Dexcom Clarity (S1–S3) | Glooko population dashboard (unverified source) | mySugr (unverified source) |
|---|---|---|---|
| Patient data entry / adherence | Documented: automatic upload from compatible Dexcom CGMs (reduces manual entry). Adherence support: Unknown | Documented (summary): device-data aggregation, device-usage metrics. Patient-side adherence prompts: Unknown | Documented (summary): patient logbook for self-management. Reminders/adherence design: Unknown |
| Clinician prioritisation / workload | Documented: dashboard of shared patients with alerting for critical outlier readings. Workload effect: Unknown | Documented (summary): population view, risk stratification, flags for patients needing attention. Stratification method: Unknown | Unknown (summary: no standalone clinician dashboard — not verified) |
| Follow-up ownership & closure | Unknown (not found) | Documented (summary): care-plan tracking. Task owner / closure states: Unknown | Unknown |
| Explainability | Documented: interactive pattern/trend/AGP reports a clinician can inspect. Why a patient is flagged: Unknown | Unknown | Unknown |
| Arabic / accessibility | Unknown | Unknown | Unknown (the summary suggested Arabic is not listed; absence of listing ≠ absence of support) |
| Evidence for outcomes | Documented: billing support for CGM interpretation (CPT 95251). Outcome studies: not retrieved | Not retrieved | Not retrieved |

## What this means for design (hypotheses, not facts)
Reviewed material emphasises **data display and flagging**; it did not surface (unknown ≠ absent) explicit follow-up task ownership/closure, flag explanations, or Arabic-first workflows. HealthSpot's demonstrator therefore tests those three gaps *operationally*.

## Three design principles applied
1. **Show the reason, not just the flag** — every worklist position lists rule, version, observations, timestamps, data limits and tie-break reason.
2. **Separate data problems from clinical-review triggers** — quality, completeness, triggers and workflow urgency are independent dimensions; no composite score.
3. **Close the loop with an owner and a trace** — explicit state model, owner, due times, clinician-approved messages, append-only event history.

Branding and interface are original; no product assets are used. No "first/best/unique" claims are made.
