# Deploy ClearPath at clearpath.wiki

The domain is registered at Porkbun. Render currently uses **www.clearpath.wiki** as the canonical host, with clearpath.wiki redirecting there. All production PUBLIC_* values must target www directly; redirects can break telemetry POSTs and WebSocket handshakes. The selected deployment is a single Render Docker web service named **clearpath** (provider URL `https://clearpath-z5nq.onrender.com`) serving the dashboard, `/mobile`, API and `/ws/stream`. Use the free instance for the hackathon; it can sleep after inactivity. No Vercel service is required for this deployment.

The checked-in `render.yaml` sets the www.clearpath.wiki HTTPS/WSS URLs, exact web/native CORS origins, and an automatically generated private observer key. `backend/main.js` also permits Render’s assigned HTTPS origin so the provider URL can be inspected while DNS propagates. Set the health probe to `/api/health`. Do not set `BACKEND_PORT` on Render.

Add `clearpath.wiki` under the service’s **Settings → Custom Domains**, then copy the exact DNS target displayed by Render into Porkbun. Update only the root parking record and the matching `www` parking record if adding that hostname; preserve mail and unrelated records. Wait until Render verifies DNS and issues a certificate. Test HTTPS root, `/mobile`, `/api/health`, direct device registration, and WSS before calling the deployment complete. Native builds use the same URLs; see `native/README.md`.

Production now deploys the tested `main` branch. After merging a feature or committing a minor fix, use **Manual Deploy → Deploy latest commit** and verify that the successful deployment's Source matches the intended main commit. Check the public `/mobile` route and `/api/health` after rollout. See `docs/ui-verification.md` for current test evidence and physical-device limitations.

The sections below retain local development and alternative split-host deployment instructions.

## Alternative hosting and local development

GoDaddy is **optional**. A Vercel `*.vercel.app` frontend and Render `*.onrender.com` backend provide HTTPS/WSS and support the standalone phone connection. No domain purchase, Google Maps key, or DNS change is needed for the hackathon.

## 1. Local development

Requires Node 20+ and npm. Install and start:

```sh
npm ci
npm run dev
```

Observer: http://127.0.0.1:5173. Backend: http://127.0.0.1:8000, including `/mobile`. `npm run dev` builds both interfaces and starts both services. Restart it after source edits; this lightweight server has no hot reload. If ports are occupied, use free ones:

```sh
BACKEND_PORT=8001 FRONTEND_PORT=5174 npm run dev
```

For a changed frontend port, add that exact localhost origin to `CORS_ORIGINS` in `.env`. Do not stop unrelated servers to free ports. See `.env.example`. Build assets live in ignored `dist/`.

## 2. Local phone sync over HTTPS

