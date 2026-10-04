FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
RUN addgroup -S -g 10001 app && adduser -S -D -H -u 10001 -G app app

USER 10001:10001
EXPOSE 8081
CMD ["node", "src/server.js"]
