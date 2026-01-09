FROM node:22-bookworm AS build

WORKDIR /app

COPY package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json

RUN npm install

COPY server server
COPY web web
COPY README.md ./

RUN npm run build && npm prune --omit=dev --workspaces --include-workspace-root

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

WORKDIR /app/server

EXPOSE 3001

CMD ["node", "dist/index.js"]
