# 融合出口 broker

[English](README.md) | 中文

`proxy.mjs` 是分析 Job 网络上唯一具有外部路由的容器。Job 加入内部 Docker 网络（`dsh-fusion-egress`），并收到指向该 broker 的 `HTTP_PROXY`/`HTTPS_PROXY`。只有 `DSH_FUSION_EGRESS_ALLOWLIST` 中的精确 `host:port` 条目可达；其他目标一律拒绝。代理本身从不跟随重定向。

容器不发布端口、以 uid 1000 运行、丢弃全部 capability，并保持只读。白名单由管理员持有；绝不能从模型请求派生。

健康检查：内部网络上的 `GET /healthz`。

构建：

```bash
docker build -t dsh-fusion-broker:local deploy/integration/broker
```

部署 compose 会构建该服务，并把它连接到 `dsh-fusion-egress`（internal）与默认网络（出口）。除非 broker 已部署，否则保持 `DSH_INTEGRATION_JOB_NETWORK=none`，并设置 `DSH_INTEGRATION_EGRESS_BROKER_URL=http://fusion-broker:3128`。