Install [ngrok from its official source](https://ngrok.com/download), create/configure your account, and run `ngrok config add-authtoken YOUR_TOKEN`. The token belongs in ngrok's configuration, not this repository. Stop an existing ClearPath dev server, then:

```sh
npm run sync:local
# If another project owns 8000:
BACKEND_PORT=8001 npm run sync:local
# Inspect the startup plan without opening a public tunnel:
npm run sync:local -- --dry-run
```

The utility builds the app, starts `ngrok http 8000` (or your `BACKEND_PORT`), discovers its HTTPS URL via the local ngrok API, starts the API and desktop observer, configures CORS and WSS, and prints the standalone `/mobile` URL. Open that URL on your phone. Ctrl+C stops both servers and the tunnel. A conflicting port, unavailable ngrok agent, missing auth, or startup timeout fails with a message.

Open the HTTPS phone URL and tap **Enable Navigation & Sensors**. Browsers require this explicit tap for motion permission. Approve location and motion, keep the page in the foreground, and walk inside Cornell coverage. Tap **Stop Sensors** to stop telemetry and discard unsent sensor reports. GPS navigation remains active until the page closes. HealthKit/Health Connect require the native build described in `native/README.md`; ordinary Safari/Chrome cannot read health stores.

The phone stores its device ID locally and obtains a four-hour scoped token directly from `POST /api/devices/register`. The token authenticates the first message on `/ws/device`; it never appears in the WebSocket URL. Raw motion streams over WSS, manual reports use authenticated HTTPS POST, and observers receive derived hazards over `/ws/stream`. Devices cannot resolve reports.

## 3. Render backend (HTTPS + WSS)

Use **New → Blueprint**, connect this repository, and select `render.yaml`. It builds the multi-stage `Dockerfile` and starts `node backend/main.js`. Alternatively, create a Docker Web Service manually. Render supplies `PORT`; bind `HOST=0.0.0.0`. **Do not set BACKEND_PORT in production**: it would override Render's assigned port.

Configure:

| Variable | Example / purpose |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `ADMIN_TOKEN` | Random secret, at least 32 characters; Blueprint generates one |
| `CORS_ORIGINS` | Exact comma-separated frontend origins, e.g. `https://clearpath-demo.vercel.app,capacitor://localhost,https://localhost` |
| `PUBLIC_API_URL` | `https://clearpath-api.onrender.com` |
| `PUBLIC_WS_URL` | `wss://clearpath-api.onrender.com/ws/stream` |
| `PUBLIC_MOBILE_URL` | `https://clearpath-demo.vercel.app/mobile` |

Replace examples with the actual URLs from your hosting dashboards. Do not include trailing slashes in origins. Add a Vercel preview origin explicitly if you want that preview to pair; CORS does not allow arbitrary preview domains. The health endpoint `/api/health` must return `ok: true`. WebSocket path: `/ws/stream`.

The service currently keeps reports, device sessions, and rate limits in memory. Restart/redeploy loses them. Use **one backend instance** for the hackathon; multiple replicas need a shared database/pubsub and session store. Render's free service may sleep or cold-start; wait for `/api/health` before testing. A paid always-on instance avoids that demo interruption. No production report retention/database is implied by these configs.

## 4. Vercel frontend

Import the repository into Vercel. `vercel.json` sets build command `npm run build`, output `dist`, and `/mobile → mobile.html`. Set these three **public** build variables:

```dotenv
PUBLIC_API_URL=https://clearpath-api.onrender.com
PUBLIC_WS_URL=wss://clearpath-api.onrender.com/ws/stream
PUBLIC_MOBILE_URL=https://clearpath-demo.vercel.app/mobile
```

Never add `ADMIN_TOKEN` to Vercel's public/build variables. After a URL/env change, redeploy the frontend and update/redeploy Render's matching variables. `dist/runtime-config.js` contains only these public URLs. A Render-only deployment also works: set `PUBLIC_MOBILE_URL=https://YOUR-SERVICE.onrender.com/mobile`, include that origin in CORS, and use its root observer page.

In production, dashboard report submission and verification require the observer key. Open **How ClearPath works** and enter `ADMIN_TOKEN` from Render into its password field. It remains in page memory and is never bundled or persisted; reload to clear it. Phone activation needs no observer key. The public observer stream includes derived hazard coordinates, penalties and device **counts**, never device identifiers or raw health values.

## 5. Optional custom domain, if registration becomes available

Only do this after both provider URLs work. Registering a domain is not required. In Vercel **Project → Settings → Domains**, add `yourdomain.com` and `www.yourdomain.com`. In GoDaddy **Domain → DNS**, add/update:

| Record | Name | Value |
| --- | --- | --- |
| A | `@` | **Copy the exact IPv4 target Vercel shows for this project** |
| CNAME | `www` | **Copy the exact CNAME target Vercel shows** |
| CNAME | `api` | Your Render service hostname, e.g. `clearpath-api.onrender.com` |

Do not paste `https://`, paths, or `/ws/stream` into DNS record values. Remove conflicting records for these names; preserve email MX/TXT records and unrelated names. Add `api.yourdomain.com` in Render **Settings → Custom Domains**, verify DNS, and wait for the TLS certificate. Vercel's displayed DNS targets can vary; do not reuse an old universal IP from a tutorial. Choose one canonical frontend hostname and redirect the other in Vercel.

Then set both hosts' public URLs to `https://api.yourdomain.com`, `wss://api.yourdomain.com/ws/stream`, and `https://yourdomain.com/mobile`; update Render CORS to the exact root/www origins you actually use, and redeploy. Test HTTPS `/mobile` and WSS before sharing the phone URL.

## 6. Verify the deployment as a user

1. Open the observer, wait for **Live**, and confirm real Cornell tiles/paths. Choose Starting point, drop A, choose Destination, drop B, then Find a walking route.
2. Run **Simulation → Run all four**. A detours 36 m → 62 m; B rejects bag tumble; C preserves after five swerves; D shows 25 / 12.5 / 3.125 m at 15 / 30 / 60 min and restores the direct path. Move the slider back to zero and inject each type by map click. Simulation must not appear in a second live observer.
3. Create a phone QR, scan it, Start Sensors, and use Report → choose a category → Confirm Report at a real Cornell GPS location. Every live observer should receive the pin and updated route. On desktop test **Still here** and **Mark resolved**.
4. Stop/restart phone sharing. Revoke location/motion permission and verify useful feedback plus map-pin manual fallback. Try an outside-campus position; it must not create an event. A desktop is not a substitute for device sensor testing.
5. `npm test`, `npm run simulate`, and `NODE_ENV=production npm run build` verify the local core. Check the hosted `/api/health`, CORS rejection for a wrong origin, fresh QR expiry, and WSS reconnect after a backend restart.

Map tiles are requested only for the visible map, with attribution and browser caching. The browser referrer policy is `strict-origin-when-cross-origin`; removing the referrer breaks OSM's tile policy. The graph is an independently shipped Cornell OSM snapshot, so transient tile failure still leaves paths/routing available. For sustained production traffic, choose a tile provider with the needed service guarantee and configure its URL/attribution rather than assuming the volunteer tile service has an SLA.

References: [Render web services](https://render.com/docs/web-services), [Render WebSockets](https://render.com/docs/websocket), [Vercel domains](https://vercel.com/docs/domains/working-with-domains/add-a-domain), [GoDaddy CNAME](https://www.godaddy.com/en/help/add-a-cname-record-19236), [ngrok agent](https://ngrok.com/docs/agent), [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/).
