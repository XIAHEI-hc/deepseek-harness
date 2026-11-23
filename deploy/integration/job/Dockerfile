# Analysis job image.
#
# The platform clears the image entrypoint and runs `/bin/sh /scratch/run.sh`
# or `python3 /scratch/run.py` from a read-only root. The image therefore needs
# only a shell, and Python for `language: "python"` jobs. It never receives a
# token, host path, or network route beyond `--network none`.
FROM python:3.12-alpine

RUN addgroup -g 1000 job \
 && adduser -D -u 1000 -G job job

USER 1000:1000
WORKDIR /work
ENV HOME=/scratch
ENV TMPDIR=/tmp

# The runner passes `--entrypoint ''`; declaring none keeps local `docker run`
# behavior identical.
ENTRYPOINT []
