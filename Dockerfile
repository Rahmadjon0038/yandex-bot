FROM node:20-alpine

WORKDIR /app

# Install deps first (better Docker layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY . .

ENV NODE_ENV=production

CMD ["node", "bot.js"]

