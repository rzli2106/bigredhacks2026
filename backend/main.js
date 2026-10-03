import { createTelemetryServer } from './server.js';
import { loadEnvironment } from '../scripts/env.js';
await loadEnvironment();
if(process.env.NODE_ENV==='production'&&!process.env.ADMIN_TOKEN)throw new Error('ADMIN_TOKEN is required in production.');
const app=await createTelemetryServer({production:process.env.NODE_ENV==='production',adminToken:process.env.ADMIN_TOKEN,
  allowedOrigins:process.env.CORS_ORIGINS?.split(',').map(value=>value.trim()).filter(Boolean),
  publicApiUrl:process.env.PUBLIC_API_URL??'',publicWsUrl:process.env.PUBLIC_WS_URL??'',publicMobileUrl:process.env.PUBLIC_MOBILE_URL??''});
const address=await app.listen(Number(process.env.BACKEND_PORT??process.env.PORT??8000),process.env.HOST??'127.0.0.1');
console.log(`PathPulse API + phone app: http://${address.address}:${address.port}`);
console.log('Observer pairing on localhost is enabled. Remote pairing requires ADMIN_TOKEN.');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await app.close();process.exit(0);});
