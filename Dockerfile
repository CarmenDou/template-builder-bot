FROM node:22-bookworm-slim

# curl for the insta installer; ca-certificates for Slack and the platform API
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The bot drives the agent box through `insta compute exec`, so it needs the CLI.
RUN curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh
ENV PATH="/root/.insta/bin:${PATH}"

WORKDIR /app
COPY package.json ./
COPY src ./src

# No dependencies to install: the bot is plain Node with node:http and node:crypto.
EXPOSE 8080
CMD ["node", "src/server.js"]
