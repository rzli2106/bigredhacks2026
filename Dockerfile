FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY native/clearpath-health ./native/clearpath-health
RUN npm ci
COPY . .
ENV NODE_ENV=production
RUN npm run build
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000
COPY package*.json ./
COPY native/clearpath-health ./native/clearpath-health
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY backend ./backend
COPY src ./src
COPY scripts/env.js ./scripts/env.js
COPY public/cornell-osm.json ./public/cornell-osm.json
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","backend/main.js"]
