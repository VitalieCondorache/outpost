# The published devcontainer image already brings everything VS Code and
# Codespaces expect (non-root `node` user, passwordless sudo, git, zsh, VS Code
# server support). It is referenced from a Dockerfile instead of the `image` key
# so the environment is pinned in the repository, not in registry tag metadata.
FROM mcr.microsoft.com/devcontainers/javascript-node:24-bookworm

# Nothing else to install: the API needs no compiler, because SQLite (`node:sqlite`)
# ships inside the runtime. That is deliberate — see docs/adr.
