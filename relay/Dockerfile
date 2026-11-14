# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
ARG TARGETOS TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/npi-relay . \
	&& mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/npi-relay /npi-relay
# A named volume mounted here inherits this ownership on first use.
COPY --from=build --chown=65532:65532 /out/data /data
ENV RELAY_LISTEN=:8787 RELAY_DB=/data/relay.db
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["/npi-relay", "healthcheck"]
ENTRYPOINT ["/npi-relay"]
