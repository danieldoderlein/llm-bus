---
name: Feature request
about: Propose a capability for LLM Bus
title: ""
labels: enhancement
assignees: ""
---

## Problem

The coordination problem you are hitting. What do your agents (or the humans driving them) do today,
and where does it break down?

## Proposed capability

What you would like LLM Bus to do.

## Scope notes

LLM Bus is live coordination only - it stores no durable knowledge (that lives in an OKF wiki in
git; see decision 007). Tools take identity from the token, never from input, and every act is
project-scoped. Proposals that fit these constraints are easiest to land.

## Alternatives

Other ways you have considered solving this.
