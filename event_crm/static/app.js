'use strict';

const $ = (id) => document.getElementById(id);
const state = {data: null, audience: '', search: '', owner: '', attendance: '', answers: new Map(), busy: false, pending: 0, editRevision: 0, refreshAfterEdit: false, receivedAt: 0, refreshError: false};
const statuses = [['new', 'New'], ['assigned', 'Assigned'], ['contacted', 'Contacted'], ['follow_up', 'Follow up'], ['done', 'Done']];
let toastTimer;

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = String(text);
  return el;
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, {credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal});
    let body;
    try { body = await response.json(); } catch { throw new Error('The server returned an unreadable response.'); }
    if (!response.ok) {
      const error = new Error(body.error || 'Request failed.');
      error.status = response.status;
      throw error;
    }
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The server did not respond in time.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function post(path, body, csrf) {
  const headers = {'Content-Type': 'application/json'};
  if (csrf) headers['X-CSRF-Token'] = csrf;
  return request(path, {method: 'POST', headers, body: JSON.stringify(body)});
}

function signedOut() {
  state.data = null;
  state.editRevision += 1;
  state.refreshError = false;
  state.audience = ''; state.search = ''; state.owner = ''; state.attendance = ''; state.answers.clear();
  $('dashboard-view').hidden = true;
  $('login-view').hidden = false;
  for (const id of ['guest-list', 'audience-tabs', 'question-filters']) $(id).replaceChildren();
  $('search').value = ''; $('attendance-filter').value = '';
  $('owner-filter').replaceChildren(new Option('Everyone', ''), new Option('Unassigned', '__unassigned'));
  $('event-name').textContent = 'Event';
  $('event-meta').textContent = ''; $('access-label').textContent = ''; $('updated-at').textContent = '';
  for (const id of ['metric-matches', 'metric-checked', 'metric-open']) $(id).textContent = '0';
  document.title = 'Event CRM · Team desk';
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').className = `toast${error ? ' error-toast' : ''}`;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
}

function dateLabel(value, options) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, options).format(date) : 'Time unavailable';
}

function updateLiveState() {
  if (!state.data) return;
  const {event, runtime, captured_at} = state.data;
  const now = Date.parse(runtime.checked_at) + performance.now() - state.receivedAt;
  const captured = Date.parse(captured_at);
  const stale = runtime.stale || !Number.isFinite(captured) || now - captured > runtime.max_age_seconds * 1000;
  const ended = runtime.ended || now > Date.parse(event.ends_at) + runtime.grace_seconds * 1000;
  const pill = $('live-pill');
  pill.textContent = ended ? 'Window ended' : state.refreshError ? 'Refresh unavailable' : stale ? 'Data is stale' : 'Snapshot current';
  pill.className = `pill${ended ? ' ended' : stale || state.refreshError ? ' stale' : ''}`;
  $('updated-at').textContent = captured_at ? `Captured ${dateLabel(captured_at, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})}` : 'No snapshot yet';
  $('event-meta').textContent = `${dateLabel(event.starts_at, {month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit'})} · ${String(event.provider || 'event').toUpperCase()}`;
}

function selectedAudience() {
  return state.data.audiences.find((audience) => audience.id === state.audience) || state.data.audiences[0];
}

function syncFilters() {
  const data = state.data;
  if (!data.audiences.some((audience) => audience.id === state.audience)) state.audience = data.audiences[0]?.id || '';
  const tabs = data.audiences.map((audience) => {
    const tab = element('button', 'tab', audience.label);
    tab.type = 'button'; tab.role = 'tab'; tab.dataset.audience = audience.id;
    tab.setAttribute('aria-selected', String(audience.id === state.audience));
    tab.append(element('span', 'tab-count', audience.records.length));
    return tab;
  });
  $('audience-tabs').replaceChildren(...tabs);
  const owner = $('owner-filter');
  owner.replaceChildren(new Option('Everyone', ''), new Option('Unassigned', '__unassigned'), ...data.team.map((member) => new Option(member.label, member.id)));
  if (state.owner && ![...owner.options].some((option) => option.value === state.owner)) state.owner = '';
  owner.value = state.owner;
  renderQuestionFilters();
}

