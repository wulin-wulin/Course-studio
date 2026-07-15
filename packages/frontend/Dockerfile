FROM node:20-alpine

WORKDIR /app

COPY packages/frontend/package.json ./
RUN npm install

COPY packages/frontend/ .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
