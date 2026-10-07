// Offline cross-language contract fixture. No browser or network access.
import {readFileSync} from 'node:fs';
import {captureAttendance} from '../../browser/partiful.mjs';

const config = JSON.parse(readFileSync(0, 'utf8'));
let view = 'approved', top = 0;
const adapter = {
  url: async () => config.event.url,
  reload: async () => {}, prepare: async () => {}, observe: async () => {},
  readHeaders: async () => ['Guest', 'Plus Ones', 'Status', 'Check in', ...Object.values(config.fields), ...config.questions.map(q => q.label)],
  readCounts: async () => ({approved: 1, cant_go: 1}),
  selectView: async value => { view = value; top = 0; },
  measure: async () => ({top, height: 80, view: 50, headerHeight: 30, point: [10,10]}),
  scroll: async (_state, direction) => { top = direction === 'up' ? 0 : 30; },
  readRows: async () => [{name: view === 'approved' ? 'Synthetic Approved' : 'Synthetic Declined',
    company: 'Example Organization', title: 'Founder', linkedin_url: view === 'approved' ? 'linkedin.com/in/synthetic?utm_source=share' : 'not provided',
    answers: Object.fromEntries(config.questions.map(q => [q.id, ''])),
    approval_label: view === 'approved' ? '🤘 Approved' : "😢 Can't Go",
    check_label: 'Check in', check_icon: '', _row_top: 0, _row_height: 50}]
};
process.stdout.write(JSON.stringify(await captureAttendance(adapter, config)));
