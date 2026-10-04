import test from 'node:test';
import assert from 'node:assert/strict';
import { LocationPicker } from '../frontend/location-picker.js';
import { MobileNavigation } from '../frontend/mobile-navigation.js';
import { CORNELL_PLACES } from '../src/ui/cornell.js';

function fixture(t) {
  const elements=[];
  class Element {
    constructor(id=''){this.id=id;this.value='';this.children=[];this.attributes={};this.listeners={};this.style={};this.offsetWidth=44;elements.push(this);}
    setAttribute(key,value){this.attributes[key]=value;}
    addEventListener(type,callback){(this.listeners[type]??=[]).push(callback);}
    dispatchEvent(event){for(const callback of this.listeners[event.type]??[])callback(event);return true;}
    append(child){this.children.push(child);}
    replaceChildren(){this.children=[];}
    querySelector(){return this.children[0];}
    querySelectorAll(){return this.children;}
    getBoundingClientRect(){return {left:100,bottom:180,width:200};}
    contains(element){return element===this||this.children.includes(element);}
    focus(){globalThis.document.activeElement=this;this.dispatchEvent({type:'focus'});}
  }
  const oldDocument=globalThis.document,oldWindow=globalThis.window;
  t.after(()=>{globalThis.document=oldDocument;globalThis.window=oldWindow;});
  globalThis.document={body:new Element(),createElement:()=>new Element(),addEventListener(){},
    querySelector:selector=>elements.find(element=>`#${element.id}`===selector),
    querySelectorAll:selector=>selector==='.location-suggestions'?elements.filter(element=>element.className==='location-suggestions'):
      elements.filter(element=>element.attributes['aria-controls']===selector.match(/aria-controls="([^"]+)"/)?.[1])};
  globalThis.window={innerHeight:844,addEventListener(){}};
  const start=new Element('start-location'),destination=new Element('destination-location'),startToggle=new Element('start-toggle'),destinationToggle=new Element('destination-toggle');
  start.value='My live location';
  const startPicker=new LocationPicker(start,startToggle,[{name:'My live location'},...CORNELL_PLACES],{label:'Start locations'});
  const destinationPicker=new LocationPicker(destination,destinationToggle,CORNELL_PLACES,{label:'Destinations'});
  return {Element,start,destination,startToggle,destinationToggle,startPicker,destinationPicker};
}

test('both endpoint pickers populate, use independent IDs, and close the other menu before selecting',t=>{
  const f=fixture(t);f.startToggle.onclick();
  assert.equal(f.startPicker.menu.hidden,false);assert.equal(f.startPicker.menu.children.length,CORNELL_PLACES.length+1);
  assert.notEqual(f.startPicker.menu.id,f.destinationPicker.menu.id);
  const startName=CORNELL_PLACES[0].name;let changes=0;f.start.addEventListener('change',()=>changes++);
  f.startPicker.menu.children.find(button=>button.textContent===startName).onclick();
  assert.equal(f.start.value,startName);assert.equal(f.destination.value,'');assert.equal(changes,1);
  f.startToggle.onclick();f.destinationToggle.onclick();
  assert.equal(f.startPicker.menu.hidden,true);assert.equal(f.start.attributes['aria-expanded'],'false');
  f.destinationPicker.menu.children.find(button=>button.textContent===CORNELL_PLACES[1].name).onclick();
  assert.equal(f.start.value,startName);assert.equal(f.destination.value,CORNELL_PLACES[1].name);
});

test('filtered start selection is keyboard accessible and routes from the selected landmark without requesting GPS',async t=>{
  const f=fixture(t);f.start.value='Ho';f.start.dispatchEvent({type:'input'});
  assert.deepEqual(f.startPicker.menu.children.map(button=>button.textContent),['Ho Plaza']);
  f.start.dispatchEvent({type:'keydown',key:'ArrowDown',preventDefault(){}});
  assert.equal(document.activeElement,f.startPicker.menu.children[0]);document.activeElement.onclick();
  f.destinationToggle.onclick();f.destinationPicker.menu.children.find(button=>button.textContent==='Arts Quad').onclick();
  for(const id of ['route-options','active-route','find-routes','route-status','locate-me','return-to-map','hazard-stream-status','route-update-warning','route-update-status','retry-route'])new f.Element(id);
  const nav=Object.create(MobileNavigation.prototype);let gpsCalls=0,requested;
  Object.assign(nav,{requestId:0,planningId:0,routes:{clearLayers(){}},hideAlert(){},markStart(){},markDestination(){},getLocation:()=>null,
    ensureLocation:async()=>gpsCalls++,refresh:async()=>{requested={from:nav.from,to:nav.to};}});
  await nav.generate();
  assert.equal(gpsCalls,0);assert.equal(nav.liveStart,false);
  assert.deepEqual(requested.from,{lat:CORNELL_PLACES[0].lat,lon:CORNELL_PLACES[0].lon});
  assert.deepEqual(requested.to,{lat:CORNELL_PLACES[1].lat,lon:CORNELL_PLACES[1].lon});
});
