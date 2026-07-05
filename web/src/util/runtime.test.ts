import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import {
  APT_PACKAGE_PATTERN,
  CONTAINER_IMAGE_PATTERN,
  CONTAINER_USER_PATTERN,
  LANGUAGE_VERSION_PATTERN,
  RUNTIME_LANGUAGES,
  RUNTIME_LANGUAGE_META,
  RUNTIME_WIRE_KEYS,
  aptPackagesToText,
  isNonUbuntuHostedLabel,
  parseAptPackages,
  validateAptPackages,
  validateContainerImage,
  validateContainerUser,
  validateLanguageVersion,
} from "./runtime"

describe("validateLanguageVersion", () => {
  it("accepts an empty value (field omitted -> toolchain skipped)", () => {
    expect(validateLanguageVersion("")).toBeUndefined()
    expect(validateLanguageVersion("   ")).toBeUndefined()
  })

  it("accepts versions the CLI's LanguageVersionPattern allows", () => {
    for (const v of ["3.12", "20", "1.23.4", "latest", "21.0.1+12"]) {
      expect(validateLanguageVersion(v)).toBeUndefined()
    }
  })

  it("rejects a value with whitespace or shell metacharacters", () => {
    expect(validateLanguageVersion("3.12 rm -rf")).toBeDefined()
    expect(validateLanguageVersion("$(whoami)")).toBeDefined()
    expect(validateLanguageVersion("a;b")).toBeDefined()
  })

  it("rejects a value longer than 32 characters", () => {
    expect(validateLanguageVersion("1".repeat(32))).toBeUndefined()
    expect(validateLanguageVersion("1".repeat(33))).toBeDefined()
  })
})

describe("parseAptPackages", () => {
  it("splits on commas and whitespace, trimming and dropping blanks", () => {
    expect(parseAptPackages("cmake, valgrind")).toEqual(["cmake", "valgrind"])
    expect(parseAptPackages("cmake valgrind")).toEqual(["cmake", "valgrind"])
    expect(parseAptPackages(" cmake ,  valgrind , ")).toEqual([
      "cmake",
      "valgrind",
    ])
    expect(parseAptPackages("")).toEqual([])
  })

  it("tolerates an array input", () => {
    expect(parseAptPackages(["cmake", " valgrind ", ""])).toEqual([
      "cmake",
      "valgrind",
    ])
  })
})

describe("aptPackagesToText", () => {
  it("joins packages with a comma and space, and handles undefined", () => {
    expect(aptPackagesToText(["cmake", "valgrind"])).toBe("cmake, valgrind")
    expect(aptPackagesToText([])).toBe("")
    expect(aptPackagesToText(undefined)).toBe("")
  })
})

describe("validateAptPackages", () => {
  it("accepts an empty list and valid lowercase Debian names", () => {
    expect(validateAptPackages([])).toBeUndefined()
    expect(
      validateAptPackages(["cmake", "libssl-dev", "g++", "python3.12"]),
    ).toBeUndefined()
  })

  it("rejects an uppercase, empty, or metacharacter-bearing package", () => {
    expect(validateAptPackages(["CMake"])).toBeDefined()
    expect(validateAptPackages(["valid", "bad name"])).toBeDefined()
    expect(validateAptPackages(["$(x)"])).toBeDefined()
  })
})

describe("validateContainerImage", () => {
  it("accepts an empty value and valid public image references", () => {
    expect(validateContainerImage("")).toBeUndefined()
    expect(validateContainerImage("   ")).toBeUndefined()
    for (const img of [
      "gcc:13",
      "ubuntu:24.04",
      "ghcr.io/cs50/grading-env:1.2",
      "node:22@sha256:abc",
    ]) {
      expect(validateContainerImage(img)).toBeUndefined()
    }
  })

  it("rejects an image with whitespace or shell metacharacters", () => {
    expect(validateContainerImage("ubuntu:24.04 rm -rf")).toBeDefined()
    expect(validateContainerImage("ubuntu:24.04;rm")).toBeDefined()
    expect(validateContainerImage("$(whoami)")).toBeDefined()
    expect(validateContainerImage("1".repeat(257))).toBeDefined()
  })
})

describe("validateContainerUser", () => {
  it("accepts an empty value and valid docker --user values", () => {
    expect(validateContainerUser("")).toBeUndefined()
    for (const u of ["root", "0", "1000:1000", "appuser:appgroup"]) {
      expect(validateContainerUser(u)).toBeUndefined()
    }
  })

  it("rejects a user with whitespace, metacharacters, or a dangling colon", () => {
    expect(validateContainerUser("root; rm")).toBeDefined()
    expect(validateContainerUser("1000:")).toBeDefined()
    expect(validateContainerUser("$(id)")).toBeDefined()
  })
})

