# Changelog

All notable changes to the Classroom 50 **web app** (classroom50.org) are
documented here. The CLI extensions (`gh-teacher`, `gh-student`) have their own
release track and are not covered by this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are automated with
[release-please](https://github.com/googleapis/release-please): feature PRs
merge into `main` and release-please maintains a release PR that bumps
`web/package.json` and this file from [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:` -> minor, `fix:` -> patch, `feat!:`/`fix!:` -> major). Merging that
release PR tags `web-vX.Y.Z`, publishes the GitHub Release, and deploys to
classroom50.org (see `.github/workflows/web-release-please.yaml`). You no longer
edit this file or tag by hand; write Conventional Commit messages and
release-please compiles the notes.

## [1.12.0](https://github.com/foundation50/classroom50/compare/web-v1.11.0...web-v1.12.0) (2026-07-21)


### Features

* add Head TA (HTA) role ([#344](https://github.com/foundation50/classroom50/issues/344)) ([b6a7deb](https://github.com/foundation50/classroom50/commit/b6a7debaba1f829759f546690fc0600ff50e47f1))
* enforce a $0 Actions budget cap as org policy ([#356](https://github.com/foundation50/classroom50/issues/356)) ([3cb60e4](https://github.com/foundation50/classroom50/commit/3cb60e4653cf14b80cd3c46961b9f271a4562235))
* **web:** add RTL language support (Arabic, Hebrew, Farsi, Urdu) ([#340](https://github.com/foundation50/classroom50/issues/340)) ([5e36401](https://github.com/foundation50/classroom50/commit/5e36401705b709a8c595825c756e658d203d1034))
* **web:** capability-gate RBAC so TAs/Head TAs can't invoke owner-only or write ops ([#346](https://github.com/foundation50/classroom50/issues/346)) ([4335378](https://github.com/foundation50/classroom50/commit/433537843d3f78f441b74e7eedbf9fdd8df6fcca))
* **web:** centralize classroom resource reconcile on owner open ([#349](https://github.com/foundation50/classroom50/issues/349)) ([c795216](https://github.com/foundation50/classroom50/commit/c7952160e7b7d425f445f6c6fd4ef3e0f1ee2a4b))
* **web:** show live submission presence in teacher gradebook ([#354](https://github.com/foundation50/classroom50/issues/354)) ([a7a8465](https://github.com/foundation50/classroom50/commit/a7a8465def2a835147b2395e35dcf1571007c48f))


### Bug Fixes

* **web:** guide teachers past missing and Free-plan orgs in setup modal ([#355](https://github.com/foundation50/classroom50/issues/355)) ([4018f4b](https://github.com/foundation50/classroom50/commit/4018f4bc4767751cf4b8b67f0b0de2903a8b0ca0))
* **web:** let CLDR fixed-count plural forms drop the count placeholder in verify_locale ([#345](https://github.com/foundation50/classroom50/issues/345)) ([99d8c76](https://github.com/foundation50/classroom50/commit/99d8c76dd6009a27b84c987c16535299b7ae96cc))
* **web:** patch brace-expansion DoS (GHSA-3jxr-9vmj-r5cp) ([#357](https://github.com/foundation50/classroom50/issues/357)) ([ab4c306](https://github.com/foundation50/classroom50/commit/ab4c3060dc217904ea87ccbff485a959840fc212))
* **web:** refresh staff list after add and guard teacher self-removal ([#350](https://github.com/foundation50/classroom50/issues/350)) ([e3a7b9a](https://github.com/foundation50/classroom50/commit/e3a7b9aed7bf9d201831937c740e6c0a8053f18e))

## [1.11.0](https://github.com/foundation50/classroom50/compare/web-v1.10.0...web-v1.11.0) (2026-07-20)


### Features

* **web:** surface web upload as the primary submission action ([#338](https://github.com/foundation50/classroom50/issues/338)) ([2ea8b05](https://github.com/foundation50/classroom50/commit/2ea8b050feb170065c5b7cc548bfdca44c0b3a28))

## [1.10.0](https://github.com/foundation50/classroom50/compare/web-v1.9.0...web-v1.10.0) (2026-07-20)


### Features

* **web:** align user-facing copy and standardize button icons ([#167](https://github.com/foundation50/classroom50/issues/167)) ([#324](https://github.com/foundation50/classroom50/issues/324)) ([f459e81](https://github.com/foundation50/classroom50/commit/f459e8107ca3529587850acc3cf27583313c53c1))
* **web:** let students upload submissions from the browser ([#329](https://github.com/foundation50/classroom50/issues/329)) ([f462e68](https://github.com/foundation50/classroom50/commit/f462e683a0a535e0aa483c1c70c855cc43d8a1a6))
* **web:** student classrooms view, assignment discovery, and submit guidance ([#328](https://github.com/foundation50/classroom50/issues/328)) ([4bff93b](https://github.com/foundation50/classroom50/commit/4bff93b748528d35618718bf2ca6a31ad8de127b))


### Bug Fixes

* enable notifications on staff teams (teacher/ta) ([#337](https://github.com/foundation50/classroom50/issues/337)) ([28c6e10](https://github.com/foundation50/classroom50/commit/28c6e106c005bab2aabc84b41290a97bcb0bb7d5))
* **web:** update daisyUI to fix non-expanding details ([#333](https://github.com/foundation50/classroom50/issues/333)) ([95cd252](https://github.com/foundation50/classroom50/commit/95cd2528f6cc40464a9e18b04e187810563ab010))

## [1.9.0](https://github.com/foundation50/classroom50/compare/web-v1.8.0...web-v1.9.0) (2026-07-17)


### Features

* **assignments:** add opt-in empty-repo option ([#311](https://github.com/foundation50/classroom50/issues/311)) ([f06ee63](https://github.com/foundation50/classroom50/commit/f06ee632d0005a3db499178f57c0504a6be01052))
* standardize on "teacher" terminology (backward-compatible role/team migration) ([#321](https://github.com/foundation50/classroom50/issues/321)) ([0b6d5a0](https://github.com/foundation50/classroom50/commit/0b6d5a0a24d8d874724cca549d20dd9e618c8d05))
* **web:** harden setup + auth flow against stuck GitHub reads (derive wizard stage, add recovery affordances, warn on outages) ([#310](https://github.com/foundation50/classroom50/issues/310)) ([1967f67](https://github.com/foundation50/classroom50/commit/1967f67f55b563eec608da8422ea4c13282ad9ae))
* **web:** hint at GitHub outages on transient template-verify and save failures ([#319](https://github.com/foundation50/classroom50/issues/319)) ([8253ae0](https://github.com/foundation50/classroom50/commit/8253ae0dee918e0384f97b32c58cd0eea4407b8d))


### Bug Fixes

* **web:** recover classroom team read access to assignment templates ([#305](https://github.com/foundation50/classroom50/issues/305)) ([#308](https://github.com/foundation50/classroom50/issues/308)) ([02e52ea](https://github.com/foundation50/classroom50/commit/02e52ea8239f02b8199a6d77459e3c0458f470e6))

## [1.8.0](https://github.com/foundation50/classroom50/compare/web-v1.7.0...web-v1.8.0) (2026-07-16)


### Features

* grant TA staff team read on templates at setup, not only at collect-scores ([#288](https://github.com/foundation50/classroom50/issues/288)) ([9e4e5a3](https://github.com/foundation50/classroom50/commit/9e4e5a3bb71c6c3ec2247851c9abe66d828e5e0f))
* **web:** show assignment description to students ([#299](https://github.com/foundation50/classroom50/issues/299)) ([572953c](https://github.com/foundation50/classroom50/commit/572953c5cd305494a972ae758ff64157741006c3))

## [1.7.0](https://github.com/foundation50/classroom50/compare/web-v1.6.0...web-v1.7.0) (2026-07-15)


### Features

* **web:** enforce the i18n dead-key + hardcoded-string gate in CI ([#281](https://github.com/foundation50/classroom50/issues/281)) ([79d5e57](https://github.com/foundation50/classroom50/commit/79d5e57bf1e9143a85b00fe1df57e7a27410e589))


### Bug Fixes

* **web:** let org owners accept assignments despite residual admin ([#286](https://github.com/foundation50/classroom50/issues/286)) ([23c8515](https://github.com/foundation50/classroom50/commit/23c8515f3515fdb13bc7a2f087d565a609953aea))
* **web:** set safe QueryClient defaultOptions for queries ([#278](https://github.com/foundation50/classroom50/issues/278)) ([bbd1cb8](https://github.com/foundation50/classroom50/commit/bbd1cb8f97210eaba8338c9fb62f0e8bc1471e3a))
* **web:** treat an org owner as org-staff so a fresh org isn't stranded ([#285](https://github.com/foundation50/classroom50/issues/285)) ([3a826e1](https://github.com/foundation50/classroom50/commit/3a826e126cc163bc172b6cb097626c5011d69d19)), closes [#280](https://github.com/foundation50/classroom50/issues/280)

## [1.6.0](https://github.com/foundation50/classroom50/compare/web-v1.5.0...web-v1.6.0) (2026-07-15)


### Features

* grant TA (staff) teams repo access during score collection ([#244](https://github.com/foundation50/classroom50/issues/244)) ([3c5b369](https://github.com/foundation50/classroom50/commit/3c5b369d790da97dc25b890767a1127234426e7f))
* **web:** list created repos on the submissions dashboard ([#249](https://github.com/foundation50/classroom50/issues/249)) ([3d26e31](https://github.com/foundation50/classroom50/commit/3d26e316d1d1855cfaf06c999f0217e68c6741bb))
* **web:** team-based org-staff signal, replacing the config-repo heuristic (P5d) ([#265](https://github.com/foundation50/classroom50/issues/265)) ([539907f](https://github.com/foundation50/classroom50/commit/539907fa09096c5399d400159ef4aa751f38ce1b))


### Bug Fixes

* **web:** show write-access assignment repositories ([#263](https://github.com/foundation50/classroom50/issues/263)) ([3d4fc52](https://github.com/foundation50/classroom50/commit/3d4fc5222d132de7e986f8be7b34d3679c7fd993))
* **web:** stop no-cycle guard test timing out in CI ([#256](https://github.com/foundation50/classroom50/issues/256)) ([3a8b678](https://github.com/foundation50/classroom50/commit/3a8b678684a48d9a89aaf7c21981ece45c3adb1e))

## [1.5.0](https://github.com/foundation50/classroom50/compare/web-v1.4.0...web-v1.5.0) (2026-07-14)


### Features

* grant students push (not admin) on individual assignment repos ([#231](https://github.com/foundation50/classroom50/issues/231)) ([052ce36](https://github.com/foundation50/classroom50/commit/052ce360eca39f4e90dcc981abc000d3ae9df627))
* **web:** surface pending org invitations on the home page ([#239](https://github.com/foundation50/classroom50/issues/239)) ([02ef9cb](https://github.com/foundation50/classroom50/commit/02ef9cb7e3de1f4966020be2fd28843ccbb30668))


### Bug Fixes

* keep classroom creator on the instructor team only ([#243](https://github.com/foundation50/classroom50/issues/243)) ([511d3f0](https://github.com/foundation50/classroom50/commit/511d3f0fcc5f6b85a41db1ce5b11f199c475de6d))
* support non-main default branches in org setup and submit ([#235](https://github.com/foundation50/classroom50/issues/235)) ([1b31591](https://github.com/foundation50/classroom50/commit/1b31591ae51e8f81cce71f0720caeafaa33ce430))
* **web:** count only role=student in classroom student stats ([#241](https://github.com/foundation50/classroom50/issues/241)) ([c17f59e](https://github.com/foundation50/classroom50/commit/c17f59eb1446355cd0a08caa60a8c333baf4c2bb))
* **web:** isolate classroom invitations per team (reads + unenroll) ([#237](https://github.com/foundation50/classroom50/issues/237)) ([3351eb5](https://github.com/foundation50/classroom50/commit/3351eb5c6939202f89f43fc8beb95971df584ebf))

## [1.4.0](https://github.com/foundation50/classroom50/compare/web-v1.3.0...web-v1.4.0) (2026-07-13)


### Features

* migrate students.csv to roster.csv on write ([#219](https://github.com/foundation50/classroom50/issues/219)) ([86fd1d9](https://github.com/foundation50/classroom50/commit/86fd1d9dd5c7b97e7bc3c3f03e29236512115e68))
* rename students.csv to roster.csv with read-fallback and migrator ([#215](https://github.com/foundation50/classroom50/issues/215)) ([aca0711](https://github.com/foundation50/classroom50/commit/aca071166068c1fd89359630c16eac463f6516dd))
* sync instructors/TAs into roster.csv and add a best-effort role column ([#216](https://github.com/foundation50/classroom50/issues/216)) ([af17992](https://github.com/foundation50/classroom50/commit/af17992da0fbc21063050c45da707aab9bf370e2))
* team-driven roster with role-aware upload and self-healing roster.csv ([#217](https://github.com/foundation50/classroom50/issues/217)) ([30d8c89](https://github.com/foundation50/classroom50/commit/30d8c891bcb48c2be1526bfd6f2ce9c296eb8dc0))
* **web:** add search/sort/filter toolbar to assignments view ([#202](https://github.com/foundation50/classroom50/issues/202)) ([cfa58b2](https://github.com/foundation50/classroom50/commit/cfa58b2a5aabf47ca1a3d5ba2fc6cb0cc36eccd7))
* **web:** animate inline alerts in/out ([#189](https://github.com/foundation50/classroom50/issues/189)) ([cd4e90f](https://github.com/foundation50/classroom50/commit/cd4e90f1dd69eda378c19de5a9671023a15ed1b2))
* **web:** complete invite & membership lifecycle across all roles ([#223](https://github.com/foundation50/classroom50/issues/223)) ([afdd337](https://github.com/foundation50/classroom50/commit/afdd337f62f3d5f59ee954cc9740b8d57c807bf8))
* **web:** make activity banner reflect state and surface poll errors ([#193](https://github.com/foundation50/classroom50/issues/193)) ([aeeb70c](https://github.com/foundation50/classroom50/commit/aeeb70cab3051fc3dc41f2d9919a3f9d96b93f11))
* **web:** resolve effective role once at route boundaries ([#227](https://github.com/foundation50/classroom50/issues/227)) ([b284a7f](https://github.com/foundation50/classroom50/commit/b284a7fdaba7b8c576366f123bdd0caee27aeac0))
* **web:** unified roster upload with auto-detect and bulk email invites ([#222](https://github.com/foundation50/classroom50/issues/222)) ([23a5faf](https://github.com/foundation50/classroom50/commit/23a5faf3ec9bebc4aacbc57466fe57fe198bcd41))
* **web:** unify Students nav into a Roster of all classroom members with pending invites ([#208](https://github.com/foundation50/classroom50/issues/208)) ([63f81d8](https://github.com/foundation50/classroom50/commit/63f81d8cde5f4b6b8e26a14455b971cd4083d128))


### Bug Fixes

* **cli:** auto-install pytest + pytest-json-report for python autograding ([#229](https://github.com/foundation50/classroom50/issues/229)) ([15f936d](https://github.com/foundation50/classroom50/commit/15f936d1463381b8635a0f8c41b46cbd1610df3d))
* patch dependabot security alerts in x/crypto and happy-dom ([#224](https://github.com/foundation50/classroom50/issues/224)) ([5f51ba0](https://github.com/foundation50/classroom50/commit/5f51ba0a8033717d35ef1758c95c0cec72dc1d5e))
* **web:** fix roster profile edit modal getting stuck and Save not disabling ([#221](https://github.com/foundation50/classroom50/issues/221)) ([64d28c0](https://github.com/foundation50/classroom50/commit/64d28c0718f448c5331b88c14ed952c8de2aad9f))
* **web:** harden Modal close lock and Button form-submit type ([#197](https://github.com/foundation50/classroom50/issues/197)) ([9346c1d](https://github.com/foundation50/classroom50/commit/9346c1da0cbdf3c3a2661ea9a3f37b4b91f5a78d))
* **web:** make assignment due date optional and rework the form layout ([#201](https://github.com/foundation50/classroom50/issues/201)) ([bfbeb80](https://github.com/foundation50/classroom50/commit/bfbeb8083ce0e179ff732000c6b3d9af13f7d87b))
* **web:** stop unenrolled students and non-students from reappearing ([#209](https://github.com/foundation50/classroom50/issues/209)) ([#214](https://github.com/foundation50/classroom50/issues/214)) ([c4bdbbf](https://github.com/foundation50/classroom50/commit/c4bdbbf3f2c56f6d5738c3b269ad8ede15a0e62c))

## [1.3.0](https://github.com/foundation50/classroom50/compare/web-v1.2.0...web-v1.3.0) (2026-07-09)


### Features

* **web:** add personal access token sign-in ([#161](https://github.com/foundation50/classroom50/issues/161)) ([d289762](https://github.com/foundation50/classroom50/commit/d2897625af5fc647ba371202c4bb6fef8f7ad595))
* **web:** client-side diagnostics and a unified org activity view ([#182](https://github.com/foundation50/classroom50/issues/182)) ([6d3f4df](https://github.com/foundation50/classroom50/commit/6d3f4df8b54150d5679778b84939e534a888d107))
* **web:** detect offline and stop bouncing a valid session to /login ([#187](https://github.com/foundation50/classroom50/issues/187)) ([a80329a](https://github.com/foundation50/classroom50/commit/a80329a4c012b30988ebcd0aded985afa48d7bf0))
* **web:** link assignment to its source repository ([#148](https://github.com/foundation50/classroom50/issues/148)) ([1040514](https://github.com/foundation50/classroom50/commit/104051451878aaaa57681a618b13f45d606fcb41))
* **web:** list registry languages in the language dropdown ([#151](https://github.com/foundation50/classroom50/issues/151)) ([d47ddd8](https://github.com/foundation50/classroom50/commit/d47ddd803abfa1355a7e1cb3bbd2603e568f19b1))
* **web:** list the specific settings needing a manual fix at setup ([#152](https://github.com/foundation50/classroom50/issues/152)) ([bb86196](https://github.com/foundation50/classroom50/commit/bb86196ea247fe1dfb69e67598463bc1e17bea59))
* **web:** make the sidebar account button more compact ([#188](https://github.com/foundation50/classroom50/issues/188)) ([467d954](https://github.com/foundation50/classroom50/commit/467d95474f6b2bbf84b6e4cfedc51350bc3c8c34))
* **web:** prompt users to reload when a new version is deployed ([#168](https://github.com/foundation50/classroom50/issues/168)) ([d46354b](https://github.com/foundation50/classroom50/commit/d46354b17a59b741fa99a17b4de983955ac25607))
* **web:** redesign the assignment submissions page ([#176](https://github.com/foundation50/classroom50/issues/176)) ([1b1a3ed](https://github.com/foundation50/classroom50/commit/1b1a3ed0b4292183e60d62105472ff03afe79483))
* **web:** redesign the My Classrooms page (unified toolbar, richer cards, card actions) ([#157](https://github.com/foundation50/classroom50/issues/157)) ([559af45](https://github.com/foundation50/classroom50/commit/559af45d18752840ba4d046c1f648ac986e877c6))
* **web:** redesign the organization homepage (search, views, sort, setup modal) ([#154](https://github.com/foundation50/classroom50/issues/154)) ([15dfaae](https://github.com/foundation50/classroom50/commit/15dfaaef4b20f03dedcf90ddff318f6cd368735c))
* **web:** standardized client-side logger, dev rate-limit overlay, and app-wide logging coverage ([#184](https://github.com/foundation50/classroom50/issues/184)) ([6e1183e](https://github.com/foundation50/classroom50/commit/6e1183e08bcbaf1c455b5714c89892f58aa340bc))
* **web:** sumi theme redesign and shared UI component standardization ([#169](https://github.com/foundation50/classroom50/issues/169)) ([3c4be5d](https://github.com/foundation50/classroom50/commit/3c4be5dbca690ece7e067ddd37a08b16d7a01178))


### Bug Fixes

* stop enforcing private-repo forking org policy ([#179](https://github.com/foundation50/classroom50/issues/179)) ([898156a](https://github.com/foundation50/classroom50/commit/898156a12b0b86bd90825fb0017f5ff83ddc120a)), closes [#109](https://github.com/foundation50/classroom50/issues/109)
* **web:** flag and persist audit fixes that couldn't complete automatically ([#180](https://github.com/foundation50/classroom50/issues/180)) ([78c6fdf](https://github.com/foundation50/classroom50/commit/78c6fdf11e1182fad7610b610e458615562d48bf))
* **web:** split assignment due badge into date and countdown ([#186](https://github.com/foundation50/classroom50/issues/186)) ([484f58d](https://github.com/foundation50/classroom50/commit/484f58d27d6ee327e55636f91ffa33461cd183ff))
* **web:** verify classroom50 config repo before listing an org ([#171](https://github.com/foundation50/classroom50/issues/171)) ([9f832bd](https://github.com/foundation50/classroom50/commit/9f832bd24cb03d99a823e6e66a9a9f71d230ec76))

## [1.2.0](https://github.com/foundation50/classroom50/compare/web-v1.1.0...web-v1.2.0) (2026-07-06)


### Features

* add Rust runtime toolchain support to the autograder ([#132](https://github.com/foundation50/classroom50/issues/132)) ([4db3da2](https://github.com/foundation50/classroom50/commit/4db3da2679ba9f5faf735073c04d49d7dc5ea783))
* decouple classroom from students.csv — team as source of truth ([#108](https://github.com/foundation50/classroom50/issues/108)) ([#112](https://github.com/foundation50/classroom50/issues/112)) ([be1c1c1](https://github.com/foundation50/classroom50/commit/be1c1c138b263f19d973767cad3dc6c5f6d512b3))
* **web:** add shift-click range selection to roster and member tables ([#138](https://github.com/foundation50/classroom50/issues/138)) ([20fd606](https://github.com/foundation50/classroom50/commit/20fd60648983288ca5b6525f3749a4340cce2da2))
* **web:** edit assignment language runtimes and prevent runtime conflicts ([#128](https://github.com/foundation50/classroom50/issues/128)) ([6a3899e](https://github.com/foundation50/classroom50/commit/6a3899e98a9c70ba93d311f03660490d0a81119b))
* **web:** improve teacher assignment and submissions views ([#123](https://github.com/foundation50/classroom50/issues/123)) ([f7221d7](https://github.com/foundation50/classroom50/commit/f7221d7f2e8fcae61709e6201d690a73659a8ef7))
* **web:** link org name in page headings to github.com ([#142](https://github.com/foundation50/classroom50/issues/142)) ([62b25ca](https://github.com/foundation50/classroom50/commit/62b25cac90928d16f74a010f81c937089ef0838e))
* **web:** make classroom enrollment team-authoritative ([#125](https://github.com/foundation50/classroom50/issues/125)) ([a677ccf](https://github.com/foundation50/classroom50/commit/a677ccf25a19bedcd5280dba6d52db42fc2a8ea2))
* **web:** make skeleton-drift banner self-service ([#136](https://github.com/foundation50/classroom50/issues/136)) ([c0477c7](https://github.com/foundation50/classroom50/commit/c0477c73eff54c96ffc395eddca38e84be1eba19))
* **web:** org-level bulk membership management ([#70](https://github.com/foundation50/classroom50/issues/70) Phase 1) ([#117](https://github.com/foundation50/classroom50/issues/117)) ([28b7c99](https://github.com/foundation50/classroom50/commit/28b7c9934263eee6015075384ee1abd162c608c5))
* **web:** overhaul the classroom roster to reuse the org-members model ([#126](https://github.com/foundation50/classroom50/issues/126)) ([7f7610c](https://github.com/foundation50/classroom50/commit/7f7610c3f5c6ad260d21ce9693bdb88ccc5091c7))
* **web:** polish the student assignment-acceptance view ([#122](https://github.com/foundation50/classroom50/issues/122)) ([d845204](https://github.com/foundation50/classroom50/commit/d84520435254ba339c16d7747e6dce1c5d0941d2))


### Bug Fixes

* **web:** bound GitHub client requests with a default timeout ([#119](https://github.com/foundation50/classroom50/issues/119)) ([cdd7f95](https://github.com/foundation50/classroom50/commit/cdd7f95d504aaa8366162d2db13e18190c0d104f))
* **web:** stop stranding users across the auth flow ([#124](https://github.com/foundation50/classroom50/issues/124)) ([19df339](https://github.com/foundation50/classroom50/commit/19df3392eea144fc833a52a9ed8e80a595150615))
* **web:** surface a warning when re-adding an already-enrolled student ([#137](https://github.com/foundation50/classroom50/issues/137)) ([afea0f3](https://github.com/foundation50/classroom50/commit/afea0f35d36048772bdac7f74ef7f19409e9760d))
* **web:** surface real GitHub 403 cause for template access; block cross-org private forks ([#79](https://github.com/foundation50/classroom50/issues/79)) ([#118](https://github.com/foundation50/classroom50/issues/118)) ([26d4e28](https://github.com/foundation50/classroom50/commit/26d4e2833cb980424c82dcc40be9174bbfce80d8))
* **web:** trigger preview Pages deploy after publish ([#121](https://github.com/foundation50/classroom50/issues/121)) ([e0d4ec8](https://github.com/foundation50/classroom50/commit/e0d4ec876aa85bf55faae1c300c1df09332cbe98))
* **web:** write students.csv header on an empty roster; make regrade team-driven ([#133](https://github.com/foundation50/classroom50/issues/133)) ([19f9dc9](https://github.com/foundation50/classroom50/commit/19f9dc9b3fee79d566854744ff5267e890071d11))

## [1.1.0](https://github.com/foundation50/classroom50/compare/web-v1.0.0...web-v1.1.0) (2026-07-04)


### Features

* **web:** add docs link to logged-in account menu ([#91](https://github.com/foundation50/classroom50/issues/91)) ([#94](https://github.com/foundation50/classroom50/issues/94)) ([ae967f4](https://github.com/foundation50/classroom50/commit/ae967f4cb7ecc7cf3e3ca0540c020572fbc10b60))
* **web:** global GitHub Actions activity banner ([#98](https://github.com/foundation50/classroom50/issues/98)) ([2362f8e](https://github.com/foundation50/classroom50/commit/2362f8e7edb4a7b2ddc2dcdcff34691df6e309fd))
* **web:** localize relative timestamps to the active language ([#100](https://github.com/foundation50/classroom50/issues/100)) ([b78a768](https://github.com/foundation50/classroom50/commit/b78a76866bd104b6ba68b0204e16b8806eafeb01))
* **web:** silently auto-update installed language packs on startup ([#104](https://github.com/foundation50/classroom50/issues/104)) ([1f31521](https://github.com/foundation50/classroom50/commit/1f3152124f404107d2eb8813dabce4cce6d9b2cf))
* **web:** surface skeleton drift and bump skeleton action pins ([#90](https://github.com/foundation50/classroom50/issues/90)) ([2e6314f](https://github.com/foundation50/classroom50/commit/2e6314fc85ee05ee870d276f30efc7b515050af2)), closes [#88](https://github.com/foundation50/classroom50/issues/88)


### Bug Fixes

* **web:** match ConfirmModal cancel button to its description copy ([#93](https://github.com/foundation50/classroom50/issues/93)) ([240484b](https://github.com/foundation50/classroom50/commit/240484b3229d606cfa9a4bdff274e4dda6596f92))

## [1.0.0](https://github.com/foundation50/classroom50/releases/tag/web-v1.0.0) (2026-07-03)

First versioned release of the web app.

### Features

- Runtime internationalization (i18n) with sideloadable language packs, letting the UI be localized and extended without a rebuild.
- Bedrock-backed translation pipeline plus built-in localization UX for generating and maintaining language packs (#61).
- Locale translation prompt and integrity checker to keep translations consistent (#59).
- Language-pack patching from the `en.json` diff instead of full regeneration, so updates only touch changed strings (#69).
- Build version stamp: the running app reports its version, commit, and build date, shows a version badge in the sign-in card footer, and adds an **About** item to the profile menu (version linked to its GitHub release, commit to the source commit).

### Bug Fixes

- Return to the originally requested deep link after a forced sign-in, instead of dropping the user on a default page (#71).
- SSO-aware, fail-open org-membership gate on assignment accept, so SAML SSO orgs no longer incorrectly block valid members (#66).
- Sign out and redirect cleanly when a GitHub token is revoked or expired, rather than leaving the app in a broken authenticated state (#45).
- Pin the OAuth `redirect_uri` to the registered `/login` callback to avoid redirect-URI mismatches (#58).

### Security

- Added `SECURITY.md` with a private vulnerability reporting process (#50).
