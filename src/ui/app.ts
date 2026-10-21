import { DEFAULT_CONFIG } from '../core/config';
import { Engine } from '../core/engine';
import { buildDemoEngine, buildScenarioEngine, SCENARIOS, type Scenario } from '../core/scenarios';
import { caseIdFor, MESSAGE_TEMPLATES, STATE_ORDER, WorkflowError } from '../core/workflow';
import type { AppEvent, Config, WorklistItem } from '../core/types';
import { DICT, makeT, type Lang } from './i18n';

// ---------- tiny safe templating ----------
class Raw { constructor(public s: string) {} }
const raw = (s: string) => new Raw(s);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const part = (v: unknown): string => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : esc(v));
const h = (s: TemplateStringsArray, ...v: unknown[]) => new Raw(s.reduce((a, x, i) => a + x + (i < v.length ? part(v[i]) : ''), ''));

// ---------- state ----------
type View = 'patient' | 'clinician' | 'reviewer' | 'inspector';
interface Notice { kind: 'ok' | 'error'; text: string; scope: string }
const KEY = 'hs-demo-v1';
const SETTING_KEYS: (keyof Config)[] = ['lowMgdl', 'highMgdl', 'oorCount', 'oorWindowHours', 'missDays', 'ackSlaHours'];

let lang: Lang = (localStorage.getItem('hs-lang') as Lang) || 'ar';
let view: View = 'patient';
let patientId = 'p-001';
let caseSel: string | null = null;
let tab: 'open' | 'closed' | 'quiet' = 'open';
let scenarioId = SCENARIOS[0].id;
let notice: Notice | null = null;
let timer: { caseId: string; start: number } | null = null;
let engine: Engine = load();
let t = makeT(lang);

function load(): Engine {
  const pats = SCENARIOS.map((s) => s.patient);
  try {
    const j = localStorage.getItem(KEY);
    const cfg = { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(KEY + '-cfg') || '{}') };
    if (j) return Engine.restore(pats, j, cfg);
  } catch { /* fall through to fresh demo */ }
  return buildDemoEngine();
}
const save = () => {
  try { localStorage.setItem(KEY, engine.serialize()); } catch { /* storage unavailable: demo still works in-memory */ }
};

