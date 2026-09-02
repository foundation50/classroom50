# Changelog

All notable changes to the Classroom 50 CLI extensions (`gh-teacher`,
`gh-student`) are documented here. The web app (classroom50.org) has its own
release track and is not covered by this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are automated with
[release-please](https://github.com/googleapis/release-please): feature PRs
merge into `main` and release-please maintains a release PR that bumps this file
from [Conventional Commits](https://www.conventionalcommits.org/) (`feat:` ->
minor, `fix:` -> patch, `feat!:`/`fix!:` -> major). Merging that release PR tags
`cli-vX.Y.Z`, which the existing CLI release workflow consumes to build and
publish the extensions (see `.github/workflows/cli-release.yaml`). You no longer
tag by hand; write Conventional Commit messages and release-please compiles the
notes.

## [1.42.0](https://github.com/foundation50/classroom50/compare/cli-v1.41.0...cli-v1.42.0) (2026-09-02)


### Features

* expose the assignment bundle to declarative test commands ([#833](https://github.com/foundation50/classroom50/issues/833)) ([aeb154d](https://github.com/foundation50/classroom50/commit/aeb154dbed806b1a8311a2de66db72417ecaa47c))
* label each collect by scope and make its button show progress ([#832](https://github.com/foundation50/classroom50/issues/832)) ([3765cf3](https://github.com/foundation50/classroom50/commit/3765cf3a363158d2c75dd37698c57cb0eedb2f91))
* lock an assignment from the assignment form ([#839](https://github.com/foundation50/classroom50/issues/839)) ([7787456](https://github.com/foundation50/classroom50/commit/7787456251acb20ffd08687121e9fab0fa99264d))


### Bug Fixes

* **cli:** explain hand-written tests.json errors and where tests belong ([#834](https://github.com/foundation50/classroom50/issues/834)) ([6b0b83c](https://github.com/foundation50/classroom50/commit/6b0b83cfad6048af79a9705dc114d2b73fa786d9))
* **cli:** hand the classroom default autograder the extracted bundle ([515d4b6](https://github.com/foundation50/classroom50/commit/515d4b6367b2418bd99b9666532b4df44ed9454b))
* **cli:** make collect warnings reflect what the run found ([f89fc10](https://github.com/foundation50/classroom50/commit/f89fc1050cd2a480d052464f066e7c9fac7e78f9))
* **cli:** name every required permission when the config repo read is refused ([#855](https://github.com/foundation50/classroom50/issues/855)) ([7acdcef](https://github.com/foundation50/classroom50/commit/7acdcefe5b7ad4513b99ce74d7b1cea4f967b18a))
* **cli:** reuse the org listing when detecting pushes without a release ([63f36d4](https://github.com/foundation50/classroom50/commit/63f36d43d64d0c2be2fe3d57970d251d58b68c0f))
* count pushes without a graded release in the assignments list ([#838](https://github.com/foundation50/classroom50/issues/838)) ([b5853e7](https://github.com/foundation50/classroom50/commit/b5853e7931e2df3de4704ff3a8615e6e36000de0))
* fetch the org repo listing in parallel and probe known repo names ([#829](https://github.com/foundation50/classroom50/issues/829)) ([45f95e4](https://github.com/foundation50/classroom50/commit/45f95e40e0754393e6b8889c9eb3e258def11f03))
* make staff access grants visible and catch repo-scoped service tokens ([#835](https://github.com/foundation50/classroom50/issues/835)) ([f27b4dc](https://github.com/foundation50/classroom50/commit/f27b4dc20f509b568f82014e4c024768be196eb0))

## [1.41.0](https://github.com/foundation50/classroom50/compare/cli-v1.40.0...cli-v1.41.0) (2026-09-02)


### Features

* add team-based group assignments backed by GitHub Teams ([#827](https://github.com/foundation50/classroom50/issues/827)) ([63cb10f](https://github.com/foundation50/classroom50/commit/63cb10f6ab06ed76c7cbd69b366f61a65b3df5eb))

## [1.40.0](https://github.com/foundation50/classroom50/compare/cli-v1.39.1...cli-v1.40.0) (2026-08-31)


### Miscellaneous Chores

* **cli:** Synchronize classroom50 versions

## [1.39.1](https://github.com/foundation50/classroom50/compare/cli-v1.39.0...cli-v1.39.1) (2026-08-31)


### Bug Fixes

* **cli:** rewrite user-facing copy in GitHub's voice ([#818](https://github.com/foundation50/classroom50/issues/818)) ([f014a90](https://github.com/foundation50/classroom50/commit/f014a902fdbd3751f498b15d52ad1fe47ecbb3a0))

## [1.39.0](https://github.com/foundation50/classroom50/compare/cli-v1.38.0...cli-v1.39.0) (2026-08-30)


### ⚠ BREAKING CHANGES

* remove GitHub Classroom migration (product retired) ([#811](https://github.com/foundation50/classroom50/issues/811))

### Features

* remove GitHub Classroom migration (product retired) ([#811](https://github.com/foundation50/classroom50/issues/811)) ([319b7f6](https://github.com/foundation50/classroom50/commit/319b7f613db0f260ba619001eb4e93f345fdbc14))


### Miscellaneous Chores

* pin next release to 1.39.0 ([640736b](https://github.com/foundation50/classroom50/commit/640736b70c3ee865aef7a99eb78a212833391eb4))

## [1.38.0](https://github.com/foundation50/classroom50/compare/cli-v1.37.0...cli-v1.38.0) (2026-08-30)


### Features

* non-blocking roster sync, kept unlinked rows, and batch editing ([#806](https://github.com/foundation50/classroom50/issues/806)) ([5a5bb25](https://github.com/foundation50/classroom50/commit/5a5bb25554ed3f75b7abd5395467701c717f33e5))

## [1.37.0](https://github.com/foundation50/classroom50/compare/cli-v1.36.0...cli-v1.37.0) (2026-08-28)


### Miscellaneous Chores

* **cli:** Synchronize classroom50 versions

## [1.36.0](https://github.com/foundation50/classroom50/compare/cli-v1.35.0...cli-v1.36.0) (2026-08-28)


### Miscellaneous Chores

* **cli:** Synchronize classroom50 versions

## [1.35.0](https://github.com/foundation50/classroom50/compare/cli-v1.34.1...cli-v1.35.0) (2026-08-28)


### Features

* add autograder failure-details and show-output options ([#767](https://github.com/foundation50/classroom50/issues/767)) ([d1713bd](https://github.com/foundation50/classroom50/commit/d1713bd63be070a5321622a6b7f3d855a4c7e74a))
* add repo_visibility control for generated assignment repos ([#771](https://github.com/foundation50/classroom50/issues/771)) ([d6ff58e](https://github.com/foundation50/classroom50/commit/d6ff58e53221a8193a8ed14808f2240337da39b6))
* **web:** support a custom Pages domain for published classroom resources ([#782](https://github.com/foundation50/classroom50/issues/782)) ([807265c](https://github.com/foundation50/classroom50/commit/807265ce28de174f70f6fb51a197c209ca75c77f))


### Bug Fixes

* **cli:** use the student's git identity for submit commits ([#780](https://github.com/foundation50/classroom50/issues/780)) ([f96a82c](https://github.com/foundation50/classroom50/commit/f96a82c78f254864df841b82fc762409740931d5)), closes [#772](https://github.com/foundation50/classroom50/issues/772)
* stop concurrent invite acceptance from corrupting roster.csv ([#773](https://github.com/foundation50/classroom50/issues/773)) ([14eae9c](https://github.com/foundation50/classroom50/commit/14eae9c8b12f8f76b9c44025f08855eeba4543b0))

## [1.34.1](https://github.com/foundation50/classroom50/compare/cli-v1.34.0...cli-v1.34.1) (2026-08-26)


### Miscellaneous Chores

* **cli:** Synchronize classroom50 versions

## [1.34.0](https://github.com/foundation50/classroom50/compare/cli-v1.33.0...cli-v1.34.0) (2026-08-25)


### Bug Fixes

* stop corrupting non-ASCII names in uploaded roster CSVs ([#746](https://github.com/foundation50/classroom50/issues/746)) ([c85ed9c](https://github.com/foundation50/classroom50/commit/c85ed9cfdb9cfccf0346471284f1ba5fbc29aea1))

## [1.33.0](https://github.com/foundation50/classroom50/compare/cli-v1.32.0...cli-v1.33.0) (2026-08-24)


### Features

* **cli:** record one-shot slug renames with renamed_from ([#713](https://github.com/foundation50/classroom50/issues/713)) ([1ad7959](https://github.com/foundation50/classroom50/commit/1ad7959064d33195d0d0accfd2d60402ec0570f0))
* **cli:** rename an over-budget assignment slug and its student repos ([#714](https://github.com/foundation50/classroom50/issues/714)) ([55fe3d0](https://github.com/foundation50/classroom50/commit/55fe3d00d221990fda2829f5fc36dc77552da767))


### Bug Fixes

* **cli:** auto-trim over-budget migrated slugs and add --rename ([#711](https://github.com/foundation50/classroom50/issues/711)) ([46008f4](https://github.com/foundation50/classroom50/commit/46008f4c21df4806b3979d5b3988d83c649747f6))
* **cli:** block classroom/assignment names that overflow GitHub's repo-name limit ([#705](https://github.com/foundation50/classroom50/issues/705)) ([be99bb2](https://github.com/foundation50/classroom50/commit/be99bb22db0c60a47971dd56d4d54c357d314a67))
* **cli:** scope collect-scores staff-team grant to who needs it ([#695](https://github.com/foundation50/classroom50/issues/695)) ([0e92deb](https://github.com/foundation50/classroom50/commit/0e92deb3533c73dcf0ae53ae1919d945482c5062))
* **cli:** stop collect persisting truncated submission histories ([#702](https://github.com/foundation50/classroom50/issues/702)) ([bfd4b27](https://github.com/foundation50/classroom50/commit/bfd4b279c82476d77ff4154041f2c198c536e138))
* **cli:** trim auto-derived reuse slugs to the repo-name budget ([#707](https://github.com/foundation50/classroom50/issues/707)) ([ff5234f](https://github.com/foundation50/classroom50/commit/ff5234fedabd5e30a68769ecf2b2315bef6bb43d))
* **gh-teacher:** tell GitHub throttles apart from an under-scoped token ([#665](https://github.com/foundation50/classroom50/issues/665)) ([8b13b51](https://github.com/foundation50/classroom50/commit/8b13b51a78b03e0e478815c7c60c4da3c9fe7226))
* ignore a custom template branch, warning it won't take effect ([#673](https://github.com/foundation50/classroom50/issues/673)) ([#686](https://github.com/foundation50/classroom50/issues/686)) ([e2a7949](https://github.com/foundation50/classroom50/commit/e2a794977bc009ec2a2912a00cc715473d1a3227))
* point no-room slug budgets at a shorter classroom, not negative counts ([#710](https://github.com/foundation50/classroom50/issues/710)) ([dd4894a](https://github.com/foundation50/classroom50/commit/dd4894a8e7aa25927b642c6ee20bb052e40fec01))
* raise the classroom and assignment slug cap to 100 characters ([#693](https://github.com/foundation50/classroom50/issues/693)) ([37f0a19](https://github.com/foundation50/classroom50/commit/37f0a1915c8f68db0383513d1d851ab3f8512b12))
* show submissions for assignments that skip autograding ([#694](https://github.com/foundation50/classroom50/issues/694)) ([7e444e8](https://github.com/foundation50/classroom50/commit/7e444e8606dca591aa4edd72435a77f7c6b9342e))
* **web:** stop counting the tool's own commits as submissions ([#688](https://github.com/foundation50/classroom50/issues/688)) ([7c8725e](https://github.com/foundation50/classroom50/commit/7c8725e29a997efc0905b0fcb95226dd875ad5e7))
* **web:** stop treating an absent submission_mode as an unmigrated file ([#683](https://github.com/foundation50/classroom50/issues/683)) ([00f0779](https://github.com/foundation50/classroom50/commit/00f0779ea44b3867c03fdd80e3f7a1b38f01c066))

## [1.32.0](https://github.com/foundation50/classroom50/compare/cli-v1.31.0...cli-v1.32.0) (2026-08-20)


### Features

* **cli:** drop nightly score collection as the default ([#670](https://github.com/foundation50/classroom50/issues/670)) ([604f7f0](https://github.com/foundation50/classroom50/commit/604f7f097a53594d61564f59b58298eab0eb3adb))
* **web:** request delete_repo on demand instead of at every sign-in ([#667](https://github.com/foundation50/classroom50/issues/667)) ([a9ddca8](https://github.com/foundation50/classroom50/commit/a9ddca812006145f37a2f656520bf4cd052f9846))

## [1.31.0](https://github.com/foundation50/classroom50/compare/cli-v1.30.0...cli-v1.31.0) (2026-08-18)


### Features

* **cli:** add roster invite --file for bulk email invites ([#656](https://github.com/foundation50/classroom50/issues/656)) ([f083618](https://github.com/foundation50/classroom50/commit/f08361815b84d3c0c4d909209b18779854db4134))
* **cli:** give the teacher CLI the full email-invite lifecycle ([#651](https://github.com/foundation50/classroom50/issues/651)) ([a6809bd](https://github.com/foundation50/classroom50/commit/a6809bdc77fef08788a0982efb292b191dea8577))


### Bug Fixes

* align copy with behavior and drop the init_shim auto_init README ([#628](https://github.com/foundation50/classroom50/issues/628)) ([17f28b5](https://github.com/foundation50/classroom50/commit/17f28b5476b417fe2c3a8ae99121c051d19a1e24))
* **cli:** correct scores.csv shape in download help text ([#616](https://github.com/foundation50/classroom50/issues/616)) ([bcc4022](https://github.com/foundation50/classroom50/commit/bcc402205d231f48f36f093343b3577a32664184))
* **cli:** read the roster's email-only invite rows and sweep invite teams ([#632](https://github.com/foundation50/classroom50/issues/632)) ([9772e6c](https://github.com/foundation50/classroom50/commit/9772e6cd734c1ad838f05b35d7a81255e53b90f9))
* **cli:** sweep engineering jargon from help text and output ([#625](https://github.com/foundation50/classroom50/issues/625)) ([954c423](https://github.com/foundation50/classroom50/commit/954c423328d174d6e7e27c386cb1396c8ba6f453))
* correct email-invite docs, comments, and two contract defects ([#658](https://github.com/foundation50/classroom50/issues/658)) ([7076432](https://github.com/foundation50/classroom50/commit/7076432e805ac6f399e5af52fc57b76d1482ea3d))

## [1.30.0](https://github.com/foundation50/classroom50/compare/cli-v1.29.0...cli-v1.30.0) (2026-08-14)


### Miscellaneous Chores

* **cli:** Synchronize classroom50 versions

## [1.29.0](https://github.com/foundation50/classroom50/compare/cli-v1.28.2...cli-v1.29.0) (2026-08-14)


### Features

* add opt-in teacher pull_request_template.md as the Feedback PR body ([#602](https://github.com/foundation50/classroom50/issues/602)) ([fdb910d](https://github.com/foundation50/classroom50/commit/fdb910d9681cd8e7fbc5ec3f6d4d8ca1e277bda4))

## [1.28.2](https://github.com/foundation50/classroom50/compare/cli-v1.28.1...cli-v1.28.2) (2026-08-14)


### Features

* allow editing provisioning settings after assignment creation ([#597](https://github.com/foundation50/classroom50/issues/597)) ([f77c8f7](https://github.com/foundation50/classroom50/commit/f77c8f7b5c37908f41791c7aff311b15ccbee798))
* assignment-scoped score collection and accurate submission status ([#593](https://github.com/foundation50/classroom50/issues/593)) ([08e32f7](https://github.com/foundation50/classroom50/commit/08e32f7cce807e82e72861231c1738bc05d6e418))


### Miscellaneous Chores

* pin next release to 1.28.2 ([fb74e64](https://github.com/foundation50/classroom50/commit/fb74e6495d6005df1adc17b76497c5beb9b066f7))

## [1.28.1](https://github.com/foundation50/classroom50/compare/cli-v1.28.0...cli-v1.28.1) (2026-08-12)


### Miscellaneous Chores

* **cli:** Synchronize classroom50 versions

## [1.28.0](https://github.com/foundation50/classroom50/compare/cli-v1.27.2...cli-v1.28.0) (2026-08-12)


### Features

* add include_all_branches for template assignments ([#562](https://github.com/foundation50/classroom50/issues/562)) ([60c00e8](https://github.com/foundation50/classroom50/commit/60c00e8c9bd2e7616378ab2971627da01c990e08))
* add no_autograder assignment state for teacher-supplied CI ([#554](https://github.com/foundation50/classroom50/issues/554)) ([bd58fce](https://github.com/foundation50/classroom50/commit/bd58fce09ed8553f041338e9d0aa333ce91ff374))
* per-assignment submission triggers — modes and milestone tags ([#477](https://github.com/foundation50/classroom50/issues/477)) ([#531](https://github.com/foundation50/classroom50/issues/531)) ([90c45a7](https://github.com/foundation50/classroom50/commit/90c45a749d047e4087543b04d417ad3cd0112626))
* **web:** add Close submission bulk action ([#571](https://github.com/foundation50/classroom50/issues/571)) ([7897d9a](https://github.com/foundation50/classroom50/commit/7897d9a100d9c24a2fe0bb18ccee51d8fc5b9349))
* **web:** overhaul the assignment form and add empty-repo autograding ([#561](https://github.com/foundation50/classroom50/issues/561)) ([8fe3af3](https://github.com/foundation50/classroom50/commit/8fe3af374b02a210e84b07563f59733d96f7dea5))
* **web:** submission configuration, grading modes, and manual scoring ([#565](https://github.com/foundation50/classroom50/issues/565)) ([812cc0c](https://github.com/foundation50/classroom50/commit/812cc0c2078e33ea7af8cc981ade72a7d33faaad))

## [1.27.2](https://github.com/foundation50/classroom50/compare/cli-v1.27.1...cli-v1.27.2) (2026-08-09)


### Miscellaneous Chores

* **cli:** Synchronize classroom50 versions

## [1.27.1](https://github.com/foundation50/classroom50/compare/cli-v1.27.0...cli-v1.27.1) (2026-08-09)


### Bug Fixes

* **web:** use branches probe, not repo size, to detect empty templates ([#545](https://github.com/foundation50/classroom50/issues/545)) ([4ed82f5](https://github.com/foundation50/classroom50/commit/4ed82f54d606736433bca081fbc18c7a53b0c425))

## [1.27.0](https://github.com/foundation50/classroom50/compare/cli-v1.26.1...cli-v1.27.0) (2026-08-07)


### Features

* **cli:** reuse/refresh gh auth instead of clobbering it on login ([#537](https://github.com/foundation50/classroom50/issues/537)) ([6fe861a](https://github.com/foundation50/classroom50/commit/6fe861a7b43bd413853d4287361518f1e8769917))


### Bug Fixes

* **cli:** record a submission when no autograder is configured ([#535](https://github.com/foundation50/classroom50/issues/535)) ([f3dd96c](https://github.com/foundation50/classroom50/commit/f3dd96c8c949cb7d763743ad942ffa22718e68fc))
* exempt forks from the empty-template size-0 guard ([#536](https://github.com/foundation50/classroom50/issues/536)) ([6be63f1](https://github.com/foundation50/classroom50/commit/6be63f1838124645da20f3a4ffa6e62a769b6080))

## [1.26.1](https://github.com/foundation50/classroom50/compare/cli-v1.26.0...cli-v1.26.1) (2026-08-07)


### Bug Fixes

* reject an empty (commitless) template before accept ([#528](https://github.com/foundation50/classroom50/issues/528)) ([5ca964f](https://github.com/foundation50/classroom50/commit/5ca964f4d50656d2bfa0c9f77ac995f2f79e9003))
* silence staff-team removal email by granting config-repo access after owner drop ([#529](https://github.com/foundation50/classroom50/issues/529)) ([34c4014](https://github.com/foundation50/classroom50/commit/34c401403eb3178040551763fd2fef575685233f))

## [1.26.0](https://github.com/foundation50/classroom50/compare/cli-v1.25.1...cli-v1.26.0) (2026-08-06)


### Miscellaneous Chores

* **cli:** Synchronize classroom50 versions

## [1.25.1](https://github.com/foundation50/classroom50/compare/cli-v1.25.0...cli-v1.25.1) (2026-08-04)


### Miscellaneous Chores

* **cli:** Synchronize classroom50 versions

## [1.25.0](https://github.com/foundation50/classroom50/compare/cli-v1.24.1...cli-v1.25.0) (2026-08-04)


### Miscellaneous Chores

* **cli:** Synchronize classroom50 versions

## [1.24.1](https://github.com/foundation50/classroom50/compare/cli-v1.24.0...cli-v1.24.1) (2026-08-02)


### Bug Fixes

* **web:** stop force-disabling repo features on template-less assignments ([#482](https://github.com/foundation50/classroom50/issues/482)) ([da7825d](https://github.com/foundation50/classroom50/commit/da7825dd3e46d4c82f5bce544704f06406352f3c))

## [1.24.0](https://github.com/foundation50/classroom50/compare/cli-v1.23.0...cli-v1.24.0) (2026-08-02)


### Features

* **web:** per-assignment repository features (issues/wiki/projects/pull requests) ([#479](https://github.com/foundation50/classroom50/issues/479)) ([bd9725d](https://github.com/foundation50/classroom50/commit/bd9725de6c3fbc249dcaa2a4dded10908a9e97e7))

## [1.23.0](https://github.com/foundation50/classroom50/compare/cli-v1.22.0...cli-v1.23.0) (2026-08-02)


### ⚠ BREAKING CHANGES

* remove students.csv legacy roster support ([#474](https://github.com/foundation50/classroom50/issues/474))
* a classroom still on a -instructor team or with a teams.instructor ref is no longer accepted rather than silently normalized; a role=instructor CSV row imports as an unknown role (degrades to student).

### Features

* **cli:** surface roster role column and note dual staff/student roles ([#475](https://github.com/foundation50/classroom50/issues/475)) ([634cbb4](https://github.com/foundation50/classroom50/commit/634cbb4df50aa39b47e4403ff1180a98a5e8b2cc))
* remove legacy "instructor" staff-role alias ([#473](https://github.com/foundation50/classroom50/issues/473)) ([85164b9](https://github.com/foundation50/classroom50/commit/85164b9a7bb3791c72f652c3bbf42196928d7255))
* remove students.csv legacy roster support ([#474](https://github.com/foundation50/classroom50/issues/474)) ([b00ce2c](https://github.com/foundation50/classroom50/commit/b00ce2ce0df7f9e72fdb964646082461d28b17bc))


### Miscellaneous Chores

* release 1.23.0 ([#476](https://github.com/foundation50/classroom50/issues/476)) ([4a50632](https://github.com/foundation50/classroom50/commit/4a50632a2832fdfa5a5e3bc385712620a0d9e797))

## [1.22.0](https://github.com/foundation50/classroom50/compare/cli-v1.21.0...cli-v1.22.0) (2026-08-01)


### Features

* **cli:** skip autograde grade job when no autograder is configured ([#458](https://github.com/foundation50/classroom50/issues/458)) ([aa16f0a](https://github.com/foundation50/classroom50/commit/aa16f0a2fc3452282246e8d790f0f02a01e4fd18))
* configurable student assignment-repo access with per-repo and bulk controls ([#466](https://github.com/foundation50/classroom50/issues/466)) ([efb69f8](https://github.com/foundation50/classroom50/commit/efb69f8294512eadb7956bfff69e8e912bbd7ae5))


### Bug Fixes

* name the fork's upstream org for cross-org fork templates ([#468](https://github.com/foundation50/classroom50/issues/468)) ([#470](https://github.com/foundation50/classroom50/issues/470)) ([53785b8](https://github.com/foundation50/classroom50/commit/53785b807133023c418580f5b02fcd95a90b3c1f))

## [1.21.0](https://github.com/foundation50/classroom50/compare/cli-v1.20.0...cli-v1.21.0) (2026-07-29)


### Bug Fixes

* **cli:** correct help text listing --template as required and other stale flag references ([#452](https://github.com/foundation50/classroom50/issues/452)) ([98e5551](https://github.com/foundation50/classroom50/commit/98e555164899649e1e8f1ed023c807af36684412))

## [1.20.0](https://github.com/foundation50/classroom50/compare/cli-v1.19.0...cli-v1.20.0) (2026-07-29)


### Features

* **web:** manage service tokens across organizations ([#443](https://github.com/foundation50/classroom50/issues/443)) ([549d34a](https://github.com/foundation50/classroom50/commit/549d34aab497dc1a3050111f4bfbd8cbf974479d))

## [1.19.0](https://github.com/foundation50/classroom50/compare/cli-v1.18.1...cli-v1.19.0) (2026-07-28)


### Features

* add lockable assignments that block student access and revoke private-template read ([#441](https://github.com/foundation50/classroom50/issues/441)) ([127982b](https://github.com/foundation50/classroom50/commit/127982b9a518ee6b8a3c91fc4a6e1143f0f793c6))
* add per-assignment release date (available_from) and hide unreleased assignments from students ([#439](https://github.com/foundation50/classroom50/issues/439)) ([6cc15f0](https://github.com/foundation50/classroom50/commit/6cc15f07852545e0f50988ffa7386339a87dc99e))
* restrict assignment accept to enrolled classroom members ([#442](https://github.com/foundation50/classroom50/issues/442)) ([0e06012](https://github.com/foundation50/classroom50/commit/0e0601219e6006083da6a6767f8e6a520b85845c))

## [1.18.1](https://github.com/foundation50/classroom50/compare/cli-v1.18.0...cli-v1.18.1) (2026-07-28)


### Bug Fixes

* **web:** remediate brace-expansion DoS and refresh dependencies ([#436](https://github.com/foundation50/classroom50/issues/436)) ([9e1d355](https://github.com/foundation50/classroom50/commit/9e1d355940fac44589d3bf8361f77c75b3f57d29))

## [1.18.0](https://github.com/foundation50/classroom50/compare/cli-v1.17.0...cli-v1.18.0) (2026-07-28)


### Features

* **cli:** open and repair Feedback PRs from the teacher CLI ([#435](https://github.com/foundation50/classroom50/issues/435)) ([70ff18a](https://github.com/foundation50/classroom50/commit/70ff18ae30c95f0823d85f54064dbcc4f9169600))
* **web:** teacher tools to open and repair Feedback PRs ([#434](https://github.com/foundation50/classroom50/issues/434)) ([91ce244](https://github.com/foundation50/classroom50/commit/91ce244303cf63e99aac4f183442124babd8c97e))

## [1.17.0](https://github.com/foundation50/classroom50/compare/cli-v1.16.1...cli-v1.17.0) (2026-07-28)


### Features

* open the Feedback PR at accept time via the GitHub API ([#409](https://github.com/foundation50/classroom50/issues/409)) ([5ce01b7](https://github.com/foundation50/classroom50/commit/5ce01b749db789192f613040715657ff09b38358))

## [1.16.1](https://github.com/foundation50/classroom50/compare/cli-v1.16.0...cli-v1.16.1) (2026-07-27)


### Bug Fixes

* close the roster.csv formula-guard, padded-id, and i18n gaps ([#417](https://github.com/foundation50/classroom50/issues/417)) ([3aa8e22](https://github.com/foundation50/classroom50/commit/3aa8e22996cdab1fd2e1dd4256f432af45ba897c))
* name the real cause when an org blocks student repo creation ([#418](https://github.com/foundation50/classroom50/issues/418)) ([789b65c](https://github.com/foundation50/classroom50/commit/789b65c4ebdb65539d6f69d7389aaf75bbe4db5c))
* reject a malformed github_id in both the web app and the CLI ([#411](https://github.com/foundation50/classroom50/issues/411)) ([f2576d8](https://github.com/foundation50/classroom50/commit/f2576d89b9c1da97f845238b6f929ab76b434f5e))

## [1.16.0](https://github.com/foundation50/classroom50/compare/cli-v1.15.0...cli-v1.16.0) (2026-07-25)


### Miscellaneous Chores

* **cli:** Synchronize classroom50 versions

## [1.15.0](https://github.com/foundation50/classroom50/compare/cli-v1.14.0...cli-v1.15.0) (2026-07-24)


### Features

* collect and show accepted staff submissions ([#393](https://github.com/foundation50/classroom50/issues/393)) ([675e117](https://github.com/foundation50/classroom50/commit/675e117a6ce0ee8692edc21e0963ff1a7d29a8d5))

## [1.14.0](https://github.com/foundation50/classroom50/compare/cli-v1.13.0...cli-v1.14.0) (2026-07-23)


### Features

* **gh-teacher:** add additional details to autograded logs.  ([#353](https://github.com/foundation50/classroom50/issues/353)) ([254381e](https://github.com/foundation50/classroom50/commit/254381e9fae3dcc8f63b4f0c43e6c4ad3b695aa1))


### Bug Fixes

* **cli:** skip managed toolchain setup on self-hosted autograde runners ([#370](https://github.com/foundation50/classroom50/issues/370)) ([d1cf8b0](https://github.com/foundation50/classroom50/commit/d1cf8b05e6b4cf95fdffb050fa0c78b413f808c8))

## [1.13.0](https://github.com/foundation50/classroom50/compare/cli-v1.12.0...cli-v1.13.0) (2026-07-22)


### Features

* add submission release assets ([#363](https://github.com/foundation50/classroom50/issues/363)) ([3a69695](https://github.com/foundation50/classroom50/commit/3a69695ab407cb204ff6e7170aa943b272ae7838))

## [1.12.0](https://github.com/foundation50/classroom50/compare/cli-v1.11.0...cli-v1.12.0) (2026-07-21)


### Features

* add Head TA (HTA) role ([#344](https://github.com/foundation50/classroom50/issues/344)) ([b6a7deb](https://github.com/foundation50/classroom50/commit/b6a7debaba1f829759f546690fc0600ff50e47f1))
* **ci:** add release-please automation for cli releases ([#341](https://github.com/foundation50/classroom50/issues/341)) ([b5a3b94](https://github.com/foundation50/classroom50/commit/b5a3b944da0e8746be50d95f21d77feeee11db1b)), closes [#143](https://github.com/foundation50/classroom50/issues/143)
* enforce a $0 Actions budget cap as org policy ([#356](https://github.com/foundation50/classroom50/issues/356)) ([3cb60e4](https://github.com/foundation50/classroom50/commit/3cb60e4653cf14b80cd3c46961b9f271a4562235))
* **web:** capability-gate RBAC so TAs/Head TAs can't invoke owner-only or write ops ([#346](https://github.com/foundation50/classroom50/issues/346)) ([4335378](https://github.com/foundation50/classroom50/commit/433537843d3f78f441b74e7eedbf9fdd8df6fcca))

## 1.11.0

Automated releases start here. CLI versions through `cli-v1.11.0` were cut by
hand (tags aligned to the matching web release commit) before this track
existed, so they are not itemized above; see the git history and the per-tag
Releases on the `gh-teacher` / `gh-student` repos for those. release-please
compiles every entry from this point forward.
