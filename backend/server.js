import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { buildWalkingGraph } from '../src/routing/index.js';
import { ApiError, TelemetryEngine } from './engine.js';
import { RawMotionReceiver } from './raw-motion.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.wav':'audio/wav'};
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function createTelemetryServer({ graph, now, allowedOrigins=['http://127.0.0.1:5173','http://localhost:5173','http://127.0.0.1:8000','http://localhost:8000'],
  adminToken=randomBytes(32).toString('hex'), production=false, publicApiUrl='', publicWsUrl='', publicMobileUrl='', staticRoot=resolve(root,'dist'), broadcastMs=5000,
  maxClients=100, pairLifetimeSeconds=14400 }={}) {
  if (production && adminToken.length<32) throw new Error('Production ADMIN_TOKEN must contain at least 32 characters.');
  if(production){for(const [value,protocol]of [[publicApiUrl,'https:'],[publicWsUrl,'wss:'],[publicMobileUrl,'https:']])if(value&&new URL(value).protocol!==protocol)throw new Error('Production public URLs require HTTPS/WSS.');}
  graph ??= buildWalkingGraph(JSON.parse(await readFile(resolve(root,'public/cornell-osm.json'),'utf8')));
  const engine=new TelemetryEngine(graph,{now});
  const rawMotion=new RawMotionReceiver(engine);
  const sessions=new Map(), limits=new Map(), origins=new Set(allowedOrigins);
  const websocket=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});
  const allowOrigin=origin=>!origin||origins.has(origin);
  const local=request=>!production&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress)&&
    /^((127\.0\.0\.1)|(localhost)|(\[::1\]))(:\d+)?$/.test(request.headers.host??'')&&!request.headers['x-forwarded-for']&&!request.headers['x-forwarded-host'];
  const bearer=request=>(request.headers.authorization??'').replace(/^Bearer /,'');
  function authorizeAdmin(request) { if (!local(request)&&!equal(bearer(request),adminToken)) throw new ApiError(401,'Enter the observer key configured as ADMIN_TOKEN to connect or verify devices.'); }
  function authorizeDevice(request,payload) {
    const token=bearer(request);
    if (equal(token,adminToken)) return;
    const session=sessions.get(token);
    if (!session||session.expiresAt<=engine.now()) throw new ApiError(401,'Pairing expired. Scan a new Connect Phone QR code.');
    if (payload.device_id!==session.deviceId) throw new ApiError(403,'This pairing belongs to another device.');
    session.lastSeen=engine.now();
  }
  function json(response,status,body) { response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(body)); }
  async function body(request) {
    let size=0;const parts=[];
    for await (const chunk of request) {size+=chunk.length;if(size>65536) throw new ApiError(413,'Payload exceeds 64 KB.');parts.push(chunk);}
    try {const value=JSON.parse(Buffer.concat(parts).toString());if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;} catch {throw new ApiError(400,'Expected a JSON object.');}
  }
  function devices() { return [...sessions.values()].filter(s=>s.expiresAt>engine.now()&&s.lastSeen!==null&&engine.now()-s.lastSeen<45).length; }
  function snapshot() {return {...engine.snapshot(),connected_devices:devices()};}
  function broadcast() {
    const payload=JSON.stringify(snapshot());
    for (const client of websocket.clients) {
      if (client.readyState!==1) continue;
      if (client.bufferedAmount>1024*1024) {client.terminate();continue;}
      client.send(payload);
    }
  }
  const server=createServer(async(request,response)=>{
    response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    const origin=request.headers.origin;
    if (!allowOrigin(origin)) {json(response,403,{error:'Origin is not allowed.'});return;}
    if(origin){response.setHeader('Access-Control-Allow-Origin',origin);response.setHeader('Vary','Origin');}
    response.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
    response.setHeader('Access-Control-Max-Age','600');
    response.setHeader('Permissions-Policy','accelerometer=(self), gyroscope=(self), geolocation=(self)');
    if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
    try {
      const url=new URL(request.url,'http://localhost'),path=url.pathname;
      if (path.startsWith('/api/') && request.method==='POST') {
        if (!request.headers['content-type']?.startsWith('application/json')) throw new ApiError(415,'Use application/json.');
        const raw=path==='/api/telemetry/raw';
        const key= `${raw?'raw':'api'}:${request.socket.remoteAddress}:${bearer(request).slice(0,64)}`;
        const previous=limits.get(key),at=engine.now();
        const bucket=previous&&at-previous.start<60?previous:{start:at,count:0};bucket.count++;limits.set(key,bucket);
        if(bucket.count>(raw?1500:120)) throw new ApiError(429,'Too many requests. Retry in a minute.');
      }
      if(path==='/api/health' && request.method==='GET'){json(response,200,{ok:true,service:'PathPulse',edges:graph.edges.size});return;}
      if(path==='/api/cornell-map' && request.method==='GET'){
        response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'public, max-age=300'});response.end(await readFile(resolve(root,'public/cornell-osm.json')));return;
      }
      if(path==='/api/telemetry/snapshot'&&request.method==='GET'){json(response,200,snapshot());return;}
      if(path==='/api/pairing'&&request.method==='POST') {
        authorizeAdmin(request); const data=await body(request);
        const fallback=publicMobileUrl||`${origin??publicApiUrl??''}/mobile`;
        let mobile;try{mobile=new URL(data.mobile_url||fallback);}catch{throw new ApiError(400,'Configure PUBLIC_MOBILE_URL or supply mobile_url.');}
        if(mobile.pathname!=='/mobile'||mobile.search||mobile.hash||!origins.has(mobile.origin)||
          (mobile.protocol!=='https:'&&!local(request))) throw new ApiError(400,'Pairing must point to /mobile on an allowed HTTPS frontend (localhost is allowed in development).');
        const token=randomBytes(32).toString('base64url'),deviceId=randomUUID(),expiresAt=engine.now()+pairLifetimeSeconds;
        if (sessions.size>=500) throw new ApiError(429,'Pairing capacity reached.');
        sessions.set(token,{deviceId,expiresAt,lastSeen:null});
        const api=publicApiUrl || `${local(request)?'http':'https'}://${request.headers.host}`;
        mobile.hash=new URLSearchParams({token,device_id:deviceId,api}).toString();
        json(response,201,{url:mobile.href,device_id:deviceId,expires_at:expiresAt});return;
      }
      if(path==='/api/devices/heartbeat'&&request.method==='POST'){
        const data=await body(request);authorizeDevice(request,data);json(response,200,{ok:true});return;
      }
      if(path==='/api/telemetry/manual'&&request.method==='POST'){
        authorizeAdmin(request);const data=await body(request);if(data.source!=='manual')throw new ApiError(400,'Observer reports must use manual source.');
        const result=engine.ingest({...data,device_id:'observer-manual'});json(response,201,result);broadcast();return;
      }
      if(path==='/api/telemetry/event'&&request.method==='POST'){
        const data=await body(request);authorizeDevice(request,data);const result=engine.ingest(data);
        json(response,result.accepted?201:200,result);if(result.accepted&&!result.duplicate)broadcast();return;
      }
      if(path==='/api/telemetry/raw'&&request.method==='POST'){
        const data=await body(request);authorizeDevice(request,data);const revision=engine.revision;
        try {const result=rawMotion.ingest(data);json(response,200,result);}
        finally {if(engine.revision!==revision)broadcast();}
        return;
      }
      if(path==='/api/telemetry/passage'&&request.method==='POST'){
        const data=await body(request);authorizeDevice(request,data);const result=engine.passage(data);json(response,200,result);broadcast();return;
      }
      if(path==='/api/telemetry/verify'&&request.method==='POST'){
        authorizeAdmin(request);const data=await body(request);const result=engine.verify(data.id,data.action);json(response,200,result);broadcast();return;
      }
      if(path==='/api/route'&&request.method==='POST'){
        const data=await body(request);try{const result=engine.route(data.from,data.to);json(response,200,result);}catch(error){throw new ApiError(400,error.message);}return;
      }
      if(path==='/api/route/options'&&request.method==='POST'){
        const data=await body(request);try{json(response,200,engine.routeOptions(data.from,data.to));}catch(error){throw new ApiError(400,error.message);}return;
      }
      if(path==='/runtime-config.js'&&request.method==='GET'){
        response.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});
        response.end(`window.PathPulseConfig=${JSON.stringify({apiBase:publicApiUrl,wsUrl:publicWsUrl,mobileUrl:publicMobileUrl})};`);return;
      }
      if(!['GET','HEAD'].includes(request.method))throw new ApiError(405,'Method not allowed.');
      const relative=path==='/'?'index.html':path==='/mobile'||path==='/mobile/'?'mobile.html':decodeURIComponent(path).slice(1);
      if(relative.split('/').some(part=>part==='..'||part.startsWith('.')))throw new ApiError(404,'Not found.');
      const file=resolve(staticRoot,relative);
      if(!file.startsWith(`${staticRoot}/`)||!MIME[extname(file)]||!(await stat(file)).isFile())throw new ApiError(404,'Not found.');
      response.writeHead(200,{'Content-Type':MIME[extname(file)],'Cache-Control':'no-cache'});response.end(request.method==='HEAD'?undefined:await readFile(file));
    }catch(error){json(response,error instanceof ApiError?error.status:error.code==='ENOENT'?404:500,{error:error instanceof ApiError?error.message:error.code==='ENOENT'?'Not found.':'Server could not process the request.'});}
  });
  server.on('upgrade',(request,socket,head)=>{
    if(new URL(request.url,'http://localhost').pathname!=='/ws/stream'||!allowOrigin(request.headers.origin)||websocket.clients.size>=maxClients){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    websocket.handleUpgrade(request,socket,head,client=>{websocket.emit('connection',client,request);});
  });
  websocket.on('connection',client=>{
    client.alive=true;client.on('error',()=>{});client.on('pong',()=>{client.alive=true;});
    client.send(JSON.stringify(snapshot()));
  });
  const timer=setInterval(()=>{
    rawMotion.prune();
    for(const[token,session]of sessions)if(session.expiresAt<=engine.now())sessions.delete(token);
    for(const[key,bucket]of limits)if(engine.now()-bucket.start>60)limits.delete(key);
    if(engine.metadata.size||websocket.clients.size)broadcast();
  },broadcastMs);timer.unref();
  const ping=setInterval(()=>{for(const client of websocket.clients){if(!client.alive){client.terminate();continue;}client.alive=false;client.ping();}},30000);ping.unref();
  return {server,engine,broadcast,adminToken,listen:(port=8000,host='127.0.0.1')=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.removeListener('error',reject);const address=server.address();if(!production){origins.add(`http://127.0.0.1:${address.port}`);origins.add(`http://localhost:${address.port}`);}resolve(address);});}),
    close:async()=>{clearInterval(timer);clearInterval(ping);engine.dispose();for(const client of websocket.clients)client.terminate();await new Promise(resolve=>websocket.close(resolve));if(server.listening)await new Promise(resolve=>server.close(resolve));}};
}
