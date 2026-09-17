FROM node:22-bookworm-slim

# curl for the insta installer; ca-certificates for Slack and the platform API
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The bot drives the agent box through `insta compute exec`, so it needs the CLI.
#
# Pinned to a release rather than piping install.sh, which resolves `latest`:
# v0.0.79 shipped only darwin-x64 and linux-arm64, so `latest` 404s on this
# x86_64 builder. A pinned version also keeps the build reproducible.
ARG INSTA_VERSION=v0.0.78
RUN curl -fsSL -o /tmp/insta.gz \
      "https://github.com/InsForge/instacloud-cli/releases/download/${INSTA_VERSION}/insta-linux-x64.gz" \
  && gunzip -c /tmp/insta.gz > /usr/local/bin/insta \
  && chmod +x /usr/local/bin/insta \
  && rm -f /tmp/insta.gz \
  && insta --version

WORKDIR /app
COPY package.json ./
COPY src ./src

# No dependencies to install: the bot is plain Node with node:http and node:crypto.
EXPOSE 8080
CMD ["node", "src/server.js"]
