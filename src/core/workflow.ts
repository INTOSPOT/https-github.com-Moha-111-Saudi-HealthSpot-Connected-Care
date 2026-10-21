import type { AppEvent, Case, CaseState, Derived, Patient, Role } from './types';

export class WorkflowError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

/** Allowed transitions of the explicit state model. */
export const TRANSITIONS: Record<CaseState, CaseState[]> = {
  new: ['acknowledged'],
  acknowledged: ['assigned'],
  assigned: ['awaiting_response'],
  awaiting_response: ['reassessment'],
  reassessment: ['assigned', 'closed'],
  closed: ['new'],
};
export const STATE_ORDER: CaseState[] = ['new', 'acknowledged', 'assigned', 'awaiting_response', 'reassessment', 'closed'];

export const caseIdFor = (patientId: string) => `case-${patientId}`;

export function emptyDerived(patients: Patient[]): Derived {
  return { patients, readings: [], callbacks: [], cases: {}, tasks: [], messages: [], reviewSessions: [], events: [] };
}

/** Pure reducer: current state is entirely derived from the event log. */
export function derive(events: AppEvent[], patients: Patient[]): Derived {
  const d = emptyDerived(patients);
  for (const e of events) {
    d.events.push(e);
    const c: Case | undefined = e.caseId ? d.cases[e.caseId] : undefined;
    if (c) c.history.push(e.id);
    switch (e.type) {
      case 'reading_submitted':
        d.readings.push({ ...(e.payload.reading as any), id: e.payload.reading.id, receivedAt: e.at });
        break;
      case 'callback_requested':
        d.callbacks.push({ id: e.id, patientId: e.patientId, at: e.at, text: e.payload.text ?? '', resolvedByCaseClosure: false });
        break;
      case 'case_opened': {
        const nc: Case = {
          id: e.caseId!, patientId: e.patientId, state: 'new', openedAt: e.at, reopenCount: 0, stateSince: e.at,
          acknowledgedAt: null, firstFollowupAt: null, closedAt: null, owner: null,
          seenEvidence: [...(e.payload.evidenceKeys ?? [])], override: null, awaitingSince: null,
          responseDueAt: null, respondedAt: null, history: [e.id],
          episodes: [{ openedAt: e.at, acknowledgedAt: null, firstFollowupAt: null, closedAt: null }],
        };
        d.cases[nc.id] = nc;
        break;
      }
      case 'trigger_added':
        if (c) c.seenEvidence.push(...(e.payload.evidenceKeys ?? []));
        break;
      case 'case_reopened':
        if (c) {
          c.state = 'new'; c.stateSince = e.at; c.reopenCount++; c.closedAt = null; c.acknowledgedAt = null;
          c.firstFollowupAt = null; c.awaitingSince = null; c.responseDueAt = null; c.respondedAt = null; c.override = null;
          c.seenEvidence.push(...(e.payload.evidenceKeys ?? []));
          c.episodes.push({ openedAt: e.at, acknowledgedAt: null, firstFollowupAt: null, closedAt: null });
        }
        break;
      case 'acknowledged':
        if (c) {
          c.state = 'acknowledged'; c.stateSince = e.at; c.acknowledgedAt = e.at; c.owner ??= e.actor;
          c.episodes[c.episodes.length - 1].acknowledgedAt = e.at;
        }
        break;
      case 'followup_assigned':
        if (c) {
          c.state = 'assigned'; c.stateSince = e.at; c.owner = e.payload.owner;
          c.firstFollowupAt ??= e.at;
          const ep = c.episodes[c.episodes.length - 1];
          ep.firstFollowupAt ??= e.at;
          d.tasks.push({ id: e.payload.taskId, caseId: c.id, owner: e.payload.owner, description: e.payload.description, createdAt: e.at, dueAt: e.payload.dueAt, completedAt: null });
        }
        break;
      case 'message_sent':
        if (c) {
          c.state = 'awaiting_response'; c.stateSince = e.at; c.awaitingSince = e.at; c.responseDueAt = e.payload.responseDueAt;
          d.messages.push({ id: e.id, caseId: c.id, patientId: c.patientId, templateId: e.payload.templateId, text: e.payload.text, approvedBy: e.actor, at: e.at, respondedAt: null, response: null });
          d.tasks.filter((t) => t.caseId === c.id && !t.completedAt).forEach((t) => (t.completedAt = e.at));
        }
        break;
      case 'patient_responded':
        if (c) {
          c.state = 'reassessment'; c.stateSince = e.at; c.respondedAt = e.at;
          const m = [...d.messages].reverse().find((x) => x.caseId === c.id && !x.response);
          if (m) { m.respondedAt = e.at; m.response = { kind: e.payload.kind, text: e.payload.text ?? '' }; }
        }
        break;
      case 'reassessment_started':
        if (c) { c.state = 'reassessment'; c.stateSince = e.at; }
        break;
      case 'returned_to_followup':
        if (c) {
          c.state = 'assigned'; c.stateSince = e.at; c.owner = e.payload.owner;
          d.tasks.push({ id: e.payload.taskId, caseId: c.id, owner: e.payload.owner, description: e.payload.description, createdAt: e.at, dueAt: e.payload.dueAt, completedAt: null });
        }
        break;
      case 'case_closed':
        if (c) {
          c.state = 'closed'; c.stateSince = e.at; c.closedAt = e.at; c.override = null;
          c.episodes[c.episodes.length - 1].closedAt = e.at;
          d.tasks.filter((t) => t.caseId === c.id && !t.completedAt).forEach((t) => (t.completedAt = e.at));
          d.callbacks.filter((cb) => cb.patientId === c.patientId && cb.at <= e.at).forEach((cb) => (cb.resolvedByCaseClosure = true));
        }
        break;
      case 'priority_overridden':
        if (c) c.override = { tier: e.payload.tier, reason: e.payload.reason, actor: e.actor, at: e.at };
        break;
      case 'override_cleared':
        if (c) c.override = null;
        break;
      case 'review_session':
        d.reviewSessions.push({ caseId: e.caseId ?? '', seconds: e.payload.seconds, at: e.at, actor: e.actor });
        break;
    }
  }
  return d;
}

