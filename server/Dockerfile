FROM node:18-alpine AS builder

LABEL maintainer="sms-forwarder"
LABEL description="SMS Forwarder MQTT Server with Web Dashboard"

WORKDIR /app

RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    && ln -sf /usr/bin/python3 /usr/bin/python

COPY package*.json ./

# Install full deps (incl. devDeps) to build frontend assets.
RUN npm install && npm cache clean --force

COPY backend.js ./
COPY database.js ./
COPY middleware/ ./middleware/
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY tailwind.config.js ./
COPY postcss.config.js ./

RUN npm run build:web


FROM node:18-alpine AS runner

WORKDIR /app

RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    && ln -sf /usr/bin/python3 /usr/bin/python

COPY package*.json ./

# Install production deps. better-sqlite3 is optional on build hosts but required at runtime.
RUN npm install --omit=dev && npm cache clean --force

COPY backend.js ./
COPY database.js ./
COPY middleware/ ./middleware/

# Only ship built frontend (fingerprinted assets)
COPY --from=builder /app/public/dist/ ./public/dist/

RUN mkdir -p /app/data

EXPOSE 34567

VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=34567
ENV TZ=Asia/Shanghai
ENV MQTT_HOST=192.168.31.197
ENV MQTT_PORT=1883
ENV DATA_DIR=/app/data

CMD ["node", "backend.js"]
