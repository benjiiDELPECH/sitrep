FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3333
USER node
CMD ["node", "server.js"]
