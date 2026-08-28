FROM ghcr.io/open-webui/open-webui:v0.11.0@sha256:72c0ba641ba75e7aa52655cb242570906ececd09b1140fb736483038a22b3228

LABEL org.opencontainers.image.title="TreeAI Open WebUI"
LABEL org.opencontainers.image.description="Pinned Open WebUI with the managed TreeAI Train Library action"

COPY deploy/lab/open-webui/ /opt/treeai/actions/
