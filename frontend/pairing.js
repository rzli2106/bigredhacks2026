/** Validate the server URL before it reaches fetch or WebSocket construction. */
export function readPairingLink(link) {
  let url;
  try { url = new URL(link); } catch { throw new Error('Paste the complete pairing link from Connect Phone.'); }
  const fragment = new URLSearchParams(url.hash.slice(1));
  const api = fragment.get('api'), token = fragment.get('token'), deviceId = fragment.get('device_id');
  if (!api || !token || !deviceId) throw new Error('Paste the complete link from Connect Phone.');
  let endpoint;
  try { endpoint = new URL(api); } catch { throw new Error('The pairing link contains an invalid server address.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    throw new Error('Use an HTTPS server. HTTP is allowed only on localhost.');
  }
  return { api: endpoint.origin, token, deviceId };
}
