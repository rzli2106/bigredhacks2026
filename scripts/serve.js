import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from './env.js';
await loadEnvironment();
const root=fileURLToPath(new URL('../dist/',import.meta.url));
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.map':'application/json','.wav':'audio/wav'};
createServer(async(request,response)=>{
  try{
    if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return;}
    const path=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
    if(path==='/runtime-config.js'){
      response.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});
      response.end(`window.ClearPathConfig=${JSON.stringify({apiBase:process.env.LOCAL_API_URL||process.env.PUBLIC_API_URL||`http://127.0.0.1:${process.env.BACKEND_PORT??8000}`,wsUrl:process.env.LOCAL_WS_URL??process.env.PUBLIC_WS_URL??'',mobileUrl:process.env.PUBLIC_MOBILE_URL??''})};`);return;
    }
    const relative=path==='/'?'index.html':['/mobile','/mobile/'].includes(path)?'mobile.html':path==='/api/cornell-map'?'public/cornell-osm.json':path.slice(1);
    if(relative.split('/').some(part=>part==='..'||part.startsWith('.'))||!types[extname(relative)])throw new Error('Not found');
    const file=resolve(root,relative);if(!file.startsWith(root))throw new Error('Not found');
    const data=await readFile(file);response.writeHead(200,{'Content-Type':types[extname(file)],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});response.end(request.method==='HEAD'?undefined:data);
  }catch{response.writeHead(404);response.end('Not found');}
}).listen(Number(process.env.PORT??5173),'127.0.0.1',()=>console.log(`ClearPath observer: http://127.0.0.1:${process.env.PORT??5173}`));
