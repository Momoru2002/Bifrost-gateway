# Node 24+ required — Bifrost uses node:sqlite (built into Node, stable
# from 24 onward) instead of a native-compiled SQLite driver, specifically
# so it doesn't need a C++ build toolchain either on bare metal or here.
FROM node:24-alpine

WORKDIR /app

# Install dependencies first so this layer is cached across rebuilds that
# only change application code.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# SQLite data lives here — mount a volume over this path (see
# docker-compose.yml) so it survives container recreation.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8787
ENV PORT=8787

CMD ["node", "server.js"]
