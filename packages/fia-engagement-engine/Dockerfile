FROM node:22-alpine AS builder

WORKDIR /app

# Build tools needed for native modules (baileys/libsignal)
RUN apk add --no-cache python3 make g++ git

COPY package.json ./
RUN yarn install
# Install baileys separately — native module, requires Linux to compile
RUN yarn add @whiskeysockets/baileys

COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/

RUN yarn build

FROM node:22-alpine

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Build metadata — surfaced in /health so we can verify which version is running
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ARG APP_VERSION=unknown
ENV GIT_SHA=$GIT_SHA \
    BUILD_TIME=$BUILD_TIME \
    APP_VERSION=$APP_VERSION \
    NODE_ENV=production

EXPOSE 3001

CMD ["node", "dist/index.js"]
