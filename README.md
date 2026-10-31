# GitHub access

Gives a project's members access to the GitHub repositories whoever runs it handed that project, in their GitHub keyvault. Members who proved their GitHub account and shared it with the project get access, and whoever leaves loses it again. Read access to an organization's repository; write access to a person's (GitHub has no read-only collaborators there).

A repository can be handed to any number of projects (it gets everyone any of them lets in), and a project any number of repositories.

It ships with Weave and holds no GitHub access of its own: its contract says it uses its person's GitHub keyvault (Administration write, Metadata read), and Weave hands it short-lived access from there, one repository at a time, only for repositories its person handed that project. Only they hand anything to a project: never the project's other maintainers. Taken back, a repository is still reachable for a day, only to take back the access it gave there.

Members prove their GitHub account once, in Keys & devices (a secret gist naming their Weave id, checked by GitHub's verifier), and choose which projects see it. Weave only tells it who is in a project and whose accounts hold: it knows nothing of GitHub. Each change it makes is recorded in the project (github.added), so it only ever takes back access it gave. It reaches `api.github.com` only.

A project that only hands out builds (GitHub releases) doesn't need it: it gives people the code.

    weave service add --shipped github-access --spaces <project>

Then, in Keys & devices: add the GitHub keyvault, make your GitHub App there (one click on GitHub), install it on your repositories, and hand the project the ones its members get.

## Where it lives

This repository is its only source. Weave ships it by pinning one of its releases (Weave's
`packages/shipped/pinned.json`: this repository, a tag and the archive's SHA-256), so what Weave ships is exactly
the file released here. A new version: tag it here, then move the pin in Weave.

## Building and releasing

```
npm install
npm run build              # → github-access.wasm
```

A tag `v*` builds it on GitHub and attaches `weave-github-access.tar.gz` (the component, `weave.app.json` and this README) to a
release (`.github/workflows/release.yml`).

`wit/service.wit` is Weave's service interface (`packages/sdk/wit` in Weave's repository), copied here to build against.
