#!/bin/sh
# Runs before the image's 20-envsubst-on-templates.sh: SPICY3D_PLUGIN_ORIGINS ends up inside the
# Content-Security-Policy header of docker/default.conf.template, so only a space-separated list of
# origins (scheme://host[:port], host may start with "*.") is accepted; anything else stops the container.
set -eu
set -f # no pathname expansion of "*." origins

for origin in ${SPICY3D_PLUGIN_ORIGINS:-}; do
    if ! printf '%s\n' "$origin" | grep -Eq '^https?://(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:[0-9]{1,5})?$'; then
        echo "$0: SPICY3D_PLUGIN_ORIGINS: '$origin' is not an origin like https://plugins.example.com[:port]" >&2
        exit 1
    fi
done

# The rendered configuration goes to the tmpfs; /etc/nginx/conf.d/default.conf includes it.
mkdir -p /tmp/conf.d
