# Autograder Recipes

Working setups for grading common languages with
[declarative tests](Autograding-Basics#declarative-tests): what to put in the
template repository, the tests to define, and the failures teachers hit
first. Each recipe works in the web assignment form or as a `--tests` JSON
file; adjust names, commands, and points to your assignment.

Two conventions apply throughout:

- **Timeouts are per command** (`setup` and `run` separately), 1 to 600
  seconds, default 10. Builds and dependency installs usually need more than
  the default; the assignment's **Setup command** starts at 120 seconds.
- **Every command starts in a fresh shell** in the student checkout. Files
  and installed packages persist between commands; `cd`, `export`, and
  virtual-environment activation don't. See
  [Setup commands, dependencies, and environment variables](Autograding-Basics#setup-commands-dependencies-and-environment-variables).

## Python

The default runtime already provides Python 3.14; pin another version with a
`runtime` of `{ "python": "3.12" }` if you need one.

- **Template:** starter code, `requirements.txt` if the assignment has
  dependencies, and your `test_*.py` files.
- **Setup command:** `python3 -m pip install -r requirements.txt` (only when
  there are dependencies). Raise its timeout for heavy installs, up to 600
  seconds.
- **Tests:** one `python` test runs pytest and splits its points across the
  test cases. The runner auto-installs `pytest` and `pytest-json-report`;
  add an install line only to pin versions.

```json
[
  { "name": "pytest suite", "type": "python", "run": "python -m pytest -q", "timeout": 120, "points": 10 }
]
```

Common failures:

- `ModuleNotFoundError`: a dependency wasn't installed. Add the
  requirements install to the Setup command.
- Imports work locally but not in grading: pytest can't see a `src/`
  layout. Set `pythonpath` in `pyproject.toml` or `pytest.ini`, or prefix
  the run command: `PYTHONPATH=src python -m pytest -q`.
- Environment variables vanish between tests. This is expected; writes to
  `$GITHUB_ENV` don't reach later tests. Set variables inline per command.

## Java

Pin a JDK with the `runtime` block, and commit the Gradle wrapper to the
template so grading uses your build's exact Gradle version:

```json
{ "java": "21" }
```

- **Template:** a standard Gradle (or Maven) project with the wrapper
  committed (`gradlew`, `gradle/wrapper/`), starter sources under
  `src/main/java`, and your test classes under `src/test/java`.
- **Tests:** a `run` test that passes when the build's tests pass. The first
  run downloads Gradle and dependencies, so give it a generous timeout.

```json
[
  { "name": "unit tests", "type": "run", "run": "sh ./gradlew test --console=plain", "timeout": 300, "points": 10 }
]
```

For partial credit, add one `run` test per test class:
`sh ./gradlew test --tests "CalculatorTest"` with its own points.

Common failures:

- `Permission denied: ./gradlew`: the wrapper lost its executable bit. Run
  it as `sh ./gradlew` (as above) or restore the bit in the template.
- Timeouts on the first test: dependency downloads exceeded the limit.
  Raise the test's timeout rather than splitting the build.

## C\#

GitHub-hosted Ubuntu runners ship recent .NET SDKs, so most assignments need
no runtime block. To pin an exact SDK, grade in a container:

```json
{ "container": { "image": "mcr.microsoft.com/dotnet/sdk:8.0" }, "python": "3.14" }
```

The grading runner is a Python script, so a container image must provide
`python3`; the `python` field installs one inside the container when the image
doesn't ship it.

- **Template:** a solution or project with the student code and an
  `xunit`/`NUnit`/`MSTest` test project.
- **Setup command:** `dotnet restore` with a raised timeout.
- **Tests:** a `run` test on `dotnet test`.

```json
[
  { "name": "unit tests", "type": "run", "run": "dotnet test --nologo", "timeout": 300, "points": 10 }
]
```

For partial credit, filter per test group:
`dotnet test --filter "FullyQualifiedName~AddTests"`.

Common failures:

- Timeouts: the first restore and build dominate. Put `dotnet restore` in
  the Setup command so test timeouts only cover the tests.

## C and C++

Compilers and `make` are preinstalled on Ubuntu runners; add packages with
the runtime's `apt` list when you need more (for example
`{ "apt": ["valgrind"] }`).

- **Template:** starter sources plus your test program. For
  [Catch2](https://github.com/catchorg/Catch2), commit the amalgamated
  header and source with the template so nothing needs installing.
- **Tests:** compile in a `setup` (or the Setup command), then run. Plain
  input/output tests on the student's binary also work well and need no test
  framework.

```json
[
  { "name": "compiles", "type": "run", "run": "make", "timeout": 60, "points": 1 },
  { "name": "unit tests", "type": "run", "setup": "g++ -std=c++17 -o tests tests.cpp student.cpp",
    "run": "./tests", "timeout": 120, "points": 8 },
  { "name": "prints usage", "type": "io", "run": "./student", "input": "\n",
    "expected": "Usage:", "comparison": "included", "points": 1 }
]
```

For partial credit with Catch2, run tagged subsets:
`./tests "[part1]"` as one test, `./tests "[part2]"` as another.

Common failures:

- Compile errors surface as a failed `setup`; the captured compiler output
  is in the Release body and the run's **Grade details** log.
- A crashing binary fails an `io` test with the captured stderr; a hanging
  one hits the test's timeout.

## Rust

Request a toolchain with the runtime block:

```json
{ "rust": "stable" }
```

- **Template:** a Cargo project with starter code and `#[test]` functions
  (or a `tests/` directory). Commit `Cargo.lock` so grading builds the same
  dependency versions students used.
- **Tests:** `cargo test` as a `run` test. The first build compiles all
  dependencies; give it the largest timeout.

```json
[
  { "name": "builds", "type": "run", "run": "cargo build", "timeout": 300, "points": 1 },
  { "name": "test suite", "type": "run", "run": "cargo test", "timeout": 120, "points": 9 }
]
```

For partial credit, run one named test per declarative test:
`cargo test test_add -- --exact` passes only when that test passes, so each
carries its own points.

Common failures:

- Timeouts on `cargo test`: the build happened inside the test. Add the
  `cargo build` test first (as above) so compilation and testing budget
  separately.

## Bring your own CI

If your grading already lives in workflows you maintain, you don't have to
adopt the built-in autograder:

- **Grade entirely outside Classroom 50.** Create the assignment with **Do
  not use the built-in autograder**; each accept then installs no grading
  workflow and your template's own CI runs instead. Score collection records
  who submitted, but no scores. See
  [Turning autograding off or pausing it](Managing-Actions-Cost#turning-autograding-off-or-pausing-it).
- **Keep a GitHub Classroom `autograding.json`.** A custom runner workflow
  lets your existing grading action keep reading `autograding.json` from
  each student repository. See
  [Keeping a GitHub Classroom autograder](Advanced-Autograding#keeping-a-github-classroom-autograder).

The one reserved filename is `.github/workflows/autograde.yaml`; template
workflows under any other name are left alone.

## Further reading

- [Declarative tests](Autograding-Basics#declarative-tests) for every test
  type and field.
- [Writing an `autograder.py`](Advanced-Autograding#writing-an-autograderpy)
  when a recipe outgrows declarative tests.
- [The `runtime` block](Advanced-Autograding#the-runtime-block) for
  toolchains, `apt` packages, containers, and self-hosted runners.
