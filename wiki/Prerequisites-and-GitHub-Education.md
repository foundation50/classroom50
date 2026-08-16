# Prerequisites and GitHub Education

What you need before your first classroom: a GitHub organization on the right
plan, a free upgrade through GitHub Education, and a network that can reach
GitHub. Work through this page once and the setup guides go smoothly.

## What you need

- **A GitHub account** for you. Students each need their own free account;
  no student pays for anything.
- **A GitHub organization on the Team or Enterprise plan.** Classroom 50
  stores everything in an organization and relies on Team-plan features,
  most importantly GitHub Pages from a private repository.

Create the organization at
[github.com/account/organizations/new](https://github.com/account/organizations/new)
if you don't have one. The Free plan is enough to create it; the next two
sections cover the upgrade.

## The organization's plan is separate from your account

This is the most common setup surprise: organizations have their own plans,
separate from any plan or benefit on your personal account. A teacher benefit
on your account does not upgrade your organization by itself. You apply for
the benefit first, then use it to upgrade the specific organization your
classroom will live in.

## Get the Team plan free through GitHub Education

Verified teachers get GitHub Team free for their organizations:

1. [Apply to GitHub Education as a teacher](https://docs.github.com/en/education/about-github-education/github-education-for-teachers/apply-to-github-education-as-a-teacher).
   Verification goes fastest with a school-issued email address and clear
   proof of your role, such as a photo of a valid faculty ID or an employment
   letter. Blurry or expired documents are the usual reason applications
   bounce.
2. Wait for approval. Many applications clear in a few days, but allow up to
   one or two weeks; apply before the term starts, not the week of.
3. Once approved, upgrade your organization to GitHub Team at no cost
   through your [GitHub Education](https://github.com/education/teachers)
   benefits.

If your school already runs GitHub Enterprise, your organization may already
be covered; see the next section.

## Enterprise organizations

Enterprise-managed organizations work, but two setup warnings look like
failures and aren't:

- **"Couldn't verify the Actions spending cap"** (a `read failed (400)`
  warning). Billing is managed at the enterprise level, so Classroom 50 can't
  read it. The warning is advisory; setup continues. See
  [Couldn't verify the Actions spending cap](Troubleshooting#couldnt-verify-the-actions-spending-cap).
- **Branch protection can't be applied.** An enterprise policy can pin
  branch-protection settings so that neither you nor Classroom 50 can change
  them from the organization side. Ask your enterprise administrator to
  adjust the policy, or note the warning and continue.

Enterprise policies can also restrict which OAuth apps an organization may
use. If Classroom 50 doesn't appear or can't be granted, an owner or
enterprise administrator needs to approve it; see
[My organization doesn't appear](Troubleshooting#my-organization-doesnt-appear).

## School and district networks

Classroom 50 runs in the browser, so the browser itself must reach GitHub and
the app's domains. On a filtered network, ask IT to allow the short domain
list in
[Network and allowed domains](GitHub-Integration#network-and-allowed-domains).

Two related problems have known workarounds:

- **classroom50.org is blocked or flagged.** A few ISPs and school filters
  have flagged the domain; add an exception or switch DNS resolvers. See
  [classroom50.org won't load, or is flagged as unsafe](Troubleshooting#classroom50org-wont-load-or-is-flagged-as-unsafe).
- **The sign-in proxy is blocked.** Some networks block `workers.dev`, which
  breaks the normal **Sign in with GitHub** button. Sign in with a personal
  access token instead; see
  [If the proxy domain is blocked](GitHub-Integration#if-the-proxy-domain-is-blocked).

## Next steps

With the organization on the Team plan, follow the
[Web Teacher Guide](Web-Teacher-Guide) or the
[CLI Teacher Guide](CLI-Teacher-Guide) to run the one-time setup and create
your first classroom.
