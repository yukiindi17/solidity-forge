FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
ENV NODE_ENV=production
EXPOSE 10000
USER node
CMD ["npm", "start"]