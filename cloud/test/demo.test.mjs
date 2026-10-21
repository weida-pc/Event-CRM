import test from 'node:test';
import assert from 'node:assert/strict';
import {demoData,selectDemoAudience} from '../public/demo.js';
test('fictional sponsor view demonstrates different priorities without resetting team work',()=>{
  const d=structuredClone(demoData);d.people[0].work.status='meeting';
  selectDemoAudience(d,'aud-2');assert.equal(d.people[0].name,'Riley Chen');assert.equal(d.people.at(-1).name,'Avery Patel');
  selectDemoAudience(d,'aud-1');assert.equal(d.people[0].name,'Jordan Avery');assert.equal(d.people[0].work.status,'meeting');
});
