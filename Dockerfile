FROM docker.io/node:24-trixie-lim

COPY ./ /src

WORKDIR /src
RUN npm ci
CMD npm run migrate-latest; node app.js
