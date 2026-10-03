import test from 'node:test';
import assert from 'node:assert/strict';
import { MobileNavigation } from '../frontend/mobile-navigation.js';
function fixture(t) {
  let focused, marked, notified;
  const ids=['route-planner','edit-route','return-to-map','pin-start','pin-end','pin-help','pin-reticle','start-location','destination-location','route-status'];
  const elements=new Map(ids.map(id=>[`#${id}`,{hidden:false,value:id,attributes:{},setAttribute(k,v){this.attributes[k]=v;},focus(){focused=id;}}]));
  const old=globalThis.document;globalThis.document={querySelector:id=>elements.get(id)};t.after(()=>{globalThis.document=old;});
  const nav=Object.create(MobileNavigation.prototype);
  Object.assign(nav,{searches:[],map:{getCenter:()=>({lat:42.4468,lng:-76.485}),getContainer:()=>({focus(){focused='map';}})},markStart:p=>{marked={side:'start',...p};},markDestination:p=>{marked={side:'end',...p};},notify:m=>{notified=m;}});
  const key=k=>nav.handlePinKey({key:k,preventDefault(){},stopPropagation(){}});
  return {nav,elements,key,get focused(){return focused;},get marked(){return marked;},get notified(){return notified;}};
}
test('keyboard places the armed start independently and returns focus to its field',t=>{
  const f=fixture(t);f.nav.beginPin('start');assert.equal(f.focused,'map');assert.equal(f.elements.get('#pin-reticle').hidden,false);
  f.key('Enter');assert.equal(f.marked.side,'start');assert.equal(f.elements.get('#start-location').value,'42.446800, -76.485000');
  assert.equal(f.elements.get('#destination-location').value,'destination-location');assert.equal(f.focused,'start-location');
  assert.equal(f.nav.placingPin,false);assert.equal(f.elements.get('#pin-reticle').hidden,true);
});
test('Escape cancels destination placement without modifying either endpoint',t=>{
  const f=fixture(t);f.nav.beginPin('end');f.key('Escape');assert.equal(f.marked,undefined);
  assert.equal(f.elements.get('#destination-location').value,'destination-location');assert.equal(f.focused,'destination-location');assert.equal(f.nav.placingPin,false);
});
test('out-of-campus placement retains armed selection and both fields',t=>{
  const f=fixture(t);f.nav.beginPin('start');f.nav.placePin({lat:0,lon:0});assert.equal(f.nav.placingPin,true);assert.match(f.notified,/starting point.*Cornell/);assert.equal(f.marked,undefined);
});
test('map clicks and Enter cannot change endpoints during a collapsed active walk',t=>{
  const f=fixture(t);f.nav.active={};f.nav.setPlannerOpen(false);f.nav.placePin({lat:42.4468,lon:-76.485});f.key('Enter');assert.equal(f.marked,undefined);
});
