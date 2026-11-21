# AWS publishes no prebuilt image for AWS Emulator; this is the Dockerfile from
# "Getting started with Docker" in its user guide. `task emulator:install` builds
# it on macOS and Windows, where there is no native package, and local/stack.mjs
# runs a fresh container of it for each run.
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
# The versioned package to install, e.g. aws-emulator-1.0.365-1-x86_64.rpm;
# `task emulator:install` passes the version pinned in Taskfile.yml.
ARG PACKAGE
ADD https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/${PACKAGE} /tmp/aws-emulator.rpm
RUN rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm \
    && mkdir -p /home/emulator && chown 1000 /home/emulator
USER 1000
ENV HOME=/home/emulator
EXPOSE 9297
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
