import test from 'node:test';
import assert from 'node:assert/strict';
import { MobileNavigation } from '../frontend/mobile-navigation.js';
function fixture(t) {
  const elements=new Map(['locate-me','start-location'].map(id=>[`#${id}`,{disabled:false,textContent:'Locate me',value:'Ho Plaza'}]));
  const old=globalThis.document;globalThis.document={querySelector:id=>elements.get(id)};t.after(()=>{globalThis.document=old;});
  const pending=[],views=[],messages=[],nav=Object.create(MobileNavigation.prototype);
  Object.assign(nav,{unlockAudio(){},ensureLocation(){return new Promise((resolve,reject)=>pending.push({resolve,reject}));},getLocation:()=>({lat:42.4468,lon:-76.485}),map:{setView:p=>views.push(p)},notify:m=>messages.push(m)});
  return {nav,pending,views,messages,elements};
}
test('editing the starting point cancels late Locate me results without changing map or input',async t=>{
  const f=fixture(t),request=f.nav.locate();assert.equal(f.elements.get('#locate-me').disabled,true);
  f.elements.get('#start-location').value='Gates Hall';f.nav.cancelLocate();f.pending[0].resolve();await request;
  assert.equal(f.elements.get('#start-location').value,'Gates Hall');assert.equal(f.views.length,0);assert.equal(f.elements.get('#locate-me').disabled,false);
});
test('a stale location failure cannot replace a newer locate request or release its button',async t=>{
  const f=fixture(t),old=f.nav.locate(),current=f.nav.locate();f.pending[0].reject(new Error('Old denied'));await old;
  assert.equal(f.messages.length,0);assert.equal(f.elements.get('#locate-me').disabled,true);
  f.pending[1].resolve();await current;assert.equal(f.views.length,1);assert.equal(f.elements.get('#start-location').value,'My live location');assert.equal(f.elements.get('#locate-me').textContent,'Locate me');
});
test('current location failures restore the control and provide recovery feedback',async t=>{
  const f=fixture(t),request=f.nav.locate();f.pending[0].reject(new Error('Location denied'));await request;
  assert.deepEqual(f.messages,['Location denied']);assert.equal(f.elements.get('#locate-me').disabled,false);assert.equal(f.elements.get('#start-location').value,'Ho Plaza');
});
