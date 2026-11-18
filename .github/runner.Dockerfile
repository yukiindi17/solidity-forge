FROM node:22-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates git bash \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /bin/bash forge

USER forge
ENV HOME=/home/forge
ENV PATH=/home/forge/.foundry/bin:$PATH
RUN curl -fsSL https://foundry.paradigm.xyz | bash \
    && /home/forge/.foundry/bin/foundryup

WORKDIR /workspace
