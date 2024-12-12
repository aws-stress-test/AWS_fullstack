FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

ARG NODE_ENV
ENV NODE_ENV=$NODE_ENV

EXPOSE 5000

CMD ["node", "server.js"] 