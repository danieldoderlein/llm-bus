# 001 - Build LLM Bus as a standalone product

**Date:** 2026-06-10
**Status:** Accepted

## Decision

Build **LLM Bus** (working name "yolo") as a dedicated, productizable service: a hosted,
multi-tenant MCP coordination plane for independent AI agents and the humans driving them
(collision-free atomic ID allocation, presence, an attributable prose handoff channel, advisory
file leases, a task graph, a queryable event ledger). It lives in its own git repository with its
own stack, tests, verification command, and deploy runbook.

## Context

The concept was conceived inside the `ai-coding-startkit` method library (that repo's decisions 003
and 007): first built in-repo under `tools/llm-bus/` while the design was moving, then extracted
to this dedicated repository once it reached a deployed v2 (live web admin, owner model, invites).
The extraction preserved full git history via `git subtree split`. The product is tightly coupled to
the protocol/adherence-kit ideas it grew from, but it has a different lifecycle, release cadence, and
(eventually) billing - mixing two products in one coherence loop was drift. This repo now carries the
whole build story and its own governance.

## Alternatives considered

- **Keep it in the method library under `tools/`** - rejected once deployed: two products with
  different lifecycles do not belong in one prose-coherence loop.
- **Keep it a private/internal tool, not a product** - rejected: the four-reviewer feedback and the
  owner/participant model (see [003](003-v1-scope-from-agent-feedback.md),
  [004](004-owner-participant-model-and-web-admin.md)) are explicitly aimed at external tenants.

## Consequences

- This repository owns LLM Bus's source, tests, ops runbook, and governance (CLAUDE.md, README,
  USING.md, ops/README.md).
- The product **name** was deferred at conception: a candidate sweep found the clean-`.io` real-word
  space saturated and "yolo" unsuitable as a codename (it reads as "no guardrails"). Resolved later to
  **LLM Bus** (decision 012).

## Follow-ups

- Pick a product name; trademark + domain clearance (tracked in PLAN.md).
- Dedicated hosting off the shared personal VM; self-serve signup; Stripe billing over the
  participation/event ledger (tracked in PLAN.md).
- Publish the adherence kit as a one-command installer (tracked in PLAN.md).
