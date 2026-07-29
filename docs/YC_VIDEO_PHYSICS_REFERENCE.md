# Fleet AI Physics — Reference for Founder Video (glance doc, not a script)

Pulled straight from the codebase (`fleet_ai/physics/vehicle_physics.py`, `fleet_ai/training/fleet_simulation.py`, model metadata). Use this to talk casually about the mechanism — don't recite it.

## The one-line reframe

Fleet AI is not a dashboard that shows you sensor readings. It's a physics simulation engine that models how a truck actually degrades — thermally, mechanically, electrochemically — and flags when a component's real physical state is heading toward failure, before the failure throws a fault code.

## What's actually being modeled (say 2-3 of these, not all)

- **Bearing wear (tribology):** hub bearing life modeled with a field-calibrated L10 fatigue life equation (the same math bearing manufacturers use), tracking friction heat at each wheel corner from load, speed, and a wear-dependent friction coefficient. A bearing throwing off abnormal heat today is mechanically consistent with failure days out — that's not a guess, it's the physics of metal fatigue.
- **Oil breakdown (lubrication physics):** oil viscosity modeled with the Walther equation (the real ASTM standard for how oil thins with heat), producing a "film thickness ratio" — a 0-to-1 score for whether the engine still has a hydrodynamic oil film or has degraded toward metal-on-metal boundary lubrication. That's the actual physical countdown to bearing seizure.
- **Thermal behavior (heat transfer):** engine and turbo temperatures modeled with Newton's Law of Cooling — heat in from combustion, heat out through the radiator — so a cooling system that's losing capacity shows up as a rising steady-state temperature well before it overheats.
- **Battery/electrical (electrochemistry):** battery state-of-health modeled with Arrhenius aging (degradation rate doubles roughly every 10°C of extra heat) and Peukert's law for cranking voltage sag — the same equations electrical engineers use for battery life, not a lookup table.
- **DPF/emissions (combustion + regen cycles):** diesel particulate filter soot load modeled as a real regeneration cycle (loads up, forced regen burns it off), so we know when a filter is trending toward a forced derate instead of just reading todays soot %.
- **Aerodynamics/engine load:** road load computed from actual drag equations (0.5·ρ·Cd·A·v³), rolling resistance, and grade — so the model knows the real mechanical stress a truck is under, not just its speed.

## The framing line that ties it together

"Every one of these is a real physical equation — the same ones a mechanical or automotive engineer would use to design the part. We're not pattern-matching on historical breakdowns. We're calculating the physical state of the part and asking: given this rate of degradation, how many days until this crosses the failure threshold."

## Numbers — what you can say confidently

- Current model (`physics-v4.4.0`): trained on **450,000 simulated observations**, precision **94.9%**, recall **92.7%**, ROC-AUC **99.8%** on a held-out synthetic test set (5,840 rows).
- Site currently states a **7–21 day early-warning window** — framed as the typical lead time between a developing fault and the point of failure, based on the sensor drift signatures across duty cycles.

## Numbers — say this carefully, don't overclaim

- **Everything above is simulation, not field data yet.** There is a real-world training pipeline (`train_real_world.py`) built and ready, but the only file run through it so far is a 3-row template — zero real trucks have been scored against a real failure outcome yet.
- Your own `INVESTOR_TEST_REPORT.md` (dated March 2026) shows very different numbers (precision 35%, recall 46%, ROC-AUC 89.6%) from the current model metadata (precision 94.9%, recall 92.7%, ROC-AUC 99.8%). That's an older model run — don't hand out both; only cite the current one, and if anyone cross-references, be ready to say "that was an earlier iteration, here's the current model."
- Your own `ASSUMPTIONS.md` says it directly: *"These numbers support planning simulations. They do not prove production savings by themselves. Production proof requires historical maintenance events, true failure labels, and real downtime/accounting records."* That's the honest line — use it, don't paper over it.

## The honest version of the claim you want to make

Not: *"We've seen similar numbers in the real world."* (Not true yet — no real fleet has been scored.)

Say instead: *"In simulation, built on real physics equations for how these components fail, we're seeing 90%+ precision and recall. The next step, and where McClane Transport comes in with their 12 trucks, is validating that same signal against real breakdown history."* That's a stronger, more credible story for pre-seed than a real-world claim you can't back up if a technical partner asks for the data.
