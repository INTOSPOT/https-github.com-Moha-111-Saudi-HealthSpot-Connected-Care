import { DEFAULT_CONFIG } from './config';
import { computeMetrics } from './metrics';
import { buildWorklist } from './prioritise';
import { parseTime } from './quality';
import { commands, derive, caseIdFor, WorkflowError, type CommandCtx, type NewEvent } from './workflow';
import type { AppEvent, Config, Derived, Patient, RawReading, Role } from './types';

export const CLINICIAN = 'clinician-demo';
export interface ReadingInput { value: number | null; unit: string | null; takenAt: string | null; context?: string }

/** Event-sourced engine. UI-independent: holds the event log, a simulated clock and configuration. */
export class Engine {
  events: AppEvent[] = [];
  private counter = 0;
  constructor(public patients: Patient[], public nowIso: string, public cfg: Config = DEFAULT_CONFIG) {}

  get nowMs() { return Date.parse(this.nowIso); }
  get d(): Derived { return derive(this.events, this.patients); }
  worklist() { return buildWorklist(this.d, this.nowMs, this.cfg); }
  metrics() { return computeMetrics(this.d, this.nowMs, this.cfg); }

  setNow(iso: string) {
    if (parseTime(iso) === null) throw new WorkflowError('INVALID_TIMESTAMP');
    if (Date.parse(iso) < this.nowMs) throw new WorkflowError('CLOCK_BACKWARDS');
    this.nowIso = new Date(iso).toISOString();
    this.sync();
  }
  advanceHours(h: number) { this.setNow(new Date(this.nowMs + h * 3_600_000).toISOString()); }

  private append(evs: NewEvent[]): AppEvent[] {
    const added = evs.map((e) => ({ ...e, id: `e${this.events.length + 1}`, seq: this.events.length + 1 }));
    this.events.push(...added);
    return added;
  }

  /** Raw ingestion keeps whatever was received; quality flags are derived, never silent corrections. */
  ingestReading(patientId: string, r: ReadingInput, role: Role = 'patient'): AppEvent[] {
    if (!this.patients.some((p) => p.id === patientId)) throw new WorkflowError('PATIENT_NOT_FOUND');
    const id = `r${++this.counter}`;
    const reading: RawReading = { id, patientId, value: r.value, unit: r.unit, takenAt: r.takenAt, receivedAt: this.nowIso, context: r.context };
    const evs = this.append([{ at: this.nowIso, type: 'reading_submitted', patientId, actor: patientId, role, payload: { reading } }]);
    return [...evs, ...this.sync()];
  }

  /** Patient-facing entry form: required fields are enforced here; plausibility is flagged, not blocked. */
  submitReadingForm(patientId: string, r: ReadingInput): AppEvent[] {
    const errors: string[] = [];
    if (r.value === null || !Number.isFinite(r.value) || r.value <= 0) errors.push('value');
    if (r.unit !== 'mg/dL' && r.unit !== 'mmol/L') errors.push('unit');
    if (parseTime(r.takenAt) === null) errors.push('takenAt');
    if (errors.length) throw new WorkflowError('FORM_INVALID', errors.join(','));
    return this.ingestReading(patientId, r);
  }

  requestCallback(patientId: string, text = ''): AppEvent[] {
    const evs = this.append([{ at: this.nowIso, type: 'callback_requested', patientId, actor: patientId, role: 'patient', payload: { text } }]);
    return [...evs, ...this.sync()];
  }

  private ctx(role: Role, actor: string): CommandCtx {
    return { d: this.d, now: this.nowIso, actor, role, taskDueHours: this.cfg.taskDueHours, responseDueHours: this.cfg.responseDueHours };
  }
  private run(role: Role, actor: string, f: (c: CommandCtx) => NewEvent[]): AppEvent[] {
    const added = this.append(f(this.ctx(role, actor)));
    return [...added, ...this.sync()];
  }
  private nextTask() { return `t${this.events.filter((e) => e.type === 'followup_assigned' || e.type === 'returned_to_followup').length + 1}`; }