function renderQuestionFilters() {
  const audience = selectedAudience();
  const rows = [];
  const available = new Set();
  for (const question of state.data.questions) {
    const values = [...new Set((audience?.records || []).map((guest) => guest.answers?.[question.id]).filter((answer) => typeof answer === 'string' && answer.trim()))].sort((a, b) => a.localeCompare(b));
    if (!values.length) continue;
    available.add(question.id);
    if (state.answers.has(question.id) && !values.includes(state.answers.get(question.id))) state.answers.delete(question.id);
    const row = element('div', 'question-row');
    row.append(element('span', 'question-label', question.label));
    for (const value of values) {
      const chip = element('button', 'chip', value);
      chip.type = 'button'; chip.dataset.question = question.id; chip.dataset.answer = value;
      chip.setAttribute('aria-pressed', String(state.answers.get(question.id) === value));
      row.append(chip);
    }
    rows.push(row);
  }
  for (const question of state.answers.keys()) if (!available.has(question)) state.answers.delete(question);
  $('question-filters').replaceChildren(...rows);
}

function attendanceRank(guest) { return guest.checked_in === true ? 0 : 1; }
function rank(audience, a, b) {
  const priority = Number(b.priority || 0) - Number(a.priority || 0);
  const score = Number(b.score || 0) - Number(a.score || 0);
  const attendance = attendanceRank(a) - attendanceRank(b);
  return priority || (audience.ranking === 'attendance_first' ? attendance || score : score || attendance) || String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id));
}

