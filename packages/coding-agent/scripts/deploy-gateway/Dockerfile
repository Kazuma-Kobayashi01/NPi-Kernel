FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 procps libstdc++6 libssl3t64 \
    && rm -rf /var/lib/apt/lists/* \
    && (getent passwd 1000 || useradd --uid 1000 --create-home worker)
COPY npi /usr/local/bin/npi
RUN chmod 0755 /usr/local/bin/npi
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/npi"]
