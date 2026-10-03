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
  constructor({api,token,deviceId,getLocation,onStatus=()=>{},onSent=()=>{},onRejected=()=>{}}) {
    Object.assign(this,{api,token,deviceId,getLocation,onStatus,onSent,onRejected});
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
      if([401,403].includes(error.status)){this.stop();this.onRejected(error.message,error.status);}
    }finally{clearTimeout(timeout);this.running=false;}
  }
}
export function subscribe(onSnapshot,onStatus=()=>{},{ws=configuration().ws}={}){
  let socket,timer,closed=false,attempt=0;
  function connect(){if(closed)return;onStatus('Connecting');const connection=new WebSocket(ws);socket=connection;
    const current=()=>!closed&&socket===connection;
    connection.onopen=()=>{if(!current())return;attempt=0;onStatus('Live');};
    connection.onmessage=event=>{if(!current())return;try{const data=JSON.parse(event.data);if(data.type==='snapshot')onSnapshot(data);}catch{onStatus('Stream error');}};
    connection.onclose=()=>{if(!current())return;onStatus('Reconnecting');timer=setTimeout(connect,Math.min(30000,1000*2**attempt++));};
    connection.onerror=()=>{if(current())connection.close();};
  }
  connect();return ()=>{closed=true;clearTimeout(timer);socket?.close();};
}
export class DeviceTransport {
  constructor({api,token,deviceId,onStatus=()=>{},onSent=()=>{},onRejected=()=>{}}){Object.assign(this,{api,token,deviceId,onStatus,onSent,onRejected});this.queue=[];this.running=false;this.enabled=false;this.generation=0;this.requests=new Set();}
  start(){if(this.enabled)return;this.enabled=true;++this.generation;this.heartbeat();this.timer=setInterval(()=>this.heartbeat(),15000);this.flush();}
  stop(){this.enabled=false;++this.generation;clearInterval(this.timer);this.queue=[];for(const controller of this.requests)controller.abort();this.requests.clear();this.running=false;this.heartbeatRunning=false;}
  async send(path,body,timeoutMs){
    const controller=new AbortController();this.requests.add(controller);
    const timeout=setTimeout(()=>controller.abort(),timeoutMs);
    try{return await request(path,{api:this.api,method:'POST',token:this.token,body,signal:controller.signal});}
    finally{clearTimeout(timeout);this.requests.delete(controller);}
  }
  async heartbeat(){
    if(!this.enabled||this.heartbeatRunning)return;
    const generation=this.generation;this.heartbeatRunning=true;
    try{await this.send('/api/devices/heartbeat',{device_id:this.deviceId},60000);if(!this.enabled||generation!==this.generation)return;this.onStatus('Connected');this.flush();}
    catch(error){if(this.enabled&&generation===this.generation){this.onStatus(error.name==='AbortError'?'Connection timed out. Retrying…':error.message);if([401,403].includes(error.status)){this.stop();this.onRejected(error.message,error.status);}}}
    finally{if(generation===this.generation)this.heartbeatRunning=false;}
  }
  enqueue(event){if(!this.enabled)return;this.queue.push({...event,device_id:this.deviceId,event_id:crypto.randomUUID()});if(this.queue.length>100)this.queue.shift();this.flush();}
  async flush(){if(this.running||!this.enabled)return;const generation=this.generation;this.running=true;
    try{while(this.queue.length&&this.enabled&&generation===this.generation){const event=this.queue[0];if(Date.now()/1000-event.timestamp>120){this.queue.shift();continue;}
      try{const result=await this.send('/api/telemetry/event',event,10000);if(!this.enabled||generation!==this.generation)return;if(this.queue[0]?.event_id===event.event_id)this.queue.shift();this.onStatus('Connected');if(result.accepted)this.onSent(result);}
      catch(error){if(!this.enabled||generation!==this.generation)return;this.onStatus(error.name==='AbortError'?'Report upload timed out. Retrying…':error.message);if([401,403].includes(error.status)){this.stop();this.onRejected(error.message,error.status);break;}if([400,413,415,422].includes(error.status)){if(this.queue[0]?.event_id===event.event_id)this.queue.shift();this.onRejected(error.message,error.status);continue;}break;}}
    }finally{if(generation===this.generation)this.running=false;}
  }
}
