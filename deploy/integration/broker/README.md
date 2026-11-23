# Fusion egress broker

English | [中文](README.zh.md)

`proxy.mjs` is the only container with an external route on the analysis job
network. Jobs join an internal Docker network (`dsh-fusion-egress`) and receive
`HTTP_PROXY`/`HTTPS_PROXY` values pointing at this broker. Exact
`host:port` entries in `DSH_FUSION_EGRESS_ALLOWLIST` are reachable; every other
destination is refused. Redirects are never followed by the proxy itself.

The container has no published port, runs as uid 1000, drops all capabilities,
and is read-only. The allowlist is administrator-owned; never derive it from a
model request.

Health: `GET /healthz` on the internal network.

Build:

```bash
docker build -t dsh-fusion-broker:local deploy/integration/broker
```

The deployment compose file builds this service and connects it to
`dsh-fusion-egress` (internal) plus the default network (egress). Keep
`DSH_INTEGRATION_JOB_NETWORK=none` unless the broker is deployed, and set
`DSH_INTEGRATION_EGRESS_BROKER_URL=http://fusion-broker:3128`.
