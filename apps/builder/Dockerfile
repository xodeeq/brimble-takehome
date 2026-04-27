FROM debian:bookworm-slim

# Install official Docker CE CLI + buildx (not docker.io — Debian's package may lack buildx,
# which Railpack needs to run its BuildKit client against the host daemon).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git tar \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*

# Download Railpack from GitHub releases (tarball, versioned filename).
# Detects architecture so the same Dockerfile works on amd64 and arm64.
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64) RAILPACK_ARCH="x86_64-unknown-linux-musl" ;; \
         arm64) RAILPACK_ARCH="arm64-unknown-linux-musl" ;; \
         *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
       esac \
    && RAILPACK_VERSION=$(curl -fsSL https://api.github.com/repos/railwayapp/railpack/releases/latest \
         | grep '"tag_name"' | sed 's/.*"tag_name": *"v\([^"]*\)".*/\1/') \
    && curl -fsSL \
         "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-${RAILPACK_ARCH}.tar.gz" \
         | tar -xz -C /usr/local/bin railpack \
    && chmod +x /usr/local/bin/railpack

WORKDIR /workspace
ENTRYPOINT ["railpack"]
