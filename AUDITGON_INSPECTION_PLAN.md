# Auditgon: an inspection that can defend its findings

Give Auditgon a house scan, an independent design brief, and an inspection scope. It builds its own checklist, visits the relevant locations, measures what the evidence supports, revisits doubtful conclusions, and delivers a punch list and a draft measured floor plan. Every result links back to its evidence. Unresolved observations become specific requests for another measurement or photograph.

The demonstration should prove sustained autonomous work through completed inspections, useful tool creation, and visible corrections. A 45–60 minute run is a target workload and budget, not a minimum duration. Finish early when the work is complete. At the budget limit, save progress and report the remaining scope accurately.

## What the supplied scene gives us

The [Private Residence Interior scene](https://superspl.at/scene/9d09ab82) is listed at approximately 524 MB and 15 million Gaussians. Its creator describes a photographic reconstruction, including estimated depth and normal maps used to help fill walls. The loaded view shows a furnished living/kitchen area, an island, extensive glazing, and a vaulted ceiling. Those are useful inspection targets; no defect has been established by this planning review.

The linked [cutaway viewer](https://view.promediaproductions.com/residence-blueprint/) offers views of the main floor, garage, and lower level. It explicitly describes itself as a visual exploration rather than a measured construction drawing. Use it to understand navigation. A comparison against the intended design still needs an independent reference.

The [public hackathon brief](https://events.cerebralvalley.ai/e/gemini-4-argon-sf) emphasizes advanced reasoning, visual coding, robotics, and world models, and lists a $5,000 Managed Agents prize. The supplied detailed event page redirects to login; its private judging rubric and submission instructions were not verified. The public brief does not establish a one-hour minimum.

## The first implementation gate

Before building the dashboard, prove the following in one room:

1. Obtain a creator-permitted scene export or another supported way to access spatial data. A public viewer link alone does not establish access to usable measurement geometry.
2. Establish world orientation and metric scale from a known measured baseline, then check additional independent dimensions. Do not assume a door is a standard width. Keep scale calibration separate from testing whether the construction matches the design.
3. Fit a small number of visible surfaces and evaluate the error against independent reference measurements. Gaussians are rendering primitives; their centers are not automatically surveyed surface samples. Prefer validated depth, point-cloud, or mesh data where available.
4. Programmatically place a camera, capture its image and pose, obtain a spatial region for measurement, and reproduce that result.
5. Read an independent target plan or clearly labeled synthetic demo specification. A plan extracted from the same scan can support navigation and an as-built draft, but cannot independently establish construction deviation.

If metric scale or reliable geometry is unavailable, ship a visual inspection and relative-layout prototype with explicit unknowns. Do not manufacture centimeter measurements.

SuperSplat documents [export formats](https://developer.playcanvas.com/user-manual/supersplat/editor/import-export/) and [calibration to a known real length](https://developer.playcanvas.com/user-manual/supersplat/editor/transform-measure-align/). These capabilities do not establish this particular scene's accuracy. The original [3D Gaussian Splatting research](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/) describes a representation optimized for novel-view rendering, which is why measurement validation is a separate gate.

## The refined chapters

### 1. Turn the blueprint into a reference map and inspection agenda

The user can supply an independent blueprint. Treat that as the intended-design input, with its revision and sheet references preserved. Auditgon generates a simplified floor-plan sketch for navigation while retaining the original drawing for dimensional and specification checks. This input is distinct from the scan creator's visual cutaway.

Produce two linked representations from the blueprint:

- **Navigation sketch:** room names, walls, doors, windows, stairs, fixed features such as the island, and clear connections between rooms. Display the inspection path and item status on this map.
- **Structured reference model:** stable room and feature IDs, intended dimensions and units, explicit tolerances, room connections, and links to the source sheet, detail, or note. Keep unspecified properties unknown and ambiguous extractions unresolved. A guessed sketch dimension must not become a design requirement.

The blueprint remains available to the inspecting agent alongside both representations. Once the scene is calibrated, align the reference map to it using multiple distributed correspondences and retain registration uncertainty. Preserve differences between the design and the observed layout; do not deform the reference map to erase them. Use the observed layout to determine which camera routes are traversable.

Auditgon extracts rooms, objects, expected dimensions, tolerances, and room connections. Each checklist entry represents a claim that can be tested: an opening's location, an island clearance, or a ceiling profile. Avoid counting every intermediate click as an inspection item. A typical item links `room → feature → source requirement → observation → measurement → evidence → outcome`.

Every item has a stable ID, location, source requirement, measurement method, evidence requirement, and status. Start with a concrete scope; add newly discovered items with a reason visible in the activity stream. The item count comes from that scope, rather than a promise to reach 100.

**What judges see:** the blueprint becomes a clear reference sketch, the sketch fills with inspection targets, and Auditgon proposes its first route. The original blueprint, planned geometry, and measured as-built outline remain independently inspectable.

### 2. Orient itself, then walk the house

Auditgon establishes the floor, vertical direction, coordinate transform, and room connections. It visits rooms through a navigable route and selects views that expose the next target. Camera movements follow the agent's actual inspection actions. A decorative flythrough should not stand in for navigation.

For each item it gathers context, measures the relevant region, records uncertainty, and saves an annotated view. When the current view is insufficient, it changes position or requests another capture. A second rendered view can expose an occlusion or rendering artifact, but does not independently validate the underlying reconstruction.

**What judges see:** a marker moves on the floor plan while the corresponding camera view, measurement, and checklist entry update together.

### 3. Compare the house with the intended design

Start with a small set of measurements that can be validated: room dimensions, opening locations, island clearances, and visible ceiling geometry. Use one calibrated coordinate frame across rooms. Do not rescale each room to make its dimensions fit the plan.

Attach a measurement interval to each numerical claim. Flag a confirmed deviation only when the interval lies outside the accepted tolerance. If it overlaps the boundary, request better evidence. Keep predicted or occluded wall segments visibly distinct from measured segments.

A floor plan supports horizontal layout checks. A ceiling-slope comparison additionally requires a section, elevation, or explicit ceiling specification. Without that reference, Auditgon can describe the observed profile but cannot claim it contradicts the design.

**What judges see:** the target and measured outline overlay, with the specific discrepancy and its evidence highlighted.

### 4. Apply a small, explicit rulebook

Turn “Auditgon knows the code” into “Auditgon applies the supplied rules and records why they apply.” Each rule includes jurisdiction, edition, occupancy or room assumptions, applicability, units, exceptions, source, and the evidence needed to decide it. The hackathon's location does not identify the house's jurisdiction.

Choose two or three rules whose required geometry is actually visible and measurable. Candidate checks include stair-riser consistency, guard or handrail dimensions, and headroom. Retain the option to return insufficient evidence.

Door clear opening is different from the wall aperture. Window frame area does not establish an operable emergency opening. For example, [ICC's residential provisions](https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning) specify net clear opening through normal operation. A closed window in a scan cannot establish all of that. Outlet-spacing checks also require applicable wall-space rules and adequate visibility; put them behind the core geometry checks.

**What judges see:** a measurement, a cited rule, and either a supported result or a precise explanation of what remains unverified.

### 5. Search for visible workmanship issues

Treat missing trim, absent hardware, outlet covers, and finish patches as candidates that require confirmation. This furnished scene does not guarantee unfinished work. Missing reconstructed detail can also look like a missing physical component.

For a candidate, acquire a closer view and another useful angle; use original capture frames if available. Keep uncertain findings labeled as possible issues. “Not visible” must not become “missing.” A clean room with good evidence is a successful outcome.

**What judges see:** a candidate appears, then is confirmed, dismissed, or converted into a targeted photo request.

### 6. Challenge conclusions and write missing measurement tools

Before signing off a room, Auditgon runs an explicit verification pass against the saved evidence. It asks whether the chosen surface was correct, the measurement was affected by occlusion or glass, and the uncertainty supports the conclusion. It obtains new evidence or a different computation when needed; merely repeating the same reasoning is not verification.

When a standard measurement tool is insufficient, Auditgon can write a short script in the Managed Agent sandbox. A suitable candidate for this scene is comparing a planar ceiling fit with a curved or piecewise profile. The need for that script must arise from the inspection, and the intended ceiling profile must be supplied before making a design-compliance claim.

Save the generated script, cropped input data, assumptions, validation results, numerical output, and overlay. Test units and behavior on known synthetic geometry and evaluate held-out data. Fit residuals alone do not establish absolute real-world accuracy.

If a global scale, alignment, or tool error is discovered, invalidate every dependent result and requeue those items. Keep an immutable history of the original conclusion and its replacement.

**What judges see:** an actual conclusion changes because of new evidence or a validated computation. Do not script a fake mistake or guarantee that a correction will occur.

### 7. Deliver a usable inspection package

The package includes:

- A scoped verdict: **Pass**, **Pass with notes**, **Fail**, or **Incomplete**. Any mandatory unresolved check prevents an unqualified pass. Define which severities affect the verdict before the run.
- A floor-plan heatmap showing confirmed findings, uncertain regions, inspected areas, and unobserved areas distinctly.
- A punch list ordered by severity, with stable item IDs, annotated images, measurements and uncertainty, source requirements, and suggested next actions.
- An annotated 3D inspection viewer with persistent, spatially anchored findings. Each report issue opens its location in the scan, and each scan marker opens the same finding and supporting evidence.
- A draft measured as-built floor plan, with dimensions and evidence links. Show inferred or hidden segments differently and preserve the original design alongside it.
- An optional repair-cost range using supplied quotes or dated unit costs, quantities, and disclosed assumptions. Payment retention can be calculated only from supplied contract terms and an agreed valuation basis. Keep this optional for the hackathon.
- A capture list specifying exactly what additional photo or measurement would resolve each blocked item.

Do not generate a second, inconsistent set of findings while writing the report. The checklist is the report's source of truth.

### Mark findings directly in the 3D scan

Auditgon's inspection viewer displays the scan with an annotation layer. When Auditgon commits a supported finding, it also creates a marker at the affected feature. For measurements, highlight the relevant geometry: endpoints and a dimension line for a gap, a bounded region for a finish issue, or an outlined surface for a wall or ceiling discrepancy. Start with point markers and dimension lines; add more complex region overlays after the complete review flow works.

Annotations are stored with the inspection and remain available when the owner reopens the viewer. Store a stable finding ID, scan version, world-coordinate anchor or region, coordinate-frame version, associated room and feature IDs, and a saved review camera pose. An image pixel position or a saved camera pose alone does not establish a persistent spatial anchor. An uncertain location receives an explicitly approximate marker or a room-level capture request rather than a precise-looking pin.

Each marker opens a concise finding card containing:

- **What was flagged:** feature, room, issue category, severity, and current status.
- **Why it was flagged:** the observed condition and the specific comparison or rule that supports the result.
- **Expected and observed:** the blueprint dimension, tolerance, or applicable cited rule alongside the measured value and uncertainty when available.
- **Evidence:** annotated views, source drawing detail, measurement method, and any generated-script result used in the decision.
- **Next action:** suggested repair, physical measurement, or additional capture needed to resolve the item.

The report, floor-plan marker, and 3D marker use the same finding record. A **Show in 3D** action in the report focuses the saved review view and highlights the affected feature. Clicking that feature's marker opens the matching report entry. Corrections, dismissals, and reinspection results update every view together while retaining the earlier decision history. Exported report snapshots identify their inspection revision so an older report is distinguishable from the latest viewer state.

Use both symbols and text to distinguish confirmed findings from observations needing evidence. Label severity independently. Make pins readable, filterable by room and status, and aware of walls and floors so a marker from another room does not appear attached to the current wall. Provide an explicit overview mode for seeing all findings across the house.

This capability belongs in Auditgon's controlled viewer, which renders the supplied scene asset and its saved annotations. Prove world-coordinate placement and persistence on a single finding as part of the first-room implementation gate; access to a public scene page does not by itself establish the required camera, picking, and overlay APIs.

**What judges see:** Auditgon flags a feature, places its marker, and adds the same issue to the report. The owner clicks the report's **Show in 3D** button, lands at the feature, and immediately sees what Auditgon observed and why the evidence supports the flag.

### 8. Reinspect a claimed fix — stretch

A builder's statement initiates a recheck; it does not close an issue. Register the new capture to the previous run, verify scale, revisit the affected item, and retain before/after evidence. Recheck adjacent or dependent items when the repair could affect them. Expand the scope if registration has changed materially.

If the second capture is simulated or edited for the demo, label it as such. This chapter is optional until the first inspection works end to end.

## Completion, evidence, and recovery

Use a small state model:

`pending → observing → measured → verified pass / verified finding / blocked`

An item may be reopened, with a reason, after verification. A blocked item is administratively accounted for but remains unverified. Display accounted-for scope and verified coverage separately.

Every numerical result should retain: item ID, scan version, camera pose, region or surface ID, source requirement, measurement method and version, value, unit, uncertainty basis, evidence links, and verification history. Findings also retain their annotation anchor or bounds and coordinate-frame version so the report and 3D overlays refer to the same location.

Finish when all items have an outcome, the final coverage review produces no new actionable items, and the scoped verdict follows the predefined rules. Limit repeated attempts at the same unresolved observation. When further progress requires unavailable evidence, emit a capture request. At a time or cost limit, checkpoint and return an incomplete run with remaining scope.

Persist checklist transitions, evidence, scripts, and event history outside the transient model context. A resumed run must continue from saved state. Derive dashboard metrics and reports from that history.

## Runtime and tool boundary

Use Gemini Managed Agents for the planning and inspection loop, including generated measurement scripts. Configure Auditgon explicitly: Google's [Antigravity documentation](https://ai.google.dev/gemini-api/docs/antigravity-agent.md) shows `antigravity-preview-09-2026` with `agent_config.model = "gemini-4-argon"`; omitting that configuration defaults to a Flash model. Verify access with a real call before depending on it.

The same documentation supports sandbox code execution, files, and custom functions. Use custom tools to connect the managed sandbox to a renderer and measurement service. A cloud sandbox cannot directly reach a developer laptop's localhost. Prefer a deployed service or a renderer running in a reachable environment, and prove camera capture early. Supply rendered images plus structured spatial data; the model does not directly consume a Gaussian scene as measurement truth.

Keep the initial tool surface small: inspect the scene manifest, move the camera, capture a view, obtain a spatial region, perform validated standard measurements, read a rule, and commit an evidence-backed item result with a spatial annotation when its location is supported. The agent decides what to inspect next and when another method is needed. Deterministic code performs routine rendering and arithmetic.

## The screen judges watch

Use the splat view as the largest panel. Show the floor plan and actual inspection path beside it. Put the current item's requirement, measurement, and annotated evidence next to the checklist. Use a narrow event strip for meaningful actions such as “revisiting doorway because frame width was measured.”

A compact header might read:

`47:12 elapsed · 112/128 accounted for · 104 verified · 7 findings · 8 blocked · 2 corrections`

Those figures are an illustrative layout, not results from this scene. Let the scope total increase honestly when new items are discovered. Provide an issue click that returns to the evidence camera pose. During script execution, briefly show the code, validation, and resulting overlay without replacing the main experience with terminal logs.

## Hackathon scope and sequence

Build in this order:

1. **One complete room:** independent target, calibrated measurement, actual camera action, evidence, checklist result, report entry, and a persistent 3D marker with a working **Show in 3D** action.
2. **Core inspection:** several connected spaces, approximately 20–40 meaningful checks if supported by the scene, a limited cited rulebook, and verification that can reopen results.
3. **Differentiator:** one useful script generated during inspection and a draft measured floor plan.
4. **Scale:** expand the same validated workflow through the house. Add 100+ checks only when the real scope warrants them.
5. **Stretch:** workmanship detection, cost estimates, then a second scan and reinspection.

Keep a development-only reference set of independent manual measurements and reviewed labels. Measure numerical error, false positives, unresolved coverage, successful checkpoint/resume, and whether evidence supports the final verdict. Clearly labeled synthetic discrepancies can test the system when the real scene has no verified defects; they must not be presented as flaws in this residence.

For a long run, a planning budget could be 5 minutes for agenda and orientation, 30 for room inspection, 10 for specialist measurements, 10 for challenges and revisits, and 5 for deliverables. These are estimates, not delays or enforced phases. Revisit as soon as evidence calls for it.

Start the full run before judging. During a short presentation, show the running agent, open one finding and its evidence, play a clearly labeled recording of a real tool-creation or correction event if needed, and open the report and measured floor plan. Preserve timestamps so the sustained work is inspectable.

**Pitch:** “Give Auditgon a design and a house scan. It plans the inspection, gathers evidence, builds missing measurement tools, and keeps checking until every item is resolved or it can tell you exactly what evidence is missing.”
