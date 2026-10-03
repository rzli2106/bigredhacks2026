import test from 'node:test';
import assert from 'node:assert/strict';
import {MobileNavigation} from '../frontend/mobile-navigation.js';
function fixture(t){
 const old=globalThis.document,elements=new Map(['map-stream','hazard-stream-status'].map(id=>[`#${id}`,{hidden:true,textContent:''}]));
 globalThis.document={querySelector:id=>elements.get(id)};t.after(()=>{globalThis.document=old;});
 const nav=Object.create(MobileNavigation.prototype),route={};
 Object.assign(nav,{active:route,snapshot:{events:[]},alerts:{observe:()=>[]},getLocation:()=>null,pending:[],hazards:{clearLayers(){}},renderAlert(){},renderRoutes(){},queueRefresh(){}});
 return {nav,elements,route};
}
test('disconnected hazard feed warns outside the planner while preserving the active walk',t=>{
 const {nav,elements,route}=fixture(t);nav.setStreamStatus('Reconnecting');
 assert.equal(nav.active,route);assert.equal(elements.get('#hazard-stream-status').hidden,false);
 assert.match(elements.get('#hazard-stream-status').textContent,/paused.*last known reports/);
});
test('socket opening does not clear the warning before a fresh snapshot arrives',t=>{
 const {nav,elements}=fixture(t);nav.setStreamStatus('Waiting for hazards');
 assert.equal(elements.get('#hazard-stream-status').hidden,false);
 nav.onSnapshot({events:[],instance_id:'test',revision:0,time:1800000000});
 assert.equal(elements.get('#hazard-stream-status').hidden,true);assert.equal(elements.get('#map-stream').textContent,'Live hazards');
});
test('paused feed does not add a walking warning when no route is active',t=>{
 const {nav,elements}=fixture(t);nav.active=null;nav.setStreamStatus('Connecting');
 assert.equal(elements.get('#hazard-stream-status').hidden,true);assert.equal(elements.get('#map-stream').textContent,'Connecting');
});

test('missing initial snapshot warns about missing reports instead of implying cached reports exist',t=>{
 const {nav,elements}=fixture(t);nav.snapshot=null;nav.setStreamStatus('Connecting');
 assert.match(elements.get('#hazard-stream-status').textContent,/reports may be missing/);
});
