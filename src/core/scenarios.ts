import { Engine } from './engine';
import { caseIdFor } from './workflow';
import type { Patient } from './types';

export const DEMO_NOW = '2026-03-10T08:00:00.000Z';

export type Step =
  | { at: string; op: 'tick' }
  | { at: string; op: 'reading'; value: number | null; unit: string | null; takenAt?: string | null; context?: string }
  | { at: string; op: 'callback'; text: string }
  | { at: string; op: 'ack' }
  | { at: string; op: 'assign'; owner: string; description: string }
  | { at: string; op: 'message'; template: string; text: string }
  | { at: string; op: 'respond'; kind: string; text: string }
  | { at: string; op: 'close'; note: string };

export interface Scenario {
  id: string;
  patient: Patient;
  focus: 'oor' | 'missing' | 'questionable' | 'callback' | 'overdue' | 'closable' | 'reopen' | 'insufficient' | 'stable';
  steps: Step[];
  expected: { tier?: number; state: string; rules: string[] };
}

const day = (d: number) => `2026-03-${String(d).padStart(2, '0')}`;
function routine(from: number, to: number, seed: number, lastDayOnlyMorning = false): Step[] {
  const out: Step[] = [];
  for (let d = from; d <= to; d++) {
    const v1 = 108 + ((d * 7 + seed * 3) % 38);
    const v2 = 118 + ((d * 5 + seed * 11) % 40);
    out.push({ at: `${day(d)}T07:30:00Z`, op: 'reading', value: v1, unit: 'mg/dL', takenAt: `${day(d)}T07:25:00Z`, context: 'fasting' });
    if (!(lastDayOnlyMorning && d === to))
      out.push({ at: `${day(d)}T20:00:00Z`, op: 'reading', value: v2, unit: 'mg/dL', takenAt: `${day(d)}T19:55:00Z`, context: 'after_meal' });
  }
  return out;
}
const rd = (at: string, value: number, unit = 'mg/dL', context = 'random'): Step => ({ at, op: 'reading', value, unit, takenAt: at, context });
const P = (n: number, ar: string, en: string, start: string | null): Patient => ({
  id: `p-00${n}`, nameAr: ar, nameEn: en, schedule: start ? { startDate: start, perDay: 2 } : null,
});

