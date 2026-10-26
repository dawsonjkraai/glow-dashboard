#!/usr/bin/with-contenv bashio
# Glow Dashboard: the built panel and its services (server/serve.mjs), with the Supervisor's token.
#   8099  Home Assistant's sidebar (ingress)
#   8199  wall tablets on the home network, when the household gives it a port

export GLOW_ADDON=1
export GLOW_DATA=/data

if bashio::config.true 'no_sign_in'; then
  export GLOW_NO_SIGN_IN=1
  bashio::log.warning "No sign-in is on: any screen on your home network that opens the add-on's port controls your home as Home Assistant itself. Turn it off if guests or untrusted devices share your network."
fi

bashio::log.info "Starting Glow Dashboard"
exec node /app/server/serve.mjs --dir /app/www --port 8099 --lan-port 8199
