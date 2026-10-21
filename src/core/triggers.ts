import { RULE_VERSIONS, TIER } from './config';
import type { AssessedReading, Completeness, Config, Derived, Trigger } from './types';
import { parseTime } from './quality';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

export function evaluateTriggers(
  patientId: string,
  d: Derived,
  assessed: AssessedReading[],
  completeness: Completeness,
  nowMs: number,
  cfg: Config,
): Trigger[] {
  const out: Trigger[] = [];

  // R-CALL: callback request not yet resolved by a case closure
  const cbs = d.callbacks.filter((c) => c.patientId === patientId && !c.resolvedByCaseClosure);
  if (cbs.length) {
    out.push({
      ruleId: 'R-CALL', ruleVersion: RULE_VERSIONS['R-CALL'], tier: TIER.CALLBACK, summaryKey: 'rule.callback',
      params: { count: cbs.length }, observationIds: cbs.map((c) => c.id),
      evidenceKey: 'R-CALL:' + cbs.map((c) => c.id).join(','),
      firstEvidenceAt: cbs[0].at, latestEvidenceAt: cbs[cbs.length - 1].at,
    });
  }

  // R-OOR: >= N valid out-of-range readings in the same direction within the window
  const windowStart = nowMs - cfg.oorWindowHours * 3_600_000;
  const inWin = assessed.filter((a) => a.outOfRange && a.takenMs! >= windowStart && a.takenMs! <= nowMs);
  for (const dir of ['high', 'low'] as const) {
    const g = inWin.filter((a) => a.outOfRange === dir).sort((a, b) => a.takenMs! - b.takenMs!);
    if (g.length >= cfg.oorCount) {
      out.push({
        ruleId: 'R-OOR', ruleVersion: RULE_VERSIONS['R-OOR'], tier: TIER.REPEATED_OOR, summaryKey: 'rule.oor.' + dir,
        params: { count: g.length, threshold: dir === 'high' ? cfg.highMgdl : cfg.lowMgdl, window: cfg.oorWindowHours },
        observationIds: g.map((a) => a.raw.id), evidenceKey: 'R-OOR:' + dir + ':' + g.map((a) => a.raw.id).join(','),
        firstEvidenceAt: iso(g[0].takenMs!), latestEvidenceAt: g.map((a) => a.raw.receivedAt).sort().pop()!,
      });
    }
  }

  // R-MISS: consecutive fully elapsed scheduled days with no usable reading
  if (completeness.state !== 'insufficient_information' && completeness.consecutiveEmptyDays >= cfg.missDays) {
    const days = completeness.days.slice(-completeness.consecutiveEmptyDays);
    const lastDay = days[days.length - 1].date;
    out.push({
      ruleId: 'R-MISS', ruleVersion: RULE_VERSIONS['R-MISS'], tier: TIER.MISSING, summaryKey: 'rule.missing',
      params: { days: days.length, expected: days.reduce((s, x) => s + x.expected, 0) },
      observationIds: days.map((x) => 'day:' + x.date), evidenceKey: 'R-MISS:' + days[0].date + '..' + lastDay,
      firstEvidenceAt: days[0].date + 'T00:00:00.000Z', latestEvidenceAt: iso(Date.parse(lastDay + 'T00:00:00Z') + DAY),
    });
  }

  // R-QUAL: questionable/invalid reading with no later valid reading (needs verification, never auto-corrected)
  const validRecv = assessed.filter((a) => a.status === 'valid').map((a) => parseTime(a.raw.receivedAt)!);
  const pend = assessed.filter(
    (a) => (a.status === 'questionable' || a.status === 'invalid') && !validRecv.some((v) => v > parseTime(a.raw.receivedAt)!),
  );
  if (pend.length) {
    out.push({
      ruleId: 'R-QUAL', ruleVersion: RULE_VERSIONS['R-QUAL'], tier: TIER.VERIFY_DATA, summaryKey: 'rule.verify',
      params: { count: pend.length }, observationIds: pend.map((a) => a.raw.id),
      evidenceKey: 'R-QUAL:' + pend.map((a) => a.raw.id).join(','),
      firstEvidenceAt: pend[0].raw.receivedAt, latestEvidenceAt: pend[pend.length - 1].raw.receivedAt,
    });
  }
  return out;
}
