# spicy3d-web: the static web app, as SpicySrv's compose expects it (SpicySrv deploy/README.md, Services):
# HTTP on port 8080, a non-root user, nothing written outside /tmp (runs with a read-only root file system).
#
# - `docker build .` (and `docker compose build`) builds the app from source (the last stage):
#     docker build -t spicy3d-web:0.0.1 .
#     docker run --rm -p 8080:8080 --read-only --tmpfs /tmp --cap-drop ALL spicy3d-web:0.0.1
# - `--target prebuilt --build-context dist=<folder>` packages an already built dist/ into the same
#   hardened runtime instead; the deploy workflow uses it to ship the exact files it tested and deployed
#   (.github/workflows/deploy.yml, ghcr.io/<owner>/<repo>).
#
# The same image serves a LAN-only server and a public host: no server URL is baked in (the app finds the
# API on its own origin, /api/config), and per-deployment settings live in deployment.json (docs/deployment.md).
# Base images are pinned by digest (multi-arch indexes; Dependabot keeps them current, .github/dependabot.yml).

# The output is static files: build on the build machine's platform, whatever platform the image targets.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
# Where the MCP panel links the bridge executables unless deployment.json says otherwise (docs/deployment.md).
ARG SPICY3D_BRIDGE_DOWNLOAD_URL
COPY . .
RUN npm ci --no-audit --no-fund && NODE_ENV=production npm run build

# The hardened nginx both targets share. No RUN: a multi-arch build needs no emulation.
FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6 AS runtime
# Origins plugins may be loaded from besides the app's own, and other origins the page may connect to (the
# assistant's LLM endpoints), space-separated (Content-Security-Policy, docs/security.md).
ENV SPICY3D_PLUGIN_ORIGINS="" \
    SPICY3D_CONNECT_ORIGINS="" \
    NGINX_ENVSUBST_FILTER="^SPICY3D_" \
    NGINX_ENVSUBST_OUTPUT_DIR=/tmp/conf.d
COPY --chmod=755 docker/19-spicy3d-plugin-origins.sh /docker-entrypoint.d/
COPY docker/default.conf.template /etc/nginx/templates/default.conf.template
# The server block is rendered into the tmpfs at start (templates above); this only includes it.
COPY <<EOF /etc/nginx/conf.d/default.conf
include /tmp/conf.d/*.conf;
EOF
EXPOSE 8080

FROM runtime AS prebuilt
COPY --from=dist . /usr/share/nginx/html

FROM runtime
COPY --from=build /app/dist /usr/share/nginx/html
