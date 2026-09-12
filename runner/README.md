# Self-hosted runners on the cluster

`register-runner.sh` registers a repo-scoped GitHub Actions runner on a Linux node as a **user-level systemd service** — no root required.

```bash
./register-runner.sh duketopceo/Pace-Server cluster2-argus
./register-runner.sh owner/other-repo cluster2-other-repo
```

Each repo gets its own runner dir (`~/actions-runner-<name>`) and unit (`actions-runner-<name>.service`).

## Topology

- **Primary node: cluster2** (Ubuntu 24.04, x86_64, Docker 29, ~14 GiB free). cluster1 hosts the stateful AppFlowy stack; cluster3 is RAM-constrained.
- Labels: `self-hosted, linux, x64, argus-reviewer`. Target jobs with `runs-on: [self-hosted, linux, x64, argus-reviewer]`.

## Cost model

- An **idle runner** is an outbound HTTPS long-poll: ~40–60 MB RAM, no CPU. Many per-repo instances are fine.
- **Concurrency is the constraint**: each Playwright run wants ~2–4 GB. On 14 GiB free, ~3–4 concurrent runs is the ceiling; GitHub queues per-repo anyway.

## Container jobs

The runner node has Docker, so jobs can run in the pinned Playwright image:

```yaml
container:
  image: mcr.microsoft.com/playwright:v<version>-noble   # must match the npm playwright version
```

## Security

- **Never attach a self-hosted runner to a public repository** — fork PRs would run arbitrary code on your machine.
- The runner only makes outbound connections to GitHub; no inbound ports or Tailscale exposure are needed.
- Runner registration tokens are minted per-call via `gh api` and expire; they are never stored.
