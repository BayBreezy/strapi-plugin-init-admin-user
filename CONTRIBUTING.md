# Contributing

## Setup

[Bun](https://bun.sh) is preferred, but the scripts are plain and `npm install` works too.

```bash
bun install       # also installs the git hooks (husky)
bun run lint      # oxlint
bun run format    # prettier
bun run typecheck # tsc
bun run test      # vitest
bun run build     # Strapi Plugin SDK build, then `bun run verify`
```

## Commits

Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org).
A commit-msg hook (commitlint) checks the format locally, and CI checks the PR title.

## Releases

Releases are generated from the commits by [semantic-release](https://semantic-release.gitbook.io) when
something lands on `main`: `feat:` is a minor release, `fix:` a patch and a `BREAKING CHANGE:` footer a
major.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so no npm
token is stored in the repository and provenance is generated automatically. The package's trusted
publisher on npmjs.com is `BayBreezy` / `strapi-plugin-init-admin-user` / `release.yml`.

## Trying the plugin in a Strapi app

```bash
bun run watch:link                                                          # in this repo
npx yalc add --link @baybreezy/strapi-plugin-init-admin-user && npm install # in your Strapi app
INIT_ADMIN=true npm run develop
```

`node e2e/smoke.mjs` does the same against a fresh Strapi app, and is what CI runs.

## Branches

- `main`: Strapi v5 (1.x). Strapi v4 users stay on the original `strapi-plugin-init-admin-user@0.2.x`.
