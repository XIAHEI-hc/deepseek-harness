# 平台服务镜像：只包含平台代码（无第三方运行时依赖）与 docker CLI。
#
# 平台进程需要执行 docker 命令来管理用户 Runtime，因此从 docker:29-cli 复制 CLI；
# 用户 Runtime 容器不包含该 CLI、socket 或平台密钥。
FROM docker:29-cli AS dockercli

FROM node:24-bookworm-slim

WORKDIR /app
# docker CLI 供 supervisor 的 container 后端使用；dockerd 不在此镜像内。
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
# 平台代码使用 Node 24 原生 TypeScript type stripping 直接运行，无需构建。
COPY services/platform ./services/platform
# PostgreSQL 身份库驱动（平台服务自己的 package.json，不属于 pnpm workspace）。
RUN cd services/platform && npm ci --omit=dev --no-audit --no-fund
COPY deploy/runtime/platform-runtime.patch.yml ./deploy/runtime/platform-runtime.patch.yml

ENV NODE_ENV=production
EXPOSE 8080
ENTRYPOINT []
CMD ["node", "services/platform/src/main.ts"]
