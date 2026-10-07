// Pure validation and a framework-neutral, read-only visible-table reader.
// The browser facade is supplied by the operator's authorized browser tool.
const unsafeLabel = /\b(?:e[\s-]?mail|phone|mobile|telephone|contact|immigration|visa|citizenship|passport|nationality|religion|medical|disability|gender|sexual|race|ethnicity|birth|address|ssn|social security)\b/i;
const email = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const phone = /(?<!\w)(?:\+\d[\d ()-]{7,}\d|\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4})(?!\w)/g;

export function cleanText(value) {
  if (typeof value !== 'string' || value.length > 10000) throw new Error('Invalid professional text');
  const text = value.trim();
  return text === 'No response' ? '' : text.replace(email, '[redacted]').replace(phone, '[redacted]');
}

export function checkInLabel(text, iconHref = '') {
  if (text === 'Check in') return false;
  if (text === 'Checked in') return true;
  // Positive, reviewed icon from the Check in column, never absence of a label.
  if (text === '' && iconHref.endsWith('#icon-check-filled')) return true;
  throw new Error('Unrecognized check-in control; inspect the host table');
}

export function approvalLabel(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized === '🤘 Approved') return 'approved';
  if (normalized === "😢 Can't Go") return 'cant_go';
  throw new Error('Unrecognized RSVP control; inspect the host table');
}

export function validateConfig(config) {
  if (config?.event?.provider !== 'partiful' || !config.event.id) throw new Error('Partiful event binding required');
  if (config.event.calendar_id != null && config.event.calendar_id !== '') throw new Error('Partiful has no calendar ID');
  const url = new URL(config.event.url);
  if (url.protocol !== 'https:' || url.hostname !== 'partiful.com' || url.username || url.password ||
      url.search || url.hash || url.port || url.pathname !== '/e/' + config.event.id) {
    throw new Error('An exact canonical Partiful event URL and ID are required');
  }
  for (const key of ['host_confirmed', 'professional_fields_confirmed', 'team_sharing_confirmed']) {
    if (config.authorization?.[key] !== true) throw new Error('Host/professional field/team authorization required');
  }
  if (!config.fields || Array.isArray(config.fields) || Object.keys(config.fields).some(key => !['company', 'linkedin', 'title'].includes(key)) ||
      !Array.isArray(config.questions)) throw new Error('Explicit professional field mappings required');
  const ids = new Set(), labels = new Set();
  for (const question of config.questions) {
    if (!/^[A-Za-z0-9_-]+$/.test(question.id) || unsafeLabel.test(question.id) ||
        ids.has(question.id) || labels.has(question.label)) throw new Error('Unsafe or duplicate question mapping');
    ids.add(question.id);
    labels.add(question.label);
  }
  for (const label of [...Object.values(config.fields), ...labels]) {
    if (typeof label !== 'string' || !label.trim() || unsafeLabel.test(label)) {
      throw new Error('Contact or sensitive questions cannot be mapped as professional data');
    }
  }
  return config;
}

export function partifulColumns(headers, config) {
  validateConfig(config);
  const controls = {guest: 'Guest', status: 'Status', check_in: 'Check in', plus_ones: 'Plus Ones',
    ...config.partiful?.columns};
  if (Object.keys(controls).sort().join(',') !== 'check_in,guest,plus_ones,status') throw new Error('Unknown control column');
  if (Object.values(controls).some(label => typeof label !== 'string' || !label.trim() || unsafeLabel.test(label))) {
    throw new Error('Control columns cannot be contact or sensitive questions');
  }
  const index = label => {
    const indexes = headers.flatMap((header, i) => header === label ? [i] : []);
    if (indexes.length !== 1) throw new Error('An exact mapped header is missing or ambiguous');
    return indexes[0];
  };
  return {count: headers.length, guest: index(controls.guest), status: index(controls.status),
    check: index(controls.check_in), plus: index(controls.plus_ones),
    company: config.fields.company ? index(config.fields.company) : null,
    title: config.fields.title ? index(config.fields.title) : null,
    linkedin: config.fields.linkedin ? index(config.fields.linkedin) : null,
    answers: config.questions.map(q => ({id: q.id, index: index(q.label)}))};
}

