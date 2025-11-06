FROM node:20-alpine@sha256:1ab6fc5a31d515dc7b6b25f6acfda2001821f2c2400252b6cb61044bd9f9ad48

RUN mkdir -p /code
WORKDIR /code

COPY . /code

RUN yarn install --production && yarn cache clean
RUN yarn build

CMD ["yarn","start"]

EXPOSE 8080
