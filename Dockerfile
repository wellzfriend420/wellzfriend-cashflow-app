ARG NODE_IMAGE=node:24.18.0-bookworm-slim
FROM ${NODE_IMAGE}
ENV NODE_ENV=production TZ=Asia/Tokyo
WORKDIR /app
COPY --chown=node:node package.json index.html login.html ./
COPY --chown=node:node src ./src
COPY --chown=node:node assets ./assets
COPY --chown=node:node tools ./tools
USER node
EXPOSE 3000
CMD ["node", "src/server.cjs"]
