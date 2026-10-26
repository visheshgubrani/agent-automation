# Headful Chromium for the phase 05 browser agent (D041).
# Base: linuxserver Chromium (Selkies web view). Pinned by tag + digest; bump deliberately.
FROM lscr.io/linuxserver/chromium:2dba585f-ls60@sha256:f2d4b8b284918d8d65e10921e2fc84c57fd7edbc15345ddb3c024f0949f0031c

# socat forwards the container's CDP port to Chrome's loopback-only debugging port, because
# headful Chrome ignores --remote-debugging-address. The host publishes it on 127.0.0.1 only.
RUN apt-get update \
  && apt-get install -y --no-install-recommends socat \
  && rm -rf /var/lib/apt/lists/*

# Replaces the image's launcher: a dedicated profile (Chrome 136+ refuses remote debugging on
# the default profile) and no automation or stealth flags. The base launcher's --test-type is
# deliberately dropped.
COPY root/ /
RUN chmod 0755 /usr/bin/wrapped-chromium /etc/s6-overlay/s6-rc.d/svc-cdp-proxy/run
