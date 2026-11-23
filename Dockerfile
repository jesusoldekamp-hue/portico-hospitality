FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY agent ./agent
COPY sql ./sql

ENV NODE_ENV=production
ENV PORTICO_DEMO_MODE=false
ENV PORT=3080

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3080/api/health || exit 1

CMD ["node", "src/server.js"]
