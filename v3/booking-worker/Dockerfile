FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_ARTIFACT_DIR=/tmp/courtside-playwright

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 8787

CMD ["npm", "run", "start"]
