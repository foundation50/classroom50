import { describe, expect, it } from "vitest"
import { classifyUploadFile } from "./uploadClassify"

describe("classifyUploadFile", () => {
  it("classifies a CSV with a username header as roster-csv", () => {
    const csv = "username,first_name,email\nada,Ada,ada@x.io\n"
    expect(classifyUploadFile(csv)).toBe("roster-csv")
  })

  it("classifies a multi-column header (even without username) as roster-csv", () => {
    // A delimiter on the first line means a structured CSV; the modal's roster
    // path then surfaces the missing-username-header message.
    expect(classifyUploadFile("email,first_name\na@x.io,Ada\n")).toBe(
      "roster-csv",
    )
  })

  it("classifies a bare one-username-per-line list as username-list", () => {
    expect(classifyUploadFile("ada\nbob\n@carol\n")).toBe("username-list")
  })

  it("classifies a single-column username CSV as username-list, not roster-csv", () => {
    // No recognized header token and no delimiter -> a bare list, not a CSV.
    expect(classifyUploadFile("octocat\ntorvalds\n")).toBe("username-list")
  })

  it("classifies one-email-per-line as email-list", () => {
    expect(classifyUploadFile("ada@x.io\nbob@y.edu\n")).toBe("email-list")
  })

  it("classifies email-list even with a leading mailto:", () => {
    expect(classifyUploadFile("mailto:ada@x.io\nbob@y.edu\n")).toBe(
      "email-list",
    )
  })

  it("treats a majority-email mixed list as email-list", () => {
    // 2 emails, 1 username -> majority email. The username is dropped downstream.
    expect(classifyUploadFile("ada@x.io\nbob@y.edu\noctocat\n")).toBe(
      "email-list",
    )
  })

  it("treats a majority-username mixed list as username-list", () => {
    // 2 usernames, 1 email -> not majority email -> username-list.
    expect(classifyUploadFile("octocat\ntorvalds\nada@x.io\n")).toBe(
      "username-list",
    )
  })

  it("treats an exactly-half email/username tie as email-list", () => {
    // 1 email + 1 username: emailCount (1) >= ceil(2/2) (1) -> email-list. Pins
    // the ceil rounding so an off-by-one drift to `>`/`floor` would fail here.
    expect(classifyUploadFile("ada@x.io\noctocat\n")).toBe("email-list")
  })

  it("does not misread a username header CSV whose rows contain emails", () => {
    // The header row wins: this is a structured roster CSV, not an email list.
    expect(classifyUploadFile("username,email\nada,ada@x.io\n")).toBe(
      "roster-csv",
    )
  })

  it("defaults an empty or whitespace-only file to username-list", () => {
    expect(classifyUploadFile("")).toBe("username-list")
    expect(classifyUploadFile("  \n \n")).toBe("username-list")
  })
})
