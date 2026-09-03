FROM mcr.microsoft.com/playwright:v1.60.0-noble

# Instalar Brave Browser + dependências
RUN apt-get update && apt-get install -y --no-install-recommends     dumb-init gosu build-essential python3 curl gnupg2     && curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg     && echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" > /etc/apt/sources.list.d/brave-browser-release.list     && apt-get update     && apt-get install -y --no-install-recommends brave-browser     && rm -rf /var/lib/apt/lists/*

# Verificar que Brave tá instalado
RUN brave-browser --version

WORKDIR /app

COPY package*.json ./
RUN npm ci && npm cache clean --force

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN npm run build && npm prune --omit=dev

RUN mkdir -p /app/data /app/qwen_profiles /tmp/playwright     && chown -R pwuser:pwuser /app /tmp/playwright     && chmod +x /app/docker-entrypoint.sh

VOLUME ["/app/data", "/app/qwen_profiles"]

EXPOSE 3000
ENV NODE_ENV=production PORT=3000

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
