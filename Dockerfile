FROM node:20-alpine

WORKDIR /workspace

RUN mkdir -p /watch && mkdir -p /download && mkdir -p /in-progress && mkdir -p /completed

COPY package.json yarn.lock /workspace/
RUN yarn install --frozen-lockfile

ADD . /workspace

CMD yarn start