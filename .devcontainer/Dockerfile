FROM ubuntu:26.04

ARG DEBIAN_FRONTEND=noninteractive

RUN rm -f /etc/dpkg/dpkg.cfg.d/excludes

# Install dependencies
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    dpkg \
    jq \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Install Bun
SHELL ["/bin/bash", "-c"]
RUN set -euo pipefail; \
    case "$(dpkg --print-architecture)" in \
        amd64) bun_arch=x64 ;; \
        arm64) bun_arch=aarch64 ;; \
        *) echo "unsupported arch for bun" >&2; exit 1 ;; \
    esac; \
    url="$(curl -fsSL https://api.github.com/repos/oven-sh/bun/releases/latest \
        | jq -r --arg n "bun-linux-${bun_arch}.zip" '.assets[] | select(.name==$n) | .browser_download_url')"; \
    test -n "$url"; \
    curl -fsSL "$url" -o /tmp/bun.zip; \
    unzip -q /tmp/bun.zip -d /tmp/bun; \
    install -m 0755 "/tmp/bun/bun-linux-${bun_arch}/bun" /usr/local/bin/bun; \
    rm -rf /tmp/bun /tmp/bun.zip; \
    bun --version
