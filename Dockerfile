FROM docker.io/node:24-slim

COPY ./ /src

WORKDIR /src
RUN npm ci
CMD npm run migrate-latest; node app.js
