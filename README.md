# Classroom 50

Classroom 50 is a free and open-source tool for managing and grading programming assignments via GitHub. Supported by the [Fifty Foundation](https://fifty.foundation/) as an open-source alternative to GitHub Classroom, Classroom 50 supports creating assignments, defining auto-graded correctness tests, and managing submissions.

Each top-level folder is a self-contained piece that may eventually ship from its own repository.

## Layout

| Folder                   | Contents                                                                        |
| ------------------------ | ------------------------------------------------------------------------------- |
| [cli/](cli/)             | Command-line tools, packaged as `gh` CLI extensions.                            |
| [templates/](templates/) | Example assignment templates teachers can copy when setting up classroom repos. |
| [web/](web/)             | Web frontend for Classroom 50.                                                  |

Reusable GitHub Actions workflows live in [`.github/workflows/`](.github/workflows/) (GitHub requires that location for `uses:` references). The autograde runner is scaffolded into each teacher's `classroom50` config repo; see the [Autograders](https://github.com/foundation50/classroom50/wiki/Autograders) wiki page.

Each folder has its own README with a bit more detail.

## License

Classroom 50 is released under the [GNU General Public License v3.0](LICENSE).