// ---------- formatting ----------
const locale = () => (lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB');
const fmt = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat(locale(), { timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—';
const num = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? '—' : String(Math.round(n * 10 ** d) / 10 ** d));
const pat = (id: string) => engine.patients.find((p) => p.id === id)!;
const pname = (id: string) => (lang === 'ar' ? pat(id).nameAr : pat(id).nameEn);
const actorName = (e: { actor: string; role: string }) => (e.role === 'patient' ? pname(e.actor) : e.role === 'system' ? t('role.system') : e.actor);
const riyadhLocal = (ms: number) => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 16);
const fromRiyadhLocal = (v: string) => (v ? new Date(v + ':00+03:00').toISOString() : null);
const errText = (e: unknown) => (e instanceof WorkflowError ? t('err.' + e.code) === 'err.' + e.code ? t('err.generic') : t('err.' + e.code) : t('err.generic'));
const allItems = () => { const w = engine.worklist(); return [...w.items, ...w.closed, ...w.quiet]; };
const itemFor = (pid: string) => allItems().find((i) => i.patientId === pid)!;

function tplText(id: string, stored: string) {
  return (MESSAGE_TEMPLATES as readonly string[]).includes(id) ? t('tpl.' + id) : stored;
}
function ruleText(tr: { summaryKey: string; params: Record<string, string | number> }) { return t(tr.summaryKey, tr.params); }
function urgText(f: WorklistItem['urgencyFlags'][number]) {
  return t('urg.' + f.kind, { ...(f as any), sla: engine.cfg.ackSlaHours });
}
function reasonText(r: { key: string; params: Record<string, string | number> }) {
  const p = { ...r.params };
  if (r.key === 'reason.vsNext') { p.by = t('by.' + p.by); p.next = String(p.next); }
  return t(r.key, p);
}
const stateChip = (s: string) => h`<span class="chip state-${s}">${t('state.' + s)}</span>`;
const tierChip = (n: number) => h`<span class="chip tier-${n}">${t('tier.' + n)}</span>`;

function describe(e: AppEvent): string {
  const p = e.payload;
  switch (e.type) {
    case 'reading_submitted': return `${p.reading.value ?? '∅'} ${p.reading.unit ?? '∅'} · ${fmt(p.reading.takenAt)}`;
    case 'callback_requested': return p.text || '';
    case 'case_opened': case 'case_reopened': case 'trigger_added':
      return (p.triggers ?? []).map((x: any) => `${x.ruleId} v${x.ruleVersion}`).join(', ');
    case 'followup_assigned': case 'returned_to_followup': return `${p.owner}: ${p.description} (${fmt(p.dueAt)})`;
    case 'message_sent': return tplText(p.templateId, p.text);
    case 'patient_responded': return `${p.kind}${p.text ? ' — ' + p.text : ''}`;
    case 'case_closed': return p.note + (p.withoutResponse ? ' (no patient response)' : '');
    case 'priority_overridden': return `T${p.tier}: ${p.reason}`;
    case 'review_session': return t('r.m.seconds', { n: p.seconds });
    default: return '';
  }
}
const history = (evs: AppEvent[]) => h`<ol class="history">${evs.map((e) => h`<li><time datetime="${e.at}">${fmt(e.at)}</time> <strong>${t('ev.' + e.type)}</strong> <span class="muted">· ${actorName(e)}</span>${describe(e) ? h`<div class="detail">${describe(e)}</div>` : ''}</li>`)}</ol>`;

// ---------- views ----------
function qualityList(it: WorklistItem) {
  const bad = it.assessed.filter((a) => a.flags.length);
  if (!bad.length) return h`<p class="muted">${t('d.noQuality')}</p>`;
  return h`<ul class="plain">${bad.map((a) => h`<li><strong>${a.raw.value ?? '∅'} ${a.raw.unit ?? '∅'}</strong> · ${fmt(a.raw.takenAt)} → ${t('qs.' + a.status)}: ${a.flags.map((f) => t('q.' + f.code)).join('، ')}</li>`)}</ul>`;
}

function readingsTable(it: WorklistItem, limit = 12) {
  const rows = [...it.assessed].reverse().slice(0, limit);
  return h`<div class="scroll"><table><caption class="sr">${t('d.readings')}</caption><thead><tr><th>${t('d.raw')}</th><th>${t('d.norm')}</th><th>${t('p.col.taken')}</th><th>${t('p.col.received')}</th><th>${t('d.status')}</th></tr></thead><tbody>${rows.map((a) => h`<tr><td>${a.raw.value ?? '∅'} ${a.raw.unit ?? '∅'}</td><td>${num(a.mgdl)}</td><td>${fmt(a.raw.takenAt)}</td><td>${fmt(a.raw.receivedAt)}</td><td>${t('qs.' + a.status)}${a.outOfRange ? ' · ' + t('or.' + a.outOfRange) : ''}${a.flags.length ? h`<div class="muted">${a.flags.map((f) => t('q.' + f.code)).join('، ')}</div>` : ''}</td></tr>`)}</tbody></table></div>`;
}

const noticeBox = (scope: string) =>
  notice && notice.scope === scope ? h`<p class="notice ${notice.kind}" role="${notice.kind === 'error' ? 'alert' : 'status'}">${notice.text}</p>` : '';

function patientView() {
  const it = itemFor(patientId);
  const p = pat(patientId);
  const c = engine.d.cases[caseIdFor(patientId)];
  const d = engine.d;
  const msgs = d.messages.filter((m) => m.patientId === patientId);
  const pending = msgs.filter((m) => !m.response && c?.state === 'awaiting_response');
  const past = msgs.filter((m) => m.response);
  const todayKey = engine.nowIso.slice(0, 10);
  const todayN = it.assessed.filter((a) => a.takenMs !== null && new Date(a.takenMs).toISOString().slice(0, 10) === todayKey && a.status !== 'duplicate' && a.status !== 'invalid').length;
  let team: string;
  if (!c) team = t('p.team.none');
  else if (c.state === 'new') team = t('p.team.new', { t: fmt(c.stateSince) });
  else if (c.state === 'acknowledged') team = t('p.team.ack', { t: fmt(c.acknowledgedAt), o: c.owner ?? '' });
  else if (c.state === 'assigned') team = t('p.team.assigned', { o: c.owner ?? '' });
  else if (c.state === 'awaiting_response') team = t('p.team.awaiting');
  else if (c.state === 'reassessment') team = t('p.team.reassessment');
  else team = t('p.team.closed', { t: fmt(c.closedAt) });

  return h`
  <section aria-labelledby="pv-h"><h2 id="pv-h" class="sr">${t('nav.patient')}</h2>
    <div class="row"><label for="pat-sel">${t('p.choose')}</label>
      <select id="pat-sel" data-change="patient">${engine.patients.map((x) => h`<option value="${x.id}" ${x.id === patientId ? raw('selected') : ''}>${lang === 'ar' ? x.nameAr : x.nameEn}</option>`)}</select></div>
    <p class="muted">${p.schedule ? t('p.schedule', { n: p.schedule.perDay, d: p.schedule.startDate }) + ' ' + t('p.today', { r: todayN, n: p.schedule.perDay }) : t('p.noSchedule')}</p>
    <div class="grid3">
      <article class="card" aria-labelledby="q1"><h3 id="q1">1. ${t('p.q1')}</h3>
        <form data-form="reading" novalidate>
          <div class="field"><label for="f-value">${t('f.value')}</label><input id="f-value" name="value" inputmode="decimal" autocomplete="off" aria-describedby="f-value-err f-help" /><div id="f-value-err" class="err" hidden>${t('f.err.value')}</div></div>
          <div class="field"><label for="f-unit">${t('f.unit')}</label><select id="f-unit" name="unit" aria-describedby="f-unit-err"><option value="mg/dL">mg/dL</option><option value="mmol/L">mmol/L</option></select><div id="f-unit-err" class="err" hidden>${t('f.err.unit')}</div></div>
          <div class="field"><label for="f-taken">${t('f.takenAt')}</label><input id="f-taken" name="takenAt" type="datetime-local" value="${riyadhLocal(engine.nowMs)}" aria-describedby="f-taken-err" /><div id="f-taken-err" class="err" hidden>${t('f.err.takenAt')}</div></div>
          <div class="field"><label for="f-ctx">${t('f.context')}</label><select id="f-ctx" name="context">${['fasting', 'after_meal', 'random'].map((k) => h`<option value="${k}">${t('f.ctx.' + k)}</option>`)}</select></div>
          <p id="f-help" class="muted">${t('f.help')} ${t('tz')}</p>
          <button class="btn primary" type="submit">${t('f.submit')}</button>
        </form>
        ${noticeBox('reading')}
        <details class="sub"><summary>${t('cb.title')}</summary>
          <form data-form="callback"><div class="field"><label for="cb-t">${t('cb.text')}</label><input id="cb-t" name="text" /></div><button class="btn" type="submit">${t('cb.send')}</button></form>
          ${noticeBox('callback')}
        </details>
      </article>
      <article class="card" aria-labelledby="q2"><h3 id="q2">2. ${t('p.q2')}</h3>
        <p class="status-line" role="status">${team}</p>
        ${it.assessed.length === 0 ? h`<p class="empty">${t('p.noReadings')}</p>` : h`
        <h4>${t('p.recent')}</h4>
        <div class="scroll"><table><thead><tr><th>${t('p.col.value')}</th><th>${t('p.col.taken')}</th><th>${t('p.col.received')}</th><th>${t('p.col.status')}</th></tr></thead><tbody>
        ${[...it.assessed].reverse().slice(0, 6).map((a) => h`<tr><td>${a.raw.value ?? '∅'} ${a.raw.unit ?? '∅'}</td><td>${fmt(a.raw.takenAt)}</td><td>${fmt(a.raw.receivedAt)}</td><td>${a.status === 'valid' ? t('p.st.received') : a.status === 'questionable' ? t('p.st.check') : a.status === 'duplicate' ? t('p.st.duplicate') : t('p.st.invalid')}${a.flags.length ? h`<div class="muted">${a.flags.map((f) => t('q.' + f.code)).join('، ')}</div>` : ''}</td></tr>`)}
        </tbody></table></div>`}
      </article>
      <article class="card" aria-labelledby="q3"><h3 id="q3">3. ${t('p.q3')}</h3>
        ${noticeBox('respond')}
        ${pending.length === 0 ? h`<p class="empty">${t('p.tasks.none')}</p>` : pending.map((m) => h`
          <form data-form="respond" data-case="${m.caseId}" class="task">
            <p class="muted">${t('p.msgFrom', { a: t('role.clinician'), t: fmt(m.at) })}</p>
            <blockquote>${tplText(m.templateId, m.text)}</blockquote>
            <p class="muted">${t('p.due', { t: fmt(c?.responseDueAt) })}</p>
            <fieldset><legend>${t('p.q3')}</legend>
              ${['rechecked', 'fine', 'callme'].map((k, i) => h`<label class="radio"><input type="radio" name="kind" value="${k}" ${i === 0 ? '' : ''}/> ${t('p.resp.' + k)}</label>`)}
            </fieldset>
            <div class="field"><label for="rt">${t('p.resp.note')}</label><input id="rt" name="text" /></div>
            <button class="btn primary" type="submit">${t('p.resp.send')}</button>
          </form>`)}
        ${past.length ? h`<h4>${t('p.tasks.done')}</h4><ul class="plain">${past.map((m) => h`<li>${tplText(m.templateId, m.text)}<div class="muted">${t('p.resp.yours', { t: fmt(m.respondedAt), r: (m.response!.kind === 'rechecked' ? t('p.resp.rechecked') : m.response!.kind === 'fine' ? t('p.resp.fine') : m.response!.kind === 'callme' ? t('p.resp.callme') : m.response!.kind) + (m.response!.text ? ' — ' + m.response!.text : '') })}</div></li>`)}</ul>` : ''}
        <p class="muted">${t('p.resp.emergency')}</p>
      </article>
    </div></section>`;
}

function stepper(s: string) {
  const idx = STATE_ORDER.indexOf(s as any);
  return h`<ol class="stepper" aria-label="${t('d.state')}">${STATE_ORDER.map((x, i) => h`<li class="${i < idx ? 'done' : i === idx ? 'current' : ''}" ${i === idx ? raw('aria-current="step"') : ''}>${t('state.' + x)}</li>`)}</ol>`;
}

function templateSelect(def: string) {
  return h`<select id="a-tpl" name="templateId" data-change="tpl">${MESSAGE_TEMPLATES.map((k) => h`<option value="${k}" ${k === def ? raw('selected') : ''}>${t('tpl.' + k)}</option>`)}</select>`;
}

function actionsPanel(it: WorklistItem) {
  const c = engine.d.cases[it.caseId!];
  const cid = c.id;
  const topRule = it.triggers[0]?.ruleId;
  const defTpl = topRule === 'R-CALL' ? 'callback' : topRule === 'R-OOR' ? 'recheck' : topRule === 'R-MISS' ? 'missing' : topRule === 'R-QUAL' ? 'verify' : 'checkin';
  const defDesc = topRule === 'R-CALL' ? 'Return patient call request' : topRule === 'R-MISS' ? 'Contact patient about missing readings' : topRule === 'R-QUAL' ? 'Ask patient to verify flagged reading' : 'Contact patient to request a repeat measurement';
  const lastMsg = [...engine.d.messages].reverse().find((m) => m.caseId === cid);
  const assignForm = h`<form data-form="assign" data-case="${cid}"><div class="field"><label for="a-own">${t('a.owner')}</label><input id="a-own" name="owner" value="${c.owner && c.owner !== 'clinician-demo' ? c.owner : 'nurse-demo-A'}" /></div><div class="field"><label for="a-desc">${t('a.desc')}</label><input id="a-desc" name="description" value="${defDesc}" /></div><button class="btn primary" type="submit">${t('a.assignBtn')}</button></form>`;
  let body;
  switch (c.state) {
    case 'new': body = h`<button class="btn primary" data-action="ack" data-case="${cid}">${t('a.ack')}</button>`; break;
    case 'acknowledged': body = h`<h5>${t('a.assign')}</h5>${assignForm}`; break;
    case 'assigned': body = h`<h5>${t('a.msg')}</h5><form data-form="message" data-case="${cid}"><div class="field"><label for="a-tpl">${t('a.tpl')}</label>${templateSelect(defTpl)}</div><div class="field"><label for="a-msg">${t('a.msgText')}</label><textarea id="a-msg" name="text" rows="3" aria-describedby="a-help">${t('tpl.' + defTpl)}</textarea><p id="a-help" class="muted">${t('a.msgHelp')}</p></div><button class="btn primary" type="submit">${t('a.sendBtn')}</button></form>`; break;
    case 'awaiting_response': body = h`<p>${t('a.waiting', { t: fmt(c.awaitingSince), d: fmt(c.responseDueAt) })}</p><button class="btn" data-action="reassess" data-case="${cid}">${t('a.reassess')}</button>`; break;
    case 'reassessment': body = h`<p><strong>${t('a.response')}:</strong> ${lastMsg?.response ? `${lastMsg.response.kind}${lastMsg.response.text ? ' — ' + lastMsg.response.text : ''}` : '—'}</p>
      <h5>${t('a.close')}</h5><form data-form="close" data-case="${cid}"><div class="field"><label for="a-note">${t('a.note')}</label><input id="a-note" name="note" /></div><button class="btn primary" type="submit">${t('a.closeBtn')}</button></form>
      <h5>${t('a.again')}</h5>${assignForm}`; break;
    default: body = h`<p class="muted">${t('a.noAction')}</p>`;
  }
  const ov = c.override
    ? h`<p class="notice ok">${t('a.ovActive', { t: c.override.tier, b: it.baseTier, r: c.override.reason, a: c.override.actor, w: fmt(c.override.at) })}</p><button class="btn" data-action="clearov" data-case="${cid}">${t('a.ovClear')}</button>`
    : '';
  const override = c.state === 'closed' ? '' : h`<details class="sub"><summary>${t('d.override')}</summary>${ov}<form data-form="override" data-case="${cid}"><div class="field"><label for="o-tier">${t('a.ovTier')}</label><select id="o-tier" name="tier">${[1, 2, 3, 4, 5, 6].map((n) => h`<option value="${n}">${t('tier.' + n)}</option>`)}</select></div><div class="field"><label for="o-r">${t('a.ovReason')}</label><input id="o-r" name="reason" /></div><button class="btn" type="submit">${t('a.ovBtn')}</button></form></details>`;
  return h`${noticeBox('action')}${body}${override}`;
}

function detail(it: WorklistItem) {
  const d = engine.d;
  const c = it.caseId ? d.cases[it.caseId] : undefined;
  const evs = d.events.filter((e) => e.patientId === it.patientId && e.role !== undefined);
  const running = timer && timer.caseId === it.caseId;
  return h`<section class="card detail" aria-labelledby="dh" tabindex="-1" id="detail">
    <div class="row between"><h3 id="dh">${pname(it.patientId)} <span class="muted">${it.patientId}</span></h3>
      ${c ? h`<div>${running ? h`<span class="muted" role="status">${t('d.timer.running')}</span> <button class="btn" data-action="timer-stop">${t('d.timer.stop')}</button>` : h`<button class="btn" data-action="timer-start" data-case="${c.id}">${t('d.timer.start')}</button>`}</div>` : ''}</div>
    ${noticeBox('timer')}
    ${c ? stepper(c.state) : ''}
    <h4>${t('d.why')}</h4>
    <p>${tierChip(it.tier)} ${it.overridden ? h`<span class="chip warn">${t('d.override')}</span>` : ''}</p>
    <ul class="plain">${it.reasonKeys.map((r) => h`<li>${reasonText(r)}</li>`)}${it.urgencyFlags.map((f) => h`<li>${urgText(f)}</li>`)}</ul>
    <h4>${t('d.triggers')}</h4>
    ${it.triggers.length ? it.triggers.map((tr) => h`<div class="trig"><p><strong>${tr.ruleId}</strong> · ${t('d.version')} ${tr.ruleVersion} · ${tierChip(tr.tier)}</p><p>${ruleText(tr)}</p><p class="muted">${t('d.first')}: ${fmt(tr.firstEvidenceAt)} · ${t('d.latest')}: ${fmt(tr.latestEvidenceAt)}</p><p class="muted">${t('d.obs')}: ${tr.observationIds.join(', ')}</p></div>`) : h`<p class="muted">${t('d.noTriggers')}</p>`}
    <h4>${t('d.quality')}</h4>${qualityList(it)}
    <h4>${t('d.completeness')} — ${t('comp.' + it.completeness.state)}</h4>
    ${it.completeness.state === 'insufficient_information' ? h`<p class="muted">${t('d.insufficient')}</p>` : ''}
    ${it.completeness.days.length ? h`<div class="scroll"><table><thead><tr><th>${t('d.date')}</th><th>${t('d.expected')}</th><th>${t('d.received')}</th></tr></thead><tbody>${it.completeness.days.map((x) => h`<tr><td>${x.date}</td><td>${x.expected}</td><td>${x.received}${x.received === 0 ? ' ⚠' : ''}</td></tr>`)}</tbody></table></div><p>${it.completeness.received}/${it.completeness.expected}</p>` : ''}
    <h4>${t('d.readings')}</h4>${readingsTable(it)}
    ${c ? h`<h4>${t('d.actions')}</h4>${actionsPanel(it)}` : ''}
    <h4>${t('d.history')}</h4>${history(evs.slice(-30))}
  </section>`;
}

function worklist() {
  const w = engine.worklist();
  const list = tab === 'open' ? w.items : tab === 'closed' ? w.closed : w.quiet;
  const sel = list.find((i) => i.patientId === caseSel) ?? null;
  const row = (it: WorklistItem) => {
    const flagged = it.assessed.filter((a) => a.status === 'questionable' || a.status === 'invalid').length;
    return h`<tr class="${it.patientId === caseSel ? 'sel' : ''}">
      <td data-label="${t('c.col.rank')}">${tab === 'open' ? it.rank : '–'}</td>
      <td data-label="${t('c.col.patient')}"><button class="link" data-action="select" data-id="${it.patientId}" aria-label="${t('c.open')} ${pname(it.patientId)}">${pname(it.patientId)}</button></td>
      <td data-label="${t('c.col.why')}">${tierChip(it.tier)}${it.overridden ? h` <span class="chip warn">↑ override</span>` : ''}<div class="muted">${it.triggers.map((x) => x.ruleId).join(' · ')}${it.urgencyFlags.length ? ' · ' + urgText(it.urgencyFlags[0]) : ''}</div></td>
      <td data-label="${t('c.col.data')}">${it.completeness.lastUsableAgeHours === null ? t('c.noLast') : t('c.last', { h: num(it.completeness.lastUsableAgeHours) })}<div class="muted">${it.completeness.state === 'insufficient_information' ? t('comp.insufficient_information') : t('c.comp', { r: it.completeness.received, e: it.completeness.expected }) + ' · ' + t('comp.' + it.completeness.state)}${flagged ? ' · ' + t('c.flags', { n: flagged }) : ''}</div></td>
      <td data-label="${t('c.col.owner')}">${it.owner ?? t('c.unowned')}</td>
      <td data-label="${t('c.col.state')}">${stateChip(it.state)}</td>
      <td data-label="${t('c.col.open')}">${it.unresolved.length ? it.unresolved.map((u) => t(u)).join('، ') : t('c.noneOpen')}</td></tr>`;
  };
  return h`<section aria-labelledby="cw"><h2 id="cw">${t('c.title')}</h2><p class="muted">${t('c.q')}</p>
    <div class="tabs" role="tablist">${(['open', 'closed', 'quiet'] as const).map((k) => h`<button role="tab" class="tabbtn" aria-selected="${tab === k}" data-action="tab" data-id="${k}">${t('c.tab.' + k, { n: (k === 'open' ? w.items : k === 'closed' ? w.closed : w.quiet).length })}</button>`)}</div>
    ${noticeBox('global')}
    ${list.length === 0 ? h`<p class="empty">${t('c.empty.' + tab)}</p>` : h`<div class="scroll wide"><table class="work"><thead><tr>${['rank', 'patient', 'why', 'data', 'owner', 'state', 'open'].map((k) => h`<th scope="col">${t('c.col.' + k)}</th>`)}</tr></thead><tbody>${list.map(row)}</tbody></table></div>`}
    ${sel ? detail(sel) : h`<p class="muted">${t('c.select')}</p>`}
  </section>`;
}

const ratioText = (r: { num: number; den: number; pct: number | null }) => `${r.num}/${r.den}` + (r.pct === null ? '' : ` (${num(r.pct)}%)`);
function settingsForm() {
  return h`<form data-form="settings" class="settings">${SETTING_KEYS.map((k) => h`<div class="field"><label for="s-${k}">${t('s.' + k)}</label><input id="s-${k}" name="${k}" type="number" min="1" value="${engine.cfg[k]}" /></div>`)}<button class="btn" type="submit">${t('s.apply')}</button> <button class="btn" type="button" data-action="settings-reset">${t('s.reset')}</button></form>`;
}
function metricsBlock(e: Engine) {
  const m = e.metrics();
  const list = (a: string[]) => (a.length ? a.join(', ') : t('r.m.none'));
  const row = (k: string, v: unknown) => h`<tr><th scope="row">${t(k)}</th><td>${v}</td></tr>`;
  return h`<div class="scroll"><table class="metrics"><tbody>
    ${row('r.m.completeness', h`${ratioText(m.completeness)}<div class="muted">${t('r.m.insuff', { n: m.completeness.patientsInsufficient })}</div>`)}
    ${row('r.m.ack', h`${ratioText(m.acknowledgement)}<div class="muted">${t('r.m.unackList', { l: list(m.acknowledgement.unacknowledged) })}</div>`)}
    ${row('r.m.ackTime', m.acknowledgement.medianMinutes === null ? t('r.m.na') : t('r.m.minutes', { n: num(m.acknowledgement.medianMinutes) }) + ` (n=${m.acknowledgement.num})`)}
    ${row('r.m.followup', h`${ratioText(m.followup)}<div class="muted">${t('r.m.noFu', { l: list(m.followup.withoutFollowup) })}</div>`)}
    ${row('r.m.followupTime', m.followup.medianMinutes === null ? t('r.m.na') : t('r.m.minutes', { n: num(m.followup.medianMinutes) }) + ` (n=${m.followup.num})`)}
    ${row('r.m.tasks', h`${ratioText(m.tasks)}<div class="muted">${t('r.m.openTasks', { o: m.tasks.open, d: m.tasks.overdue })}</div>`)}
    ${row('r.m.closure', ratioText(m.closure))}
    ${row('r.m.unresolved', `${m.unresolved.openCases}: ${list(m.unresolved.openCaseIds)}`)}
    ${row('r.m.overdue', `${m.unresolved.overdueCases}: ${list(m.unresolved.overdueCaseIds)}`)}
    ${row('r.m.review', m.review.sessions === 0 ? '0' : `${m.review.sessions} · ${t('r.m.seconds', { n: num(m.review.medianSeconds) })} (median)`)}
  </tbody></table></div><p class="muted">${t('r.m.events', { n: m.events })}</p>`;
}

function reviewerView() {
  const cfg = engine.cfg;
  return h`<section aria-labelledby="rv"><h2 id="rv">${t('r.title')}</h2>
    <p class="notice warn">${t('r.disc')}</p>
    <div class="grid2">${[1, 2, 3, 4].map((n) => h`<article class="card"><h3>${t('r.q' + n)}</h3><p>${t('r.a' + n)}</p></article>`)}</div>
    <article class="card"><h3>${t('r.flow')}</h3><p>${t('r.flowSteps')}</p></article>
    <article class="card"><h3>${t('r.metrics')}</h3>${metricsBlock(engine)}</article>
    <article class="card"><h3>${t('r.decision')}</h3><div class="scroll"><table><thead><tr><th>${t('r.d.tier')}</th><th>${t('r.d.cond')}</th></tr></thead><tbody>${[1, 2, 3, 4, 5, 6].map((n) => h`<tr><td>${tierChip(n)}</td><td>${t('dt.' + n)}${n === 2 ? ` (≥ ${cfg.oorCount}, < ${cfg.lowMgdl} / > ${cfg.highMgdl} mg/dL, ${cfg.oorWindowHours} h)` : n === 4 ? ` (≥ ${cfg.missDays})` : n === 3 ? ` (${cfg.ackSlaHours} h)` : ''}</td></tr>`)}</tbody></table></div><p class="muted">${t('r.tiebreak')}</p></article>
    <article class="card"><h3>${t('r.settings')}</h3><p class="muted">${t('r.settingsNote')} (${cfg.version})</p>${noticeBox('settings')}${settingsForm()}</article>
    <article class="card"><h3>${t('r.eval')}</h3><p>${t('r.evalText')}</p></article>
  </section>`;
}

const FROM_TYPE: Record<string, string> = { case_opened: 'new', case_reopened: 'new', acknowledged: 'acknowledged', followup_assigned: 'assigned', returned_to_followup: 'assigned', message_sent: 'awaiting_response', patient_responded: 'reassessment', reassessment_started: 'reassessment', case_closed: 'closed' };
function inspectorView() {
  const s: Scenario = SCENARIOS.find((x) => x.id === scenarioId)!;
  const e = buildScenarioEngine(s);
  const wl = [...e.worklist().items, ...e.worklist().closed, ...e.worklist().quiet][0];
  const evs = e.d.events;
  let prev = '—';
  const trans = evs.filter((x) => FROM_TYPE[x.type]).map((x) => { const r = { x, from: prev, to: FROM_TYPE[x.type] }; prev = r.to; return r; });
  const ok = wl.state === s.expected.state && JSON.stringify(wl.triggers.map((x) => x.ruleId).sort()) === JSON.stringify([...s.expected.rules].sort()) && (!s.expected.tier || wl.tier === s.expected.tier);
  return h`<section aria-labelledby="iv"><h2 id="iv">${t('i.title')}</h2><p class="muted">${t('i.intro')}</p>
    <div class="row"><label for="sc-sel">${t('i.choose')}</label><select id="sc-sel" data-change="scenario">${SCENARIOS.map((x) => h`<option value="${x.id}" ${x.id === scenarioId ? raw('selected') : ''}>${x.id} — ${t('sc.' + x.focus)}</option>`)}</select></div>
    <article class="card"><h3>${t('i.inputs')}</h3>${readingsTable(wl, 20)}${e.d.callbacks.length ? h`<p>${t('ev.callback_requested')}: ${e.d.callbacks.map((c) => fmt(c.at) + ' — ' + c.text).join(' | ')}</p>` : ''}</article>
    <article class="card"><h3>${t('i.rules')}</h3>${wl.triggers.length ? wl.triggers.map((tr) => h`<p><strong>${tr.ruleId}</strong> v${tr.ruleVersion} · ${tierChip(tr.tier)}<br>${ruleText(tr)}<br><span class="muted">${tr.observationIds.join(', ')} · ${fmt(tr.firstEvidenceAt)} → ${fmt(tr.latestEvidenceAt)}</span></p>`) : h`<p class="muted">${t('i.noRules')}</p>`}<h4>${t('d.quality')}</h4>${qualityList(wl)}<p>${t('comp.' + wl.completeness.state)} — ${wl.completeness.received}/${wl.completeness.expected}</p></article>
    <article class="card"><h3>${t('i.reasons')}</h3><ul class="plain">${wl.reasonKeys.map((r) => h`<li>${reasonText(r)}</li>`)}${wl.urgencyFlags.map((f) => h`<li>${urgText(f)}</li>`)}</ul></article>
    <article class="card"><h3>${t('i.transitions')}</h3>${trans.length ? h`<div class="scroll"><table><thead><tr><th>${t('i.time')}</th><th>${t('i.from')}</th><th>${t('i.to')}</th><th>${t('i.actor')}</th></tr></thead><tbody>${trans.map((r) => h`<tr><td>${fmt(r.x.at)}</td><td>${r.from === '—' ? '—' : t('state.' + r.from)}</td><td>${t('state.' + r.to)}</td><td>${actorName(r.x)} · ${t('ev.' + r.x.type)}</td></tr>`)}</tbody></table></div>` : h`<p class="muted">${t('state.no_case')}</p>`}</article>
    <article class="card"><h3>${t('i.metrics')}</h3>${metricsBlock(e)}</article>
    <article class="card"><h3>${t('i.expected')}</h3><p>${s.expected.state}${s.expected.tier ? ' · T' + s.expected.tier : ''} · [${s.expected.rules.join(', ')}] ⇄ ${wl.state} · T${wl.tier} · [${wl.triggers.map((x) => x.ruleId).join(', ')}] — <strong>${ok ? t('i.pass') : t('i.fail')}</strong></p></article>
  </section>`;
}

function shell(body: Raw) {
  const nav = (['patient', 'clinician', 'reviewer', 'inspector'] as View[]).map((v) => h`<a href="#/${v}" class="navlink" ${v === view ? raw('aria-current="page"') : ''}>${t('nav.' + v)}</a>`);
  return h`<a class="skip" href="#main">${t('skip')}</a>
  <header><div class="brand"><span class="logo" aria-hidden="true">✚</span><div><h1>${t('app.title')}</h1><p class="muted">${t('app.subtitle')}</p></div></div>
    <nav aria-label="main">${nav}</nav><button class="btn" data-action="lang" lang="${lang === 'ar' ? 'en' : 'ar'}">${t('lang.toggle')}</button></header>
  <p class="banner" role="note">${t('banner')}</p>
  <div class="clock" role="group" aria-label="${t('clock.label')}"><strong>${t('clock.label')}:</strong> <time datetime="${engine.nowIso}">${fmt(engine.nowIso)}</time> <span class="muted">${t('tz')}</span>
    <button class="btn" data-action="adv" data-id="1">${t('clock.plus1h')}</button><button class="btn" data-action="adv" data-id="4">${t('clock.plus4h')}</button><button class="btn" data-action="adv" data-id="24">${t('clock.plus1d')}</button><button class="btn" data-action="reset">${t('clock.reset')}</button></div>
  <main id="main" tabindex="-1">${body}</main>`;
}

// ---------- render & events ----------
const root = () => document.getElementById('app')!;
export function render(focusId?: string) {
  t = makeT(lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.title = t('app.title');
  const body = view === 'patient' ? patientView() : view === 'clinician' ? worklist() : view === 'reviewer' ? reviewerView() : inspectorView();
  root().innerHTML = shell(body).s;
  if (focusId) document.getElementById(focusId)?.focus();
}

function attempt(scope: string, f: () => void, focus?: string, okText?: string) {
  try {
    f();
    save();
    notice = { kind: 'ok', text: okText ?? t('ok.done'), scope };
  } catch (e) {
    notice = { kind: 'error', text: errText(e), scope };
  }
  render(focus);
}

const val = (f: HTMLFormElement, n: string) => ((f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '').trim();

function onSubmit(ev: Event) {
  const f = ev.target as HTMLFormElement;
  const kind = f.dataset.form;
  if (!kind) return;
  const snap = Array.from(new FormData(f).entries()).map(([k, v]) => [k, String(v)] as [string, string]);
  const cid = f.dataset.case;
  handleSubmit(ev);
  // keep what the user typed (and the open section) when validation fails
  if (notice?.kind === 'error' && kind !== 'settings') {
    const nf = document.querySelector(`form[data-form="${kind}"]${cid ? `[data-case="${cid}"]` : ''}`) as HTMLFormElement | null;
    if (nf) {
      for (const [k, v] of snap) { const c = nf.elements.namedItem(k); if (c instanceof HTMLInputElement && c.type === 'radio') continue; if (c && 'value' in c) (c as unknown as HTMLInputElement).value = v; }
      nf.closest('details')?.setAttribute('open', '');
    }
  }
}

function handleSubmit(ev: Event) {
  const f = ev.target as HTMLFormElement;
  const kind = f.dataset.form;
  if (!kind) return;
  ev.preventDefault();
  const cid = f.dataset.case ?? '';
  if (kind === 'reading') {
    const value = val(f, 'value').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace('٫', '.');
    const v = value === '' ? null : Number(value);
    const takenAt = fromRiyadhLocal(val(f, 'takenAt'));
    const input = { value: v, unit: val(f, 'unit'), takenAt, context: val(f, 'context') };
    try {
      const evs = engine.submitReadingForm(patientId, input);
      save();
      const a = itemFor(patientId).assessed.find((x) => x.raw.id === evs[0].payload.reading.id)!;
      const base = t('f.ok', { t: fmt(engine.nowIso) });
      notice = { kind: 'ok', scope: 'reading', text: a.flags.length ? base + t('f.okFlag', { f: a.flags.map((x) => t('q.' + x.code)).join('، ') }) : base };
    } catch (e) {
      const fields = e instanceof WorkflowError && e.code === 'FORM_INVALID' ? (e.message || '').split(',') : [];
      notice = { kind: 'error', scope: 'reading', text: fields.length ? fields.map((k) => t('f.err.' + k)).join(' ') : errText(e) };
    }
    render('main');
    return;
  }
  if (kind === 'callback') return attempt('callback', () => engine.requestCallback(patientId, val(f, 'text')), 'main', t('cb.ok', { t: fmt(engine.nowIso) }));
  if (kind === 'respond') {
    const k = val(f, 'kind') || ((f.querySelector('input[name=kind]:checked') as HTMLInputElement | null)?.value ?? '');
    if (!k) { notice = { kind: 'error', scope: 'respond', text: t('p.resp.needChoice') }; return render('main'); }
    return attempt('respond', () => { engine.respond(cid, k, val(f, 'text')); if (k === 'callme') engine.requestCallback(patientId, val(f, 'text')); }, 'main', t('p.resp.sent', { t: fmt(engine.nowIso) }));
  }
  if (kind === 'assign') return attempt('action', () => engine.assign(cid, val(f, 'owner'), val(f, 'description')), 'detail');
  if (kind === 'message') {
    const text = val(f, 'text');
    let tpl = val(f, 'templateId');
    if (text !== DICT.ar['tpl.' + tpl] && text !== DICT.en['tpl.' + tpl]) tpl = 'custom';
    return attempt('action', () => engine.sendMessage(cid, tpl, text), 'detail');
  }
  if (kind === 'close') return attempt('action', () => engine.close(cid, val(f, 'note')), 'detail');
  if (kind === 'override') return attempt('action', () => engine.override(cid, Number(val(f, 'tier')), val(f, 'reason')), 'detail');
  if (kind === 'settings') {
    const next: Config = { ...engine.cfg };
    for (const k of SETTING_KEYS) { const n = Number(val(f, k)); if (Number.isFinite(n) && n > 0) (next as any)[k] = n; }
    engine.cfg = next;
    localStorage.setItem(KEY + '-cfg', JSON.stringify(next));
    return attempt('settings', () => engine.sync(), 'main');
  }
}

function onClick(ev: Event) {
  const el = (ev.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
  if (!el) return;
  const a = el.dataset.action!;
  const cid = el.dataset.case ?? '';
  switch (a) {
    case 'lang': lang = lang === 'ar' ? 'en' : 'ar'; localStorage.setItem('hs-lang', lang); notice = null; return render('main');
    case 'adv': return attempt('global', () => engine.advanceHours(Number(el.dataset.id)), 'main', '');
    case 'reset':
      if (confirm(t('clock.confirmReset'))) {
        engine = buildDemoEngine(); localStorage.removeItem(KEY); localStorage.removeItem(KEY + '-cfg'); save(); caseSel = null; notice = null; render('main');
      }
      return;
    case 'tab': tab = el.dataset.id as any; caseSel = null; return render();
    case 'select': caseSel = el.dataset.id!; notice = null; return render('detail');
    case 'ack': return attempt('action', () => engine.acknowledge(cid), 'detail');
    case 'reassess': return attempt('action', () => engine.startReassessment(cid), 'detail');
    case 'clearov': return attempt('action', () => engine.clearOverride(cid), 'detail');
    case 'timer-start': timer = { caseId: cid, start: Date.now() }; return render('detail');
    case 'timer-stop': {
      if (!timer) return;
      const tm = timer; timer = null;
      const secs = (Date.now() - tm.start) / 1000;
      return attempt('timer', () => engine.recordReview(tm.caseId, secs), 'detail', t('d.timer.saved', { s: num(secs) }));
    }
    case 'settings-reset': engine.cfg = { ...DEFAULT_CONFIG }; localStorage.removeItem(KEY + '-cfg'); return attempt('settings', () => engine.sync(), 'main');
  }
}

function onChange(ev: Event) {
  const el = ev.target as HTMLSelectElement;
  const k = el.dataset.change;
  if (k === 'patient') { patientId = el.value; notice = null; render('main'); }
  else if (k === 'scenario') { scenarioId = el.value; render('main'); }
  else if (k === 'tpl') { const ta = document.getElementById('a-msg') as HTMLTextAreaElement | null; if (ta) ta.value = t('tpl.' + el.value); }
}

function route() {
  const v = location.hash.replace('#/', '') as View;
  view = ['patient', 'clinician', 'reviewer', 'inspector'].includes(v) ? v : 'patient';
  notice = null;
  render();
}

export function start() {
  document.addEventListener('submit', onSubmit);
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  window.addEventListener('hashchange', route);
  route();
}
