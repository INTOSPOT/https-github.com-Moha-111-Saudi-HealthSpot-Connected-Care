# 2. Algorithm specification (deterministic, explainable, NOT validated)

All thresholds are **illustrative simulation settings (`sim-1.0`) requiring clinical validation**. The engine is not validated triage, prediction or AI. No composite risk score exists. Code: `src/core/` (no UI imports).

## Dimensions (computed independently)
| Dimension | Module | Output |
|---|---|---|
| A Data quality | `quality.ts` | per reading: `valid / questionable / duplicate / invalid` + flags. Raw values are never edited or deleted. mmol/L → mg/dL ×18.016 (original kept). |
| B Completeness | `completeness.ts` | received vs expected over fully elapsed UTC days of the patient's explicit schedule (window 7 d). States: `adequate (≥80%)`, `incomplete`, `insufficient_information` (no schedule or <2 elapsed days) |
| C Review triggers | `triggers.ts` | R-CALL, R-OOR, R-MISS, R-QUAL (each versioned, `1.0`) |
| D Workflow urgency | `prioritise.ts` | unacknowledged > 4 h, overdue task, overdue patient reply, unresolved prior items after reopening |

### Quality flags
Missing value/unit/time and unknown unit or unparsable time → `invalid`. Future time (>10 min), stale (>14 d), implausible (<20 or >600 mg/dL), possible unit mix-up (mg/dL value 1–35, e.g. 7.4 typed as mg/dL) → `questionable`. Same value within 5 min of an earlier reading → `duplicate`. Only `valid` readings feed R-OOR; questionable/invalid are surfaced for verification (R-QUAL).

## Decision table (priority hierarchy; tier 1 = highest)
| Tier | Condition |
|---|---|
| 1 | R-CALL: open callback request not yet resolved by a closure |
| 2 | R-OOR: ≥3 valid readings, same direction, outside 70–180 mg/dL within 72 h |
| 3 | Workflow: new case unacknowledged >4 h; task past due; patient reply overdue (48 h) |
| 4 | R-MISS: ≥2 consecutive fully elapsed scheduled days without any usable reading |
| 5 | R-QUAL: questionable/invalid reading with no later valid reading |
| 6 | Open case with no active trigger (monitor only) |

Case tier = best (lowest) tier among its active items. A simulated clinician may **override** the tier (required reason; recorded with actor/time; clearable). Base tier stays visible.

## Deterministic tie-breakers (in order)
tier ↑ → workflow urgency present first → more active triggers → earliest evidence → patient id. The worklist shows which key separated an item from the next one.

## Explanation exposed per item
Triggering observations (ids), rule + version, first/latest evidence timestamps, data-quality limitations, completeness, and reason keys for the position.

## Follow-up state model
`New → Acknowledged → Follow-up assigned → Awaiting response → Reassessment → Closed`; `Reassessment → Follow-up assigned` (further follow-up, new task); `Closed → New` (reopen). Only clinicians act on cases; only patients respond; invalid transitions are rejected. Messages are clinician-approved; text containing medication/treatment terms is rejected. The system never adapts medication or treatment.

**Duplicate prevention:** each trigger has an evidence key (rule + observation ids). Keys already seen on a case create no event. **Reopen:** a closed case reopens only for a trigger whose latest evidence is newer than the closure and whose key is unseen.

## Metrics (`metrics.ts`, derived from the event log only)
Completeness (received/expected), time to acknowledgement and to documented follow-up (median, with n), task completion (+open/overdue), closed episodes, open/overdue cases, timed simulated review sessions. Unresolved items are listed, never hidden. Synthetic runs are not effectiveness evidence.
