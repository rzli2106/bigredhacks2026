import { spawn } from 'node:child_process';
import { loadEnvironment } from './env.js';
await loadEnvironment();
const build=spawn(process.execPath,['scripts/build.js'],{stdio:'inherit'});
await new Promise((resolve,reject)=>{build.on('error',reject);build.on('exit',code=>code===0?resolve():reject(new Error('Build failed.')));});
const children=[spawn(process.execPath,['backend/main.js'],{stdio:'inherit'}),spawn(process.execPath,['scripts/serve.js'],{stdio:'inherit',env:{...process.env,PORT:process.env.FRONTEND_PORT??'5173'}})];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');process.exitCode=code;}
for(const child of children){child.on('error',error=>{console.error(error.message);stop(1);});child.on('exit',code=>{if(!stopping)stop(code??1);});}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
