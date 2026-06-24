FROM node:18-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

# Install ALL deps (incl. dev) so the Vite/Remix build can run. We set
# NODE_ENV=production only AFTER the build, otherwise `npm ci` skips
# devDependencies (vite, @remix-run/dev) and the build fails.
COPY package.json package-lock.json* ./
RUN npm ci --include=dev && npm cache clean --force

COPY . .

RUN npm run build

ENV NODE_ENV=production

# docker-start = `prisma generate && prisma migrate deploy` then `remix-serve`.
CMD ["npm", "run", "docker-start"]
