---
description: "Trusted-proxy identity provider that admits a DSH instance reached only through a gateway, replacing browser cookies with per-request signed assertions."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-authentication-gateway

English | [中文](README.zh.md)

## Summary

Use this package for a DSH instance a gateway owns: one instance per account, private-interface bound, reachable only through the gateway. The gateway signs one assertion per request and this provider verifies it against the configured key material, the audience, and the single served subject, then admits it as one owner Peer; cookies and the launch token play no part. Every request is authenticated again. Version 2 assertions add issuer, key id, generation binding, an assertion id for replay rejection, and optional Ed25519 verification.

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
| `algorithm` | `hmac-sha256` | Signature algorithm for version 2 assertions: `hmac-sha256` or `ed25519`. |
| `secret` | required for `hmac-sha256` | Shared HMAC secret with the gateway; at least 32 characters. |
| `publicKey` | — | PEM Ed25519 public key the gateway signs with. |
| `publicKeyFile` | — | Path to a PEM Ed25519 public key; used when `publicKey` is absent. |
| `keyId` | — | Signing key id version 2 assertions must carry; every other `kid` is refused. |
| `issuer` | — | Issuer version 2 assertions must carry; every other `iss` is refused. |
| `generation` | — | Runtime generation version 2 assertions must carry; every other `gen` is refused. |
| `replayWindowSeconds` | `0` | Seconds each accepted version 2 assertion id stays remembered; `0` accepts repeats. |
| `audience` | required | Deployment audience the gateway signs; one value per fleet. |
| `subject` | required | The identity-provider subject this instance serves; every other subject is refused. |
| `headerName` | `x-dsh-gateway-identity` | Header carrying the assertion. |
| `clockSkewSeconds` | `30` | Accepted difference between the gateway clock and this host. |
| `maxLifetimeSeconds` | `300` | Longest accepted `expiresAt - issuedAt` interval. |

Set `algorithm: ed25519` with `publicKey` or `publicKeyFile` to verify version 2 assertions with a public key; the gateway then signs with its private key and this instance never holds the HMAC secret. The config rejects an Ed25519 algorithm without a public key, an unparseable or non-Ed25519 key, and an HMAC algorithm without a secret of at least 32 characters at load.

The deployment must bind the listener to a private or loopback interface, name the browser-visible authority with `--trusted-host`, and strip the mount prefix before forwarding, as [publishing the Web UI behind a reverse proxy](../../../docs/user/guide/public-deployments.md) describes. The gateway attaches the assertion to every HTTP request and every WebSocket upgrade, and it is the only process that holds the signing key.

<a id="understand-the-implementation"></a>
## Understand the implementation

The wire form is `base64url(payloadJson utf8, no padding).base64url(signature, no padding)`. Version 1 signs the ASCII string `dsh-gateway-identity.1.<payload segment>` with HMAC-SHA256 and carries `v`, `aud`, `sub`, `sid`, `pv`, `iat`, and `exp`; `sid` and `pv` identify the gateway session and its permission version for logging only, because the instance makes no session decision of its own. Version 2 signs `dsh-gateway-identity.2.<payload segment>` with the configured algorithm and carries `v`, `iss`, `aud`, `sub`, `sid`, `pv`, `gen`, `iat`, `exp`, `jti`, and `kid`. Its payload is UTF-8 JSON with sorted keys and `,` and `:` separators, and its Ed25519 signature is a detached 64-byte signature over the same message bytes.

A signature over the version 1 framing always makes the assertion version 1, so a version 1 payload keeps its existing rejection under `algorithm: ed25519` and an unsupported `v` keeps the same reason it had before. Version 2 checks run in this order: signature, payload structure and version, audience, subject, configured issuer, configured key id, configured generation, lifetime bounds, remembered assertion id, not-yet-valid start, expiry. The signature is checked before any payload field influences a decision, and only an assertion that passed every check joins the replay window.

The replay window belongs to the loaded plugin instance: an accepted `jti` is remembered for `replayWindowSeconds`, expired entries are swept, and a reload starts empty. Memory therefore follows the accepted request rate times the window instead of the lifetime of the process. With `replayWindowSeconds: 0` the instance holds no ids and accepts repeats.

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

- The provider sees request headers only, so it cannot check the peer address. Trust rests on the listener binding a private interface and on the signing key staying with the gateway.
- Revocation applies to new requests: a WebSocket admitted before the gateway stopped signing stays open until it closes itself. The gateway owns closing live connections, which keeps this package free of session state.
- Version 1 assertions carry no replay rejection beyond `exp`, so a captured assertion is usable until it expires. Version 2 assertions are remembered for `replayWindowSeconds`; keep `maxLifetimeSeconds` short and forward over a private network either way.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The gateway that issues assertions for the PixLab workbench signs `dsh-gateway-identity.1.<segment>` with HMAC-SHA256 and attaches it as `x-dsh-gateway-identity`; version 2 assertions sign `dsh-gateway-identity.2.<segment>` with HMAC-SHA256 or an Ed25519 key over canonical JSON. Changing either canonical string or the header default is a breaking change for that issuer.

</details>