describe("isNonUbuntuHostedLabel", () => {
  it("flags recognized macOS/Windows hosted labels", () => {
    expect(isNonUbuntuHostedLabel("macos-15")).toBe(true)
    expect(isNonUbuntuHostedLabel("windows-2025")).toBe(true)
    expect(isNonUbuntuHostedLabel("MACOS-14")).toBe(true)
  })

  it("passes bare macos/windows and Ubuntu/custom labels (teacher owns OS)", () => {
    expect(isNonUbuntuHostedLabel("macos")).toBe(false)
    expect(isNonUbuntuHostedLabel("windows")).toBe(false)
    expect(isNonUbuntuHostedLabel("ubuntu-latest")).toBe(false)
    expect(isNonUbuntuHostedLabel("self-hosted")).toBe(false)
    expect(isNonUbuntuHostedLabel("gpu")).toBe(false)
  })
})

describe("RUNTIME_LANGUAGE_META", () => {
  it("has an entry for every runtime language, newest-first versions", () => {
    for (const lang of RUNTIME_LANGUAGES) {
      const meta = RUNTIME_LANGUAGE_META[lang]
      expect(meta.label).toBeTruthy()
      expect(meta.versions.length).toBeGreaterThan(0)
      // Placeholder is the latest supported release (first in the menu).
      expect(meta.placeholder).toBe(meta.versions[0])
      // Every suggested version must itself pass the validator.
      for (const v of meta.versions) {
        expect(validateLanguageVersion(v)).toBeUndefined()
      }
    }
  })
})

// The `runtime` block is a CLOSED cross-tool contract (schema
// additionalProperties:false; the Go RuntimeRef decodes it strictly with no
// Extra; the web rebuilds it and drops unknown sub-keys on edit). That makes an
// unknown sub-key fatal, so a NEW sub-key must ship across the schema, the Go
// RuntimeRef, and the web in the SAME release. This test is the web's half of
// that lockstep guard: it reads the schema source of truth and fails if the
// web's known sub-key set or the shared regexes drift from it — so a one-sided
// schema change can't merge without the web catching up.
describe("runtime contract parity with assignments-v1 schema", () => {
  // Repo-root schema, reached from web/src/util. Web tests already read the
  // monorepo root (see the skeleton import), and vitest runs in a node env.
  const schemaPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../schemas/assignments-v1.schema.json",
  )
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
    $defs: { runtime: RuntimeSchema; langVersion: { pattern: string } }
  }
  type RuntimeSchema = {
    additionalProperties: boolean
    properties: Record<
      string,
      {
        pattern?: string
        items?: { pattern?: string }
        properties?: Record<string, { pattern?: string }>
      }
    >
  }
  const runtime = schema.$defs.runtime

  it("is a closed object (additionalProperties:false)", () => {
    expect(runtime.additionalProperties).toBe(false)
  })

  it("has exactly the sub-keys the web knows (RUNTIME_WIRE_KEYS)", () => {
    // Exact set equality both ways: a schema sub-key the web doesn't model (the
    // silent-drop-on-edit hazard) OR a web key not in the schema fails here.
    expect(new Set(Object.keys(runtime.properties))).toEqual(
      new Set(RUNTIME_WIRE_KEYS),
    )
  })

  it("shares the language, apt, and container patterns byte-for-byte", () => {
    // Compare regex bodies without the ^...$ anchors and normalizing JSON
    // Schema's capturing `(...)` group to the JS non-capturing `(?:...)` — a
    // cosmetic difference the two dialects don't share, not a shape difference.
    const body = (re: RegExp) => re.source.replace(/^\^|\$$/g, "")
    const norm = (p: string) => p.replace(/^\^|\$$/g, "").replace(/\(\?:/g, "(")

    expect(norm(schema.$defs.langVersion.pattern)).toBe(
      body(LANGUAGE_VERSION_PATTERN),
    )
    expect(norm(runtime.properties.apt.items!.pattern!)).toBe(
      body(APT_PACKAGE_PATTERN),
    )
    expect(norm(runtime.properties.container.properties!.image.pattern!)).toBe(
      body(CONTAINER_IMAGE_PATTERN),
    )
    expect(norm(runtime.properties.container.properties!.user.pattern!)).toBe(
      norm(CONTAINER_USER_PATTERN.source),
    )
  })
})
