# Installation

`gh teacher` and `gh student` are extensions for the [GitHub CLI (`gh`)](https://cli.github.com/),
written in Go. Install them from their published releases, or build from source
if you're developing the extensions themselves.

## Prerequisites

- [GitHub CLI (`gh`)](https://cli.github.com/)
- [Go](https://go.dev/doc/install), only for the build-from-source path.

You don't need to run `gh auth login` first. The `login` commands below handle
GitHub authentication with the right scopes.

## Install (recommended)

```sh
gh extension install foundation50/gh-teacher
gh extension install foundation50/gh-student
```

Verify:

```sh
gh teacher --help
gh student --help
```

## Update

```sh
gh extension upgrade gh-teacher
gh extension upgrade gh-student
```

Or update everything at once with `gh extension upgrade --all`. `gh` also checks
for new releases in the background and tells you when an extension is out of
date.

Teachers who share an organization should upgrade together. `gh teacher init`
reinstalls the organization rulesets to whatever the running version expects,
so an older release re-running `init` undoes protections a newer one installed
(for example, the staff exemption on the `feedback` branch lock) until someone
runs the newer `init` or clicks **Fix it** in the web app's organization
settings.

To pin a version, pass `--pin` with a release tag:

```sh
gh extension install foundation50/gh-teacher --pin v1.42.0
```

## Log in

Each CLI has a `login` command that runs `gh auth login` with the extra OAuth
scopes Classroom 50 needs:

```sh
gh teacher login
gh student login
```

If you skip this and run another command first, the CLI runs the login flow for
you automatically. `gh teacher logout` and `gh student logout` mirror
`gh auth logout`.

## Shell completion (optional)

Tab completion for `gh teacher` and `gh student` commands and flags works in
bash, zsh, and fish. `gh` completes the names of installed extensions but not
what follows them, so each extension ships a script that extends gh's own
completion. Set up [gh's completion](https://cli.github.com/manual/gh_completion)
first, then add the extension's script after it.

zsh (`~/.zshrc`, after `compinit`):

```sh
eval "$(gh teacher completion zsh)"
eval "$(gh student completion zsh)"
```

bash (`~/.bashrc`, or `~/.bash_profile` on macOS). bash needs the
[bash-completion](https://github.com/scop/bash-completion) package, which
macOS does not ship (`brew install bash-completion@2`); without it the script
does nothing:

```sh
eval "$(gh teacher completion bash)"
eval "$(gh student completion bash)"
```

fish:

```sh
gh teacher completion fish > ~/.config/fish/conf.d/gh-teacher.fish
gh student completion fish > ~/.config/fish/conf.d/gh-student.fish
```

Start a new shell afterwards. Add only the lines for the extensions you have
installed. PowerShell is not supported: gh's completion there cannot be
extended without replacing it.

## Next steps

- Teachers: [CLI Teacher Guide](CLI-Teacher-Guide).
- Students: [CLI Student Guide](CLI-Student-Guide).

---

## Build from source (for development)

Install from a local checkout so your changes take effect:

```sh
git clone https://github.com/foundation50/classroom50
cd classroom50

(cd cli/gh-teacher && go build . && gh extension install .)
(cd cli/gh-student && go build . && gh extension install .)
```

After pulling new commits, rebuild. You don't need to reinstall:

```sh
(cd cli/gh-teacher && go build .)
(cd cli/gh-student && go build .)
```

## Verify a download (optional)

Each release ships a `checksums.txt` and build provenance attestations. To
confirm a binary came from the official release pipeline, replace `PATH-TO-BINARY`
with the downloaded file:

```sh
# Build provenance (gh 2.49+). Point --repo at the source monorepo, where the
# attestations are recorded (not the extension repository the binary came from):
gh attestation verify PATH-TO-BINARY --repo foundation50/classroom50

# Or check the SHA-256 against the release's checksums.txt:
sha256sum PATH-TO-BINARY
```

> [!NOTE]
> If `gh attestation verify` reports "no attestations found", confirm your `gh`
> is 2.49+ and that you passed `--repo foundation50/classroom50`.
