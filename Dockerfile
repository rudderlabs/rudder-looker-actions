# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# check=error=true

# The Node version must match .nvmrc. scripts/check-node-version.sh checks both files.
FROM node:24.22.1-alpine3.24@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d AS base
# Node uses its bundled root store. apk upgrade patches the OS packages and the system CA bundle for other tools.
RUN apk --no-cache upgrade && apk --no-cache add tini
# The build fails when the base image runs another Node version than .nvmrc.
COPY .nvmrc /tmp/.nvmrc
RUN test "$(node --version)" = "v$(tr -d '[:space:]' < /tmp/.nvmrc)" \
    || { echo "node $(node --version) does not match .nvmrc $(cat /tmp/.nvmrc)" >&2; exit 1; }
WORKDIR /code

FROM base AS deps
COPY package.json yarn.lock .yarnrc .npmrc ./
COPY .yarn ./.yarn
RUN yarn install --frozen-lockfile --production && yarn cache clean

# The server runs from src through ts-node. This stage only proves that the sources compile.
FROM deps AS build
COPY tsconfig.json tsconfig.npm.json ./
COPY src ./src
RUN yarn build

FROM base AS runtime
COPY --from=deps /code/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY public ./public
# bin/generate_key.ts makes the API key: yarn generate-api-key.
COPY bin ./bin
COPY --from=build /code/src ./src
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
# The node user (uid 1000) ships with the official image. The app files stay root-owned and read-only to it.
USER 1000:1000
CMD ["node", "./node_modules/ts-node/dist/bin.js", "./src/boot.ts"]
