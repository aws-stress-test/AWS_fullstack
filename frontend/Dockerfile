FROM node:18-alpine

WORKDIR /app

# package.json과 .npmrc 파일을 먼저 복사
COPY package*.json .npmrc ./

# npm 설치 시 peer dependency 경고 무시
RUN npm install --legacy-peer-deps

# 나머지 소스 파일 복사
COPY . .

ARG NEXT_PUBLIC_API_URL=http://localhost:5000
ARG NEXT_PUBLIC_PASSWORD_SALT=akhsivheoifcoidh929u4934u8dfh883u9f9

RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]