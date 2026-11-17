---
description: "Trusted-proxy identity provider that admits a DSH instance reached only through a gateway, replacing browser cookies with per-request signed assertions."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-authentication-gateway

English | [中文](README.zh.md)

## Summary

Use this package for a DSH instance that a gateway owns: one instance per account, bound to a private interface, reachable only through the gateway that already authenticated the browser. The gateway signs one assertion per request; this provider verifies it against a shared secret, the deployment audience, and the single subject the instance serves, then admits the request as one owner Peer. Browser cookies and the launch token play no part, because the browser never reaches the listener directly. Every request is authenticated again, so a gateway that stops signing ends access without touching the instance process.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it in a Web composition beside Connection, and disable the default token provider so cookies cannot bypass the gateway. A profile patch does both:

```yaml
- id: authentication-token
  disabled: true
- insert:
    - id: authentication-gateway
      name: '@deepseek-ai/dsh-host-authentication-gateway'
      config:
        secret: ${DSH_WORKBENCH_GATEWAY_SECRET}
        audience: pixlab-prod
        subject: user-a
```

| Field | Default | Meaning |
|---|---|---|
| `secret` | required | Shared HMAC secret with the gateway; at least 32 characters. |
| `audience` | required | Deployment audience the gateway signs; one value per fleet. |
| `subject` | required | The identity-provider subject this instance serves; every other subject is refused. |
| `headerName` | `x-dsh-gateway-identity` | Header carrying the assertion. |
| `clockSkewSeconds` | `30` | Accepted difference between the gateway clock and this host. |
| `maxLifetimeSeconds` | `300` | Longest accepted `expiresAt - issuedAt` interval. |

The deployment must bind the listener to a private or loopback interface, name the browser-visible authority with `--trusted-host`, and strip the mount prefix before forwarding, as [publishing the Web UI behind a reverse proxy](../../../docs/user/guide/public-deployments.md) describes. The gateway attaches the assertion to every HTTP request and every WebSocket upgrade, and it is the only process that knows the secret.

<a id="understand-the-implementation"></a>
## Understand the implementation

The assertion is `base64url(payload).base64url(HMAC-SHA256)` over `dsh-gateway-identity.1.<payload segment>`. The payload carries `v`, `aud`, `sub`, `sid`, `pv`, `iat`, and `exp`; `sid` and `pv` identify the gateway session and its permission version for logging only, because the instance makes no session decision of its own. Verification rejects a malformed segment, a signature mismatch, an unsupported version or field type, a foreign audience or subject, a lifetime longer than the configured maximum, and a start or expiry outside the clock skew, in that order. The signature is checked before any payload field influences a decision.

A verified request gets the single owner Peer this plugin creates at load. One Peer per instance is what makes approvals, user questions, and forwarded waterfalls work: the gateway already resolved the browser to this subject, and a second identity inside one instance has no meaning. The registration lives on `connection.authentication`, so HTTP routes and upgrade admission share it.

<a id="further-exploration"></a>
## Further Exploration

- [Connection](../../client/connection/README.md) — the `connection.authentication` registry, Peer admission, and the `trustedHosts` fence.
- [Default token authentication](../authentication-token/README.md) — the launch token and browser cookie this plugin replaces.
- [Web server](../webserver/README.md) — request and upgrade admission.
- [Publish the Web UI behind a reverse proxy](../../../docs/user/guide/public-deployments.md) — what the front proxy must do.

<a id="model-experience"></a>
## Model Experience

None, as the plugin authenticates HTTP callers and contributes no model input.

#### KV Cache effect

None; authentication does not modify model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The provider sees request headers only, so it cannot check the peer address. Trust rests on the listener binding a private interface and on the secret staying with the gateway.
- Revocation applies to new requests: a WebSocket admitted before the gateway stopped signing stays open until it closes itself. The gateway owns closing live connections, which keeps this package free of session state.
- The assertion carries no replay window beyond `exp`; a captured assertion is usable until it expires. Keep `maxLifetimeSeconds` short and forward over a private network.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The gateway that issues assertions for the PixLab workbench signs `dsh-gateway-identity.1.<segment>` with HMAC-SHA256 and attaches it as `x-dsh-gateway-identity`. Changing the canonical string or the header default is a breaking change for that issuer.

</details>
