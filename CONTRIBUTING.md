# Contributing to Termic+

Termic+ is a personal fork of [Termic](https://github.com/simion/termic). Bug
reports and pull requests are welcome here, but check first whether the change
belongs upstream. A fix to something Termic+ did not change is better sent to
simion/termic, where every Termic user gets it, and Termic+ picks it up on the
next merge from upstream.

Contributions are accepted under the project's license, the
[GNU AGPL 3.0](./LICENSE). There is no separate contributor agreement.

## Set up

```sh
git clone https://github.com/stafawashere/termic.git termic-plus
cd termic-plus
make setup
make dev
```

`make setup` installs Rust, Node and the platform packages that are missing,
then runs `npm install` and `cargo check`. `make doctor` checks the same
things without installing anything. `make help` lists every target.

You need Rust ([rustup](https://rustup.rs/)) and Node 20 or newer. On Linux,
run `bash scripts/setup-linux.sh` first, because a stock desktop has no
`make`.

## Before you open a pull request

Run the checks that cover what you changed and keep them green:

```sh
npm test                                       # vitest
cargo test --manifest-path src-tauri/Cargo.toml
npm run build                                  # type check and bundle
make e2e                                       # WebdriverIO against the real app
```

`npm run typecheck:e2e` covers `e2e/` and `perf/`, which `npm run build` does
not reach. Run it after touching a spec.

Green suites do not catch a one-frame flicker, stolen focus or a shortcut that
fires twice. Before opening a pull request, run the change in the app and try
it by hand, and say in the description what you tried and what you saw.

A change and its test land in the same commit. Never edit a test, threshold
or fixture to make it pass.

The reference docs in `docs/` describe how the app works today (`ui.md`,
`ipc.md`, `performance.md`, `gotchas.md` and others). If your change makes one
of them wrong, update it in the same pull request. User-facing guides live in
`docs/guide/`.

## UI changes come with screenshots

A new feature or a visible design change needs screenshots in the pull request
description, one per state that matters. A small fix with no visual change
does not. You can capture them from an e2e spec with `snap()` (the images land
in `.e2e/artifacts/`). Attach them to the description and do not commit them.
Screenshots must not show real hostnames, usernames or paths.

## Agent-written PRs

Pull requests written with a coding agent are welcome on the same terms as any
other. Somebody has to have run the change in the app before the pull request
goes up, and the description says what they tried.

## Fixtures and release files

The repository is public and its history is permanent. Never paste real
command output into a test fixture, because it carries hostnames, usernames
and paths. Retype the shape with placeholders such as `acme.com`, `alice` and
`/Users/alice`.

Leave `CHANGELOG.md`, `changelog.json` and the version number alone. Those
change when a release is cut.
