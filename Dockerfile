# No browser — Node only (discord.js-selfbot + Gemini).
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY autoadvert.js ./

ENV NODE_ENV=production

CMD ["node", "autoadvert.js"]
