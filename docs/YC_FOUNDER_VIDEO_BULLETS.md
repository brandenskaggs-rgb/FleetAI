# YC Founder Video — Framing Feedback + Talking Bullets

## What I checked

Your homepage (`index.html`) and product copy right now: 100% dashboard/risk-score framing. Word "physics" doesn't appear anywhere on the site. The "7-21 day early warning" claim exists but is buried as a small stat, not the lead. That matches what you described — you've been leading with Fleet AI/dashboard, physics has never been the opener. I didn't find prior pitch decks in this project folder (only the codebase is connected here) — if you want those reviewed too, share the deck files directly and I'll pull the same comparison.

## Physics-first vs. product-first: the actual tradeoff

**Leading with physics works in your favor because:**
- YC partners watch hundreds of "we built a dashboard that predicts X" pitches a season. Opening with the physical mechanism — bearing fatigue, oil film breakdown, Arrhenius battery aging — signals real technical founder-market fit in the first 10 seconds, not a UI wrapped around telemetry.
- This video specifically is scored on how you communicate, not on the product. Showing depth of thinking about a hard technical problem, spontaneously, is exactly the signal this exercise is designed to surface.
- It preempts the single biggest objection a fleet-software pitch gets: "is this just alerts on a screen?"

**The risk of leading with physics:**
- 60 seconds is unforgiving. If you spend the first 20 seconds on mechanism before saying what the company does and why it matters to a fleet owner, you can lose the "so what."
- Pre-seed, pre-revenue, bootstrapped: your strongest asset in a minute is founder conviction and a sharp wedge, not technical depth for its own sake.

**The fix: sequence it, don't choose one.** One reframing sentence up front, then why-now/why-you, then the evidence line, in that order.

## Structure for the 60 seconds (bullets to glance at, not read)

1. **Open with the reframe (8-10 sec):** "Fleet AI isn't a dashboard — it's a physics engine. We model how a truck actually breaks down: bearing wear, oil breakdown, thermal load, battery aging. And we predict a failure days before it happens."
2. **Who you are + why you (10-15 sec):** Branden — background, why trucking/fleet failure is the problem you're obsessed with. Caden — co-founder, his experience (third startup). Keep it human, not resume-reading.
3. **Why now / why this matters (10-15 sec):** Breakdowns cost fleets real money and real downtime; most fleet software just shows you what already happened. You're predicting what's *about* to happen, physically.
4. **Evidence, framed honestly (10-15 sec):** "In simulation — built on the real physics of how these parts fail — we're seeing 90%+ precision and recall. We're pre-seed, bootstrapped, and about to validate that against real breakdown data with our first fleet customer."
5. **Close human (5-10 sec):** Something personal — why this, why now, what you want people to know about you as founders. This is the part YC actually wants: not more product, more *you*.

## Guardrails for what you say on camera

- Don't say "we've seen similar results in the real world" — per your own docs, zero real fleets have been scored yet. Say "next step is validating in the real world," which is true and still a strong pre-seed story.
- Don't quote both your old INVESTOR_TEST_REPORT.md numbers and the current model metadata numbers in the same conversation — they're from different model versions and don't match. Use only the current model's numbers (94.9% precision / 92.7% recall / 99.8% ROC-AUC, physics-v4.4.0).
- This is not the demo video — YC explicitly doesn't want a product walkthrough here. Name-drop the mechanism (bearing wear, oil film, thermal load) at a high level; save the equations for the deck or for follow-up questions.
- No script. These are five beats, not five sentences — talk through them like you're explaining it to a friend who just asked "wait, what do you guys actually do?"
