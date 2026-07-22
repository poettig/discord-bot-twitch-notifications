FROM docker.io/node:24-trixie-slim

COPY ./ /src

WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 && rm -rf /var/lib/apt/lists/*
RUN npm ci
CMD npm run migrate-latest; node app.js
