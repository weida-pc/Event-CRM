import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalLabel, checkInLabel, captureAttendance, partifulColumns, partifulIdentity,
  readVisibleRows, readCountButtons, validatedNamedRowCount, createCodexAdapter,
  createPlaywrightAdapter} from './partiful.mjs';

const config = () => ({event: {provider: 'partiful', id: 'synthetic', url: 'https://partiful.com/e/synthetic'},
  authorization: {host_confirmed: true, professional_fields_confirmed: true, team_sharing_confirmed: true},
  fields: {company: 'Company', title: 'Role', linkedin: 'LinkedIn'},
  questions: [{id: 'interest', label: 'Professional interests'}]});
const headers = ['', 'Guest', 'Plus Ones', 'Status', 'Check in', 'Email', 'Company', 'Role', 'LinkedIn', 'Professional interests'];
const row = (index, view = 'approved') => ({name: `Synthetic Person ${index}`, company: 'Example Organization',
  title: 'Engineer', linkedin_url: `https://www.linkedin.com/in/synthetic-${index}`,
  answers: {interest: 'Design'}, approval_label: view === 'approved' ? '🤘 Approved' : "😢 Can't Go",
  check_label: index % 2 ? 'Checked in' : 'Check in', check_icon: '', _row_top: index * 50, _row_height: 50});

function fake({approved = [row(0), row(1), row(2), row(3)], cant_go = [row(0, 'cant_go')], badges, mutate} = {}) {
  // Keep different people in each view; no real identities in tests.
  cant_go = cant_go.map(item => ({...item, name: `Other ${item.name}`}));
  let view = 'approved', top = 0, reads = 0;
  const rows = {approved, cant_go};
  const counts = badges ?? {approved: approved.length, cant_go: cant_go.length};
  const state = () => ({top, height: 30 + rows[view].length * 50, view: 100, headerHeight: 30, point: [10, 10]});
  return {url: async () => config().event.url, reload: async () => {}, prepare: async () => {},
    observe: async () => {}, readHeaders: async () => [...headers], readCounts: async () => ({...counts}),
    selectView: async value => { view = value; }, measure: async () => state(),
    readRows: async () => {
      reads++;
      const visible = rows[view].filter(item => item._row_top + item._row_height > top - 30 && item._row_top < top + 100);
      const copied = structuredClone(visible);
      if (mutate) mutate(copied, {view, reads, top});
      return copied;
    },
    scroll: async (_state, direction, pages) => {
      top = Math.max(0, Math.min(state().height - 100, top + (direction === 'up' ? -1 : 1) * pages * 100));
    }};
}

test('explicit check-in and RSVP labels only', () => {
  assert.equal(checkInLabel('Check in'), false);
  assert.equal(checkInLabel('Checked in'), true);
  assert.equal(checkInLabel('', '/sprites#icon-check-filled'), true);
  for (const label of ['', 'Going', 'false', 'Unknown']) assert.throws(() => checkInLabel(label));
  assert.equal(approvalLabel('🤘 Approved'), 'approved');
  assert.equal(approvalLabel("😢 Can't Go"), 'cant_go');
  assert.throws(() => approvalLabel('Maybe'));
});

test('exact configured headers, unsafe mapped questions, duplicate headers', () => {
  assert.equal(partifulColumns(headers, config()).company, 6);
  assert.throws(() => partifulColumns(headers.map(v => v === 'Company' ? 'company' : v), config()));
  assert.throws(() => partifulColumns([...headers, 'Company'], config()));
  for (const label of ['Email', 'Immigration status', 'Visa timeline', 'Phone number', 'Nationality']) {
    const cfg = config(); cfg.questions = [{id: 'extra', label}];
    assert.throws(() => partifulColumns(headers, cfg));
  }
});

test('DOM row extraction never reads unmapped contact or plus-one cells', () => {
  const columns = partifulColumns(headers, config());
  const cells = headers.map((_, index) => ({innerText: ['','Synthetic Person','','🤘 Approved','Check in','','Example Organization','Engineer','','Design'][index],
    querySelector: () => null}));
  for (const index of [2, 5]) Object.defineProperty(cells[index], 'innerText', {get() { throw new Error('Forbidden cell read'); }});
  const elements = [{querySelectorAll: () => cells, style: {transform: 'translateY(0px)', height: '50px'}}];
  assert.equal(readVisibleRows(elements, {columns})[0].name, 'Synthetic Person');
});

