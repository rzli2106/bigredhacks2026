import test from 'node:test';
import assert from 'node:assert/strict';
import { MobileNavigation } from '../frontend/mobile-navigation.js';
const deferred = () => { let resolve,reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; };
const settle = async () => { for(let i=0;i<10;i++)await Promise.resolve(); };
function fixture(t){
  const elements=new Map(['locate-me','route-update-warning','route-update-status','retry-route','route-options','active-route','return-to-map','find-routes','route-status','start-location','destination-location'].map(id=>[`#${id}`,{disabled:false,hidden:false,value:'',textContent:'',replaceChildren(){}}]));
  elements.get('#start-location').value='My live location';elements.get('#destination-location').value='Arts Quad';
  const old=globalThis.document;globalThis.document={querySelector:id=>elements.get(id)};
  t.after(()=>{if(old===undefined)delete globalThis.document;else globalThis.document=old;});
  const gps=[],routes=[],navigation=Object.create(MobileNavigation.prototype);
  Object.assign(navigation,{requestId:0,planningId:0,pending:[],routes:{clearLayers(){}},hideAlert(){},markStart(){},markDestination(){},getLocation:()=>({lat:42.4468,lon:-76.485,timestamp:Date.now()/1000}),
    ensureLocation(){const next=deferred();gps.push(next);return next.promise;},
    refresh(){const next=deferred();routes.push(next);return next.promise;}});
  return {navigation,gps,routes,elements};
}
test('an old GPS completion cannot re-enable controls during a newer route lookup',async t=>{
  const {navigation,gps,routes,elements}=fixture(t);
  const first=navigation.generate();const second=navigation.generate();
  gps[1].resolve();await settle();assert.equal(routes.length,1);
  gps[0].resolve();await first;
  assert.equal(elements.get('#find-routes').disabled,true);assert.equal(routes.length,1);
  routes[0].resolve();await second;assert.equal(elements.get('#find-routes').disabled,false);
});
test('a stale GPS failure cannot overwrite the newer planning status',async t=>{
  const {navigation,gps,elements}=fixture(t);
  const first=navigation.generate();const second=navigation.generate();
  gps[0].reject(new Error('Old location denied'));await first;
  assert.equal(elements.get('#route-status').textContent,'Finding walking routes…');
  assert.equal(elements.get('#find-routes').disabled,true);
  gps[1].reject(new Error('Current location denied'));await second;
  assert.equal(elements.get('#route-status').textContent,'Current location denied');assert.equal(elements.get('#find-routes').disabled,false);
});
test('cancelling pending GPS planning restores controls and ignores its late completion',async t=>{
  const {navigation,gps,routes,elements}=fixture(t);
  const pending=navigation.generate();navigation.cancelRequest();
  assert.equal(elements.get('#find-routes').disabled,false);
  gps[0].resolve();await pending;assert.equal(routes.length,0);
});

test('editing the selection cancels a pending GPS plan and ignores its later result',async t=>{
  const {navigation,gps,routes,elements}=fixture(t),pending=navigation.generate();
  elements.get('#destination-location').value='Bailey Hall';navigation.cancelPlanning();
  assert.equal(elements.get('#find-routes').disabled,false);assert.match(elements.get('#route-status').textContent,/selection changed/);
  gps[0].resolve();await pending;assert.equal(routes.length,0);assert.equal(elements.get('#destination-location').value,'Bailey Hall');
});
