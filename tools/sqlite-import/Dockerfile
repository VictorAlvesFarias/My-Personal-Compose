# syntax=docker/dockerfile:1
FROM node:24-alpine
WORKDIR /tool

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY import.mjs ./
# node:sqlite is built in (experimental in Node 24: hide the warning).
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "import.mjs"]
