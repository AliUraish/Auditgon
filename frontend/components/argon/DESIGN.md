# Argon dashboard design decision

Primary reference: Taste Library’s Cursor profile, selected for a technical workflow on a warm canvas with restrained containers and a clear primary action. Secondary contribution: Linear’s nested product panels and fine separators, adapted to spatial inspection rather than copied as a marketing page.

References reviewed through the GitHub connector:

- `profiles/cursor.md`, `profiles/linear.md`, and `profiles/teenage-engineering.md` were compared against an inspector’s main task: keeping spatial context while understanding evidence and coverage.
- [Cursor layout](https://github.com/MartinPuli/taste-library/blob/main/data/sections/cursor/layout.json), source pointer `/result/design_system/layout`: neutral warm surfaces and the main product demonstration dominate the hierarchy. Argon adapts this to a persistent working viewer, not a centered marketing composition.
- [Cursor typography](https://github.com/MartinPuli/taste-library/blob/main/data/sections/cursor/typography.json), source pointer `/result/design_system/typography`: restrained weights and compact hierarchy. Argon uses system Helvetica rather than downloading proprietary reference fonts.
- [Cursor actions](https://github.com/MartinPuli/taste-library/blob/main/data/sections/cursor/actions.json), source pointer `/result/design_system/actions`: dark primary actions, quieter secondary controls. Argon’s main action is starting or pausing an inspection.
- [Linear layout](https://github.com/MartinPuli/taste-library/blob/main/data/sections/linear/layout.json), source pointer `/result/design_system/layout`: multi-panel product layout with subtle separation. The dashboard places the scan, reference map, and evidence side by side.
- [Linear surfaces](https://github.com/MartinPuli/taste-library/blob/main/data/sections/linear/surfaces.json), source pointer `/result/design_system/surfaces`: fine panel borders and nested surfaces. Argon adapts these to a light architectural palette and avoids continuous blur/glow effects for rendering cost and readability.

These extracted references are marked `extracted_unverified` and describe captured homepages rather than official complete product design systems. Argon’s olive, lime, and rust palette; spatial map; typography scale; responsive behavior; accessible native dialogs; and inspection interactions are original adaptations.

## React and memory review

Applied the Vercel React Best Practices skill after component implementation. Heavy scene code is owned by the separately lazy-loaded viewer. The dashboard uses a single serialized timeout for inspection updates, cleans event listeners and timers on unmount, guards asynchronous updates after unmount, caps events/findings/checklist pages, and never stores the scene binary or full-size image data in component state. Managed viewer callbacks use at most 80 remembered call IDs and release temporary bounded capture data after submission.

Functional controls use native buttons, forms, labeled inputs, and modal dialogs. The map supports keyboard activation. Derived coverage is computed from persisted checklist state; blocked checks remain separate from verified coverage. Reports, map markers, review edits, and 3D selections share finding IDs.

## Dark theme revision

The user requested a dark dashboard and removal of the general sample-session banner. The workspace now uses graphite surfaces, fine separators, readable neutral text, a restrained lime primary action, and rust/amber finding states. Per-finding labels, sample reference provenance, and report disclosures remain visible. Small-screen functional copy has a higher minimum size.

## Auditgon cutaway reference

The user selected the blue architectural cutaway at https://view.promediaproductions.com/residence-blueprint/?detail=auto and supplied a screenshot. The blueprint renderer applies its navy grid, white structural edges, elevated roof-off perspective, room openings, and furnishing silhouettes to actual model data. It uses real interactive PlayCanvas meshes, not the reference illustration as a substitute for the user’s building. Furniture is rendered only when the generated model records its type, position, and dimensions. Unknown geometry stays unknown. The graphics engine is lazy-loaded as a single chunk to avoid an engine/viewer circular initialization dependency.