test('unmapped professional fields require no invented headers and read no cells', () => {
  const cfg = config(); cfg.fields = {}; cfg.questions = [];
  const basicHeaders = ['Guest', 'Plus Ones', 'Status', 'Check in'];
  const columns = partifulColumns(basicHeaders, cfg);
  assert.equal(columns.company, null);
  const cells = ['Synthetic Person', '', '🤘 Approved', 'Check in'].map(innerText => ({innerText, querySelector: () => null}));
  const extracted = readVisibleRows([{querySelectorAll: () => cells, style: {transform: 'translateY(0px)', height: '50px'}}], {columns});
  assert.equal(extracted[0].company, '');
  assert.equal(extracted[0].linkedin_url, '');
  assert.deepEqual(extracted[0].answers, {});
});

test('counts require exact stable visible badges', () => {
  assert.deepEqual(readCountButtons([{innerText: '4 Approved'}, {innerText: "0 Can't Go"}],
    {approved: 'Approved', cant_go: "Can't Go"}), {approved: 4, cant_go: 0});
  assert.throws(() => readCountButtons([{innerText: '4 Approved'}], {approved: 'Approved', cant_go: "Can't Go"}));
});

test('contiguous geometry rejects gaps, mismatches, inconsistent height', () => {
  const extent = {height: 180, headerHeight: 30};
  const positions = [{top: 0, height: 50}, {top: 50, height: 50}, {top: 100, height: 50}];
  assert.equal(validatedNamedRowCount(extent, extent, positions, 3), 3);
  assert.equal(validatedNamedRowCount(extent, extent, [positions[0], positions[2]], 2), null);
  assert.equal(validatedNamedRowCount(extent, {...extent, height: 181}, positions, 3), null);
  assert.equal(validatedNamedRowCount(extent, extent, [...positions, {top: 100, height: 49}], 4), null);
});

test('complete traversal covers both views with independent explicit attendance', async () => {
  const other = row(0, 'cant_go'); other.check_label = 'Checked in';
  const snapshot = await captureAttendance(fake({cant_go: [other]}), config());
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.source_counts, {approved: 4, cant_go: 1});
  assert.equal(snapshot.guests.length, 5);
  assert.equal(snapshot.guests.at(-1).checked_in, true);
  assert.equal(snapshot.guests.at(-1).approval_status, 'cant_go');
  assert.equal(new Set(snapshot.guests.map(g => g.source_id)).size, 5);
  assert.equal(snapshot.guests[0].source_id, await partifulIdentity(config().event.url,
    'Synthetic Person 0', 'https://www.linkedin.com/in/synthetic-0', 'Example Organization'));
});

test('named geometry supports larger stable badge without assigning its difference', async () => {
  const snapshot = await captureAttendance(fake({badges: {approved: 7, cant_go: 2}}), config());
  assert.deepEqual(snapshot.source_counts, {approved: 4, cant_go: 1});
  assert.equal(snapshot.source_evidence.approved.badge_count, 7);
  assert.equal(snapshot.source_evidence.approved.named_count, 4);
  assert.equal(snapshot.source_evidence.approved.scroll_height, 230);
});

test('explicit empty views and zero counts are complete', async () => {
  const snapshot = await captureAttendance(fake({approved: [], cant_go: []}), config());
  assert.deepEqual(snapshot.source_counts, {approved: 0, cant_go: 0});
  assert.deepEqual(snapshot.guests, []);
});

test('badge smaller than actual rows fails', async () => {
  await assert.rejects(captureAttendance(fake({badges: {approved: 3, cant_go: 1}}), config()), /smaller/);
});

test('unknown check-in aborts instead of marking absent', async () => {
  await assert.rejects(captureAttendance(fake({mutate(rows) { rows[0].check_label = ''; }}), config()), /Unrecognized check-in/);
});

test('unknown RSVP aborts', async () => {
  await assert.rejects(captureAttendance(fake({mutate(rows) { rows[0].approval_label = 'Maybe'; }}), config()), /Unrecognized RSVP/);
});