// Serialized into a DOM evaluator: no module closures, network, hidden state,
// contact-cell access, provider IDs, or image downloading.
export function readVisibleRows(elements, {columns}) {
  return elements.flatMap(row => {
    const cells = row.querySelectorAll('td');
    if (!cells.length) return [];
    if (cells.length !== columns.count) throw new Error('Guest table row schema changed');
    const rowTop = /^translateY\((\d+(?:\.\d+)?)px\)$/.exec(row.style?.transform || '');
    const rowHeight = /^(\d+(?:\.\d+)?)px$/.exec(row.style?.height || '');
    const guestCell = cells[columns.guest];
    return [{
      name: guestCell.querySelector('img')?.alt || guestCell.innerText.split('\n').at(-1),
      company: columns.company === null ? '' : cells[columns.company].innerText,
      title: columns.title === null ? '' : cells[columns.title].innerText,
      linkedin_url: columns.linkedin === null ? '' : cells[columns.linkedin].innerText,
      answers: Object.fromEntries(columns.answers.map(q => [q.id, cells[q.index].innerText])),
      approval_label: cells[columns.status].innerText,
      check_label: cells[columns.check].innerText.trim(),
      check_icon: cells[columns.check].querySelector('button svg use')?.getAttribute('href') || '',
      _row_top: rowTop ? Number(rowTop[1]) : null,
      _row_height: rowHeight ? Number(rowHeight[1]) : null,
    }];
  });
}

export function readCountButtons(elements, labels) {
  const counts = {};
  for (const [view, label] of Object.entries(labels)) {
    const matches = elements.map(el => el.innerText.replace(/\s+/g, ' ').trim()).filter(text => {
      const space = text.indexOf(' ');
      return space > 0 && /^\d+$/.test(text.slice(0, space)) && text.slice(space + 1) === label;
    });
    if (matches.length !== 1) throw new Error('Exact guest-view count badge is missing or ambiguous');
    const count = Number(matches[0].split(' ')[0]);
    if (!Number.isSafeInteger(count)) throw new Error('Invalid guest count');
    counts[view] = count;
  }
  return counts;
}

export function measureTable(element) {
  const parent = element.parentElement, rect = parent.getBoundingClientRect();
  return {top: parent.scrollTop, height: parent.scrollHeight, view: parent.clientHeight,
    headerHeight: element.querySelector('thead')?.getBoundingClientRect().height ?? null,
    point: [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)]};
}

export function validatedNamedRowCount(start, end, positions, uniqueRows) {
  if (!start || !end || start.height !== end.height || start.headerHeight !== end.headerHeight ||
      !Number.isFinite(start.headerHeight) || start.headerHeight <= 0) return null;
  if (positions.length === 0) return uniqueRows === 0 && end.height === Math.round(end.headerHeight) ? 0 : null;
  const height = positions[0].height;
  if (!Number.isFinite(height) || height <= 0 || positions.some(row => row.height !== height ||
      !Number.isFinite(row.top) || row.top < 0 || !Number.isInteger(row.top / height))) return null;
  const indexes = new Set(positions.map(row => row.top / height));
  const count = Math.max(...indexes) + 1;
  // Only browser integer scrollHeight rounding, never a guessed row tolerance.
  if (!Number.isInteger(count) || indexes.size !== count || uniqueRows !== count ||
      Math.round(end.headerHeight + count * height) !== end.height) return null;
  for (let i = 0; i < count; i++) if (!indexes.has(i)) return null;
  return count;
}

