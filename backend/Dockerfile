# Dockerfile
FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy app source
COPY . .

# Build step if needed (uncomment if you have build scripts)
# RUN npm run build

ENV NODE_ENV=production
EXPOSE 5000

CMD ["node", "server.js"]
