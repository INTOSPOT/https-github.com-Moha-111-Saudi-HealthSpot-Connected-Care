import { TIER } from './config';
import { assessCompleteness } from './completeness';
import { assessReadings, parseTime } from './quality';
import { evaluateTriggers } from './triggers';
import { caseIdFor } from './workflow';
import type { Config, Derived, UrgencyFlag, WorklistItem } from './types';

const H = 3_600_000;
const hrs = (ms: number) => Math.round((ms / H) * 10) / 10;

export function urgencyFor(d: Derived, patientId: string, nowMs: number, cfg: Config): UrgencyFlag[] {
  const c = d.cases[caseIdFor(patientId)];
  const flags: UrgencyFlag[] = [];
  if (!c || c.state === 'closed') return flags;
  if (c.state === 'new' && nowMs - Date.parse(c.stateSince) > cfg.ackSlaHours * H)
    flags.push({ kind: 'unacknowledged', hours: hrs(nowMs - Date.parse(c.stateSince)) });
  for (const t of d.tasks.filter((t) => t.caseId === c.id && !t.completedAt && Date.parse(t.dueAt) < nowMs))
    flags.push({ kind: 'overdue_task', hours: hrs(nowMs - Date.parse(t.dueAt)), taskId: t.id });
  if (c.state === 'awaiting_response' && c.responseDueAt && Date.parse(c.responseDueAt) < nowMs)
    flags.push({ kind: 'response_overdue', hours: hrs(nowMs - Date.parse(c.responseDueAt)) });
  const unresolved = d.tasks.filter((t) => t.caseId === c.id && !t.completedAt).length + d.messages.filter((m) => m.caseId === c.id && !m.response).length;
  if (c.reopenCount > 0 && unresolved > 0) flags.push({ kind: 'unresolved_prior', count: unresolved });
  return flags;
}

export function unresolvedList(d: Derived, patientId: string): string[] {
  const c = d.cases[caseIdFor(patientId)];
  const out: string[] = [];
  if (c && c.state !== 'closed') {
    if (c.state === 'new') out.push('unresolved.unacknowledged');
    if (d.tasks.some((t) => t.caseId === c.id && !t.completedAt)) out.push('unresolved.task');
    if (c.state === 'awaiting_response') out.push('unresolved.patientResponse');
    if (c.state === 'reassessment') out.push('unresolved.reassessment');
  }
  return out;
}

/**
 * Documented priority hierarchy (docs/algorithm-spec.md). No composite risk score.
 * sort keys, in order: tier asc; urgency flag present first; more active triggers first;
 * earliest evidence first; patient id asc.
 */
export function buildWorklist(d: Derived, nowMs: number, cfg: Config): { items: WorklistItem[]; closed: WorklistItem[]; quiet: WorklistItem[] } {
  const all: WorklistItem[] = d.patients.map((p) => {
    const assessed = assessReadings(d.readings.filter((r) => r.patientId === p.id), nowMs, cfg);
    const completeness = assessCompleteness(p, assessed, nowMs, cfg);
    const triggers = evaluateTriggers(p.id, d, assessed, completeness, nowMs, cfg);
    const c = d.cases[caseIdFor(p.id)];
    const urgencyFlags = urgencyFor(d, p.id, nowMs, cfg);
    let baseTier: number = TIER.MONITOR;
    const reasonKeys: WorklistItem['reasonKeys'] = [];
    for (const t of triggers) {
      baseTier = Math.min(baseTier, t.tier);
      reasonKeys.push({ key: 'reason.trigger', params: { rule: t.ruleId, version: t.ruleVersion, tier: t.tier } });
    }
    if (urgencyFlags.some((f) => f.kind !== 'unresolved_prior')) {
      baseTier = Math.min(baseTier, TIER.WORKFLOW_OVERDUE);
      reasonKeys.push({ key: 'reason.workflow', params: { tier: TIER.WORKFLOW_OVERDUE } });
    }
    const tier = c?.override?.tier ?? baseTier;
    if (c?.override) reasonKeys.push({ key: 'reason.override', params: { tier: c.override.tier, base: baseTier } });
    if (!reasonKeys.length) reasonKeys.push({ key: 'reason.none', params: {} });
    const evid = [...triggers.map((t) => parseTime(t.firstEvidenceAt)!), ...(c ? [parseTime(c.openedAt)!] : [])];
    const oldest = evid.length ? Math.min(...evid) : Number.MAX_SAFE_INTEGER;
    return {
      patientId: p.id, caseId: c ? c.id : null, rank: 0, tier, baseTier, overridden: !!c?.override, triggers, urgencyFlags,
      assessed, completeness, state: c ? c.state : 'no_case', owner: c?.owner ?? null, unresolved: unresolvedList(d, p.id),
      reasonKeys, tieBreakers: [tier, urgencyFlags.length ? 0 : 1, -triggers.length, oldest, p.id],
    };
  });
  const cmp = (a: WorklistItem, b: WorklistItem) => {
    for (let i = 0; i < a.tieBreakers.length; i++) {
      const x = a.tieBreakers[i], y = b.tieBreakers[i];
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  };
  const items = all.filter((i) => i.state !== 'closed' && i.state !== 'no_case').sort(cmp);
  items.forEach((it, idx) => {
    it.rank = idx + 1;
    const next = items[idx + 1];
    if (next) {
      const names = ['tier', 'urgency', 'triggerCount', 'oldestEvidence', 'patientId'];
      const k = it.tieBreakers.findIndex((v, i) => v !== next.tieBreakers[i]);
      it.reasonKeys.push({ key: 'reason.vsNext', params: { by: names[k], next: next.patientId } });
    } else it.reasonKeys.push({ key: 'reason.last', params: {} });
  });
  const closed = all.filter((i) => i.state === 'closed').sort(cmp);
  const quiet = all.filter((i) => i.state === 'no_case').sort(cmp);
  return { items, closed, quiet };
}
