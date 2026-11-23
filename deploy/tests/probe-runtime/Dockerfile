# Container-supervisor probe image.
#
# It is NOT the production runtime image: it only answers the readiness probe so
# deploy/scripts/verify-container-isolation.sh can exercise the real docker run
# argv (network, static IP, mounts, user, limits, probes) without building the
# full DSH runtime image. Base image must already be present locally.
FROM node:24-bookworm-slim
COPY entrypoint.mjs /entrypoint.mjs
RUN chmod 0444 /entrypoint.mjs
ENTRYPOINT ["node", "/entrypoint.mjs"]
