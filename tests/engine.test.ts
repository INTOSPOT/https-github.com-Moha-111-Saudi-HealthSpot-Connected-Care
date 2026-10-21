import { describe, expect, it } from 'vitest';
import { assessReadings, toMgdl } from '../src/core/quality';
import { assessCompleteness } from '../src/core/completeness';
import { DEFAULT_CONFIG as cfg } from '../src/core/config';
import { Engine } from '../src/core/engine';
import { containsTreatmentAdvice, derive, WorkflowError } from '../src/core/workflow';
import { SCENARIOS, buildDemoEngine, buildScenarioEngine, DEMO_NOW } from '../src/core/scenarios';
import type { Patient, RawReading } from '../src/core/types';

const NOW = Date.parse('2026-03-10T08:00:00Z');
const raw = (o: Partial<RawReading>): RawReading => ({ id: 'x', patientId: 'p', value: 120, unit: 'mg/dL', takenAt: '2026-03-10T06:00:00Z', receivedAt: '2026-03-10T06:01:00Z', ...o });
const P: Patient = { id: 'p-1', nameAr: 'أ', nameEn: 'A', schedule: { startDate: '2026-03-01', perDay: 2 } };
const PN: Patient = { ...P, schedule: null };
const eng = () => new Engine([PN], '2026-03-10T00:00:00Z');
const hi = (e: Engine, t: string, v = 230) => { e.setNow(t); return e.ingestReading('p-1', { value: v, unit: 'mg/dL', takenAt: t }); };
const THREE = ['2026-03-10T01:00:00Z', '2026-03-10T02:00:00Z', '2026-03-10T03:00:00Z'];
const openThree = () => { const e = eng(); THREE.forEach((t) => hi(e, t)); return e; };
const throws = (f: () => any, code: string) => { try { f(); } catch (x) { expect((x as WorkflowError).code).toBe(code); return; } throw new Error('no throw ' + code); };

describe('input validation and conversion', () => {
  it('converts mmol/L to mg/dL', () => { expect(toMgdl(10, 'mmol/L')).toBe(180.2); expect(toMgdl(100, 'mg/dL')).toBe(100); expect(toMgdl(1, 'x')).toBeNull(); });
  it('flags missing fields as invalid without deleting', () => {
    const a = assessReadings([raw({ value: null }), raw({ id: 'y', unit: null }), raw({ id: 'z', takenAt: null }), raw({ id: 'w', takenAt: 'garbage' }), raw({ id: 'u', unit: 'mmol' })], NOW, cfg);
    expect(a).toHaveLength(5);
    expect(a.every((x) => x.status === 'invalid')).toBe(true);
    expect(a.map((x) => x.flags[0].code)).toEqual(['MISSING_VALUE', 'MISSING_UNIT', 'MISSING_TIMESTAMP', 'INVALID_TIMESTAMP', 'UNKNOWN_UNIT']);
  });
  it('flags implausible, unit mix-up, future and stale as questionable; keeps raw value', () => {
    const a = assessReadings([raw({ id: 'a', value: 900 }), raw({ id: 'b', value: 7.2 }), raw({ id: 'c', takenAt: '2026-03-12T00:00:00Z' }), raw({ id: 'd', takenAt: '2026-01-01T00:00:00Z' })], NOW, cfg);
    expect(a.map((x) => x.status)).toEqual(['questionable', 'questionable', 'questionable', 'questionable']);
    expect(a.map((x) => x.flags[0].code)).toEqual(['IMPLAUSIBLE_VALUE', 'POSSIBLE_UNIT_MIX_UP', 'FUTURE_TIMESTAMP', 'STALE_TIMESTAMP']);
    expect(a[1].raw.value).toBe(7.2);
    expect(a[1].outOfRange).toBeNull();
  });
  it('accepts a plausible mmol/L value and converts it', () => {
    const [a] = assessReadings([raw({ value: 12, unit: 'mmol/L' })], NOW, cfg);
    expect(a.status).toBe('valid'); expect(a.mgdl).toBe(216.2); expect(a.outOfRange).toBe('high');
  });
  it('detects duplicates (same value, within window) including across units', () => {
    const a = assessReadings([raw({ id: 'a', value: 180.2 }), raw({ id: 'b', value: 10, unit: 'mmol/L', takenAt: '2026-03-10T06:03:00Z', receivedAt: '2026-03-10T06:04:00Z' }), raw({ id: 'c', takenAt: '2026-03-10T06:30:00Z', receivedAt: '2026-03-10T06:31:00Z' })], NOW, cfg);
    expect(a.map((x) => x.status)).toEqual(['valid', 'duplicate', 'valid']);
  });
  it('range boundaries: 70 and 180 are in range, 69.9 and 180.1 are not', () => {
    const a = assessReadings([70, 180, 69.9, 180.1].map((v, i) => raw({ id: 'r' + i, value: v, takenAt: `2026-03-10T0${i}:00:00Z`, receivedAt: `2026-03-10T0${i}:01:00Z` })), NOW, cfg);
    expect(a.map((x) => x.outOfRange)).toEqual([null, null, 'low', 'high']);
  });
});

