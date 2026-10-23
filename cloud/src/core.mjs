// Pure domain functions. No provider, credential, storage or browser access.
export class Fault extends Error {
  constructor(code, status = 400, retryAfter = 0) {
    super(code); this.code = code; this.status = status; this.retryAfter = retryAfter;
  }
}
export function requireThat(value, code = 'invalid_input', status = 400) {
  if (!value) throw new Fault(code, status);
}
export function text(value, max = 500) {
  requireThat(typeof value === 'string' && value.length <= max, 'invalid_text');
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}
export function redact(value, max = 500) {
  return text(value, max).replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[contact removed]')
    .replace(/(?:\+?\d[\s().-]*){10,15}/g, '[contact removed]');
}
export function stamp(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(value)
    && Number.isFinite(Date.parse(value)), 'invalid_timestamp');
  const dateOnly=new Date(value.slice(0,10)+'T00:00:00Z');
  requireThat(Number.isFinite(dateOnly.getTime())&&dateOnly.toISOString().slice(0,10)===value.slice(0,10),'invalid_timestamp');
  return Date.parse(value);
}
export const safeTypes = new Set(['text', 'select', 'company', 'linkedin', 'url', 'agree-check']);
const sensitive = /email|e-mail|phone|contact|address|immigra|visa|citizen|nationality|passport|race|ethnic|religio|gender|sexual|disabil|medical|health|diagnos|pregnan|birth|diet|allerg|ssn|social security|salary|household income/i;
export function professionalQuestion(q) {
  return q && safeTypes.has(q.question_type) && typeof q.label === 'string' && !sensitive.test(q.label);
}
export function questions(raw) {
  requireThat(Array.isArray(raw) && raw.length <= 100, 'unsupported_questions');
  const seen = new Set();
  return raw.filter(professionalQuestion).map(q => {
    const id = text(q.id, 100); requireThat(id && !seen.has(id), 'duplicate_question'); seen.add(id);
    const options = q.options || []; requireThat(Array.isArray(options) && options.length <= 250, 'invalid_options');
    return { id, label: redact(q.label, 300), type: q.question_type,
      multiple: q.multiple === true, options: options.map(v => redact(v, 300)) };
  });
}
export function eventUrl(value) {
  let u; try { u = new URL(value); } catch { throw new Fault('invalid_event_url'); }
  requireThat(u.protocol === 'https:' && ['luma.com', 'lu.ma'].includes(u.hostname)
    && !u.port && !u.username && !u.password && /^\/[A-Za-z0-9_-]+\/?$/.test(u.pathname), 'invalid_event_url');
  return `https://luma.com/${u.pathname.split('/')[1]}`;
}
export function linkedin(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || !/^(?:[a-z]{2,3}\.)?linkedin\.com$/.test(u.hostname)
      || u.username || u.password || u.port) return null;
    const m = u.pathname.match(/^\/in\/([a-zA-Z0-9_%\-]+)\/?$/);
    return m ? `https://www.linkedin.com/in/${m[1]}` : null;
  } catch { return null; }
}
export function publicUrl(value) {
  let u; try { u = new URL(value); } catch { throw new Fault('invalid_website'); }
  // Fixed public HTTPS names only. Every redirect requires a new validated fetch.
  requireThat(u.protocol === 'https:' && !u.username && !u.password && !u.port && u.href.length <= 2000
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(u.hostname)
    && !/(^|\.)(localhost|local|internal|test|invalid|example|onion|arpa)$/.test(u.hostname)
    && !/(^|\.)(nip\.io|sslip\.io|localtest\.me)$/.test(u.hostname), 'invalid_website');
  u.hash = ''; return u.href;
}
export const statuses = ['approved', 'pending_approval', 'waitlist', 'invited', 'declined'];
export function counts(detail) {
  const result = {};
  for (const status of [...statuses, 'checked_in']) {
    const n = detail.guest_counts?.[status]?.guests;
    requireThat(Number.isSafeInteger(n) && n >= 0, 'missing_source_counts', 502); result[status] = n;
  }
  requireThat(statuses.reduce((s, k) => s + result[k], 0) <= 500, 'event_too_large', 422);
  return result;
}
export function eventDetail(d, calendarId, expectedUrl) {
  requireThat(d && d.access === 'manage' && d.calendar_id === calendarId && /^evt-[\w-]+$/.test(d.id)
    && eventUrl(d.url) === expectedUrl, 'event_access_mismatch', 403);
  requireThat(Array.isArray(d.hosts), 'missing_hosts', 502);
  return { id: d.id, calendarId, url: expectedUrl, name: redact(d.name, 300),
    start: stamp(d.start_at), end: stamp(d.end_at), counts: counts(d), questions: questions(d.registration_questions),
    hosts: d.hosts.map(h => ({ userId: text(h.id, 100), name: redact(h.name || 'Host', 150) })) };
}
export function checkIn(guest) {
  const ts = guest.event_tickets;
  if (!Array.isArray(ts) || ts.length !== 1 || !Object.hasOwn(ts[0], 'checked_in_at')) return null;
  if (ts[0].checked_in_at === null) return false;
  try { stamp(ts[0].checked_in_at); return true; } catch { return null; }
}
export function normalizeGuest(raw, selected, fields = {}) {
  const id = text(raw.id, 100), userId = text(raw.user_id, 100);
  requireThat(id && userId && statuses.includes(raw.approval_status), 'unsupported_guest', 502);
  const answers = Object.create(null), omittedAnswers = [], source = raw.registration_answers || [];
  const mapped = new Set(Object.values(fields).filter(Boolean));
  requireThat(Array.isArray(source) && source.length <= 100, 'invalid_answers', 502);
  for (const q of selected) {
    const matches = source.filter(a => a.question_id === q.id);
    requireThat(matches.length <= 1, 'duplicate_answer', 502);
    if (!matches.length) { answers[q.id] = ''; continue; }
    const a = matches[0];
    requireThat(a.question_type === q.type && redact(a.label, 300) === q.label, 'question_changed', 409);
    // Oversized optional answers cannot stop attendance for the entire event.
    // Never score an excerpt or silently shorten an identity/consent value.
    const tooLong = typeof a.value === 'string' && a.value.length > 500
      || Array.isArray(a.value) && (a.value.length > 20 || a.value.some(v => typeof v === 'string' && v.length > 300));
    if (tooLong && !mapped.has(q.id)) { answers[q.id] = ''; omittedAnswers.push(q.id); continue; }
    if (a.value == null) answers[q.id] = '';
    else if (q.type === 'company') {
      requireThat(typeof a.value === 'object' && !Array.isArray(a.value), 'invalid_answer', 502);
      answers[q.id] = { company: redact(a.value.company || '', 150), title: redact(a.value.job_title || '', 150) };
    } else if (q.multiple) {
      requireThat(Array.isArray(a.value) && a.value.length <= 20, 'invalid_answer', 502);
      answers[q.id] = a.value.map(v => redact(v, 300));
    } else if (q.type === 'agree-check') {
      requireThat(typeof a.value === 'boolean', 'invalid_answer', 502); answers[q.id] = String(a.value);
    } else answers[q.id] = redact(a.value, 500);
  }
  const field = k => {
    const v = answers[fields[k]];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v[k] || '';
    return typeof v === 'string' ? v : '';
  };
  const person = { id, userId, name: redact(raw.user_name || [raw.user_first_name, raw.user_last_name].filter(Boolean).join(' '), 150),
    company: field('company'), title: field('title'), linkedin: linkedin(field('linkedin')),
    answers, omittedAnswers, status: raw.approval_status, checkedIn: checkIn(raw) };
  const bytes = () => new TextEncoder().encode(JSON.stringify(person)).length;
  for (const id of Object.keys(answers).filter(id => !mapped.has(id)).sort((a,b) => JSON.stringify(answers[b]).length-JSON.stringify(answers[a]).length)) {
    if (bytes() <= 3000) break;
    if (!omittedAnswers.includes(id)) { answers[id] = ''; omittedAnswers.push(id); }
  }
  requireThat(bytes() <= 3000, 'identity_size_limit', 422);
  return person;
}
export function validateScan(before, after, rows, frozen = null) {
  requireThat(before.id === after.id && before.calendarId === after.calendarId && before.url === after.url
    && JSON.stringify(before.questions) === JSON.stringify(after.questions)
    && JSON.stringify(before.hosts) === JSON.stringify(after.hosts)
    && JSON.stringify(before.counts) === JSON.stringify(after.counts), 'source_changed', 409);
  const ids = new Set(), users = new Set(), tally = Object.fromEntries(statuses.map(s => [s, 0]));
  for (const p of rows) {
    requireThat(!ids.has(p.id) && !users.has(p.userId), 'duplicate_guest', 502);
    ids.add(p.id); users.add(p.userId); tally[p.status]++;
  }
  requireThat(statuses.every(s => tally[s] === after.counts[s]), 'incomplete_source', 502);
  const hosts = new Set(after.hosts.map(h => h.userId));
  const guests = rows.filter(p => !hosts.has(p.userId));
  if (frozen) {
    const lookup = new Map(guests.map(p => [p.id, p]));
    for (const old of frozen) {
      const fresh = lookup.get(old.id);
      requireThat(fresh && fresh.userId === old.userId && fresh.name === old.name
        && fresh.company === old.company && fresh.title === old.title && fresh.linkedin === old.linkedin,
      'cohort_review_required', 409);
      // A declined/pending registration may never have had a ticket. Keeping its
      // explicit unknown state does not erase evidence or block other guests.
      // Losing a previously usable check-in signal still rejects the whole update.
      requireThat(typeof fresh.checkedIn === 'boolean'||fresh.checkedIn===null&&old.checkedIn===null, 'attendance_unknown', 409);
    }
    // New people are available for explicit review, never added to a frozen cohort implicitly.
    return { guests, extra: guests.filter(p => !frozen.some(old => old.id === p.id)) };
  }
  return { guests, extra: [] };
}
export function rank(people, rules = [], attendanceFirst = true) {
  const scored = people.map(p => {
    let score = 0, group = 0; const reasons = [];
    for (const r of rules) {
      const v = r.field === 'company' ? p.company : r.field === 'title' ? p.title : p.answers?.[r.field];
      const values = Array.isArray(v) ? v : [v];
      const matches = values.some(x => typeof x === 'string' && x.length &&
        (r.op === 'equals' ? x.toLocaleLowerCase() === r.value.toLocaleLowerCase()
          : r.op === 'number_gte' ? /^\d+(?:\.\d+)?$/.test(x) && Number(x) >= Number(r.value) : false));
      if (matches) { score += r.points; group = Math.max(group, r.group || 0); reasons.push(r.reason); }
    }
    return { ...p, score, group, reasons };
  });
  return scored.sort((a,b) => a.group - b.group || (attendanceFirst
    ? Number(b.checkedIn === true) - Number(a.checkedIn === true) || b.score - a.score
    : b.score - a.score || Number(b.checkedIn === true) - Number(a.checkedIn === true))
    || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