export const SCENARIOS: Scenario[] = [
  {
    id: 'S1-repeated-out-of-range', focus: 'oor', patient: P(1, 'مريض تجريبي ١', 'Demo patient 1', '2026-03-03'),
    steps: [...routine(3, 8, 1), rd('2026-03-09T07:30:00Z', 235), rd('2026-03-09T20:00:00Z', 212), rd('2026-03-10T06:40:00Z', 228)],
    expected: { tier: 2, state: 'new', rules: ['R-OOR'] },
  },
  {
    id: 'S2-missing-readings', focus: 'missing', patient: P(2, 'مريض تجريبي ٢', 'Demo patient 2', '2026-03-01'),
    steps: [...routine(1, 7, 2), { at: '2026-03-10T00:05:00Z', op: 'tick' }],
    expected: { tier: 3, state: 'new', rules: ['R-MISS'] },
  },
  {
    id: 'S3-questionable-measurement', focus: 'questionable', patient: P(3, 'مريض تجريبي ٣', 'Demo patient 3', '2026-03-06'),
    steps: [...routine(6, 9, 3), rd('2026-03-10T07:10:00Z', 7.4, 'mg/dL', 'fasting')],
    expected: { tier: 5, state: 'new', rules: ['R-QUAL'] },
  },
  {
    id: 'S4-callback-request', focus: 'callback', patient: P(4, 'مريض تجريبي ٤', 'Demo patient 4', '2026-03-03'),
    steps: [...routine(3, 9, 4), { at: '2026-03-10T07:45:00Z', op: 'callback', text: 'أرغب في اتصال من الفريق بخصوص الجهاز' }],
    expected: { tier: 1, state: 'new', rules: ['R-CALL'] },
  },
  {
    id: 'S5-overdue-followup', focus: 'overdue', patient: P(5, 'مريض تجريبي ٥', 'Demo patient 5', '2026-03-03'),
    steps: [
      ...routine(3, 6, 5),
      rd('2026-03-07T06:50:00Z', 224), rd('2026-03-07T12:30:00Z', 231), rd('2026-03-07T20:00:00Z', 219),
      { at: '2026-03-07T21:00:00Z', op: 'ack' },
      { at: '2026-03-07T22:00:00Z', op: 'assign', owner: 'nurse-demo-A', description: 'Contact patient to request a repeat measurement' },
      ...routine(8, 9, 5), rd('2026-03-10T07:30:00Z', 131),
    ],
    expected: { tier: 3, state: 'assigned', rules: [] },
  },
  {
    id: 'S6-response-allows-closure', focus: 'closable', patient: P(6, 'مريض تجريبي ٦', 'Demo patient 6', '2026-03-03'),
    steps: [
      ...routine(3, 7, 6), rd('2026-03-08T05:30:00Z', 62), rd('2026-03-08T13:00:00Z', 66), rd('2026-03-08T22:10:00Z', 58),
      { at: '2026-03-08T22:40:00Z', op: 'ack' },
      { at: '2026-03-09T07:00:00Z', op: 'assign', owner: 'nurse-demo-B', description: 'Ask patient to repeat the measurement' },
      { at: '2026-03-09T07:20:00Z', op: 'message', template: 'recheck', text: 'الرجاء إعادة القياس وإرسال النتيجة.' },
      rd('2026-03-09T17:55:00Z', 104, 'mg/dL', 'recheck'),
      { at: '2026-03-09T18:00:00Z', op: 'respond', kind: 'rechecked', text: 'أعدت القياس وأرسلت النتيجة.' },
      ...routine(10, 10, 6, true),
    ],
    expected: { tier: 2, state: 'reassessment', rules: ['R-OOR'] },
  },
  {
    id: 'S7-new-information-after-closure', focus: 'reopen', patient: P(7, 'مريض تجريبي ٧', 'Demo patient 7', '2026-03-01'),
    steps: [
      ...routine(1, 3, 7), rd('2026-03-04T07:00:00Z', 241), rd('2026-03-04T13:00:00Z', 226), rd('2026-03-04T21:00:00Z', 238),
      { at: '2026-03-05T08:00:00Z', op: 'ack' },
      { at: '2026-03-05T09:00:00Z', op: 'assign', owner: 'nurse-demo-A', description: 'Ask patient to repeat the measurement' },
      { at: '2026-03-05T09:10:00Z', op: 'message', template: 'recheck', text: 'الرجاء إعادة القياس وإرسال النتيجة.' },
      rd('2026-03-05T14:50:00Z', 128, 'mg/dL', 'recheck'),
      { at: '2026-03-05T15:00:00Z', op: 'respond', kind: 'rechecked', text: 'القياس عاد ضمن النطاق التجريبي.' },
      { at: '2026-03-05T16:00:00Z', op: 'close', note: 'Recheck received; closed for this simulation.' },
      ...routine(6, 8, 7), rd('2026-03-09T07:30:00Z', 233), rd('2026-03-09T13:00:00Z', 219), rd('2026-03-10T07:20:00Z', 247),
    ],
    expected: { tier: 2, state: 'new', rules: ['R-OOR'] },
  },
  {
    id: 'S8-insufficient-information', focus: 'insufficient', patient: P(8, 'مريض تجريبي ٨ (مسجل حديثاً)', 'Demo patient 8 (newly enrolled)', '2026-03-09'),
    steps: [rd('2026-03-09T20:15:00Z', 142, 'mg/dL', 'after_meal')],
    expected: { state: 'no_case', rules: [] },
  },
  {
    id: 'S9-stable', focus: 'stable', patient: P(9, 'مريض تجريبي ٩', 'Demo patient 9', '2026-03-03'),
    steps: [...routine(3, 9, 9), rd('2026-03-10T07:30:00Z', 119)],
    expected: { state: 'no_case', rules: [] },
  },
];

export function runSteps(engine: Engine, scenarios: Scenario[], until: string = DEMO_NOW): Engine {
  const steps = scenarios
    .flatMap((s, si) => s.steps.map((st, i) => ({ s, st, key: `${st.at}|${String(si).padStart(3, '0')}|${String(i).padStart(4, '0')}` })))
    .sort((a, b) => (a.st.at < b.st.at ? -1 : a.st.at > b.st.at ? 1 : a.key < b.key ? -1 : 1));
  for (const { s, st } of steps) {
    if (st.at > until) continue;
    engine.setNow(st.at);
    const pid = s.patient.id;
    const cid = caseIdFor(pid);
    switch (st.op) {
      case 'tick': break;
      case 'reading': engine.ingestReading(pid, { value: st.value, unit: st.unit, takenAt: st.takenAt === undefined ? st.at : st.takenAt, context: st.context }); break;
      case 'callback': engine.requestCallback(pid, st.text); break;
      case 'ack': engine.acknowledge(cid); break;
      case 'assign': engine.assign(cid, st.owner, st.description); break;
      case 'message': engine.sendMessage(cid, st.template, st.text); break;
      case 'respond': engine.respond(cid, st.kind, st.text); break;
      case 'close': engine.close(cid, st.note); break;
    }
  }
  engine.setNow(until);
  return engine;
}

export function buildDemoEngine(scenarios: Scenario[] = SCENARIOS): Engine {
  const e = new Engine(scenarios.map((s) => s.patient), '2026-03-01T00:00:00.000Z');
  return runSteps(e, scenarios);
}
export function buildScenarioEngine(s: Scenario): Engine {
  const e = new Engine([s.patient], '2026-03-01T00:00:00.000Z');
  return runSteps(e, [s]);
}
