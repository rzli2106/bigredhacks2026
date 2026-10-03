import {Geolocation} from '@capacitor/geolocation';
import {nativePlatform} from './health.js';
import {captureDeviceLocation} from '../src/ui/reporting.js';
const options={enableHighAccuracy:true,maximumAge:0,timeout:10000};
const normalize=position=>({lat:position.coords.latitude,lon:position.coords.longitude,accuracyMeters:position.coords.accuracy,timestamp:position.timestamp/1000,source:'device'});
export async function captureLocation(){
  if(!nativePlatform())return captureDeviceLocation();
  return normalize(await Geolocation.getCurrentPosition(options));
}
export async function watchLocation(onPosition,onError){
  if(nativePlatform()){
    const permission=await Geolocation.requestPermissions();
    if(permission.location!=='granted')throw new Error('Precise location permission is required.');
    const id=await Geolocation.watchPosition(options,(position,error)=>{if(error)onError(error);else if(position)onPosition(normalize(position));});
    return ()=>Geolocation.clearWatch({id}).catch(()=>{});
  }
  if(!navigator.geolocation)throw new Error('Location is unavailable.');
  const id=navigator.geolocation.watchPosition(position=>onPosition(normalize(position)),onError,options);
  return ()=>navigator.geolocation.clearWatch(id);
}
