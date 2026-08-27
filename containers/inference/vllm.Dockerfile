ARG VLLM_IMAGE=vllm/vllm-openai:v0.25.0@sha256:fc56161ee42a011aeee78b65d0a81b6683c7d04402fd40503d14d4d6c98f07cb
FROM ${VLLM_IMAGE}
LABEL org.opencontainers.image.title="AI inference vLLM runtime" org.opencontainers.image.base.name="vllm/vllm-openai:v0.25.0" org.opencontainers.image.base.digest="sha256:fc56161ee42a011aeee78b65d0a81b6683c7d04402fd40503d14d4d6c98f07cb"
COPY containers/inference/vllm-entrypoint.sh /usr/local/bin/treeai-vllm
ENTRYPOINT ["/usr/local/bin/treeai-vllm"]
RUN DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
