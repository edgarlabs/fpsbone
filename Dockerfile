# One image, one process, one port: the game server and the built client together.
#
# WHY THIS FILE EXISTS. A static host serves the client perfectly and cannot hold a WebSocket,
# so a build uploaded to one runs its own host inside each tab and every player is alone with
# the bots — see client/src/localserver.js. Real multiplayer needs one long-lived process that
# everybody's browser can reach, and this is that process packaged so that any host which
# takes a Dockerfile can run it: Fly, Render, Railway, Koyeb, a VPS, your own machine.
#
# The build step is `build:server`, not `build`, and that is the important line. It bakes
# VITE_SERVER=origin into the bundle, so the client dials a socket back at whatever host
# served it. A plain `build` produces the bots-only bundle instead, which would come up here
# and quietly refuse to let anyone meet.
#
#   docker build -t fpsbone .
#   docker run -p 8080:8080 fpsbone      then open http://localhost:8080
#
# PORT is read at startup (server/serve.js), which is how a cloud host routes 443 to this.
#
# Careers are the one thing that does not survive: ranks.json lives in the container's own
# filesystem, so a redeploy resets ranks and badges. Point FPSBONE_RANKS at a mounted volume
# to keep them.

FROM node:22-alpine

WORKDIR /app

# Dependencies first, on their own layer, so a source edit does not reinstall them. The build
# needs vite, so this is a full install rather than --omit=dev.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:server

ENV NODE_ENV=production
EXPOSE 8080

# Not `npm start` — that would rebuild the client on every container start. The image already
# has dist/ in it, so this runs the server and nothing else.
CMD ["node", "server/serve.js"]
