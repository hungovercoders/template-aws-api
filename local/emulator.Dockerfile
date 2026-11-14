# AWS publishes no prebuilt image for AWS Emulator; this is the Dockerfile from
# "Getting started with Docker" in its user guide. Used by `task emulator:docker`
# on macOS and Windows, where there is no native package.
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
ARG PACKAGE=aws-emulator-x86_64.rpm
ADD https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/${PACKAGE} /tmp/aws-emulator.rpm
RUN rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm \
    && mkdir -p /home/emulator && chown 1000 /home/emulator
USER 1000
ENV HOME=/home/emulator
EXPOSE 9297
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
