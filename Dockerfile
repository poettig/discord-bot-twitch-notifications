FROM docker.io/node:20-slim

COPY ./ /src

WORKDIR /src
RUN npm ci
CMD node app.js
