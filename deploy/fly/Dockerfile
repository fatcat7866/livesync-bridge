# Fly.io image for the fatcat deployment (fork branch ignore-on-receive).
# Runs as root so the mounted volume (root-owned) is writable, and keeps the
# Deno localStorage (checkpoints: "since" per peer) on the volume so a restart
# resumes instead of re-reading every database from the first change.
FROM docker.io/denoland/deno:2.9.7
WORKDIR /app
COPY . .
RUN deno install --frozen
# Bridge + file API (fileapi/) as two processes; see deploy/fly/start.sh.
CMD ["bash", "deploy/fly/start.sh"]
