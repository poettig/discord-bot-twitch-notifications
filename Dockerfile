FROM docker.io/node:20-slim

COPY ./ /src

WORKDIR /src
RUN npm ci
RUN npm run migrate-latest
CMD node app.js
