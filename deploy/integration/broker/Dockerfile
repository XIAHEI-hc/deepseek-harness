FROM node:24-alpine

RUN addgroup -g 1000 proxy \
 && adduser -D -u 1000 -G proxy proxy

WORKDIR /app
COPY proxy.mjs /app/proxy.mjs

USER 1000:1000
EXPOSE 3128
ENV NODE_ENV=production
ENTRYPOINT []
CMD ["node", "/app/proxy.mjs"]
