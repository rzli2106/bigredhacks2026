export function configuration(){
  const config=window.PathPulseConfig??{},api=(config.apiBase||window.location.origin).replace(/\/$/,'');
  return {api,ws:config.wsUrl||`${api.replace(/^http/,'ws')}/ws/stream`,mobile:config.mobileUrl||`${window.location.origin}/mobile`};
}
export async function request(path,{method='GET',body,token,api=configuration().api,signal}={}){
  const response=await fetch(`${api}${path}`,{method,signal,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();if(!response.ok){const error=new Error(result.error||`Request failed (${response.status}).`);error.status=response.status;throw error;}return result;
}

/** Preserve the sensor cadence, throttle network requests to at most 20 Hz.
 * No replay of stale motion after reconnecting; gaps reset the server filter. */
export class RawMotionTransport {
  constructor({api,token,deviceId,getLocation,onStatus=()=>{},onSent=()=>{}}) {
    Object.assign(this,{api,token,deviceId,getLocation,onStatus,onSent});
    this.samples=[];this.enabled=false;this.running=false;this.retryAt=0;
  }
  start(){this.enabled=true;this.timer=setInterval(()=>this.flush(),50);}
  stop(){this.enabled=false;clearInterval(this.timer);this.samples=[];this.controller?.abort();}
  enqueue(sample){if(!this.enabled)return;this.samples.push(sample);if(this.samples.length>32)this.samples.shift();}
  async flush(){
    if(!this.enabled||this.running||Date.now()<this.retryAt)return;
    const samples=this.samples.splice(0).filter(sample=>Date.now()-sample.timestamp<1000);
    if(!samples.length)return;
    this.running=true;this.controller=new AbortController();
    const timeout=setTimeout(()=>this.controller.abort(),3000);
    try{
      const result=await request('/api/telemetry/raw',{api:this.api,token:this.token,method:'POST',signal:this.controller.signal,
        body:{device_id:this.deviceId,samples,location:this.getLocation()}});
      if(!this.enabled)return;
      this.onStatus(`Sensors streaming · ${samples.length} samples delivered`);
      for(const event of result.events??[])this.onSent(event);
    }catch(error){
      if(!this.enabled)return;
      this.onStatus(`Sensors: ${error.message}`);
      this.retryAt=Date.now()+(error.status===429?60000:1000);
      if([401,403].includes(error.status))this.stop();
    }finally{clearTimeout(timeout);this.running=false;}
  }
}
export function subscribe(onSnapshot,onStatus=()=>{},{ws=configuration().ws}={}){
  let socket,timer,closed=false,attempt=0;
  function connect(){if(closed)return;onStatus('Connecting');socket=new WebSocket(ws);
    socket.onopen=()=>{attempt=0;onStatus('Live');};
    socket.onmessage=event=>{try{const data=JSON.parse(event.data);if(data.type==='snapshot')onSnapshot(data);}catch{onStatus('Stream error');}};
    socket.onclose=()=>{if(closed)return;onStatus('Reconnecting');timer=setTimeout(connect,Math.min(30000,1000*2**attempt++));};
    socket.onerror=()=>socket.close();
  }
  connect();return ()=>{closed=true;clearTimeout(timer);socket?.close();};
}
export class DeviceTransport {
  constructor({api,token,deviceId,onStatus=()=>{},onSent=()=>{},onRejected=()=>{}}){Object.assign(this,{api,token,deviceId,onStatus,onSent,onRejected});this.queue=[];this.running=false;this.enabled=false;}
  start(){this.enabled=true;this.heartbeat();this.timer=setInterval(()=>this.heartbeat(),15000);this.flush();}
  stop(){this.enabled=false;clearInterval(this.timer);this.queue=[];}
  async heartbeat(){try{await request('/api/devices/heartbeat',{api:this.api,method:'POST',token:this.token,body:{device_id:this.deviceId}});if(!this.enabled)return;this.onStatus('Connected');this.flush();}catch(e){if(this.enabled)this.onStatus(e.message);}}
  enqueue(event){if(!this.enabled)return;this.queue.push({...event,device_id:this.deviceId,event_id:crypto.randomUUID()});if(this.queue.length>100)this.queue.shift();this.flush();}
  async flush(){if(this.running||!this.enabled)return;this.running=true;
    try{while(this.queue.length&&this.enabled){const event=this.queue[0];if(Date.now()/1000-event.timestamp>120){this.queue.shift();continue;}
      try{const result=await request('/api/telemetry/event',{api:this.api,method:'POST',body:event,token:this.token});if(!this.enabled)return;this.queue.shift();this.onStatus('Connected');if(result.accepted)this.onSent(result);}
      catch(error){if(!this.enabled)return;this.onStatus(error.message);if([400,403,413,415,422].includes(error.status)){this.queue.shift();this.onRejected(error.message);continue;}break;}}
    }finally{this.running=false;}
  }
}

export function localDeviceId(storage = window.localStorage) {
  let id = storage.getItem('pathpulse.device_id');
  if (!id || !/^[\w:-]{1,80}$/.test(id)) {
    id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `phone-${Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')}`; storage.setItem('pathpulse.device_id', id);
  }
  return id;
}

/** Scoped credentials are issued directly to the phone; an ID is not a secret. */
export async function registerDevice(api = configuration().api, previous) {
  const deviceId = previous?.deviceId || localDeviceId();
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const data = await request('/api/devices/register', { api, method: 'POST', token: previous?.token, body: { device_id: deviceId }, signal: controller.signal });
    return { api, deviceId, token: data.token, expiresAt: data.expires_at };
  } finally { clearTimeout(timeout); }
}

/** Authenticated WSS telemetry, bounded queue and 20 Hz maximum cadence. */
export class WebSocketMotionTransport {
  constructor({api,token,deviceId,getLocation,onStatus=()=>{},onSent=()=>{}}) {
    Object.assign(this,{api,token,deviceId,getLocation,onStatus,onSent});this.samples=[];this.attempt=0;
  }
  start(){this.enabled=true;this.connect();this.timer=setInterval(()=>this.flush(),50);this.heartbeat=setInterval(()=>{if(this.ready)this.socket.send(JSON.stringify({type:'heartbeat',device_id:this.deviceId}));},15000);}
  connect(){
    if(!this.enabled)return;
    const socket=this.socket=new WebSocket(`${this.api.replace(/^http/,'ws')}/ws/device`);
    this.onStatus('Connecting sensors');
    const authTimeout=setTimeout(()=>socket.close(),6000);
    socket.onopen=()=>socket.send(JSON.stringify({type:'authenticate',token:this.token,device_id:this.deviceId}));
    socket.onmessage=event=>{
      if(!this.enabled)return;
      let data;try{data=JSON.parse(event.data);}catch{return;}
      if(data.type==='authenticated'){clearTimeout(authTimeout);this.ready=true;this.attempt=0;this.onStatus('Sensors connected');}
      if(data.type==='telemetry_ack'){clearTimeout(this.ackTimeout);this.pending=false;this.onStatus('Sensors streaming');for(const result of data.events??[])this.onSent(result);}
      if(data.type==='error'){
        this.pending=false;clearTimeout(this.ackTimeout);this.onStatus(data.error);
        if([401,403,429].includes(data.status)){this.stop();this.onStatus(`${data.error} Stop and enable sensors to reconnect.`);}
      }
    };
    socket.onerror=()=>socket.close();
    socket.onclose=()=>{clearTimeout(authTimeout);clearTimeout(this.ackTimeout);this.ready=false;this.pending=false;this.samples=[];
      if(this.enabled){this.onStatus('Reconnecting sensors');this.retry=setTimeout(()=>this.connect(),Math.min(30000,1000*2**this.attempt++));}
    };
  }
  enqueue(sample){if(!this.enabled)return;this.samples.push(sample);if(this.samples.length>32)this.samples.shift();}
  flush(){
    if(!this.ready||this.pending||this.socket.readyState!==1)return;
    const samples=this.samples.splice(0).filter(sample=>Date.now()-sample.timestamp<1000);if(!samples.length)return;
    this.pending=true;this.socket.send(JSON.stringify({type:'telemetry',device_id:this.deviceId,samples,location:this.getLocation()}));
    this.ackTimeout=setTimeout(()=>this.socket.close(),3000);
  }
  stop(){this.enabled=false;this.ready=false;this.pending=false;this.samples=[];clearInterval(this.timer);clearInterval(this.heartbeat);clearTimeout(this.retry);clearTimeout(this.ackTimeout);this.socket?.close();}
}
