export function configuration(){
  const config=window.PathPulseConfig??{},api=(config.apiBase||window.location.origin).replace(/\/$/,'');
  return {api,ws:config.wsUrl||`${api.replace(/^http/,'ws')}/ws/stream`,mobile:config.mobileUrl||`${window.location.origin}/mobile`};
}
export async function request(path,{method='GET',body,token,api=configuration().api}={}){
  const response=await fetch(`${api}${path}`,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();if(!response.ok){const error=new Error(result.error||`Request failed (${response.status}).`);error.status=response.status;throw error;}return result;
}
export function subscribe(onSnapshot,onStatus=()=>{}){
  let socket,timer,closed=false,attempt=0;
  function connect(){if(closed)return;onStatus('Connecting');socket=new WebSocket(configuration().ws);
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