  acknowledge(caseId: string, actor = CLINICIAN, role: Role = 'clinician') { return this.run(role, actor, (c) => commands.acknowledge(c, caseId)); }
  assign(caseId: string, owner: string, description: string, actor = CLINICIAN, role: Role = 'clinician') {
    return this.run(role, actor, (c) => commands.assign(c, caseId, owner, description, this.nextTask()));
  }
  sendMessage(caseId: string, templateId: string, text: string, actor = CLINICIAN, role: Role = 'clinician') {
    return this.run(role, actor, (c) => commands.sendMessage(c, caseId, templateId, text));
  }
  respond(caseId: string, kind: string, text: string, actor?: string, role: Role = 'patient') {
    const pid = this.d.cases[caseId]?.patientId ?? '';
    return this.run(role, actor ?? pid, (c) => commands.patientRespond(c, caseId, kind, text));
  }
  startReassessment(caseId: string, actor = CLINICIAN, role: Role = 'clinician') { return this.run(role, actor, (c) => commands.startReassessment(c, caseId)); }
  close(caseId: string, note: string, actor = CLINICIAN, role: Role = 'clinician') { return this.run(role, actor, (c) => commands.close(c, caseId, note)); }
  override(caseId: string, tier: number, reason: string, actor = CLINICIAN, role: Role = 'clinician') { return this.run(role, actor, (c) => commands.override(c, caseId, tier, reason)); }
  clearOverride(caseId: string, actor = CLINICIAN, role: Role = 'clinician') { return this.run(role, actor, (c) => commands.clearOverride(c, caseId)); }
  recordReview(caseId: string, seconds: number, actor = CLINICIAN, role: Role = 'clinician') { return this.run(role, actor, (c) => commands.recordReview(c, caseId, seconds)); }

  /**
   * Opens / extends / reopens cases from triggers. Idempotent: evidence keys already seen
   * never create events (duplicate-trigger prevention). Closed cases reopen only when the
   * trigger carries evidence newer than the closure.
   */
  sync(): AppEvent[] {
    const added: AppEvent[] = [];
    for (let pass = 0; pass < 3; pass++) {
      const d = this.d;
      const wl = this.worklist();
      const everyone = [...wl.items, ...wl.closed, ...wl.quiet];
      const evs: NewEvent[] = [];
      for (const it of everyone) {
        if (!it.triggers.length) continue;
        const c = d.cases[caseIdFor(it.patientId)];
        const summary = it.triggers.map((t) => ({ ruleId: t.ruleId, ruleVersion: t.ruleVersion, observationIds: t.observationIds, params: t.params, summaryKey: t.summaryKey }));
        const base = { at: this.nowIso, patientId: it.patientId, caseId: caseIdFor(it.patientId), actor: 'rules-engine', role: 'system' as Role };
        if (!c) {
          evs.push({ ...base, type: 'case_opened', payload: { evidenceKeys: it.triggers.map((t) => t.evidenceKey), triggers: summary } });
        } else if (c.state === 'closed') {
          const fresh = it.triggers.filter((t) => !c.seenEvidence.includes(t.evidenceKey) && Date.parse(t.latestEvidenceAt) > Date.parse(c.closedAt!));
          if (fresh.length)
            evs.push({ ...base, type: 'case_reopened', payload: { evidenceKeys: it.triggers.map((t) => t.evidenceKey), triggers: summary, newEvidence: fresh.map((t) => t.evidenceKey) } });
        } else {
          const fresh = it.triggers.filter((t) => !c.seenEvidence.includes(t.evidenceKey));
          if (fresh.length)
            evs.push({ ...base, type: 'trigger_added', payload: { evidenceKeys: fresh.map((t) => t.evidenceKey), triggers: fresh.map((t) => ({ ruleId: t.ruleId, ruleVersion: t.ruleVersion, observationIds: t.observationIds, params: t.params, summaryKey: t.summaryKey })) } });
        }
      }
      if (!evs.length) break;
      added.push(...this.append(evs));
    }
    return added;
  }

  serialize() { return JSON.stringify({ events: this.events, nowIso: this.nowIso, counter: this.counter }); }
  static restore(patients: Patient[], json: string, cfg: Config = DEFAULT_CONFIG): Engine {
    const o = JSON.parse(json);
    const e = new Engine(patients, o.nowIso, cfg);
    e.events = o.events; e.counter = o.counter;
    return e;
  }
}
