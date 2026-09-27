# spicy3d-web: the static web app, as SpicySrv's compose expects it (SpicySrv deploy/README.md, Services):
# HTTP on port 8080, a non-root user, nothing written outside /tmp (runs with a read-only root file system).
#
#   docker build -t spicy3d-web:0.0.1 .
#   docker run --rm -p 8080:8080 --read-only --tmpfs /tmp --cap-drop ALL spicy3d-web:0.0.1
#
# The same image serves a LAN-only server and a public host: no server URL is baked in (the app finds the
# API on its own origin, /api/config), and per-deployment settings live in deployment.json (docs/deployment.md).

FROM node:24-alpine AS builder
WORKDIR /app
# Where the MCP panel links the bridge executables unless deployment.json says otherwise (docs/deployment.md).
ARG SPICY3D_BRIDGE_DOWNLOAD_URL
COPY . .
RUN npm ci --no-audit --no-fund && NODE_ENV=production npm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 8080
