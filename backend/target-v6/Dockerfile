FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "--expose-gc", "--max-old-space-size=450", "server.js"]
