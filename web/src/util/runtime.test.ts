import { describe, expect, it } from "vitest"

import {
  RUNTIME_LANGUAGES,
  RUNTIME_LANGUAGE_META,
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