describe('completeness', () => {
  const mk = (ds: string[]) => assessReadings(ds.map((t, i) => raw({ id: 'r' + i, value: 100 + i, takenAt: t, receivedAt: t })), NOW, cfg);
  it('insufficient information without schedule or with <2 elapsed days', () => {
    expect(assessCompleteness({ ...P, schedule: null }, [], NOW, cfg).state).toBe('insufficient_information');
    expect(assessCompleteness({ ...P, schedule: { startDate: '2026-03-09', perDay: 2 } }, [], NOW, cfg).state).toBe('insufficient_information');
  });
  it('adequate / incomplete against the schedule, with denominators', () => {
    const full = mk(['2026-03-08T07:00:00Z', '2026-03-08T20:00:00Z', '2026-03-09T07:00:00Z', '2026-03-09T20:00:00Z']);
    const p = { ...P, schedule: { startDate: '2026-03-08', perDay: 2 } };
    const c = assessCompleteness(p, full, NOW, cfg);
    expect([c.state, c.received, c.expected]).toEqual(['adequate', 4, 4]);
    const half = assessCompleteness(p, mk(['2026-03-08T07:00:00Z']), NOW, cfg);
    expect([half.state, half.received, half.expected, half.consecutiveEmptyDays]).toEqual(['incomplete', 1, 4, 1]);
  });
  it('reports stale data age', () => {
    const c = assessCompleteness(P, mk(['2026-03-05T06:00:00Z']), NOW, cfg);
    expect(c.lastUsableAgeHours).toBe(122);
  });
});

