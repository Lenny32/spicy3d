#!/bin/sh
# Runs before the image's 20-envsubst-on-templates.sh: SPICY3D_PLUGIN_ORIGINS and SPICY3D_CONNECT_ORIGINS end up
# inside the Content-Security-Policy header of docker/default.conf.template, so only a space-separated list of
# origins (scheme://host[:port], host may start with "*.") is accepted; anything else stops the container.
set -eu
set -f # no pathname expansion of "*." origins

check() { # <variable name> <scheme pattern> <value>
    # The raw value goes into the header as is: nothing but origin characters and single spaces
    # (no tab, newline, quote or ';'), checked on the whole value before its words.
    case "$3" in
        *[!A-Za-z0-9:/.*\ -]* | *"  "*)
            echo "$0: $1: only origins separated by single spaces are accepted" >&2
            exit 1
            ;;
    esac
    for origin in $3; do
        # A wildcard needs at least two labels after "*." (https://*.example.com, never https://*.com).
        if ! printf '%s\n' "$origin" | grep -Eq "^$2://(\*\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+|[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*)(:[0-9]{1,5})?$"; then
            echo "$0: $1: '$origin' is not an origin like https://host.example.com[:port]" >&2
            exit 1
        fi
    done
}

check SPICY3D_PLUGIN_ORIGINS 'https?' "${SPICY3D_PLUGIN_ORIGINS:-}"
# What else the page may connect to (e.g. `?url=` file hosts): https, or wss for a socket.
check SPICY3D_CONNECT_ORIGINS '(https|wss)' "${SPICY3D_CONNECT_ORIGINS:-}"

# The rendered configuration goes to the tmpfs; /etc/nginx/conf.d/default.conf includes it.
mkdir -p /tmp/conf.d
