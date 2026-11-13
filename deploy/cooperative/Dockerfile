# Cooperative central service image. Build context is the repository root.
FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY src ./src
COPY tsconfig.json ./
# Containers run as the installing user's uid; source files from a 0600 checkout must stay readable.
RUN chmod -R a+rX /app
ENTRYPOINT ["bun", "src/central/cooperative-service.ts"]
CMD ["serve"]