export async function partifulIdentity(eventUrl, name, linkedinUrl, company) {
  const data = new TextEncoder().encode(JSON.stringify([eventUrl, name, linkedinUrl, company]));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function normalizeLinkedIn(value) {
  if (typeof value !== 'string' || value.length > 10000) return '';
  const match = /^(?:https:\/\/)?(?:(?:www|[a-z]{2})\.)?linkedin\.com(?::443)?(\/in\/[A-Za-z0-9_%.-]+\/?)(?:[?#][^\x00-\x20\x7f]*)?$/i.exec(value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ''));
  return match ? 'https://www.linkedin.com' + match[1].replace(/\/$/, '') : '';
}

function normalizedRow(row, config) {
  const name = cleanText(row.name), company = cleanText(row.company), title = cleanText(row.title);
  if (!name) throw new Error('Guest display name is unavailable');
  const linkedin = normalizeLinkedIn(row.linkedin_url);
  const approvedIds = new Set(config.questions.map(question => question.id));
  if (!row.answers || Object.keys(row.answers).some(id => !approvedIds.has(id))) throw new Error('Unmapped question answer');
  return {name, company, title, linkedin_url: linkedin,
    answers: Object.fromEntries(config.questions.map(q => [q.id, cleanText(row.answers[q.id] ?? '')])),
    checked_in: checkInLabel(row.check_label, row.check_icon), approval_status: approvalLabel(row.approval_label)};
}

function validateState(state) {
  if (!state || !['top', 'height', 'view', 'headerHeight'].every(k => Number.isFinite(state[k])) ||
      state.top < 0 || state.height <= 0 || state.view <= 0 || state.headerHeight <= 0) {
    throw new Error('Unrecognized guest table geometry');
  }
  return state;
}

function boundTabUrl(actual, expected) {
  // Partiful's documented host workflow uses this UI-only focus hint. It does
  // not change the canonical event identity; no other query is accepted.
  return actual === expected || actual === expected + '?focus=guest-table';
}

async function scanView(adapter, config, columns, view, counts, maxPages) {
  await adapter.selectView(view);
  await adapter.observe();
  let state = validateState(await adapter.measure());
  for (let page = 0; state.top > 1 && page < maxPages; page++) {
    const previous = state.top;
    await adapter.scroll(state, 'up', Math.max(1, Math.ceil(state.top / state.view)));
    await adapter.observe();
    state = validateState(await adapter.measure());
    if (state.top >= previous) throw new Error('Guest table could not return to the top');
  }
  if (state.top > 1) throw new Error('Guest table did not reach the top');
  const start = state, collected = new Map(), positions = new Map(), occupied = new Map();
  const read = async () => {
    const visible = await adapter.readRows(columns), visibleKeys = new Set();
    for (const row of visible) {
      const clean = normalizedRow(row, config);
      if (clean.approval_status !== view) throw new Error('Wrong RSVP view or status changed during scan');
      const key = JSON.stringify([clean.name, clean.linkedin_url, clean.company]);
      const position = {top: row._row_top, height: row._row_height};
      if (visibleKeys.has(key)) throw new Error('Duplicate exact professional identity in the visible table');
      visibleKeys.add(key);
      const oldPosition = positions.get(key);
      if (oldPosition && (oldPosition.top !== position.top || oldPosition.height !== position.height)) {
        throw new Error('Identity appears at multiple row positions; duplicate or changing roster');
      }
      if (occupied.has(position.top) && occupied.get(position.top) !== key) throw new Error('Guest changed at a row position');
      const old = collected.get(key);
      if (old && JSON.stringify(old) !== JSON.stringify(clean)) throw new Error('Guest data changed during scan');
      positions.set(key, position); occupied.set(position.top, key); collected.set(key, clean);
    }
    state = validateState(await adapter.measure());
    if (state.height !== start.height || state.headerHeight !== start.headerHeight) throw new Error('Guest table extent changed during scan');
  };
  await read();
  for (let page = 0; state.top + state.view < state.height - 2 && page < maxPages; page++) {
    const previous = state.top;
    await adapter.scroll(state, 'down', 0.5);
    await adapter.observe();
    await read();
    if (state.top <= previous) throw new Error('Guest table scroll stopped advancing');
  }
  if (state.top + state.view < state.height - 2) throw new Error('Incomplete guest table traversal');
  // Empty views can contain an empty-state panel with a viewport-sized extent.
  const named = counts[view] === 0 && collected.size === 0 && state.height <= state.view
    ? 0 : validatedNamedRowCount(start, state, [...positions.values()], collected.size);
  if (named === null) throw new Error('Guest table does not have complete contiguous named-row geometry');
  if (JSON.stringify(await adapter.readCounts()) !== JSON.stringify(counts)) throw new Error('Guest counts changed during scan');
  if (counts[view] < named) throw new Error('Badge count is smaller than the verified named roster');
  return {guests: [...collected.values()], evidence: {badge_count: counts[view], named_count: named,
    scroll_height: state.height, header_height: state.headerHeight,
    row_height: positions.size ? [...positions.values()][0].height : null}};
}

/** adapter: url/reload/prepare/readHeaders/readCounts/selectView/readRows/
 * measure/scroll/observe. All methods may be asynchronous. No cookies or APIs. */
export async function captureAttendance(adapter, config, {maxPages = 400, onEvidence} = {}) {
  validateConfig(config);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10000) throw new Error('Invalid traversal page bound');
  const eventUrl = config.event.url;
  if (!boundTabUrl(await adapter.url(), eventUrl)) throw new Error('Wrong event tab');
  const started = new Date().toISOString();
  await adapter.reload();
  await adapter.prepare();
  if (!boundTabUrl(await adapter.url(), eventUrl)) throw new Error('Event navigation changed during reload');
  const headers = await adapter.readHeaders(), columns = partifulColumns(headers, config);
  const counts = await adapter.readCounts();
  if (Object.keys(counts).sort().join(',') !== 'approved,cant_go' ||
      Object.values(counts).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Both RSVP view counts are required');
  const guests = [], evidence = {}, seen = new Set();
  for (const view of ['approved', 'cant_go']) {
    const result = await scanView(adapter, config, columns, view, counts, maxPages);
    evidence[view] = result.evidence;
    for (const row of result.guests) {
      const sourceId = await partifulIdentity(eventUrl, row.name, row.linkedin_url, row.company);
      if (seen.has(sourceId)) throw new Error('Identity appears in multiple RSVP views');
      seen.add(sourceId); guests.push({source_id: sourceId, ...row});
    }
  }
  if (!boundTabUrl(await adapter.url(), eventUrl) || JSON.stringify(await adapter.readHeaders()) !== JSON.stringify(headers) ||
      JSON.stringify(await adapter.readCounts()) !== JSON.stringify(counts)) throw new Error('Event/table binding changed during scan');
  if (onEvidence) await onEvidence(evidence);
  return {schema_version: 1, provider: 'partiful', event_id: config.event.id, event_url: eventUrl,
    calendar_id: null, scan_started_at: started, captured_at: new Date().toISOString(), complete: true,
    source_counts: {approved: evidence.approved.named_count, cant_go: evidence.cant_go.named_count},
    source_evidence: evidence, guests};
}

function domAdapter(facade, config) {
  const p = facade.playwright;
  const labels = {approved: 'Approved', cant_go: "Can't Go", ...config.partiful?.count_labels};
  const currentLabels = ['All guests', 'Approved', "Can't Go"];
  const options = {approved: '🤘 Approved', cant_go: "😢 Can't Go"};
  return {
    url: () => facade.url(), reload: () => facade.reload(), observe: () => facade.observe(),
    prepare: async () => {
      await facade.waitVisible(p.getByRole('heading', {name: 'Manage Guests', exact: true}));
      await p.getByPlaceholder('Search for a guest', {exact: true}).fill('');
    },
    readHeaders: () => p.locator('table th').allTextContents({}),
    readCounts: () => p.locator('button').evaluateAll(readCountButtons, labels),
    selectView: async view => {
      const current = await p.locator('button').evaluateAll((elements, allowed) =>
        elements.map(el => el.innerText.trim()).filter(text => allowed.includes(text)), currentLabels);
      if (current.length !== 1) throw new Error('Open the full unfiltered Manage Guests table');
      if (current[0] === labels[view]) return;
      await p.getByRole('button', {name: current[0], exact: true}).click();
      await p.getByRole('button', {name: options[view], exact: true}).last().click();
    },
    readRows: columns => p.locator('table tr').evaluateAll(readVisibleRows, {columns}),
    measure: () => p.locator('table').evaluate(measureTable),
    scroll: (state, direction, pages) => facade.scroll(state, direction, pages),
  };
}

export function createCodexAdapter(tab, config) {
  validateConfig(config);
  return domAdapter({url: () => tab.url(), reload: () => tab.reload(), playwright: tab.playwright,
    observe: () => tab.getScreenshot({emit: false}),
    waitVisible: locator => locator.waitFor({state: 'visible', timeoutMs: 15000}),
    scroll: (state, direction, pages) => tab.scroll(state.point, direction, pages)}, config);
}

/** Accept an already authorized existing Playwright-compatible Page facade.
 * This module does not install, launch, connect to, or authenticate a browser. */
export function createPlaywrightAdapter(page, config) {
  validateConfig(config);
  return domAdapter({url: () => page.url(), reload: () => page.reload(), playwright: page,
    observe: () => page.screenshot(),
    waitVisible: locator => locator.waitFor({state: 'visible', timeout: 15000}),
    scroll: async (state, direction, pages) => {
      await page.mouse.move(...state.point);
      await page.mouse.wheel(0, state.view * pages * (direction === 'up' ? -1 : 1));
    }}, config);
}
