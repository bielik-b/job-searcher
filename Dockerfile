FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY requirements.txt ./
RUN pip3 install --break-system-packages --no-cache-dir -r requirements.txt

COPY . .

ENV NODE_ENV=production
ENV BOT_MODE=webhook
ENV PORT=3000
ENV DATA_DIR=/data
ENV SQLITE_PATH=/data/job-searcher.sqlite
ENV PYTHON_BIN=python3

EXPOSE 3000

CMD ["npm", "run", "bot:webhook"]
