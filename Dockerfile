# spicy3d-web: the static web app, as SpicySrv's compose expects it (SpicySrv deploy/README.md, Services):
# HTTP on port 8080, a non-root user, nothing written outside /tmp (runs with a read-only root file system).
#
#   docker build -t spicy3d-web:0.0.1 .
#   docker run --rm -p 8080:8080 --read-only --tmpfs /tmp --cap-drop ALL spicy3d-web:0.0.1
#
# The same image serves a LAN-only server and a public host: no server URL is baked in (the app finds the
# API on its own origin, /api/config), and per-deployment settings live in deployment.json (docs/deployment.md).
# Base images are pinned by digest (Dependabot keeps them current, .github/dependabot.yml).

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder
WORKDIR /app
# Where the MCP panel links the bridge executables unless deployment.json says otherwise (docs/deployment.md).
ARG SPICY3D_BRIDGE_DOWNLOAD_URL
COPY . .
RUN npm ci --no-audit --no-fund && NODE_ENV=production npm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6
# Origins plugins may be loaded from besides the app's own, space-separated (Content-Security-Policy).
ENV SPICY3D_PLUGIN_ORIGINS="" \
    NGINX_ENVSUBST_FILTER="^SPICY3D_" \
    NGINX_ENVSUBST_OUTPUT_DIR=/tmp/conf.d
COPY --chmod=755 docker/19-spicy3d-plugin-origins.sh /docker-entrypoint.d/
COPY docker/default.conf.template /etc/nginx/templates/default.conf.template
# The server block is rendered into the tmpfs at start (templates above); this only includes it.
COPY <<EOF /etc/nginx/conf.d/default.conf
include /tmp/conf.d/*.conf;
EOF
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 8080
