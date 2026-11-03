FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8792 \
    MYAPI_CONFIG=/app/channels.json

COPY package.json ./
COPY src ./src
COPY plugins ./plugins
COPY public ./public

EXPOSE 8792

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8792)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
