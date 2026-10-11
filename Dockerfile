# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS frontend
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/index.html web/tsconfig.json web/vite.config.ts ./
COPY web/src/ ./src/
COPY web/public/ ./public/
# Bound bundler workers on large build hosts.
RUN ROLLDOWN_WORKER_THREADS=2 ROLLDOWN_MAX_BLOCKING_THREADS=2 RAYON_NUM_THREADS=2 npm run build

FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/artiface/ ./cmd/artiface/
COPY internal/ ./internal/
COPY web/embed.go ./web/embed.go
COPY --from=frontend /src/web/dist/ ./web/dist/
ARG TARGETOS
ARG TARGETARCH
ARG ARTIFACE_GIT_COMMIT=unknown
RUN CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
    go build -trimpath -ldflags="-s -w -X artiface/internal/buildinfo.GitCommit=$ARTIFACE_GIT_COMMIT -X artiface/internal/buildinfo.BuildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        -o /out/artiface ./cmd/artiface

FROM debian:bookworm-slim AS runtime
LABEL org.opencontainers.image.licenses="Apache-2.0"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client poppler-utils util-linux \
    && rm -rf /var/lib/apt/lists/*
ARG ARTIFACE_UID=1000
ARG ARTIFACE_GID=1000
RUN groupadd --gid "$ARTIFACE_GID" artiface \
    && useradd --uid "$ARTIFACE_UID" --gid artiface --create-home \
        --home-dir /home/artiface --shell /usr/sbin/nologin --no-log-init artiface \
    && install -d -m 0700 -o artiface -g artiface /data /home/artiface
COPY --from=build /out/artiface /usr/local/bin/artiface
COPY LICENSE /usr/share/licenses/artiface/LICENSE
ENV HOME=/home/artiface \
    ARTIFACE_LISTEN=0.0.0.0:8787 \
    ARTIFACE_APP_ORIGIN=http://127.0.0.1:8787
WORKDIR /home/artiface
USER artiface:artiface
ENTRYPOINT ["artiface"]
CMD ["serve", "--config", "/data/config.json"]
