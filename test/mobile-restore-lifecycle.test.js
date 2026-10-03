import test from 'node:test';
import assert from 'node:assert/strict';
import { MobileNavigation } from '../frontend/mobile-navigation.js';
test('page-cache restore reinstalls keyboard pins exactly once and restores map observation',t=>{
  const old=globalThis.document,container=new EventTarget(),elements=new Map(['locate-me','find-routes','navigation-map'].map(id=>[`#${id}`,{}]));
  globalThis.document={querySelector:id=>elements.get(id)};t.after(()=>{globalThis.document=old;});
  let keys=0,connections=0,observations=0,invalidations=0;
  const nav=Object.create(MobileNavigation.prototype);
  Object.assign(nav,{map:{getContainer:()=>container,invalidateSize(){invalidations++;}},pinKeyboard:()=>{keys++;},connect(){connections++;},resize:{disconnect(){},observe(element){assert.equal(element,elements.get('#navigation-map'));observations++;}},audio:{pause(){}}});
  container.addEventListener('keydown',nav.pinKeyboard);nav.stop();container.dispatchEvent(new Event('keydown'));assert.equal(keys,0);
  nav.resume();container.dispatchEvent(new Event('keydown'));assert.equal(keys,1);
  nav.resume();container.dispatchEvent(new Event('keydown'));assert.equal(keys,2);
  assert.equal(connections,2);assert.equal(observations,2);assert.equal(invalidations,2);
});
