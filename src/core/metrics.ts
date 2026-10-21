import { buildWorklist } from './prioritise';
import type { Config, Derived } from './types';

export interface Ratio { num: number; den: number; pct: number | null }
const ratio = (num: number, den: number): Ratio => ({ num, den, pct: den ? Math.round((num / den) * 1000) / 10 : null });
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mins = (a: string, b: string) => Math.round(((Date.parse(b) - Date.parse(a)) / 60_000) * 10) / 10;

export interface Metrics {
  completeness: Ratio & { patientsWithSchedule: number; patientsInsufficient: number };
  acknowledgement: Ratio & { medianMinutes: number | null; unacknowledged: string[] };
  followup: Ratio & { medianMinutes: number | null; withoutFollowup: string[] };
  tasks: Ratio & { open: number; overdue: number };
  closure: Ratio;
  unresolved: { openCases: number; overdueCases: number; openCaseIds: string[]; overdueCaseIds: string[] };
  review: { sessions: number; medianSeconds: number | null; totalSeconds: number; simulated: true };
  events: number;
}

/** Every figure is computed from the event log (via derive) – nothing is stored separately. */
export function computeMetrics(d: Derived, nowMs: number, cfg: Config): Metrics {
  const wl = buildWorklist(d, nowMs, cfg);
  const everyone = [...wl.items, ...wl.closed, ...wl.quiet];
  const sched = everyone.filter((i) => i.completeness.state !== 'insufficient_information');
  const completeness = {
    ...ratio(sched.reduce((s, i) => s + i.completeness.received, 0), sched.reduce((s, i) => s + i.completeness.expected, 0)),
    patientsWithSchedule: sched.length,
    patientsInsufficient: everyone.length - sched.length,
  };
  const episodes = Object.values(d.cases).flatMap((c) => c.episodes.map((e) => ({ ...e, caseId: c.id })));
  const acked = episodes.filter((e) => e.acknowledgedAt);
  const fu = episodes.filter((e) => e.firstFollowupAt);
  const openTasks = d.tasks.filter((t) => !t.completedAt);
  const overdueCases = wl.items.filter((i) => i.urgencyFlags.some((f) => f.kind !== 'unresolved_prior'));
  const secs = d.reviewSessions.map((r) => r.seconds);
  return {
    completeness,
    acknowledgement: {
      ...ratio(acked.length, episodes.length),
      medianMinutes: median(acked.map((e) => mins(e.openedAt, e.acknowledgedAt!))),
      unacknowledged: episodes.filter((e) => !e.acknowledgedAt).map((e) => e.caseId),
    },
    followup: {
      ...ratio(fu.length, episodes.length),
      medianMinutes: median(fu.map((e) => mins(e.openedAt, e.firstFollowupAt!))),
      withoutFollowup: episodes.filter((e) => !e.firstFollowupAt).map((e) => e.caseId),
    },
    tasks: {
      ...ratio(d.tasks.filter((t) => t.completedAt).length, d.tasks.length),
      open: openTasks.length,
      overdue: openTasks.filter((t) => Date.parse(t.dueAt) < nowMs).length,
    },
    closure: ratio(episodes.filter((e) => e.closedAt).length, episodes.length),
    unresolved: {
      openCases: wl.items.length,
      overdueCases: overdueCases.length,
      openCaseIds: wl.items.map((i) => i.patientId),
      overdueCaseIds: overdueCases.map((i) => i.patientId),
    },
    review: { sessions: secs.length, medianSeconds: median(secs), totalSeconds: secs.reduce((a, b) => a + b, 0), simulated: true },
    events: d.events.length,
  };
}
