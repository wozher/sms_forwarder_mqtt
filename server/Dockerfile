FROM node:18-alpine

LABEL maintainer="sms-forwarder"
LABEL description="SMS Forwarder MQTT Server with Web Dashboard"

WORKDIR /app

RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    && ln -sf /usr/bin/python3 /usr/bin/python

COPY package*.json ./

RUN npm install --only=production && \
    npm cache clean --force && \
    rm -rf /var/cache/apk/*

COPY backend.js ./
COPY database.js ./
COPY middleware/ ./middleware/
COPY routes/ ./routes/
COPY public/ ./public/

RUN mkdir -p data firmware

EXPOSE 34567

VOLUME ["/app/data", "/app/firmware"]

ENV NODE_ENV=production
ENV PORT=34567
ENV TZ=Asia/Shanghai
ENV MQTT_HOST=192.168.31.197
ENV MQTT_PORT=1883

CMD ["node", "backend.js"]
