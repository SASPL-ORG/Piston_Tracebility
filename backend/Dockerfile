# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production stage
FROM node:20-alpine
WORKDIR /app
# Timezone database. Without this, alpine has no /usr/share/zoneinfo, so
# TZ=Asia/Kolkata is silently ignored and the container runs UTC — which
# makes the image matcher compare UTC-formatted mtimes against the PLC's
# IST wall-clock strings and NO_MATCH every image.
RUN apk add --no-cache tzdata
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/main.js"]