describe('rule boundaries and overlapping triggers', () => {
  it('two out-of-range readings do not trigger; the third does', () => {
    const e = eng(); hi(e, THREE[0]); hi(e, THREE[1]);
    expect(e.worklist().items).toHaveLength(0);
    hi(e, THREE[2]);
    const it = e.worklist().items[0];
    expect(it.triggers.map((t) => t.ruleId)).toEqual(['R-OOR']);
    expect(it.triggers[0].ruleVersion).toBe('1.0');
    expect(it.triggers[0].observationIds).toHaveLength(3);
  });
  it('readings outside the 72 h window do not count; questionable readings never count', () => {
    const e = new Engine([PN], '2026-03-06T00:00:00Z');
    for (const t of ['2026-03-06T01:00:00Z', '2026-03-10T01:00:00Z', '2026-03-10T02:00:00Z']) { e.setNow(t); e.ingestReading('p-1', { value: 230, unit: 'mg/dL', takenAt: t }); }
    e.setNow('2026-03-10T03:00:00Z'); e.ingestReading('p-1', { value: 900, unit: 'mg/dL', takenAt: '2026-03-10T03:00:00Z' });
    expect(e.worklist().items.some((i) => i.triggers.some((t) => t.ruleId === 'R-OOR'))).toBe(false);
  });
  it('overlapping triggers are all reported and ordered by documented tier', () => {
    const e = openThree(); e.requestCallback('p-1', 'call me'); e.ingestReading('p-1', { value: 7, unit: 'mg/dL', takenAt: '2026-03-10T03:00:00Z' });
    const it = e.worklist().items[0];
    expect(it.triggers.map((t) => t.ruleId).sort()).toEqual(['R-CALL', 'R-OOR', 'R-QUAL']);
    expect(it.tier).toBe(1);
  });
  it('missing-reading rule needs two consecutive empty scheduled days', () => {
    const e = new Engine([{ ...P, schedule: { startDate: '2026-03-08', perDay: 2 } }], '2026-03-09T00:00:00Z');
    e.setNow('2026-03-09T12:00:00Z'); expect(e.worklist().items).toHaveLength(0);
    e.setNow('2026-03-10T00:00:00Z'); expect(e.worklist().items[0].triggers[0].ruleId).toBe('R-MISS');
  });
  it('a questionable measurement is flagged for verification and cleared by a later valid reading', () => {
    const e = eng(); e.setNow('2026-03-10T05:00:00Z');
    e.ingestReading('p-1', { value: 7.4, unit: 'mg/dL', takenAt: '2026-03-10T05:00:00Z' });
    expect(e.worklist().items[0].triggers[0].ruleId).toBe('R-QUAL');
    e.setNow('2026-03-10T06:00:00Z'); e.ingestReading('p-1', { value: 130, unit: 'mg/dL', takenAt: '2026-03-10T06:00:00Z' });
    expect(e.worklist().items[0].triggers).toHaveLength(0);
  });
  it('form submission rejects missing required fields but keeps implausible values as flagged', () => {
    const e = eng();
    throws(() => e.submitReadingForm('p-1', { value: null, unit: 'mg/dL', takenAt: '2026-03-10T00:00:00Z' }), 'FORM_INVALID');
    throws(() => e.submitReadingForm('p-1', { value: 100, unit: 'x', takenAt: '2026-03-10T00:00:00Z' }), 'FORM_INVALID');
    expect(e.d.readings).toHaveLength(0);
    e.submitReadingForm('p-1', { value: 800, unit: 'mg/dL', takenAt: '2026-03-10T00:00:00Z' });
    expect(e.d.readings).toHaveLength(1);
  });
});

describe('stable prioritisation', () => {
  it('is deterministic and independent of input order', () => {
    const a = buildDemoEngine().worklist().items.map((i) => i.patientId);
    const b = buildDemoEngine([...SCENARIOS].reverse()).worklist().items.map((i) => i.patientId);
    expect(a).toEqual(b);
    expect(a).toEqual(['p-004', 'p-007', 'p-006', 'p-001', 'p-002', 'p-005', 'p-003']);
  });
  it('ties break on urgency, trigger count, oldest evidence, then patient id, and the reason says which', () => {
    const items = buildDemoEngine().worklist().items;
    expect(items.find((i) => i.patientId === 'p-007')!.reasonKeys.find((r) => r.key === 'reason.vsNext')!.params.by).toBe('oldestEvidence');
    const p4 = items[0].reasonKeys.find((r) => r.key === 'reason.vsNext')!;
    expect(p4.params.by).toBe('tier');
  });
  it('every item exposes triggers, rule version, timestamps and a position reason', () => {
    for (const it of buildDemoEngine().worklist().items) {
      expect(it.reasonKeys.length).toBeGreaterThan(0);
      for (const t of it.triggers) { expect(t.ruleVersion).toBeTruthy(); expect(t.latestEvidenceAt).toBeTruthy(); expect(t.observationIds.length).toBeGreaterThan(0); }
    }
  });
  it('overdue workflow work outranks missing/verify triggers (tier 3)', () => {
    const wl = buildDemoEngine().worklist().items;
    const idx = (p: string) => wl.findIndex((i) => i.patientId === p);
    expect(idx('p-005')).toBeLessThan(idx('p-003'));
    expect(wl[idx('p-005')].urgencyFlags[0].kind).toBe('overdue_task');
  });
});

