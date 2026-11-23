FROM node:22-bookworm-slim AS build-service
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc -p tsconfig.json

FROM build-service AS build-dashboard
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build-service /app/dist/ dist/
COPY --from=build-dashboard /app/dashboard/dist/ dashboard/dist/
COPY contracts/ contracts/
COPY examples/ examples/

EXPOSE 3000
ENV NODE_ENV=production HOST=0.0.0.0
CMD ["node", "--enable-source-maps", "dist/src/taskmarket/main.js"]
