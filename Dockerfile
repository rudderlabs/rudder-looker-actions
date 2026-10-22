# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# check=error=true

# The Node version must match .nvmrc. scripts/check-node-version.sh checks both files.
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base
# Node uses its bundled root store. ca-certificates-bundle 20261020 drops the eMudhra intermediates from the
# system CA store for other tools. apk refuses the install when no bundle at or above that version is available.
RUN apk --no-cache upgrade && apk --no-cache add tini 'ca-certificates-bundle>=20261020'
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
