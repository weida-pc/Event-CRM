// Offline DOM harness for the shipped UI. No browser/network or customer data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Node {
  constructor(tag = 'div', text = '') {
    this.tag = tag; this.textContent = text; this.children = []; this.dataset = {};
    this.listeners = {}; this.attributes = {}; this.value = ''; this.className = '';
  }
  append(...nodes) { for (const node of nodes) { if (node.parent) node.remove(); node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  get childNodes() { return this.children; }
  get parentElement() { return this.parent; }
  closest(selector) { return this.className.split(' ').includes(selector.slice(1)) ? this : this.parent?.closest(selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  remove() { this.parent.children = this.parent.children.filter(n => n !== this); }
  querySelectorAll(selector) {
    const all = this.children.flatMap(n => [n, ...n.querySelectorAll('*')]);
    return selector === '*' ? all : all.filter(n => n.tag === selector);
  }
}

function ui(photo = `/api/photos/${'a'.repeat(24)}/${'f'.repeat(64)}`) {
  const nodes = new Map();
  const doc = {hidden: true, addEventListener() {},
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); },
    createElement(tag) { return new Node(tag); }, createTextNode(text) { return new Node('#text', text); }};
  const guest = {id: 'a'.repeat(24), name: 'Synthetic Person', company: 'Example Organization', title: 'Engineer',
    answers: {}, photo_url: photo, checked_in: true, score: 50, priority: 0, reasons: [], status: 'new'};
  const second = {...guest, id: 'b'.repeat(24), name: 'Other Synthetic', photo_url: '', checked_in: false, score: 20};
  const data = {team: [], questions: [], runtime: {access: 'read_only'}, audiences: [
    {id: 'first', ranking: 'value_first', records: [guest, second]},
    {id: 'second', ranking: 'value_first', records: [guest]}]};
  const context = vm.createContext({document: doc, URL, setInterval() {}, setTimeout() {}, clearTimeout() {},
    fixture: data, fetch() { throw new Error('No network in offline DOM test'); }});
  vm.runInContext(readFileSync(new URL('../event_crm/static/app.js', import.meta.url), 'utf8'), context);
  vm.runInContext("state.data = fixture; state.audience = 'first'; renderGuests();", context);
  return {context, nodes, doc};
}

test('actual UI counts unique stored people separately from successful image loads', () => {
  const {nodes} = ui();
  assert.match(nodes.get('photo-summary').textContent, /Photos stored: 1\/2 people.*Visible loaded: 0\/1/);
  const image = nodes.get('guest-list').querySelectorAll('img')[0];
  assert.ok(image.src.startsWith('/api/photos/'));
  image.naturalWidth = 256;
  image.listeners.load();
  assert.match(nodes.get('photo-summary').textContent, /Visible loaded: 1\/1/);
  assert.equal(nodes.get('metric-checked').textContent, 1);
  assert.equal(nodes.get('guest-list').children.length, 2);
});

test('actual UI exposes render failure and preserves initials and all guest cards', () => {
  const {nodes} = ui();
  const card = nodes.get('guest-list').children[0];
  card.querySelectorAll('img')[0].listeners.error();
  assert.equal(card.dataset.photo, 'failed_render');
  assert.equal(card.querySelectorAll('img').length, 0);
  assert.match(nodes.get('photo-summary').textContent, /1 failed to load/);
  assert.equal(nodes.get('guest-list').children.length, 2);
  assert.equal(card.querySelectorAll('div').find(n => n.className === 'avatar').textContent, 'SP');
});

test('legacy remote URLs cannot load or inflate stored coverage', () => {
  const {nodes} = ui('https://images.example.com/unreviewed.png');
  assert.equal(nodes.get('guest-list').querySelectorAll('img').length, 0);
  assert.match(nodes.get('photo-summary').textContent, /Photos stored: 0\/2/);
});

test('late image events after sign-out do not throw', () => {
  const {nodes, context} = ui();
  const image = nodes.get('guest-list').querySelectorAll('img')[0];
  vm.runInContext('state.data = null;', context);
  assert.doesNotThrow(() => image.listeners.error());
});

test('ordinary refresh reuses loaded and pending image nodes without refetch', () => {
  for (const loaded of [true, false]) {
    const {nodes, context} = ui();
    const image = nodes.get('guest-list').querySelectorAll('img')[0];
    if (loaded) { image.naturalWidth = 256; image.listeners.load(); }
    vm.runInContext('renderGuests();', context);
    assert.equal(nodes.get('guest-list').querySelectorAll('img')[0], image);
    if (!loaded) { image.naturalWidth = 256; image.listeners.load(); }
    assert.match(nodes.get('photo-summary').textContent, /Visible loaded: 1\/1.*0 pending/);
  }
});
