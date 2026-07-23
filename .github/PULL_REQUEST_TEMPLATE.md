<!-- Thanks for contributing to Classroom 50! Please fill out the sections below. -->

## Summary

<!-- What does this PR do, and why? -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor / maintenance

## Checklist

- [ ] I built, tested, and linted the module(s) I touched:
  - CLI (Go): `go build ./... && go test ./... && golangci-lint run` in the module dir (`cli/gh-teacher`, `cli/gh-student`, or `cli/shared`)
  - Web: `cd web && npm run check`
  - Skeleton scripts (Python): `python3 -m pytest cli/gh-teacher/skeleton_tests -q`
- [ ] If I changed a cross-binary contract, I updated `schemas/*.schema.json` **and** every mirror (Go / Python / TypeScript), and the parity tests pass.
- [ ] If I added or changed a CLI command or flag, I documented it in the [wiki](https://github.com/foundation50/classroom50/wiki) (not in a README).
- [ ] My commits follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g., `feat(web): ...`, `fix(gh-teacher): ...`).