test('missed virtual row fails despite matching badge count', async () => {
  const adapter = fake();
  const read = adapter.readRows;
  adapter.readRows = async () => (await read()).filter(item => item._row_top !== 50);
  await assert.rejects(captureAttendance(adapter, config()), /contiguous/);
});

test('Cannot Go must have complete geometry too', async () => {
  const adapter = fake({cant_go: [row(0, 'cant_go'), row(1, 'cant_go'), row(2, 'cant_go')]});
  const read = adapter.readRows;
  adapter.readRows = async () => (await read()).filter(item => item.approval_label !== "😢 Can't Go" || item._row_top !== 50);
  await assert.rejects(captureAttendance(adapter, config()), /contiguous/);
});

test('identical display names with different professional identities remain separate', async () => {
  const first = row(0), second = row(1); second.name = first.name;
  const snapshot = await captureAttendance(fake({approved: [first, second]}), config());
  assert.equal(snapshot.source_counts.approved, 2);
  assert.notEqual(snapshot.guests[0].source_id, snapshot.guests[1].source_id);
});

test('same exact identity at two positions fails', async () => {
  const first = row(0), second = {...row(0), _row_top: 50};
  await assert.rejects(captureAttendance(fake({approved: [first, second]}), config()), /Duplicate exact professional identity|multiple row positions/);
});

test('check-in changing on overlapped rows fails', async () => {
  await assert.rejects(captureAttendance(fake({mutate(rows, {reads}) {
    if (reads > 1 && rows.length) rows[0].check_label = rows[0].check_label === 'Checked in' ? 'Check in' : 'Checked in';
  }}), config()), /changed during scan/);
});

test('changed counts or event URL fail', async () => {
  const adapter = fake(); let n = 0;
  adapter.readCounts = async () => ({approved: ++n > 1 ? 5 : 4, cant_go: 1});
  await assert.rejects(captureAttendance(adapter, config()), /counts changed/);
  const wrong = fake(); wrong.url = async () => 'https://partiful.com/e/other';
  await assert.rejects(captureAttendance(wrong, config()), /Wrong event/);
});

test('guest table focus hint preserves canonical binding; other queries fail', async () => {
  const adapter = fake(); adapter.url = async () => config().event.url + '?focus=guest-table';
  assert.equal((await captureAttendance(adapter, config())).event_url, config().event.url);
  adapter.url = async () => config().event.url + '?unreviewed=value';
  await assert.rejects(captureAttendance(adapter, config()), /Wrong event/);
});

test('stopped scrolling and bounded traversal fail', async () => {
  const adapter = fake(); adapter.scroll = async () => {};
  await assert.rejects(captureAttendance(adapter, config()), /stopped advancing/);
  await assert.rejects(captureAttendance(fake(), config(), {maxPages: 1}), /Incomplete/);
});

test('embedded contacts are redacted from allowlisted answers', async () => {
  const first = row(0); first.answers.interest = 'Design synthetic@example.invalid';
  const snapshot = await captureAttendance(fake({approved: [first]}), config());
  assert.equal(snapshot.guests[0].answers.interest, 'Design [redacted]');
});

test('facades wrap supplied handles without launch/auth and use native scroll', async () => {
  const calls = [];
  const locator = {waitFor: async options => calls.push(options), fill: async value => calls.push(value)};
  const playwright = {getByRole: () => locator, getByPlaceholder: () => locator};
  const tab = {url: () => config().event.url, reload: async () => calls.push('reload'), playwright,
    getScreenshot: async options => calls.push(options), scroll: async (...args) => calls.push(args)};
  const codex = createCodexAdapter(tab, config());
  await codex.prepare(); await codex.observe(); await codex.scroll({point: [10, 20]}, 'down', 0.5);
  assert.ok(calls.some(item => item?.timeoutMs === 15000));
  assert.deepEqual(calls.at(-1), [[10, 20], 'down', 0.5]);
  const page = {...playwright, url: tab.url, reload: tab.reload, screenshot: async () => {},
    mouse: {move: async (...args) => calls.push(args), wheel: async (...args) => calls.push(args)}};
  const bridge = createPlaywrightAdapter(page, config());
  await bridge.prepare(); await bridge.scroll({point: [10, 20], view: 200}, 'up', 0.5);
  assert.ok(calls.some(item => item?.timeout === 15000));
  assert.deepEqual(calls.at(-1), [0, -100]);
});
