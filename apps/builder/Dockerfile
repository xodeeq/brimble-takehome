FROM debian:bookworm-slim

# Install official Docker CE CLI + buildx (not docker.io — Debian's package may lack buildx,
# which Railpack needs to run its BuildKit client against the host daemon).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*

# Download Railpack binary directly from GitHub releases.
# Note: URL uses railpack-linux-amd64; adjust to railpack-linux-arm64 for ARM hosts.
# For production, switch to `railpack prepare` + custom BuildKit frontend for
# cache-key isolation across tenants and parallel build throughput.
RUN curl -fsSL \
      https://github.com/railwayapp/railpack/releases/latest/download/railpack-linux-amd64 \
      -o /usr/local/bin/railpack \
    && chmod +x /usr/local/bin/railpack

WORKDIR /workspace
ENTRYPOINT ["railpack"]
