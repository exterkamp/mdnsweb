FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --only=production

COPY server.js ./
COPY public/ ./public/

ENV PORT=8090
EXPOSE 8090
EXPOSE 5353/udp

CMD ["node", "server.js"]