export type NewEvent = Omit<AppEvent, 'id' | 'seq'>;

export const MESSAGE_TEMPLATES = ['recheck', 'missing', 'callback', 'verify', 'checkin'] as const;
export type TemplateId = (typeof MESSAGE_TEMPLATES)[number];
const MEDICATION_TERMS = /(insulin|metformin|dose|dosage|units of|tablet|medication|إنسولين|انسولين|جرعة|دواء|علاج)/i;

/** Guardrail: the prototype never produces or accepts medication/treatment advice in messages. */
export function containsTreatmentAdvice(text: string): boolean {
  return MEDICATION_TERMS.test(text);
}

const iso = (ms: number) => new Date(ms).toISOString();

export interface CommandCtx {
  d: Derived;
  now: string;
  actor: string;
  role: Role;
  taskDueHours: number;
  responseDueHours: number;
}

function needCase(ctx: CommandCtx, caseId: string): Case {
  const c = ctx.d.cases[caseId];
  if (!c) throw new WorkflowError('CASE_NOT_FOUND');
  return c;
}
function needClinician(ctx: CommandCtx) {
  if (ctx.role !== 'clinician') throw new WorkflowError('NOT_AUTHORISED');
}
function guard(c: Case, to: CaseState) {
  if (!TRANSITIONS[c.state].includes(to)) throw new WorkflowError('INVALID_TRANSITION', `${c.state}->${to}`);
}
const base = (ctx: CommandCtx, c: Case) => ({ at: ctx.now, patientId: c.patientId, caseId: c.id, actor: ctx.actor, role: ctx.role });