describe('scenarios reproduce expected behaviour', () => {
  for (const s of SCENARIOS) {
    it(s.id, () => {
      const e = buildScenarioEngine(s);
      const all = [...e.worklist().items, ...e.worklist().closed, ...e.worklist().quiet][0];
      expect(all.state).toBe(s.expected.state);
      expect(all.triggers.map((t) => t.ruleId).sort()).toEqual([...s.expected.rules].sort());
      if (s.expected.tier) expect(all.tier).toBe(s.expected.tier);
    });
  }
  it('S6 can be closed after the patient response; S7 reopened after closure on new information', () => {
    const e = buildScenarioEngine(SCENARIOS[5]);
    e.close('case-p-006', 'Recheck in range for this simulation');
    expect(e.d.cases['case-p-006'].state).toBe('closed');
    const s7 = buildScenarioEngine(SCENARIOS[6]);
    const c = s7.d.cases['case-p-007'];
    expect(c.reopenCount).toBe(1);
    expect(s7.d.events.map((x) => x.type)).toContain('case_reopened');
    expect(c.episodes).toHaveLength(2);
  });
  it('is reproducible: identical event logs on repeated builds', () => {
    expect(JSON.stringify(buildDemoEngine().events)).toBe(JSON.stringify(buildDemoEngine().events));
  });
});

describe('duplicate trigger prevention', () => {
  it('re-syncing and advancing the clock with no new evidence adds no events', () => {
    const e = openThree(); const n = e.events.length;
    e.sync(); e.sync(); e.setNow('2026-03-10T03:30:00Z');
    expect(e.events.length).toBe(n);
    expect(e.events.filter((x) => x.type === 'case_opened')).toHaveLength(1);
  });
  it('a second callback on an open case extends the case rather than opening another', () => {
    const e = openThree(); e.requestCallback('p-1', 'a'); e.requestCallback('p-1', 'b');
    expect(e.events.filter((x) => x.type === 'case_opened')).toHaveLength(1);
    expect(Object.keys(e.d.cases)).toHaveLength(1);
  });
  it('old evidence does not reopen a closed case', () => {
    const e = openThree(); const id = 'case-p-1';
    e.acknowledge(id); e.assign(id, 'n', 'call'); e.sendMessage(id, 'recheck', 'x'); e.respond(id, 'rechecked', 'ok'); e.close(id, 'done');
    e.sync(); e.setNow('2026-03-10T04:00:00Z');
    expect(e.d.cases[id].state).toBe('closed');
  });
});