function safeHTTPS(value, linkedin = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (linkedin && !(url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com'))) return null;
    return url.href;
  } catch { return null; }
}

function guestCard(guest, previousPhoto) {
  const card = element('article', 'guest-card'); card.dataset.id = guest.id;
  const main = element('div', 'card-main');
  const top = element('div', 'card-top');
  const initials = String(guest.name || '?').trim().split(/\s+/u).slice(0, 2).map((word) => [...word][0] || '').join('').toUpperCase();
  const avatar = element('div', 'avatar', initials);
  const photo = /^\/api\/photos\/[A-Za-z0-9_-]{24}\/[a-f0-9]{64}$/.test(guest.photo_url || '') ? guest.photo_url : null;
  if (photo) {
    card.dataset.photoUrl = photo;
    const reusable = previousPhoto?.url === photo ? previousPhoto : null;
    card.dataset.photo = reusable?.state || 'pending';
    const image = reusable?.image || element('img');
    if (!reusable) {
      image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      image.addEventListener('load', () => {
        const currentCard = image.closest('.guest-card');
        if (currentCard) currentCard.dataset.photo = image.naturalWidth > 0 ? 'loaded' : 'failed_render';
        updatePhotoSummary();
      }, {once: true});
      image.addEventListener('error', () => {
        const currentCard = image.closest('.guest-card');
        if (currentCard) currentCard.dataset.photo = 'failed_render';
        if (image.parentElement) image.parentElement.title = 'Photo could not load';
        image.remove(); updatePhotoSummary();
      }, {once: true});
      image.src = photo;
    }
    avatar.append(image);
  }
  top.append(avatar, element('span', `attendance-badge${guest.checked_in === true ? ' checked' : ''}`, guest.checked_in === true ? '● Checked in' : guest.checked_in === false ? 'No check-in recorded' : 'Attendance unknown'));
  main.append(top, element('h3', '', guest.name || 'Unnamed guest'), element('p', 'job-title', guest.title || 'Title not provided'), element('p', 'company', guest.company || 'Company not provided'));
  const context = element('div', 'context-row');
  const score = element('div'); score.append(element('span', 'score-value', guest.score ?? 0), element('span', 'score-label', 'match score'));
  context.append(score, element('span', 'priority', `Priority ${guest.priority ?? 0}`)); main.append(context);
  const reasons = element('ul', 'reasons');
  for (const reason of guest.reasons || []) {
    const text = typeof reason === 'string' ? reason : `${reason.reason} (${Number(reason.points) >= 0 ? '+' : ''}${reason.points})`;
    reasons.append(element('li', '', text));
  }
  if (!reasons.childNodes.length) reasons.append(element('li', '', 'No positive rule evidence available'));
  main.append(reasons);
  if (guest.missing_fields?.length) main.append(element('p', 'missing', `Missing context: ${guest.missing_fields.join(', ')}`));
  const answers = state.data.questions.filter((question) => typeof guest.answers?.[question.id] === 'string' && guest.answers[question.id].trim());
  if (answers.length) {
    const details = element('details', 'answers'); details.append(element('summary', '', `Signup context · ${answers.length}`));
    for (const question of answers) {
      const line = element('p', 'answer-line'); line.append(element('strong', '', question.label), document.createTextNode(guest.answers[question.id])); details.append(line);
    }
    main.append(details);
  }
  const linkedin = safeHTTPS(guest.linkedin_url, true);
  if (linkedin) {
    const link = element('a', 'linkedin', 'LinkedIn profile ↗'); link.href = linkedin; link.target = '_blank'; link.rel = 'noopener noreferrer'; main.append(link);
  }
  const controls = element('div', 'card-actions');
  for (const [field, label] of [['owner_id', 'Team owner'], ['status', 'Conversation']]) {
    const wrapper = element('label', '', label);
    if (state.data.runtime.access === 'team') {
      const select = element('select'); select.dataset.field = field; select.setAttribute('aria-label', `${label} for ${guest.name}`);
      const options = field === 'owner_id' ? [['', 'Unassigned'], ...state.data.team.map((member) => [member.id, member.label])] : statuses;
      select.append(...options.map(([value, text]) => new Option(text, value)));
      select.value = guest[field] || (field === 'status' ? 'new' : ''); wrapper.append(select);
    } else {
      const value = field === 'owner_id' ? state.data.team.find((member) => member.id === guest.owner_id)?.label || 'Unassigned' : statuses.find(([value]) => value === guest.status)?.[1] || 'New';
      wrapper.append(element('span', 'readonly-value', value));
    }
    controls.append(wrapper);
  }
  card.append(main, controls);
  return card;
}

function updatePhotoSummary() {
  if (!state.data) return;
  const unique = new Map(state.data.audiences.flatMap(a => a.records).map(g => [g.id, g]));
  const stored = [...unique.values()].filter(g => /^\/api\/photos\//.test(g.photo_url || '')).length;
  const cards = [...$('guest-list').children];
  const loaded = cards.filter(c => c.dataset.photo === 'loaded').length;
  const failed = cards.filter(c => c.dataset.photo === 'failed_render').length;
  const expected = cards.filter(c => c.dataset.photo).length;
  $('photo-summary').textContent = `Photos stored: ${stored}/${unique.size} people · Visible loaded: ${loaded}/${expected} · ${expected - loaded - failed} pending${failed ? ` · ${failed} failed to load` : ''}`;
}

function renderGuests() {
  const audience = selectedAudience();
  const records = audience?.records || [];
  $('metric-matches').textContent = records.length;
  $('metric-checked').textContent = records.filter((guest) => guest.checked_in === true).length;
  $('metric-open').textContent = records.filter((guest) => !guest.owner_id).length;
  const search = state.search.trim().toLocaleLowerCase();
  const filtered = records.filter((guest) => {
    if (search && ![guest.name, guest.company, guest.title].join(' ').toLocaleLowerCase().includes(search)) return false;
    if (state.owner === '__unassigned' ? Boolean(guest.owner_id) : state.owner && guest.owner_id !== state.owner) return false;
    if (state.attendance === 'checked' && guest.checked_in !== true) return false;
    if (state.attendance === 'not_recorded' && guest.checked_in !== false) return false;
    if (state.attendance === 'unknown' && guest.checked_in != null) return false;
    for (const [question, answer] of state.answers) if (guest.answers?.[question] !== answer) return false;
    return true;
  }).sort((a, b) => rank(audience, a, b));
  const openDetails = new Set([...$('guest-list').querySelectorAll('details[open]')].map((details) => details.closest('.guest-card').dataset.id));
  const previousPhotos = new Map([...$('guest-list').children].flatMap(card => {
    const image = card.querySelector('img');
    return image ? [[card.dataset.id, {image, url: card.dataset.photoUrl, state: card.dataset.photo}]] : [];
  }));
  const cards = filtered.map(guest => guestCard(guest, previousPhotos.get(guest.id)));
  for (const card of cards) if (openDetails.has(card.dataset.id)) { const details = card.querySelector('details'); if (details) details.open = true; }
  $('guest-list').replaceChildren(...cards);
  updatePhotoSummary();
  $('result-count').textContent = `${filtered.length} ${filtered.length === 1 ? 'person' : 'people'}${filtered.length !== records.length ? ` of ${records.length}` : ''}`;
  $('ranking-note').textContent = audience?.ranking === 'attendance_first' ? 'Priority → check-in → match score' : 'Priority → match score → check-in';
  $('empty-state').hidden = filtered.length !== 0;
}

function render() {
  $('login-view').hidden = true; $('dashboard-view').hidden = false;
  $('event-name').textContent = state.data.event.name;
  document.title = `${state.data.event.name} · Event CRM`;
  const actor = state.data.team.find((member) => member.id === state.data.runtime.actor);
  $('access-label').textContent = actor ? `${actor.label} · Team access` : 'Read-only access';
  updateLiveState(); syncFilters(); renderGuests();
}

async function refresh() {
  if (state.busy) { state.refreshAfterEdit = true; return; }
  if (state.pending || document.hidden) return;
  // Keep an active owner/status selection intact while the user operates it.
  if (document.activeElement?.closest('.card-actions')) { state.refreshAfterEdit = true; return; }
  state.busy = true;
  const editRevision = state.editRevision;
  try {
    const data = await request('/api/dashboard');
    if (editRevision !== state.editRevision || state.pending) return;
    if (!data?.event || !data.runtime || !Array.isArray(data.audiences) || !Array.isArray(data.team) || !Array.isArray(data.questions) || data.audiences.some((audience) => !Array.isArray(audience.records))) {
      throw new Error('The server returned an incomplete dashboard.');
    }
    state.data = data;
    state.receivedAt = performance.now(); state.refreshError = false;
    $('connection-error').hidden = true;
    render();
  } catch (error) {
    if (editRevision !== state.editRevision) return;
    if (error.status === 401) signedOut();
    else if (state.data) {
      state.refreshError = true;
      $('connection-error').textContent = `${error.message} Displaying the last successful snapshot.`;
      $('connection-error').hidden = false;
      updateLiveState();
    } else $('login-error').textContent = error.message;
  } finally {
    state.busy = false;
    if (state.refreshAfterEdit && !document.activeElement?.closest('.card-actions')) {
      state.refreshAfterEdit = false;
      refresh();
    }
  }
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button'); button.disabled = true; $('login-error').textContent = '';
  const token = $('access-token').value; $('access-token').value = '';
  try { await post('/api/login', {token}); state.editRevision += 1; await refresh(); }
  catch (error) { $('login-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('logout').addEventListener('click', async () => {
  try { await post('/api/logout', {}, state.data.runtime.csrf); signedOut(); }
  catch (error) { if (error.status === 401) signedOut(); else toast(error.message, true); }
});
$('audience-tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-audience]'); if (!tab) return;
  state.audience = tab.dataset.audience; syncFilters(); renderGuests();
});
$('audience-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const ids = state.data.audiences.map((audience) => audience.id);
  const current = ids.indexOf(state.audience);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
  event.preventDefault();
  state.audience = ids[next]; syncFilters(); renderGuests();
  [...$('audience-tabs').children].find((tab) => tab.dataset.audience === state.audience)?.focus();
});
$('search').addEventListener('input', (event) => { state.search = event.target.value; renderGuests(); });
$('owner-filter').addEventListener('change', (event) => { state.owner = event.target.value; renderGuests(); });
$('attendance-filter').addEventListener('change', (event) => { state.attendance = event.target.value; renderGuests(); });
$('question-filters').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-question]'); if (!chip) return;
  if (state.answers.get(chip.dataset.question) === chip.dataset.answer) state.answers.delete(chip.dataset.question);
  else state.answers.set(chip.dataset.question, chip.dataset.answer);
  renderQuestionFilters(); renderGuests();
});
$('clear-filters').addEventListener('click', () => {
  state.search = ''; state.owner = ''; state.attendance = ''; state.answers.clear();
  $('search').value = ''; $('attendance-filter').value = ''; syncFilters(); renderGuests();
});
$('guest-list').addEventListener('change', async (event) => {
  const control = event.target.closest('select[data-field]'); if (!control) return;
  const card = control.closest('.guest-card');
  const guest = selectedAudience().records.find((record) => record.id === card.dataset.id);
  const body = {id: guest.id, owner_id: guest.owner_id || null, status: guest.status || 'new', expected_owner_id: guest.owner_id || null, expected_status: guest.status || 'new'};
  body[control.dataset.field] = control.value || null;
  state.editRevision += 1; state.pending += 1; card.querySelectorAll('select').forEach((select) => { select.disabled = true; });
  try {
    await post('/api/assignment', body, state.data.runtime.csrf);
    if (!state.data) return;
    for (const audience of state.data.audiences) for (const record of audience.records) if (record.id === guest.id) { record.owner_id = body.owner_id; record.status = body.status; }
    toast('Team assignment saved');
  } catch (error) {
    if (error.status === 401) signedOut();
    else {
      toast(error.message, true);
      if (error.status === 409) state.refreshAfterEdit = true;
    }
  }
  finally {
    state.pending -= 1;
    if (state.data && !state.pending) {
      renderGuests();
      if (state.refreshAfterEdit) { state.refreshAfterEdit = false; refresh(); }
    }
  }
});
$('guest-list').addEventListener('focusout', () => {
  setTimeout(() => { if (state.refreshAfterEdit && !document.activeElement?.closest('.card-actions')) { state.refreshAfterEdit = false; refresh(); } }, 0);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(refresh, 15000);
setInterval(updateLiveState, 5000);
refresh();
