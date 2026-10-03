import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  if (!['GET','HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (relative !== 'index.html' && !['src/', 'public/', 'node_modules/leaflet/dist/'].some((prefix) => relative.startsWith(prefix))) {
      response.writeHead(404); response.end('Not found'); return;
    }
    const file = resolve(root, relative);
    if (!file.startsWith(root) || relative.split('/').some((part) => part === '..' || part.startsWith('.')) || !types[extname(file)]) {
      response.writeHead(404); response.end('Not found'); return;
    }
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': `${types[extname(file)]}; charset=utf-8`, 'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(404); response.end('Not found');
  }
});
server.listen(Number(process.env.PORT ?? 5173), process.env.HOST ?? '127.0.0.1', () => console.log(`Waymark: http://${process.env.HOST ?? '127.0.0.1'}:${server.address().port}`));
