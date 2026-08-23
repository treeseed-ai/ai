FROM python:3.12.14-slim-bookworm@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134
LABEL org.opencontainers.image.base.name="python:3.12.14-slim-bookworm" org.opencontainers.image.base.digest="sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134" org.treeseed-ai.upstream.hermes="0.18.2"
RUN apt-get update && apt-get install -y --no-install-recommends gosu patch && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 10001 hermes && pip install --no-cache-dir "https://files.pythonhosted.org/packages/0c/4c/91652c61450763bfe165c65b83026503de0ac9ddad2c11ee522490bf4c2d/hermes_agent-0.18.2-py3-none-any.whl#sha256=8f02155cfc84b28bd98551cd18dffec0efa9ec070dd08f90f1a850f1c779492f" && install -d -o hermes -g hermes /home/hermes/.hermes /workspace
COPY containers/lab/hermes-api-requirements.txt /tmp/hermes-api-requirements.txt
RUN pip install --no-cache-dir --no-deps --require-hashes -r /tmp/hermes-api-requirements.txt && python -c "import aiohttp; assert aiohttp.__version__ == '3.14.1'" && rm /tmp/hermes-api-requirements.txt
COPY containers/lab/hermes-password-auth.patch /tmp/hermes-password-auth.patch
COPY containers/lab/hermes-small-context.patch /tmp/hermes-small-context.patch
RUN patch -d /usr/local/lib/python3.12/site-packages -p1 < /tmp/hermes-password-auth.patch && patch -d /usr/local/lib/python3.12/site-packages -p1 < /tmp/hermes-small-context.patch && rm /tmp/hermes-password-auth.patch /tmp/hermes-small-context.patch
COPY containers/lab/treeai-web-plugin /usr/local/lib/python3.12/site-packages/plugins/web/treeai
COPY containers/lab/hermes-entrypoint.sh /usr/local/bin/hermes-entrypoint
RUN chmod 0755 /usr/local/bin/hermes-entrypoint
ENV HERMES_HOME=/home/hermes/.hermes HOME=/home/hermes
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/hermes-entrypoint"]
