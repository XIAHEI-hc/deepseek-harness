# 每用户 DSH Runtime 镜像（生产）。
#
# 镜像里只有一份只读的 DSH 代码与构建产物；每用户的数据（DSH_HOME/HOME/工作区/
# 技能/凭据/Session）全部位于容器挂载的独立卷中。用户容器不发布端口，只加入
# 平台私有网络，由 Gateway 通过内网 IP 访问。
#
# 构建（在联网的构建机执行，可离线分发 docker save 包）：
#   docker build -f deploy/runtime/Dockerfile -t dsh-runtime:<version> .
# 详见 deploy/scripts/build-image.sh 与 docs/standalone-w3/DEPLOYMENT.md。

FROM node:24-bookworm-slim AS build

# 原生依赖与构建工具；仅存在于构建阶段。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN corepack enable
# The image build context excludes .git, so the client build environment takes
# the source commit explicitly; build-image.sh passes the repository HEAD.
ARG DSH_CLIENT_COMMIT_HASH=0000000000000000000000000000000000000000
ENV DSH_CLIENT_COMMIT_HASH=$DSH_CLIENT_COMMIT_HASH
COPY . .
# 完整的 DSH 构建：host/client 产物与 Web 前端 dist。
RUN pnpm install --frozen-lockfile
RUN pnpm run build

# 运行时存在 tsx（Web 源码启动）与已构建的 Web 前端。
ENV NODE_ENV=development

FROM node:24-bookworm-slim

# The node image already ships uid/gid 1000 as the `node` user, which is the
# non-root identity every user runtime runs as. Space directories are mounted
# owned by 1000:1000; creating another user with that uid would collide.
WORKDIR /app
COPY --from=build /src /app
COPY deploy/runtime/entrypoint.sh /app/entrypoint.sh
RUN chmod 0555 /app/entrypoint.sh

ENV DSH_HOME=/data/dsh-home \
    HOME=/data/home \
    DSH_AGENTS_HOME=/data/agents-home \
    TMPDIR=/data/tmp \
    TSX_TSCONFIG_PATH=/app/tsconfig.json \
    NO_COLOR=1

# The supervisor appends the app arguments; the entrypoint resolves the loader
# and CLI absolutely because the container's cwd is the user workspace.
ENTRYPOINT ["/app/entrypoint.sh"]
USER 1000:1000
