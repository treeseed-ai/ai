FROM python:3.12.14-slim-bookworm@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134
LABEL org.opencontainers.image.base.name="python:3.12.14-slim-bookworm" org.opencontainers.image.base.digest="sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134"
RUN useradd --system --uid 10002 --home-dir /nonexistent --shell /usr/sbin/nologin webtool
COPY workers/lab_web_tool/worker.py /app/worker.py
USER 10002:10002
EXPOSE 8090
ENTRYPOINT ["python","/app/worker.py"]