describe('workflow transitions, ownership and overrides', () => {
  const id = 'case-p-1';
  it('walks New→Acknowledged→Assigned→Awaiting→Reassessment→Closed with owner and timestamps', () => {
    const e = openThree();
    e.setNow('2026-03-10T03:10:00Z'); e.acknowledge(id);
    e.setNow('2026-03-10T03:20:00Z'); e.assign(id, 'nurse-a', 'Contact patient');
    e.setNow('2026-03-10T03:30:00Z'); e.sendMessage(id, 'recheck', 'الرجاء إعادة القياس');
    e.setNow('2026-03-10T05:00:00Z'); e.respond(id, 'rechecked', 'تم');
    expect(e.d.cases[id].state).toBe('reassessment');
    e.setNow('2026-03-10T05:10:00Z'); e.close(id, 'ok');
    const c = e.d.cases[id];
    expect(c.state).toBe('closed'); expect(c.owner).toBe('nurse-a');
    expect(c.history.length).toBe(6);
    expect(e.d.tasks[0].completedAt).toBe('2026-03-10T03:30:00.000Z');
    expect(e.d.messages[0].response?.kind).toBe('rechecked');
  });
  it('rejects invalid transitions, unauthorised roles and missing inputs', () => {
    const e = openThree();
    throws(() => e.assign(id, 'n', 'x'), 'INVALID_TRANSITION');
    throws(() => e.close(id, 'x'), 'INVALID_TRANSITION');
    throws(() => e.acknowledge(id, 'p-1', 'patient'), 'NOT_AUTHORISED');
    e.acknowledge(id);
    throws(() => e.acknowledge(id), 'INVALID_TRANSITION');
    throws(() => e.assign(id, '', 'x'), 'OWNER_REQUIRED');
    e.assign(id, 'n', 'x');
    throws(() => e.respond(id, 'ok', 'x'), 'INVALID_TRANSITION');
    throws(() => e.sendMessage(id, 'custom', ''), 'MESSAGE_REQUIRED');
    throws(() => e.acknowledge('case-nope'), 'CASE_NOT_FOUND');
  });
  it('blocks medication or treatment advice in messages and responses', () => {
    expect(containsTreatmentAdvice('increase insulin dose')).toBe(true);
    expect(containsTreatmentAdvice('زيادة جرعة الإنسولين')).toBe(true);
    expect(containsTreatmentAdvice('please repeat the measurement')).toBe(false);
    const e = openThree(); e.acknowledge(id); e.assign(id, 'n', 'x');
    throws(() => e.sendMessage(id, 'custom', 'take more insulin'), 'TREATMENT_ADVICE_BLOCKED');
  });
  it('clinician override needs a reason, changes rank, is recorded and can be cleared', () => {
    const e = new Engine([PN, { ...PN, id: 'p-2' }], '2026-03-10T00:00:00Z');
    THREE.forEach((t) => { e.setNow(t); e.ingestReading('p-1', { value: 230, unit: 'mg/dL', takenAt: t }); });
    e.setNow('2026-03-10T03:30:00Z'); e.ingestReading('p-2', { value: 7, unit: 'mg/dL', takenAt: '2026-03-10T03:30:00Z' });
    expect(e.worklist().items.map((i) => i.patientId)).toEqual(['p-1', 'p-2']);
    throws(() => e.override('case-p-2', 1, ' '), 'REASON_REQUIRED');
    throws(() => e.override('case-p-2', 9, 'r'), 'INVALID_TIER');
    throws(() => e.override('case-p-2', 1, 'r', 'p-2', 'patient'), 'NOT_AUTHORISED');
    e.override('case-p-2', 1, 'Patient reported symptoms by phone');
    const wl = e.worklist().items;
    expect(wl.map((i) => i.patientId)).toEqual(['p-2', 'p-1']);
    expect(wl[0].overridden).toBe(true); expect(wl[0].baseTier).toBe(5);
    expect(e.events.find((x) => x.type === 'priority_overridden')!.payload.reason).toMatch(/symptoms/);
    e.clearOverride('case-p-2');
    expect(e.worklist().items.map((i) => i.patientId)).toEqual(['p-1', 'p-2']);
  });
  it('reopened case requires new acknowledgement; returning from reassessment creates a new task', () => {
    const e = openThree(); e.acknowledge(id); e.assign(id, 'n', 'x'); e.sendMessage(id, 'recheck', 'x'); e.respond(id, 'still_unwell', 'y');
    e.assign(id, 'n2', 'call again');
    expect(e.d.cases[id].state).toBe('assigned'); expect(e.d.tasks).toHaveLength(2);
  });
});

describe('event-based metrics', () => {
  it('computes counts and denominators from events; unresolved items stay visible', () => {
    const m = buildDemoEngine().metrics();
    expect(m.acknowledgement).toMatchObject({ num: 3, den: 8, medianMinutes: 60 });
    expect(m.acknowledgement.unacknowledged).toHaveLength(5);
    expect(m.followup).toMatchObject({ num: 3, den: 8 });
    expect(m.tasks).toMatchObject({ num: 2, den: 3, open: 1, overdue: 1 });
    expect(m.closure).toMatchObject({ num: 1, den: 8 });
    expect(m.unresolved.openCases).toBe(7);
    expect(m.unresolved.overdueCaseIds).toEqual(['p-002', 'p-005']);
    expect(m.completeness).toMatchObject({ patientsInsufficient: 1 });
    expect(m.completeness.den).toBe(106);
  });
  it('records simulated review sessions', () => {
    const e = buildDemoEngine(); e.recordReview('case-p-001', 42); e.recordReview('case-p-004', 18);
    expect(e.metrics().review).toMatchObject({ sessions: 2, medianSeconds: 30, totalSeconds: 60 });
  });
  it('metrics equal a re-derivation from serialised events (nothing stored outside the log)', () => {
    const e = buildDemoEngine();
    const r = Engine.restore(e.patients, e.serialize());
    expect(r.metrics()).toEqual(e.metrics());
    expect(derive(r.events, r.patients).cases['case-p-007'].reopenCount).toBe(1);
  });
  it('clock cannot move backwards', () => {
    const e = buildDemoEngine(); throws(() => e.setNow('2026-03-01T00:00:00Z'), 'CLOCK_BACKWARDS');
    expect(e.nowIso).toBe(DEMO_NOW);
  });
});
