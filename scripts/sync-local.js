import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import QRCode from 'qrcode-terminal';
import {loadEnvironment} from './env.js';
await loadEnvironment();
const apiPort=Number(process.env.BACKEND_PORT??8000),frontPort=Number(process.env.FRONTEND_PORT??5173);
if(process.argv.includes('--dry-run')){console.log(`Plan: build → ngrok http ${apiPort} → API:${apiPort} + observer:${frontPort} → paired HTTPS /mobile QR. Requires ngrok installed and authenticated. No tunnel started.`);process.exit(0);}
const children=[];let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');process.exitCode=code;}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
function launch(command,args,env=process.env){const child=spawn(command,args,{stdio:'inherit',env});children.push(child);child.on('error',error=>{console.error(`${command}: ${error.message}. Install ngrok and run ngrok config add-authtoken first.`);stop(1);});child.on('exit',code=>{if(!stopping)stop(code??1);});return child;}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function unused(port){return new Promise(resolve=>{const socket=createConnection({port,host:'127.0.0.1'});socket.on('connect',()=>{socket.destroy();resolve(false);});socket.on('error',()=>resolve(true));});}
async function waitFor(get,seconds=30){for(let i=0;i<seconds*4&&!stopping;i++){try{const result=await get();if(result)return result;}catch{}await delay(250);}throw new Error('Startup timed out. Check the preceding server/ngrok output.');}
try{
  for(const port of [apiPort,frontPort])if(!await unused(port))throw new Error(`Port ${port} is in use. Stop your existing PathPulse server or set BACKEND_PORT / FRONTEND_PORT to free ports.`);
  // Build before starting the persistent children.
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['scripts/build.js'],{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Build failed.')));});
  launch('ngrok',['http',String(apiPort),'--log','stdout']);
  const tunnel=await waitFor(async()=>{const result=await fetch('http://127.0.0.1:4040/api/tunnels');const data=await result.json();return data.tunnels.find(item=>item.public_url.startsWith('https://')&&String(item.config.addr).endsWith(`:${apiPort}`))?.public_url;});
  const env={...process.env,BACKEND_PORT:String(apiPort),HOST:'127.0.0.1',NODE_ENV:'development',PUBLIC_API_URL:tunnel,PUBLIC_WS_URL:`${tunnel.replace('https:','wss:')}/ws/stream`,PUBLIC_MOBILE_URL:`${tunnel}/mobile`,
    LOCAL_API_URL:`http://127.0.0.1:${apiPort}`,LOCAL_WS_URL:`ws://127.0.0.1:${apiPort}/ws/stream`,CORS_ORIGINS:[`http://127.0.0.1:${frontPort}`,`http://localhost:${frontPort}`,tunnel,'capacitor://localhost','https://localhost'].join(',')};
  launch(process.execPath,['backend/main.js'],env);launch(process.execPath,['scripts/serve.js'],{...env,PORT:String(frontPort)});
  await waitFor(async()=>(await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok);
  const response=await fetch(`http://127.0.0.1:${apiPort}/api/pairing`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mobile_url:`${tunnel}/mobile`})});
  const data=await response.json();if(!response.ok)throw new Error(data.error);
  console.log(`\nObserver: http://127.0.0.1:${frontPort}/\nScan with your phone, then tap Start sharing. The pairing expires in four hours.\n`);QRCode.generate(data.url,{small:true});console.log(data.url);
  console.log('\nCtrl+C stops the API, observer, and public tunnel.');
}catch(error){console.error(error.message);stop(1);}
