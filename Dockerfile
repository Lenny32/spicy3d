# Spicy3D web client: static files served by nginx.
#
# - `docker build .` (and compose.yml) builds the app from source.
# - `--target prebuilt --build-context dist=<folder>` packages an already built dist/ instead; the
#   deploy workflow uses it to ship the exact files it tested and deployed.

FROM node:24-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci && NODE_ENV=production npm run build

FROM nginx:alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

FROM runtime AS prebuilt
COPY --from=dist . /usr/share/nginx/html

FROM runtime
COPY --from=build /app/dist /usr/share/nginx/html
