import {MotionService} from '../src/motion-service.js';
import {NativeMotionService} from './native-motion.js';
import {captureLocation,watchLocation} from './location.js';
import {withinCornell} from '../src/ui/cornell.js';
import {DeviceTransport,RawMotionTransport,request} from './connection.js';
import {Health,nativePlatform} from './health.js';
import {HealthAnalyzer} from './health-analysis.js';
const $=selector=>document.querySelector(selector);let pairing,transport,rawTransport,stopLocation=()=>{},healthTimer,sharing=false,sharingGeneration=0,location,reportLocation,reportGeneration=0,map,marker,sent=0;let lastMotion=0,lastUnsafeMotion=0,lastShock=0,lastPassage=0;const locations=[],analyzer=new HealthAnalyzer();
function message(text){$('#phone-message').hidden=false;$('#phone-message').textContent=text;}
function pairLink(link){const url=new URL(link),fragment=new URLSearchParams(url.hash.slice(1)),api=fragment.get('api'),token=fragment.get('token'),deviceId=fragment.get('device_id');
  if(!api||!token||!deviceId)throw new Error('Paste the complete link from Connect Phone.');
  const endpoint=new URL(api);if(endpoint.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(endpoint.hostname))throw new Error('The connection must use HTTPS.');
  if(sharing)stop();pairing={api:endpoint.origin,token,deviceId};$('#phone-status').textContent='Paired. Tap Start to allow motion and location access.';$('#pair-details').open=false;$('#start').disabled=false;
}
try{if(location===undefined&&window.location.hash)pairLink(window.location.href);}catch(e){message(e.message);}
$('#pair').onclick=()=>{try{pairLink($('#pair-link').value.trim());message('Pairing link ready. Tap Start Sensors.');}catch(e){message(e.message);}};
function freshLocation(){if(!location||Date.now()/1000-location.timestamp>10||location.accuracyMeters>20||!withinCornell(location))throw new Error('A fresh, precise Cornell location is needed.');return location;}
const Motion=nativePlatform()?NativeMotionService:MotionService;
const motion=new Motion({bridge:Health,config:{rotationLimitRadS:300*Math.PI/180},onRawSample:sample=>rawTransport?.enqueue(sample),onSamples:()=>lastMotion=Date.now()/1000,onStatus:status=>{if(status.state==='sample-dropped')lastUnsafeMotion=Date.now()/1000;if(status.state==='listening')$('#sensor-status').textContent='Motion permission granted · waiting for sensor samples';},onCandidate:candidate=>{
  if(!sharing||candidate.peakAcceleration<=16)return;lastShock=Date.now()/1000;
  // Browser hazards are derived from raw samples on the backend, once only.
  if(!nativePlatform())return;
  try{const point=freshLocation();transport.enqueue({lat:point.lat,lng:point.lon,accuracy_meters:point.accuracyMeters,source:nativePlatform()?'native_motion':'web_motion',metric_type:'SENSOR_SHOCK',severity:1,timestamp:Date.now()/1000,
    evidence:{gyro_deg_s:candidate.peakAngularSpeed*180/Math.PI,peak_jerk:candidate.peakJerk,peak_acceleration:candidate.peakAcceleration,fwhm_ms:candidate.fwhmMs}});}catch(e){$('#phone-status').textContent=e.message;}
}});
async function submitPassage(){
  if(!sharing||Date.now()/1000-lastPassage<10||Date.now()/1000-lastMotion>1)return;
  const trace=locations.slice(-30),start=trace[0]?.timestamp;
  if(trace.length<8||start<=Math.max(lastUnsafeMotion,lastShock)||trace.some((point,i)=>point.accuracyMeters>.25||(i>0&&point.timestamp-trace[i-1].timestamp>.5)))return;
  lastPassage=Date.now()/1000;
  try{await request('/api/telemetry/passage',{api:pairing.api,token:pairing.token,method:'POST',body:{device_id:pairing.deviceId,passage_id:crypto.randomUUID(),shock_detected:false,trace:trace.map(point=>({lat:point.lat,lng:point.lon,timestamp:point.timestamp,accuracy_meters:point.accuracyMeters}))}});}catch(error){message(error.message);}
}
async function readHealth(){const activeTransport=transport;try{const {samples}=await Health.readSamples();if(!sharing||activeTransport!==transport)return;for(const event of analyzer.ingest(samples,locations))activeTransport.enqueue(event);}catch(e){if(sharing&&activeTransport===transport)$('#health-status').textContent=`Health: ${e.message}`;}}
$('#start').onclick=async()=>{
  if(!pairing){message('Scan a QR code or paste a pairing link first.');$('#pair-details').open=true;return;}
  if(!window.isSecureContext){message('Open this phone page over HTTPS to enable motion and location.');return;}
  $('#start').disabled=true;sharing=true;const generation=++sharingGeneration;
  // Called directly from the tap, before waiting for any network response.
  const motionRequest=motion.start().catch(e=>{if(generation!==sharingGeneration)return;rawTransport?.stop();$('#sensor-status').textContent=`Motion: ${e.message}`;message(`Motion: ${e.message} Manual reporting remains available.`);});
  transport=new DeviceTransport({...pairing,onStatus:status=>$('#connection').textContent=status,onRejected:message,onSent:()=>{$('#sent-count').textContent=String(++sent);}});transport.start();
  if(!nativePlatform()){
    rawTransport=new RawMotionTransport({...pairing,getLocation:()=>{try{const point=freshLocation();return {lat:point.lat,lng:point.lon,accuracy_meters:point.accuracyMeters,timestamp:point.timestamp};}catch{return null;}},
      onStatus:status=>$('#sensor-status').textContent=status,onSent:()=>{$('#sent-count').textContent=String(++sent);}});rawTransport.start();
  }
  watchLocation(point=>{if(generation!==sharingGeneration)return;location=point;locations.push(location);while(locations.length>300||locations[0]?.timestamp<Date.now()/1000-180)locations.shift();submitPassage();$('#phone-status').textContent=withinCornell(location)?`Location ±${Math.round(location.accuracyMeters)} m · sharing is active`:'Outside Cornell coverage. Automatic reports are paused.';},e=>{if(generation===sharingGeneration)$('#phone-status').textContent=`Location: ${e.message}`;}).then(stopWatch=>{if(sharing&&generation===sharingGeneration)stopLocation=stopWatch;else stopWatch();}).catch(error=>{if(generation===sharingGeneration)$('#phone-status').textContent=error.message;});
  $('#start').hidden=true;$('#stop').hidden=false;
  try{await motionRequest;if(!sharing||generation!==sharingGeneration)return;if(nativePlatform()){const availability=await Health.availability();if(!sharing||generation!==sharingGeneration)return;if(availability.available){await Health.requestPermissions();if(!sharing||generation!==sharingGeneration)return;await Health.startMonitoring();if(!sharing||generation!==sharingGeneration){await Health.stopMonitoring();return;}healthTimer=setInterval(readHealth,30000);readHealth();$('#health-status').textContent='Native health access requested · fresh samples are matched to location';}else $('#health-status').textContent=availability.reason||'Native health is unavailable.';}}
  catch(e){if(generation===sharingGeneration)$('#health-status').textContent=e.message;}finally{if(generation===sharingGeneration)$('#start').disabled=false;}
};
function stop(){sharing=false;++sharingGeneration;motion.stop();rawTransport?.stop();rawTransport=null;stopLocation();stopLocation=()=>{};clearInterval(healthTimer);if(nativePlatform())Health.stopMonitoring().catch(()=>{});transport?.stop();locations.length=0;location=null;$('#start').hidden=false;$('#start').disabled=false;$('#stop').hidden=true;$('#connection').textContent='Stopped';$('#sensor-status').textContent='Sensors stopped';$('#phone-status').textContent='Sharing stopped. Tap Start to reconnect.';}
$('#stop').onclick=stop;window.addEventListener('pagehide',stop);
function setReport(point){if(!withinCornell(point)||point.accuracyMeters>50)throw new Error('Choose a precise point on a Cornell walking path.');reportLocation=point;$('#location-status').textContent='Location captured. Choose the incident.';$('#chosen-coordinate').textContent=`${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;document.querySelectorAll('[data-metric]').forEach(button=>button.disabled=false);}
$('#phone-report').onclick=async()=>{if(!sharing||!pairing){message('Start sharing before sending a report.');return;}const generation=++reportGeneration;reportLocation=null;document.querySelectorAll('[data-metric]').forEach(button=>button.disabled=true);$('#location-status').textContent='Capturing your location…';$('#chosen-coordinate').textContent='';$('#phone-map').hidden=true;$('#phone-report-dialog').showModal();try{const point=await captureLocation();if(generation===reportGeneration&&$('#phone-report-dialog').open)setReport(point);}catch(e){if(generation===reportGeneration)$('#location-status').textContent=e.message;}};
$('#phone-report-dialog').addEventListener('close',()=>reportGeneration++);$('#close-report').onclick=()=>$('#phone-report-dialog').close();
$('#manual-location').onclick=()=>{reportGeneration++;$('#phone-map').hidden=false;if(!map){map=window.L.map('phone-map').setView([42.447,-76.483],16);window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap',maxZoom:19}).addTo(map);map.on('click',({latlng})=>{try{setReport({lat:latlng.lat,lon:latlng.lng,accuracyMeters:0,timestamp:Date.now()/1000});marker?.remove();marker=window.L.marker(latlng).addTo(map);}catch(e){$('#location-status').textContent=e.message;}});}$('#phone-map').setAttribute('tabindex','0');$('#phone-map').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();map.fire('click',{latlng:map.getCenter()});}if(event.key==='Escape')$('#phone-report-dialog').close();};map.invalidateSize();$('#location-status').textContent='Tap a Cornell walking path to place your report.';};
document.querySelectorAll('[data-metric]').forEach(button=>button.onclick=()=>{if(!sharing||!reportLocation)return;if(Date.now()/1000-reportLocation.timestamp>120){$('#location-status').textContent='Location expired. Close this report and capture it again.';return;}transport.enqueue({lat:reportLocation.lat,lng:reportLocation.lon,accuracy_meters:reportLocation.accuracyMeters,source:'manual',metric_type:button.dataset.metric,severity:1,timestamp:Date.now()/1000});$('#phone-report-dialog').close();message('Report queued. The sent counter updates when the backend accepts it.');});