export const commands = {
  acknowledge(ctx: CommandCtx, caseId: string): NewEvent[] {
    needClinician(ctx);
    const c = needCase(ctx, caseId);
    guard(c, 'acknowledged');
    return [{ ...base(ctx, c), type: 'acknowledged', payload: {} }];
  },
  assign(ctx: CommandCtx, caseId: string, owner: string, description: string, taskId: string): NewEvent[] {
    needClinician(ctx);
    const c = needCase(ctx, caseId);
    guard(c, 'assigned');
    if (!owner.trim()) throw new WorkflowError('OWNER_REQUIRED');
    if (!description.trim()) throw new WorkflowError('DESCRIPTION_REQUIRED');
    const dueAt = iso(Date.parse(ctx.now) + ctx.taskDueHours * 3_600_000);
    const type = c.state === 'reassessment' ? 'returned_to_followup' : 'followup_assigned';
    return [{ ...base(ctx, c), type, payload: { owner: owner.trim(), description: description.trim(), dueAt, taskId } }];
  },
  sendMessage(ctx: CommandCtx, caseId: string, templateId: string, text: string): NewEvent[] {
    needClinician(ctx);
    const c = needCase(ctx, caseId);
    guard(c, 'awaiting_response');
    if (!text.trim()) throw new WorkflowError('MESSAGE_REQUIRED');
    if (containsTreatmentAdvice(text)) throw new WorkflowError('TREATMENT_ADVICE_BLOCKED');
    const responseDueAt = iso(Date.parse(ctx.now) + ctx.responseDueHours * 3_600_000);
    return [{ ...base(ctx, c), type: 'message_sent', payload: { templateId, text: text.trim(), responseDueAt } }];
  },
  patientRespond(ctx: CommandCtx, caseId: string, kind: string, text: string): NewEvent[] {
    if (ctx.role !== 'patient') throw new WorkflowError('NOT_AUTHORISED');
    const c = needCase(ctx, caseId);
    guard(c, 'reassessment'); // only from awaiting_response
    if (c.state !== 'awaiting_response') throw new WorkflowError('INVALID_TRANSITION');
    if (containsTreatmentAdvice(text)) throw new WorkflowError('TREATMENT_ADVICE_BLOCKED');
    return [{ ...base(ctx, c), type: 'patient_responded', payload: { kind, text: text.trim() } }];
  },
  startReassessment(ctx: CommandCtx, caseId: string): NewEvent[] {
    needClinician(ctx);
    const c = needCase(ctx, caseId);
    if (c.state !== 'awaiting_response') throw new WorkflowError('INVALID_TRANSITION');
    return [{ ...base(ctx, c), type: 'reassessment_started', payload: { withoutResponse: true } }];
  },
  close(ctx: CommandCtx, caseId: string, note: string): NewEvent[] {
    needClinician(ctx);
    const c = needCase(ctx, caseId);
    guard(c, 'closed');
    if (!note.trim()) throw new WorkflowError('NOTE_REQUIRED');
    const lastMsg = [...ctx.d.messages].reverse().find((m) => m.caseId === c.id);
    const withoutResponse = !lastMsg || !lastMsg.response;
    return [{ ...base(ctx, c), type: 'case_closed', payload: { note: note.trim(), withoutResponse } }];
  },
  override(ctx: CommandCtx, caseId: string, tier: number, reason: string): NewEvent[] {
    needClinician(ctx);
    const c = needCase(ctx, caseId);
    if (c.state === 'closed') throw new WorkflowError('CASE_CLOSED');
    if (!reason.trim()) throw new WorkflowError('REASON_REQUIRED');
    if (!Number.isInteger(tier) || tier < 1 || tier > 6) throw new WorkflowError('INVALID_TIER');
    return [{ ...base(ctx, c), type: 'priority_overridden', payload: { tier, reason: reason.trim() } }];
  },
  clearOverride(ctx: CommandCtx, caseId: string): NewEvent[] {
    needClinician(ctx);
    const c = needCase(ctx, caseId);
    if (!c.override) throw new WorkflowError('NO_OVERRIDE');
    return [{ ...base(ctx, c), type: 'override_cleared', payload: {} }];
  },
  recordReview(ctx: CommandCtx, caseId: string, seconds: number): NewEvent[] {
    needClinician(ctx);
    const c = needCase(ctx, caseId);
    if (!(seconds >= 0)) throw new WorkflowError('INVALID_DURATION');
    return [{ ...base(ctx, c), type: 'review_session', payload: { seconds: Math.round(seconds * 10) / 10, simulated: true } }];
  },
};
